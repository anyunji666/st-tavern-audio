// @ts-nocheck
// 精简版 TTS 缓存：内存 Map，按 cacheKey 去重（保留原项目"命中缓存跳过重复请求"的行为）。
// 音频文件本身（audioBlob/audioUrl）由调用方决定是否落盘到 IndexedDB（见 voice-dispatch.js）。

export const TtsCacheEmitter = new EventTarget();
const ttsCache = new Map();

export function getTtsCache() {
    return ttsCache;
}

export function getTtsItem(cacheKey) {
    return ttsCache.get(cacheKey);
}

export function addOrUpdateTtsItem(cacheKey, data) {
    const existing = ttsCache.get(cacheKey) || {};
    const updated = { ...existing, ...data, timestamp: Date.now() };
    ttsCache.set(cacheKey, updated);
    TtsCacheEmitter.dispatchEvent(new CustomEvent("update", { detail: { cacheKey, item: updated } }));
    return updated;
}

export function clearTtsCache() {
    if (ttsCache.size === 0) return;
    ttsCache.clear();
    TtsCacheEmitter.dispatchEvent(new CustomEvent("update", { detail: { cleared: true } }));
}

// cyrb53 简单快速字符串哈希
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * 生成去重用的 cacheKey：同样的文本 + 语气 + 供应商:音色 视为同一次请求。
 */
export function generateTtsCacheKey(text, mood, providerSpeakerId) {
    if (typeof text !== "string" || !text) return `tts-empty-${Date.now()}`;
    const keyString = `${text}|${mood || ""}|${providerSpeakerId || ""}`;
    return `tts-${cyrb53(keyString)}`;
}
