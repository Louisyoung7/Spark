import { EditorView } from "@codemirror/view";

// 与设计令牌对齐的 CodeMirror 主题。
// 只负责编辑器整体视觉与列表层级样式，正文其余部分保持纯文本。
// 颜色统一走 styles.css 的 CSS 变量，后续调整配色只需要改令牌。

// 预构建两份主题并缓存，避免每次切换都生成新的 StyleModule
const themeCache = new Map();

export function sparkTheme(isDark) {
  const key = isDark ? "dark" : "light";
  if (!themeCache.has(key)) themeCache.set(key, buildTheme(isDark));
  return themeCache.get(key);
}

function buildTheme(isDark) {
  return EditorView.theme(
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

      // ---------- 列表 ----------

      // 列表圆点：用 CSS 绘制的小圆点，避免字体符号的高低与大小不一致；
      // 层级只靠缩进表达，不再用颜色区分
      ".cm-bullet": {
        display: "inline-block",
        width: "0.34em",
        height: "0.34em",
        marginRight: "0.3em",
        borderRadius: "50%",
        backgroundColor: "var(--text-muted)",
        verticalAlign: "middle",
      },
      // 有序列表序号：弱化颜色，数字等宽避免换行时跳动
      ".cm-list-marker": {
        color: "var(--text-muted)",
        fontVariantNumeric: "tabular-nums",
      },
      // 悬挂缩进：换行后的文字与列表内容对齐，标记悬挂在左侧
      ".cm-list-line": {
        paddingLeft: "var(--spark-hang, 0)",
        textIndent: "calc(-1 * var(--spark-hang, 0))",
      },
    },
    { dark: isDark }
  );
}
