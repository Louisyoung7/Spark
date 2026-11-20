// 历史列表与导出图片共用的时间/键工具。纯函数，不碰 DOM，便于单测。

export const pad2 = (n) => String(n).padStart(2, "0");

// RFC3339 → "MM-DD HH:mm"（本地时区）
export function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 导出图片用完整日期，脱离列表上下文也能看清年月日
export function formatFullTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 时间筛选起点：以本地自然日 00:00 为界
export function rangeStart(range) {
  if (range === "all") return -Infinity;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return start.getTime();
}

// 选择状态用「行号 + 时间」标识，重新加载后行号变动也能对齐
export function noteKey(note) {
  return `${note.line}:${note.time}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 回收站剩余天数：向上取整，已过期返回 0，时间非法返回 null
export function daysLeft(expiresAt, now = Date.now()) {
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}
