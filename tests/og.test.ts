import { test } from "node:test";
import assert from "node:assert/strict";
import { ogSvg, ogTags, ogPng } from "../server/og.ts";

const fresh = { id: "wyrm-lantern-ward", title: "Tuesday BT run", players: 0, calls: 0, bingos: 0, calledCells: [] };
const live = { ...fresh, players: 18, calls: 19, bingos: 2, calledCells: [0, 1, 6, 7, 13] };

test("a freshly pasted link shows an invitation, not three zeros", () => {
  // The image is generated at paste time, so empty IS the normal case.
  const svg = ogSvg(fresh);
  assert.ok(svg.includes("Claim a card"));
  assert.ok(svg.includes("FIVE IN A ROW"));
  assert.ok(!svg.includes("PLAYERS"));
});

test("once the night is under way it shows the score instead", () => {
  const svg = ogSvg(live);
  assert.ok(svg.includes("PLAYERS") && svg.includes("CALLED") && svg.includes("BINGOS"));
  assert.ok(svg.includes(">18<") && svg.includes(">19<"));
  assert.ok(!svg.includes("Claim a card"));
});

test("the free centre always carries the dashed bar, called squares a solid one", () => {
  assert.match(ogSvg(fresh), /stroke-dasharray="7 6"/);
  const svg = ogSvg(live);
  const solid = svg.match(/fill="#8FD94A"\/>/g) ?? [];
  assert.ok(solid.length >= live.calledCells.length);
});

test("a title with an ampersand does not break the document", () => {
  // A bare & makes the svg unparseable and the unfurl blank.
  const svg = ogSvg({ ...fresh, title: "Sun & Moon <raid>" });
  assert.ok(svg.includes("Sun &amp; Moon &lt;raid&gt;"));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(svg));
});

test("a long title is stepped down and then clamped, since svg cannot wrap", () => {
  const long = ogSvg({ ...fresh, title: "An extremely long raid night title that will not fit" });
  assert.match(long, /font-size="44"/);
  assert.ok(long.includes("\u2026"));
});

test("the game id is monospace and never Cinzel", () => {
  const svg = ogSvg(fresh);
  const idLine = (svg.split("\n").find((l) => l.includes("wyrm-lantern-ward")) ?? "");
  assert.match(idLine, /Mono|monospace/);
  assert.ok(!idLine.includes("Cinzel"));
});

test("meta tags carry absolute urls, or Discord will not unfurl them", () => {
  const tags = ogTags(live, "https://raidbingo.com");
  assert.ok(tags.includes('content="https://raidbingo.com/og/wyrm-lantern-ward.png"'));
  assert.ok(tags.includes('content="https://raidbingo.com/g/wyrm-lantern-ward"'));
  assert.ok(tags.includes("18 players"));
  assert.ok(tags.includes('property="og:image:width" content="1200"'));
});

test("the empty-state description invites rather than reporting zeros", () => {
  assert.match(ogTags(fresh, "https://x.test"), /Claim a card/);
});

test("it rasterises to a real png, because Discord will not render svg", async () => {
  const png = await ogPng(fresh);
  assert.ok(png.length > 2000, `only ${png.length} bytes`);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
