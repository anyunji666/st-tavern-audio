// @ts-nocheck
import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";

import { extensionName, extensionFolderPath, ensureDefaultSettings, getSettings } from "./utils/config.js";
import { processMessageForAudio } from "./utils/pipeline.js";
import { applyBusVolumes } from "./utils/playback-engine.js";
import { resumeAudioContext } from "./utils/audio-context.js";
import { initSettingsPanel } from "./utils/ui-settings.js";
import { initFloatingPanel } from "./utils/floating-panel.js";
import { skip as skipCurrentGeneration } from "./utils/panel-state.js";

/**
 * 从酒馆 chat 数组里取出指定楼层的纯文本正文。
 */
function getMessageText(chat, messageId) {
    const mes = chat?.[messageId];
    if (!mes || typeof mes.mes !== "string") return "";
    return mes.mes;
}

/**
 * 是否存在一次"真正的生成"在等待被消费。
 * 只有 GENERATION_STARTED（发送新消息、continue、swipe 重新生成都会触发）
 * 发生之后紧跟着的那次 CHARACTER_MESSAGE_RENDERED，才被视为一条需要配音的新回复。
 * 进角色卡、切换设置面板再切回聊天、刷新页面等操作只会把已有的最后一条消息
 * 重新渲染一遍，不会触发 GENERATION_STARTED，因此不会被误判成新消息。
 */
let pendingGeneration = false;

async function onCharacterMessageRendered(messageId) {
    if (!pendingGeneration) return; // 不是真正生成产生的渲染，跳过（历史消息重渲染等情况）
    pendingGeneration = false;

    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const context = getContext();
        const chat = context.chat;
        const text = getMessageText(chat, messageId);
        if (!text || !text.trim()) return;

        await processMessageForAudio(text);
    } catch (e) {
        console.error("[st-tavern-audio] 处理本回合音效失败:", e);
    }
}

function bindEvents() {
    eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
        // dryRun 是酒馆内部用来预估 token/提示词长度等场景的"假生成"，
        // 常见于打开/切换角色卡界面等操作，不代表真的会产生一条新回复。
        // 之前没有过滤这个参数，导致角色卡界面的操作有时会把 pendingGeneration
        // 误置为 true，恰好被后续一次无关的 CHARACTER_MESSAGE_RENDERED 消费掉，
        // 从而错误地对旧消息/预览内容跑了一次 TTS。
        if (dryRun) return;
        pendingGeneration = true;
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 切换会话时中止上一段还没跑完的生成/播放，避免串场；
        // 顺带重置标记位，防止跨聊天窗口误触发
        pendingGeneration = false;
        skipCurrentGeneration();
    });
}

/**
 * 移动端浏览器（尤其 iOS Safari）要求 AudioContext 必须在用户手势的
 * 同步回调里 resume，否则会一直停在 "suspended"：source.start() 不会报错，
 * 但完全没有声音。这里在用户第一次点击/触摸页面任意位置时尝试解锁一次，
 * 是全局兜底，不依赖插件自己的悬浮面板有没有被点到。
 * playback-engine.js 的 playSequence 里也有一次兜底 resume，双保险。
 */
function bindGestureUnlock() {
    const unlock = () => {
        resumeAudioContext();
    };
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    document.addEventListener("touchend", unlock, { once: true, capture: true });
    document.addEventListener("click", unlock, { once: true, capture: true });
}

jQuery(async () => {
    ensureDefaultSettings();
    applyBusVolumes();

    // 事件监听尽早同步注册，不等下面的设置面板 HTML 网络请求返回，
    // 避免网络慢时（常见于手机端）错过 GENERATION_STARTED/CHARACTER_MESSAGE_RENDERED
    bindEvents();
    bindGestureUnlock();

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/html/settings.html`);
        $("#extensions_settings2").append(settingsHtml);
    } catch (e) {
        console.error("[st-tavern-audio] 加载设置面板 HTML 失败:", e);
    }

    initSettingsPanel();
    initFloatingPanel(getSettings().enabled);

    console.log("[st-tavern-audio] 插件已加载。");
});
