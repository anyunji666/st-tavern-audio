// @ts-nocheck
// 精简版音频缓存：只负责 BGM / 环境音 / 音效 等"静态素材"的本地持久化与解码缓存。
// 语音(TTS)的缓存与去重由 tts-cache.js 单独处理，不复用本文件。

import { getAudioContext } from "./audio-context.js";

const memoryCache = new Map(); // url -> 已解码 AudioBuffer
const dbName = "STTavernAudioCacheDB";
const storeName = "audioCache";

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                const store = db.createObjectStore(storeName, { keyPath: "url" });
                store.createIndex("timestamp", "timestamp", { unique: false });
            }
        };
    });
}

async function getFromDB(url) {
    const db = await initDB();
    const tx = db.transaction([storeName], "readonly");
    return new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).get(url);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveToDB(url, arrayBuffer) {
    const db = await initDB();
    const tx = db.transaction([storeName], "readwrite");
    return new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).put({ url, arrayBuffer, timestamp: Date.now() });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * 加载一段静态音频（BGM/环境音/音效）为可播放的 AudioBuffer。
 * 优先级：内存缓存 > IndexedDB本地缓存 > 网络拉取(拉取后写入本地)。
 * @param {string} url
 * @returns {Promise<AudioBuffer|null>}
 */
export async function loadStaticAudio(url) {
    if (!url) return null;

    if (memoryCache.has(url)) return memoryCache.get(url);

    try {
        const cached = await getFromDB(url);
        if (cached?.arrayBuffer) {
            const buf = await getAudioContext().decodeAudioData(cached.arrayBuffer.slice(0));
            memoryCache.set(url, buf);
            return buf;
        }
    } catch (e) {
        console.warn(`[audio-cache] 读取本地缓存失败，改为联网获取: ${url}`, e);
    }

    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const arrayBuffer = await resp.arrayBuffer();
        if (!url.startsWith("blob:")) {
            // blob: 是临时URL，不做持久化，只解码使用
            await saveToDB(url, arrayBuffer.slice(0));
        }
        const buf = await getAudioContext().decodeAudioData(arrayBuffer);
        memoryCache.set(url, buf);
        return buf;
    } catch (e) {
        console.error(`[audio-cache] 加载音频失败: ${url}`, e);
        return null;
    }
}

/** 某个url是否已经缓存在本地（供"增量下载"跳过判断用） */
export async function isAssetCached(url) {
    if (!url) return false;
    try {
        const cached = await getFromDB(url);
        return !!cached?.arrayBuffer;
    } catch (_) {
        return false;
    }
}

/** 列出全部本地已缓存的素材（缓存管理面板用，不含二进制数据） */
export async function listCachedAssets() {
    const db = await initDB();
    const tx = db.transaction([storeName], "readonly");
    return new Promise((resolve, reject) => {
        const items = [];
        const req = tx.objectStore(storeName).openCursor();
        req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const { url, arrayBuffer, timestamp } = cursor.value;
                items.push({ url, sizeBytes: arrayBuffer?.byteLength || 0, timestamp });
                cursor.continue();
            } else {
                resolve(items.sort((a, b) => b.timestamp - a.timestamp));
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/** 取出某个已缓存素材的可播放Blob（试听用） */
export async function getCachedAssetBlob(url) {
    const cached = await getFromDB(url);
    if (!cached?.arrayBuffer) return null;
    return new Blob([cached.arrayBuffer]);
}

/** 删除单条素材本地缓存 */
export async function deleteCachedAsset(url) {
    const db = await initDB();
    const tx = db.transaction([storeName], "readwrite");
    await new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).delete(url);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
    memoryCache.delete(url);
}

export async function getCacheSize() {
    const db = await initDB();
    const tx = db.transaction([storeName], "readonly");
    return new Promise((resolve, reject) => {
        let total = 0;
        const req = tx.objectStore(storeName).openCursor();
        req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                total += cursor.value.arrayBuffer?.byteLength || 0;
                cursor.continue();
            } else {
                resolve(total);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

export async function clearAllCache() {
    const db = await initDB();
    const tx = db.transaction([storeName], "readwrite");
    await new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
    memoryCache.clear();
}
