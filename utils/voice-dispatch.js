// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  统一语音调度：按 provider 分发到 豆包 / MiMo，
//  请求前先查内存缓存 -> 再查本地IndexedDB持久化记录 -> 都没有才真正调用TTS。
//  这一层就是用户要求保留的"识别相同cacheKey跳过重复请求"。
// ═══════════════════════════════════════════════════════════

import { getSettings } from "./config.js";
import { getTtsItem, addOrUpdateTtsItem, generateTtsCacheKey } from "./tts-cache.js";
import { saveVoiceLine, getVoiceLine } from "./voice-audio-store.js";
import { initDoubaoTtsApi } from "./doubao-tts.js";
import { requestNimoTTS, parseApiKeys } from "./nimo-tts.js";
import { getRoot as getNimoRoot, resolveVoicePayload as resolveNimoVoicePayload } from "./nimo-voices.js";
import { initEdgeTtsApi } from "./edge-tts.js";

let doubaoApi = null;
function getDoubaoApi() {
    if (!doubaoApi) doubaoApi = initDoubaoTtsApi(5);
    return doubaoApi;
}

let edgeApi = null;
function getEdgeApi() {
    if (!edgeApi) edgeApi = initEdgeTtsApi(3);
    return edgeApi;
}

/**
 * @param {object} req
 *   @param {string} req.text        要合成的文本
 *   @param {string} [req.mood]      语气/情绪提示（会影响 cacheKey，不同语气不复用同一条缓存）
 *   @param {string} req.speakerName 说话人显示名（仅用于日志/管理列表）
 *   @param {string} req.provider    'doubao' | 'mimo' | 'edge'
 *   @param {string} req.speaker     doubao: settings.doubao.speakers 的 key；mimo: nimo 内部 voice id / 预置名；
 *                                   edge: settings.edge.speakers 的 key
 * @returns {Promise<{cacheKey:string, audioUrl:string, audioBuffer:ArrayBuffer}>}
 */
export async function requestVoiceLine(req) {
    const { text, mood = "", speakerName = "", provider, speaker } = req;
    if (!text || !String(text).trim()) throw new Error("语音文本为空");
    if (!/[\p{L}\p{N}]/u.test(text)) throw new Error(`跳过无可朗读字符的文本: "${String(text).slice(0, 20)}"`);
    if (!provider || !speaker) throw new Error(`未指定音色（speaker="${speakerName}"）`);

    const cacheKey = generateTtsCacheKey(text, mood, `${provider}:${speaker}`);

    // 1) 内存缓存命中
    const inMem = getTtsItem(cacheKey);
    if (inMem?.status === "success") {
        return inMem;
    }

    // 2) 本地持久化记录命中（跨会话去重复用）
    const persisted = await getVoiceLine(cacheKey).catch(() => null);
    if (persisted?.arrayBuffer) {
        const blob = new Blob([persisted.arrayBuffer], { type: persisted.mime || "audio/mpeg" });
        const audioUrl = URL.createObjectURL(blob);
        return addOrUpdateTtsItem(cacheKey, {
            status: "success", audioBuffer: persisted.arrayBuffer, audioUrl,
            text, speaker: speakerName, provider,
        });
    }

    // 3) 真正发起请求
    addOrUpdateTtsItem(cacheKey, { status: "pending", text, speaker: speakerName, provider });

    try {
        let audioBuffer, mime;

        if (provider === "doubao") {
            const settings = getSettings();
            const doubaoCfg = settings.doubao || {};
            const speakerInfo = doubaoCfg.speakers?.[speaker];
            if (!speakerInfo?.speaker_id || !speakerInfo?.resource_id) {
                throw new Error(`豆包音色 "${speaker}" 未配置 speaker_id/resource_id`);
            }
            if (!doubaoCfg.app_id || !doubaoCfg.access_key) {
                throw new Error("豆包 TTS 未配置 app_id / access_key");
            }
            const result = await getDoubaoApi()({
                appId: doubaoCfg.app_id,
                accessKey: doubaoCfg.access_key,
                speaker: speakerInfo.speaker_id,
                resourceId: speakerInfo.resource_id,
                text,
                context_texts: mood,
            });
            audioBuffer = result.audioBuffer;
            mime = "audio/mpeg";
        } else if (provider === "mimo") {
            const nimoRoot = getNimoRoot();
            const apiKeys = parseApiKeys(nimoRoot.apiKey);
            if (!apiKeys.length) throw new Error("MiMo TTS 未配置 API Key");
            const payload = await resolveNimoVoicePayload(speaker);
            const { blob, mime: nimoMime } = await requestNimoTTS(text, {
                apiKeys,
                baseUrl: nimoRoot.baseUrl,
                model: payload.model,
                voice: payload.voice,
                prompt: payload.prompt,
                format: nimoRoot.format || "wav",
                stylePrefix: mood || nimoRoot.stylePrefix || "",
            });
            audioBuffer = await blob.arrayBuffer();
            mime = nimoMime;
        } else if (provider === "edge") {
            const settings = getSettings();
            const edgeCfg = settings.edge || {};
            const speakerInfo = edgeCfg.speakers?.[speaker];
            if (!speakerInfo?.voice) {
                throw new Error(`Edge-TTS 音色 "${speaker}" 未配置 voice`);
            }
            const result = await getEdgeApi()({
                text,
                voice: speakerInfo.voice,
                rate: speakerInfo.rate,
                pitch: speakerInfo.pitch,
                volume: speakerInfo.volume,
            });
            audioBuffer = result.audioBuffer;
            mime = "audio/mpeg";
        } else {
            throw new Error(`未知的 TTS 供应商: ${provider}`);
        }

        const blobOut = new Blob([audioBuffer], { type: mime });
        const audioUrl = URL.createObjectURL(blobOut);

        const successItem = addOrUpdateTtsItem(cacheKey, {
            status: "success", audioBuffer, audioUrl, text, speaker: speakerName, provider,
        });

        // 落盘（不阻塞返回；用户要求本地留存，不需要等待完成）
        saveVoiceLine(cacheKey, { speaker: speakerName, text, mood, provider, mime }, audioBuffer)
            .catch(e => console.warn("[voice-dispatch] 本地持久化失败:", e));

        return successItem;
    } catch (error) {
        addOrUpdateTtsItem(cacheKey, { status: "error", error: error?.message || String(error) });
        throw error;
    }
}
