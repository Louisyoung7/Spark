import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// 幕布式无序列表即时渲染：把「- / * / + 」标记（后接空格）原地绘制为蓝色圆点，
// 按行首缩进宽度体现嵌套层级。底层仍是纯文本，光标/选区由 CodeMirror 原生管理。
//
// 判定规则与 history.js 的 renderOutline 保持一致：行首缩进 + 标记 + 后接空白。
// 仅当标记后存在空白（即「- 」已输入空格）才渲染圆点，符合「输入 - 加空格实时渲染」。
const LIST_RE = /^([ \t]*)([-*+])(\s.*)$/;

class BulletWidget extends WidgetType {
  eq(other) {
    return other instanceof BulletWidget;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

function computeDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(LIST_RE);
    if (!m) continue;
    const indent = m[1];
    const ws = m[3].match(/^\s+/);
    if (!ws) continue;
    // 标记起点 = 行首 + 缩进宽度；替换范围 = 标记(1) + 前导空白
    const markerStart = line.from + indent.length;
    const replaceEnd = markerStart + 1 + ws[0].length;
    builder.add(
      markerStart,
      replaceEnd,
      Decoration.replace({ widget: new BulletWidget() })
    );
  }
  return builder.finish();
}

export function outlineList() {
  return ViewPlugin.fromClass(
    class {
      decorations;
      constructor(view) {
        this.decorations = computeDecorations(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged) {
          this.decorations = computeDecorations(u.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
