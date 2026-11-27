// 前端日志统一转发到 Rust，与后端写入同一个日志文件。
// 日志失败不能影响业务，也不能递归触发日志上报。

const { invoke: tauriInvoke } = window.__TAURI__.core;

const MAX_MESSAGE_CHARS = 2000;
const LEVELS = new Set(["error", "warn", "info", "debug"]);
let installed = false;

function windowScope() {
  const name = window.location.pathname.split("/").pop();
  if (!name || name === "/") return "main";
  return name.replace(/\.html$/, "");
}

function formatError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function truncate(message) {
  return message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS) : message;
}

function send(level, message) {
  const safeLevel = LEVELS.has(level) ? level : "error";
  const text = truncate(`[${windowScope()}] ${message}`);
  try {
    tauriInvoke("log_frontend", { level: safeLevel, message: text }).catch(() => {});
  } catch {
    // 日志通道不可用时静默降级，避免打断业务
  }
}

export function logError(message) {
  send("error", message);
}

export function logWarn(message) {
  send("warn", message);
}

export function logInfo(message) {
  send("info", message);
}

export function logDebug(message) {
  send("debug", message);
}

// 与 Tauri invoke 用法一致；额外把失败写到日志文件后原样抛出。
export function invoke(cmd, args) {
  return tauriInvoke(cmd, args).catch((err) => {
    send("error", `invoke ${cmd} 失败: ${formatError(err)}`);
    throw err;
  });
}

// 每个窗口在入口处调用一次，捕获未处理异常与 Promise 拒绝。
export function initFrontendLogging() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    send("error", `未捕获异常: ${event.message} @ ${event.filename || "?"}:${event.lineno || 0}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", `未处理的 Promise 拒绝: ${formatError(event.reason)}`);
  });

  // 前端焦点 / 可见性变化：与 Rust 侧窗口事件对照，可判断 WebView 是否还在响应。
  // Node 单测只提供 window 桩，没有 document，跳过 DOM 相关监听。
  if (typeof document !== "undefined") {
    window.addEventListener("focus", () => logDebug("窗口获得焦点"));
    window.addEventListener("blur", () => logDebug("窗口失去焦点"));
    document.addEventListener("visibilitychange", () => {
      logDebug(`页面可见性: ${document.visibilityState}`);
    });
    // 仅前台窗口记录心跳；心跳中断而 Rust 侧仍有窗口日志时，说明渲染进程可能已挂起。
    setInterval(() => {
      if (document.visibilityState === "visible") logDebug("前端心跳");
    }, 60_000);
  }

  logInfo("前端日志已接入");
}
