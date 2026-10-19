# Thoosie

A daily roller coaster guessing game. Guess the mystery coaster in 8 tries; each guess
shows how its park, country, maker, type, opening year, height, speed and inversions
compare to the answer.

## Run it

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

Opening `index.html` directly also works.

Add `?day=N` to play puzzle N in practice mode (doesn't touch saved stats).

Shared results end with a link to the game. Set `GAME_URL` in `src/game.js` once it has a
permanent address; until then the link is whatever address the page was loaded from.

## Modes

The game always opens on **Trivia** (see below). The **Classic** tab is the stats game, with
sub-tabs for Daily and Infinite; it reopens on whichever of the two was played last.
`?mode=daily` or `?mode=infinite` opens one of those instead.

- **Daily:** one coaster per day, the same for everyone.
- **Infinite:** a random featured coaster each round, with separate stats and streak. It
  won't repeat any of the last 30 answers and never serves today's daily answer.

## Layout

```
index.html                     page shell + dialogs
styles.css                     all styling (light + dark)
src/game.js                    game logic: daily pick, scoring, autocomplete, stats, share
data/coasters.js               GENERATED coaster list (window.COASTERS), CC BY-SA
data/featured.txt              always-in answer pool additions
data/schedule.js               GENERATED frozen Daily answers (scripts/schedule.py)
data/exclude.txt               never-an-answer list
scripts/import_coasterpedia.py builds data/coasters.js from Coasterpedia
```

## Coaster data

`data/coasters.js` is generated from [Coasterpedia](https://coasterpedia.net) (CC BY-SA 4.0,
see `data/LICENSE`). Don't edit it by hand. Re-run the importer:

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

1. **If `data/ranking.json` exists** (see below): every ranked coaster that matches a
   Coasterpedia coaster with complete stats. Anything unmatched, incomplete or defunct is
   discarded and listed in `data/ranking-discarded.txt`.
   **Otherwise:** the 300 best-known operating coasters by Coasterpedia article length.
2. plus everything in `data/featured.txt` (standing-but-not-operating is fine);
3. minus everything in `data/exclude.txt`.

### Captain Coaster rankings

`scripts/parse_rankings.py` reads ranking pages saved by hand from
`captaincoaster.com/en/ranking/?filters[continent]=N&page=P` (50 per page; view-source saves
work) and writes `data/ranking.json`: top 325 America, top 50 Europe, top 50 Asia, all of
Oceania (`LIMITS` in the script). Then re-run the importer.

```sh
python3 scripts/parse_rankings.py && python3 scripts/import_coasterpedia.py
```

The saved pages are Captain Coaster's content and are gitignored. Their terms forbid
mass scraping and commercial use, so ask them before using this in anything that earns money.

Both lists are `Name @ Park`, one per line. Old names work too, and the importer reports
any line it can't match.

Names come from the Coasterpedia page title, which follows renames; the infobox name is kept
as `aka` when different, so searching "Mantis" finds Rougarou.

## Trivia mode

A third mode: one mystery coaster a day, guessed from trivia facts instead of stat tickets.
Each miss (or "Next clue") reveals the next clue: ride stats, maker and year, location, a notable fact, a name hint.

Puzzles are pre-generated into `data/trivia/YYYY-MM-DD.json` by `scripts/generate_trivia.py`:

1. picks an answer-pool coaster not used in the last 300 puzzles;
2. gathers sources: its Wikipedia article (only accepted if the infobox park matches) and its
   Coasterpedia article as backup; skips coasters with too little text;
3. asks Gemini (`MODELS` in the script: Gemini 3.8 Flash, falling back to older Flash models when it's overloaded) for exactly 5 clues using **your** system prompt in
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

Add `?trivia=YYYY-MM-DD` to the URL to play a given day without touching stats.

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
It can also be run by hand from the Actions tab.

Puzzle files ship with the site, so the answers are readable by anyone who looks.

## How the daily coaster is picked

Days already played never change. `data/schedule.js` fixes the answer for days 1..N (by
Coasterpedia page), and later days go through the answer pool shuffled with a fixed seed
(`SHUFFLE_SEED` in `game.js`), coasters that haven't been a Daily answer yet first.
Puzzle 1 is 2026-01-01 local time.

Changing the pool only reorders days after the frozen ones. `import_coasterpedia.py` freezes
through today + 2 days (using the pool that's live before the import) before it writes the new
pool, so re-importing is safe. `scripts/schedule.py --show 7` prints the coming week's answers;
`scripts/schedule.py --through YYYY-MM-DD` freezes further ahead. Keep `scripts/schedule.py`
and `dailyAnswerFor` in `game.js` in step.
