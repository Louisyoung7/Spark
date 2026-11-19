import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
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

// 悬挂缩进：行首前缀（缩进 + 标记 + 空格）折算成 em 宽度，
// 列表行整体左内边距等于该宽度、首行负缩进抵消，换行后文字与列表内容对齐。
// 编辑器非等宽字体，这里按各字符的近似字宽估算，只为视觉对齐，不参与逻辑。
const EM_PER_TAB = 1; // .cm-content 中 tabSize: 4，约等于 4 个空格宽
const EM_PER_SPACE = 0.25;
const EM_BULLET = 0.64; // 与 .cm-bullet 的宽 + 右外边距一致
const EM_DIGIT = 0.6;
const EM_PUNCT = 0.25;

function indentEm(ws) {
  let tabs = 0;
  let spaces = 0;
  for (const ch of ws) {
    if (ch === "\t") tabs++;
    else spaces++;
  }
  return tabs * EM_PER_TAB + spaces * EM_PER_SPACE;
}

function listLine(em) {
  return Decoration.line({
    class: "cm-list-line",
    attributes: { style: `--spark-hang: ${em.toFixed(2)}em` },
  });
}

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
      builder.add(line.from, line.from, listLine(indentEm(indent) + EM_BULLET));
      builder.add(markerStart, replaceEnd, Decoration.replace({ widget: new BulletWidget() }));
      continue;
    }

    const ordered = text.match(ORDERED_RE);
    if (ordered) {
      const start = line.from + ordered[1].length;
      // 数字 + 分隔符（. 或 )）+ 其后空白
      const prefixEm =
        indentEm(ordered[1]) +
        ordered[2].length * EM_DIGIT +
        EM_PUNCT +
        ordered[4].length * EM_PER_SPACE;
      builder.add(line.from, line.from, listLine(prefixEm));
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
    },
  );
}
