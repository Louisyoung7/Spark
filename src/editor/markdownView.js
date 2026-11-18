import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

import { BULLET_RE, ORDERED_RE } from "../markdown/syntax.js";

// 只负责列表层级的视觉：无序列表标记换成圆点，有序列表序号弱化。
// 其余 Markdown 语法不解析，统一按普通文本显示；底层始终是纯文本，
// 光标与选区交给 CodeMirror 原生管理。

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

const orderedMarker = Decoration.mark({ class: "cm-list-marker" });

function computeDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    const bullet = text.match(BULLET_RE);
    if (bullet) {
      const indent = bullet[1];
      const markerStart = line.from + indent.length;
      const replaceEnd = markerStart + 1 + bullet[3].length;
      builder.add(
        markerStart,
        replaceEnd,
        Decoration.replace({ widget: new BulletWidget() })
      );
      continue;
    }

    const ordered = text.match(ORDERED_RE);
    if (ordered) {
      const start = line.from + ordered[1].length;
      // 数字 + 分隔符（. 或 )）
      builder.add(start, start + ordered[2].length + 1, orderedMarker);
    }
  }

  return builder.finish();
}

export function markdownView() {
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
