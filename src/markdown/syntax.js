// 速记只需要「层级」：无序 / 有序列表由行首缩进表达嵌套，
// 编辑器装饰与历史预览共用同一套判定，避免两边正则漂移。
//
// 标题、引用、围栏代码块、分割线、行内格式等 Markdown 语法一律按普通文本处理。

/** 无序列表：标记后必须跟空白才视为列表项 */
export const BULLET_RE = /^([ \t]*)([-*+])(\s+)(.*)$/;
/** 有序列表：1. / 1) */
export const ORDERED_RE = /^([ \t]*)(\d{1,9})([.)])(\s+)(.*)$/;

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
