// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  运行日志：纯内存存储，记录 pipeline 处理过程中的"跳过/失败"事件，
//  供设置面板"运行日志"页签展示，方便排查"这一轮怎么没声音"。
//  不写入插件设置，不跨会话持久化；刷新页面/重启酒馆后自动清空。
// ═══════════════════════════════════════════════════════════

const MAX_ENTRIES = 200;

/** @type {Array<{time:number, level:'warn'|'error', message:string}>} */
let entries = [];

/** @type {object|null} 最近一次编排LLM返回并解析成功的结构化方案，每次处理新回合直接覆盖 */
let lastPlan = null;

/**
 * 记录最近一次编排结果（覆盖式，只保留最新一份）。
 * @param {object} plan parseAudioPlan() 的返回值
 */
export function setLastPlan(plan) {
    lastPlan = { time: Date.now(), plan };
}

/** 取最近一次编排结果，尚无则返回 null */
export function getLastPlan() {
    return lastPlan;
}

/**
 * 记录一条日志。
 * @param {'warn'|'error'} level
 * @param {string} message
 */
export function addLogEntry(level, message) {
    entries.push({ time: Date.now(), level, message: String(message || "") });
    if (entries.length > MAX_ENTRIES) {
        entries = entries.slice(entries.length - MAX_ENTRIES);
    }
}

/**
 * 取全部日志，按时间倒序（最新的在最前）。
 * @returns {Array<{time:number, level:string, message:string}>}
 */
export function listLogEntries() {
    return [...entries].reverse();
}

/** 清空全部日志 */
export function clearLogEntries() {
    entries = [];
}
