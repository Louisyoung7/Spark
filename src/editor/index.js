import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { outlineList } from "./outlineList.js";
import { sparkTheme } from "./theme.js";

export { EditorView };

// 幕布式缩进：对光标所在（或选中多行）每行行首增/减一个 Tab（或单空格）。
export function indentSelection(view, dir) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  const lines = state.sliceDoc(lineFrom, lineTo).split("\n");
  let changed = 0;
  const newLines = lines.map((line) => {
    if (dir > 0) {
      changed++;
      return "\t" + line;
    }
    if (line.startsWith("\t")) {
      changed++;
      return line.slice(1);
    }
    if (line.startsWith(" ")) {
      changed++;
      return line.slice(1);
    }
    return line;
  });
  const insert = newLines.join("\n");
  const delta = dir > 0 ? lines.length : changed;
  view.dispatch({
    changes: { from: lineFrom, to: lineTo, insert },
    selection: {
      anchor: Math.max(0, Math.min(state.doc.length, from + delta)),
      head: Math.max(0, Math.min(state.doc.length, to + delta)),
    },
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
        placeholder ? cmPlaceholder(placeholder) : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onDocChange) onDocChange(u.state.doc.toString());
        }),
        ...(extensions || []),
      ],
    }),
  });
}
