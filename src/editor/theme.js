import { EditorView } from "@codemirror/view";

// 与现有 Catppuccin Mocha 深色极简风格对齐的 CodeMirror 主题。
// 纯文本存储，仅控制编辑器视觉：透明背景、15px 正文、1.7 行高、14/16px 内边距。
export const sparkTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "#cdd6f4",
      fontSize: "15px",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.7",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "14px 16px",
      caretColor: "#cdd6f4",
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
      borderLeftColor: "#cdd6f4",
      // CM6 默认光标高度为整行行高，空文档时空行光标会显得异常粗大；
      // 用 !important 覆盖 JS 写入的 inline 高度，使其接近文字高度。
      height: "1.2em !important",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "#45475a",
    },
    ".cm-placeholder": {
      color: "#6c7086",
    },
    ".cm-placeholder-multiline": {
      position: "absolute",
      top: "14px",
      left: "16px",
      right: "16px",
      pointerEvents: "none",
      whiteSpace: "pre",
    },
    // 列表圆点：输入「- / * / + 」后实时绘制为蓝色圆点
    ".cm-bullet": {
      color: "#89b4fa",
      display: "inline-block",
      paddingRight: "0.4em",
    },
  },
  { dark: true }
);
