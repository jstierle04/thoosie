# Thoosie

A daily roller coaster guessing game with two modes:

- **Trivia** (the main mode, and what the game opens on): guess one mystery coaster a day from
  up to 5 trivia clues, revealed one per miss.
- **Classic:** guess the coaster in 8 tries; each guess shows how its park, country, maker,
  type, opening year, height, speed and inversions compare to the answer. Daily and Infinite.

## Run it

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

Use a server rather than opening `index.html` directly: Trivia fetches its puzzle files, which
browsers block for pages opened from disk.

URL options:

- `?trivia=YYYY-MM-DD` plays that day's Trivia puzzle (see Archive below).
- `?mode=daily` or `?mode=infinite` opens Classic on that sub-mode.
- `?day=N` plays Classic Daily puzzle N in practice mode (doesn't touch saved stats).

Shared results end with a link to the game. Set `GAME_URL` in `src/game.js` once it has a
permanent address; until then the link is whatever address the page was loaded from.

## Modes

### Trivia

One mystery coaster a day, the same for everyone, guessed from trivia facts. Each miss (or
"Next clue") reveals the next clue: ride stats, maker and year, location, a notable fact, a
name hint. The game always opens on this tab.

**Hard mode** (toggle next to the date picker): no suggestion dropdown; the typed name is
matched forgivingly (case, punctuation, accents, leading "the", spacing, the part before a
colon, old names, 1 typo from 6 letters and 2 from 12). A name that isn't in the game is
rejected without costing a guess. A game keeps the mode it started in, and shares show "Hard".

**Archive:** the "Past puzzles" date picker replays any day from `TRIVIA_FIRST` in `game.js` up
to today. It loads `?trivia=YYYY-MM-DD`; archive games are saved so a reload keeps progress, but
never count toward stats or streaks, and a day you already finished live shows that game. The
picker stops at today, but typing a future date into the URL works, for reviewing puzzles.

Puzzles come from `data/trivia/`; see [Trivia puzzles](#trivia-puzzles) for how they're made.

### Classic

The stats game, with sub-tabs for Daily and Infinite. The tab reopens on whichever of the two
was played last.

- **Daily:** one coaster per day, the same for everyone (see
  [How the Classic Daily coaster is picked](#how-the-classic-daily-coaster-is-picked)).
- **Infinite:** a random coaster each round, with separate stats and streak. It won't repeat
  any of the last 30 answers and never serves today's daily answer.

## Layout

```
index.html                     page shell + dialogs
styles.css                     all styling (light + dark)
src/game.js                    game logic: modes, scoring, autocomplete, stats, share
data/trivia/YYYY-MM-DD.json    GENERATED Trivia puzzles (scripts/generate_trivia.py)
data/coasters.js               GENERATED coaster list (window.COASTERS), CC BY-SA
data/schedule.js               GENERATED frozen Classic Daily answers (scripts/schedule.py)
data/featured.txt              always-in answer pool additions
data/exclude.txt               never-an-answer list
data/overrides.txt             hand-filled stats Coasterpedia is missing
prompts/trivia_system.md       system prompt for the Trivia clue writer
scripts/generate_trivia.py     writes Trivia puzzles with Gemini
scripts/import_coasterpedia.py builds data/coasters.js from Coasterpedia
scripts/parse_rankings.py      builds data/ranking.json from saved ranking pages
scripts/schedule.py            freezes the Classic Daily schedule
.github/workflows/trivia.yml   generates Trivia puzzles automatically
```

## Trivia puzzles

Puzzles are pre-generated into `data/trivia/YYYY-MM-DD.json` by `scripts/generate_trivia.py`:

1. picks an answer-pool coaster not used in the last 300 puzzles;
2. gathers sources: its Wikipedia article (only accepted if the infobox park matches) and its
   Coasterpedia article as backup; skips coasters with too little text;
3. asks Gemini (`MODELS` in the script: Gemini 3.8 Flash, falling back to older Flash models
   when it's overloaded) for exactly 5 clues using **your** system prompt in
   `prompts/trivia_system.md`, with the output shape fixed by a JSON schema;
4. writes the file with `"review": {"reviewed": false, "warnings": [...], "evidence": [...]}`
   for you to check before the day goes live. Warnings come from code checks, not a second
   model: the coaster's name in a clue, the park named before clue 4, a number in the stats
   clues that doesn't match the coaster's data, or an evidence quote that isn't found word for
   word in the source it cites.
   Clue labels ("Stats", "The park", …) are set by position from `CLUE_ORDER` in the script; keep
   it in step with the prompt.

Locally the key is read from `GEMINI_API_KEY` in the environment or a `.env` file in the repo
root (`GEMINI_API_KEY=...`). `.env` is gitignored; never commit it.

```sh
pip install -r scripts/requirements.txt
python3 scripts/generate_trivia.py --dry-run      # fetch sources + show the prompt, no API call
python3 scripts/generate_trivia.py                # fill today .. today+3
python3 scripts/generate_trivia.py --date 2026-10-20 --force
```

**Everyone gets the same clues:** each day is generated once, committed, and served as a static
file; the model is never called during play. `--force` only regenerates days that haven't
started anywhere in the world yet (regenerating keeps that day's coaster). Fixing a live day
needs `--replace-live`, or edit its JSON by hand.

**Daily automation:** `.github/workflows/trivia.yml` runs the generator every 3 hours and commits
new puzzles. Add a `GEMINI_API_KEY` repository secret (Settings → Secrets and variables →
Actions). It keeps 3 days ahead, so you can review (and edit) puzzles before they go live.
Most runs find nothing missing and finish quickly; a day that failed because Gemini was
unavailable is simply retried on the next run. A run only fails (and GitHub emails you) when a
missing day is within a day of going live (`URGENT_DAYS`), or for a one-off `--date` run.
It can also be run by hand from the Actions tab. Pull before pushing, since the bot commits often.

Puzzle files ship with the site, so the answers are readable by anyone who looks.

## Coaster data

`data/coasters.js` is generated from [Coasterpedia](https://coasterpedia.net) (CC BY-SA 4.0,
see `data/LICENSE`). Both modes use it. Don't edit it by hand. Re-run the importer:

```sh
python3 scripts/import_coasterpedia.py            # re-parse cached pages (fast)
python3 scripts/import_coasterpedia.py --refresh  # re-download (~4,200 pages, ~2 min)
```

It keeps only coasters with complete stats (park, country, type, year, height, speed),
and leaves out defunct coasters entirely (`DROP_STATUSES` in the script).
Raw pages are cached in `data/.cache/` (gitignored).
It reads both the standard coaster infobox and the multitrack one used by racing/dueling
coasters (Lightning Racer, Racer 75, ...), taking track 1's stats.

**Missing stats:** `data/overrides.txt` fills gaps by hand (`Page title | speed=27`). Better
still, add the stat to the Coasterpedia page, re-import with `--refresh`, and drop the line.

**Guessable vs. answers:** with `GUESSABLE_ONLY_ANSWERS = True` (the default) the data file
holds only the answer pool, so those are the only guessable coasters too. Set it to `False`
to make every complete Coasterpedia coaster guessable while only the pool can be the answer. The importer builds it:

1. **If `data/ranking.json` exists:** every ranked coaster that matches a Coasterpedia coaster
   with complete stats. Anything unmatched, incomplete or defunct is discarded and listed in
   `data/ranking-discarded.txt`. `scripts/parse_rankings.py` builds `data/ranking.json` from
   ranking pages saved by hand (`LIMITS` in the script sets how many per continent).
   **Otherwise:** the 300 best-known operating coasters by Coasterpedia article length.
2. plus everything in `data/featured.txt` (standing-but-not-operating is fine);
3. minus everything in `data/exclude.txt`.

Both lists are `Name @ Park`, one per line. Old names work too, and the importer reports
any line it can't match.

Names come from the Coasterpedia page title, which follows renames; the infobox name is kept
as `aka` when different, so searching "Mantis" finds Rougarou.

## How the Classic Daily coaster is picked

Days already played never change. `data/schedule.js` fixes the answer for days 1..N (by
Coasterpedia page), and later days go through the answer pool shuffled with a fixed seed
(`SHUFFLE_SEED` in `game.js`), coasters that haven't been a Daily answer yet first.
Puzzle 1 is 2026-01-01 local time.

Changing the pool only reorders days after the frozen ones. `import_coasterpedia.py` freezes
through today + 2 days (using the pool that's live before the import) before it writes the new
pool, so re-importing is safe. `scripts/schedule.py --show 7` prints the coming week's answers;
`scripts/schedule.py --through YYYY-MM-DD` freezes further ahead. Keep `scripts/schedule.py`
and `dailyAnswerFor` in `game.js` in step.
