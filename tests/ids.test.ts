import { test } from "node:test";
import assert from "node:assert/strict";
import { WORDS, WORDS_IN_POOL, KEYSPACE, generateId, isBlockedId, isWellFormedId } from "../shared/ids.ts";
import { seededRng, cryptoRng } from "../shared/seams.ts";

test("the word pool has no duplicates and is all lowercase letters", () => {
  assert.equal(new Set(WORDS).size, WORDS.length, "pool contains a duplicate");
  for (const word of WORDS) assert.match(word, /^[a-z]{3,}$/, `bad word: ${word}`);
});

test("the keyspace is large enough that guessing an open game is impractical", () => {
  assert.equal(KEYSPACE, WORDS_IN_POOL * (WORDS_IN_POOL - 1) * (WORDS_IN_POOL - 2));
  // Well below the ~512-word target, but with a handful of games open at once a
  // guess lands about 1 in 2.8M times, and the join endpoint is rate limited.
  assert.ok(KEYSPACE > 10_000_000, `keyspace is only ${KEYSPACE}`);
});

test("a generated id is three distinct words from the pool", () => {
  for (let seed = 0; seed < 200; seed++) {
    const id = generateId(seededRng(seed));
    const parts = id.split("-");
    assert.equal(parts.length, 3, id);
    assert.equal(new Set(parts).size, 3, `repeated word in ${id}`);
    for (const p of parts) assert.ok(WORDS.includes(p), `${p} not in pool`);
    assert.ok(isWellFormedId(id), id);
  }
});

test("generated ids never contain a blocked substring", () => {
  for (let i = 0; i < 300; i++) assert.ok(!isBlockedId(generateId(cryptoRng)));
});

test("the blocklist catches a substring split across a hyphen", () => {
  assert.ok(isBlockedId("hel-lantern-ward"));
  assert.ok(isBlockedId("shattered-hell-wyrm"));
});

test("isWellFormedId rejects anything that is not three pool words", () => {
  assert.ok(!isWellFormedId("wyrm-wyrm-wyrm"));      // repeated
  assert.ok(!isWellFormedId("wyrm-lantern"));         // too few
  assert.ok(!isWellFormedId("wyrm-lantern-notaword"));
  assert.ok(!isWellFormedId(""));
});
