// @ts-nocheck
import { saveSettingsDebounced } from "../../../../../script.js";
import { getSettings, FALLBACK_VOICE_CATEGORIES, DEFAULT_PROMPT_TEMPLATE } from "./config.js";
import { applyBusVolumes } from "./playback-engine.js";
import {
    listCharacterVoiceBindings, setCharacterVoiceBinding, removeCharacterVoiceBinding,
    listNpcVoiceMap, setNpcCategory, removeNpcMapping,
    setFallbackVoice, setNarratorVoice, setFallbackVoiceEnabled, setNarratorVoiceEnabled,
} from "./npc-voice-map.js";
import { getRoot as getNimoRoot, listPresetVoices, addPresetVoice, listMyVoices, deleteMyVoice, addCloneVoice, findMyVoice } from "./nimo-voices.js";
import { getCloneAudio } from "./nimo-clone-storage.js";
import { b64ToBytes } from "./nimo-tts.js";
import { EDGE_VOICE_PRESETS } from "./edge-tts.js";
import { listVoiceLines, deleteVoiceLine, clearAllVoiceLines, getVoiceLine } from "./voice-audio-store.js";
import { fetchModelList } from "./llm-service.js";
import { parseAssetLines } from "./world-info.js";
import { loadStaticAudio, isAssetCached, listCachedAssets, getCachedAssetBlob, deleteCachedAsset, clearAllCache } from "./audio-cache.js";
import { listLogEntries, clearLogEntries, getLastPlan } from "./run-log.js";
import { setPanelVisible } from "./floating-panel.js";
import { skip as skipCurrentGeneration } from "./panel-state.js";

function save() { saveSettingsDebounced(); }

function escapeHtml(s) {
    return $("<div>").text(s == null ? "" : String(s)).html();
}

function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── 供应商音色下拉 ───────────────────────────────────────
// 角色音色 / NPC音色 两个页签都需要"选供应商 -> 联动出该供应商已配置的音色"，
// 音色来源统一从这里取：豆包取 settings.doubao.speakers 的 key，MiMo 取"我的音色"列表。
function getVoiceOptionsForProvider(provider) {
    if (provider === "mimo") {
        return listMyVoices().map(v => ({ value: v.id, label: mimoMyVoiceLabel(v) }));
    }
    const s = getSettings();
    if (provider === "edge") {
        const speakers = s.edge.speakers || {};
        return Object.entries(speakers).map(([key, info]) => ({ value: key, label: edgeSpeakerLabel(info) }));
    }
    const speakers = s.doubao.speakers || {};
    return Object.keys(speakers).map(name => ({ value: name, label: name }));
}

function buildSpeakerOptionsHtml(provider, selected) {
    const opts = getVoiceOptionsForProvider(provider);
    if (!opts.length) {
        return `<option value="">（暂无音色，请先到对应TTS页签添加）</option>`;
    }
    let html = `<option value="">（请选择音色）</option>`;
    for (const o of opts) {
        html += `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`;
    }
    return html;
}

// ── Tabs ─────────────────────────────────────────────
function bindTabs() {
    $(document).on("click", ".sta-tab-btn", function () {
        const tab = $(this).data("tab");
        $(".sta-tab-btn").removeClass("active");
        $(this).addClass("active");
        $(".sta-tab-content").removeClass("active");
        $(`.sta-tab-content[data-tab="${tab}"]`).addClass("active");

        // 音色下拉是从当前设置里的音色列表现取现生成的，每次点开都重新渲染，
        // 避免"刚导入/新建了音色，但下拉框还是旧的"。
        if (tab === "voices") renderCharBindings();
        if (tab === "npc") { renderFixedVoices(); renderNpcMap(); }
        if (tab === "cache") { renderVoiceCacheList(); renderAssetCacheList(); }
        if (tab === "runlog") { renderLastPlan(); renderRunLog(); }
    });
}

// ── 主设置（含 LLM 解析）────────────────────────────────
function initGeneralTab() {
    const s = getSettings();
    $("#sta_enabled").prop("checked", s.enabled).on("change", function () {
        s.enabled = $(this).is(":checked"); save();
        setPanelVisible(s.enabled);
        if (!s.enabled) skipCurrentGeneration(); // 关闭插件=立即停止当前播放/生成
    });
    const volMap = [
        ["sta_vol_master", "masterVolume"],
        ["sta_vol_music", "musicVolume"],
        ["sta_vol_ambiance", "ambianceVolume"],
        ["sta_vol_sfx", "sfxVolume"],
        ["sta_vol_voice", "voiceVolume"],
    ];
    for (const [id, key] of volMap) {
        $(`#${id}`).val(s[key]).on("input", function () {
            s[key] = parseFloat($(this).val());
            save();
            applyBusVolumes();
        });
    }
}

// ── Prompt 模板下拉渲染 ──────────────────────────────
function renderPromptTemplateOptions(s, selectedId) {
    const select = $("#sta_prompt_template_select");
    select.empty();
    for (const t of s.prompt_templates) {
        select.append(`<option value="${escapeHtml(t.id)}"${t.id === selectedId ? " selected" : ""}>${escapeHtml(t.name)}</option>`);
    }
}

function genTemplateId() {
    return "tpl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── LLM 解析（现内嵌于主设置页签）───────────────────────
function initLlmTab() {
    const s = getSettings();
    $("#sta_llm_api_url").val(s.llm_profile.api_url);
    $("#sta_llm_api_key").val(s.llm_profile.api_key);
    $("#sta_llm_model").val(s.llm_profile.model);
    $("#sta_llm_temperature").val(s.llm_profile.temperature);
    $("#sta_llm_temperature_val").text(Number(s.llm_profile.temperature ?? 0).toFixed(2));
    $("#sta_llm_max_tokens").val(s.llm_profile.max_tokens);

    $("#sta_llm_temperature").on("input", function () {
        $("#sta_llm_temperature_val").text(parseFloat($(this).val()).toFixed(2));
    });

    // 以下字段全部即时自动保存，不再需要单独的"保存"按钮
    $("#sta_llm_api_url").on("input", function () {
        s.llm_profile.api_url = $(this).val().trim();
        save();
    });
    $("#sta_llm_api_key").on("input", function () {
        s.llm_profile.api_key = $(this).val().trim();
        save();
    });
    $("#sta_llm_model").on("input", function () {
        s.llm_profile.model = $(this).val().trim();
        save();
    });
    $("#sta_llm_temperature").on("change", function () {
        s.llm_profile.temperature = parseFloat($(this).val());
        save();
    });
    $("#sta_llm_max_tokens").on("input", function () {
        s.llm_profile.max_tokens = parseInt($(this).val(), 10);
        save();
    });

    // Prompt 模板初始化
    const activeTpl = s.prompt_templates.find(t => t.id === s.active_prompt_template_id) || s.prompt_templates[0];
    renderPromptTemplateOptions(s, activeTpl.id);
    $("#sta_prompt_template").val(activeTpl.content);

    $("#sta_prompt_template").on("blur", function () {
        const tpl = s.prompt_templates.find(t => t.id === s.active_prompt_template_id);
        if (tpl) {
            tpl.content = $(this).val();
            save();
        }
    });

    // 获取模型列表（同时充当连接测试：成功即代表配置可用）
    $("#sta_llm_fetch_models").on("click", async function () {
        const btn = $(this);
        s.llm_profile.api_url = $("#sta_llm_api_url").val().trim();
        s.llm_profile.api_key = $("#sta_llm_api_key").val().trim();
        save();
        btn.prop("disabled", true).text("获取中…");
        try {
            const models = await fetchModelList();
            const datalist = $("#sta_llm_model_datalist");
            datalist.empty();
            for (const m of models) datalist.append(`<option value="${escapeHtml(m)}"></option>`);
            if (models.length) {
                // 清空模型输入框：避免浏览器原生 datalist 按输入框旧值做前缀过滤，
                // 导致新拉取的选项因不匹配旧值而不显示在下拉列表中。
                $("#sta_llm_model").val("");
                s.llm_profile.model = "";
                save();
                toastr.success(`连接成功，已获取 ${models.length} 个模型，请在模型框下拉选择`);
            } else {
                toastr.warning("连接成功，但供应商没有返回任何模型");
            }
        } catch (err) {
            toastr.error("获取模型列表失败：" + (err?.message || String(err)));
        } finally {
            btn.prop("disabled", false).text("获取模型列表");
        }
    });

    // 新建模板
    $("#sta_prompt_template_new").on("click", function () {
        const id = genTemplateId();
        const name = `新模板${s.prompt_templates.length + 1}`;
        s.prompt_templates.push({ id, name, content: DEFAULT_PROMPT_TEMPLATE });
        s.active_prompt_template_id = id;
        save();
        renderPromptTemplateOptions(s, id);
        $("#sta_prompt_template").val(DEFAULT_PROMPT_TEMPLATE);
        toastr.success(`已新建模板 "${name}"`);
    });

    // 切换模板
    $("#sta_prompt_template_select").on("change", function () {
        const id = $(this).val();
        s.active_prompt_template_id = id;
        save();
        const tpl = s.prompt_templates.find(t => t.id === id);
        $("#sta_prompt_template").val(tpl ? tpl.content : "");
    });

    // 双击模板名进入内联改名
    $("#sta_prompt_template_select").on("dblclick", function () {
        const select = $(this);
        const current = select.find("option:selected").text();
        const input = $("#sta_prompt_template_rename_input");
        input.val(current);
        select.hide();
        input.show().trigger("focus").select();
    });

    function commitTemplateRename() {
        const input = $("#sta_prompt_template_rename_input");
        const select = $("#sta_prompt_template_select");
        if (!input.is(":visible")) return;
        const newName = input.val().trim();
        const id = select.val();
        if (newName) {
            const tpl = s.prompt_templates.find(t => t.id === id);
            if (tpl && tpl.name !== newName) {
                tpl.name = newName;
                save();
            }
        }
        renderPromptTemplateOptions(s, id);
        input.hide();
        select.show();
    }
    $("#sta_prompt_template_rename_input").on("keydown", function (e) {
        if (e.key === "Enter") commitTemplateRename();
        if (e.key === "Escape") {
            $(this).hide();
            $("#sta_prompt_template_select").show();
        }
    }).on("blur", commitTemplateRename);

    // 删除当前模板（原"恢复默认模板"）
    $("#sta_prompt_reset").on("click", function () {
        if (s.prompt_templates.length <= 1) {
            toastr.warning("至少保留一个模板，无法删除");
            return;
        }
        const id = s.active_prompt_template_id;
        const tpl = s.prompt_templates.find(t => t.id === id);
        if (!confirm(`确定删除模板 "${tpl?.name || id}" 吗？此操作不可撤销。`)) return;
        s.prompt_templates = s.prompt_templates.filter(t => t.id !== id);
        s.active_prompt_template_id = s.prompt_templates[0].id;
        save();
        renderPromptTemplateOptions(s, s.active_prompt_template_id);
        $("#sta_prompt_template").val(s.prompt_templates[0].content);
        toastr.success("已删除模板");
    });
}

// ── 豆包TTS ──────────────────────────────────────────
function renderDoubaoSpeakers() {
    const s = getSettings();
    const container = $("#sta_doubao_speakers_list");
    container.empty();
    const speakers = s.doubao.speakers || {};
    const names = Object.keys(speakers);
    if (!names.length) {
        container.append('<p class="sta-hint">暂无音色，请在上方添加</p>');
        return;
    }
    for (const name of names) {
        const v = speakers[name];
        const row = $(`
            <div class="sta-row">
                <span class="sta-row-name">${escapeHtml(name)}</span>
                <span class="sta-row-sub">speaker_id=${escapeHtml(v.speaker_id)} · resource_id=${escapeHtml(v.resource_id)}</span>
                <button class="menu_button danger sta-del-doubao-speaker" data-name="${escapeHtml(name)}">删除</button>
            </div>
        `);
        container.append(row);
    }
}

function initDoubaoTab() {
    const s = getSettings();
    $("#sta_doubao_app_id").val(s.doubao.app_id).on("input", function () {
        s.doubao.app_id = $(this).val(); save();
    });
    $("#sta_doubao_access_key").val(s.doubao.access_key).on("input", function () {
        s.doubao.access_key = $(this).val(); save();
    });
    renderDoubaoSpeakers();

    $("#sta_doubao_add_speaker").on("click", function () {
        const name = $("#sta_doubao_new_name").val().trim();
        const speakerId = $("#sta_doubao_new_speaker_id").val().trim();
        const resourceId = $("#sta_doubao_new_resource_id").val().trim();
        if (!name || !speakerId || !resourceId) {
            toastr.warning("请把音色名称/speaker_id/resource_id都填完整");
            return;
        }
        s.doubao.speakers[name] = { speaker_id: speakerId, resource_id: resourceId };
        save();
        $("#sta_doubao_new_name, #sta_doubao_new_speaker_id, #sta_doubao_new_resource_id").val("");
        renderDoubaoSpeakers();
        toastr.success(`音色 "${name}" 已添加`);
    });

    $(document).on("click", ".sta-del-doubao-speaker", function () {
        const name = $(this).data("name");
        delete s.doubao.speakers[name];
        save();
        renderDoubaoSpeakers();
    });

    // 导出：我们自己的简单格式 {app_id, access_key, speakers}
    $("#sta_doubao_export_btn").on("click", function () {
        downloadJson("doubao-voices.json", {
            app_id: s.doubao.app_id,
            access_key: s.doubao.access_key,
            speakers: s.doubao.speakers,
        });
        toastr.success("已导出豆包音色配置");
    });

    // 导入：直接覆盖当前 App ID / Access Token / 音色列表。
    // 兼容两种格式：
    //   1) 我们自己导出的 {app_id, access_key, speakers:{name:{speaker_id,resource_id}}}
    //   2) 旧工具导出的 {apiConfigs:[{appId,accessToken,speakers:[{name,speakerId,resourceId}]}], currentApiIndex}
    $("#sta_doubao_import_btn").on("click", function () {
        $("#sta_doubao_import_file").trigger("click");
    });
    $("#sta_doubao_import_file").on("change", function (e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result));
                let appId = "", accessToken = "";
                const newSpeakers = {};

                if (Array.isArray(data.apiConfigs)) {
                    const idx = Number.isInteger(data.currentApiIndex) ? data.currentApiIndex : 0;
                    const cfg = data.apiConfigs[idx] || data.apiConfigs[0];
                    if (!cfg) throw new Error("apiConfigs 为空");
                    appId = cfg.appId || "";
                    accessToken = cfg.accessToken || "";
                    for (const sp of (cfg.speakers || [])) {
                        if (sp && sp.name && sp.speakerId && sp.resourceId) {
                            newSpeakers[sp.name] = { speaker_id: sp.speakerId, resource_id: sp.resourceId };
                        }
                    }
                } else if (data.speakers && typeof data.speakers === "object") {
                    appId = data.app_id || "";
                    accessToken = data.access_key || "";
                    for (const [name, v] of Object.entries(data.speakers)) {
                        if (v && v.speaker_id && v.resource_id) {
                            newSpeakers[name] = { speaker_id: v.speaker_id, resource_id: v.resource_id };
                        }
                    }
                } else {
                    throw new Error("无法识别的文件格式");
                }

                if (appId) s.doubao.app_id = appId;
                if (accessToken) s.doubao.access_key = accessToken;
                s.doubao.speakers = newSpeakers; // 直接覆盖，不合并
                save();

                $("#sta_doubao_app_id").val(s.doubao.app_id);
                $("#sta_doubao_access_key").val(s.doubao.access_key);
                renderDoubaoSpeakers();
                toastr.success(`已导入并覆盖：${Object.keys(newSpeakers).length} 个音色`);
            } catch (err) {
                toastr.error("导入失败：" + (err?.message || String(err)));
            } finally {
                $("#sta_doubao_import_file").val("");
            }
        };
        reader.readAsText(file);
    });
}

// ── Edge-TTS ─────────────────────────────────────────
// 无需 API Key。不需要手动起名：音色下拉自带默认名字（预置音色的中文标签），
// 同一个音色配不同的 rate/pitch/volume 会分别存成独立记录，靠这几个参数值本身来区分，
// 内部 key 自动生成保证唯一，不需要用户关心。
function edgeSpeakerLabel(info) {
    const preset = EDGE_VOICE_PRESETS.find(p => p.value === info.voice);
    const baseLabel = preset ? preset.label : (info.voice || "未知音色");
    const parts = [];
    if (info.rate) parts.push(`语速${info.rate}`);
    if (info.pitch) parts.push(`音调${info.pitch}`);
    if (info.volume) parts.push(`音量${info.volume}`);
    return parts.length ? `${baseLabel} · ${parts.join(" ")}` : baseLabel;
}

function edgeSpeakerSignature(info) {
    return [info.voice || "", info.rate || "", info.pitch || "", info.volume || ""].join("||");
}

function genEdgeSpeakerKey(voice) {
    return `${voice}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function renderEdgeVoiceSelectOptions(selected) {
    let html = "";
    for (const v of EDGE_VOICE_PRESETS) {
        html += `<option value="${escapeHtml(v.value)}"${v.value === selected ? " selected" : ""}>${escapeHtml(v.label)}</option>`;
    }
    return html;
}

function renderEdgeSpeakers() {
    const s = getSettings();
    const container = $("#sta_edge_speakers_list");
    container.empty();
    const speakers = s.edge.speakers || {};
    const keys = Object.keys(speakers);
    if (!keys.length) {
        container.append('<p class="sta-hint">暂无音色，请在上方添加</p>');
        return;
    }
    for (const key of keys) {
        const v = speakers[key];
        const preset = EDGE_VOICE_PRESETS.find(p => p.value === v.voice);
        const baseLabel = preset ? preset.label : (v.voice || "未知音色");
        const row = $(`
            <div class="sta-row">
                <span class="sta-row-name">${escapeHtml(baseLabel)}</span>
                <span class="sta-row-sub">语速=${escapeHtml(v.rate || "默认")} · 音调=${escapeHtml(v.pitch || "默认")} · 音量=${escapeHtml(v.volume || "默认")}</span>
                <button class="menu_button danger sta-del-edge-speaker" data-key="${escapeHtml(key)}">删除</button>
            </div>
        `);
        container.append(row);
    }
}

function initEdgeTab() {
    const s = getSettings();
    $("#sta_edge_new_voice").html(renderEdgeVoiceSelectOptions(""));
    renderEdgeSpeakers();

    $("#sta_edge_add_speaker").on("click", function () {
        const voice = $("#sta_edge_new_voice").val();
        const rate = $("#sta_edge_new_rate").val().trim();
        const pitch = $("#sta_edge_new_pitch").val().trim();
        const volume = $("#sta_edge_new_volume").val().trim();
        if (!voice) {
            toastr.warning("请先选择一个音色");
            return;
        }
        const newSig = edgeSpeakerSignature({ voice, rate, pitch, volume });
        const dup = Object.values(s.edge.speakers).some(v => edgeSpeakerSignature(v) === newSig);
        if (dup) {
            toastr.warning("该音色配置（音色+语速+音调+音量）已存在，未重复添加");
            return;
        }
        const key = genEdgeSpeakerKey(voice);
        s.edge.speakers[key] = { voice, rate, pitch, volume };
        save();
        $("#sta_edge_new_rate, #sta_edge_new_pitch, #sta_edge_new_volume").val("");
        renderEdgeSpeakers();
        toastr.success(`音色 "${edgeSpeakerLabel(s.edge.speakers[key])}" 已添加`);
    });

    $(document).on("click", ".sta-del-edge-speaker", function () {
        const key = $(this).data("key");
        delete s.edge.speakers[key];
        save();
        renderEdgeSpeakers();
    });
}

// ── MiMo TTS ─────────────────────────────────────────
// ── MiMo 音色标签：统一格式为「分类 · 名字」，方便一眼看出语言/来源 ──
function mimoPresetLabel(p) {
    return `${p.lang} · ${p.name}`;
}
function mimoMyVoiceTag(v) {
    if (v.kind === "preset") {
        const p = listPresetVoices().find(p => p.voice === v.voice);
        return p ? p.lang : "预置";
    }
    if (v.kind === "clone") return "克隆";
    if (v.kind === "design") return "设计";
    if (v.kind === "custom") return "自定义";
    return v.kind || "";
}
function mimoMyVoiceLabel(v) {
    const tag = mimoMyVoiceTag(v);
    const name = v.nickname || v.id;
    return tag ? `${tag} · ${name}` : name;
}

function renderMimoPresetSelectOptions(selected) {
    let html = "";
    for (const p of listPresetVoices()) {
        html += `<option value="${escapeHtml(p.voice)}"${p.voice === selected ? " selected" : ""}>${escapeHtml(mimoPresetLabel(p))}</option>`;
    }
    return html;
}

let currentMimoClonePreviewAudio = null;
let currentMimoClonePreviewId = null;
let currentMimoClonePreviewUrl = null;

function stopMimoClonePreview() {
    if (currentMimoClonePreviewAudio) {
        try { currentMimoClonePreviewAudio.pause(); } catch (_) {}
    }
    if (currentMimoClonePreviewUrl) {
        try { URL.revokeObjectURL(currentMimoClonePreviewUrl); } catch (_) {}
    }
    currentMimoClonePreviewAudio = null;
    currentMimoClonePreviewId = null;
    currentMimoClonePreviewUrl = null;
    $(".sta-play-mimo-clone").text("试听");
}

function renderMimoMyVoices() {
    const container = $("#sta_mimo_my_voices_list");
    container.empty();
    const mine = listMyVoices();
    if (!mine.length) {
        container.append('<p class="sta-hint">暂无，先在上方收藏预置音色或添加复刻音色</p>');
        return;
    }
    for (const v of mine) {
        const row = $(`
            <div class="sta-row" data-id="${escapeHtml(v.id)}">
                <span class="sta-row-name">${escapeHtml(mimoMyVoiceLabel(v))}</span>
                <span class="sta-row-sub">id=${escapeHtml(v.id)}</span>
                ${v.kind === 'clone' ? `<button class="menu_button sta-play-mimo-clone" data-id="${escapeHtml(v.id)}">试听</button>` : ''}
                <button class="menu_button danger sta-del-mimo-voice" data-id="${escapeHtml(v.id)}">删除</button>
            </div>
        `);
        container.append(row);
    }
}

function initMimoTab() {
    const root = getNimoRoot();
    $("#sta_mimo_apikey").val(root.apiKey).on("input", function () {
        root.apiKey = $(this).val(); save();
    });
    $("#sta_mimo_baseurl").val(root.baseUrl).on("input", function () {
        root.baseUrl = $(this).val(); save();
    });
    $("#sta_mimo_preset_select").html(renderMimoPresetSelectOptions(""));
    renderMimoMyVoices();

    $("#sta_mimo_preset_add").on("click", function () {
        const voice = $("#sta_mimo_preset_select").val();
        const preset = listPresetVoices().find(p => p.voice === voice);
        if (!preset) return;
        addPresetVoice({ voice: preset.voice, nickname: preset.name });
        renderMimoMyVoices();
        toastr.success(`已收藏音色 "${mimoPresetLabel(preset)}"`);
    });
    $(document).on("click", ".sta-del-mimo-voice", async function () {
        const id = $(this).data("id");
        if (currentMimoClonePreviewId === id) stopMimoClonePreview();
        await deleteMyVoice(id);
        renderMimoMyVoices();
    });

    // 音色复刻：按钮触发隐藏的 file input
    $("#sta_mimo_clone_file_btn").on("click", function () {
        $("#sta_mimo_clone_file").trigger("click");
    });

    // 音色复刻：选择文件后即时试听 + 显示文件名
    $("#sta_mimo_clone_file").on("change", function () {
        const file = this.files && this.files[0];
        const audioEl = $("#sta_mimo_clone_preview")[0];
        const wrap = $("#sta_mimo_clone_preview_wrap");
        const nameEl = $("#sta_mimo_clone_filename");
        if (!file) {
            wrap.hide();
            audioEl.removeAttribute("src");
            nameEl.text("未选择文件");
            return;
        }
        nameEl.text(file.name);
        const url = URL.createObjectURL(file);
        audioEl.src = url;
        wrap.show();
    });

    // 音色复刻：添加
    $("#sta_mimo_clone_add").on("click", async function () {
        const btn = $(this);
        const fileInput = $("#sta_mimo_clone_file")[0];
        const file = fileInput.files && fileInput.files[0];
        const nickname = $("#sta_mimo_clone_nickname").val().trim();

        if (!file) { toastr.error("请先选择参考音频文件"); return; }
        if (!nickname) { toastr.error("请填写音色昵称"); return; }
        if (file.size > 10 * 1024 * 1024) { toastr.error("参考音频超过 10 MB"); return; }

        btn.prop("disabled", true).text("添加中…");
        try {
            await addCloneVoice({ file, nickname });
            toastr.success(`已添加复刻音色 "${nickname}"`);
            fileInput.value = "";
            $("#sta_mimo_clone_nickname").val("");
            $("#sta_mimo_clone_preview_wrap").hide();
            $("#sta_mimo_clone_preview")[0].removeAttribute("src");
            $("#sta_mimo_clone_filename").text("未选择文件");
            renderMimoMyVoices();
        } catch (e) {
            toastr.error(`添加失败：${e?.message || e}`);
        } finally {
            btn.prop("disabled", false).text("添加复刻音色");
        }
    });

    // 我的音色：试听克隆音色的原始参考音频
    $(document).on("click", ".sta-play-mimo-clone", async function () {
        const btn = $(this);
        const id = btn.data("id");

        if (currentMimoClonePreviewAudio && currentMimoClonePreviewId === id && !currentMimoClonePreviewAudio.paused) {
            stopMimoClonePreview();
            return;
        }
        stopMimoClonePreview();

        const item = findMyVoice(id);
        if (!item || item.kind !== 'clone' || !item.audioKvId) {
            toastr.error("找不到该音色的参考音频");
            return;
        }
        const rec = await getCloneAudio(item.audioKvId);
        if (!rec || !rec.b64) {
            toastr.error("读取参考音频失败，可能已丢失");
            return;
        }
        const bytes = b64ToBytes(rec.b64);
        const blob = new Blob([bytes], { type: rec.mime || "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentMimoClonePreviewAudio = audio;
        currentMimoClonePreviewId = id;
        currentMimoClonePreviewUrl = url;
        audio.onended = () => stopMimoClonePreview();
        audio.play();
        btn.text("暂停");
    });
}

// ── 角色音色绑定 ─────────────────────────────────────
// 每行都是可编辑状态：角色名 + 供应商下拉 + 音色下拉（联动供应商）+ 保存 + 删除。
// "新建角色"在列表顶部插入一条空白可编辑行，保存前不写入设置。
function charRowTemplate(displayNames, provider, speaker, isNew, origName) {
    provider = provider || "doubao";
    return `
        <div class="sta-row" data-orig-name="${escapeHtml(isNew ? "" : (origName ?? displayNames))}">
            <input type="text" class="text_pole sta-char-name" placeholder="角色名，别名用逗号分隔，如 林黛玉,黛玉,颦儿" value="${escapeHtml(displayNames)}" />
            <select class="sta-char-provider">
                <option value="doubao">豆包</option>
                <option value="mimo">MiMo</option>
                <option value="edge">Edge-TTS</option>
            </select>
            <select class="sta-char-speaker">${buildSpeakerOptionsHtml(provider, speaker)}</select>
            <button class="menu_button danger sta-char-del">删除</button>
        </div>
    `;
}

function renderCharBindings() {
    const container = $("#sta_char_bindings_list");
    container.empty();
    const list = listCharacterVoiceBindings();
    if (!list.length) {
        container.append('<p class="sta-hint">暂无绑定，点上方"+ 新建角色"添加</p>');
        return;
    }
    for (const item of list) {
        const displayNames = [item.name, ...(item.aliases || [])].join(",");
        const row = $(charRowTemplate(displayNames, item.provider, item.speaker, false, item.name));
        row.find(".sta-char-provider").val(item.provider || "doubao");
        container.append(row);
    }
}

function initVoicesTab() {
    renderCharBindings();

    $("#sta_char_new").on("click", function () {
        if ($("#sta_char_bindings_list .sta-hint").length) $("#sta_char_bindings_list").empty();
        const row = $(charRowTemplate("", "doubao", "", true));
        $("#sta_char_bindings_list").prepend(row);
        row.find(".sta-char-name").trigger("focus");
    });

    // 切换供应商时，联动刷新该行的音色下拉
    $(document).on("change", "#sta_char_bindings_list .sta-char-provider", function () {
        const row = $(this).closest(".sta-row");
        const provider = $(this).val();
        row.find(".sta-char-speaker").html(buildSpeakerOptionsHtml(provider, ""));
    });

    $("#sta_char_save_all").on("click", function () {
        const rows = $("#sta_char_bindings_list .sta-row").toArray();
        let savedCount = 0;
        let skipped = 0;
        for (const el of rows) {
            const row = $(el);
            const origName = row.data("orig-name");
            const rawNames = row.find(".sta-char-name").val().trim();
            const names = rawNames.split(",").map(s => s.trim()).filter(Boolean);
            const name = names[0];
            const aliases = names.slice(1);
            const provider = row.find(".sta-char-provider").val();
            const speaker = row.find(".sta-char-speaker").val();
            if (!name || !speaker) { skipped++; continue; }
            if (origName && origName !== name) removeCharacterVoiceBinding(origName);
            setCharacterVoiceBinding(name, provider, speaker, aliases);
            savedCount++;
        }
        renderCharBindings();
        if (savedCount) toastr.success(`已保存 ${savedCount} 个角色音色绑定`);
        if (skipped) toastr.warning(`有 ${skipped} 行角色名或音色未填写完整，未保存`);
        if (!savedCount && !skipped) toastr.info("暂无可保存的角色");
    });

    // 未保存的新行（origName为空）直接从DOM移除即可，不触发整表重渲染，
    // 否则会连带把其它还没保存的新行一起清掉（之前的bug）。
    // 已保存的行才需要真正删除数据并重渲染。
    $(document).on("click", "#sta_char_bindings_list .sta-char-del", function () {
        const row = $(this).closest(".sta-row");
        const origName = row.data("orig-name");
        if (origName) {
            removeCharacterVoiceBinding(origName);
            renderCharBindings();
        } else {
            row.remove();
            if (!$("#sta_char_bindings_list .sta-row").length) renderCharBindings();
        }
    });
}

// ── NPC 与兜底音色 ───────────────────────────────────
// 旁白 + 5个固定分类合并成一个列表统一渲染，只有一个"保存"按钮一次性写入全部。
function fixedVoiceRowTemplate(label, provider, speaker, catKey, enabled) {
    const disabledAttr = enabled === false ? "disabled" : "";
    return `
        <div class="sta-row" data-cat="${escapeHtml(catKey)}">
            <span class="sta-row-name">${escapeHtml(label)}</span>
            <label class="sta-fixed-enable-label sta-row-check" title="取消勾选后，该类别的台词将被跳过，不生成语音">
                <input type="checkbox" class="sta-fixed-enable" data-cat="${escapeHtml(catKey)}" ${enabled === false ? "" : "checked"} />
            </label>
            <select class="sta-fixed-provider" data-cat="${escapeHtml(catKey)}" ${disabledAttr}>
                <option value="doubao">豆包</option>
                <option value="mimo">MiMo</option>
                <option value="edge">Edge-TTS</option>
            </select>
            <select class="sta-fixed-speaker" data-cat="${escapeHtml(catKey)}" ${disabledAttr}>${buildSpeakerOptionsHtml(provider, speaker)}</select>
        </div>
    `;
}

function renderFixedVoices() {
    const s = getSettings();
    const container = $("#sta_fixed_voices_list");
    container.empty();

    // 旁白放最前面
    const nv = s.narrator_voice || {};
    const narratorRow = $(fixedVoiceRowTemplate("旁白", nv.provider || "doubao", nv.speaker || "", "__narrator__", nv.enabled));
    narratorRow.find(".sta-fixed-provider").val(nv.provider || "doubao");
    container.append(narratorRow);

    for (const cat of FALLBACK_VOICE_CATEGORIES) {
        const v = s.fallback_voices[cat.key] || {};
        const row = $(fixedVoiceRowTemplate(cat.label, v.provider || "doubao", v.speaker || "", cat.key, v.enabled));
        row.find(".sta-fixed-provider").val(v.provider || "doubao");
        container.append(row);
    }
}

function renderNpcMap() {
    const container = $("#sta_npc_map_list");
    container.empty();
    const list = listNpcVoiceMap();
    if (!list.length) {
        container.append('<p class="sta-hint">还没有NPC被自动分类，等AI在故事里遇到新NPC后会自动出现在这里</p>');
        return;
    }
    const catLabel = Object.fromEntries(FALLBACK_VOICE_CATEGORIES.map(c => [c.key, c.label]));
    for (const item of list) {
        const row = $(`
            <div class="sta-row">
                <span class="sta-row-name">${escapeHtml(item.name)}</span>
                <select class="sta-npc-cat" data-name="${escapeHtml(item.name)}">
                    ${FALLBACK_VOICE_CATEGORIES.map(c => `<option value="${c.key}">${c.label}</option>`).join("")}
                </select>
                <button class="menu_button danger sta-del-npc" data-name="${escapeHtml(item.name)}">移除映射</button>
            </div>
        `);
        row.find(".sta-npc-cat").val(item.category);
        container.append(row);
    }
}

function initNpcTab() {
    renderFixedVoices();
    renderNpcMap();

    // 启用勾选框：取消勾选后该类别台词被跳过（不生成语音），下拉框变灰禁用但保留已选内容
    $(document).on("change", "#sta_fixed_voices_list .sta-fixed-enable", function () {
        const row = $(this).closest(".sta-row");
        const cat = row.data("cat");
        const enabled = $(this).is(":checked");
        row.find(".sta-fixed-provider, .sta-fixed-speaker").prop("disabled", !enabled);
        if (cat === "__narrator__") {
            setNarratorVoiceEnabled(enabled);
        } else {
            setFallbackVoiceEnabled(cat, enabled);
        }
        toastr.success(enabled ? "已启用" : "已关闭，该类别台词将不再生成语音");
    });

    // 切换供应商时，联动刷新该行的音色下拉（不落盘，等选定音色后一并即时保存）
    $(document).on("change", "#sta_fixed_voices_list .sta-fixed-provider", function () {
        const row = $(this).closest(".sta-row");
        const provider = $(this).val();
        row.find(".sta-fixed-speaker").html(buildSpeakerOptionsHtml(provider, ""));
    });

    // 音色下拉改动即时保存，无需单独的"保存"按钮
    $(document).on("change", "#sta_fixed_voices_list .sta-fixed-speaker", function () {
        const row = $(this).closest(".sta-row");
        const cat = row.data("cat");
        const provider = row.find(".sta-fixed-provider").val();
        const speaker = $(this).val();
        if (cat === "__narrator__") {
            setNarratorVoice(provider, speaker);
        } else {
            setFallbackVoice(cat, provider, speaker);
        }
        toastr.success("已保存");
    });

    $(document).on("change", ".sta-npc-cat", function () {
        const name = $(this).data("name");
        setNpcCategory(name, $(this).val());
        toastr.success(`已将 "${name}" 改为 ${$(this).val()}`);
    });
    $(document).on("click", ".sta-del-npc", function () {
        removeNpcMapping($(this).data("name"));
        renderNpcMap();
    });
}

// ── 素材库 ───────────────────────────────────────────
function initAssetsTab() {
    const s = getSettings();
    $("#sta_audio_assets_content").val(s.audio_assets_content || "");
    $("#sta_audio_assets_save").on("click", function () {
        s.audio_assets_content = $("#sta_audio_assets_content").val();
        save();
        toastr.success("素材库已保存");
    });

    $("#sta_assets_export_btn").on("click", function () {
        downloadJson("audio-assets.json", { content: $("#sta_audio_assets_content").val() || "" });
        toastr.success("已导出素材库");
    });

    $("#sta_assets_import_btn").on("click", function () {
        $("#sta_assets_import_file").trigger("click");
    });
    $("#sta_assets_import_file").on("change", function (e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result));
                if (typeof data.content !== "string") throw new Error("文件里没有 content 字段");
                $("#sta_audio_assets_content").val(data.content);
                toastr.info('已导入到文本框，记得点下方"保存素材库"才会生效');
            } catch (err) {
                toastr.error("导入失败：" + (err?.message || String(err)));
            } finally {
                $("#sta_assets_import_file").val("");
            }
        };
        reader.readAsText(file);
    });
}

// ── 缓存管理 ─────────────────────────────────────────
function formatBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${units[i]}`;
}

let currentVoicePreviewAudio = null;
let currentVoicePreviewKey = null;
let currentVoicePreviewUrl = null;

function stopVoicePreview() {
    if (currentVoicePreviewAudio) {
        try { currentVoicePreviewAudio.pause(); } catch (_) {}
    }
    if (currentVoicePreviewUrl) {
        try { URL.revokeObjectURL(currentVoicePreviewUrl); } catch (_) {}
    }
    currentVoicePreviewAudio = null;
    currentVoicePreviewKey = null;
    currentVoicePreviewUrl = null;
    $(".sta-play-voice-cache").text("播放");
}

async function renderVoiceCacheList() {
    const container = $("#sta_voice_cache_list");
    container.empty();
    const items = await listVoiceLines();
    if (!items.length) {
        container.append('<p class="sta-hint">暂无缓存的语音</p>');
        return;
    }
    for (const item of items) {
        const row = $(`
            <div class="sta-row" data-key="${escapeHtml(item.cacheKey)}">
                <span class="sta-row-name">${escapeHtml(item.speaker || "")}</span>
                <span class="sta-row-sub" title="${escapeHtml(item.text)}">${escapeHtml((item.text || "").slice(0, 30))}${(item.text || "").length > 30 ? "…" : ""}</span>
                <span class="sta-row-sub">${formatBytes(item.sizeBytes)} · ${new Date(item.timestamp).toLocaleString()}</span>
                <button class="menu_button sta-play-voice-cache">播放</button>
                <button class="menu_button danger sta-del-voice-cache" data-key="${escapeHtml(item.cacheKey)}">删除</button>
            </div>
        `);
        container.append(row);
    }
}

// ── 素材库缓存（缓存管理页签内） ─────────────────────
let currentAssetPreviewAudio = null;
let currentAssetPreviewUrl = null;

function stopAssetPreview() {
    if (currentAssetPreviewAudio) {
        try { currentAssetPreviewAudio.pause(); } catch (_) {}
    }
    currentAssetPreviewAudio = null;
    currentAssetPreviewUrl = null;
    $(".sta-play-asset-cache").text("播放");
}

async function renderAssetCacheList() {
    const container = $("#sta_asset_cache_list");
    container.empty();
    const cached = await listCachedAssets();
    if (!cached.length) {
        container.append('<p class="sta-hint">暂无缓存的素材，点上方"下载素材库内容"拉取</p>');
        return;
    }
    // 用当前素材库文本框（含未保存修改）反查 key，方便识别每条缓存对应的素材名
    const currentAssets = parseAssetLines($("#sta_audio_assets_content").val() || getSettings().audio_assets_content || "");
    const urlToKey = new Map(currentAssets.map(a => [a.url, a.key]));
    for (const item of cached) {
        const label = urlToKey.get(item.url) || "（未在当前素材库中，可能已被删除）";
        const row = $(`
            <div class="sta-row" data-url="${escapeHtml(item.url)}">
                <span class="sta-row-name">${escapeHtml(label)}</span>
                <span class="sta-row-sub" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
                <span class="sta-row-sub">${formatBytes(item.sizeBytes)} · ${new Date(item.timestamp).toLocaleString()}</span>
                <button class="menu_button sta-play-asset-cache">播放</button>
                <button class="menu_button danger sta-del-asset-cache">删除</button>
            </div>
        `);
        container.append(row);
    }
}

function initCacheTab() {
    renderVoiceCacheList();
    renderAssetCacheList();

    $("#sta_cache_refresh").on("click", function () { stopVoicePreview(); renderVoiceCacheList(); });
    $("#sta_cache_clear_all").on("click", async function () {
        if (!confirm("确定清空全部本地语音缓存吗？此操作不可撤销。")) return;
        stopVoicePreview();
        await clearAllVoiceLines();
        renderVoiceCacheList();
        toastr.success("已清空全部语音缓存");
    });
    $(document).on("click", ".sta-del-voice-cache", async function () {
        const key = $(this).data("key");
        if (currentVoicePreviewKey === key) stopVoicePreview();
        await deleteVoiceLine(key);
        renderVoiceCacheList();
    });
    $(document).on("click", ".sta-play-voice-cache", async function () {
        const row = $(this).closest(".sta-row");
        const key = row.data("key");
        const btn = $(this);

        if (currentVoicePreviewAudio && currentVoicePreviewKey === key && !currentVoicePreviewAudio.paused) {
            stopVoicePreview();
            return;
        }
        stopVoicePreview();

        const rec = await getVoiceLine(key);
        if (!rec || !rec.arrayBuffer) {
            toastr.error("读取本地缓存失败，可能已被清空");
            return;
        }
        const blob = new Blob([rec.arrayBuffer], { type: rec.mime || "audio/mpeg" });
        const objUrl = URL.createObjectURL(blob);
        const audio = new Audio(objUrl);
        currentVoicePreviewAudio = audio;
        currentVoicePreviewKey = key;
        currentVoicePreviewUrl = objUrl;
        audio.onended = () => stopVoicePreview();
        audio.play();
        btn.text("暂停");
    });

    // 增量下载素材库内容：跳过本地已缓存的url，只拉取新增/变更的
    $("#sta_asset_cache_download").on("click", async function () {
        const btn = $(this);
        const list = parseAssetLines($("#sta_audio_assets_content").val() || getSettings().audio_assets_content || "");
        if (!list.length) {
            toastr.info("素材库为空，请先在「素材库」页签添加内容");
            return;
        }
        btn.prop("disabled", true).text("下载中…");
        let added = 0, skipped = 0, failed = 0;
        for (const asset of list) {
            try {
                if (await isAssetCached(asset.url)) { skipped++; continue; }
                const buf = await loadStaticAudio(asset.url);
                if (buf) added++; else failed++;
            } catch (_) {
                failed++;
            }
        }
        btn.prop("disabled", false).text("下载素材库内容");
        toastr.success(`素材库缓存更新完成：新增 ${added} 条，已有 ${skipped} 条${failed ? `，失败 ${failed} 条` : ""}`);
        renderAssetCacheList();
    });

    $("#sta_asset_cache_refresh").on("click", renderAssetCacheList);

    $("#sta_asset_cache_clear").on("click", async function () {
        if (!confirm("确定清空全部素材库本地缓存吗？只清掉本地下载的音频文件，不影响素材库配置本身。")) return;
        stopAssetPreview();
        await clearAllCache();
        renderAssetCacheList();
        toastr.success("已清空素材库缓存");
    });

    $(document).on("click", ".sta-play-asset-cache", async function () {
        const row = $(this).closest(".sta-row");
        const url = row.data("url");
        const btn = $(this);

        if (currentAssetPreviewAudio && currentAssetPreviewUrl === url && !currentAssetPreviewAudio.paused) {
            stopAssetPreview();
            return;
        }
        stopAssetPreview();

        const blob = await getCachedAssetBlob(url);
        if (!blob) {
            toastr.error("读取本地缓存失败，可能已被清空");
            return;
        }
        const objUrl = URL.createObjectURL(blob);
        const audio = new Audio(objUrl);
        currentAssetPreviewAudio = audio;
        currentAssetPreviewUrl = url;
        audio.onended = () => stopAssetPreview();
        audio.play();
        btn.text("暂停");
    });

    $(document).on("click", ".sta-del-asset-cache", async function () {
        const row = $(this).closest(".sta-row");
        const url = row.data("url");
        if (currentAssetPreviewUrl === url) stopAssetPreview();
        await deleteCachedAsset(url);
        renderAssetCacheList();
    });
}

// ── 运行日志 ─────────────────────────────────────────
const SEGMENT_TYPE_LABEL = { music: "🎵 音乐", ambiance: "🌫️ 环境音", sfx: "🔊 音效" };

function renderLastPlan() {
    const container = $("#sta_runlog_last_plan");
    container.empty();
    const entry = getLastPlan();
    if (!entry) {
        container.append('<p class="sta-hint">暂无，还没有处理过任何回合</p>');
        return;
    }
    const { time, plan } = entry;
    container.append(`<p class="sta-hint" style="margin-bottom:6px;">生成于 ${new Date(time).toLocaleString()}</p>`);

    const segments = plan?.segments || [];
    if (!segments.length) {
        container.append('<p class="sta-hint">这次编排没有任何事件</p>');
    }
    for (const seg of segments) {
        let row;
        if (seg.type === "voice") {
            const moodText = seg.mood ? `语气：${seg.mood}` : "无语气提示";
            row = $(`
                <div class="sta-row">
                    <span class="sta-row-name">🗣️ ${escapeHtml(seg.speaker)}</span>
                    <span class="sta-row-sub">"${escapeHtml(seg.text)}"</span>
                    <span class="sta-row-sub">${escapeHtml(moodText)}</span>
                </div>
            `);
        } else {
            const label = SEGMENT_TYPE_LABEL[seg.type] || seg.type;
            const extra = seg.type === "sfx" && seg.durationSec ? `（时长 ${seg.durationSec}s）` : "";
            row = $(`
                <div class="sta-row">
                    <span class="sta-row-name">${escapeHtml(label)}</span>
                    <span class="sta-row-sub">${escapeHtml(seg.assetKey || "")}${escapeHtml(extra)}</span>
                </div>
            `);
        }
        container.append(row);
    }

    const assignFallback = plan?.assign_fallback || [];
    if (assignFallback.length) {
        const text = assignFallback.map(a => `${a.name} → ${a.category}`).join("，");
        container.append(`
            <div class="sta-row">
                <span class="sta-row-name">🆕 新分类</span>
                <span class="sta-row-sub">${escapeHtml(text)}</span>
            </div>
        `);
    }
}

function renderRunLog() {
    const container = $("#sta_runlog_list");
    container.empty();
    const items = listLogEntries();
    if (!items.length) {
        container.append('<p class="sta-hint">暂无日志</p>');
        return;
    }
    for (const item of items) {
        const levelLabel = item.level === "error" ? "错误" : "警告";
        const row = $(`
            <div class="sta-row">
                <span class="sta-row-sub">${new Date(item.time).toLocaleString()}</span>
                <span class="sta-row-name${item.level === "error" ? " sta-runlog-error" : ""}">[${levelLabel}]</span>
                <span class="sta-row-sub" title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</span>
            </div>
        `);
        container.append(row);
    }
}

function initRunLogTab() {
    renderLastPlan();
    renderRunLog();
    $("#sta_runlog_refresh").on("click", function () { renderLastPlan(); renderRunLog(); });
    $("#sta_runlog_clear").on("click", function () {
        clearLogEntries();
        renderRunLog();
        toastr.success("已清空运行日志");
    });
}

export function initSettingsPanel() {
    bindTabs();
    initGeneralTab();
    initLlmTab();
    initDoubaoTab();
    initMimoTab();
    initEdgeTab();
    initVoicesTab();
    initNpcTab();
    initAssetsTab();
    initCacheTab();
    initRunLogTab();
}
