// @ts-nocheck
// 精简版本地 IndexedDB KV 存储：只保留通用 KV 层，供 nimo-clone-storage.js 使用。

const DB_NAME = "st_tavern_audio_kv";
const DB_VERSION = 1;
const STORE_NAME = "kv";

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        req.onerror = (ev) => reject(ev.target.error);
        req.onsuccess = (ev) => resolve(ev.target.result);
    });
    return dbPromise;
}

async function put(id, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put({ id, data, updatedAt: Date.now() });
        req.onsuccess = () => resolve(true);
        req.onerror = (ev) => reject(ev.target.error);
    });
}

async function get(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = (ev) => resolve(ev.target.result ? ev.target.result.data : null);
        req.onerror = (ev) => reject(ev.target.error);
    });
}

async function del(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = (ev) => reject(ev.target.error);
    });
}

const KV_PREFIX = "kv_";
export async function saveKv(name, data) {
    if (!name) throw new Error("saveKv: name 不能为空");
    return put(KV_PREFIX + name, data);
}
export async function getKv(name) {
    if (!name) return null;
    return get(KV_PREFIX + name);
}
export async function deleteKv(name) {
    if (!name) return false;
    return del(KV_PREFIX + name);
}
