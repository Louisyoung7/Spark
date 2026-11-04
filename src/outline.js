// 编辑框内联大纲渲染：把纯文本中「- / * / + 」列表标记原地显示为圆点，
// 供 textarea 之上的装饰层（overlay）使用。
//
// 关键点：不改变任何字符宽度——仅把标记字符设为透明，再用 ::before 圆点覆盖，
// 因此 overlay 与底层 textarea 逐字符对齐，所见即所得且不破坏光标 / 选区。
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function renderOutlineInline(text) {
  return text
    .split("\n")
    .map((line) => {
      // 与 history.js 的 renderOutline 判定一致：行首缩进 + 标记 +（空白或行尾）
      const m = line.match(/^([ \t]*)([-*+])(\s.*|)$/);
      if (m) {
        const indent = m[1];
        const marker = m[2];
        const rest = m[3];
        return (
          escapeHtml(indent) +
          `<span class="bullet">${escapeHtml(marker)}</span>` +
          escapeHtml(rest)
        );
      }
      return escapeHtml(line);
    })
    .join("\n");
}

// 同步装饰层内容，并跟随 textarea 滚动
export function syncOutline(textarea, overlay) {
  if (!textarea || !overlay) return;
  overlay.innerHTML = renderOutlineInline(textarea.value);
  overlay.scrollTop = textarea.scrollTop;
  overlay.scrollLeft = textarea.scrollLeft;
}
