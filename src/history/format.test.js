import assert from "node:assert/strict";
import test from "node:test";
import { daysLeft, formatFullTime, formatTime, noteKey, pad2, rangeStart } from "./format.js";

// 时间格式化按本地时区解析与展示，用本地构造再转 ISO，避免测试依赖运行环境时区
function localIso(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

test("pad2 补足两位", () => {
  assert.equal(pad2(3), "03");
  assert.equal(pad2(12), "12");
});

test("formatTime 输出 MM-DD HH:mm", () => {
  assert.equal(formatTime(localIso(2026, 1, 2, 3, 4)), "01-02 03:04");
});

test("formatTime 对无效时间返回空串", () => {
  assert.equal(formatTime("not-a-date"), "");
});

test("formatFullTime 输出完整年月日", () => {
  assert.equal(formatFullTime(localIso(2026, 11, 19, 8, 5)), "2026-11-19 08:05");
});

test("formatFullTime 对无效时间返回空串", () => {
  assert.equal(formatFullTime(""), "");
});

test("rangeStart(all) 不设下界", () => {
  assert.equal(rangeStart("all"), -Infinity);
});

test("rangeStart 以本地自然日零点为界", () => {
  const now = new Date();
  const cases = { today: 0, "7d": 6, "30d": 29 };
  for (const [range, daysAgo] of Object.entries(cases)) {
    const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    expected.setDate(expected.getDate() - daysAgo);
    assert.equal(rangeStart(range), expected.getTime(), range);
  }
});

test("noteKey 用行号与时间定位记录", () => {
  assert.equal(noteKey({ line: 7, time: "2026-11-19T08:05:00Z" }), "7:2026-11-19T08:05:00Z");
});

test("daysLeft 向上取整剩余天数", () => {
  const now = new Date(2026, 10, 20, 12, 0).getTime();
  const expires = new Date(2026, 10, 21, 0, 0).toISOString();
  assert.equal(daysLeft(expires, now), 1);
});

test("daysLeft 已过期返回 0", () => {
  const now = new Date(2026, 10, 20, 12, 0).getTime();
  assert.equal(daysLeft(new Date(2026, 10, 19, 12, 0).toISOString(), now), 0);
});

test("daysLeft 对无效时间返回 null", () => {
  assert.equal(daysLeft("not-a-date"), null);
});
