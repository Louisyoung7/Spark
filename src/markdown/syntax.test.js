import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { indentDepth } from "./syntax.js";

describe("indentDepth", () => {
  it("treats no indentation as depth 0", () => {
    assert.equal(indentDepth(""), 0);
  });

  it("counts a tab as one level", () => {
    assert.equal(indentDepth("\t"), 1);
    assert.equal(indentDepth("\t\t"), 2);
  });

  it("counts two spaces as one level", () => {
    assert.equal(indentDepth("  "), 1);
    assert.equal(indentDepth("    "), 2);
  });

  it("floors odd space counts", () => {
    assert.equal(indentDepth("   "), 1);
  });

  it("combines tabs and spaces", () => {
    assert.equal(indentDepth("\t  "), 2);
    assert.equal(indentDepth("  \t"), 2);
  });
});
