/**
 * The whole client. Imports the same board and validation modules the server
 * runs — served from /shared with types stripped at request time.
 */
import { winningCells, isMarked, FREE, FREE_CELL, ITEM_COUNT } from "/shared/board.js";
import { checkItems, validateCharName, ITEM_MAX, ITEM_SOFT_MAX } from "/shared/validate.js";

const S = window.__RB__ ?? { view: "login", returnTo: "/" };
const root = document.getElementById("app");

/* ------------------------------------------------------------------ dom */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;          // never innerHTML
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

async function api(path, body, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? "Something went wrong."), { detail: data?.error ?? {} });
  return data;
}

/* --------------------------------------------------------------- toasts */
const toasts = h("div", { class: "toasts" });
function toast(text, { kind = "", actions = [], sticky = false } = {}) {
  const box = h("div", { class: `toast ${kind}` }, h("div", { text }));
  if (actions.length) {
    box.append(h("div", { class: "acts" }, actions.map((a) =>
      h("button", { class: "btn sm", onclick: () => { box.remove(); a.run(); } }, a.label))));
  }
  if (!sticky) setTimeout(() => box.remove(), 6000);
  toasts.append(box);
  return box;
}

/* --------------------------------------------------------------- header */
function masthead() {
  const name = S.lastName ?? S.game?.charName ?? null;
  const chip = h("button", { class: `chip ${name ? "" : "anon"}`, "aria-haspopup": "menu" },
    name ?? "Signed in", " ▾");
  let menu = null;
  chip.addEventListener("click", () => {
    if (menu) { menu.remove(); menu = null; return; }
    menu = h("div", { class: "menu", role: "menu" },
      h("button", { onclick: () => { location.href = "/"; } }, "Your games"),
      h("button", { onclick: async () => {
        const f = h("form", { method: "POST", action: "/auth/logout" });
        document.body.append(f); f.submit();
      } }, "Log out"));
    document.body.append(menu);
  });
  return h("header", { class: "masthead" },
    h("a", { class: "wordmark", href: "/" }, mark(26), h("span", null, "Raid Bingo")),
    h("div", { class: "spacer" }), chip);
}

function mark(size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", size); svg.setAttribute("height", size);
  svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<path d="M11 2H53L62 11V53L53 62H11L2 53V11Z" stroke="var(--gold)" stroke-width="2.2"/>' +
    '<g fill="currentColor" opacity=".2"><path d="M14.5 11H23V19.5L19.5 23H11V14.5Z"/><path d="M29.5 11H38V19.5L34.5 23H26V14.5Z"/><path d="M14.5 26H23V34.5L19.5 38H11V29.5Z"/><path d="M44.5 26H53V34.5L49.5 38H41V29.5Z"/><path d="M29.5 41H38V49.5L34.5 53H26V44.5Z"/><path d="M44.5 41H53V49.5L49.5 53H41V44.5Z"/></g>' +
    '<g fill="var(--fel)"><path d="M44.5 11H53V19.5L49.5 23H41V14.5Z"/><path d="M29.5 26H38V34.5L34.5 38H26V29.5Z"/><path d="M14.5 41H23V49.5L19.5 53H11V44.5Z"/></g>';
  return svg;
}

/* ---------------------------------------------------------------- login */
function renderLogin() {
  const invite = S.invite ?? null;
  const href = `/auth/login?returnTo=${encodeURIComponent(S.returnTo ?? "/")}`;
  root.append(h("main", { class: "narrow stack-lg", style: "text-align:center;align-items:center" },
    mark(88),
    invite ? h("p", { class: "eyebrow" }, "You've been invited to") : null,
    h("h1", { text: invite ? invite.title : "Raid Bingo" }),
    invite
      ? h("p", { class: "mono", text: invite.id })
      : h("p", { class: "eyebrow", style: "color:var(--gold);letter-spacing:.34em" }, "Call the night"),
    invite
      ? h("p", { class: "dim" }, invite.closed ? "This game has finished." :
          `${invite.players} ${invite.players === 1 ? "player" : "players"} so far`)
      : h("p", { class: "lede" },
          "Bingo for raid night. Someone makes a card, the raid leader calls the squares, and everyone watches their board tick over in real time."),
    h("a", { class: "btn pri", href, style: "width:min(340px,100%);min-height:48px" }, "Log in with Discord"),
    h("p", { class: "dim", style: "font-style:italic" }, "Discord is how we know you're you. That's all."),
  ));
}

/* ---------------------------------------------------------------- lobby */
function gameCard(g) {
  const filled = Math.round((g.called / ITEM_COUNT) * 5);
  return h("div", { class: "gamecard" },
    h("div", { class: "row" },
      h("span", { style: "font-family:Cinzel,Georgia,serif;font-weight:700;font-size:17px;flex:1", text: g.title }),
      g.closed ? null : h("span", { class: "conn" }, h("i", { class: "dot" }), "LIVE")),
    h("p", { class: "mono", text: g.id }),
    h("div", { class: "row" },
      h("span", { class: "bar" }, Array.from({ length: 5 }, (_, i) => h("i", { class: i < filled ? "on" : "" }))),
      h("span", { class: "dim tabular" }, `${g.marks} of 25 marked`)),
    h("div", { class: "row dim" },
      h("span", null, `${g.players} ${g.players === 1 ? "player" : "players"}`),
      h("span", null, "·"), h("span", null, `as ${g.charName}`),
      g.isOwner ? h("span", { style: "color:var(--gold)" }, "⌂ you own") : null,
      g.bingoAt ? h("span", { class: "badge" }, "BINGO") : null),
    h("a", { class: "btn pri block", href: `/g/${g.id}` }, g.closed ? "Look back" : "Resume"));
}

function renderLobby() {
  const joinInput = h("input", { type: "text", placeholder: "paste it here", autocapitalize: "none", spellcheck: "false" });
  const joinBtn = h("button", { class: "btn" }, "Join");
  const joinNote = h("p", { class: "dim" }, "Three words, dashes between.");
  const go = () => {
    const id = joinInput.value.trim().toLowerCase();
    if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(id)) {
      joinNote.textContent = "That doesn't look like a game ID — it's three words with dashes.";
      joinNote.style.color = "var(--gold)";
      return;
    }
    location.href = `/g/${id}`;
  };
  joinBtn.addEventListener("click", go);
  joinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

  root.append(masthead(), h("main", { class: "wrap stack-lg", style: "padding-block:28px 48px;max-width:840px" },
    h("section", { class: "stack" },
      h("p", { class: "eyebrow" }, "Playing now"),
      S.active.length
        ? h("div", { class: "grid-2" }, S.active.map(gameCard))
        : h("div", { class: "panel" }, h("p", { class: "empty" },
            "No games on the go. Start one, or paste an ID someone sent you."))),
    h("section", { class: "row", style: "align-items:stretch;gap:18px" },
      h("div", { class: "panel", style: "flex:1;min-width:260px;padding:18px" },
        h("p", { class: "eyebrow", style: "margin-bottom:10px" }, "Join with a game ID"),
        h("div", { class: "row", style: "gap:10px;flex-wrap:nowrap" }, joinInput, joinBtn), joinNote),
      h("div", { class: "panel", style: "width:250px;padding:18px;display:flex;flex-direction:column;justify-content:space-between;gap:14px" },
        h("p", { class: "dim" }, "Pick 24 squares and call them yourself."),
        h("a", { class: "btn pri block", href: "/new" }, "+ New game"))),
    S.past.length
      ? h("section", { class: "stack" },
          h("p", { class: "eyebrow" }, "Past games"),
          h("div", { class: "panel" }, S.past.map((g) =>
            h("a", { class: "lrow", href: `/g/${g.id}`, style: "text-decoration:none;color:inherit" },
              h("span", { class: "dim", style: "width:84px;flex:none", text: day(g.createdAt) }),
              h("span", { class: "nm", style: "font-family:Cinzel,Georgia,serif;font-weight:700", text: g.title }),
              h("span", { class: "dim", text: `as ${g.charName}` }),
              g.bingoAt ? h("span", { class: "badge" }, "BINGO") : h("span", { class: "dim" }, "no bingo")))))
      : null,
    h("p", { class: "dim", style: "font-style:italic" },
      "Only games you're in show up here. There's no public list."),
  ), toasts);
}

/* ----------------------------------------------------------------- join */
function renderJoin() {
  const g = S.game;
  const input = h("input", { type: "text", value: S.lastName ?? "", placeholder: "Thalgrim",
    maxlength: "24", autocapitalize: "words", enterkeyhint: "go", spellcheck: "false" });
  const note = h("p", { class: "dim" }, "The character you're raiding on — it's the only way the others know it's you.");
  const suggestions = h("div", { class: "row", style: "gap:9px" });
  const btn = h("button", { class: "btn pri block", style: "min-height:48px" }, "Get my board");

  input.addEventListener("focus", () => input.select());
  const submit = async () => {
    const check = validateCharName(input.value);
    if (!check.ok) { note.textContent = check.reason; note.style.color = "var(--gold)"; return; }
    btn.disabled = true;
    try {
      await api(`/api/games/${g.id}/join`, { charName: check.value });
      location.reload();
    } catch (e) {
      note.textContent = e.message;
      note.style.color = "var(--gold)";
      input.classList.add("bad");
      clear(suggestions);
      for (const s of e.detail?.suggestions ?? []) {
        suggestions.append(h("button", { class: "btn sm", onclick: () => {
          input.value = s; note.textContent = ""; input.classList.remove("bad"); clear(suggestions); btn.disabled = false;
        } }, s));
      }
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  root.append(masthead(), h("main", { class: "narrow stack-lg", style: "text-align:center;align-items:center" },
    h("p", { class: "eyebrow" }, "You've been invited to"),
    h("h1", { text: g.title }),
    h("p", { class: "mono", text: g.id }),
    h("div", { class: "panel", style: "width:100%;padding:24px;text-align:left" },
      h("p", { class: "eyebrow", style: "margin-bottom:10px" }, "Who are you tonight?"),
      input, note, suggestions,
      h("div", { style: "margin-top:16px" }, btn)),
    S.calledCount > 0
      ? h("p", { class: "dim" }, S.calledCount === 1
          ? "One square has already been called — you'll get it."
          : `${S.calledCount} squares have already been called — you'll get them.`)
      : null,
  ), toasts);
}

/* --------------------------------------------------------------- create */
function renderCreate() {
  const title = h("input", { type: "text", placeholder: "Tuesday BT run", maxlength: "40" });
  const values = new Array(ITEM_COUNT).fill("");
  const slotEls = [];
  const counter = h("span", { style: "font-weight:700;color:var(--fel)" });
  const createBtn = h("button", { class: "btn pri" }, "Create game");

  const paste = h("textarea", { placeholder: "One square per line — paste 24 of them." });
  const pasteWrap = h("div", { hidden: true, style: "margin-top:14px" }, paste,
    h("p", { class: "dim", style: "margin-top:8px" }, "One per line. Extra lines are ignored."));

  function refresh() {
    const check = checkItems(values);
    counter.textContent = `${check.filled} of ${ITEM_COUNT} filled`;
    const byIndex = new Map();
    for (const p of check.problems) if (!byIndex.has(p.index)) byIndex.set(p.index, p);
    for (const w of check.warnings) if (!byIndex.has(w.index)) byIndex.set(w.index, { ...w, soft: true });

    slotEls.forEach((slot, i) => {
      const problem = byIndex.get(i);
      const hard = problem && !problem.soft && problem.kind !== "empty";
      slot.el.classList.toggle("filled", values[i] !== "");
      slot.input.classList.toggle("bad", Boolean(hard));
      slot.note.textContent = problem && problem.kind !== "empty" ? problem.message : "";
      slot.note.className = `note ${problem && !problem.soft ? "bad" : "dim"}`;
    });
    createBtn.disabled = !check.ok || title.value.trim() === "";
  }

  for (let i = 0; i < ITEM_COUNT; i++) {
    const input = h("input", { type: "text", maxlength: String(ITEM_MAX + 20) });
    const note = h("p", { class: "note dim" });
    input.addEventListener("input", () => { values[i] = input.value; refresh(); });
    // Multi-line paste into any slot spills into the ones below — no mode switch.
    input.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text.includes("\n")) return;
      e.preventDefault();
      text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .forEach((line, n) => { if (i + n < ITEM_COUNT) { values[i + n] = line; slotEls[i + n].input.value = line; } });
      refresh();
    });
    const el = h("div", { class: "slot" }, h("span", { class: "num", text: String(i + 1) }),
      h("div", { class: "field" }, input, note));
    slotEls.push({ el, input, note });
  }

  paste.addEventListener("input", () => {
    const lines = paste.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < ITEM_COUNT; i++) { values[i] = lines[i] ?? ""; slotEls[i].input.value = values[i]; }
    refresh();
  });

  const useSet = (items) => {
    items.slice(0, ITEM_COUNT).forEach((v, i) => { values[i] = v; slotEls[i].input.value = v; });
    refresh();
    window.scrollTo({ top: document.body.scrollHeight * 0.4, behavior: "smooth" });
  };

  const tabs = h("div", { class: "tabs", style: "max-width:320px;margin:0" },
    h("button", { "aria-selected": "true", onclick: (e) => switchMode(e, false) }, "Type one by one"),
    h("button", { "aria-selected": "false", onclick: (e) => switchMode(e, true) }, "Paste a list"));
  const slotsWrap = h("div", { class: "slots" }, slotEls.map((s) => s.el));
  function switchMode(e, pasting) {
    [...tabs.children].forEach((b) => b.setAttribute("aria-selected", String(b === e.target)));
    slotsWrap.hidden = pasting; pasteWrap.hidden = !pasting;
  }

  title.addEventListener("input", refresh);
  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    try {
      const { id } = await api("/api/games", { title: title.value, items: values });
      location.href = `/g/${id}`;
    } catch (e) { toast(e.message, { kind: "warn" }); createBtn.disabled = false; }
  });

  root.append(masthead(), h("main", { class: "wrap stack-lg", style: "padding-block:26px 56px;max-width:940px" },
    h("div", null, h("a", { class: "dim", href: "/", style: "text-decoration:none" }, "‹ Lobby"),
      h("h1", { style: "margin-top:6px;letter-spacing:.06em;text-transform:uppercase" }, "New game")),
    h("section", { class: "stack" },
      h("p", { class: "eyebrow" }, "Title"),
      h("div", { style: "max-width:420px" }, title),
      h("p", { class: "dim" }, "Seen in the lobby and in Discord. 40 characters.")),
    S.previous.length
      ? h("section", { class: "stack" },
          h("p", { class: "eyebrow" }, "Start from"),
          h("div", { class: "cards" }, S.previous.map((p) =>
            h("div", { class: "card" },
              h("span", { style: "font-family:Cinzel,Georgia,serif;font-weight:700;font-size:14px", text: p.title }),
              h("span", { class: "dim", text: `${day(p.createdAt)} · ${p.items.length}` }),
              h("span", { class: "sample", text: p.items.slice(0, 2).map((t) => `“${t}”`).join(", ") + "…" }),
              h("button", { class: "btn sm", onclick: () => useSet(p.items) }, "Use it")))))
      : null,
    h("section", { class: "stack" },
      h("div", { class: "row" },
        h("p", { class: "eyebrow", style: "margin:0" }, "Squares"), h("div", { class: "spacer" }), tabs),
      h("div", { class: "row" }, counter,
        h("span", { class: "dim" }, "Order doesn't matter — every player's board is shuffled.")),
      slotsWrap, pasteWrap),
    h("div", { class: "row", style: "border-top:1px solid var(--line);padding-top:18px" },
      h("p", { class: "dim", style: "flex:1;min-width:240px" },
        "Title stays editable. Squares lock for good the moment the first player joins."),
      h("a", { class: "btn quiet", href: "/" }, "Cancel"), createBtn),
  ), toasts);
  refresh();
}

/* ---------------------------------------------------------------- board */
function renderBoard() {
  let game = S.game;
  const owner = game.isOwner;
  const board = game.board;
  let called = new Map(game.called);
  const pending = new Map();      // itemIndex -> timeout id
  let connState = "live";
  let justCalled = null;

  const grid = h("div", { class: "grid" });
  const well = h("div", { class: "board-well" }, grid);
  const conn = h("span", { class: "conn" }, h("i", { class: "dot" }), h("span", null, "Live"));
  const tallyCalled = h("span", { class: "n fel tabular" });
  const tallyLine = h("span", { class: "n tabular" });
  const tallyRaid = h("span", { class: "n tabular" });
  const banner = h("div", { class: "banner", hidden: true });
  const rosterBody = h("div", { class: "body" });
  const logBody = h("div", { class: "body" });
  const filter = h("input", { type: "text", placeholder: "filter items…" });

  /* one fitted size for the whole grid — 25 different sizes reads as a ransom note */
  const ruler = h("div", { style: "position:absolute;visibility:hidden;left:-9999px;top:0;font-family:inherit;line-height:1.18;font-weight:500" });
  document.body.append(ruler);
  function fit() {
    const cell = grid.firstElementChild;
    if (!cell) return;
    const box = cell.getBoundingClientRect();
    if (box.width < 10) return;
    const phone = window.innerWidth < 700;
    const lo = phone ? 9.5 : 11, hi = phone ? 12.5 : 14.5;
    let minH = phone ? 86 : 104;
    ruler.style.width = `${box.width - (phone ? 12 : 12)}px`;
    for (let grow = 0; grow < 4; grow++) {
      let best = lo;
      for (let size = hi; size >= lo; size -= 0.5) {
        ruler.style.fontSize = `${size}px`;
        let fits = true;
        for (const item of game.items) {
          ruler.textContent = item;
          if (ruler.scrollHeight > minH - 20) { fits = false; break; }
        }
        if (fits) { best = size; break; }
      }
      document.documentElement.style.setProperty("--cell-font", `${best}px`);
      document.documentElement.style.setProperty("--cell-min", `${minH}px`);
      if (best > lo) return;
      minH += 6;
    }
  }

  function draw() {
    const calledSet = new Set(called.keys());
    const wins = winningCells(board, calledSet);
    clear(grid);

    board.forEach((item, pos) => {
      if (pos === FREE_CELL) {
        grid.append(h("div", { class: "cell free" + (wins.has(pos) ? " win" : "") }, "Callstone"));
        return;
      }
      const on = calledSet.has(item);
      const cls = ["cell", wins.has(pos) ? "win" : on ? "on" : "", pending.has(item) ? "pending" : ""].filter(Boolean).join(" ");
      const cell = h("button", { class: cls, type: "button",
        "data-just-called": justCalled === item ? "" : null,
        "aria-pressed": on ? "true" : "false",
        onclick: () => openSheet(item, on) },
        h("span", { class: "t", text: game.items[item] }));
      grid.append(cell);
    });
    justCalled = null;

    tallyCalled.textContent = `${calledSet.size}/${ITEM_COUNT}`;
    const best = Math.max(...[[0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
      [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],[0,6,12,18,24],[4,8,12,16,20]]
      .map((line) => line.filter((p) => isMarked(board, p, calledSet)).length));
    tallyLine.textContent = `${best}/5`;
    tallyRaid.textContent = String(game.roster.length);

    const me = game.roster.find((r) => r.charName === game.charName);
    if (me?.bingoAt) {
      const winners = game.roster.filter((r) => r.bingoAt).sort((a, b) => a.bingoAt - b.bingoAt);
      const at = me.bingoAt;
      const joint = winners.filter((w) => w.bingoAt === at && w.charName !== me.charName).map((w) => w.charName);
      const place = winners.findIndex((w) => w.charName === me.charName) + 1;
      clear(banner).append(h("strong", null, "BINGO"), h("span", { class: "dim" },
        joint.length
          ? `Joint ${ordinal(place)} with ${joint.join(" and ")}, ${clock(at)} — screenshot it before anyone argues.`
          : place === 1
            ? `First tonight, ${clock(at)} — screenshot it before anyone argues.`
            : `${ordinal(place)} tonight, ${clock(at)}.`));
      banner.hidden = false;
    } else banner.hidden = true;

    clear(rosterBody);
    if (!game.roster.length) rosterBody.append(h("p", { class: "empty" }, "Nobody has joined yet."));
    for (const r of game.roster) {
      rosterBody.append(h("div", { class: `lrow ${r.you ? "me" : ""}` },
        h("span", { class: "nm", text: r.charName }),
        r.bingoAt ? h("span", { class: "badge" }, "BINGO") : null,
        h("span", { class: "dim tabular" }, `${r.marks}/25`)));
    }

    clear(logBody);
    const recent = [...called.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!recent.length) logBody.append(h("p", { class: "empty" }, "Nothing called yet tonight."));
    for (const [item, at] of recent) {
      logBody.append(h("div", { class: "lrow" },
        h("span", { class: "nm", style: "white-space:normal", text: game.items[item] }),
        h("span", { class: "dim" }, clock(at)),
        owner ? h("button", { class: "btn quiet sm", title: `Undo call: ${game.items[item]}`,
          onclick: () => send("undo", item) }, "↩") : null));
    }

    fit();
  }

  const ordinal = (n) => ["", "1st", "2nd", "3rd"][n] ?? `${n}th`;

  /* ---- the sheet: how you read a square, and how the owner calls one ---- */
  function openSheet(item, isOn) {
    const desktop = window.innerWidth >= 700;
    if (owner && desktop) { send(isOn ? "undo" : "call", item); return; }
    const at = called.get(item);
    const scrim = h("div", { class: "sheet-scrim", onclick: close });
    const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" },
      h("div", { class: "grab" }),
      h("p", { class: "eyebrow", style: owner ? "color:var(--fel)" : "" },
        owner && !isOn ? "Call this square" : isOn ? `Called at ${clock(at)}` : "Not called yet"),
      h("p", { class: "phrase", text: game.items[item] }),
      owner ? h("p", { class: "dim", style: "margin-bottom:14px" },
        isOn ? `Unticks on all ${game.roster.length} boards.` : `Ticks on all ${game.roster.length} boards at once.`) : null,
      owner ? h("button", { class: `btn block ${isOn ? "" : "pri"}`, style: "min-height:52px" + (isOn ? ";border-color:var(--fel);color:var(--fel)" : ""),
        onclick: () => { close(); send(isOn ? "undo" : "call", item); } }, isOn ? "UNDO CALL" : "CALL IT") : null,
      h("button", { class: "btn quiet block", onclick: close }, owner ? "Cancel" : "Close"));
    function close() { scrim.remove(); sheet.remove(); document.removeEventListener("keydown", esc); }
    function esc(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", esc);
    document.body.append(scrim, sheet);
  }

  /* --------- calls: optimistic, with a defined death if no ack comes -------- */
  async function send(kind, item) {
    if (connState !== "live") { toast("Reconnecting — calls are paused."); return; }
    if (pending.has(item)) return;                        // 400ms inert window below

    if (kind === "call") { called.set(item, Date.now()); justCalled = item; }
    else called.delete(item);
    pending.set(item, setTimeout(() => {
      pending.delete(item);
      if (kind === "call") called.delete(item); else called.set(item, Date.now());
      draw();
      toast("That call didn't reach the server.", {
        kind: "warn", sticky: true,
        actions: [{ label: "Try again", run: () => send(kind, item) }, { label: "Dismiss", run: () => {} }],
      });
    }, 5000));
    draw();

    try {
      const res = await api(`/api/games/${game.id}/${kind}`, { item });
      clearTimeout(pending.get(item)); pending.delete(item);
      if (res.game) apply(res.game);
      setTimeout(() => {}, 0);
    } catch (e) {
      clearTimeout(pending.get(item)); pending.delete(item);
      if (kind === "call") called.delete(item); else called.set(item, Date.now());
      draw();
      toast(e.message, { kind: "warn" });
    }
  }

  function apply(next) {
    game = { ...game, ...next, board };
    called = new Map(next.called);
    draw();
  }

  /* ------------------------------ live feed ------------------------------ */
  let socket = null, backoff = 1000, downSince = 0, restarting = false;
  function setConn(state, label) {
    connState = state;
    conn.setAttribute("data-state", state === "live" ? "live" : state);
    conn.lastChild.textContent = label;
    well.setAttribute("data-conn", state === "live" ? "up" : "down");
  }
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws/${game.id}`);
    socket.addEventListener("open", () => {
      backoff = 1000; restarting = false; downSince = 0;
      setConn("live", "Live");
    });
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "goodbye") { restarting = true; setConn("down", "Restarting — back in a moment"); return; }
      if (msg.type !== "state") return;
      // Full state replaces local state; deltas are never merged across a gap.
      called = new Map(msg.called);
      game = { ...game, closed: msg.closed,
        roster: msg.roster.map((r) => ({ ...r, you: r.charName === game.charName })) };
      draw();
    });
    socket.addEventListener("close", () => {
      if (!downSince) downSince = Date.now();
      const elapsed = Date.now() - downSince;
      if (elapsed < 3000) setConn("live", "Live");           // don't flicker on a blip
      else if (restarting) setConn("down", "Restarting — back in a moment");
      else if (elapsed > 20000) setConn("stale", "Offline — this board is stale");
      else setConn("down", "Reconnecting…");
      const wait = restarting ? Math.min(2000, backoff) : Math.min(15000, backoff);
      backoff = Math.min(15000, backoff * 1.7);
      setTimeout(connect, wait + Math.random() * 400);
    });
    socket.addEventListener("error", () => socket.close());
  }

  // No "call a square" list: every item is on the owner's own board, so the
  // list only ever duplicated it — and it pushed standings below the fold.
  const rail = h("aside", { class: "stack" },
    h("div", { class: "panel" }, h("h2", null, h("span", null, "Standings"),
      h("span", { class: "dim tabular", text: String(game.roster.length) })), rosterBody),
    h("div", { class: "panel" }, h("h2", null, h("span", null, "Call log")), logBody));

  root.append(masthead(), h("main", { class: "wrap", style: "padding-block:22px 48px" },
    h("div", { class: "row", style: "gap:10px 24px" },
      h("div", { style: "flex:1;min-width:260px" },
        h("p", { class: "eyebrow" }, owner ? "Owner · you are the caller" : `Playing as ${game.charName}`),
        h("h1", { text: game.title }),
        h("p", { class: "mono", style: "margin-top:6px", text: game.id })),
      h("div", { class: "tally" },
        h("div", { style: "text-align:right" }, tallyCalled, h("span", { class: "eyebrow" }, "Called")),
        h("div", { style: "text-align:right" }, tallyLine, h("span", { class: "eyebrow" }, "Best line")),
        h("div", { style: "text-align:right" }, tallyRaid, h("span", { class: "eyebrow" }, "Raiders")))),
    h("div", { class: "row", style: "margin-top:14px;gap:10px" }, conn,
      game.closed ? h("span", { class: "dim" }, "· this game is closed") : null,
      h("div", { class: "spacer" }),
      h("button", { class: "btn quiet sm", onclick: async () => {
        await navigator.clipboard?.writeText(`${location.origin}/g/${game.id}`);
        toast("Link copied. The Discord preview freezes when it's pasted.");
      } }, "Copy link"),
      owner && !game.closed ? h("button", { class: "btn quiet sm", onclick: async () => {
        if (!confirm("Close this game? No more squares can be called.")) return;
        await api(`/api/games/${game.id}/close`); location.reload();
      } }, "Close game") : null),
    h("div", { class: `callbar ${owner ? "owner" : ""}`, style: "margin-top:12px" },
      owner ? "⚑ Caller — tap a square when it happens. Tap it again to undo."
            : "Five in a row wins. Tap any square to read it."),
    h("div", { class: "layout" },
      h("section", null, well,
        h("div", { class: "legend" },
          h("span", null, h("i"), "Not called"),
          h("span", null, h("i", { class: "on" }), "Called"),
          h("span", null, h("i", { class: "win" }), "Winning line")),
        banner),
      rail)), toasts);

  draw();
  connect();
  window.addEventListener("resize", () => { clearTimeout(fit._t); fit._t = setTimeout(fit, 120); });
}

/* --------------------------------------------------------------- router */
const views = { login: renderLogin, lobby: renderLobby, join: renderJoin, create: renderCreate, board: renderBoard };
(views[S.view] ?? renderLogin)();
