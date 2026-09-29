const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
const input = document.getElementById("note-input");
const status = document.getElementById("status");

// 聚焦输入框并把光标移到末尾（草稿保留时接着输入）
function focusInput() {
  input.focus();
  const len = input.value.length;
  input.setSelectionRange(len, len);
}
window.addEventListener("DOMContentLoaded", focusInput);

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

input.addEventListener("keydown", (event) => {
  // Shift+Enter：默认行为，插入换行
  if (event.key === "Enter" && event.shiftKey) return;
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) {
      // 空内容：直接隐藏，不写入
      appWindow.hide();
      return;
    }
    invoke("save_note", { content })
      .then(() => {
        input.value = ""; // 保存成功后清空；草稿仅在取消时保留
        appWindow.hide();
      })
      .catch((err) => {
        flashStatus(`保存失败：${err}`, true);
      });
  } else if (event.key === "Escape") {
    event.preventDefault();
    // 取消：保留草稿，隐藏窗口
    appWindow.hide();
  }
});
