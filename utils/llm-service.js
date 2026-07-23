// @ts-nocheck
// 精简版 LLM 请求服务：单一 API 配置（url/key/model），浏览器直连 API。

import { getSettings } from "./config.js";

function tryParseJsonText(text) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch (_) { return null; }
}

function extractApiErrorMessage(data) {
    if (!data) return "";
    const source = (typeof data === "object" && data.error !== undefined) ? data.error : data;
    if (typeof source === "string") return source;
    if (!source || typeof source !== "object") return "";
    return source.message || JSON.stringify(source).slice(0, 300);
}

/**
 * 发起一次 chat/completions 请求（非流式），返回文本内容。
 * @param {Array<{role:string, content:string}>} messages
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function executeLLMRequest(messages, signal) {
    const settings = getSettings();
    const cfg = settings.llm_profile || {};
    const { api_url, api_key, model, temperature, max_tokens } = cfg;

    if (!api_url) throw new Error("未配置 API Base URL");
    if (!model) throw new Error("未配置模型");
    if (!api_key) throw new Error("未配置 API Key");

    const baseUrl = api_url.replace(/\/$/, "");
    const payload = { model, messages, temperature, max_tokens, stream: false };

    const url = baseUrl + "/chat/completions";
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${api_key}` };
    const body = JSON.stringify(payload);

    const resp = await fetch(url, { method: "POST", headers, body, signal });

    const rawText = await resp.text();
    const data = tryParseJsonText(rawText);

    if (!resp.ok) {
        const apiMsg = extractApiErrorMessage(data);
        throw new Error(`HTTP ${resp.status}${apiMsg ? `: ${apiMsg}` : ""}`);
    }
    if (!data) throw new Error("LLM 响应不是有效 JSON");

    const apiError = extractApiErrorMessage(data?.error);
    if (apiError) throw new Error(apiError);

    return data?.choices?.[0]?.message?.content || "";
}

function normalizeModelList(data) {
    // 标准 OpenAI 兼容格式：{ data: [{id:"..."}, ...] }；也兼容直接返回数组或 {models:[...]} 的情况。
    const arr = Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : [];
    const names = arr.map(m => (typeof m === "string" ? m : (m?.id || m?.name || ""))).filter(Boolean);
    return [...new Set(names)];
}

/**
 * 拉取供应商的模型列表（标准 OpenAI 兼容 GET /v1/models，浏览器直连）。
 * @returns {Promise<string[]>}
 */
export async function fetchModelList() {
    const settings = getSettings();
    const cfg = settings.llm_profile || {};
    const { api_url, api_key } = cfg;

    if (!api_url) throw new Error("请先填写 API Base URL");

    const baseUrl = api_url.replace(/\/$/, "");
    const url = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
    const headers = { "Content-Type": "application/json", ...(api_key ? { "Authorization": `Bearer ${api_key}` } : {}) };
    const resp = await fetch(url, { method: "GET", headers });

    const rawText = await resp.text();
    const data = tryParseJsonText(rawText);

    if (!resp.ok) {
        const apiMsg = extractApiErrorMessage(data);
        throw new Error(`HTTP ${resp.status}${apiMsg ? `: ${apiMsg}` : ""}`);
    }
    if (!data) throw new Error("响应不是有效 JSON");

    const apiError = extractApiErrorMessage(data?.error);
    if (apiError) throw new Error(apiError);

    return normalizeModelList(data);
}
