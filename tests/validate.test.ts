import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCharName, charNameKey, validateCharName, validateTitle,
  checkItems, cleanText, validateMessage, ITEM_MAX, ITEM_SOFT_MAX,
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

test("names that only look alike collide, whatever is hidden in them (#11)", () => {
  const base = charNameKey("Thalgrim");
  const hidden = [
    "Thalgrim​", "Thal­grim", "Thal‍grim", "⁦Thalgrim⁩", "Thalgrim️",
    "Thal͏grim", "Thalgrim\u{E0041}", "﻿Thalgrim", "Thal\u0000grim",
    "Ｔｈａｌｇｒｉｍ",                       // fullwidth, folded by NFKC
  ];
  for (const name of hidden) {
    assert.equal(charNameKey(name), base, JSON.stringify(name));
    const v = validateCharName(name);
    assert.ok(v.ok, JSON.stringify(name));
    assert.ok(!/[​­‍⁦⁩️͏﻿\u0000]/u.test(v.value), "display name is clean too");
  }
  // Precomposed and decomposed accents are one name.
  assert.equal(charNameKey("Thalgrím"), charNameKey("Thalgrím"));
  // But a real accent is still a different name.
  assert.notEqual(charNameKey("Thalgrím"), base);
});

test("a name made of nothing visible, or mixing look-alike alphabets, is refused (#11)", () => {
  for (const blank of ["ㅤ", "​​", "⠀", "️", "ᅟᅠ", "‮"]) {
    assert.equal(validateCharName(blank).ok, false, JSON.stringify(blank));
  }
  assert.equal(validateCharName("Thаlgrim").ok, false, "Cyrillic а among Latin");
  assert.equal(validateCharName("Thalgrιm").ok, false, "Greek ι among Latin");
  for (const fine of ["Thalgrim", "Тальгрим", "Θάλγκριμ", "Thalgrím", "Bonkgrog2"]) {
    assert.ok(validateCharName(fine).ok, fine);
  }
});

test("a direction override cannot reach a name, title or square (#11)", () => {
  const rlo = "‮mirglaht";
  assert.equal(normalizeCharName(rlo), "mirglaht");
  const title = validateTitle("Tuesday ‮BT run‬");
  assert.ok(title.ok && title.value === "Tuesday BT run");
  const check = checkItems(Array.from({ length: 24 }, (_, i) => `square ${i}⁧`));
  assert.ok(check.items.every((s) => !s.includes("⁧")));
});

test("free text keeps emoji joiners and presentation selectors; names do not (#11)", () => {
  const wizard = "\u{1F9D9}‍♂️";
  assert.equal(cleanText(`gz ${wizard}`), `gz ${wizard}`);
  assert.equal(cleanText(`gz ${wizard}`, "name"), "gz \u{1F9D9}♂");
  // And the wider strip set reaches chat too.
  const msg = validateMessage("a­ㅤ\u{E0041}b");
  assert.ok(msg.ok && msg.value === "ab");
  assert.equal(validateMessage("ㅤ‌‍").ok, false, "a message of nothing visible");
});

test("noncharacters and lone surrogates never get into stored text (#17)", () => {
  // Built from code points: a literal noncharacter or lone surrogate in the
  // source trips Node's type stripper.
  const t = validateTitle(["BT", "\uFFFE", " run", "\uD800", " ", "\uFDD0", "night", "\uDBFF", "\u{10FFFF}"].join(""));
  assert.ok(t.ok && t.value === "BT run night", JSON.stringify(t));
  // A real surrogate pair is an emoji, and stays.
  assert.equal(cleanText("gz \u{1F525}"), "gz \u{1F525}");
  const n = validateCharName("Thal\uFFFFgrim");
  assert.ok(n.ok && n.value === "Thalgrim");
});
