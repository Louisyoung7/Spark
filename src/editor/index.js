import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { outlineList } from "./outlineList.js";
import { sparkTheme } from "./theme.js";

export { EditorView };

// 幕布式缩进：对光标所在（或选中多行）每行行首操作。
// - Tab（dir>0）：行首加一个 Tab（增加嵌套层级）。
// - Shift+Tab（dir<0）：先删行首缩进；若无缩进但本行是列表项，则删除 marker 取消列表。
// 选择位置交给 CodeMirror 自动映射，不手动计算，避免坐标错位。
export function indentSelection(view, dir) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  const original = state.sliceDoc(lineFrom, lineTo);
  const lines = original.split("\n");
  const newLines = lines.map((line) => {
    if (dir > 0) return "\t" + line;
    // 反向：逐层解除缩进
    if (line.startsWith("\t")) return line.slice(1);
    if (line.startsWith(" ")) return line.slice(1);
    // 已无缩进：若是列表项则取消 marker（「- 」→ 普通文本）
    const m = line.match(/^([-+*])(\s|$)/);
    if (m) return line.slice(m[0].length);
    return line;
  });
  const insert = newLines.join("\n");
  if (insert === original) return; // 无变化，避免无意义 dispatch
  view.dispatch({
    changes: { from: lineFrom, to: lineTo, insert },
  });
  view.focus();
}

// 回车继承缩进（幕布式手感）：
// - 有内容的列表项 → 续行并自动补「marker 」；
// - 空列表项（仅「- 」无内容）→ 退出列表层级（删除 marker）；
// - 普通行 → 仅继承行首缩进；空行 → 退一级。
export function enterWithIndent(view) {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const full = line.text;
  const indentMatch = full.match(/^([ \t]*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const rest = full.slice(indent.length);
  const listMatch = rest.match(/^([-*+])(\s.*)?$/);

  if (listMatch) {
    const marker = listMatch[1];
    if (rest.trim() === marker) {
      // 空列表项：删除 marker 及其后空白，退出当前列表层级
      const from = line.from + indent.length;
      view.dispatch({
        changes: { from, to: line.to, insert: "" },
        selection: { anchor: from },
      });
      view.focus();
      return;
    }
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "\n" + indent + marker + " " },
      selection: { anchor: sel.from + 1 + indent.length + 2 },
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
        outlineList(),
        sparkTheme,
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
