import { createEditor, indentSelection, enterWithIndent } from "./editor/index.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

// 让顶栏可拖动窗口；按钮/输入控件上的按下不触发，避免影响点击
function enableWindowDragging(header) {
  if (!header) return;
  header.addEventListener("mousedown", (event) => {
    if (event.target.closest("button, input, textarea, a, select")) return;
    event.preventDefault();
    appWindow.startDragging();
  });
}

const host = document.getElementById("note-input");
const status = document.getElementById("status");
const saveBtn = document.getElementById("save-btn");
const wordCount = document.getElementById("word-count");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const hotkeyHint = document.getElementById("hotkey-hint");

let editorView;
let fullscreen = false;

// 聚焦编辑器并把光标移到末尾（草稿保留时接着输入）
function focusInput() {
  if (!editorView) return;
  editorView.focus();
  const len = editorView.state.doc.length;
  editorView.dispatch({ selection: { anchor: len } });
}

// 底部快捷键提示跟随设置变化，避免自定义后仍显示默认值
const DEFAULT_HINT = hotkeyHint ? hotkeyHint.textContent : "";

async function refreshHotkeyHint() {
  if (!hotkeyHint) return;
  try {
    const s = await invoke("get_settings");
    hotkeyHint.textContent = `${s.hotkey_main} 速记 · ${s.hotkey_history} 历史 · Esc 收起`;
  } catch {
    hotkeyHint.textContent = DEFAULT_HINT;
  }
}

// 草稿持久化：窗口隐藏不丢，托盘退出后重开也能接着写
const DRAFT_KEY = "spark:draft";
let draftTimer = null;

function writeDraft(text) {
  try {
    // 仅空白内容视为无草稿，避免下次打开只剩空格
    if (text.trim()) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // localStorage 不可用时忽略，草稿只保留在内存
  }
}

function scheduleSaveDraft(text) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => writeDraft(text), 200);
}

function flushDraft() {
  if (!editorView) return;
  clearTimeout(draftTimer);
  draftTimer = null;
  writeDraft(editorView.state.doc.toString());
}

function loadDraft() {
  try {
    return localStorage.getItem(DRAFT_KEY) || "";
  } catch {
    return "";
  }
}

function clearDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // 忽略
  }
}

function updateCount() {
  const text = editorView ? editorView.state.doc.toString() : "";
  if (!text) {
    wordCount.textContent = "";
    return;
  }
  const chars = text.length;
  const lines = text.split("\n").length;
  wordCount.textContent = `${chars} 字 · ${lines} 行`;
}

// Esc：全屏时先退出全屏，再次按 Esc 才收起窗口
function handleEscape() {
  if (fullscreen) {
    setFullscreen(false);
    return;
  }
  flushDraft();
  appWindow.hide();
}

// 用 CodeMirror 取代原生 textarea：列表标记实时渲染为圆点，仍保留纯文本存储。
// 快捷键（Tab 缩进 / Enter 续行 / Ctrl+Enter 保存 / Esc 取消 / F11 全屏）走自定义 keymap。
editorView = createEditor({
  parent: host,
  placeholder: "记点什么…\n\nEnter 换行，Ctrl+Enter 保存",
  onDocChange: (text) => {
    updateCount();
    scheduleSaveDraft(text);
  },
  commands: {
    Tab: (v) => {
      indentSelection(v, 1);
      return true;
    },
    "Shift-Tab": (v) => {
      indentSelection(v, -1);
      return true;
    },
    Enter: (v) => {
      enterWithIndent(v);
      return true;
    },
    "Ctrl-Enter": () => {
      saveNote();
      return true;
    },
    "Mod-Enter": () => {
      saveNote();
      return true;
    },
    Escape: () => {
      handleEscape();
      return true;
    },
    F11: () => {
      toggleFullscreen();
      return true;
    },
  },
});

// 恢复上次未保存的草稿（托盘退出后重开也能接着写）
const draft = loadDraft();
if (draft.trim()) {
  editorView.dispatch({ changes: { from: 0, to: 0, insert: draft } });
}

window.addEventListener("DOMContentLoaded", () => {
  focusInput();
  updateCount();
  refreshHotkeyHint();
});

// Rust 侧每次显示 / 重新聚焦窗口后都会发该事件，作为 DOM 焦点兜底
listen("focus-input", () => {
  // 窗口重新显示时取消尚未执行的收起，避免上一次保存的延迟定时器误关窗
  clearTimeout(hideTimer);
  focusInput();
  // 设置窗口可能刚改过快捷键，重新显示时同步提示
  refreshHotkeyHint();
});

// 页面重新可见时（Wayland 切换前台等场景）补一次聚焦；
// 转为不可见时立即落盘草稿，避免退出应用丢掉最后一段输入
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") focusInput();
  else flushDraft();
});

// 退出前兜底保存草稿
window.addEventListener("beforeunload", flushDraft);

let statusTimer = null;
function flashStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
  status.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove("show"), 1500);
}

// 保存成功后的延迟收起定时器（先给反馈再关窗）
let hideTimer = null;

function saveNote() {
  const content = editorView.state.doc.toString().trim();
  if (!content) {
    // 空内容：清除草稿并隐藏，不写入，也不提示成功
    clearDraft();
    appWindow.hide();
    return;
  }
  invoke("save_note", { content })
    .then(() => {
      clearDraft();
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: "" },
      });
      updateCount();
      // 短暂显示「已保存」再收起，避免只靠窗口消失暗示成功
      flashStatus("已保存");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => appWindow.hide(), 200);
    })
    .catch((err) => {
      flashStatus(`保存失败：${err}`, true);
    });
}

saveBtn.addEventListener("click", saveNote);

// ===== 拖动窗口 =====
// 无边框窗口没有标题栏，顶栏（按钮除外）承担拖动职责
enableWindowDragging(document.querySelector("[data-drag-region]"));

// ===== 窗口缩放 =====
// 无边框窗口没有系统缩放边框，用自定义 handle 触发 Tauri 原生 resize 拖拽。
//
// 关键：拖拽期间窗口管理器会让窗口失焦，而主窗口有「点击外部自动收起」逻辑，
// 若不抑制就会一按下左键窗口立刻消失。这里在按下时通知后端暂停自动收起，
// 松手后再恢复；另加超时兜底，防止 mouseup 丢失导致标记残留。
let resizing = false;
let resizeEndTimer = null;

function finishResize() {
  if (!resizing) return;
  resizing = false;
  clearTimeout(resizeEndTimer);
  resizeEndTimer = null;
  invoke("end_resize").catch(() => {});
}

for (const handle of document.querySelectorAll("[data-resize]")) {
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resizing = true;
    invoke("begin_resize").catch(() => {});
    // 兜底：拖拽结束后若没收到 mouseup，3 秒后自行恢复
    clearTimeout(resizeEndTimer);
    resizeEndTimer = setTimeout(finishResize, 3000);
    appWindow.startResizeDragging(handle.dataset.resize);
  });
}

document.addEventListener("mouseup", finishResize);

// ===== 全屏 =====
async function setFullscreen(next) {
  await appWindow.setFullscreen(next);
  fullscreen = next;
  document.body.classList.toggle("fullscreen", next);
  fullscreenBtn.textContent = next ? "⤡" : "⛶";
  fullscreenBtn.title = next ? "退出全屏 (F11)" : "全屏 (F11)";
}

async function toggleFullscreen() {
  await setFullscreen(!fullscreen);
}

fullscreenBtn.addEventListener("click", toggleFullscreen);

// 启动时同步一次（例如上次退出时是全屏状态）
window.addEventListener("DOMContentLoaded", async () => {
  fullscreen = await appWindow.isFullscreen().catch(() => false);
  document.body.classList.toggle("fullscreen", fullscreen);
  fullscreenBtn.textContent = fullscreen ? "⤡" : "⛶";
});
