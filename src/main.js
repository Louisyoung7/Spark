const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
const input = document.getElementById("note-input");
const status = document.getElementById("status");
const saveBtn = document.getElementById("save-btn");
const wordCount = document.getElementById("word-count");

// 聚焦输入框并把光标移到末尾（草稿保留时接着输入）
function focusInput() {
  input.focus();
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

function updateCount() {
  const text = input.value;
  if (!text) {
    wordCount.textContent = "";
    return;
  }
  const chars = text.length;
  const lines = text.split("\n").length;
  wordCount.textContent = `${chars} 字 · ${lines} 行`;
}
input.addEventListener("input", updateCount);

window.addEventListener("DOMContentLoaded", () => {
  focusInput();
  updateCount();
});

// Rust 侧每次显示 / 重新聚焦窗口后都会发该事件，作为 DOM 焦点兜底
listen("focus-input", focusInput);

// 页面重新可见时（Wayland 切换前台等场景）补一次聚焦
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") focusInput();
});

let statusTimer = null;
function flashStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
  status.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove("show"), 1500);
}

function saveNote() {
  const content = input.value.trim();
  if (!content) {
    // 空内容：直接隐藏，不写入
    appWindow.hide();
    return;
  }
  invoke("save_note", { content })
    .then(() => {
      input.value = ""; // 保存成功后清空；草稿仅在取消时保留
      updateCount();
      appWindow.hide();
    })
    .catch((err) => {
      flashStatus(`保存失败：${err}`, true);
    });
}

saveBtn.addEventListener("click", saveNote);

input.addEventListener("keydown", (event) => {
  // Ctrl+Enter / Cmd+Enter：保存
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    saveNote();
    return;
  }
  // 其余按键走默认行为：Enter 换行、Shift+Enter 换行、正常编辑
  if (event.key === "Escape") {
    event.preventDefault();
    // 取消：保留草稿，隐藏窗口
    appWindow.hide();
  }
});
