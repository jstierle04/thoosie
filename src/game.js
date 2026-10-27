(function () {
  "use strict";

  const MAX_GUESSES = 8;
  const STORAGE_KEY = "thoosie:v1";
  const EPOCH = new Date(2026, 0, 1); // puzzle No. 1
  const SHUFFLE_SEED = 0x7400513; // changing this reorders every unfrozen puzzle (see dailyAnswerFor)
  const CLOSE = { year: 5, height: 25, speed: 8, inversions: 2 };

  const FIELDS = [
    { key: "park", label: "Park", kind: "exact" },
    { key: "country", label: "Country", kind: "country" },
    { key: "maker", label: "Maker", kind: "exact" },
    { key: "type", label: "Type", kind: "exact" },
    { key: "year", label: "Opened", kind: "number" },
    { key: "height", label: "Height", kind: "number", unit: " ft" },
    { key: "speed", label: "Speed", kind: "number", unit: " mph" },
    { key: "inversions", label: "Inversions", kind: "number" },
  ];

  const SHARE_GLYPH = { hit: "🟩", close: "🟨", miss: "⬛" };

  // Trivia mode: one generated puzzle per day (scripts/generate_trivia.py)
  const TRIVIA_DIR = "data/trivia/";
  const TRIVIA_FIRST = "2026-10-13"; // earliest puzzle; the archive picker starts here
  const TRIVIA_MAX = 6; // most clues a puzzle can have; sizes the stats chart
  const SKIP = "__skip"; // a "Next clue" press, stored in place of a guess
  const CLUE_LABEL = { stats: "Stats", fact: "Fun fact", park: "The park", name: "Name clue" };

  // Link added to shared results. Set this once the game has a permanent home (e.g.
  // "https://thoosie.com"); until then it uses the address the page was loaded from.
  const GAME_URL = "";

  function gameLink() {
    if (GAME_URL) return GAME_URL;
    if (!/^https?:$/.test(location.protocol)) return ""; // opened as a local file: nothing shareable
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  // ---------- Data ----------

  // _n/_p/_a: normalized name, park and old name, precomputed for autocomplete
  const COASTERS = window.COASTERS.map((c) => ({
    ...c,
    id: slug(c.name + " " + c.park),
    _n: norm(c.name),
    _p: norm(c.park),
    _a: c.aka ? norm(c.aka) : "",
  }));
  const BY_ID = new Map(COASTERS.map((c) => [c.id, c]));

  function slug(s) {
    return norm(s).replace(/\s+/g, "-");
  }

  function norm(s) {
    return s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- Daily puzzle ----------

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(list, seed) {
    const rand = mulberry32(seed);
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function todayNumber() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - EPOCH) / 86400000) + 1; // round absorbs DST shifts
  }

  // ?day=N plays a specific puzzle without touching saved stats (handy for testing)
  const override = parseInt(new URLSearchParams(location.search).get("day"), 10);
  const practice = Number.isFinite(override) && override > 0;
  const puzzleNo = practice ? override : todayNumber();
  // Every coaster is guessable; only the answer pool (built by the importer) can be the answer.
  const POOL = COASTERS.some((c) => c.answer) ? COASTERS.filter((c) => c.answer) : COASTERS;
  const dailyAnswer = dailyAnswerFor(puzzleNo);

  // Days 1..SCHEDULE.length are frozen (data/schedule.js, written by scripts/schedule.py) so that
  // changing the pool never moves a played puzzle. Later days go through the pool shuffled,
  // not-yet-used coasters first. Keep in step with scripts/schedule.py.
  function dailyAnswerFor(n) {
    const frozen = window.SCHEDULE || [];
    const byPage = new Map(COASTERS.map((c) => [c.page, c]));
    if (n <= frozen.length && byPage.has(frozen[n - 1])) return byPage.get(frozen[n - 1]);
    const used = new Set(frozen);
    const order = shuffled(POOL.filter((c) => !used.has(c.page)), SHUFFLE_SEED).concat(
      shuffled(POOL.filter((c) => used.has(c.page)), SHUFFLE_SEED)
    );
    const k = n > frozen.length ? n - frozen.length : n; // (a frozen day whose coaster was removed: any will do)
    return order[(k - 1) % order.length];
  }
  // infinite mode won't repeat a coaster until this many others have come up
  const RECENT_LIMIT = Math.min(30, Math.floor(POOL.length / 2));

  // ---------- Storage ----------

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* private mode etc. — game still works, just doesn't persist */
    }
  }

  function newGame() {
    return { guesses: [], done: false, won: false };
  }

  const store = loadStore();
  store.games = store.games || {};

  // practice games (?day=N) are never added to the store, so they never touch stats
  const dailyGame = (practice ? null : store.games[puzzleNo]) || newGame();
  if (!practice) store.games[puzzleNo] = dailyGame;

  const inf = (store.infinite = store.infinite || {
    current: null,
    recent: [],
    played: 0,
    won: 0,
    streak: 0,
    best: 0,
    dist: Array(MAX_GUESSES).fill(0),
  });
  if (inf.current && !BY_ID.has(inf.current.answer)) inf.current = null; // answer dropped from data

  function startInfinite() {
    // skip recent answers, and today's daily so infinite can't spoil it
    const recent = new Set(inf.recent);
    const fresh = POOL.filter((c) => !recent.has(c.id) && c.id !== dailyAnswer.id);
    const choices = fresh.length ? fresh : POOL;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    inf.current = { answer: pick.id, ...newGame() };
    inf.recent = [...inf.recent, pick.id].slice(-RECENT_LIMIT);
    saveStore();
  }

  function recordInfinite() {
    inf.played++;
    if (game.won) {
      inf.won++;
      inf.streak++;
      inf.best = Math.max(inf.best, inf.streak);
      inf.dist[game.guesses.length - 1]++;
    } else {
      inf.streak = 0;
    }
  }

  function localDate(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ?trivia=YYYY-MM-DD plays that day's trivia from the archive without touching stats
  // (the picker only offers past days; typing a future date in the URL is for reviewing puzzles)
  const triviaOverride = new URLSearchParams(location.search).get("trivia") || "";
  const triviaPractice = /^\d{4}-\d{2}-\d{2}$/.test(triviaOverride) && triviaOverride !== localDate();
  const triviaDate = triviaPractice ? triviaOverride : localDate();
  const triviaStore = (store.trivia = store.trivia || { games: {} });
  triviaStore.archive = triviaStore.archive || {}; // archive games: saved so a reload keeps progress, but never in stats
  // status: idle → loading → ready | missing
  const trivia = { status: "idle", puzzle: null, answer: null, practiceGame: null, fresh: false };

  function triviaGame() {
    if (triviaPractice) {
      // a day you played when it was live shows that game; otherwise it's an archive game
      const live = triviaStore.games[triviaDate];
      if (live && live.done) return live;
      return (triviaStore.archive[triviaDate] = triviaStore.archive[triviaDate] || newGame());
    }
    return (triviaStore.games[triviaDate] = triviaStore.games[triviaDate] || newGame());
  }

  async function loadTrivia() {
    trivia.status = "loading";
    try {
      const res = await fetch(`${TRIVIA_DIR}${triviaDate}.json`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const puzzle = await res.json();
      const a = puzzle.answer || {};
      trivia.answer = COASTERS.find((c) => c.page === a.page) || BY_ID.get(slug(`${a.name} ${a.park}`));
      if (!trivia.answer) throw new Error(`answer "${a.name}" isn't in the coaster list`);
      if (!puzzle.clues || !puzzle.clues.length) throw new Error("puzzle has no clues");
      trivia.puzzle = puzzle;
      trivia.status = "ready";
    } catch (err) {
      trivia.status = "missing";
      console.warn(`Trivia for ${triviaDate} unavailable:`, err);
    }
    if (mode === "trivia") {
      useMode("trivia");
      renderAll();
    }
  }

  // Trivia is the main mode: the game always opens on it, except for practice links and
  // ?mode=daily|infinite (used when leaving practice, since that reloads the page)
  const modeParam = new URLSearchParams(location.search).get("mode");
  let mode = practice ? "daily" : triviaPractice ? "trivia" : ["daily", "infinite"].includes(modeParam) ? modeParam : "trivia";
  let answer;
  let game;

  function useMode(m) {
    mode = m;
    if (m === "infinite") {
      if (!inf.current) startInfinite();
      game = inf.current;
      answer = BY_ID.get(game.answer);
    } else if (m === "trivia") {
      game = triviaGame();
      answer = trivia.answer;
      if (trivia.status === "idle") loadTrivia();
    } else {
      game = dailyGame;
      answer = dailyAnswer;
    }
    game.guesses = game.guesses.filter((id) => id === SKIP || BY_ID.has(id));
  }

  function maxGuesses() {
    if (mode !== "trivia") return MAX_GUESSES;
    return trivia.puzzle ? trivia.puzzle.clues.length : 0;
  }

  const triviaReady = () => mode === "trivia" && trivia.status === "ready";

  // ---------- Scoring ----------

  function compare(guess) {
    return FIELDS.map((f) => {
      const g = guess[f.key];
      const a = answer[f.key];
      let status = "miss";
      let dir = "";
      if (g === a) status = "hit";
      else if (f.kind === "country") status = guess.continent === answer.continent ? "close" : "miss";
      else if (f.kind === "number") {
        status = Math.abs(g - a) <= CLOSE[f.key] ? "close" : "miss";
        dir = a > g ? "up" : "down";
      }
      return { field: f, value: g, status, dir };
    });
  }

  // ---------- DOM ----------

  const $ = (id) => document.getElementById(id);
  const els = {
    puzzleNo: $("puzzle-no"),
    punches: $("punches"),
    form: $("guess-form"),
    input: $("guess-input"),
    submit: document.querySelector("#guess-form .ride-btn"),
    list: $("suggestions"),
    guesses: $("guesses"),
    result: $("result"),
    help: $("help"),
    stats: $("stats"),
    statsBody: $("stats-body"),
    toast: $("toast"),
    modeTabs: document.querySelectorAll(".mode-tab"),
    classicModes: $("classic-modes"),
    triviaTools: $("trivia-tools"),
    hard: $("hard-mode"),
    archiveDate: $("archive-date"),
    clues: $("clues"),
    skip: $("skip-btn"),
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function renderPunches() {
    const total = maxGuesses();
    const left = total - game.guesses.length;
    els.punches.innerHTML = Array.from({ length: total }, (_, i) =>
      `<span class="punch${i < game.guesses.length ? " used" : ""}"></span>`
    ).join("");
    els.punches.setAttribute("aria-label", `${left} guess${left === 1 ? "" : "es"} left`);
  }

  function ticket(coaster, n, fresh) {
    const li = document.createElement("li");
    const won = coaster.id === answer.id;
    li.className = "ticket" + (fresh ? " fresh" : "");
    const cells = compare(coaster)
      .map(({ field, value, status, dir }, i) => {
        const arrow = dir
          ? `<span class="arrow" aria-label="answer is ${dir === "up" ? "higher" : "lower"}">${dir === "up" ? "↑" : "↓"}</span>`
          : "";
        return `<div class="cell ${status === "miss" ? "" : status}" style="--i:${i}">
          <span class="cell-label">${field.label}</span>
          <span class="cell-value"><span>${esc(value)}${field.unit || ""}</span>${arrow}</span>
        </div>`;
      })
      .join("");
    li.innerHTML = `
      <div class="ticket-head">
        <span class="ticket-no">${String(n).padStart(2, "0")}</span>
        <span class="ticket-name">${esc(coaster.name)}</span>
        <span class="ticket-park">${esc(coaster.park)}</span>
        ${won ? `<span class="stamp">Credit!</span>` : ""}
      </div>
      <div class="cells">${cells}</div>`;
    return li;
  }

  function renderGuesses() {
    els.guesses.innerHTML = "";
    game.guesses.forEach((id, i) => els.guesses.prepend(ticket(BY_ID.get(id), i + 1, false)));
  }

  function renderClues() {
    if (trivia.status !== "ready") {
      const msg = trivia.status === "missing"
        ? triviaPractice
          ? `There's no trivia puzzle for ${shortDate(triviaDate)}. Pick another day.`
          : `Today's trivia isn't ready yet. Check back soon, or play the Daily coaster.`
        : triviaPractice ? "Loading trivia…" : "Loading today's trivia…";
      els.clues.innerHTML = `<li class="clue clue-note">${esc(msg)}</li>`;
      return;
    }
    const clues = trivia.puzzle.clues;
    // a clue unlocks per guess made; finishing reveals the rest
    const shown = game.done ? clues.length : Math.min(game.guesses.length + 1, clues.length);
    const attempt = (id) => {
      if (!id) return "";
      if (id === SKIP) return `<p class="clue-attempt skipped">Skipped</p>`;
      const c = BY_ID.get(id);
      const hit = id === answer.id;
      const park = hit || !game.hard ? ` <span>${esc(c.park)}</span>` : ""; // a typed name can match several parks
      return `<p class="clue-attempt ${hit ? "hit" : "miss"}">${hit ? "✓" : "✗"} ${esc(c.name)}${park}</p>`;
    };
    els.clues.innerHTML = clues
      .map((clue, i) => {
        const head = `<div class="clue-head"><span class="ticket-no">${String(i + 1).padStart(2, "0")}</span>
          <span class="clue-kind">${esc(CLUE_LABEL[clue.kind] || "Clue")}</span></div>`;
        if (i >= shown) {
          return `<li class="clue locked">${head}<p class="clue-text">Unlocks after a miss</p></li>`;
        }
        const fresh = trivia.fresh && i === shown - 1 && !game.done;
        return `<li class="clue${fresh ? " fresh" : ""}">${head}<p class="clue-text">${esc(clue.text)}</p>${attempt(game.guesses[i])}</li>`;
      })
      .join("");
    trivia.fresh = false;
  }

  function renderResult() {
    if (mode === "trivia" && !triviaReady()) {
      els.result.hidden = true;
      return;
    }
    if (!game.done) {
      els.result.hidden = true;
      return;
    }
    const a = answer;
    const infinite = mode === "infinite";
    const isTrivia = mode === "trivia";
    const lost = infinite ? "Out of tickets. It was"
      : isTrivia ? `Out of clues. ${triviaPractice ? "The" : "Today's"} coaster was` : "Out of tickets. Today's coaster was";
    const tries = game.guesses.length;
    const won = isTrivia ? `Got it on clue ${tries}${game.hard ? ", in hard mode" : ""}.` : `Got it in ${tries}. Credit counted.`;
    let actions = `<button type="button" class="ride-btn" id="share-btn">Share</button>`;
    if (infinite) actions = `<button type="button" class="ride-btn next-btn" id="next-btn">Next coaster →</button>` + actions;
    else if (!(isTrivia ? triviaPractice : practice)) {
      actions += `<span class="countdown">Next ${isTrivia ? "trivia" : "coaster"} in <span id="countdown">--:--:--</span></span>`;
    }
    const credits = isTrivia && trivia.puzzle.review && trivia.puzzle.review.sources
      ? `<p class="result-credit">Clues written by AI from ${trivia.puzzle.review.sources
          .map((src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener">${src.name === "wikipedia" ? "Wikipedia" : "Coasterpedia"}</a>`)
          .join(" and ")}.</p>`
      : "";
    els.result.innerHTML = `
      <p class="result-kicker">${game.won ? won : lost}</p>
      <h2 class="result-name">${esc(a.name)}</h2>
      <p class="result-park">${esc(a.park)} &middot; ${esc(a.country)}${
        a.page ? ` &middot; <a href="https://coasterpedia.net/wiki/${encodeURIComponent(a.page.replace(/ /g, "_"))}" target="_blank" rel="noopener">Coasterpedia&nbsp;↗</a>` : ""
      }</p>
      <div class="result-stats">
        <span><b>${esc(a.maker)}</b></span>
        <span>${esc(a.type)}</span>
        <span>Opened <b>${a.year}</b></span>
        <span><b>${a.height}</b> ft</span>
        <span><b>${a.speed}</b> mph</span>
        <span><b>${a.inversions}</b> inversions</span>
      </div>
      <div class="result-actions">${actions}</div>${credits}`;
    els.result.hidden = false;
    $("share-btn").addEventListener("click", share);
    if (infinite) $("next-btn").addEventListener("click", nextInfinite);
    tickCountdown();
  }

  function renderInput() {
    const unavailable = mode === "trivia" && !triviaReady();
    const locked = game.done || unavailable;
    els.input.disabled = locked;
    els.submit.disabled = locked;
    if (unavailable) els.input.placeholder = trivia.status !== "missing" ? "Loading trivia…" : triviaPractice ? "No puzzle that day" : "No trivia today yet";
    else if (!locked) els.input.placeholder = isHard() ? "Type the coaster's name…" : "Name a coaster or park…";
    else els.input.placeholder = mode === "infinite" ? "Ride again: hit Next coaster"
      : mode === "trivia" && triviaPractice ? "Pick another day above" : "Come back tomorrow…";
    // "Next clue" only while there's another clue to reveal
    els.skip.hidden = !triviaReady() || game.done || game.guesses.length + 1 >= maxGuesses();
  }

  function shortDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  let renderGen = 0; // bumps on every full re-render so stale reveal timers can bail

  function renderAll() {
    renderGen++;
    document.body.dataset.mode = mode;
    if (mode === "infinite") els.puzzleNo.textContent = `Infinite · Ride ${inf.played + (game.done ? 0 : 1)}`;
    else if (mode === "trivia") els.puzzleNo.textContent = `Trivia · ${shortDate(triviaDate)}${triviaPractice ? " (archive)" : ""}`;
    else els.puzzleNo.textContent = `No. ${String(puzzleNo).padStart(3, "0")}${practice ? " (practice)" : ""}`;
    const tabMode = (m) => (m === "classic" ? mode !== "trivia" : m === mode);
    els.modeTabs.forEach((tab) => tab.setAttribute("aria-selected", String(tabMode(tab.dataset.mode))));
    els.classicModes.hidden = mode === "trivia";
    els.triviaTools.hidden = mode !== "trivia";
    renderHardToggle();
    renderPunches();
    els.guesses.hidden = mode === "trivia";
    els.clues.hidden = mode !== "trivia";
    if (mode === "trivia") renderClues();
    else renderGuesses();
    renderInput();
    renderResult();
  }

  // ---------- Autocomplete ----------

  let matches = [];
  let active = -1;

  function rank(c, q) {
    const n = c._n;
    if (n.startsWith(q)) return 0;
    if (n.includes(" " + q)) return 1;
    if (n.includes(q)) return 2;
    if (c._a.includes(q)) return 3; // old name
    return 4; // park match
  }

  function findMatches(raw) {
    const q = norm(raw);
    if (!q) return [];
    const guessed = new Set(game.guesses);
    return COASTERS.filter((c) => !guessed.has(c.id) && (c._n.includes(q) || c._p.includes(q) || c._a.includes(q)))
      .sort((a, b) => rank(a, q) - rank(b, q) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }

  function highlight(text, raw) {
    const q = raw.trim().toLowerCase();
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function renderSuggestions() {
    const raw = els.input.value;
    if (!matches.length) {
      closeSuggestions();
      return;
    }
    els.list.innerHTML = matches
      .map((c, i) => `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}">
          <span class="s-name">${highlight(c.name, raw)}</span>
          <span class="s-park">${highlight(c.park, raw)}${
            c._a && !c._n.includes(norm(raw)) && c._a.includes(norm(raw)) ? ` · aka ${highlight(c.aka, raw)}` : ""
          }</span>
        </li>`)
      .join("");
    els.list.hidden = false;
    els.input.setAttribute("aria-expanded", "true");
    if (active >= 0) {
      els.input.setAttribute("aria-activedescendant", `opt-${active}`);
      $(`opt-${active}`).scrollIntoView({ block: "nearest" });
    } else {
      els.input.removeAttribute("aria-activedescendant");
    }
  }

  function closeSuggestions() {
    els.list.hidden = true;
    els.list.innerHTML = "";
    els.input.setAttribute("aria-expanded", "false");
    els.input.removeAttribute("aria-activedescendant");
  }

  els.input.addEventListener("input", () => {
    if (isHard()) return closeSuggestions();
    matches = findMatches(els.input.value);
    active = matches.length ? 0 : -1;
    renderSuggestions();
  });

  els.input.addEventListener("keydown", (e) => {
    if (els.list.hidden || !matches.length) return;
    if (e.key === "ArrowDown") active = (active + 1) % matches.length;
    else if (e.key === "ArrowUp") active = (active - 1 + matches.length) % matches.length;
    else if (e.key === "Escape") return closeSuggestions();
    else return;
    e.preventDefault();
    renderSuggestions();
  });

  // mousedown keeps focus in the input; the pick happens on click, so a touch-scroll
  // through the list doesn't accidentally choose whatever the finger landed on
  els.list.addEventListener("mousedown", (e) => e.preventDefault());
  els.list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) submitGuess(matches[Number(li.dataset.i)]);
  });

  els.input.addEventListener("blur", () => setTimeout(closeSuggestions, 100));

  // ---------- Trivia hard mode ----------
  // No suggestions: the typed name is matched forgivingly (case, punctuation, accents, a leading
  // "the", spaces, the part before a colon, old names, and a typo or two in longer names).
  // A game keeps the mode it started in; the toggle only changes games that haven't started.

  function isHard() {
    if (mode !== "trivia") return false;
    return game && game.guesses.length ? !!game.hard : !!store.triviaHard;
  }

  function nameKeys(c) {
    const keys = new Set();
    for (const n of [c.name, c.aka || ""]) {
      if (!n) continue;
      keys.add(typedKey(n));
      if (/[:–—]/.test(n)) keys.add(typedKey(n.split(/[:–—]/)[0])); // "Gotham City Gauntlet: Escape from…"
    }
    keys.delete("");
    return keys;
  }

  function typedKey(s) {
    return norm(s).replace(/^the /, "").replace(/ /g, "");
  }

  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function resolveTyped(raw) {
    const q = typedKey(raw);
    if (!q) return null;
    const slack = q.length >= 12 ? 2 : q.length >= 6 ? 1 : 0;
    const close = (c, d) => [...nameKeys(c)].some((k) => editDistance(q, k, d) <= d);
    // the answer first, so a near-miss spelling of it isn't mistaken for a similar-named coaster
    if (close(answer, slack)) return game.guesses.includes(answer.id) ? null : answer;
    const unguessed = COASTERS.filter((c) => !game.guesses.includes(c.id));
    const exact = unguessed.filter((c) => close(c, 0));
    if (exact.length) return exact[0]; // same name at several parks: any of them is "not it"
    const near = unguessed.filter((c) => close(c, slack));
    return near.length === 1 ? near[0] : null;
  }

  function renderHardToggle() {
    els.hard.checked = isHard();
    // can't switch mid-game, either way
    els.hard.disabled = mode === "trivia" && game.guesses.length > 0 && !game.done;
    els.hard.parentElement.title = els.hard.disabled
      ? "Hard mode can't be switched mid-puzzle"
      : "No suggestions: type the coaster's name yourself";
  }

  els.hard.addEventListener("change", () => {
    store.triviaHard = els.hard.checked;
    saveStore();
    closeSuggestions();
    renderInput();
    els.input.focus();
  });

  // ---------- Guessing ----------

  function resolveInput() {
    const q = norm(els.input.value);
    if (!q) return null;
    if (isHard()) return resolveTyped(els.input.value);
    if (!els.list.hidden && matches[active]) return matches[active];
    const exact = COASTERS.filter((c) => (c._n === q || c._a === q) && !game.guesses.includes(c.id));
    if (exact.length === 1) return exact[0];
    const found = findMatches(els.input.value);
    return found.length === 1 ? found[0] : null;
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (game.done) return;
    const coaster = resolveInput();
    if (!coaster) {
      reject(!els.input.value.trim() ? "Name a coaster first"
        : isHard() ? "No coaster by that name. Check the spelling (this didn't cost a guess)" : "Not on the ride list");
      return;
    }
    submitGuess(coaster);
  });

  function reject(message) {
    els.form.classList.remove("shake");
    void els.form.offsetWidth; // restart the animation
    els.form.classList.add("shake");
    toast(message);
  }

  function recordGuess(id) {
    if (mode === "trivia" && !game.guesses.length && store.triviaHard) game.hard = true; // fixed for the rest of the game
    game.guesses.push(id);
    if (id === answer.id) {
      game.done = true;
      game.won = true;
    } else if (game.guesses.length >= maxGuesses()) {
      game.done = true;
    }
    if (game.done && mode === "infinite") recordInfinite();
    saveStore();
  }

  function submitGuess(coaster) {
    if (game.done || !coaster || game.guesses.includes(coaster.id)) return;
    if (mode === "trivia" && !triviaReady()) return;
    recordGuess(coaster.id);
    resetInput();

    if (mode === "trivia") {
      if (!game.done) toast("Not it. Here's another clue");
      afterTriviaMove();
      return;
    }

    els.guesses.prepend(ticket(coaster, game.guesses.length, true));
    renderPunches();
    renderInput();
    if (game.done) {
      // let the ticket flip finish before the reveal
      const gen = renderGen;
      setTimeout(() => {
        if (gen !== renderGen) return; // switched mode in the meantime
        renderAll();
        els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 1100);
    } else {
      els.input.focus();
    }
  }

  function afterTriviaMove() {
    trivia.fresh = true;
    renderAll();
    if (game.done) els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    else els.input.focus();
  }

  els.skip.addEventListener("click", () => {
    if (!triviaReady() || game.done) return;
    recordGuess(SKIP);
    afterTriviaMove();
  });

  // ---------- Modes ----------

  function resetInput() {
    els.input.value = "";
    matches = [];
    active = -1;
    closeSuggestions();
  }

  function switchMode(m) {
    if (m === "classic") m = mode !== "trivia" ? mode : store.classicMode === "infinite" ? "infinite" : "daily";
    if (m === mode) return;
    if ((practice && m !== "daily") || (triviaPractice && m !== "trivia")) {
      location.search = m === "trivia" ? "" : `?mode=${m}`; // leave practice mode cleanly
      return;
    }
    if (m !== "trivia") store.classicMode = m; // Classic reopens on whichever of Daily/Infinite was used last
    useMode(m);
    saveStore();
    resetInput();
    renderAll();
  }

  function nextInfinite() {
    startInfinite();
    useMode("infinite");
    resetInput();
    renderAll();
    window.scrollTo({ top: 0, behavior: "smooth" });
    els.input.focus();
  }

  els.modeTabs.forEach((tab) => tab.addEventListener("click", () => switchMode(tab.dataset.mode)));

  // Trivia archive: pick a past day; the page reloads on that day's puzzle
  els.archiveDate.min = TRIVIA_FIRST;
  els.archiveDate.max = localDate();
  els.archiveDate.value = triviaDate;
  $("archive-today").hidden = !triviaPractice;
  els.archiveDate.addEventListener("change", () => {
    const d = els.archiveDate.value;
    if (!d || d === triviaDate || d < TRIVIA_FIRST || d > localDate()) return;
    location.search = d === localDate() ? "" : `?trivia=${d}`;
  });

  // ---------- Share ----------

  function shareText() {
    const link = gameLink();
    if (mode === "trivia") {
      const score = game.won ? game.guesses.length : "X";
      const row = game.guesses.map((id) => (id === SKIP ? "⬜" : id === answer.id ? "🟩" : "⬛")).join("");
      return [`Thoosie Trivia · ${shortDate(triviaDate)}${game.hard ? " · Hard" : ""}  ${score}/${maxGuesses()}`, row, ...(link ? ["", link] : [])].join("\n");
    }
    const score = game.won ? game.guesses.length : "X";
    const rows = game.guesses.map((id) => compare(BY_ID.get(id)).map((r) => SHARE_GLYPH[r.status]).join(""));
    const title = mode === "infinite" ? "Thoosie Classic ∞" : `Thoosie Classic No. ${puzzleNo}`;
    return [`${title}  ${score}/${MAX_GUESSES}`, ...rows, ...(link ? ["", link] : [])].join("\n");
  }

  async function share() {
    const text = shareText();
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard");
    } catch {
      window.prompt("Copy your result:", text);
    }
  }

  // ---------- Stats ----------

  function computeStats() {
    if (mode === "infinite") {
      const { played, won, dist, streak, best } = inf;
      return { played, won, dist, streak, best };
    }
    // daily: keyed by puzzle number; trivia: keyed by date, turned into a day number for streaks
    const dayNum = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      return Math.round(new Date(y, m - 1, d) / 86400000);
    };
    const isTrivia = mode === "trivia";
    const games = isTrivia ? triviaStore.games : store.games;
    const entries = Object.entries(games)
      .filter(([, g]) => g.done)
      .map(([k, g]) => [isTrivia ? dayNum(k) : Number(k), g]);
    const played = entries.length;
    const won = entries.filter(([, g]) => g.won).length;
    const dist = Array(isTrivia ? TRIVIA_MAX : MAX_GUESSES).fill(0);
    entries.forEach(([, g]) => g.won && dist[Math.min(g.guesses.length, dist.length) - 1]++);

    const wonDays = new Set(entries.filter(([, g]) => g.won).map(([n]) => n));
    const today = isTrivia ? dayNum(localDate()) : todayNumber();
    let streak = 0;
    for (let n = wonDays.has(today) ? today : today - 1; wonDays.has(n); n--) streak++;
    let best = 0;
    wonDays.forEach((n) => {
      if (wonDays.has(n - 1)) return;
      let len = 0;
      while (wonDays.has(n + len)) len++;
      best = Math.max(best, len);
    });

    return { played, won, dist, streak, best };
  }

  function renderStats() {
    const s = computeStats();
    const max = Math.max(1, ...s.dist);
    const todayWin = !(mode === "trivia" ? triviaPractice : practice) && game.won ? game.guesses.length : 0;
    els.statsBody.innerHTML = `
      <p class="stats-mode">${{ infinite: "Infinite mode", trivia: "Trivia" }[mode] || "Daily coaster"}</p>
      <div class="stat-row">
        <div><span class="stat-num">${s.played}</span><span class="stat-label">Played</span></div>
        <div><span class="stat-num">${s.played ? Math.round((s.won / s.played) * 100) : 0}</span><span class="stat-label">Win %</span></div>
        <div><span class="stat-num">${s.streak}</span><span class="stat-label">Streak</span></div>
        <div><span class="stat-num">${s.best}</span><span class="stat-label">Best</span></div>
      </div>
      <div class="dist">
        ${s.dist
          .map((count, i) => `<div class="dist-row"><span>${i + 1}</span>
            <span class="dist-bar${todayWin === i + 1 ? " today" : ""}" style="width:${Math.max(8, (count / max) * 100)}%">${count}</span></div>`)
          .join("")}
      </div>`;
  }

  // ---------- Misc ----------

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function tickCountdown() {
    const el = $("countdown");
    if (!el) return;
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const secs = Math.max(0, Math.floor((next - now) / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    el.textContent = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
    if (secs === 0) location.reload();
  }
  setInterval(tickCountdown, 1000);

  $("help-btn").addEventListener("click", () => els.help.showModal());
  $("stats-btn").addEventListener("click", () => {
    renderStats();
    els.stats.showModal();
  });

  // close dialogs on backdrop click
  [els.help, els.stats].forEach((d) =>
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    })
  );

  useMode(mode);
  renderAll();
  if (!practice && !triviaPractice && !game.guesses.length && !store.seenHelp) {
    store.seenHelp = true;
    saveStore();
    els.help.showModal();
  }
})();
