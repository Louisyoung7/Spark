import { initTheme, setTheme } from "./theme.js";
import { createFlashStatus } from "./shared/feedback.js";
import { enableWindowDragging } from "./shared/window.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

// 顶栏（按钮除外）可拖动窗口
enableWindowDragging(appWindow, document.querySelector("[data-drag-region]"));

const els = {
  closeBtn: document.getElementById("close-btn"),
  autostartToggle: document.getElementById("autostart-toggle"),
  autostartSub: document.getElementById("autostart-sub"),
  notesPath: document.getElementById("notes-path"),
  pickPathBtn: document.getElementById("pick-path-btn"),
  resetPathBtn: document.getElementById("reset-path-btn"),
  exportNotesBtn: document.getElementById("export-notes-btn"),
  importNotesBtn: document.getElementById("import-notes-btn"),
  hotkeyMain: document.getElementById("hotkey-main"),
  hotkeyHistory: document.getElementById("hotkey-history"),
  hotkeyMainDefault: document.getElementById("hotkey-main-default"),
  hotkeyHistoryDefault: document.getElementById("hotkey-history-default"),
  hotkeyMainCurrent: document.getElementById("hotkey-main-current"),
  hotkeyHistoryCurrent: document.getElementById("hotkey-history-current"),
  resetHotkeysBtn: document.getElementById("reset-hotkeys-btn"),
  themeSegments: Array.from(document.querySelectorAll(".theme-segment")),
  appVersion: document.getElementById("app-version"),
  checkUpdateBtn: document.getElementById("check-update-btn"),
  updateResult: document.getElementById("update-result"),
  updateTitle: document.getElementById("update-title"),
  updateNotes: document.getElementById("update-notes"),
  updateProgress: document.getElementById("update-progress"),
  updateProgressFill: document.getElementById("update-progress-fill"),
  updateProgressText: document.getElementById("update-progress-text"),
  updateActions: document.getElementById("update-actions"),
  downloadUpdateBtn: document.getElementById("download-update-btn"),
  openReleaseBtn: document.getElementById("open-release-btn"),
  proxyInput: document.getElementById("proxy-input"),
  saveProxyBtn: document.getElementById("save-proxy-btn"),
  status: document.getElementById("settings-status"),
};

// 主题选中态：三段按钮用 aria-pressed 表达当前模式
function markTheme(mode) {
  for (const btn of els.themeSegments) {
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === mode));
  }
}

const flashStatus = createFlashStatus(els.status, 1800);

// ===== 版本更新 =====
const RELEASE_PAGE = "https://github.com/Louisyoung7/Spark/releases/latest";
let currentUpdate = null;
let checkingUpdate = false;
// 下载 / 安装期间忽略重新渲染，避免窗口聚焦时把进度状态冲掉
let updating = false;
// 当前安装形态与授权能力，由后端检测
let capability = { install_kind: "deb", requires_polkit: true, polkit_agent: true };

// 没有 polkit 认证代理时 deb/rpm 无法弹授权框，只能引导手动下载
function canInstallInApp() {
  return !capability.requires_polkit || capability.polkit_agent;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function resetProgress() {
  els.updateProgress.classList.add("hidden");
  els.updateProgressFill.style.width = "0%";
  els.updateProgressText.textContent = "";
  els.downloadUpdateBtn.disabled = false;
  els.downloadUpdateBtn.textContent = "下载并安装";
}

// info 为 null 表示还未检查过；有更新时展示说明摘要与下载入口
function renderUpdate(info) {
  if (updating) return;
  currentUpdate = info || null;
  if (!currentUpdate) {
    els.updateResult.classList.add("hidden");
    return;
  }
  els.updateResult.classList.remove("hidden");
  els.openReleaseBtn.classList.add("hidden");
  resetProgress();
  if (currentUpdate.has_update) {
    const blocked = !canInstallInApp();
    const notes = currentUpdate.notes || "该版本没有更新说明。";
    els.updateTitle.textContent = `发现新版本 v${currentUpdate.latest}`;
    els.updateNotes.textContent = blocked
      ? `${notes}\n\n未检测到 polkit 认证代理，无法在应用内安装，请点击「打开发布页」手动下载。`
      : notes;
    els.updateNotes.classList.remove("hidden");
    els.updateActions.classList.remove("hidden");
    els.downloadUpdateBtn.classList.toggle("hidden", blocked);
    els.openReleaseBtn.classList.toggle("hidden", !blocked);
  } else {
    els.updateTitle.textContent = "已是最新版本";
    els.updateNotes.textContent = "";
    els.updateNotes.classList.add("hidden");
    els.updateActions.classList.add("hidden");
  }
}

// 检查失败时仍给出口：交给浏览器走系统代理打开发布页
function renderUpdateError(message) {
  currentUpdate = null;
  resetProgress();
  els.updateResult.classList.remove("hidden");
  els.updateTitle.textContent = "检查更新失败";
  els.updateNotes.textContent = message || "无法获取更新信息。";
  els.updateNotes.classList.remove("hidden");
  els.updateActions.classList.remove("hidden");
  els.downloadUpdateBtn.classList.add("hidden");
  els.openReleaseBtn.classList.remove("hidden");
}

function renderProgress(event) {
  const { stage, downloaded, total } = event;
  els.updateProgress.classList.remove("hidden");
  if (stage === "installing" || stage === "replacing") {
    els.updateProgressFill.style.width = "100%";
    els.updateProgressText.textContent =
      stage === "replacing" ? "正在替换 AppImage…" : "正在安装，请在系统弹窗中输入密码…";
    els.downloadUpdateBtn.textContent = "安装中…";
    return;
  }
  const percent = total > 0 ? Math.min(100, Math.round((downloaded * 100) / total)) : 0;
  els.updateProgressFill.style.width = `${percent}%`;
  els.updateProgressText.textContent =
    total > 0
      ? `正在下载 ${percent}%（${formatBytes(downloaded)} / ${formatBytes(total)}）`
      : `正在下载 ${formatBytes(downloaded)}`;
}

async function openReleasePage(url) {
  try {
    await invoke("open_release_page", { url });
  } catch (err) {
    flashStatus(`打开下载页失败：${err}`, true);
  }
}

async function checkForUpdate() {
  if (checkingUpdate || updating) return;
  checkingUpdate = true;
  els.checkUpdateBtn.disabled = true;
  els.checkUpdateBtn.textContent = "检查中…";
  try {
    const info = await invoke("check_update", { force: true });
    renderUpdate(info);
    flashStatus(info && info.has_update ? `发现新版本 v${info.latest}` : "已是最新版本");
  } catch (err) {
    renderUpdateError(`${err}`);
  } finally {
    checkingUpdate = false;
    els.checkUpdateBtn.disabled = false;
    els.checkUpdateBtn.textContent = "检查更新";
  }
}

els.checkUpdateBtn.addEventListener("click", checkForUpdate);

els.downloadUpdateBtn.addEventListener("click", async () => {
  if (!currentUpdate || updating) return;
  updating = true;
  els.downloadUpdateBtn.disabled = true;
  els.downloadUpdateBtn.textContent = "下载中…";
  els.checkUpdateBtn.disabled = true;
  els.openReleaseBtn.classList.add("hidden");
  els.updateProgress.classList.remove("hidden");
  els.updateProgressFill.style.width = "0%";
  els.updateProgressText.textContent = "准备下载…";
  try {
    await invoke("download_and_install_update");
    // 正常流程里应用会重启，这里仅作兜底
    els.updateProgressText.textContent = "安装完成，正在重启…";
  } catch (err) {
    updating = false;
    resetProgress();
    els.downloadUpdateBtn.textContent = "重试下载";
    els.checkUpdateBtn.disabled = false;
    els.openReleaseBtn.classList.remove("hidden");
    flashStatus(`更新失败：${err}`, true);
  }
});

els.openReleaseBtn.addEventListener("click", () => openReleasePage(RELEASE_PAGE));

els.saveProxyBtn.addEventListener("click", async () => {
  const value = els.proxyInput.value.trim();
  els.saveProxyBtn.disabled = true;
  try {
    await invoke("set_proxy", { proxy: value || null });
    flashStatus(value ? "代理已保存" : "已恢复为读取环境变量");
  } catch (err) {
    flashStatus(`${err}`, true);
  } finally {
    els.saveProxyBtn.disabled = false;
  }
});

// 托盘「检查更新」触发同一套手动检查流程
listen("check-update", checkForUpdate);
listen("update-status", (event) => renderUpdate(event.payload));
listen("update-progress", (event) => renderProgress(event.payload));

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

  markTheme(s.theme || "system");

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

  // —— 关于 ——
  els.appVersion.textContent = `当前版本 ${s.app_version}`;
  // 避免窗口重新获得焦点时覆盖用户正在编辑的代理输入
  if (document.activeElement !== els.proxyInput) {
    els.proxyInput.value = s.proxy || "";
  }
  try {
    // 每次打开设置页都重新检测，用户可能刚启动了认证代理
    capability = await invoke("get_update_capability");
  } catch {
    // 检测失败时维持默认，避免误阻断
  }
  try {
    // 打开设置页时立即渲染缓存结果，避免依赖事件时序
    renderUpdate(await invoke("get_update_status"));
  } catch {
    renderUpdate(null);
  }
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

// ===== 主题 =====
for (const btn of els.themeSegments) {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.theme;
    markTheme(mode);
    try {
      await setTheme(mode);
      flashStatus("主题已切换");
    } catch (err) {
      await load(); // 失败时回填后端真实值
      flashStatus(`设置失败：${err}`, true);
    }
  });
}

initTheme();

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

// ===== 数据备份 =====
function setBackupBusy(busy) {
  els.exportNotesBtn.disabled = busy;
  els.importNotesBtn.disabled = busy;
}

els.exportNotesBtn.addEventListener("click", async () => {
  setBackupBusy(true);
  try {
    const path = await invoke("export_notes");
    if (path) flashStatus(`已备份到 ${path}`);
  } catch (err) {
    flashStatus(`导出失败：${err}`, true);
  } finally {
    setBackupBusy(false);
  }
});

els.importNotesBtn.addEventListener("click", async () => {
  setBackupBusy(true);
  try {
    const result = await invoke("import_notes");
    if (result) {
      flashStatus(
        `已导入 ${result.imported} 条，跳过 ${result.skipped} 条，重复 ${result.duplicates} 条`,
      );
    }
  } catch (err) {
    flashStatus(`导入失败：${err}`, true);
  } finally {
    setBackupBusy(false);
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
