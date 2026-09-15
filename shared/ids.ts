/**
 * Game ids: three distinct words from a curated pool, e.g.
 * `shattered-felguard-netherstorm`.
 *
 * The id is how a game is shared. It is NOT a credential — Discord login is
 * required either way — but it is the only thing standing between a stranger
 * and a game they were not pointed at, so it has to be unguessable in
 * practice. There is deliberately NO prefix matching: resolving a prefix
 * would have to search every open game, which turns the join box into an
 * enumeration oracle.
 */

import type { Rng } from "./seams.ts";

export const WORDS: readonly string[] = Object.freeze([
  "hallow", "spire", "keep", "barrow", "hollow", "reach", "marsh", "tundra",
  "vale", "crag", "bluff", "fen", "grove", "mire", "steppe", "delta",
  "basin", "ridge", "summit", "hearth", "forge", "vault", "crypt", "shrine",
  "bastion", "citadel", "rampart", "gatehouse", "causeway", "catacomb", "sanctum", "athenaeum",
  "foundry", "scriptorium", "observatory", "harbour", "wharf", "quarry", "mineshaft", "outpost",
  "waystation", "beacon", "watchtower", "wyrm", "drake", "whelp", "gryphon", "hippogryph",
  "basilisk", "chimaera", "wisp", "sprite", "dryad", "treant", "elemental", "golem",
  "gargoyle", "harpy", "kraken", "leviathan", "manticore", "phoenix", "revenant", "seraph",
  "wraith", "banshee", "lich", "ghoul", "imp", "satyr", "minotaur", "centaur",
  "ogre", "troll", "wolf", "raven", "owl", "stag", "boar", "bear",
  "hawk", "serpent", "spider", "scarab", "moth", "crow", "falcon", "iron",
  "steel", "bronze", "brass", "copper", "silver", "gold", "platinum", "obsidian",
  "granite", "marble", "basalt", "quartz", "amber", "jade", "opal", "onyx",
  "topaz", "garnet", "amethyst", "sapphire", "emerald", "ruby", "pearl", "coral",
  "ivory", "ebony", "oak", "ash", "yew", "birch", "cedar", "willow",
  "thorn", "bramble", "moss", "lichen", "fern", "rune", "glyph", "sigil",
  "ward", "hex", "charm", "oath", "pact", "rite", "chant", "psalm",
  "litany", "vigil", "omen", "augury", "portent", "prophecy", "relic", "reliquary",
  "talisman", "amulet", "censer", "brazier", "lantern", "candle", "ember", "cinder",
  "spark", "flare", "warden", "sentinel", "herald", "harbinger", "envoy", "emissary",
  "vanguard", "outrider", "skirmisher", "marshal", "castellan", "steward", "archivist", "cartographer",
  "alchemist", "artificer", "smith", "fletcher", "mason", "tanner", "scribe", "minstrel",
  "wanderer", "pilgrim", "hermit", "oracle", "seer", "augur", "ranger", "scout",
  "sapper", "quartermaster", "storm", "tempest", "gale", "squall", "zephyr", "monsoon",
  "blizzard", "frost", "rime", "hail", "sleet", "thunder", "lightning", "eclipse",
  "aurora", "twilight", "dusk", "dawn", "gloaming", "solstice", "equinox", "tide",
  "undertow", "maelstrom", "vortex", "gilded", "tarnished", "molten", "frozen", "shattered",
  "sundered", "hallowed", "forsaken", "verdant", "ashen", "crimson", "azure", "viridian",
  "umber", "sable", "argent", "gleaming", "glimmering", "wandering", "roaming", "silent",
  "restless", "weary", "ancient", "elder", "deep", "lofty", "outer", "inner",
  "wild", "bright", "dim",
]);

export const WORDS_IN_POOL = WORDS.length;

/**
 * Ordered triples of distinct words.
 *
 * NOTE: the spec targets a pool of ~512 words (133.4M combinations, 27 bits).
 * The pool below is a hand-curated starting set of 243 and yields ~14.2M. That
 * is still far more than enough in practice — with a handful of games open at
 * once a random guess lands on a live game about 1 in 2.8M times, and the
 * join endpoint is rate limited — but growing the pool toward 512 is cheap
 * and worth doing. Add words to WORDS; nothing else needs to change.
 */
export const KEYSPACE = WORDS_IN_POOL * (WORDS_IN_POOL - 1) * (WORDS_IN_POOL - 2);

/**
 * Substrings that must never appear in a generated id. Individually clean
 * words still combine badly, and these get posted into a guild channel.
 * Checked against the whole hyphenated id AND against the letters alone, so a
 * hyphen cannot smuggle a match past it.
 */
const BLOCKED: readonly string[] = Object.freeze([
  "ashen-ass", "hex-hex", "dim-wit", "hell", "damn", "kill", "die", "rape", "nazi",
]);

export function isBlockedId(id: string): boolean {
  const hyphenated = id.toLowerCase();
  const letters = hyphenated.replaceAll("-", "");
  return BLOCKED.some((bad) => {
    const b = bad.toLowerCase();
    return hyphenated.includes(b) || letters.includes(b.replaceAll("-", ""));
  });
}

/** Shape check only — says nothing about whether the game exists. */
export function isWellFormedId(id: string): boolean {
  const parts = id.split("-");
  if (parts.length !== 3) return false;
  if (new Set(parts).size !== 3) return false;
  return parts.every((p) => WORDS.includes(p));
}

/**
 * Three DISTINCT words, order significant. Regenerates on a blocklist hit;
 * throws rather than looping forever if the pool is somehow unusable.
 */
export function generateId(rng: Rng): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const picked: string[] = [];
    const used = new Set<number>();
    while (picked.length < 3) {
      const i = rng.int(WORDS.length);
      if (used.has(i)) continue;
      used.add(i);
      picked.push(WORDS[i] as string);
    }
    const id = picked.join("-");
    if (!isBlockedId(id)) return id;
  }
  throw new Error("could not generate an unblocked game id in 50 attempts");
}
