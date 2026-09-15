/**
 * Serves the `shared/` modules straight to the browser.
 *
 * There is no build step. Node can strip TypeScript types from source at
 * runtime, so the browser receives exactly the same board and validation code
 * the server runs — one implementation, not two that can drift. Import
 * specifiers are rewritten from `./x.ts` to `./x.js` on the way out, since the
 * browser resolves the served path.
 */

import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

const SHARED_DIR = path.resolve(import.meta.dirname, "..", "shared");
const CLIENT_DIR = path.resolve(import.meta.dirname, "..", "client");

const cache = new Map<string, string>();

/** Only these may be requested, so a path cannot walk out of the directory. */
const SHARED_MODULES = new Set(["board", "ids", "seams", "validate"]);

export async function sharedModule(name: string): Promise<string | null> {
  if (!SHARED_MODULES.has(name)) return null;
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const source = await readFile(path.join(SHARED_DIR, `${name}.ts`), "utf8");
  const js = stripTypeScriptTypes(source, { mode: "strip" })
    .replaceAll(/(from\s+["'])(\.\/[^"']+)\.ts(["'])/g, "$1$2.js$3");

  cache.set(name, js);
  return js;
}

const CLIENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function clientAsset(
  name: string,
): Promise<{ body: string; type: string } | null> {
  if (!/^[a-z0-9._-]+$/i.test(name) || name.includes("..")) return null;
  const ext = path.extname(name);
  const type = CLIENT_TYPES[ext];
  if (type === undefined) return null;
  try {
    return { body: await readFile(path.join(CLIENT_DIR, name), "utf8"), type };
  } catch {
    return null;
  }
}

/** Tests only — the cache would otherwise outlive an edit. */
export function clearAssetCache(): void {
  cache.clear();
}
