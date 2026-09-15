/**
 * The image Discord unfurls when someone pastes a game link.
 *
 * It is generated at PASTE time, so the normal case is a game nobody has
 * joined yet. A scoreboard would therefore render as a dead grey grid beside
 * three zeros, which is the worst possible advertisement for a game. So the
 * empty state is designed as the primary one: a pristine card etched in
 * brass, with "Claim a card" where the stats go. The live variant is the same
 * template with the stat blocks swapped back in.
 *
 * Discord caches an unfurl against the page url, so whatever is generated at
 * paste time is what everyone sees for the life of that paste.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ITEM_COUNT, FREE_CELL } from "../shared/board.ts";

const G = "#C9A05E", FEL = "#8FD94A", BONE = "#E8DFC8", BG = "#14101A";
const T = 68, P = 83, OX = 700, OY = 150, CH = 17;

export interface OgState {
  id: string;
  title: string;
  players: number;
  calls: number;
  bingos: number;
  /** Board positions already called, for the live variant. */
  calledCells: number[];
}

/** SVG has no entity table beyond the basics; a bare & breaks the document. */
function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

/** No text wrapping in SVG, so the title is stepped and then clamped. */
function titleSize(title: string): number {
  if (title.length <= 16) return 62;
  if (title.length <= 22) return 52;
  return 44;
}
function clampTitle(title: string): string {
  return title.length <= 26 ? title : `${title.slice(0, 25).trimEnd()}…`;
}

const tile = (x: number, y: number) =>
  `M${x + CH} ${y}H${x + T}V${y + T - CH}L${x + T - CH} ${y + T}H${x}V${y + CH}Z`;
const bar = (x: number, y: number) =>
  `M${x + CH} ${y}H${x + T}V${y + 7}H${x + CH - 7}Z`;

const MARK =
  '<path d="M11 2H53L62 11V53L53 62H11L2 53V11Z" fill="none" stroke="#C9A05E" stroke-width="2.2"/>' +
  '<g fill="#E8DFC8" opacity=".2"><path d="M14.5 11H23V19.5L19.5 23H11V14.5Z"/><path d="M29.5 11H38V19.5L34.5 23H26V14.5Z"/><path d="M14.5 26H23V34.5L19.5 38H11V29.5Z"/><path d="M44.5 26H53V34.5L49.5 38H41V29.5Z"/><path d="M29.5 41H38V49.5L34.5 53H26V44.5Z"/><path d="M44.5 41H53V49.5L49.5 53H41V44.5Z"/></g>' +
  '<g fill="#8FD94A"><path d="M44.5 11H53V19.5L49.5 23H41V14.5Z"/><path d="M29.5 26H38V34.5L34.5 38H26V29.5Z"/><path d="M14.5 41H23V49.5L19.5 53H11V44.5Z"/></g>';

const stat = (x: number, n: number, label: string) =>
  `<text x="${x}" y="500" font-family="Cinzel" font-weight="700" font-size="58" fill="${BONE}">${n}</text>` +
  `<text x="${x}" y="532" font-family="Alegreya Sans" font-size="16" font-weight="700" letter-spacing="3.4" fill="${BONE}" opacity=".55">${label}</text>`;

export function ogSvg(state: OgState): string {
  const fresh = state.players === 0 && state.calls === 0;
  const cells = Array.from({ length: 25 }, (_, i) => ({
    i, x: OX + (i % 5) * P, y: OY + Math.floor(i / 5) * P,
  }));
  const called = new Set(state.calledCells);
  const fx = OX + 2 * P, fy = OY + 2 * P;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${BG}"/>
<path d="M60 28H1140L1172 60V570L1140 602H60L28 570V60Z" fill="none" stroke="${G}" stroke-width="2.5"/>
<path d="M66 38H1134L1162 66V564L1134 592H66L38 564V66Z" fill="none" stroke="${G}" stroke-width="1" opacity=".38"/>
<g fill="${G}"><circle cx="44" cy="44" r="4.5"/><circle cx="1156" cy="44" r="4.5"/><circle cx="1156" cy="586" r="4.5"/><circle cx="44" cy="586" r="4.5"/></g>
<g fill="${BONE}" opacity=".055">${cells.map((c) => `<path d="${tile(c.x, c.y)}"/>`).join("")}</g>
<g fill="none" stroke="${G}" stroke-width="2" opacity=".45">${cells.map((c) => `<path d="${tile(c.x, c.y)}"/>`).join("")}</g>
${cells.filter((c) => c.i !== FREE_CELL && called.has(c.i)).map((c) => `<path d="${bar(c.x, c.y)}" fill="${FEL}"/>`).join("")}
<path d="M${fx + CH} ${fy + 4.5}H${fx + T}" stroke="${FEL}" stroke-width="9" stroke-linecap="butt" stroke-dasharray="7 6"/>
<g transform="translate(68,52) scale(.72)">${MARK}</g>
<text x="128" y="82" font-family="Cinzel" font-weight="700" font-size="25" letter-spacing="4.5" fill="${BONE}">RAID BINGO</text>
<path d="M68 128h560" stroke="${G}" stroke-width="1" opacity=".3"/>
<text x="68" y="268" font-family="Cinzel" font-weight="700" font-size="${titleSize(state.title)}" fill="${BONE}">${xml(clampTitle(state.title))}</text>
<text x="68" y="318" font-family="JetBrains Mono, DejaVu Sans Mono, monospace" font-size="25" fill="${FEL}">${xml(state.id)}</text>
${fresh
  ? `<text x="68" y="484" font-family="Alegreya Sans" font-size="17" font-weight="700" letter-spacing="4.6" fill="${G}">${ITEM_COUNT} SQUARES · FREE CENTRE · FIVE IN A ROW</text>` +
    `<text x="68" y="540" font-family="Cinzel" font-weight="700" font-size="40" fill="${FEL}">Claim a card</text>`
  : stat(68, state.players, "PLAYERS") + stat(258, state.calls, "CALLED") + stat(448, state.bingos, "BINGOS")}
</svg>`;
}

/** Meta tags for the game page head. Absolute urls, or Discord will not unfurl. */
export function ogTags(state: OgState, baseUrl: string): string {
  const description = state.players === 0
    ? `${ITEM_COUNT} squares, free centre, five in a row. Claim a card.`
    : `${state.players} ${state.players === 1 ? "player" : "players"} · ${state.calls} of ${ITEM_COUNT} called` +
      (state.bingos > 0 ? ` · ${state.bingos} bingo${state.bingos === 1 ? "" : "s"}` : "");
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${xml(state.title)} — Raid Bingo">`,
    `<meta property="og:description" content="${xml(description)}">`,
    `<meta property="og:url" content="${xml(`${baseUrl}/g/${state.id}`)}">`,
    `<meta property="og:image" content="${xml(`${baseUrl}/og/${state.id}.png`)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${xml(`A bingo board for ${state.title}.`)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");
}

/* ------------------------------------------------------------ rendering */

let fontBuffers: Buffer[] | null = null;

/**
 * Fonts do not travel inside an SVG: the rasteriser needs the files. Drop
 * Cinzel, Alegreya Sans and a monospace face into ./fonts (with their OFL
 * licences, since this repo is public). Without them the image still renders,
 * in whatever the host has.
 */
async function loadFonts(): Promise<Buffer[]> {
  if (fontBuffers !== null) return fontBuffers;
  const dir = path.resolve(import.meta.dirname, "..", "fonts");
  try {
    const names = (await readdir(dir)).filter((f) => /\.(ttf|otf)$/i.test(f));
    fontBuffers = await Promise.all(names.map((f) => readFile(path.join(dir, f))));
  } catch {
    fontBuffers = [];
  }
  return fontBuffers;
}

/** Discord will not render an SVG og:image, so this has to be a PNG. */
export async function ogPng(state: OgState): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const fontFiles = await loadFonts();
  const resvg = new Resvg(ogSvg(state), {
    fitTo: { mode: "width", value: 1200 },
    font: {
      fontBuffers: fontFiles,
      loadSystemFonts: fontFiles.length === 0,
      defaultFontFamily: "Alegreya Sans",
    },
  });
  return Buffer.from(resvg.render().asPng());
}
