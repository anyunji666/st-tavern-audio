// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  悬浮窗状态管理：纯内存、不持久化。
//  - 每次 pipeline 开始处理新一楼时调用 beginGeneration()，
//    拿到本轮的 token + AbortSignal。
//  - pipeline 在每个可能耗时的步骤前用 isTokenActive(token) 检查，
//    一旦发现令牌已经不是当前令牌（说明用户点了"跳过"，或者
//    新的一楼又开始了），就提前退出，不再产生副作用。
//  - "跳过"按钮统一调用 skip()：让当前令牌失效、中止正在进行的
//    LLM 请求、并停止播放队列（当前正在响的这条播完为止）。
// ═══════════════════════════════════════════════════════════

import { stopAll } from "./playback-engine.js";

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

let currentToken = 0;
let activeController = null;

let state = {
    phase: "idle", // idle | requesting_llm | synthesizing | playing | error
    current: 0,
    total: 0,
    message: "",
};

function notify() {
    for (const fn of listeners) {
        try { fn(state); } catch (e) { console.error("[panel-state] 监听器出错:", e); }
    }
}

function setState(patch) {
    state = { ...state, ...patch };
    notify();
}

/**
 * 订阅状态变化，立即用当前状态回调一次。
 * @returns {() => void} 取消订阅函数
 */
export function subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
}

export function getState() {
    return state;
}

/**
 * 开启新一轮生成。会自动让上一轮的令牌失效。
 * @returns {{token:number, signal:AbortSignal}}
 */
export function beginGeneration() {
    currentToken += 1;
    const token = currentToken;
    activeController = new AbortController();
    setState({ phase: "requesting_llm", current: 0, total: 0, message: "正在编排音效…" });
    return { token, signal: activeController.signal };
}

/** 传入的 token 是否仍然是"当前这一轮" */
export function isTokenActive(token) {
    return token === currentToken;
}

export function setSynthesizing(current, total) {
    setState({ phase: "synthesizing", current, total, message: `正在生成音频 ${current}/${total}` });
}

export function setPlaying() {
    setState({ phase: "playing", message: "正在播放" });
}

export function setError(message) {
    setState({ phase: "error", message: String(message || "") });
}

/** 正常结束（生成+播放都跑完了），面板回到空闲态（常驻显示，不再隐藏） */
export function finish() {
    activeController = null;
    setState({ phase: "idle", current: 0, total: 0, message: "" });
}

/**
 * 用户点击"跳过/停止音乐"（或切换会话时调用）：
 * 让当前令牌失效、中止正在进行的 LLM 请求、并停止播放队列（含循环中的BGM/环境音）。
 * 空闲态下点击本质就是"停止音乐"：没有生成任务可中止，但仍会调用 stopAll() 停掉可能还在循环的BGM。
 */
export function skip() {
    currentToken += 1;
    if (activeController) {
        try { activeController.abort(); } catch (_) {}
        activeController = null;
    }
    stopAll();
    setState({ phase: "idle", current: 0, total: 0, message: "" });
}
