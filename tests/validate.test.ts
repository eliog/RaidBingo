import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCharName, charNameKey, validateCharName, validateTitle,
  checkItems, ITEM_MAX, ITEM_SOFT_MAX,
} from "../shared/validate.ts";

test("names collide case-insensitively and across whitespace", () => {
  const key = charNameKey("Thalgrim");
  assert.equal(charNameKey("thalgrim"), key);
  assert.equal(charNameKey("  Thal  grim "), key);
  assert.equal(charNameKey("THALGRIM"), key);
  assert.notEqual(charNameKey("Thalgrimm"), key);
});

test("display names keep their capitals but lose stray whitespace", () => {
  assert.equal(normalizeCharName("  Thal   grim  "), "Thal grim");
});

test("character names must be present and within length", () => {
  assert.equal(validateCharName("Thalgrim").ok, true);
  assert.equal(validateCharName("   ").ok, false);
  assert.equal(validateCharName("x".repeat(25)).ok, false);
});

test("titles are required and capped", () => {
  const r = validateTitle("  Tuesday   BT run ");
  assert.deepEqual(r, { ok: true, value: "Tuesday BT run" });
  assert.equal(validateTitle("").ok, false);
  assert.equal(validateTitle("x".repeat(41)).ok, false);
});

const items = (n: number) => Array.from({ length: n }, (_, i) => `square number ${i + 1}`);

test("a full, clean set of 24 passes", () => {
  const r = checkItems(items(24));
  assert.equal(r.ok, true);
  assert.equal(r.filled, 24);
  assert.equal(r.problems.length, 0);
});

test("fewer than 24 items is not ok, and counts what is filled", () => {
  const list = items(24);
  list[5] = "";
  list[9] = "   ";
  const r = checkItems(list);
  assert.equal(r.ok, false);
  assert.equal(r.filled, 22);
  assert.deepEqual(r.problems.map((p) => p.index), [5, 9]);
  assert.ok(r.problems.every((p) => p.kind === "empty"));
});

test("a duplicate is reported against the earlier slot it clashes with", () => {
  const list = items(24);
  list[3] = list[2] as string;
  const r = checkItems(list);
  assert.equal(r.ok, false);
  const dup = r.problems.find((p) => p.kind === "duplicate");
  assert.ok(dup);
  assert.equal(dup.index, 3);
  assert.equal(dup.clashesWith, 2);
  assert.match(dup.message, /Same as 3/);
});

test("duplicates ignore case and surrounding whitespace", () => {
  const list = items(24);
  list[3] = `  ${(list[2] as string).toUpperCase()}  `;
  assert.ok(checkItems(list).problems.some((p) => p.kind === "duplicate"));
});

test("over the soft cap warns; over the hard cap fails", () => {
  const list = items(24);
  list[0] = "x".repeat(ITEM_SOFT_MAX + 1);
  let r = checkItems(list);
  assert.equal(r.ok, true, "a long-but-legal item should still be submittable");
  assert.equal(r.warnings[0]?.index, 0);

  list[0] = "x".repeat(ITEM_MAX + 1);
  r = checkItems(list);
  assert.equal(r.ok, false);
  assert.equal(r.problems[0]?.kind, "too-long");
});
