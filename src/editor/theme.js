import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// 与设计令牌对齐的 CodeMirror 主题。
// 纯文本存储，仅控制编辑器视觉；颜色统一走 styles.css 的 CSS 变量，
// 后续调整配色只需要改令牌。
const MONO =
  '"JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace';

export const sparkTheme = [
  EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "transparent",
        color: "var(--text)",
        fontSize: "var(--font-body)",
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "var(--lh-body)",
        overflow: "auto",
      },
      // 宽松留白：正文四周留出呼吸空间
      ".cm-content": {
        padding: "20px 22px",
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
      // 多行占位符脱离文档流，用 inset 对齐内容区，不再依赖硬编码 top/left
      ".cm-placeholder-multiline": {
        position: "absolute",
        inset: "0",
        padding: "20px 22px",
        pointerEvents: "none",
        whiteSpace: "pre",
      },

      // ---------- 块级结构 ----------

      // 标题行：上下留白形成段落节奏
      ".cm-heading-line": {
        paddingTop: "10px",
        paddingBottom: "2px",
      },
      // 引用：3px 左侧强调条 + 极淡背景
      ".cm-quote-line": {
        borderLeft: "3px solid var(--accent)",
        paddingLeft: "10px",
        backgroundColor: "var(--quote-bg)",
        borderRadius: "0 var(--radius-xs) var(--radius-xs) 0",
        color: "var(--text-secondary)",
      },
      // 围栏代码块：整行底色 + 等宽字体
      ".cm-code-line": {
        backgroundColor: "var(--surface)",
        fontFamily: MONO,
        fontSize: "13px",
      },
      // 首尾行圆角，让整行底色读作一个代码块
      ".cm-code-first": {
        borderTopLeftRadius: "var(--radius-sm)",
        borderTopRightRadius: "var(--radius-sm)",
        paddingTop: "4px",
      },
      ".cm-code-last": {
        borderBottomLeftRadius: "var(--radius-sm)",
        borderBottomRightRadius: "var(--radius-sm)",
        paddingBottom: "4px",
      },
      // 代码块内部的行内 token 不参与胶囊样式（覆盖语法高亮自带的底色/内边距）
      ".cm-code-line span": {
        backgroundColor: "transparent",
        borderRadius: "0",
        padding: "0",
        fontSize: "inherit",
        color: "var(--text-secondary)",
      },
      // 分割线：弱化字符，并用删除线把零散的 - 连成一条细线
      ".cm-hr-line": {
        color: "var(--text-faint)",
        textDecoration: "line-through",
        textDecorationColor: "var(--border-strong)",
      },

      // ---------- 列表 ----------

      // 列表圆点：输入「- / * / + 」后实时绘制，按层级换色
      ".cm-bullet": {
        color: "var(--bullet-1)",
        display: "inline-block",
        paddingRight: "0.4em",
      },
      ".cm-bullet-1": { color: "var(--bullet-1)" },
      ".cm-bullet-2": { color: "var(--bullet-2)" },
      ".cm-bullet-3": { color: "var(--bullet-3)" },
      // 有序列表序号
      ".cm-list-marker": {
        color: "var(--bullet-1)",
        fontWeight: "600",
      },
    },
    { dark: true }
  ),

  // 语法高亮：标题只调字号/字重，不改颜色，让 # 等标记保持弱化
  syntaxHighlighting(
    HighlightStyle.define(
      [
        { tag: t.heading1, fontSize: "20px", fontWeight: "600", lineHeight: "1.4" },
        { tag: t.heading2, fontSize: "18px", fontWeight: "600", lineHeight: "1.4" },
        { tag: t.heading3, fontSize: "16px", fontWeight: "600", lineHeight: "1.45" },
        { tag: t.heading4, fontSize: "15px", fontWeight: "600" },
        { tag: t.heading5, fontSize: "15px", fontWeight: "600" },
        { tag: t.heading6, fontSize: "15px", fontWeight: "600" },
        { tag: t.strong, fontWeight: "600" },
        { tag: t.emphasis, fontStyle: "italic" },
        {
          tag: t.strikethrough,
          textDecoration: "line-through",
          color: "var(--text-muted)",
        },
        // 行内代码胶囊；代码块内部由 .cm-code-line span 覆盖回纯文本样式
        {
          tag: t.monospace,
          fontFamily: MONO,
          fontSize: "0.9em",
          color: "var(--code)",
          backgroundColor: "var(--surface-strong)",
          borderRadius: "var(--radius-xs)",
          padding: "1px 5px",
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
