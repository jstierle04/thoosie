(function () {
  "use strict";

  const MAX_GUESSES = 8;
  const STORAGE_KEY = "thoosie:v1";
  const EPOCH = new Date(2026, 0, 1); // puzzle No. 1
  const SHUFFLE_SEED = 0x7400513; // changing this reorders every future puzzle
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
  const ORDER = shuffled(POOL, SHUFFLE_SEED);
  const dailyAnswer = ORDER[(puzzleNo - 1) % ORDER.length];
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

  let mode = !practice && store.mode === "infinite" ? "infinite" : "daily";
  let answer;
  let game;

  function useMode(m) {
    mode = m;
    if (m === "infinite") {
      if (!inf.current) startInfinite();
      game = inf.current;
      answer = BY_ID.get(game.answer);
    } else {
      game = dailyGame;
      answer = dailyAnswer;
    }
    game.guesses = game.guesses.filter((id) => BY_ID.has(id));
  }

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
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function renderPunches() {
    const left = MAX_GUESSES - game.guesses.length;
    els.punches.innerHTML = Array.from({ length: MAX_GUESSES }, (_, i) =>
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

  function renderResult() {
    if (!game.done) {
      els.result.hidden = true;
      return;
    }
    const a = answer;
    const infinite = mode === "infinite";
    const lost = infinite ? "Out of tickets. It was" : "Out of tickets. Today's coaster was";
    let actions = `<button type="button" class="ride-btn" id="share-btn">Share</button>`;
    if (infinite) actions = `<button type="button" class="ride-btn next-btn" id="next-btn">Next coaster →</button>` + actions;
    else if (!practice) actions += `<span class="countdown">Next coaster in <span id="countdown">--:--:--</span></span>`;
    els.result.innerHTML = `
      <p class="result-kicker">${game.won ? `Got it in ${game.guesses.length}. Credit counted.` : lost}</p>
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
      <div class="result-actions">${actions}</div>`;
    els.result.hidden = false;
    $("share-btn").addEventListener("click", share);
    if (infinite) $("next-btn").addEventListener("click", nextInfinite);
    tickCountdown();
  }

  function renderInput() {
    const locked = game.done;
    els.input.disabled = locked;
    els.submit.disabled = locked;
    if (!locked) els.input.placeholder = "Name a coaster or park…";
    else els.input.placeholder = mode === "infinite" ? "Ride again: hit Next coaster" : "Come back tomorrow…";
  }

  let renderGen = 0; // bumps on every full re-render so stale reveal timers can bail

  function renderAll() {
    renderGen++;
    els.puzzleNo.textContent =
      mode === "infinite"
        ? `Infinite · Ride ${inf.played + (game.done ? 0 : 1)}`
        : `No. ${String(puzzleNo).padStart(3, "0")}${practice ? " (practice)" : ""}`;
    els.modeTabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.mode === mode)));
    renderPunches();
    renderGuesses();
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

  // ---------- Guessing ----------

  function resolveInput() {
    const q = norm(els.input.value);
    if (!q) return null;
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
      reject(els.input.value.trim() ? "Not on the ride list" : "Name a coaster first");
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

  function submitGuess(coaster) {
    if (game.done || !coaster || game.guesses.includes(coaster.id)) return;
    game.guesses.push(coaster.id);
    if (coaster.id === answer.id) {
      game.done = true;
      game.won = true;
    } else if (game.guesses.length >= MAX_GUESSES) {
      game.done = true;
    }
    if (game.done && mode === "infinite") recordInfinite();
    saveStore();

    els.input.value = "";
    matches = [];
    active = -1;
    closeSuggestions();

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

  // ---------- Modes ----------

  function resetInput() {
    els.input.value = "";
    matches = [];
    active = -1;
    closeSuggestions();
  }

  function switchMode(m) {
    if (m === mode) return;
    if (practice && m === "infinite") location.search = ""; // leave practice mode cleanly
    store.mode = m;
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

  // ---------- Share ----------

  function shareText() {
    const score = game.won ? game.guesses.length : "X";
    const rows = game.guesses.map((id) => compare(BY_ID.get(id)).map((r) => SHARE_GLYPH[r.status]).join(""));
    const title = mode === "infinite" ? "Thoosie ∞" : `Thoosie No. ${puzzleNo}`;
    return [`${title}  ${score}/${MAX_GUESSES}`, ...rows].join("\n");
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
    const entries = Object.entries(store.games)
      .filter(([, g]) => g.done)
      .map(([n, g]) => [Number(n), g]);
    const played = entries.length;
    const won = entries.filter(([, g]) => g.won).length;
    const dist = Array(MAX_GUESSES).fill(0);
    entries.forEach(([, g]) => g.won && dist[g.guesses.length - 1]++);

    const wonDays = new Set(entries.filter(([, g]) => g.won).map(([n]) => n));
    const today = todayNumber();
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
    const todayWin = !practice && game.won ? game.guesses.length : 0;
    els.statsBody.innerHTML = `
      <p class="stats-mode">${mode === "infinite" ? "Infinite mode" : "Daily coaster"}</p>
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
  if (!practice && !game.guesses.length && !store.seenHelp) {
    store.seenHelp = true;
    saveStore();
    els.help.showModal();
  }
})();
