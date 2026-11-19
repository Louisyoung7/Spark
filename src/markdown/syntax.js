// 速记只需要「层级」：无序 / 有序列表由行首缩进表达嵌套，
// 编辑器装饰与历史预览共用同一套判定，避免两边正则漂移。
//
// 标题、引用、围栏代码块、分割线、行内格式等 Markdown 语法一律按普通文本处理。

/** 无序列表：标记后必须跟空白才视为列表项 */
export const BULLET_RE = /^([ \t]*)([-*+])(\s+)(.*)$/;
/** 有序列表：1. / 1) */
export const ORDERED_RE = /^([ \t]*)(\d{1,9})([.)])(\s+)(.*)$/;

/**
 * 匹配已去掉行首缩进的无序列表项。
 *
 * 与 BULLET_RE 的区别：允许「-」单独出现，也允许标记后无内容，
 * 供编辑器判断空列表项与取消列表使用。
 * 返回 marker、标记（含其后空白）长度与内容；不是列表项时返回 null。
 */
export function matchBullet(rest) {
  const m = /^([-*+])([ \t]+|$)/.exec(rest);
  if (!m) return null;
  const markerLength = m[0].length;
  return {
    marker: m[1],
    markerLength,
    content: rest.slice(markerLength),
  };
}

/**
 * 匹配已去掉行首缩进的有序列表项，规则与 ORDERED_RE 一致：
 * 分隔符必须是 . 或 )，其后必须有空白。
 */
export function matchOrdered(rest) {
  const m = /^(\d{1,9})([.)])([ \t]+)/.exec(rest);
  if (!m) return null;
  const markerLength = m[0].length;
  return {
    number: Number(m[1]),
    delimiter: m[2],
    markerLength,
    content: rest.slice(markerLength),
  };
}

/**
 * 回车续行策略。编辑器与测试共用同一判定。
 * - continue：列表项有内容，下一行补同样的标记（有序自动 +1）
 * - exit：空列表项，退出列表
 * - plain：普通行
 */
export function planEnter(rest) {
  const bullet = matchBullet(rest);
  if (bullet) {
    if (bullet.content.trim() === "") return { kind: "exit" };
    return { kind: "continue", prefix: `${bullet.marker} ` };
  }

  const ordered = matchOrdered(rest);
  if (ordered) {
    if (ordered.content.trim() === "") return { kind: "exit" };
    return { kind: "continue", prefix: `${ordered.number + 1}${ordered.delimiter} ` };
  }

  return { kind: "plain" };
}

/** 行首缩进折算成层级：Tab 算一级，两个空格算一级 */
export function indentDepth(ws) {
  let tabs = 0;
  let spaces = 0;
  for (const ch of ws) {
    if (ch === "\t") tabs++;
    else spaces++;
  }
  return tabs + Math.floor(spaces / 2);
}
