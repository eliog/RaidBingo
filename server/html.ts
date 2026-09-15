/**
 * Page shell. Everything the browser renders hangs off this.
 *
 * Player-supplied strings (titles, character names, item text) end up in
 * markup, so `esc` is not optional anywhere.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** Safe to drop inside a <script> tag: closes no tag and starts no comment. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export interface LayoutOptions {
  title: string;
  body: string;
  /** Extra tags for <head> — already-escaped markup. */
  head?: string | undefined;
  /** Serialised state for the client, exposed as window.__RB__. */
  state?: unknown;
  module?: string | undefined;
}

export function layout(opts: LayoutOptions): string {
  const state = opts.state === undefined
    ? ""
    : `<script>window.__RB__=${jsonForScript(opts.state)};</script>`;
  const mod = opts.module === undefined
    ? ""
    : `<script type="module" src="/assets/${esc(opts.module)}"></script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title)}</title>
<meta name="theme-color" content="#14101A">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Alegreya+Sans:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/assets/app.css">
${opts.head ?? ""}
</head>
<body>
${opts.body}
${state}${mod}
</body>
</html>`;
}

/** A full-page terminal state. Several of these are load-bearing, not cosmetic. */
export function errorPage(heading: string, detail: string, backHref = "/"): string {
  return layout({
    title: `${heading} — Raid Bingo`,
    body: `<main class="narrow stack-lg">
  <p class="eyebrow">Raid Bingo</p>
  <h1>${esc(heading)}</h1>
  <p class="lede">${esc(detail)}</p>
  <p><a class="btn" href="${esc(backHref)}">Back to your games</a></p>
</main>`,
  });
}
