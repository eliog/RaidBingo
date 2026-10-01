/**
 * The one-liners in the footer (#32). Shared so the browser can show them and
 * the tests can check them. Add, remove or reword freely; keep each one short
 * enough for a footer line.
 */

export const QUIPS: readonly string[] = [
  "Raid Bingo: written by vibes, reviewed by vibes, secured by 31 GitHub issues the vibes opened against themselves.",
  "I didn't write this code. I just stood in the fire and told Claude where it was.",
  "Vibe-coded, which means the Close Game button worked perfectly for weeks. It just never closed the game.",
  "The bingo board has more security headers than my guild has people who read the strats.",
  "Built entirely by prompt. My only contribution was saying 'ok push it' at the right moments.",
  "Vibe-coded with 253 tests, which is 253 more than our raid leader runs before pulling.",
  "Like a pug healer: I have no idea how it works, but somehow everyone's still alive.",
  "The AI wrote the code, the AI audited the code, the AI fixed what the AI found. I'm basically the loot council.",
  "Not vibe-coded. Vibe-architected, vibe-tested and vibe-deployed to Fly.io.",
  "Every square was called by a human. Every line of code was not.",
  "Vibe-coded, but with commit messages explaining why, which is more documentation than the game itself has.",
  "My code review process: 'what's left?' and repeat until nothing's left.",
  "I typed 'what's left?' so many times the AI started a support group for it.",
  "Vibe-coded. The only bug I personally introduced was asking for light mode.",
  "Fully AI-built, then I spent the whole day saying 'ok do it'.",
  "Built by AI, tested by AI, reviewed by AI, deployed by Fly. My job was choosing the colour scheme.",
  "Vibe-coded: if it breaks, I'll just ask what's left.",
  "Not hand-crafted. Vibe-crafted.",
  "Artisanal, small-batch, vibe-coded bingo.",
  "Vibe-coded with love, and with Cache-Control: no-store.",
  "Certified organic, free-range, vibe-coded.",
  "100% vibe-coded. 0% Stack Overflow.",
  "Vibe-coded: the code is 100% vibes, and the vibes are 100% unit tested.",
  "Vibe-coded in production, and somehow vibe-secured too.",
  "Some apps are hand-written. This one was vibe-dictated.",
  "Vibe-coded by an AI, vibe-reviewed by five more.",
  "Raid Bingo: the vibes passed CI.",
  "Vibe-coded, vibe-audited, vibe-patched, vibe-pushed.",
  "No developers were harmed in the making of this app. Mostly because none were involved.",
  "It's not technical debt if it was vibe-coded. It's technical vibes.",
  "Vibe-coded under a strict Content-Security-Policy: no inline scripts, only inline vibes.",
  "This app is vibe-coded and has stricter input validation than I do.",
  "Vibe-coded, but every vibe has a GitHub issue number.",
  "Vibe-driven development: write the prompt, watch the tests go green, push to prod.",
];

/** How often the footer changes line. */
export const QUIP_EVERY_MS = 30_000;

/** A random index other than `prev` (pass -1 for the first pick). */
export function nextQuip(prev: number, random: () => number = Math.random): number {
  if (QUIPS.length < 2) return 0;
  // Draw from the others, then step over prev: uniform, and never a repeat.
  const pool = prev >= 0 && prev < QUIPS.length ? QUIPS.length - 1 : QUIPS.length;
  const pick = Math.min(pool - 1, Math.floor(random() * pool));
  return prev >= 0 && pick >= prev ? pick + 1 : pick;
}
