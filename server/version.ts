/**
 * Which commit is running, for the footer (#32).
 *
 * In production the image has no .git: the Docker build lets in only HEAD and
 * the refs, resolves them with this module, and writes the hash to
 * version.txt. Locally the server reads .git itself. Anything unexpected falls
 * back to "dev" — a version string must never stop the app starting.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/;

function read(file: string): string | null {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}

/** The full commit hash HEAD points at, or null. Never throws. */
export function resolveGitHead(gitDir: string): string | null {
  const head = read(path.join(gitDir, "HEAD"))?.trim();
  if (head === undefined) return null;
  if (FULL_SHA.test(head)) return head;                       // detached

  // Only a plain branch ref: nothing that could step outside .git.
  const ref = /^ref: (refs\/heads\/[A-Za-z0-9._\/-]+)$/.exec(head)?.[1];
  if (ref === undefined || ref.includes("..")) return null;

  const loose = read(path.join(gitDir, ref))?.trim();
  if (loose !== undefined) return FULL_SHA.test(loose) ? loose : null;

  for (const line of (read(path.join(gitDir, "packed-refs")) ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha !== undefined && FULL_SHA.test(sha)) return sha;
  }
  return null;
}

/** Short hash of the running build: version.txt, then .git, then "dev". */
export function appVersion(root: string): string {
  const baked = read(path.join(root, "version.txt"))?.trim();
  const sha = baked !== undefined && FULL_SHA.test(baked) ? baked : resolveGitHead(path.join(root, ".git"));
  return sha === null ? "dev" : sha.slice(0, 7);
}

// Build step: `node server/version.ts --write <gitDir>` prints the full hash,
// or nothing if it can't be resolved.
if (process.argv[2] === "--write" && process.argv[3] !== undefined) {
  process.stdout.write(resolveGitHead(process.argv[3]) ?? "");
}
