// @ts-nocheck
// 解析 LLM 返回文本 -> 结构化编排结果。
// 容错：LLM 可能把 JSON 包在 ```json ... ``` 代码块里，或前后带一点说明文字。

/**
 * @param {string} rawText
 * @returns {{narrator_voice_key:string, segments:Array<object>, assign_fallback:Array<object>}}
 */
export function parseAudioPlan(rawText) {
    const text = String(rawText || "").trim();
    if (!text) throw new Error("LLM 未返回内容");

    let jsonText = text;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        jsonText = fenced[1].trim();
    } else {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
            jsonText = text.slice(start, end + 1);
        }
    }

    let data;
    try {
        data = JSON.parse(jsonText);
    } catch (e) {
        throw new Error(`无法解析编排结果为 JSON: ${e.message}`);
    }

    const segments = Array.isArray(data.segments) ? data.segments : [];
    const assignFallback = Array.isArray(data.assign_fallback) ? data.assign_fallback : [];

    const normalizedSegments = segments.map(normalizeSegment).filter(Boolean);

    return {
        narrator_voice_key: data.narrator_voice_key || "__narrator__",
        segments: normalizedSegments,
        assign_fallback: assignFallback
            .filter(a => a && a.name && a.category)
            .map(a => ({ name: String(a.name).trim(), category: String(a.category).trim() })),
    };
}

function normalizeSegment(seg) {
    if (!seg || typeof seg !== "object") return null;
    const type = String(seg.type || "").toLowerCase();

    if (type === "music" || type === "ambiance" || type === "sfx") {
        if (!seg.asset_key) return null;
        const result = { type, assetKey: String(seg.asset_key).trim() };
        if (type === "sfx") {
            const d = Number(seg.duration_sec);
            result.durationSec = Number.isFinite(d) && d > 0 ? d : null;
        }
        return result;
    }
    if (type === "voice") {
        const speakerText = String(seg.text || "").trim();
        if (!speakerText) return null;
        return {
            type: "voice",
            speaker: String(seg.speaker || "__narrator__").trim(),
            text: speakerText,
            mood: String(seg.mood || "").trim(),
        };
    }
    return null;
}
