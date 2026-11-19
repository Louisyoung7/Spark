import { BULLET_RE, ORDERED_RE, indentDepth } from "../markdown/syntax.js";
import { formatFullTime, pad2 } from "./format.js";

// 导出图片：Canvas 2D 直接绘制。
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

/**
 * 绘制导出图并返回 canvas。
 * rangeLabel 由调用方按当前筛选范围传入，避免导出模块依赖页面状态。
 */
export function drawExportImage(notes, rangeLabel) {
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
  ctx.fillText(`${rangeLabel} · ${notes.length} 条`, EXPORT_W - EXPORT_PAD, y + 12);
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

export function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(",")[1] || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function exportFileName() {
  const d = new Date();
  return `spark-notes-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
}
