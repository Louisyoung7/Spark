import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeHtml, renderOutline } from "./renderHtml.js";

describe("escapeHtml", () => {
  it("escapes all HTML-sensitive characters", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("renderOutline", () => {
  it("renders a plain line as a paragraph", () => {
    assert.equal(renderOutline("hello"), "<p>hello</p>");
  });

  it("joins multiple plain lines with <br>", () => {
    assert.equal(renderOutline("a\nb"), "<p>a<br>b</p>");
  });

  it("renders a bullet list", () => {
    assert.equal(renderOutline("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  });

  it("nests lists by indentation", () => {
    assert.equal(renderOutline("- a\n  - b"), "<ul><li>a<ul><li>b</li></ul></li></ul>");
  });

  it("keeps the start number of an ordered list", () => {
    assert.equal(renderOutline("3. c"), '<ol start="3"><li>c</li></ol>');
  });

  it("closes a list on a blank line and opens a new one", () => {
    assert.equal(renderOutline("- a\n\n- b"), "<ul><li>a</li></ul><ul><li>b</li></ul>");
  });

  it("splits lists when the type changes at the same depth", () => {
    assert.equal(renderOutline("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("escapes user content in list items", () => {
    assert.equal(
      renderOutline("- <img src=x onerror=alert(1)>"),
      "<ul><li>&lt;img src=x onerror=alert(1)&gt;</li></ul>",
    );
  });

  it("does not treat a marker without trailing space as a list", () => {
    assert.equal(renderOutline("-notalist"), "<p>-notalist</p>");
  });
});
