const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

// 顶栏（按钮除外）可拖动窗口
function enableWindowDragging(header) {
  if (!header) return;
  header.addEventListener("mousedown", (event) => {
    if (event.target.closest("button, input, textarea, a, select")) return;
    event.preventDefault();
    appWindow.startDragging();
  });
}
enableWindowDragging(document.querySelector("[data-drag-region]"));

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
  hotkeyMainCurrent: document.getElementById("hotkey-main-current"),
  hotkeyHistoryCurrent: document.getElementById("hotkey-history-current"),
  resetHotkeysBtn: document.getElementById("reset-hotkeys-btn"),
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

  // —— 快捷键 ——（录制中的输入框不覆盖，避免打断）
  if (recording !== els.hotkeyMain) {
    els.hotkeyMain.value = s.hotkey_main_custom || "";
  }
  if (recording !== els.hotkeyHistory) {
    els.hotkeyHistory.value = s.hotkey_history_custom || "";
  }
  els.hotkeyMainDefault.textContent = s.hotkey_main_default;
  els.hotkeyHistoryDefault.textContent = s.hotkey_history_default;
  els.hotkeyMainCurrent.textContent = s.hotkey_main;
  els.hotkeyHistoryCurrent.textContent = s.hotkey_history;
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

// ===== 快捷键录制 =====
// 修饰键顺序固定：Ctrl → Alt → Shift → Super，主键必须放在最后
const MODIFIERS = [
  ["ctrlKey", "Ctrl"],
  ["altKey", "Alt"],
  ["shiftKey", "Shift"],
  ["metaKey", "Super"],
];

// 单独按下这些键不算完成录制，继续等待主键
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

const PUNCTUATION = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

// 把 KeyboardEvent.code 转成 global-hotkey 能解析的主键名
function codeToToken(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyQ → Q
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 → 1
  if (/^Numpad[0-9]$/.test(code)) return `Numpad${code.slice(6)}`;
  if (PUNCTUATION[code]) return PUNCTUATION[code];
  return code; // Space / Enter / F1..F12 / ArrowUp / Home 等直接用 Code 名
}

function modifierTokens(e) {
  return MODIFIERS.filter(([flag]) => e[flag]).map(([, name]) => name);
}

let recording = null; // 正在录制的输入框

function startRecording(input) {
  if (recording === input) return;
  stopRecording();
  // 记下原值，Esc 取消时可还原
  input.dataset.prev = input.value;
  recording = input;
  input.classList.add("recording");
  input.value = "按下组合键…";
  // 暂停全局快捷键，避免录制 Alt+Q 时把窗口弹出来
  invoke("begin_hotkey_capture").catch(() => {});
}

function stopRecording() {
  if (!recording) return;
  recording.classList.remove("recording");
  recording = null;
  invoke("end_hotkey_capture").catch(() => {});
}

// 空字符串表示恢复默认
function currentMainInput() {
  const v = els.hotkeyMain.value.trim();
  return v === "" ? null : v;
}
function currentHistoryInput() {
  const v = els.hotkeyHistory.value.trim();
  return v === "" ? null : v;
}

async function applyHotkeys() {
  try {
    const res = await invoke("set_hotkeys", {
      hotkeyMain: currentMainInput(),
      hotkeyHistory: currentHistoryInput(),
    });
    await load();
    flashStatus(res.message);
  } catch (err) {
    await load(); // 失败时用后端真实值回填
    flashStatus(`${err}`, true);
  }
}

function handleRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();

  // Esc：取消录制，保留原值
  if (e.key === "Escape") {
    const input = recording;
    stopRecording();
    input.value = input.dataset.prev || "";
    return;
  }

  const mods = modifierTokens(e);

  // 无修饰键的 Backspace/Delete：清空，恢复默认
  if (mods.length === 0 && (e.key === "Backspace" || e.key === "Delete")) {
    recording.value = "";
    stopRecording();
    applyHotkeys();
    return;
  }

  // 只按下修饰键：显示已按下的部分，继续等主键
  if (MODIFIER_CODES.has(e.code)) {
    recording.value = mods.length ? `${mods.join("+")}+…` : "按下组合键…";
    return;
  }

  const token = codeToToken(e.code);
  if (!token) return;

  recording.value = [...mods, token].join("+");
  stopRecording();
  applyHotkeys();
}

function bindHotkeyInput(input) {
  // 键盘 Tab 聚焦也可录制
  input.addEventListener("focus", () => startRecording(input));
  input.addEventListener("mousedown", (e) => {
    e.preventDefault();
    input.focus();
    // 输入框已聚焦时 focus 不会再次触发，这里兜底重开录制
    startRecording(input);
  });
  input.addEventListener("keydown", handleRecordKey);
  input.addEventListener("blur", () => stopRecording());
}
bindHotkeyInput(els.hotkeyMain);
bindHotkeyInput(els.hotkeyHistory);

els.resetHotkeysBtn.addEventListener("click", async () => {
  els.hotkeyMain.value = "";
  els.hotkeyHistory.value = "";
  await applyHotkeys();
});