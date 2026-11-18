import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// 与设计令牌对齐的 CodeMirror 主题。
// 纯文本存储，仅控制编辑器视觉；颜色统一走 styles.css 的 CSS 变量，
// 后续调整配色只需要改令牌。
export const sparkTheme = [
  EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--text)",
        fontSize: "15px",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.7",
        overflow: "auto",
      },
      ".cm-content": {
        padding: "14px 16px",
        caretColor: "var(--text)",
        tabSize: "4",
        position: "relative",
      },
      ".cm-line": {
        padding: "0",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--text)",
        // CM6 默认光标高度为整行行高，空文档时空行光标会显得异常粗大；
        // 用 !important 覆盖 JS 写入的 inline 高度，使其接近文字高度。
        height: "1.2em !important",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--surface-strong)",
      },
      ".cm-placeholder": {
        color: "var(--text-muted)",
      },
      ".cm-placeholder-multiline": {
        position: "absolute",
        top: "14px",
        left: "16px",
        right: "16px",
        pointerEvents: "none",
        whiteSpace: "pre",
      },

      // ---------- 块级结构 ----------

      // 引用：左侧竖线 + 次要色，标记本身仍由语法高亮弱化
      ".cm-quote-line": {
        borderLeft: "2px solid var(--border-strong)",
        paddingLeft: "10px",
        color: "var(--text-secondary)",
      },
      // 围栏代码块：整行底色 + 等宽字体
      ".cm-code-line": {
        backgroundColor: "var(--surface)",
        fontFamily:
          '"JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace',
        fontSize: "13px",
      },
      // 分割线：弱化字符，并用删除线把零散的 - 连成一条细线
      ".cm-hr-line": {
        color: "var(--text-faint)",
        textDecoration: "line-through",
        textDecorationColor: "var(--border-strong)",
      },

      // ---------- 列表 ----------

      // 列表圆点：输入「- / * / + 」后实时绘制，层级越深越淡
      ".cm-bullet": {
        color: "var(--accent)",
        display: "inline-block",
        paddingRight: "0.4em",
      },
      ".cm-bullet-1": { opacity: "0.8" },
      ".cm-bullet-2": { opacity: "0.65" },
      ".cm-bullet-3": { opacity: "0.5" },
      // 有序列表序号
      ".cm-list-marker": {
        color: "var(--accent)",
        fontWeight: "600",
      },
    },
    { dark: true }
  ),

  // 语法高亮：标题只调字号/字重，不改颜色，让 # 等标记保持弱化
  syntaxHighlighting(
    HighlightStyle.define(
      [
        { tag: t.heading1, fontSize: "20px", fontWeight: "600", lineHeight: "1.45" },
        { tag: t.heading2, fontSize: "18px", fontWeight: "600", lineHeight: "1.45" },
        { tag: t.heading3, fontSize: "16px", fontWeight: "600", lineHeight: "1.5" },
        { tag: t.heading4, fontSize: "15px", fontWeight: "600" },
        { tag: t.heading5, fontWeight: "600" },
        { tag: t.heading6, fontWeight: "600" },
        { tag: t.strong, fontWeight: "600" },
        { tag: t.emphasis, fontStyle: "italic" },
        {
          tag: t.strikethrough,
          textDecoration: "line-through",
          color: "var(--text-muted)",
        },
        {
          tag: t.monospace,
          fontFamily:
            '"JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace',
          fontSize: "0.9em",
          color: "var(--code)",
        },
        { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
        { tag: t.url, color: "var(--text-muted)" },
        // 所有语法标记（#、**、反引号、>、-）统一弱化
        { tag: t.processingInstruction, color: "var(--text-faint)" },
        { tag: t.contentSeparator, color: "var(--text-faint)" },
        { tag: t.quote, color: "var(--text-secondary)" },
      ],
      { themeType: "dark" }
    )
  ),
];
