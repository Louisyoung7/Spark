import { syncOutline } from "./outline.js";

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
const listEl = document.getElementById("note-list");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const toastEl = document.getElementById("toast");
const editView = document.getElementById("edit-view");
const editText = document.getElementById("edit-text");
const editTime = document.getElementById("edit-time");
const editCount = document.getElementById("edit-count");
const editSave = document.getElementById("edit-save");
const editCancel = document.getElementById("edit-cancel");
const editTextOverlay = document.getElementById("edit-overlay");

let toastTimer = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1200);
}

// RFC3339 → "MM-DD HH:mm"（本地时区）
function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// 幕布式无序列表渲染：把带缩进的「- / * / + 」行渲染成嵌套 <ul>。
// 非列表行按原换行保留为段落；笔记仍以纯文本存储，这里只做展示层转换。
function renderOutline(text) {
  const lines = text.split("\n");
  let out = "";
  const stack = []; // 各打开层级的缩进宽度
  let paraBuf = [];

  const indentOf = (line) => {
    let n = 0;
    for (const ch of line) {
      if (ch === " " || ch === "\t") n++;
      else break;
    }
    return n;
  };
  const isItem = (line) =>
    /^[-*+]\s/.test(line.trimStart()) || /^[-*+]$/.test(line.trim());
  const itemText = (line) => line.trimStart().replace(/^[-*+]\s?/, "");

  const flushPara = () => {
    if (paraBuf.length) {
      out += `<p>${paraBuf.map(escapeHtml).join("<br>")}</p>`;
      paraBuf = [];
    }
  };

  for (const raw of lines) {
    if (raw.trim() === "") {
      flushPara();
      while (stack.length) {
        out += "</li></ul>";
        stack.pop();
      }
      continue;
    }
    const indent = indentOf(raw);
    if (!isItem(raw)) {
      flushPara();
      while (stack.length) {
        out += "</li></ul>";
        stack.pop();
      }
      paraBuf.push(raw);
      continue;
    }
    flushPara();
    const content = escapeHtml(itemText(raw));
    while (stack.length && indent < stack[stack.length - 1]) {
      out += "</li></ul>";
      stack.pop();
    }
    if (stack.length === 0) {
      out += "<ul>";
      stack.push(indent);
      out += `<li>${content}`;
    } else if (indent > stack[stack.length - 1]) {
      out += "<ul>";
      stack.push(indent);
      out += `<li>${content}`;
    } else {
      out += "</li>";
      out += `<li>${content}`;
    }
  }
  flushPara();
  while (stack.length) {
    out += "</li></ul>";
    stack.pop();
  }
  return out;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebKitGTK 剪贴板 API 不可用时的兜底
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function render(notes) {
  listEl.innerHTML = "";
  countEl.textContent = notes.length ? `${notes.length} 条` : "";
  emptyEl.classList.toggle("hidden", notes.length > 0);

  for (const note of notes) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-item-time">${escapeHtml(formatTime(note.time))}</div>
      <div class="history-item-content">${renderOutline(note.content)}</div>
      <div class="history-item-actions">
        <button class="icon-btn act-copy" title="复制" tabindex="-1">复制</button>
        <button class="icon-btn act-edit" title="编辑" tabindex="-1">编辑</button>
        <button class="icon-btn act-del" title="删除" tabindex="-1">删除</button>
      </div>`;
    item.querySelector(".act-copy").addEventListener("click", async () => {
      const ok = await copyText(note.content);
      showToast(ok ? "已复制" : "复制失败");
    });
    item.querySelector(".act-edit").addEventListener("click", () => enterEdit(note));
    item.querySelector(".act-del").addEventListener("click", async () => {
      try {
        await invoke("delete_note", { line: note.line });
        await load();
        showToast("已删除");
      } catch (err) {
        showToast(`删除失败：${err}`);
      }
    });
    listEl.appendChild(item);
  }
}

// 进入编辑态：弹出覆盖全窗口的大编辑视图（与速记编辑器一致）。
let editingNote = null;

function enterEdit(note) {
  editingNote = note;
  editTime.textContent = formatTime(note.time);
  editText.value = note.content;
  updateEditCount();
  editView.classList.remove("hidden");
  editText.focus();
  editText.setSelectionRange(editText.value.length, editText.value.length);
  syncOutline(editText, editTextOverlay);
}

function updateEditCount() {
  const text = editText.value;
  if (!text) {
    editCount.textContent = "";
    return;
  }
  const chars = text.length;
  const lines = text.split("\n").length;
  editCount.textContent = `${chars} 字 · ${lines} 行`;
}
editText.addEventListener("input", () => {
  updateEditCount();
  syncOutline(editText, editTextOverlay);
});
editText.addEventListener("scroll", () => {
  editTextOverlay.scrollTop = editText.scrollTop;
  editTextOverlay.scrollLeft = editText.scrollLeft;
});

function exitEdit() {
  editingNote = null;
  editView.classList.add("hidden");
}

editSave.addEventListener("click", saveEdit);
editCancel.addEventListener("click", exitEdit);

// 幕布式缩进（作用于任意 textarea）：对光标行/选中多行行首增/减一个 Tab。
function indentTextarea(ta, dir) {
  const val = ta.value;
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  const blockStart = val.lastIndexOf("\n", selStart - 1) + 1;
  let blockEnd = val.indexOf("\n", selEnd);
  if (blockEnd === -1) blockEnd = val.length;

  const lines = val.slice(blockStart, blockEnd).split("\n");
  let changed = 0;
  const newLines = lines.map((line) => {
    if (dir > 0) {
      changed++;
      return "\t" + line;
    }
    if (line.startsWith("\t")) {
      changed++;
      return line.slice(1);
    }
    if (line.startsWith(" ")) {
      changed++;
      return line.slice(1);
    }
    return line;
  });
  const newBlock = newLines.join("\n");

  ta.setRangeText(newBlock, blockStart, blockEnd);
  const delta = dir > 0 ? lines.length : changed;
  const max = ta.value.length;
  ta.setSelectionRange(
    Math.max(0, Math.min(max, selStart + delta)),
    Math.max(0, Math.min(max, selEnd + delta))
  );
}

// 回车继承缩进：插入换行 + 当前行前导空白；当前行为空（仅缩进）则不继承并清除缩进退出层级。
function enterWithIndent(ta) {
  const val = ta.value;
  const pos = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
  const beforeCursor = val.slice(lineStart, pos);
  const indentMatch = beforeCursor.match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0] : "";
  const contentAfterIndent = beforeCursor.slice(indent.length);
  if (contentAfterIndent.trim() === "") {
    ta.setRangeText("\n", lineStart, selEnd);
    ta.selectionStart = ta.selectionEnd = lineStart + 1;
  } else {
    const insert = "\n" + indent;
    ta.setRangeText(insert, pos, selEnd);
    ta.selectionStart = ta.selectionEnd = pos + insert.length;
  }
}

// 编辑态：Tab 缩进；Enter 继承缩进；Ctrl+Enter 保存；Esc 取消
editText.addEventListener("keydown", (e) => {
  if (e.key === "Tab" || e.code === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    indentTextarea(editText, e.shiftKey ? -1 : 1);
    updateEditCount();
    // 双保险：个别 webview 中 preventDefault 未能阻止 Tab 焦点移动，确保焦点留在编辑框
    setTimeout(() => {
      if (!editView.classList.contains("hidden") && document.activeElement !== editText) {
        editText.focus();
      }
    }, 0);
    return;
  }
  // 普通 Enter：换行并继承当前行缩进（幕布式）
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    enterWithIndent(editText);
    updateEditCount();
    return;
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.stopPropagation();
    saveEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    exitEdit();
  }
});

async function saveEdit() {
  if (!editingNote) return;
  const content = editText.value.trim();
  if (!content) {
    showToast("内容不能为空");
    return;
  }
  const note = editingNote;
  try {
    await invoke("edit_note", { line: note.line, content });
    showToast("已保存");
    exitEdit();
    await load(); // 重新拉取并刷新，确保与后端一致
  } catch (err) {
    showToast(`保存失败：${err}`);
  }
}

async function load() {
  // 编辑态下窗口聚焦等事件可能触发刷新，避免覆盖正在编辑的内容
  if (editingNote) return;
  try {
    render(await invoke("list_notes"));
  } catch (err) {
    showToast(`加载失败：${err}`);
  }
}

// Rust 侧每次显示窗口后都会发该事件，作为刷新触发
listen("reload-history", load);

// 切回窗口时刷新（切到速记窗口新写了内容等场景）
window.addEventListener("focus", load);

window.addEventListener("DOMContentLoaded", load);

// Esc / 关闭按钮 → 隐藏窗口
function hideWindow() {
  appWindow.hide();
}
document.getElementById("close-btn").addEventListener("click", hideWindow);
document.getElementById("settings-btn").addEventListener("click", () => {
  invoke("open_settings");
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideWindow();
});
