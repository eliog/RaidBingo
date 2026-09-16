/**
 * Starting item sets offered on the create screen.
 *
 * These live in `presets.json` at the project root, which is NOT committed:
 * a guild's squares name real people, and this repo is public. Ship your own
 * by copying `presets.example.json`. A missing or malformed file is not fatal
 * — the create screen simply offers fewer starting points.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkItems } from "../shared/validate.ts";
import { ITEM_COUNT } from "../shared/board.ts";

export interface Preset {
  name: string;
  items: string[];
}

let cached: Preset[] | null = null;

function usable(entry: unknown, problems: string[]): Preset | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { name, items } = entry as { name?: unknown; items?: unknown };
  if (typeof name !== "string" || name.trim() === "") {
    problems.push("a preset has no name");
    return null;
  }
  if (!Array.isArray(items) || items.length !== ITEM_COUNT) {
    problems.push(`"${name}" needs exactly ${ITEM_COUNT} squares, has ${Array.isArray(items) ? items.length : 0}`);
    return null;
  }
  const check = checkItems(items.map(String));
  if (!check.ok) {
    const first = check.problems[0];
    problems.push(`"${name}" square ${first ? first.index + 1 : "?"}: ${first?.message ?? "invalid"}`);
    return null;
  }
  return { name: name.trim(), items: check.items };
}

export async function loadPresets(): Promise<Preset[]> {
  if (cached !== null) return cached;

  const file = path.resolve(import.meta.dirname, "..", "presets.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    cached = [];
    return cached;
  }

  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`presets.json is not valid JSON, ignoring it: ${(e as Error).message}`);
    cached = [];
    return cached;
  }

  const entries = Array.isArray(parsed) ? parsed : [];
  const out: Preset[] = [];
  for (const entry of entries) {
    const preset = usable(entry, problems);
    if (preset !== null) out.push(preset);
  }
  // Loud enough to notice, quiet enough not to stop the raid.
  for (const p of problems) console.warn(`presets.json: skipped — ${p}`);

  cached = out;
  return cached;
}

/** Tests only. */
export function clearPresetCache(): void {
  cached = null;
}
