// @ts-nocheck
import { getSettings } from "./config.js";
import { listAudioAssets } from "./world-info.js";

function formatCharacterBindings(settings) {
    const entries = Object.entries(settings.character_voice_bindings || {});
    if (!entries.length) return "（暂无已绑定角色）";
    return entries.map(([name, v]) => {
        const aliases = Array.isArray(v.aliases) ? v.aliases.filter(Boolean) : [];
        const aliasPart = aliases.length ? `，此角色的其他称呼/别名：${aliases.join("、")}（出现任意一个都算同一个角色）` : "";
        return `- ${name}${aliasPart} -> voice_name="${name}"（内部音色: ${v.provider}:${v.speaker}）`;
    }).join("\n");
}

function getActivePromptTemplateContent(settings) {
    const list = Array.isArray(settings.prompt_templates) ? settings.prompt_templates : [];
    const active = list.find(t => t.id === settings.active_prompt_template_id) || list[0];
    return active ? (active.content || "") : "";
}

function formatNpcVoiceMap(settings) {
    const entries = Object.entries(settings.npc_voice_map || {});
    if (!entries.length) return "（暂无已分配的NPC）";
    return entries.map(([name, v]) => `- ${name} -> 已归类: ${v.category}`).join("\n");
}

function formatAudioAssets() {
    const assets = listAudioAssets();
    if (!assets.length) return "（暂无素材，可省略 music/ambiance/sfx 事件）";
    return assets.map(a => `- ${a.key}`).join("\n");
}

/**
 * 用当前设置 + 本回合正文，渲染出最终发给 LLM 的 prompt 文本。
 * @param {string} messageText
 * @returns {string}
 */
export function buildAudioPrompt(messageText) {
    const settings = getSettings();
    const template = getActivePromptTemplateContent(settings);
    return template
        .replaceAll("{{character_voice_bindings}}", formatCharacterBindings(settings))
        .replaceAll("{{npc_voice_map}}", formatNpcVoiceMap(settings))
        .replaceAll("{{audio_assets}}", formatAudioAssets())
        .replaceAll("{{message_text}}", messageText || "");
}
