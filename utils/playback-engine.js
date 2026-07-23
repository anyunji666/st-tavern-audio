// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  精简版顺序播放引擎
//  - BGM：循环播放，新的一条替换旧的（淡入淡出交叉）
//  - 环境音：只播一次、不循环（素材本身可能较长），新的一条顶替旧的时淡出打断
//  - 音效(SFX)：单次播放，按编排顺序依次触发，不阻塞语音队列；
//    可选 duration_sec 提前截断（素材比它长时才生效，末尾快速淡出）
//  - 语音(VOICE)：按顺序逐条播放（等上一条播完再播下一条）
//  去掉了原项目里的 3D 空间音效、逐字高亮朗读同步等复杂机制。
// ═══════════════════════════════════════════════════════════

import { getAudioContext, getBusGain, resumeAudioContext } from "./audio-context.js";
import { getSettings } from "./config.js";

const FADE_SEC = 0.6;
const SFX_FADE_OUT_SEC = 0.12; // 音效按 duration_sec 提前截断时的快速淡出，避免掐断产生爆音

let musicSource = null;
let musicGainLocal = null;
let ambianceSource = null;
let ambianceGainLocal = null;

let currentSequenceToken = 0; // 用于打断上一轮播放

function fadeAndStop(sourceNode, gainNode, ctx) {
    if (!sourceNode || !gainNode) return;
    const now = ctx.currentTime;
    try {
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0, now + FADE_SEC);
    } catch (_) {}
    setTimeout(() => { try { sourceNode.stop(); } catch (_) {} }, FADE_SEC * 1000 + 50);
}

function startLoop(buffer, busName, targetVolume) {
    const ctx = getAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    src.connect(gainNode);
    gainNode.connect(getBusGain(busName));
    src.start();
    const now = ctx.currentTime;
    gainNode.gain.linearRampToValueAtTime(targetVolume, now + FADE_SEC);
    return { src, gainNode };
}

/** 跟 startLoop 一样带淡入，但只播一次、不循环——用于环境音（素材本身可能较长，放完自然结束）。 */
function startOnce(buffer, busName, targetVolume) {
    const ctx = getAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = false;
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    src.connect(gainNode);
    gainNode.connect(getBusGain(busName));
    src.start();
    const now = ctx.currentTime;
    gainNode.gain.linearRampToValueAtTime(targetVolume, now + FADE_SEC);
    return { src, gainNode };
}

function playOneShot(buffer, busName, volume, durationSec) {
    const ctx = getAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gainNode = ctx.createGain();
    gainNode.gain.value = volume;
    src.connect(gainNode);
    gainNode.connect(getBusGain(busName));
    src.start();
    // duration_sec 只用来提前截断：比素材本身短才生效，末尾做个快速淡出避免爆音；
    // 比素材长或没填，就让素材自己播完，不循环拉长。
    if (durationSec && durationSec > 0 && durationSec < buffer.duration) {
        const now = ctx.currentTime;
        const fadeOutSec = Math.min(SFX_FADE_OUT_SEC, durationSec);
        const rampStart = Math.max(now, now + durationSec - fadeOutSec);
        gainNode.gain.setValueAtTime(volume, rampStart);
        gainNode.gain.linearRampToValueAtTime(0, now + durationSec);
        try { src.stop(now + durationSec + 0.02); } catch (_) {}
    }
    return src;
}

function playBlocking(buffer, busName, volume) {
    return new Promise((resolve) => {
        const ctx = getAudioContext();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gainNode = ctx.createGain();
        gainNode.gain.value = volume;
        src.connect(gainNode);
        gainNode.connect(getBusGain(busName));
        src.onended = () => resolve();
        src.start();
    });
}

/**
 * 播放一整套编排好的音频序列。
 * @param {Array<object>} playable 已经把 BGM/环境音/音效/语音都解析成 AudioBuffer 的可播放列表：
 *   {type:'music'|'ambiance', buffer:AudioBuffer}
 *   {type:'sfx', buffer:AudioBuffer, durationSec?:number}
 *   {type:'voice', buffer:AudioBuffer, speaker:string, text:string}
 */
export async function playSequence(playable) {
    const myToken = ++currentSequenceToken;
    const ctx = getAudioContext();

    // 兜底：如果全局手势解锁没生效（比如用户全程没点过页面任何地方），
    // 这里再尝试 resume 一次。resume 是异步的，等它完成后再继续，
    // 避免 context 还在 suspended 时就 start() 导致听不到声音。
    await resumeAudioContext();
    if (myToken !== currentSequenceToken) return; // resume 期间被新一轮打断

    for (const item of playable) {
        if (myToken !== currentSequenceToken) return; // 被新的一轮打断

        if (item.type === "music") {
            if (musicSource) fadeAndStop(musicSource, musicGainLocal, ctx);
            const { src, gainNode } = startLoop(item.buffer, "music", 1);
            musicSource = src;
            musicGainLocal = gainNode;
            continue;
        }
        if (item.type === "ambiance") {
            if (ambianceSource) fadeAndStop(ambianceSource, ambianceGainLocal, ctx);
            const { src, gainNode } = startOnce(item.buffer, "ambiance", 1);
            ambianceSource = src;
            ambianceGainLocal = gainNode;
            src.onended = () => {
                // 只清自己：如果这期间已经被新的一条环境音顶替，不要误清新的引用
                if (ambianceSource === src) { ambianceSource = null; ambianceGainLocal = null; }
            };
            continue;
        }
        if (item.type === "sfx") {
            playOneShot(item.buffer, "sfx", 1, item.durationSec);
            continue;
        }
        if (item.type === "voice") {
            await playBlocking(item.buffer, "voice", 1);
            if (myToken !== currentSequenceToken) return;
            continue;
        }
    }
}

/** 停止当前所有播放（切换会话/手动停止时调用） */
export function stopAll() {
    currentSequenceToken++; // 让正在进行的 playSequence 循环提前退出
    const ctx = getAudioContext();
    if (musicSource) { fadeAndStop(musicSource, musicGainLocal, ctx); musicSource = null; musicGainLocal = null; }
    if (ambianceSource) { fadeAndStop(ambianceSource, ambianceGainLocal, ctx); ambianceSource = null; ambianceGainLocal = null; }
}

/** 应用总线音量（0~1），从设置面板的滑条调用 */
export function applyBusVolumes() {
    const settings = getSettings();
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    getBusGain("music").gain.setValueAtTime((settings.musicVolume ?? 0.5) * (settings.masterVolume ?? 1), now);
    getBusGain("ambiance").gain.setValueAtTime((settings.ambianceVolume ?? 0.5) * (settings.masterVolume ?? 1), now);
    getBusGain("sfx").gain.setValueAtTime((settings.sfxVolume ?? 0.8) * (settings.masterVolume ?? 1), now);
    getBusGain("voice").gain.setValueAtTime((settings.voiceVolume ?? 1) * (settings.masterVolume ?? 1), now);
}
