// Markdown 轻量语法规则：编辑器装饰与历史预览共用同一套判定，
// 避免两边各写一份正则后逐渐漂移。
//
// 只覆盖速记常用的块级结构；行内格式（粗体/斜体/行内代码/链接）由
// CodeMirror 的语法树与历史预览各自渲染，但共用同一份文本规则。

/** 无序列表：标记后必须跟空白才视为列表项 */
export const BULLET_RE = /^([ \t]*)([-*+])(\s+)(.*)$/;
/** 有序列表：1. / 1) */
export const ORDERED_RE = /^([ \t]*)(\d{1,9})([.)])(\s+)(.*)$/;
/** ATX 标题：# ~ ###### */
export const HEADING_RE = /^([ \t]*)(#{1,6})(\s+)(.*)$/;
/** 引用：> 开头（可无空格） */
export const QUOTE_RE = /^([ \t]*)(>\s?)(.*)$/;
/** 围栏代码块：``` 或 ~~~ */
export const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
/** 分割线：三个及以上的 - / * / _ */
export const HR_RE = /^([ \t]*)([-*_])(?:[ \t]*\2){2,}[ \t]*$/;

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
