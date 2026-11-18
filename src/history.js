import {
  createEditor,
  indentSelection,
  enterWithIndent,
  EditorView,
  setEditorTheme,
} from "./editor/index.js";
import { escapeHtml, renderOutline } from "./markdown/renderHtml.js";
import { BULLET_RE, ORDERED_RE, indentDepth } from "./markdown/syntax.js";
import { initTheme } from "./theme.js";

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

const pad2 = (n) => String(n).padStart(2, "0");
const RANGE_LABELS = { all: "全部", today: "今天", "7d": "近7天", "30d": "近30天" };

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

// 导出图片用完整日期，脱离列表上下文也能看清年月日
function formatFullTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 时间筛选起点：以本地自然日 00:00 为界
function rangeStart(range) {
  if (range === "all") return -Infinity;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return start.getTime();
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

// 行内操作图标：继承按钮文字色，随悬停态变化
const ICON_COPY = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/><path d="M10.5 4.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h1.5"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L5 13H3v-2z"/></svg>`;
const ICON_DELETE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11"/><path d="M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5"/><path d="M4 4.5l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8"/><path d="M6.5 7v4M9.5 7v4"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>`;

const LAST_SAVED_KEY = "spark:last-saved-at";
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
      try {
        await invoke("delete_note", { line: note.line, expectedTime: note.time });
        await load();
        showToast("已删除");
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

// 选择状态用「行号 + 时间」标识，重新加载后行号变动也能对齐
const selected = new Set();
let selectMode = false;
let deleteArmed = false;
let deleteArmTimer = null;
let activeRange = "all";

function noteKey(note) {
  return `${note.line}:${note.time}`;
}

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

function resetDeleteArm() {
  deleteArmed = false;
  clearTimeout(deleteArmTimer);
  selectDelete.textContent = "删除";
  selectDelete.classList.remove("is-armed");
}

function clearSelection() {
  selected.clear();
  resetDeleteArm();
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
  resetDeleteArm();
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

selectDelete.addEventListener("click", () => {
  if (!selected.size) return;
  if (!deleteArmed) {
    deleteArmed = true;
    selectDelete.textContent = "确认删除";
    selectDelete.classList.add("is-armed");
    deleteArmTimer = setTimeout(resetDeleteArm, 3000);
    return;
  }
  resetDeleteArm();
  deleteSelected();
});

async function exportSelected() {
  const notes = selectedNotes();
  if (!notes.length) return;

  showToast("正在生成图片…");
  let dataUrl;
  try {
    dataUrl = drawExportImage(notes).toDataURL("image/png");
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

/* ---------- 导出图片：Canvas 2D 直接绘制 ---------- */
// WebKitGTK 对 SVG foreignObject 截图支持不稳定，会得到空白图，
// 因此不依赖 DOM 截图，按与历史列表一致的排版规则手工绘制。

const EXPORT_W = 640;
const EXPORT_PAD = 32;
const CARD_PAD_X = 16;
const CARD_PAD_Y = 14;
const CONTENT_W = EXPORT_W - EXPORT_PAD * 2 - CARD_PAD_X * 2;
const LINE_H = 24;
const NOTE_GAP = 10;
const LIST_INDENT = 16;
const MARKER_W = 22;

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// 按可用宽度折行：中文按字符断，西文尽量在空格处断
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let current = "";
  for (const ch of text) {
    if (current && ctx.measureText(current + ch).width > maxWidth) {
      const cut = current.lastIndexOf(" ");
      if (cut > 0 && ch !== " ") {
        lines.push(current.slice(0, cut));
        current = `${current.slice(cut + 1)}${ch}`;
      } else {
        lines.push(current);
        current = ch;
      }
    } else {
      current += ch;
    }
  }
  lines.push(current);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 把一条记录拆成可绘制的行：段落行 + 列表行（含缩进与序号）
function layoutNoteRows(ctx, content) {
  const rows = [];
  const counters = new Map();
  for (const raw of content.split("\n")) {
    if (raw.trim() === "") {
      if (rows.length) rows.push({ gap: 6 });
      counters.clear();
      continue;
    }

    const bullet = raw.match(BULLET_RE);
    const ordered = raw.match(ORDERED_RE);
    if (!bullet && !ordered) {
      for (const line of wrapText(ctx, raw, CONTENT_W)) {
        rows.push({ x: CARD_PAD_X, textX: CARD_PAD_X, text: line });
      }
      continue;
    }

    const depth = indentDepth((bullet || ordered)[1]);
    for (const key of [...counters.keys()]) {
      if (key > depth) counters.delete(key);
    }

    let marker;
    if (bullet) {
      marker = "•";
      counters.delete(depth);
    } else {
      const next = counters.has(depth) ? counters.get(depth) + 1 : Number(ordered[2]) || 1;
      counters.set(depth, next);
      marker = `${next}.`;
    }

    const x = CARD_PAD_X + depth * LIST_INDENT;
    const textX = x + MARKER_W;
    const text = (bullet ? bullet[4] : ordered[5]).trim();
    const wrapped = wrapText(ctx, text, CONTENT_W - depth * LIST_INDENT - MARKER_W);
    wrapped.forEach((line, index) => {
      rows.push({ marker: index === 0 ? marker : "", x, textX, text: line });
    });
  }
  // 末尾空行不留多余间距
  while (rows.length && rows[rows.length - 1].gap) rows.pop();
  return rows;
}

function measureFont(family) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `14px ${family}`;
  return ctx;
}

function drawExportImage(notes) {
  const colors = {
    bg: cssVar("--bg", "#1e1e2e"),
    surface: cssVar("--surface", "#313244"),
    border: cssVar("--border", "#45475a"),
    text: cssVar("--text", "#cdd6f4"),
    muted: cssVar("--text-muted", "#6c7086"),
  };
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  const measureCtx = measureFont(family);

  // 先算高度，再创建画布
  const cards = [];
  let height = EXPORT_PAD + 24 + 20;
  notes.forEach((note, index) => {
    const rows = layoutNoteRows(measureCtx, note.content);
    const contentH = rows.reduce((sum, row) => sum + (row.gap || LINE_H), 0);
    const cardH = CARD_PAD_Y * 2 + 14 + 6 + contentH;
    cards.push({ note, rows, height: cardH });
    height += cardH;
    if (index < notes.length - 1) height += NOTE_GAP;
  });
  height += EXPORT_PAD;

  if (height > 20000) {
    throw new Error("所选记录过多，请减少数量后重试");
  }

  // 超长图降为 1x，避免触发 WebView 的画布尺寸限制
  const scale = height > 8000 ? 1 : 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(EXPORT_W * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, EXPORT_W, height);

  // 标题行
  let y = EXPORT_PAD;
  ctx.font = `700 20px ${family}`;
  ctx.fillStyle = colors.text;
  ctx.fillText("Spark", EXPORT_PAD, y + 12);
  ctx.font = `12px ${family}`;
  ctx.fillStyle = colors.muted;
  ctx.textAlign = "right";
  ctx.fillText(
    `${RANGE_LABELS[activeRange]} · ${notes.length} 条`,
    EXPORT_W - EXPORT_PAD,
    y + 12
  );
  ctx.textAlign = "left";
  y += 24 + 20;

  for (const card of cards) {
    roundRect(ctx, EXPORT_PAD, y, EXPORT_W - EXPORT_PAD * 2, card.height, 8);
    ctx.fillStyle = colors.surface;
    ctx.fill();
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = `11px ${family}`;
    ctx.fillStyle = colors.muted;
    ctx.fillText(formatFullTime(card.note.time), EXPORT_PAD + CARD_PAD_X, y + CARD_PAD_Y + 7);

    let rowY = y + CARD_PAD_Y + 14 + 6;
    ctx.font = `14px ${family}`;
    for (const row of card.rows) {
      if (row.gap) {
        rowY += row.gap;
        continue;
      }
      // row.x / row.textX 是相对卡片内容区的坐标，绘制时补上画布外边距
      if (row.marker) {
        ctx.fillStyle = colors.muted;
        ctx.textAlign = "right";
        ctx.fillText(row.marker, EXPORT_PAD + row.x + MARKER_W - 6, rowY + LINE_H / 2);
        ctx.textAlign = "left";
      }
      ctx.fillStyle = colors.text;
      ctx.fillText(row.text, EXPORT_PAD + row.textX, rowY + LINE_H / 2);
      rowY += LINE_H;
    }

    y += card.height + NOTE_GAP;
  }

  return canvas;
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(",")[1] || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function exportFileName() {
  const d = new Date();
  return `spark-notes-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
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
  showToast(fail ? `已删除 ${ok} 条，${fail} 条失败` : `已删除 ${ok} 条`);
}

async function load() {
  // 编辑态下窗口聚焦等事件可能触发刷新，避免覆盖正在编辑的内容
  if (editingNote) return;
  try {
    allNotes = await invoke("list_notes");
    // 记录被外部改动后，剔除已不存在的选择项
    const validKeys = new Set(allNotes.map(noteKey));
    for (const key of selected) {
      if (!validKeys.has(key)) selected.delete(key);
    }
    updateSelectBar();
    render(filterNotes());
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
    Tab: (v) => {
      indentSelection(v, 1);
      return true;
    },
    "Shift-Tab": (v) => {
      indentSelection(v, -1);
      return true;
    },
    Enter: (v) => {
      enterWithIndent(v);
      return true;
    },
    "Ctrl-Enter": () => {
      saveEdit();
      return true;
    },
    "Mod-Enter": () => {
      saveEdit();
      return true;
    },
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
