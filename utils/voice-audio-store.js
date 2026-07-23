// @ts-nocheck
// 语音合成结果的本地持久化：每条生成的语音都落盘到 IndexedDB，
// 供用户在"缓存管理"面板里浏览、试听、删除。

const DB_NAME = "STTavernVoiceStoreDB";
const DB_VERSION = 1;
const STORE_NAME = "voiceLines";

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
                store.createIndex("timestamp", "timestamp", { unique: false });
            }
        };
        req.onerror = (ev) => reject(ev.target.error);
        req.onsuccess = (ev) => resolve(ev.target.result);
    });
    return dbPromise;
}

/**
 * 保存一条已合成的语音。
 * @param {string} cacheKey
 * @param {object} meta { speaker, text, mood, provider, mime }
 * @param {ArrayBuffer} arrayBuffer
 */
export async function saveVoiceLine(cacheKey, meta, arrayBuffer) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put({
            cacheKey,
            ...meta,
            arrayBuffer,
            timestamp: Date.now(),
        });
        req.onsuccess = () => resolve(true);
        req.onerror = (ev) => reject(ev.target.error);
    });
}

export async function getVoiceLine(cacheKey) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(cacheKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (ev) => reject(ev.target.error);
    });
}

/** 列出全部已保存的语音（不含二进制数据，供列表展示） */
export async function listVoiceLines() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const items = [];
        const req = tx.objectStore(STORE_NAME).openCursor();
        req.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor) {
                const { arrayBuffer, ...rest } = cursor.value;
                items.push({ ...rest, sizeBytes: arrayBuffer?.byteLength || 0 });
                cursor.continue();
            } else {
                resolve(items.sort((a, b) => b.timestamp - a.timestamp));
            }
        };
        req.onerror = (ev) => reject(ev.target.error);
    });
}

export async function deleteVoiceLine(cacheKey) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(cacheKey);
        req.onsuccess = () => resolve(true);
        req.onerror = (ev) => reject(ev.target.error);
    });
}

export async function clearAllVoiceLines() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve(true);
        req.onerror = (ev) => reject(ev.target.error);
    });
}
