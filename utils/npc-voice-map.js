// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  角色 / NPC 音色解析
//  ─────────────────────────────────────────────────────────
//  优先级：
//    1) 旁白 (__narrator__)           -> settings.narrator_voice
//    2) 角色卡绑定 (character_voice_bindings)
//    3) NPC 已分配类别 (npc_voice_map[name].category)
//       -> 具体音色查 settings.fallback_voices[category]
//    4) 未分配 -> 返回 null，由调用方（index.js）拿着 LLM 给出的
//       assign_fallback 结果调用 assignFallbackForNpc() 落盘后重新解析。
//
//  这样同一个 NPC（如"老板娘"）只要被分类过一次，之后每回合都会
//  复用同一个 fallback 分类对应的音色，不会因为 LLM 每次重新判断
//  而在男声/女声之间跳变。
// ═══════════════════════════════════════════════════════════

import { saveSettingsDebounced } from "../../../../../script.js";
import { getSettings, FALLBACK_VOICE_CATEGORIES } from "./config.js";

export const NARRATOR_KEY = "__narrator__";

function save() {
    saveSettingsDebounced();
}

/**
 * 按"主名或任意别名"查找角色绑定条目。
 * @returns {{provider:string, speaker:string, aliases?:string[]}|null}
 */
function findCharacterBindingEntry(settings, name) {
    const bindings = settings.character_voice_bindings || {};
    if (bindings[name]) return bindings[name];
    for (const v of Object.values(bindings)) {
        if (Array.isArray(v?.aliases) && v.aliases.includes(name)) return v;
    }
    return null;
}

/**
 * 解析一个说话人名字应使用的音色。
 * @param {string} speakerName
 * @returns {{provider:string, speaker:string, source:string, category?:string, disabled?:boolean}|null}
 *   返回 null = 未配置（需要在设置面板里补音色，pipeline 会记警告日志）
 *   返回 {disabled:true} = 用户主动关闭了该类别（不记日志，静默跳过）
 */
export function resolveSpeakerVoice(speakerName) {
    const settings = getSettings();
    const name = String(speakerName || "").trim();
    if (!name) return null;

    if (name === NARRATOR_KEY) {
        const v = settings.narrator_voice || {};
        if (v.enabled === false) return { disabled: true, source: "narrator" };
        if (!v.speaker) return null;
        return { provider: v.provider || "doubao", speaker: v.speaker, source: "narrator" };
    }

    const bound = findCharacterBindingEntry(settings, name);
    if (bound?.speaker) {
        return { provider: bound.provider || "doubao", speaker: bound.speaker, source: "character" };
    }

    const npcEntry = settings.npc_voice_map?.[name];
    if (npcEntry?.category) {
        const fb = settings.fallback_voices?.[npcEntry.category];
        if (fb?.enabled === false) return { disabled: true, source: "npc-cached", category: npcEntry.category };
        if (fb?.speaker) {
            return { provider: fb.provider || "doubao", speaker: fb.speaker, source: "npc-cached", category: npcEntry.category };
        }
    }

    return null;
}

/**
 * 检查某个说话人是否已经"有地方可查"（角色绑定 或 npc_voice_map 已记录）。
 * 用于判断是否需要让 LLM 对这个新名字做一次年龄/性别分类。
 */
export function isSpeakerKnown(speakerName) {
    const settings = getSettings();
    const name = String(speakerName || "").trim();
    if (!name || name === NARRATOR_KEY) return true;
    if (findCharacterBindingEntry(settings, name)) return true;
    if (settings.npc_voice_map?.[name]?.category) return true;
    return false;
}

/**
 * 为一个新出现的 NPC 落盘分类（只在第一次出现时写入，之后不再改变，
 * 除非用户在设置面板里手动修改）。
 * @param {string} name
 * @param {string} category  male|female|uncle|aunt|boy|girl
 * @returns {boolean} 是否实际写入（false = 已存在，未覆盖）
 */
export function assignFallbackForNpc(name, category) {
    const settings = getSettings();
    const key = String(name || "").trim();
    if (!key || key === NARRATOR_KEY) return false;
    if (!FALLBACK_VOICE_CATEGORIES.some(c => c.key === category)) {
        console.warn(`[npc-voice-map] 未知分类 "${category}"，已忽略对 "${key}" 的分配`);
        return false;
    }
    if (findCharacterBindingEntry(settings, key)) return false; // 已经是绑定角色（含别名匹配），不需要 NPC 分类
    if (settings.npc_voice_map[key]?.category) return false; // 已分配过，不覆盖

    settings.npc_voice_map[key] = { category, assignedAt: Date.now() };
    save();
    return true;
}

/** 手动覆盖/编辑某个 NPC 的分类（设置面板用） */
export function setNpcCategory(name, category) {
    const settings = getSettings();
    const key = String(name || "").trim();
    if (!key) return false;
    if (!FALLBACK_VOICE_CATEGORIES.some(c => c.key === category)) return false;
    settings.npc_voice_map[key] = { ...(settings.npc_voice_map[key] || {}), category, assignedAt: Date.now() };
    save();
    return true;
}

export function removeNpcMapping(name) {
    const settings = getSettings();
    const key = String(name || "").trim();
    if (!key || !settings.npc_voice_map[key]) return false;
    delete settings.npc_voice_map[key];
    save();
    return true;
}

export function listNpcVoiceMap() {
    const settings = getSettings();
    return Object.entries(settings.npc_voice_map || {}).map(([name, v]) => ({ name, ...v }));
}

/** 角色卡音色绑定 CRUD。aliases为该角色除主名外的其他称呼/别名列表。 */
export function setCharacterVoiceBinding(cardName, provider, speaker, aliases = []) {
    const settings = getSettings();
    const key = String(cardName || "").trim();
    if (!key) return false;
    const cleanAliases = Array.isArray(aliases)
        ? [...new Set(aliases.map(a => String(a || "").trim()).filter(a => a && a !== key))]
        : [];
    settings.character_voice_bindings[key] = { provider, speaker, aliases: cleanAliases };
    save();
    return true;
}

export function removeCharacterVoiceBinding(cardName) {
    const settings = getSettings();
    const key = String(cardName || "").trim();
    if (!key || !settings.character_voice_bindings[key]) return false;
    delete settings.character_voice_bindings[key];
    save();
    return true;
}

export function listCharacterVoiceBindings() {
    const settings = getSettings();
    return Object.entries(settings.character_voice_bindings || {}).map(([name, v]) => ({
        name,
        provider: v.provider,
        speaker: v.speaker,
        aliases: Array.isArray(v.aliases) ? v.aliases : [],
    }));
}

/** 兜底音色池 CRUD（男/女/大爷/大妈/男孩/女孩 + 旁白） */
export function setFallbackVoice(category, provider, speaker) {
    const settings = getSettings();
    if (!FALLBACK_VOICE_CATEGORIES.some(c => c.key === category)) return false;
    const prevEnabled = settings.fallback_voices[category]?.enabled;
    settings.fallback_voices[category] = { provider, speaker, enabled: prevEnabled !== false };
    save();
    return true;
}

export function setFallbackVoiceEnabled(category, enabled) {
    const settings = getSettings();
    if (!FALLBACK_VOICE_CATEGORIES.some(c => c.key === category)) return false;
    if (!settings.fallback_voices[category]) settings.fallback_voices[category] = { provider: "doubao", speaker: "" };
    settings.fallback_voices[category].enabled = !!enabled;
    save();
    return true;
}

export function setNarratorVoice(provider, speaker) {
    const settings = getSettings();
    const prevEnabled = settings.narrator_voice?.enabled;
    settings.narrator_voice = { provider, speaker, enabled: prevEnabled !== false };
    save();
    return true;
}

export function setNarratorVoiceEnabled(enabled) {
    const settings = getSettings();
    if (!settings.narrator_voice) settings.narrator_voice = { provider: "doubao", speaker: "" };
    settings.narrator_voice.enabled = !!enabled;
    save();
    return true;
}
