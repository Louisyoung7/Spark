import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

import {
  BULLET_RE,
  FENCE_RE,
  HEADING_RE,
  HR_RE,
  ORDERED_RE,
  QUOTE_RE,
  indentDepth,
} from "../markdown/syntax.js";

// 轻量渲染：不隐藏语法标记，只把标记弱化、按结构补充视觉层级。
// 底层始终是纯文本，光标/选区交给 CodeMirror 原生管理，不做原子化处理，
// 因此可以随时删掉 #、** 等标记，也不会出现光标跳位。
//
// 块级结构（圆点、引用、代码块、分割线）在这里用逐行装饰实现；
// 标题字号、粗体、行内代码等由 theme.js 的语法高亮负责。

class BulletWidget extends WidgetType {
  constructor(depth) {
    super();
    this.depth = depth;
  }

  eq(other) {
    return other instanceof BulletWidget && other.depth === this.depth;
  }

  toDOM() {
    const span = document.createElement("span");
    // 最多支持 4 级视觉区分，更深层级复用最深样式
    span.className = `cm-bullet cm-bullet-${Math.min(this.depth, 3)}`;
    span.textContent = "•";
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

// 行装饰实例可跨行复用；CodeMirror 允许同一装饰对象出现在多个区间
const quoteLine = Decoration.line({ class: "cm-quote-line" });
const headingLine = Decoration.line({ class: "cm-heading-line" });
const codeLine = Decoration.line({ class: "cm-code-line" });
const codeFirst = Decoration.line({ class: "cm-code-line cm-code-first" });
const codeLast = Decoration.line({ class: "cm-code-line cm-code-last" });
const hrLine = Decoration.line({ class: "cm-hr-line" });
const orderedMarker = Decoration.mark({ class: "cm-list-marker" });

function computeDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  // 当前围栏代码块的开栏信息；null 表示不在代码块内
  let fence = null;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const fenceMatch = text.match(FENCE_RE);

    if (fence) {
      const isClosing =
        fenceMatch &&
        fenceMatch[2][0] === fence.ch &&
        fenceMatch[2].length >= fence.len &&
        fenceMatch[3].trim() === "";
      // 收尾的围栏行加末行圆角
      builder.add(line.from, line.from, isClosing ? codeLast : codeLine);
      if (isClosing) fence = null;
      continue;
    }

    if (fenceMatch) {
      fence = { ch: fenceMatch[2][0], len: fenceMatch[2].length };
      // 开栏行加首行圆角
      builder.add(line.from, line.from, codeFirst);
      continue;
    }

    // 分割线必须先于无序列表判断，否则 --- 会被当成列表项
    if (HR_RE.test(text)) {
      builder.add(line.from, line.from, hrLine);
      continue;
    }

    if (HEADING_RE.test(text)) {
      builder.add(line.from, line.from, headingLine);
      continue;
    }

    if (QUOTE_RE.test(text)) {
      builder.add(line.from, line.from, quoteLine);
    }

    const bullet = text.match(BULLET_RE);
    if (bullet) {
      const indent = bullet[1];
      const markerStart = line.from + indent.length;
      const replaceEnd = markerStart + 1 + bullet[3].length;
      builder.add(
        markerStart,
        replaceEnd,
        Decoration.replace({ widget: new BulletWidget(indentDepth(indent)) })
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
