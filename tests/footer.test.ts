import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { QUIPS, nextQuip, QUIP_EVERY_MS } from "../shared/quips.ts";
import { resolveGitHead, appVersion } from "../server/version.ts";

const SHA = "058dc8a1f2e3d4c5b6a79881726354a5b6c7d8e9";
const OTHER = "11c343f00000000000000000000000000000abcd";

async function gitDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rb-git-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  return root;
}

test("the one-liners are all there, distinct, and short enough for a footer (#32)", () => {
  assert.equal(QUIPS.length, 34);
  assert.equal(new Set(QUIPS).size, QUIPS.length, "no duplicates");
  for (const q of QUIPS) {
    assert.equal(q, q.trim());
    assert.ok(q.length > 10 && q.length <= 140, q);
    assert.ok(!/^["“]|["”]$/.test(q), `no wrapping quotes: ${q}`);
  }
  assert.ok(QUIPS.includes("Raid Bingo: the vibes passed CI."));
});

test("the next one-liner is random but never the one just shown (#32)", () => {
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    for (const prev of [-1, 0, 5, QUIPS.length - 1]) {
      const next = nextQuip(prev, () => r);
      assert.ok(Number.isInteger(next) && next >= 0 && next < QUIPS.length);
      assert.notEqual(next, prev);
    }
  }
  // Over many draws every line gets a turn.
  let rngState = 7;
  const rng = () => ((rngState = (rngState * 48271) % 2147483647) / 2147483647);
  const seen = new Set<number>(); let i = -1;
  for (let n = 0; n < 2000; n++) seen.add(i = nextQuip(i, rng));
  assert.equal(seen.size, QUIPS.length);
  assert.ok(QUIP_EVERY_MS >= 20_000 && QUIP_EVERY_MS <= 45_000);
});

test("the commit is read from a detached HEAD, a branch ref, or packed refs (#32)", async () => {
  const detached = await gitDir({ HEAD: `${SHA}\n` });
  const loose = await gitDir({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": `${SHA}\n` });
  const packed = await gitDir({ HEAD: "ref: refs/heads/main\n",
    "packed-refs": `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n` });
  // A loose ref wins over a stale packed one, as in git.
  const both = await gitDir({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": `${SHA}\n`, "packed-refs": `${OTHER} refs/heads/main\n` });
  try {
    for (const dir of [detached, loose, packed, both]) assert.equal(resolveGitHead(dir), SHA, dir);
  } finally { for (const d of [detached, loose, packed, both]) await rm(d, { recursive: true, force: true }); }
});

test("a missing or garbled .git resolves to nothing rather than throwing (#32)", async () => {
  const cases = [
    await gitDir({}),
    await gitDir({ HEAD: "ref: refs/heads/gone\n" }),
    await gitDir({ HEAD: "not a hash\n" }),
    await gitDir({ HEAD: "ref: ../../../etc/passwd\n" }),
    await gitDir({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": "zzzz\n" }),
  ];
  try {
    for (const dir of cases) assert.equal(resolveGitHead(dir), null, dir);
    assert.equal(resolveGitHead(path.join(tmpdir(), "rb-no-such-dir")), null);
  } finally { for (const d of cases) await rm(d, { recursive: true, force: true }); }
});

test("the app version prefers version.txt, then .git, then says dev (#32)", async () => {
  const withFile = await gitDir({ "version.txt": `${SHA}\n`, ".git/HEAD": `${OTHER}\n` });
  const withGit = await gitDir({ ".git/HEAD": `${SHA}\n` });
  const bare = await gitDir({});
  const junkFile = await gitDir({ "version.txt": "<script>\n", ".git/HEAD": `${SHA}\n` });
  try {
    assert.equal(appVersion(withFile), SHA.slice(0, 7));
    assert.equal(appVersion(withGit), SHA.slice(0, 7));
    assert.equal(appVersion(bare), "dev");
    assert.equal(appVersion(junkFile), SHA.slice(0, 7), "a junk version.txt is ignored");
  } finally { for (const d of [withFile, withGit, bare, junkFile]) await rm(d, { recursive: true, force: true }); }
});
