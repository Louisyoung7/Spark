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

let currentNotes = [];

function render(notes) {
  currentNotes = notes;
  listEl.innerHTML = "";
  countEl.textContent = notes.length ? `${notes.length} 条` : "";
  emptyEl.classList.toggle("hidden", notes.length > 0);

  for (const note of notes) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-item-time">${escapeHtml(formatTime(note.time))}</div>
      <div class="history-item-content">${escapeHtml(note.content)}</div>
      <div class="history-item-actions">
        <button class="icon-btn act-copy" title="复制">复制</button>
        <button class="icon-btn act-edit" title="编辑">编辑</button>
        <button class="icon-btn act-del" title="删除">删除</button>
      </div>`;
    item.querySelector(".act-copy").addEventListener("click", async () => {
      const ok = await copyText(note.content);
      showToast(ok ? "已复制" : "复制失败");
    });
    item.querySelector(".act-edit").addEventListener("click", () => enterEdit(note, item));
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

// 进入内联编辑态：内容区换成 textarea，操作区换成 保存/取消。
function enterEdit(note, item) {
  const contentDiv = item.querySelector(".history-item-content");
  const actions = item.querySelector(".history-item-actions");

  contentDiv.innerHTML = `<textarea class="edit-area"></textarea>`;
  const ta = contentDiv.querySelector(".edit-area");
  ta.value = note.content;
  item.classList.add("editing");
  actions.innerHTML = `
    <button class="icon-btn act-save" title="保存 (Ctrl+Enter)">保存</button>
    <button class="icon-btn act-cancel" title="取消 (Esc)">取消</button>`;

  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const save = () => saveEdit(note, ta);
  const cancel = () => render(currentNotes); // 取消：用当前列表重渲染，恢复原文本

  actions.querySelector(".act-save").addEventListener("click", save);
  actions.querySelector(".act-cancel").addEventListener("click", cancel);

  // Ctrl+Enter 保存；Esc 取消（编辑态优先于窗口级 Esc 关闭）
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });
}

async function saveEdit(note, ta) {
  const content = ta.value.trim();
  if (!content) {
    showToast("内容不能为空");
    return;
  }
  try {
    await invoke("edit_note", { line: note.line, content });
    showToast("已保存");
    await load(); // 重新拉取并刷新，确保与后端一致
  } catch (err) {
    showToast(`保存失败：${err}`);
  }
}

async function load() {
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
