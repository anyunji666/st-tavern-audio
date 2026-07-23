// @ts-nocheck
// 精简版 BGM/环境音/音效 素材库：从设置里的一段文本解析，格式每行：
//   key=url=uploader=volume
// 例如：
//   雨声=https://example.com/rain.mp3=用户A=100

import { getSettings } from "./config.js";

let assetArray = [];

/** 纯函数：把"key=url=上传者=音量"文本解析成素材数组，不依赖已保存的设置。 */
export function parseAssetLines(content) {
    const list = [];
    String(content || "").split("\n").forEach(line => {
        if (!line.trim()) return;
        const [k, url, uploader, volume] = line.split("=");
        if (k && url) {
            list.push({
                key: k.trim(),
                url: url.trim(),
                uploader: uploader ? uploader.trim() : "N/A",
                volume: volume ? parseFloat(volume.trim()) : 100,
            });
        }
    });
    return list;
}

export function reloadAudioAssets() {
    const settings = getSettings();
    assetArray = parseAssetLines(settings.audio_assets_content || "");
    return assetArray;
}

export function listAudioAssets() {
    return [...assetArray];
}

/**
 * 按 key 查找素材（精确优先，其次字符级模糊匹配）。
 * @param {string} name
 * @returns {{url:string, volume:number, uploader:string}|null}
 */
export function findAudioAsset(name) {
    if (typeof name !== "string" || !name.trim()) return null;
    const queryKey = name.trim();

    const exact = assetArray.find(item => item.key === queryKey);
    if (exact) return exact;

    const normalize = (str) => str.replace(/_/g, "");
    const targetChars = Array.from(normalize(queryKey));

    let best = null, bestScore = -1, bestDiff = Infinity;
    for (const item of assetArray) {
        const candidateChars = Array.from(normalize(item.key));
        const pool = [...targetChars];
        let score = 0;
        for (const ch of candidateChars) {
            const idx = pool.indexOf(ch);
            if (idx !== -1) { score++; pool.splice(idx, 1); }
        }
        const diff = Math.abs(candidateChars.length - targetChars.length);
        if (score > bestScore || (score === bestScore && diff < bestDiff)) {
            best = item; bestScore = score; bestDiff = diff;
        }
    }
    return (best && bestScore > 0) ? best : null;
}
