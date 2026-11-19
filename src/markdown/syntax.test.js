import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { indentDepth, matchBullet, matchOrdered, planEnter } from "./syntax.js";

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

describe("matchBullet", () => {
  it("parses a normal bullet item", () => {
    assert.deepEqual(matchBullet("- a"), { marker: "-", markerLength: 2, content: "a" });
  });

  it("accepts every bullet marker", () => {
    assert.equal(matchBullet("+ a").marker, "+");
    assert.equal(matchBullet("* a").marker, "*");
  });

  it("treats a bare marker as an empty item", () => {
    assert.deepEqual(matchBullet("-"), { marker: "-", markerLength: 1, content: "" });
    assert.deepEqual(matchBullet("- "), { marker: "-", markerLength: 2, content: "" });
  });

  it("treats whitespace-only content as empty", () => {
    assert.equal(matchBullet("-   ").content, "");
  });

  it("consumes the whole separator", () => {
    assert.deepEqual(matchBullet("-   a"), { marker: "-", markerLength: 4, content: "a" });
    assert.deepEqual(matchBullet("-\ta"), { marker: "-", markerLength: 2, content: "a" });
  });

  it("rejects a marker without following whitespace", () => {
    assert.equal(matchBullet("-notalist"), null);
  });
});

describe("matchOrdered", () => {
  it("parses period and parenthesis delimiters", () => {
    assert.deepEqual(matchOrdered("1. a"), {
      number: 1,
      delimiter: ".",
      markerLength: 3,
      content: "a",
    });
    assert.deepEqual(matchOrdered("12) b"), {
      number: 12,
      delimiter: ")",
      markerLength: 4,
      content: "b",
    });
  });

  it("converts leading zeros to a number", () => {
    assert.equal(matchOrdered("03. a").number, 3);
  });

  it("accepts a marker with no content", () => {
    assert.equal(matchOrdered("1. ").content, "");
  });

  it("requires whitespace after the delimiter", () => {
    assert.equal(matchOrdered("1."), null);
    assert.equal(matchOrdered("1.a"), null);
  });

  it("limits the number to nine digits", () => {
    assert.equal(matchOrdered("123456789. a").number, 123456789);
    assert.equal(matchOrdered("1234567890. a"), null);
  });
});

describe("planEnter", () => {
  it("continues a bullet item", () => {
    assert.deepEqual(planEnter("- a"), { kind: "continue", prefix: "- " });
    assert.deepEqual(planEnter("* a"), { kind: "continue", prefix: "* " });
  });

  it("always uses a space after the bullet marker", () => {
    assert.deepEqual(planEnter("-   a"), { kind: "continue", prefix: "- " });
  });

  it("exits an empty bullet item", () => {
    assert.deepEqual(planEnter("-"), { kind: "exit" });
    assert.deepEqual(planEnter("- "), { kind: "exit" });
  });

  it("increments an ordered item and keeps the delimiter", () => {
    assert.deepEqual(planEnter("1. a"), { kind: "continue", prefix: "2. " });
    assert.deepEqual(planEnter("9) b"), { kind: "continue", prefix: "10) " });
  });

  it("exits an empty ordered item", () => {
    assert.deepEqual(planEnter("1. "), { kind: "exit" });
  });

  it("leaves plain text untouched", () => {
    assert.deepEqual(planEnter("hello"), { kind: "plain" });
    assert.deepEqual(planEnter("-notalist"), { kind: "plain" });
    assert.deepEqual(planEnter(""), { kind: "plain" });
  });
});
