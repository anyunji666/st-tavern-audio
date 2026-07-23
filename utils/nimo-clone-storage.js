// @ts-nocheck
// 精简版：MiMo 音色复刻参考音频存储，只保留浏览器 IndexedDB 本地存储。

import { saveKv, getKv, deleteKv } from "./local-kv-store.js";

/**
 * 保存复刻音频（纯 base64，不含 data: 前缀）。
 */
export async function saveCloneAudio(kvId, base64, mime) {
    await saveKv(kvId, { b64: base64, mime });
    console.log(`[nimo-clone-storage] 已保存到本地: ${kvId}`);
}

/**
 * 读取复刻音频。
 * @returns {Promise<{b64:string, mime:string}|null>}
 */
export async function getCloneAudio(kvId) {
    if (!kvId) return null;
    try {
        return await getKv(kvId);
    } catch (e) {
        console.warn("[nimo-clone-storage] 读取失败:", e);
        return null;
    }
}

export async function deleteCloneAudio(kvId) {
    if (!kvId) return false;
    try {
        await deleteKv(kvId);
        return true;
    } catch (e) {
        return false;
    }
}
