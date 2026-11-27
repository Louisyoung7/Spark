import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const listeners = new Map();
const registered = [];

let invokeImpl = (cmd, args) => {
  calls.push({ cmd, args });
  return Promise.resolve();
};

// log.js 在导入时读取 window.__TAURI__，必须先装好最小 WebView 环境。
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: (cmd, args) => invokeImpl(cmd, args),
    },
  },
  location: { pathname: "/" },
  addEventListener: (type, handler) => {
    registered.push(type);
    listeners.set(type, handler);
  },
};

const log = await import("./log.js");

function reset() {
  calls.length = 0;
  registered.length = 0;
  listeners.clear();
  window.location.pathname = "/";
  invokeImpl = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve();
  };
}

test("logInfo 写入 info 级别并带主窗口标记", () => {
  reset();
  log.logInfo("启动完成");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "log_frontend");
  assert.deepEqual(calls[0].args, { level: "info", message: "[main] 启动完成" });
});

test("日志按页面路径添加窗口标记", () => {
  reset();
  window.location.pathname = "/settings.html";
  log.logWarn("设置异常");

  assert.equal(calls[0].args.message, "[settings] 设置异常");
});

test("超长日志被截断到 2000 字符", () => {
  reset();
  log.logError("错".repeat(2100));

  assert.equal(calls[0].args.message.length, 2000);
  assert.ok(calls[0].args.message.startsWith("[main]"));
});

test("invoke 成功时原样返回结果且不写日志", async () => {
  reset();
  invokeImpl = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({ ok: true });
  };

  const result = await log.invoke("get_settings", { force: true });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ cmd: "get_settings", args: { force: true } }]);
});

test("invoke 失败时写入 error 日志并原样抛出", async () => {
  reset();
  const failure = new Error("boom");
  invokeImpl = (cmd, args) => {
    calls.push({ cmd, args });
    return cmd === "save_note" ? Promise.reject(failure) : Promise.resolve();
  };

  await assert.rejects(
    () => log.invoke("save_note", { content: "x" }),
    (err) => err === failure,
  );

  const logCall = calls.find((c) => c.cmd === "log_frontend");
  assert.equal(logCall.args.level, "error");
  assert.equal(logCall.args.message, "[main] invoke save_note 失败: Error: boom");
});

test("initFrontendLogging 只注册一次全局监听并上报异常", () => {
  reset();
  log.initFrontendLogging();
  log.initFrontendLogging();

  assert.equal(registered.filter((type) => type === "error").length, 1);
  assert.equal(registered.filter((type) => type === "unhandledrejection").length, 1);

  listeners.get("error")({ message: "崩溃", filename: "/main.js", lineno: 12 });
  listeners.get("unhandledrejection")({ reason: "拒绝原因" });

  const logCalls = calls.filter((c) => c.cmd === "log_frontend");
  assert.equal(logCalls.length, 3);
  assert.equal(logCalls[0].args.message, "[main] 前端日志已接入");
  assert.match(logCalls[1].args.message, /未捕获异常: 崩溃 @ \/main\.js:12/);
  assert.equal(logCalls[2].args.message, "[main] 未处理的 Promise 拒绝: 拒绝原因");
});
