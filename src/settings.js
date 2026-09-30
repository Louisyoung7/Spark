const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

const els = {
  closeBtn: document.getElementById("close-btn"),
  autostartToggle: document.getElementById("autostart-toggle"),
  autostartSub: document.getElementById("autostart-sub"),
  notesPath: document.getElementById("notes-path"),
  pickPathBtn: document.getElementById("pick-path-btn"),
  resetPathBtn: document.getElementById("reset-path-btn"),
  hotkeyMain: document.getElementById("hotkey-main"),
  hotkeyHistory: document.getElementById("hotkey-history"),
  hotkeyMainDefault: document.getElementById("hotkey-main-default"),
  hotkeyHistoryDefault: document.getElementById("hotkey-history-default"),
  status: document.getElementById("settings-status"),
};

let statusTimer = null;
function flashStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
  els.status.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.status.classList.remove("show"), 1800);
}

async function load() {
  let s;
  try {
    s = await invoke("get_settings");
  } catch (err) {
    flashStatus(`加载失败：${err}`, true);
    return;
  }

  // —— 通用 ——
  els.autostartToggle.checked = s.autostart;
  els.autostartToggle.disabled = !s.autostart_supported;
  els.autostartSub.textContent = s.autostart_supported
    ? s.autostart
      ? "已开启——登录后自动运行"
      : "关闭"
    : "当前环境不支持";

  els.notesPath.textContent = s.notes_path;
  els.notesPath.title = s.notes_path;
  els.resetPathBtn.disabled = s.notes_path_is_default;

  // —— 快捷键 ——
  els.hotkeyMain.value = s.hotkey_main_custom || "";
  els.hotkeyHistory.value = s.hotkey_history_custom || "";
  els.hotkeyMainDefault.textContent = s.hotkey_main_default;
  els.hotkeyHistoryDefault.textContent = s.hotkey_history_default;
}

listen("reload-settings", load);
window.addEventListener("focus", load);
window.addEventListener("DOMContentLoaded", load);

// 关闭
els.closeBtn.addEventListener("click", () => appWindow.hide());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    appWindow.hide();
  }
});

// ===== 开机自启 =====
els.autostartToggle.addEventListener("change", async () => {
  const want = els.autostartToggle.checked;
  try {
    await invoke("set_autostart", { enabled: want });
    flashStatus(want ? "已启用开机自启" : "已关闭开机自启");
  } catch (err) {
    // 失败时回滚 UI
    els.autostartToggle.checked = !want;
    flashStatus(`设置失败：${err}`, true);
  }
});

// ===== 笔记保存位置 =====
els.pickPathBtn.addEventListener("click", async () => {
  try {
    const picked = await invoke("pick_notes_path");
    if (!picked) return; // 用户取消
    await invoke("set_notes_path", { path: picked });
    await load();
    flashStatus("已更新笔记保存位置");
  } catch (err) {
    flashStatus(`保存失败：${err}`, true);
  }
});

els.resetPathBtn.addEventListener("click", async () => {
  try {
    await invoke("set_notes_path", { path: null });
    await load();
    flashStatus("已重置为默认位置");
  } catch (err) {
    flashStatus(`重置失败：${err}`, true);
  }
});