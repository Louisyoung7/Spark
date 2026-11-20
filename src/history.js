import { createEditor, EditorView, setEditorTheme } from "./editor/index.js";
import { dataUrlToBytes, drawExportImage, exportFileName } from "./history/exportImage.js";
import { daysLeft, formatTime, noteKey, rangeStart } from "./history/format.js";
import { escapeHtml, renderOutline } from "./markdown/renderHtml.js";
import { initTheme } from "./theme.js";
import { listKeyCommands, saveCommands } from "./shared/editorCommands.js";
import { createFlashStatus } from "./shared/feedback.js";
import { LAST_SAVED_KEY } from "./shared/keys.js";
import { enableWindowDragging } from "./shared/window.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

// 顶栏（按钮除外）可拖动窗口
enableWindowDragging(appWindow, document.querySelector("[data-drag-region]"));
const listEl = document.getElementById("note-list");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");
const emptyTextEl = document.getElementById("empty-text");
const searchEl = document.getElementById("search-input");
const toastEl = document.getElementById("toast");
const editView = document.getElementById("edit-view");
const editText = document.getElementById("edit-text");
const editTime = document.getElementById("edit-time");
const editCount = document.getElementById("edit-count");
const editSave = document.getElementById("edit-save");
const editCancel = document.getElementById("edit-cancel");
const cardEl = document.querySelector(".history-card");
const selectBtn = document.getElementById("select-btn");
const filterChips = Array.from(document.querySelectorAll(".filter-chip"));
const selectBar = document.getElementById("select-bar");
const selectCount = document.getElementById("select-count");
const selectCopy = document.getElementById("select-copy");
const selectExport = document.getElementById("select-export");
const selectDelete = document.getElementById("select-delete");
const selectCancel = document.getElementById("select-cancel");
const historyTitle = document.getElementById("history-title");
const searchWrap = document.getElementById("search-wrap");
const filtersEl = document.getElementById("filters");
const trashBtn = document.getElementById("trash-btn");
const trashBar = document.getElementById("trash-bar");
const trashHint = document.getElementById("trash-hint");
const trashEmpty = document.getElementById("trash-empty");
const confirmView = document.getElementById("confirm-view");
const confirmTitle = document.getElementById("confirm-title");
const confirmDesc = document.getElementById("confirm-desc");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

const RANGE_LABELS = { all: "全部", today: "今天", "7d": "近7天", "30d": "近30天" };

const showToast = createFlashStatus(toastEl, 1200);

// 通用确认弹窗：返回 Promise<boolean>，确认按钮文案可定制
let confirmResolve = null;

function askConfirm({ title, desc, okText = "确认" }) {
  confirmTitle.textContent = title;
  confirmDesc.textContent = desc;
  confirmOk.textContent = okText;
  confirmView.classList.remove("hidden");
  confirmOk.focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirm(result) {
  confirmView.classList.add("hidden");
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

confirmOk.addEventListener("click", () => closeConfirm(true));
confirmCancel.addEventListener("click", () => closeConfirm(false));

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

// 行内操作图标：继承按钮文字色，随悬停态变化
const ICON_COPY = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/><path d="M10.5 4.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h1.5"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/></svg>`;
const ICON_DELETE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11"/><path d="M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5"/><path d="M4 4.5l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8"/><path d="M6.5 7v4M9.5 7v4"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>`;
const ICON_RESTORE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3v3.5H6"/><path d="M2.9 9.6A5.2 5.2 0 1 0 4 4.1L2.5 6.5"/></svg>`;

const HIGHLIGHT_MS = 1600;
let highlightTimer = null;

// 取一次保存时间戳即清除，保证「刚保存」只高亮首次打开
function takeLastSavedAt() {
  try {
    const raw = localStorage.getItem(LAST_SAVED_KEY);
    if (!raw) return null;
    localStorage.removeItem(LAST_SAVED_KEY);
    return Number(raw);
  } catch {
    return null;
  }
}

// 与最新一条记录的时间比对（列表已按最新在前），命中则短暂高亮
function highlightLatest(savedAt) {
  if (!savedAt || !allNotes.length) return;
  const latest = allNotes[0];
  const t = new Date(latest.time).getTime();
  if (Number.isNaN(t) || Math.abs(t - savedAt) > 5000) return;
  const item = listEl.querySelector(`[data-line="${latest.line}"]`);
  if (!item) return;
  item.classList.add("is-new");
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => item.classList.remove("is-new"), HIGHLIGHT_MS);
}

function render(notes) {
  const query = searchEl.value.trim();
  listEl.innerHTML = "";
  countEl.textContent = notes.length ? `${notes.length} 条` : "";
  emptyEl.classList.toggle("hidden", notes.length > 0);
  if (!notes.length) {
    emptyTextEl.innerHTML = query
      ? `没有匹配的记录<br /><span class="dim">换个关键词试试</span>`
      : activeRange !== "all"
        ? `该时间段没有记录<br /><span class="dim">换个时间范围试试</span>`
        : `还没有速记<br /><span class="dim">按 <kbd class="kbd">Alt+Q</kbd> 写下第一条</span>`;
  }

  for (const note of notes) {
    const item = document.createElement("div");
    const key = noteKey(note);
    item.className = "history-item";
    item.dataset.line = note.line;
    if (selected.has(key)) item.classList.add("is-selected");
    item.innerHTML = `
      <div class="history-item-head">
        ${
          selectMode
            ? `<span class="select-box${selected.has(key) ? " is-checked" : ""}" aria-hidden="true">${ICON_CHECK}</span>`
            : ""
        }
        <span class="history-item-time">${escapeHtml(formatTime(note.time))}</span>
        <div class="history-item-actions">
          <button class="icon-btn act-copy" title="复制" aria-label="复制" tabindex="-1">${ICON_COPY}</button>
          <button class="icon-btn act-edit" title="编辑" aria-label="编辑" tabindex="-1">${ICON_EDIT}</button>
          <button class="icon-btn act-del" title="删除" aria-label="删除" tabindex="-1">${ICON_DELETE}</button>
        </div>
      </div>
      <div class="history-item-content">${renderOutline(note.content)}</div>`;
    // 多选模式下整张卡片即勾选区域，单条操作图标由 CSS 隐藏
    item.addEventListener("click", (event) => {
      if (!selectMode) return;
      event.preventDefault();
      toggleSelected(note, item);
    });
    item.querySelector(".act-copy").addEventListener("click", async () => {
      const ok = await copyText(note.content);
      showToast(ok ? "已复制" : "复制失败");
    });
    item.querySelector(".act-edit").addEventListener("click", () => enterEdit(note));
    item.querySelector(".act-del").addEventListener("click", async () => {
      const ok = await askConfirm({
        title: "删除这条速记？",
        desc: `删除后会移入回收站，${retentionDays} 天内可随时恢复。`,
        okText: "移入回收站",
      });
      if (!ok) return;
      try {
        await invoke("delete_note", { line: note.line, expectedTime: note.time });
        await load();
        showToast("已移入回收站");
      } catch (err) {
        showToast(`删除失败：${err}`);
        // 记录可能已被外部改动，重新拉取避免列表继续指向错误行号
        await load();
      }
    });
    listEl.appendChild(item);
  }
}

// 进入编辑态：弹出覆盖全窗口的大编辑视图（与速记编辑器一致）。
let editingNote = null;
let editEditor;

function enterEdit(note) {
  editingNote = note;
  editTime.textContent = formatTime(note.time);
  editEditor.dispatch({
    changes: { from: 0, to: editEditor.state.doc.length, insert: note.content },
  });
  updateEditCount();
  editView.classList.remove("hidden");
  editEditor.focus();
  const len = editEditor.state.doc.length;
  editEditor.dispatch({ selection: { anchor: len } });
  // 编辑视图从隐藏切到显示，主动触发一次布局测量，避免首帧尺寸为 0
  editEditor.requestMeasure();
}

function updateEditCount() {
  const text = editEditor.state.doc.toString();
  if (!text) {
    editCount.textContent = "";
    return;
  }
  const chars = text.length;
  const lines = text.split("\n").length;
  editCount.textContent = `${chars} 字 · ${lines} 行`;
}

function exitEdit() {
  editingNote = null;
  editView.classList.add("hidden");
}

editSave.addEventListener("click", saveEdit);
editCancel.addEventListener("click", exitEdit);

async function saveEdit() {
  if (!editingNote) return;
  const content = editEditor.state.doc.toString().trim();
  if (!content) {
    showToast("内容不能为空");
    return;
  }
  const note = editingNote;
  try {
    await invoke("edit_note", { line: note.line, content, expectedTime: note.time });
    showToast("已保存");
    exitEdit();
    await load(); // 重新拉取并刷新，确保与后端一致
  } catch (err) {
    showToast(`保存失败：${err}`);
  }
}

// 全量记录缓存，搜索与时间筛选只在前端过滤，不重复请求后端
let allNotes = [];
let trashEntries = [];
// 保留天数由后端返回，避免前后端各写一份常量
let retentionDays = 30;
// 当前视图：notes（历史记录）/ trash（回收站）
let view = "notes";

// 选择状态用「行号 + 时间」标识，重新加载后行号变动也能对齐
const selected = new Set();
let selectMode = false;
let activeRange = "all";

function selectedNotes() {
  return allNotes.filter((note) => selected.has(noteKey(note)));
}

function filterNotes() {
  const query = searchEl.value.trim().toLowerCase();
  const from = rangeStart(activeRange);
  return allNotes.filter((note) => {
    if (query && !note.content.toLowerCase().includes(query)) return false;
    if (from !== -Infinity) {
      const t = new Date(note.time).getTime();
      if (Number.isNaN(t) || t < from) return false;
    }
    return true;
  });
}

searchEl.addEventListener("input", () => {
  if (selectMode) clearSelection();
  render(filterNotes());
});

filterChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    if (activeRange === chip.dataset.range) return;
    activeRange = chip.dataset.range;
    filterChips.forEach((c) => c.classList.toggle("is-active", c === chip));
    if (selectMode) clearSelection();
    render(filterNotes());
  });
});

/* ---------- 多选模式 ---------- */

function updateSelectBar() {
  const n = selected.size;
  selectCount.textContent = `已选 ${n} 条`;
  selectCopy.disabled = n === 0;
  selectExport.disabled = n === 0;
  selectDelete.disabled = n === 0;
}

function clearSelection() {
  selected.clear();
  updateSelectBar();
}

function setSelectMode(on) {
  selectMode = on;
  clearSelection();
  selectBtn.textContent = on ? "完成" : "选择";
  selectBtn.classList.toggle("is-active", on);
  cardEl.classList.toggle("selecting", on);
  selectBar.classList.toggle("hidden", !on);
  render(filterNotes());
}

function toggleSelected(note, item) {
  const key = noteKey(note);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  const isSelected = selected.has(key);
  item.classList.toggle("is-selected", isSelected);
  item.querySelector(".select-box")?.classList.toggle("is-checked", isSelected);
  updateSelectBar();
}

selectBtn.addEventListener("click", () => setSelectMode(!selectMode));
selectCancel.addEventListener("click", () => setSelectMode(false));

/* ---------- 批量复制 / 导出 / 删除 ---------- */

selectCopy.addEventListener("click", async () => {
  const notes = selectedNotes();
  if (!notes.length) return;
  // 原始正文按列表顺序（最新在前）拼接，不加时间戳与渲染标记
  const ok = await copyText(notes.map((note) => note.content).join("\n\n"));
  showToast(ok ? `已复制 ${notes.length} 条` : "复制失败");
});

selectExport.addEventListener("click", exportSelected);

selectDelete.addEventListener("click", async () => {
  const count = selected.size;
  if (!count) return;
  const ok = await askConfirm({
    title: `删除选中的 ${count} 条速记？`,
    desc: `删除后会移入回收站，${retentionDays} 天内可随时恢复。`,
    okText: "移入回收站",
  });
  if (ok) deleteSelected();
});

async function exportSelected() {
  const notes = selectedNotes();
  if (!notes.length) return;

  showToast("正在生成图片…");
  let dataUrl;
  try {
    dataUrl = drawExportImage(notes, RANGE_LABELS[activeRange]).toDataURL("image/png");
  } catch (err) {
    showToast(`生成图片失败：${err.message || err}`);
    return;
  }

  try {
    const path = await invoke("save_image", {
      data: Array.from(dataUrlToBytes(dataUrl)),
      defaultName: exportFileName(),
    });
    showToast(path ? `已保存到 ${path}` : "已取消导出");
  } catch (err) {
    showToast(`保存失败：${err}`);
  }
}

async function deleteSelected() {
  const notes = selectedNotes();
  if (!notes.length) return;
  // 行号从大到小删除，后续删除不会让前面的行号偏移
  const ordered = [...notes].sort((a, b) => b.line - a.line);
  let ok = 0;
  let fail = 0;
  for (const note of ordered) {
    try {
      await invoke("delete_note", { line: note.line, expectedTime: note.time });
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  setSelectMode(false);
  await load();
  showToast(fail ? `已移入回收站 ${ok} 条，${fail} 条失败` : `已移入回收站 ${ok} 条`);
}

/* ---------- 回收站 ---------- */

function expiresLabel(entry) {
  const days = daysLeft(entry.expires_at);
  if (days === null) return "";
  return days > 0 ? `${days} 天后彻底删除` : "即将彻底删除";
}

async function restoreEntry(entry) {
  try {
    await invoke("restore_trash_note", {
      line: entry.line,
      expectedDeletedAt: entry.deleted_at,
    });
    await load();
    showToast("已恢复");
  } catch (err) {
    showToast(`恢复失败：${err}`);
    await load();
  }
}

async function purgeEntry(entry) {
  const ok = await askConfirm({
    title: "彻底删除这条速记？",
    desc: "彻底删除后无法恢复。",
    okText: "彻底删除",
  });
  if (!ok) return;
  try {
    await invoke("purge_trash_note", {
      line: entry.line,
      expectedDeletedAt: entry.deleted_at,
    });
    await load();
    showToast("已彻底删除");
  } catch (err) {
    showToast(`删除失败：${err}`);
    await load();
  }
}

function renderTrash() {
  listEl.innerHTML = "";
  countEl.textContent = trashEntries.length ? `${trashEntries.length} 条` : "";
  emptyEl.classList.toggle("hidden", trashEntries.length > 0);
  if (!trashEntries.length) {
    emptyTextEl.innerHTML = `回收站是空的<br /><span class="dim">删除的速记会在这里保留 ${retentionDays} 天</span>`;
  }

  for (const entry of trashEntries) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="history-item-head">
        <span class="history-item-time">${escapeHtml(formatTime(entry.deleted_at))} 删除</span>
        <span class="trash-expire">${expiresLabel(entry)}</span>
        <div class="history-item-actions">
          <button class="icon-btn act-restore" title="恢复" aria-label="恢复" tabindex="-1">${ICON_RESTORE}</button>
          <button class="icon-btn act-purge" title="彻底删除" aria-label="彻底删除" tabindex="-1">${ICON_DELETE}</button>
        </div>
      </div>
      <div class="history-item-content">${renderOutline(entry.content)}</div>`;
    item.querySelector(".act-restore").addEventListener("click", () => restoreEntry(entry));
    item.querySelector(".act-purge").addEventListener("click", () => purgeEntry(entry));
    listEl.appendChild(item);
  }
}

function setView(next) {
  if (view === next) return;
  view = next;
  if (selectMode) setSelectMode(false);
  const isTrash = view === "trash";
  historyTitle.textContent = isTrash ? "回收站" : "历史记录";
  trashBtn.textContent = isTrash ? "返回" : "回收站";
  searchWrap.classList.toggle("hidden", isTrash);
  filtersEl.classList.toggle("hidden", isTrash);
  selectBtn.classList.toggle("hidden", isTrash);
  trashBar.classList.toggle("hidden", !isTrash);
  cardEl.classList.toggle("trash-mode", isTrash);
  if (isTrash) renderTrash();
  else render(filterNotes());
}

trashBtn.addEventListener("click", () => setView(view === "trash" ? "notes" : "trash"));

trashEmpty.addEventListener("click", async () => {
  if (!trashEntries.length) {
    showToast("回收站已是空的");
    return;
  }
  const ok = await askConfirm({
    title: "清空回收站？",
    desc: `回收站中的 ${trashEntries.length} 条速记将被彻底删除，无法恢复。`,
    okText: "清空",
  });
  if (!ok) return;
  try {
    await invoke("empty_trash");
    await load();
    showToast("回收站已清空");
  } catch (err) {
    showToast(`清空失败：${err}`);
  }
});

async function load() {
  // 编辑态下窗口聚焦等事件可能触发刷新，避免覆盖正在编辑的内容
  if (editingNote) return;
  try {
    const [notes, trash] = await Promise.all([invoke("list_notes"), invoke("list_trash")]);
    allNotes = notes;
    trashEntries = trash.entries;
    retentionDays = trash.retention_days;
    trashHint.textContent = `回收站保留 ${retentionDays} 天`;

    // 记录被外部改动后，剔除已不存在的选择项
    const validKeys = new Set(allNotes.map(noteKey));
    for (const key of selected) {
      if (!validKeys.has(key)) selected.delete(key);
    }
    updateSelectBar();
    if (view === "trash") renderTrash();
    else render(filterNotes());
    highlightLatest(takeLastSavedAt());
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
  if (event.key !== "Escape") return;
  // 确认弹窗打开时，Esc 只关闭弹窗
  if (!confirmView.classList.contains("hidden")) {
    closeConfirm(false);
    return;
  }
  // 多选模式下 Esc 先退出选择，避免误关窗口丢失已选内容
  if (selectMode) {
    setSelectMode(false);
    return;
  }
  hideWindow();
});

// 编辑态的 CodeMirror 实例：列表标记实时渲染为圆点，复用与速记一致的快捷键。
// Esc 在编辑态下由 domEventHandlers 拦截并阻止冒泡，避免误触关闭整个历史窗口。
editEditor = createEditor({
  parent: editText,
  placeholder: "记点什么…",
  onDocChange: () => updateEditCount(),
  commands: {
    ...listKeyCommands,
    ...saveCommands(saveEdit),
  },
  extensions: [
    EditorView.domEventHandlers({
      keydown(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          exitEdit();
          return true;
        }
        return false;
      },
    }),
  ],
});

// 主题切换：重配编辑态编辑器，不重建文档
window.addEventListener("spark:theme", (event) => {
  setEditorTheme(editEditor, event.detail.isDark);
});

initTheme();
