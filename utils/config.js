// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  酒馆音效精灵 - 设置结构
//  豆包/MiMo/Edge-TTS 三 TTS 供应商、角色音色绑定、NPC 兜底音色
//  持久化映射、LLM 解析配置、Prompt 模板管理、BGM/SFX 素材库、
//  播放音量设置。
// ═══════════════════════════════════════════════════════════

import { extension_settings } from "../../../../extensions.js";

export const extensionName = "st-tavern-audio";
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

export const eventNames = {
    LLM_RESULT_READY: "st-tavern-audio:llm-result-ready",
    SETTINGS_CHANGED: "st-tavern-audio:settings-changed",
    NPC_VOICE_MAP_CHANGED: "st-tavern-audio:npc-voice-map-changed",
};

// NPC 兜底音色分类（未绑定角色卡、也未出现在 npc_voice_map 中的新角色，
// 由 LLM 按年龄/性别归入以下六类之一）
export const FALLBACK_VOICE_CATEGORIES = [
    { key: "male", label: "男生" },
    { key: "female", label: "女生" },
    { key: "uncle", label: "大爷" },
    { key: "aunt", label: "大妈" },
    { key: "boy", label: "男孩" },
    { key: "girl", label: "女孩" },
];

// mood 字段在豆包/MiMo 里会真正影响合成效果（豆包当 context_texts 语境提示，
// MiMo 当 stylePrefix 风格前缀），所以要求 LLM 认真写。统一只保留这一版详细指令
// （Edge-TTS 虽然不接这个字段，但多写的描述不影响合成结果，通用模板维护更简单）。
const MOOD_INSTRUCTION_DETAILED =
    `- mood（语气提示）不要写成"开心""害怕"这种孤立的形容词，效果很弱。要写成有画面感、有场景代入的具体描述，包含情绪+语调走向+说话状态等细节，比如"用甜蜜撒娇的声音，像在跟男朋友撒娇，语调上扬很开心"、"压低声音带着颤抖，像是怕被人听到又强忍着恐惧"。越具体越好，避免用单个词敷衍。`;
const MOOD_EXAMPLE_DETAILED =
    `语气提示，要具体有画面感，如'用甜蜜撒娇的声音，像在跟男朋友撒娇，语调上扬很开心'、'压低声音带着颤抖，像是怕被人听到又强忍着恐惧'，不要只写'开心''害怕'这种孤立词`;

function buildPromptTemplate(moodInstruction, moodExample) {
    return `你是一个"酒馆场景音效编排助手"。下面会给你一段游戏/小说风格的AI回复正文，你需要输出一份结构化的音频编排方案。

【基本原则】
- 对话是用符号标记出来的（引号 ""/"" 、「」，或"XX说/道/喊道："这类提示词），直接按这些符号识别说话人和台词，不要过度推理。
- *星号*包裹的内心独白/心理描写，不属于对话也不属于旁白，直接跳过，不要为它生成任何VOICE事件（不能并入旁白，也不能单独起一条）。
- 你不需要输出机械的字符位置，只需要按正文的自然顺序，列出这一回合里依次出现的：背景音乐(Music)、环境音(Ambiance)、音效(SFX)、语音(VOICE) 事件。
- 背景音乐(Music)会一直循环播放，直到被下一次编排换掉，不需要每次都重复给同一首。
- 环境音(Ambiance)只播放一次、不循环（素材本身可能就比较长，比如一整段环境采样），素材放完就自然结束。
- 音效(SFX)可以选填 duration_sec（数字，单位秒）来控制播放时长：不填就播放素材本身的完整长度；填了且比素材短，会在这个时长提前收尾（不会循环拉长去凑时长），所以只在你想让音效"提前掐断、只播一小段"时才填，比如一声短促的枪响只需要 0.5 秒，别用来延长音效。
- 旁白（非对话的叙事文字）整体作为一条 VOICE，speaker 固定填 "__narrator__"。
${moodInstruction}

【角色音色判断】
- 每个说话人先看是否是"已绑定音色的角色卡"（由用户配置，你会在下面的角色音色列表里看到），是的话直接用其绑定音色名。
- 不是的话，看是否已经出现在"NPC音色映射表"里（下面会给你），如果有，直接复用同一个 fallback_id，不要重新分配。
- 全新出现、且没有绑定也没有映射记录的NPC，你需要：
  1) 判断这个角色的性别，以及大致的实际年龄（数字）——不要被称呼、身份词带偏，只看真实年龄
  2) 严格按下面的数字年龄区间归类到六类之一（类目名只是标签，判断依据是年龄数字，不是称呼本身）：
     - boy：男性，年龄 3~12 岁（幼儿园/小学阶段的男孩）
     - girl：女性，年龄 3~12 岁（幼儿园/小学阶段的女孩）
     - male：男性，年龄 13~60 岁（从中学生到退休前的成年男性，不论称呼是"男生"还是"男人"）
     - female：女性，年龄 13~60 岁（从中学生到退休前的成年女性，不论称呼是"女生"还是"女人"）
     - uncle：男性，年龄 61 岁以上
     - aunt：女性，年龄 61 岁以上
     若原文没有直接给出年龄数字，可根据"小学生/中学生/大学生/职场人/爷爷奶奶/白发苍苍"等线索合理推断落在哪个数字区间，但推断结果仍要落在上述年龄区间内，不要仅凭"学生"这类词就归到男孩/女孩（比如高中生、大学生属于 male/female，不是 boy/girl）。
  3) 在返回结果里用 "assign_fallback" 字段声明："这个角色名 -> 归类"，以便系统记住，下次同名角色继续用同一个具体音色。

【角色音色列表（已绑定，直接使用其 voice_name）】
{{character_voice_bindings}}

【NPC音色映射表（已分配，遇到同名直接沿用）】
{{npc_voice_map}}

【可用BGM/环境音/音效素材（按 key 引用，找不到就留空或省略该事件）】
{{audio_assets}}

【输出格式】严格按如下 JSON 输出，不要输出多余文字：
{
  "narrator_voice_key": "__narrator__",
  "segments": [
    {"type": "music", "asset_key": "素材key"},
    {"type": "ambiance", "asset_key": "素材key"},
    {"type": "sfx", "asset_key": "素材key", "duration_sec": 0.5},
    {"type": "voice", "speaker": "说话人名字或__narrator__", "text": "要合成的原文文本", "mood": "${moodExample}"}
  ],
  "assign_fallback": [
    {"name": "角色名", "category": "male|female|uncle|aunt|boy|girl"}
  ]
}

【本回合正文】
{{message_text}}
`;
}

export const DEFAULT_PROMPT_TEMPLATE = buildPromptTemplate(MOOD_INSTRUCTION_DETAILED, MOOD_EXAMPLE_DETAILED);

function ensureRoot() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    return extension_settings[extensionName];
}

/**
 * 确保设置结构完整（首次加载 / 版本升级时调用）。
 * 只做"缺字段补默认值"，不覆盖用户已有配置。
 */
export function ensureDefaultSettings() {
    const s = ensureRoot();

    if (typeof s.enabled !== "boolean") s.enabled = true;

    if (typeof s.masterVolume !== "number") s.masterVolume = 1;
    if (typeof s.musicVolume !== "number") s.musicVolume = 0.5;
    if (typeof s.ambianceVolume !== "number") s.ambianceVolume = 0.5;
    if (typeof s.sfxVolume !== "number") s.sfxVolume = 0.8;
    if (typeof s.voiceVolume !== "number") s.voiceVolume = 1;

    if (!s.doubao || typeof s.doubao !== "object") s.doubao = {};
    if (typeof s.doubao.app_id !== "string") s.doubao.app_id = "";
    if (typeof s.doubao.access_key !== "string") s.doubao.access_key = "";
    if (!s.doubao.speakers || typeof s.doubao.speakers !== "object") s.doubao.speakers = {};

    // MiMo 的设置根节点由 nimo-voices.js 的 getRoot() 独立管理（extension_settings[extensionName].nimo）

    if (!s.edge || typeof s.edge !== "object") s.edge = {};
    if (!s.edge.speakers || typeof s.edge.speakers !== "object") s.edge.speakers = {};

    if (!s.narrator_voice || typeof s.narrator_voice !== "object") {
        s.narrator_voice = { provider: "doubao", speaker: "" };
    }
    if (typeof s.narrator_voice.enabled !== "boolean") s.narrator_voice.enabled = true;

    if (!s.fallback_voices || typeof s.fallback_voices !== "object") s.fallback_voices = {};
    for (const cat of FALLBACK_VOICE_CATEGORIES) {
        if (!s.fallback_voices[cat.key] || typeof s.fallback_voices[cat.key] !== "object") {
            s.fallback_voices[cat.key] = { provider: "doubao", speaker: "" };
        }
        if (typeof s.fallback_voices[cat.key].enabled !== "boolean") s.fallback_voices[cat.key].enabled = true;
    }

    // 角色卡名 -> { provider, speaker }
    if (!s.character_voice_bindings || typeof s.character_voice_bindings !== "object") {
        s.character_voice_bindings = {};
    }

    // NPC名 -> { category, provider, speaker }  持久化映射，跨回合保持一致
    if (!s.npc_voice_map || typeof s.npc_voice_map !== "object") {
        s.npc_voice_map = {};
    }

    if (!s.llm_profile || typeof s.llm_profile !== "object") s.llm_profile = {};
    if (typeof s.llm_profile.api_url !== "string") s.llm_profile.api_url = "";
    if (typeof s.llm_profile.api_key !== "string") s.llm_profile.api_key = "";
    if (typeof s.llm_profile.model !== "string") s.llm_profile.model = "";
    if (typeof s.llm_profile.temperature !== "number") s.llm_profile.temperature = 0.7;
    if (typeof s.llm_profile.max_tokens !== "number") s.llm_profile.max_tokens = 4096;

    // Prompt 模板为列表结构，支持多模板管理（新建/重命名/删除/切换，见 ui-settings.js）；
    // 首次加载时只预置一份通用默认模板，用户仍可按需自行新建更多模板。
    if (!Array.isArray(s.prompt_templates) || !s.prompt_templates.length) {
        s.prompt_templates = [
            { id: "default", name: "默认模板", content: DEFAULT_PROMPT_TEMPLATE },
        ];
    }
    if (typeof s.active_prompt_template_id !== "string" || !s.prompt_templates.some(t => t.id === s.active_prompt_template_id)) {
        s.active_prompt_template_id = s.prompt_templates[0].id;
    }

    // BGM/SFX 素材库：沿用 "key=url=uploader=volume" 的文本行格式
    if (typeof s.audio_assets_content !== "string") s.audio_assets_content = "";

    return s;
}

export function getSettings() {
    return ensureRoot();
}
