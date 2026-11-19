import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { markdownView } from "./markdownView.js";
import { indentDepth, matchBullet, planEnter } from "../markdown/syntax.js";
import { sparkTheme } from "./theme.js";

export { EditorView };

// 主题是可动态重配的 compartment：切换时只替换主题扩展，文档与撤销历史保持不变
const themeCompartment = new Compartment();

function currentIsDark() {
  return document.documentElement.dataset.theme !== "light";
}

export function setEditorTheme(view, isDark) {
  view.dispatch({
    effects: themeCompartment.reconfigure(sparkTheme(isDark)),
  });
}

// 行首缩进的唯一换算规则在 syntax.js：Tab 算一级、两个空格算一级。
// 编辑器与历史预览都用它，避免「\t  」这类混合缩进在两边被数成不同层级。
function splitIndent(line) {
  const m = line.match(/^([ \t]*)/);
  const ws = m ? m[1] : "";
  return [ws, line.slice(ws.length)];
}

// 幕布式缩进：对光标所在（或选中多行）每行行首操作。
// - Tab（dir>0）：行首加一个 Tab（层级 +1）。
// - Shift+Tab（dir<0）：只退一级——有 Tab 删一个 Tab；纯空格按层级折算（每级 2 空格）；
//   已无缩进但本行是列表项，则删除 marker 取消列表。
// 只做「行首插入 / 删除」的最小改动并手动映射选区。
// 若改成整行替换，CodeMirror 会把光标映射到替换区起点，导致按完 Tab 继续打字时
// 字符都插在行首（看起来像新字符把旧内容往后推），这里必须避免。
export function indentSelection(view, dir) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  const lines = state.sliceDoc(lineFrom, lineTo).split("\n");
  const ops = [];
  let base = lineFrom;
  for (const line of lines) {
    const [ws, rest] = splitIndent(line);
    if (dir > 0) {
      ops.push({ from: base, to: base, insert: "\t" });
    } else if (ws.includes("\t")) {
      const at = base + ws.indexOf("\t");
      ops.push({ from: at, to: at + 1, insert: "" });
    } else if (ws) {
      // 纯空格缩进：按层级折算回 2 空格一档，避免「退一层」后残留半档空格
      const next = "  ".repeat(Math.max(0, indentDepth(ws) - 1));
      ops.push({ from: base, to: base + ws.length, insert: next });
    } else {
      // 已无缩进：若是列表项则取消 marker（「- 」→ 普通文本）
      const bullet = matchBullet(rest);
      if (bullet) ops.push({ from: base, to: base + bullet.markerLength, insert: "" });
    }
    base += line.length + 1;
  }
  if (!ops.length) return; // 无变化，避免无意义 dispatch

  const changes = state.changes(ops);
  // assoc=1：光标正好落在插入点（如空行行首）时移到缩进之后，而不是停在缩进前
  const selection = state.selection.map(changes, 1);
  view.dispatch({ changes, selection });
  view.focus();
}

// 回车继承缩进（幕布式手感）：
// - 有内容的列表项 → 续行并自动补「marker 」（有序列表自动续号）；
// - 空列表项（仅「- 」或「1. 」无内容）→ 退出列表层级（删除 marker）；
// - 普通行 → 仅继承行首缩进；空行 → 退一级。
export function enterWithIndent(view) {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const full = line.text;
  // 续行沿用本行原始缩进（不做归一化）：新行与当前行层级、视觉宽度都完全一致，
  // 「\t  」这类混合缩进也能正确识别为列表项。
  const [indent, rest] = splitIndent(full);
  const plan = planEnter(rest);

  if (plan.kind === "exit") {
    // 空列表项：删除整行内容（含标记），退出当前列表层级
    const from = line.from + indent.length;
    view.dispatch({
      changes: { from, to: line.to, insert: "" },
      selection: { anchor: from },
    });
    view.focus();
    return;
  }

  if (plan.kind === "continue") {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "\n" + indent + plan.prefix },
      selection: { anchor: sel.from + 1 + indent.length + plan.prefix.length },
    });
    view.focus();
    return;
  }

  if (rest.trim() === "") {
    view.dispatch({
      changes: { from: line.from, to: sel.to, insert: "\n" },
      selection: { anchor: line.from + 1 },
    });
  } else {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "\n" + indent },
      selection: { anchor: sel.from + 1 + indent.length },
    });
  }
  view.focus();
}

export function getDoc(view) {
  return view.state.doc.toString();
}

export function setDoc(view, text) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

// 自定义快捷键命令：键名遵循 CodeMirror keymap（如 "Tab"、"Ctrl-Enter"）
// 额外扩展（如 EditorView.domEventHandlers 处理 Esc 冒泡等）
// 多行占位符：CM6 的 placeholder 内联渲染在首行，含 "\n" 会撑高行块，
// 导致空文档时光标等于整块高度。改为脱离文档流的绝对定位浮层。
function makePlaceholder(text) {
  if (!text.includes("\n")) return text;
  const el = document.createElement("div");
  el.className = "cm-placeholder cm-placeholder-multiline";
  el.textContent = text;
  return el;
}

export function createEditor(opts) {
  const { parent, doc, placeholder, onDocChange, commands, extensions } = opts;
  const keyBindings = Object.entries(commands || {}).map(([key, run]) => ({
    key,
    run,
    preventDefault: true,
  }));

  return new EditorView({
    parent,
    state: EditorState.create({
      doc: doc || "",
      extensions: [
        history(),
        keymap.of([...keyBindings, ...defaultKeymap, ...historyKeymap]),
        markdown(),
        indentUnit.of("\t"),
        markdownView(),
        themeCompartment.of(sparkTheme(currentIsDark())),
        EditorView.lineWrapping,
        placeholder ? cmPlaceholder(makePlaceholder(placeholder)) : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onDocChange) onDocChange(u.state.doc.toString());
        }),
        ...(extensions || []),
      ],
    }),
  });
}
