// @ts-nocheck
import { getSettings } from "./config.js";
import { buildAudioPrompt } from "./prompt-builder.js";
import { executeLLMRequest } from "./llm-service.js";
import { parseAudioPlan } from "./parser.js";
import { resolveSpeakerVoice, assignFallbackForNpc, isSpeakerKnown } from "./npc-voice-map.js";
import { requestVoiceLine } from "./voice-dispatch.js";
import { findAudioAsset, reloadAudioAssets } from "./world-info.js";
import { loadStaticAudio } from "./audio-cache.js";
import { getAudioContext } from "./audio-context.js";
import { playSequence } from "./playback-engine.js";
import { addLogEntry, setLastPlan } from "./run-log.js";
import { beginGeneration, isTokenActive, setSynthesizing, setPlaying, setError, finish } from "./panel-state.js";

// 出错后悬浮窗保留错误提示的时长，之后自动隐藏
const ERROR_DISPLAY_MS = 2500;

/**
 * 处理一整回合的AI回复正文：调用LLM编排 -> 解析 -> 落盘新NPC分类
 * -> 并行拉取所有素材/语音 -> 顺序播放。
 * 全程通过 panel-state 上报进度；用户点击悬浮窗"跳过"按钮时，
 * beginGeneration() 发的令牌会失效，本函数在下一个检查点提前退出。
 * @param {string} messageText 本回合AI回复正文
 */
export async function processMessageForAudio(messageText) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!messageText || !messageText.trim()) return;

    reloadAudioAssets();

    const { token, signal } = beginGeneration();

    let rawReply;
    try {
        const prompt = buildAudioPrompt(messageText);
        rawReply = await executeLLMRequest([{ role: "user", content: prompt }], signal);
    } catch (e) {
        if (!isTokenActive(token)) return; // 被跳过，静默退出，不弹错误
        const msg = `编排请求失败：${e?.message || String(e)}`;
        console.error(`[pipeline] ${msg}`);
        addLogEntry("error", msg);
        setError(msg);
        setTimeout(() => { if (isTokenActive(token)) finish(); }, ERROR_DISPLAY_MS);
        return;
    }

    if (!isTokenActive(token)) return; // 被跳过

    let plan;
    try {
        plan = parseAudioPlan(rawReply);
        setLastPlan(plan);
    } catch (e) {
        const msg = `编排结果解析失败：${e?.message || String(e)}`;
        console.error(`[pipeline] ${msg}`);
        addLogEntry("error", msg);
        setError(msg);
        setTimeout(() => { if (isTokenActive(token)) finish(); }, ERROR_DISPLAY_MS);
        return;
    }

    // 落盘新出现的 NPC 分类（不覆盖已存在的）
    for (const item of plan.assign_fallback) {
        assignFallbackForNpc(item.name, item.category);
    }

    const playable = [];
    const total = plan.segments.length;
    let processed = 0;

    for (const seg of plan.segments) {
        if (!isTokenActive(token)) break; // 被跳过，不再发起新的素材/语音请求
        processed += 1;
        setSynthesizing(processed, total);

        if (seg.type === "music" || seg.type === "ambiance" || seg.type === "sfx") {
            const asset = findAudioAsset(seg.assetKey);
            if (!asset) {
                const msg = `未找到素材 "${seg.assetKey}"，跳过该事件`;
                console.warn(`[pipeline] ${msg}`);
                addLogEntry("warn", msg);
                continue;
            }
            const buffer = await loadStaticAudio(asset.url);
            if (!buffer) continue;
            const item = { type: seg.type, buffer };
            if (seg.type === "sfx" && seg.durationSec) item.durationSec = seg.durationSec;
            playable.push(item);
            continue;
        }
        if (seg.type === "voice") {
            const voiceInfo = resolveSpeakerVoice(seg.speaker);
            if (voiceInfo?.disabled) {
                // 用户主动关闭了该类别（旁白/某NPC分类），静默跳过，不记日志
                continue;
            }
            if (!voiceInfo) {
                const msg = `说话人 "${seg.speaker}" 尚未分配音色（可能是 AI 编排结果里漏报了这个角色的分类），已跳过这条语音。`;
                console.warn(`[pipeline] ${msg}`);
                addLogEntry("warn", msg);
                continue;
            }
            try {
                const item = await requestVoiceLine({
                    text: seg.text,
                    mood: seg.mood,
                    speakerName: seg.speaker,
                    provider: voiceInfo.provider,
                    speaker: voiceInfo.speaker,
                });
                const audioBuffer = await getAudioContext().decodeAudioData(item.audioBuffer.slice(0));
                playable.push({ type: "voice", buffer: audioBuffer, speaker: seg.speaker, text: seg.text });
            } catch (e) {
                const msg = `语音合成失败（说话人：${seg.speaker}）：${e?.message || String(e)}`;
                console.error(`[pipeline] ${msg}`);
                addLogEntry("error", msg);
            }
            continue;
        }
    }

    if (!isTokenActive(token)) return; // 在生成阶段最后一刻被跳过，不进入播放

    if (playable.length) {
        setPlaying();
        await playSequence(playable);
    }

    // 若播放过程中被跳过，skip() 已经把状态收起来了，这里不用再重复处理
    if (isTokenActive(token)) finish();
}
