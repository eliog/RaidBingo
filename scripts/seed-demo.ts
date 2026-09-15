/**
 * Local development only. Fills a game with imaginary raiders so you can see a
 * populated board without needing several Discord accounts.
 *
 * This writes rows directly through the repository. It creates NO sessions and
 * is not a login bypass — you still sign in with Discord as yourself.
 *
 *   node --env-file=.env scripts/seed-demo.ts
 *
 * Sign in once first, so there is a player row to own the game.
 */

import { loadConfig } from "../server/config.ts";
import { openDatabase, createRepository } from "../server/db.ts";
import { GameService } from "../server/game-service.ts";
import { systemClock, cryptoRng } from "../shared/seams.ts";
import { dealBoard } from "../shared/board.ts";

const ITEMS = [
  "Someone pulls before the count", "Healer blames the tank",
  "Wipe under 5% boss health", "Tank dies in the first 30 seconds",
  "Someone DCs mid-fight", "Loot drops for a class not here",
  "Someone stands in the fire", "Warlock forgets the soulwell",
  "Two people roll the same number", "Rogue dies to trash",
  "Someone AFK at the pull", "Shaman drops the wrong totem",
  "\u201cWho pulled?\u201d", "Repair bill in raid chat",
  "\u201cCan we take five?\u201d", "Mage asked for a table mid-fight",
  "Unprompted Recount link", "DKP argument during a boss fight",
  "Battle rez goes to the wrong person", "Healer OOM before the boss hits 50%",
  "Someone brought the wrong flask", "Warrior charges in early",
  "Raid waits ten minutes on one person", "\u201cI thought you were interrupting\u201d",
];

const RAIDERS = ["Thalgrim", "Bonkgrog", "Mirelle", "Kaelen", "Sylva", "Dorn"];

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
const repo = createRepository(db);
const service = new GameService(repo, systemClock, cryptoRng);

// Whoever signed in most recently owns the game — that is you.
const owner = db
  .prepare("SELECT pid FROM players ORDER BY last_seen DESC LIMIT 1")
  .get() as { pid?: string } | undefined;

if (owner?.pid === undefined) {
  console.error(
    "\nNo players yet. Start the server, sign in with Discord once, then run this again.\n",
  );
  process.exit(1);
}

const created = await service.createGame(owner.pid, "Tuesday BT run", ITEMS);
if (!created.ok) {
  console.error(`\nCould not create the game: ${created.error.message}\n`);
  process.exit(1);
}
const gameId = created.value;

await service.joinGame(owner.pid, gameId, "Felwarden");

const now = systemClock.now();
for (const [i, name] of RAIDERS.entries()) {
  const pid = `demo-${name.toLowerCase()}`;
  await repo.upsertPlayer(pid, now);
  await repo.addGamePlayer({
    gameId, pid, charName: name,
    board: dealBoard(cryptoRng), joinedAt: now + i, bingoAt: null,
  });
}

// A few calls, so the board is not empty when you open it.
for (const item of [2, 4, 7, 11, 13, 17, 20]) {
  await service.call(owner.pid, gameId, item);
}

console.log(`
  Seeded "Tuesday BT run" with ${RAIDERS.length + 1} raiders and 7 calls.

    ${config.baseUrl}/g/${gameId}

  You are the owner, so you can call and undo squares. The other raiders are
  rows in the database, not sessions — they will not tick over on their own.
`);
