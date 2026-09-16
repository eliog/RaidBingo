import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadPresets, clearPresetCache } from "../server/presets.ts";
import { ITEM_COUNT } from "../shared/board.ts";

const FILE = path.resolve(import.meta.dirname, "..", "presets.json");
const items = (n = ITEM_COUNT) => Array.from({ length: n }, (_, i) => `square ${i + 1}`);

async function withFile(contents: string | null, run: () => Promise<void>) {
  clearPresetCache();
  if (contents === null) await rm(FILE, { force: true });
  else await writeFile(FILE, contents, "utf8");
  try { await run(); } finally { await rm(FILE, { force: true }); clearPresetCache(); }
}

test("a missing presets file is not an error, just fewer starting points", async () => {
  await withFile(null, async () => assert.deepEqual(await loadPresets(), []));
});

test("a valid preset loads", async () => {
  await withFile(JSON.stringify([{ name: "DEA Defaults", items: items() }]), async () => {
    const presets = await loadPresets();
    assert.equal(presets.length, 1);
    assert.equal(presets[0]?.name, "DEA Defaults");
    assert.equal(presets[0]?.items.length, ITEM_COUNT);
  });
});

test("malformed json is ignored rather than stopping the raid", async () => {
  await withFile("{ not json at all", async () => assert.deepEqual(await loadPresets(), []));
});

test("a preset with the wrong number of squares is skipped, others still load", async () => {
  const payload = JSON.stringify([
    { name: "Too few", items: items(20) },
    { name: "Just right", items: items() },
  ]);
  await withFile(payload, async () => {
    const presets = await loadPresets();
    assert.deepEqual(presets.map((p) => p.name), ["Just right"]);
  });
});

test("a preset with duplicate squares is skipped", async () => {
  const dup = items();
  dup[5] = dup[4] as string;
  await withFile(JSON.stringify([{ name: "Dupes", items: dup }]), async () => {
    assert.deepEqual(await loadPresets(), []);
  });
});

test("a nameless preset is skipped", async () => {
  await withFile(JSON.stringify([{ name: "  ", items: items() }]), async () => {
    assert.deepEqual(await loadPresets(), []);
  });
});
