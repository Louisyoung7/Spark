import {
  BULLET_RE,
  FENCE_RE,
  HEADING_RE,
  HR_RE,
  ORDERED_RE,
  QUOTE_RE,
  indentDepth,
} from "./syntax.js";

// 历史记录预览的 Markdown → HTML 渲染。
// 与编辑器的块级判定共用 syntax.js，保证同一条笔记在两边呈现的结构一致。
// 所有文本都经过 escapeHtml，只拼接固定的标签。

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** 行内格式：行内代码 → 链接 → 粗体 → 删除线 → 斜体 */
export function renderInline(text) {
  // 先抽出反引号内容并占位，避免其中的符号被后续规则再次解析
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);
  s = s
    .replace(
      /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<span class="md-link">$1</span>'
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  return s.replace(
    /\u0000(\d+)\u0000/g,
    (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`
  );
}

export function renderOutline(text) {
  const lines = text.split("\n");
  let out = "";
  let paras = [];
  let quotes = [];
  /** 打开的列表层级：{ type: "ul" | "ol", depth } */
  const stack = [];
  let fence = null;
  let fenceCode = [];

  const flushPara = () => {
    if (paras.length) {
      out += `<p>${paras.map(renderInline).join("<br>")}</p>`;
      paras = [];
    }
  };

  const flushQuote = () => {
    if (quotes.length) {
      out += `<blockquote>${quotes.map(renderInline).join("<br>")}</blockquote>`;
      quotes = [];
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
    // —— 围栏代码块内部：原样收集，不做任何行内解析 ——
    if (fence) {
      const m = raw.match(FENCE_RE);
      const isClosing =
        m && m[2][0] === fence.ch && m[2].length >= fence.len && m[3].trim() === "";
      if (isClosing) {
        out += `<pre class="md-code"><code>${escapeHtml(fenceCode.join("\n"))}</code></pre>`;
        fence = null;
        fenceCode = [];
      } else {
        fenceCode.push(raw);
      }
      continue;
    }

    const fenceOpen = raw.match(FENCE_RE);
    if (fenceOpen) {
      flushPara();
      flushQuote();
      closeLists();
      fence = { ch: fenceOpen[2][0], len: fenceOpen[2].length };
      fenceCode = [];
      continue;
    }

    if (raw.trim() === "") {
      flushPara();
      flushQuote();
      closeLists();
      continue;
    }

    // 分割线要先于无序列表判断，否则 --- 会被当成列表项
    if (HR_RE.test(raw)) {
      flushPara();
      flushQuote();
      closeLists();
      out += '<hr class="md-hr">';
      continue;
    }

    const heading = raw.match(HEADING_RE);
    if (heading) {
      flushPara();
      flushQuote();
      closeLists();
      const level = heading[2].length;
      out += `<h${level} class="md-h${level}">${renderInline(heading[4])}</h${level}>`;
      continue;
    }

    const quote = raw.match(QUOTE_RE);
    if (quote) {
      flushPara();
      closeLists();
      quotes.push(quote[3]);
      continue;
    }
    flushQuote();

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

      out += renderInline(bullet ? bullet[4] : ordered[5]);
      continue;
    }

    closeLists();
    paras.push(raw);
  }

  // 收尾：未闭合的代码块、段落、引用与列表
  if (fence) {
    out += `<pre class="md-code"><code>${escapeHtml(fenceCode.join("\n"))}</code></pre>`;
  }
  flushPara();
  flushQuote();
  closeLists();
  return out;
}
