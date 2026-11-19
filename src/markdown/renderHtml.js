import { BULLET_RE, ORDERED_RE, indentDepth } from "./syntax.js";

// 历史记录预览：只渲染列表层级，其余内容按纯文本段落显示。
// 与编辑器的列表判定共用 syntax.js，保证同一条笔记在两边呈现的结构一致。
// 所有文本都经过 escapeHtml，只拼接固定的标签。

export function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export function renderOutline(text) {
  const lines = text.split("\n");
  let out = "";
  let paras = [];
  /** 打开的列表层级：{ type: "ul" | "ol", depth } */
  const stack = [];

  const flushPara = () => {
    if (paras.length) {
      out += `<p>${paras.map(escapeHtml).join("<br>")}</p>`;
      paras = [];
    }
  };

  const closeLists = () => {
    while (stack.length) {
      const top = stack.pop();
      out += `</li></${top.type}>`;
    }
  };

  const openList = (type, start, depth) => {
    if (type === "ol" && start !== 1) out += `<ol start="${start}">`;
    else out += `<${type}>`;
    stack.push({ type, depth });
    out += "<li>";
  };

  for (const raw of lines) {
    if (raw.trim() === "") {
      flushPara();
      closeLists();
      continue;
    }

    const bullet = raw.match(BULLET_RE);
    const ordered = raw.match(ORDERED_RE);
    if (bullet || ordered) {
      flushPara();
      const indent = indentDepth((bullet || ordered)[1]);
      const type = bullet ? "ul" : "ol";
      const start = ordered ? Number(ordered[2]) || 1 : 1;

      while (stack.length && indent < stack[stack.length - 1].depth) {
        const top = stack.pop();
        out += `</li></${top.type}>`;
      }
      // 同层但列表类型变化：先收掉旧列表，避免 ul/ol 交叉
      if (
        stack.length &&
        stack[stack.length - 1].depth === indent &&
        stack[stack.length - 1].type !== type
      ) {
        const top = stack.pop();
        out += `</li></${top.type}>`;
      }

      if (stack.length === 0) {
        openList(type, start, indent);
      } else if (indent > stack[stack.length - 1].depth) {
        openList(type, start, indent);
      } else {
        out += "</li><li>";
      }

      out += escapeHtml(bullet ? bullet[4] : ordered[5]);
      continue;
    }

    closeLists();
    paras.push(raw);
  }

  flushPara();
  closeLists();
  return out;
}
