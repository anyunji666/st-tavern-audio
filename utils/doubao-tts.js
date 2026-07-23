// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  豆包（火山引擎）语音合成 - 底层 API 封装
//  接口：openspeech.bytedance.com/api/v3/tts/unidirectional (流式)
//  鉴权：X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id
// ═══════════════════════════════════════════════════════════

const API_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const DEFAULT_TIMEOUT_MS = 15000;
const TIMEOUT_RETRY_COUNT = 1;

function createConcurrencyLimiter(limit) {
    const queue = [];
    let activeCount = 0;
    const next = () => {
        if (activeCount < limit && queue.length > 0) {
            activeCount++;
            const { fn, args, resolve, reject } = queue.shift();
            fn(...args).then(resolve).catch(reject).finally(() => {
                activeCount--;
                next();
            });
        }
    };
    return (fn) => (...args) => new Promise((resolve, reject) => {
        queue.push({ fn, args, resolve, reject });
        next();
    });
}

/**
 * 发起一次豆包语音合成请求（纯API客户端，不含缓存/去重逻辑）。
 * @param {object} requestData
 *   @param {string} requestData.appId
 *   @param {string} requestData.accessKey
 *   @param {string} requestData.speaker      speaker_id
 *   @param {string} requestData.resourceId   resource_id（如 seed-tts-2.0）
 *   @param {string} requestData.text         要合成的文本
 *   @param {string} [requestData.context_texts]  语气/情绪提示
 * @returns {Promise<{audioBuffer: ArrayBuffer}>}
 */
async function fetchTtsAudio(requestData) {
    const { appId, accessKey, speaker, resourceId, text, context_texts, options = {} } = requestData;
    const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    const headers = {
        "X-Api-App-Key": appId,
        "X-Api-Access-Key": accessKey,
        "X-Api-Resource-Id": resourceId,
        "Content-Type": "application/json",
    };

    // 克隆音色（resource_id 形如 seed-icl-2.0）必须显式传 model_type: 4
    // 才能启用完整的 ICL2.0 情感/语气控制，否则语气控制会静默失效。
    // 系统音色（如 seed-tts-2.0）不需要这个字段，本身就支持自然语言语气控制。
    const additionsPayload = { context_texts: context_texts ? [context_texts] : [] };
    if (typeof resourceId === "string" && resourceId.startsWith("seed-icl")) {
        additionsPayload.model_type = 4;
    }

    const payload = {
        user: { uid: "st-tavern-audio" },
        req_params: {
            text,
            speaker,
            audio_params: { format: "mp3", sample_rate: 24000 },
            additions: JSON.stringify(additionsPayload),
        },
    };

    for (let attempt = 0; attempt <= TIMEOUT_RETRY_COUNT; attempt++) {
        const controller = new AbortController();
        const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => "");
                throw new Error(`HTTP ${response.status}${errText ? `: ${errText}` : ""}`);
            }
            if (!response.body) throw new Error("响应无 body，无法流式读取。");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let finished = false;
            const audioChunks = [];
            let totalBytes = 0;

            while (!finished) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let boundary;
                while ((boundary = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, boundary).trim();
                    buffer = buffer.slice(boundary + 1);
                    if (!line) continue;

                    let data;
                    try { data = JSON.parse(line); }
                    catch (e) { console.error("[doubao-tts] JSON 行解析失败:", e, line); continue; }

                    if (data.code === 0 && data.data) {
                        const chunkAudio = Uint8Array.from(atob(data.data), c => c.charCodeAt(0));
                        audioChunks.push(chunkAudio);
                        totalBytes += chunkAudio.length;
                    } else if (data.code === 20000000) {
                        finished = true;
                        break;
                    } else if (data.code > 0) {
                        throw new Error(`豆包TTS错误: ${JSON.stringify(data)}`);
                    }
                }
            }

            if (totalBytes > 0) {
                const merged = new Uint8Array(totalBytes);
                let offset = 0;
                for (const c of audioChunks) { merged.set(c, offset); offset += c.length; }
                return { audioBuffer: merged.buffer };
            }
            throw new Error("豆包TTS未返回任何音频数据。");
        } catch (error) {
            const isTimeout = error?.name === "AbortError";
            if (!isTimeout || attempt >= TIMEOUT_RETRY_COUNT) {
                throw isTimeout ? new Error(`请求超时 (${timeoutMs / 1000}s)`) : error;
            }
        } finally {
            clearTimeout(timeoutTimer);
        }
    }
}

/**
 * 初始化豆包TTS客户端（带并发限制）。
 * @param {number} concurrency
 * @returns {(requestData: object) => Promise<{audioBuffer: ArrayBuffer}>}
 */
export function initDoubaoTtsApi(concurrency = 5) {
    const limitedFetch = createConcurrencyLimiter(concurrency)(fetchTtsAudio);
    return async (requestData) => {
        const { appId, accessKey, speaker, resourceId, text } = requestData || {};
        if (appId && accessKey && speaker && resourceId && text) {
            return limitedFetch(requestData);
        }
        throw new Error("豆包TTS请求参数不完整（需要 appId/accessKey/speaker/resourceId/text）。");
    };
}
