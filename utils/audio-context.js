// @ts-nocheck
// 精简版 AudioContext：只保留 音乐/环境音/音效/语音 四条总线 + 主限幅器。
// 去掉了原项目里的 3D 空间音效 / 混响(Tone.js) 相关节点。

let audioCtx = null;
let masterGainNode = null;
let masterLimiterNode = null;
let musicGainNode = null;
let ambianceGainNode = null;
let sfxGainNode = null;
let voiceGainNode = null;

function initAudio() {
    if (audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    masterGainNode = audioCtx.createGain();
    musicGainNode = audioCtx.createGain();
    ambianceGainNode = audioCtx.createGain();
    sfxGainNode = audioCtx.createGain();
    voiceGainNode = audioCtx.createGain();

    musicGainNode.connect(masterGainNode);
    ambianceGainNode.connect(masterGainNode);
    sfxGainNode.connect(masterGainNode);
    voiceGainNode.connect(masterGainNode);

    // 砖墙限幅器，防止多轨叠加削顶破音
    masterLimiterNode = audioCtx.createDynamicsCompressor();
    masterLimiterNode.threshold.value = -1;
    masterLimiterNode.knee.value = 0;
    masterLimiterNode.ratio.value = 20;
    masterLimiterNode.attack.value = 0.001;
    masterLimiterNode.release.value = 0.05;

    masterGainNode.connect(masterLimiterNode);
    masterLimiterNode.connect(audioCtx.destination);

    console.log("[st-tavern-audio] AudioContext initialized on demand.");
}

export function getAudioContext() {
    initAudio();
    return audioCtx;
}

export function getBusGain(bus) {
    initAudio();
    switch (bus) {
        case "music": return musicGainNode;
        case "ambiance": return ambianceGainNode;
        case "sfx": return sfxGainNode;
        case "voice": return voiceGainNode;
        default: return masterGainNode;
    }
}

export function getMasterGain() {
    initAudio();
    return masterGainNode;
}

/**
 * 尝试解锁/恢复 AudioContext。
 * 移动端浏览器（尤其 iOS Safari）要求 AudioContext 必须在用户手势的
 * 同步回调里 resume，否则会一直停在 "suspended"：source.start() 不会报错，
 * 但完全没有声音。这里提供一个统一入口，方便在手势回调和播放前都调用。
 * @returns {Promise<void>}
 */
export function resumeAudioContext() {
    initAudio();
    if (audioCtx && audioCtx.state === "suspended") {
        return audioCtx.resume().catch((e) => {
            console.warn("[st-tavern-audio] AudioContext resume 失败:", e);
        });
    }
    return Promise.resolve();
}
