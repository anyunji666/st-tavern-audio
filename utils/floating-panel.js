// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  悬浮窗：常驻挂载在 <body> 下，任何时候都显示（不再随任务结束隐藏）。
//  空闲态（没有生成/播放任务）整体呈半透明，按钮文案变为"停止音乐"，
//  用于随时手动停掉可能还在循环播放的BGM/环境音；
//  有任务进行时恢复不透明，按钮文案为"跳过"，中止当前编排/合成，
//  并让播放队列不再继续（当前这条播完为止）。
//  可拖拽（鼠标/触屏都支持）。
//
//  移动端（触屏/窄屏，例如 Termux 上跑的酒馆）自动切换为一个不带文字的
//  圆形按钮：外观代替文字说明状态（半透明=空闲，进度环=进行中，红边=出错），
//  点击即触发和 PC 端"跳过/停止音乐"按钮相同的动作。
// ═══════════════════════════════════════════════════════════

import { subscribe, skip } from "./panel-state.js";

const PANEL_ID = "sta-float-panel";

// 触屏 或 窄屏 命中任一即判定为移动端；用 matchMedia 而非 UA 判断更稳，
// 且能在 change 事件里响应横竖屏切换/分屏，无需刷新页面。
const MOBILE_MQL = window.matchMedia("(pointer: coarse), (max-width: 768px)");

// 拖动 vs 点击 的判定阈值（像素）：移动端圆形按钮上拖拽与点击共用同一元素，
// 需要靠触摸起止点的位移量区分，避免拖拽手势被误判为点击触发跳过。
const DRAG_CLICK_THRESHOLD = 8;

let dragState = null;

function buildPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "sta-float-panel";
    panel.innerHTML = `
        <div class="sta-float-header">
            <span class="sta-float-title">酒馆音效</span>
            <span class="sta-float-drag" title="拖动">⠿</span>
        </div>
        <div class="sta-float-status"></div>
        <div class="sta-float-progress"><div class="sta-float-progress-bar"></div></div>
        <button type="button" class="menu_button sta-float-skip">跳过</button>
    `;
    document.body.appendChild(panel);

    const header = panel.querySelector(".sta-float-header");
    header.addEventListener("mousedown", onDragStart);
    header.addEventListener("touchstart", onDragStart, { passive: true });

    panel.querySelector(".sta-float-skip").addEventListener("click", () => {
        skip();
    });

    // 移动端：整个圆形按钮既是拖拽把手也是点击目标（没有单独的 header/按钮可见），
    // 靠位移阈值区分"拖动"和"点击"。isMobile() 在交互发生时判断，
    // 因此屏幕方向/尺寸变化后也始终生效，无需额外监听并同步 class。
    panel.addEventListener("mousedown", onPanelPointerStart);
    panel.addEventListener("touchstart", onPanelPointerStart, { passive: true });

    return panel;
}

function isMobile() {
    return MOBILE_MQL.matches;
}

function onDragStart(e) {
    const panel = document.getElementById(PANEL_ID);
    const point = e.touches ? e.touches[0] : e;
    const rect = panel.getBoundingClientRect();
    dragState = { offsetX: point.clientX - rect.left, offsetY: point.clientY - rect.top, startX: point.clientX, startY: point.clientY, moved: false, mobileTap: false };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    document.addEventListener("touchmove", onDragMove, { passive: false });
    document.addEventListener("touchend", onDragEnd);
}

/** 移动端圆形按钮上的拖拽起点：和 onDragStart 逻辑一致，仅多标记 mobileTap 以便结束时判断点击。 */
function onPanelPointerStart(e) {
    if (!isMobile()) return;
    const panel = document.getElementById(PANEL_ID);
    const point = e.touches ? e.touches[0] : e;
    const rect = panel.getBoundingClientRect();
    dragState = { offsetX: point.clientX - rect.left, offsetY: point.clientY - rect.top, startX: point.clientX, startY: point.clientY, moved: false, mobileTap: true };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    document.addEventListener("touchmove", onDragMove, { passive: false });
    document.addEventListener("touchend", onDragEnd);
}

function onDragMove(e) {
    if (!dragState) return;
    if (e.cancelable) e.preventDefault();
    const panel = document.getElementById(PANEL_ID);
    const point = e.touches ? e.touches[0] : e;
    if (Math.abs(point.clientX - dragState.startX) > DRAG_CLICK_THRESHOLD
        || Math.abs(point.clientY - dragState.startY) > DRAG_CLICK_THRESHOLD) {
        dragState.moved = true;
    }
    const x = point.clientX - dragState.offsetX;
    const y = point.clientY - dragState.offsetY;
    const maxX = window.innerWidth - panel.offsetWidth;
    const maxY = window.innerHeight - panel.offsetHeight;
    panel.style.left = `${Math.min(Math.max(0, x), Math.max(0, maxX))}px`;
    panel.style.top = `${Math.min(Math.max(0, y), Math.max(0, maxY))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
}

function onDragEnd() {
    const wasMobileTap = dragState && dragState.mobileTap && !dragState.moved;
    dragState = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    document.removeEventListener("touchmove", onDragMove);
    document.removeEventListener("touchend", onDragEnd);
    // 移动端：位移未超过阈值，判定为点击（而非拖拽），触发和 PC 端按钮相同的动作。
    if (wasMobileTap) {
        skip();
    }
}

function render(state) {
    const panel = buildPanel();
    const idle = state.phase === "idle";
    panel.classList.toggle("sta-float-idle", idle);
    panel.classList.toggle("sta-float-error", state.phase === "error");

    const statusEl = panel.querySelector(".sta-float-status");
    statusEl.textContent = state.message || "";
    statusEl.classList.toggle("sta-float-status-error", state.phase === "error");

    const bar = panel.querySelector(".sta-float-progress-bar");
    const pct = state.total > 0
        ? Math.min(100, Math.round((state.current / state.total) * 100))
        : (state.phase === "playing" ? 100 : 0);
    bar.style.width = `${pct}%`;
    // 移动端圆形按钮的进度环靠这个 CSS 变量画（PC 端矩形面板不使用它，无副作用）。
    panel.style.setProperty("--sta-pct", idle ? 0 : pct);

    panel.querySelector(".sta-float-skip").textContent = idle ? "停止音乐" : "跳过";
}

/**
 * 控制悬浮球的显示/隐藏（对应插件启用开关）。
 * 隐藏时只是 display:none，不销毁 DOM，状态/拖拽位置不丢。
 */
export function setPanelVisible(visible) {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = visible ? "" : "none";
}

/**
 * 挂载悬浮窗并订阅状态更新，插件初始化时调用一次即可。
 * @param {boolean} initialVisible 初始是否显示（对应当前"启用插件"设置）
 */
export function initFloatingPanel(initialVisible = true) {
    buildPanel();
    subscribe(render);
    setPanelVisible(initialVisible);
}
