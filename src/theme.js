// 主题：light / dark / system，三个窗口共用。
//
// 偏好持久化在 settings.json；页面实际主题写到 <html data-theme="light|dark">，
// 由 styles.css 的令牌覆盖负责换肤。system 模式以 matchMedia 为准：
// Linux 上 Tauri 的 window.theme()/onThemeChanged 受 xdg portal 限制不可靠。

import { THEME_CACHE_KEY } from "./shared/keys.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const MODES = new Set(["light", "dark", "system"]);
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

let currentMode = "system";
let listening = false;

function normalize(mode) {
  return MODES.has(mode) ? mode : "system";
}

function isDarkMode(mode) {
  return mode === "system" ? darkQuery.matches : mode === "dark";
}

// 同步读取上次解析结果，尽量让首帧就是正确主题
try {
  const cached = localStorage.getItem(THEME_CACHE_KEY);
  if (cached === "light" || cached === "dark") {
    document.documentElement.dataset.theme = cached;
  }
} catch {
  // localStorage 不可用时忽略，稍后由 initTheme 校正
}

function paint(mode) {
  const isDark = isDarkMode(mode);
  const resolved = isDark ? "dark" : "light";
  const changed = document.documentElement.dataset.theme !== resolved;
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  } catch {
    // 忽略缓存失败
  }
  // 解析结果没变时不必让编辑器重配主题
  if (changed) {
    window.dispatchEvent(new CustomEvent("spark:theme", { detail: { mode, isDark } }));
  }
}

export function currentThemeMode() {
  return currentMode;
}

export async function setTheme(mode) {
  const next = normalize(mode);
  const prev = currentMode;
  // 乐观应用：点击后立即换肤，失败再回滚
  currentMode = next;
  paint(next);
  try {
    await invoke("set_theme", { theme: next });
    return next;
  } catch (err) {
    currentMode = prev;
    paint(prev);
    throw err;
  }
}

export async function initTheme() {
  if (!listening) {
    listening = true;
    listen("theme-changed", (event) => {
      currentMode = normalize(event.payload);
      paint(currentMode);
    });

    const onSystemChange = () => {
      if (currentMode === "system") paint(currentMode);
    };
    if (darkQuery.addEventListener) darkQuery.addEventListener("change", onSystemChange);
    else if (darkQuery.addListener) darkQuery.addListener(onSystemChange);

    // 隐藏窗口期间 WebKit 可能合并媒体查询事件，重新可见时复检一次
    window.addEventListener("focus", onSystemChange);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onSystemChange();
    });
  }

  try {
    const settings = await invoke("get_settings");
    currentMode = normalize(settings.theme);
  } catch {
    currentMode = "system";
  }
  paint(currentMode);
  return currentMode;
}
