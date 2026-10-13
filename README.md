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

## How the daily coaster is picked

The answer pool is shuffled with a fixed seed (`SHUFFLE_SEED` in `game.js`) and
puzzle N takes entry `(N - 1) % length`. Puzzle 1 is 2026-01-01 local time.
**Any change to the pool reorders every puzzle.** That's fine while prototyping; switch to
an explicit schedule before launch.
