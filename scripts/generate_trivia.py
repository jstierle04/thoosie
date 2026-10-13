#!/usr/bin/env python3
"""Generate daily Trivia-mode puzzles: data/trivia/YYYY-MM-DD.json.

For each missing day from today through today + DAYS_AHEAD, pick an answer-pool coaster
(from data/coasters.js), gather source text (Wikipedia first, Coasterpedia as backup), and ask
Gemini to write 5 trivia clues the player guesses the coaster from, in the order set by
prompts/trivia_system.md: ride stats, maker + year, park location, a notable fact, a name hint.

    python3 scripts/generate_trivia.py                    # fill today..today+DAYS_AHEAD
    python3 scripts/generate_trivia.py --date 2026-10-20  # one specific day
    python3 scripts/generate_trivia.py --dry-run          # gather sources + print the prompt, no API call
    python3 scripts/generate_trivia.py --date 2026-10-20 --force   # regenerate a day nobody can play yet

Every player gets the same clues because each day is generated once, saved to data/trivia/ and
served as a static file; the model is never called while someone plays. To keep it that way, a
day that has started anywhere in the world is never regenerated, even with --force; fixing a
live puzzle needs --replace-live (or a hand edit of its file).

Needs `pip install -r scripts/requirements.txt` and a Gemini API key in GEMINI_API_KEY (read from
the environment, or from a .env file in the repo root, which is gitignored) for anything but
--dry-run. The system prompt lives in prompts/trivia_system.md.

The generated files ship with the site, so anyone who opens them can see the answer — same
trade-off as Wordle's answer list. Files have "reviewed": false until you check them.
"""

import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_coasterpedia as ic  # noqa: E402  (shared parsing/matching helpers)

ROOT = Path(__file__).resolve().parent.parent
COASTERS_PATH = ROOT / "data" / "coasters.js"
TRIVIA_DIR = ROOT / "data" / "trivia"
SYSTEM_PROMPT_PATH = ROOT / "prompts" / "trivia_system.md"
ENV_PATH = ROOT / ".env"

# Tried in order: if one is overloaded (503) or rate-limited (429) after retries, the next is
# used. Pinned names rather than "gemini-flash-latest", so a release can't silently change the
# clues. Each puzzle file records which model actually wrote it.
MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash-preview"]
MAX_OUTPUT_TOKENS = 8192
RETRIES_PER_MODEL = 3
RETRY_WAIT = 20  # seconds, doubled after each failed attempt
DAYS_AHEAD = 3            # keep this many future days generated, so there's time to review
REPEAT_WINDOW = 300       # don't reuse a coaster that was an answer within this many puzzles
MIN_CLUES, MAX_CLUES = 5, 5
MIN_SOURCE_CHARS = 1500   # skip coasters whose sources are too thin to write good trivia from
CANDIDATES_PER_DAY = 6    # how many coasters to try before giving up on a day

USER_AGENT = "ThoosieTrivia/0.1 (daily coaster trivia game)"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
COASTERPEDIA_API = "https://coasterpedia.net/w/api.php"

CLUE_KINDS = ["stats", "fact", "park", "name"]
# The order prompts/trivia_system.md asks for; update both together.
CLUE_ORDER = ["stats", "stats", "park", "fact", "name"]
PARK_NAMED_FROM = CLUE_ORDER.index("fact")  # the location clue mustn't name the park; clue 4 may
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "clues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": CLUE_KINDS},
                    "text": {"type": "string"},
                    "source": {"type": "string", "enum": ["stats", "wikipedia", "coasterpedia"]},
                    "evidence": {"type": "string"},
                },
                "required": ["kind", "text", "source", "evidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clues"],
    "additionalProperties": False,
}


# ---------- Data ----------

def load_coasters():
    src = COASTERS_PATH.read_text(encoding="utf-8")
    return json.loads(src[src.index("["):src.rindex("]") + 1])


def used_answers(except_day=None):
    """Coaster pages already used by other days, most recent last."""
    files = sorted(f for f in TRIVIA_DIR.glob("????-??-??.json") if f.stem != str(except_day))
    return [json.loads(f.read_text(encoding="utf-8"))["answer"]["page"] for f in files]


def candidates_for(day, coasters):
    # the day's own file doesn't count as "used", so regenerating a day keeps its coaster
    recent = set(used_answers(except_day=day)[-REPEAT_WINDOW:])
    pool = [c for c in coasters if c.get("answer", True) and c["page"] not in recent] or coasters
    rng = random.Random(f"thoosie-trivia-{day.isoformat()}")  # same day -> same order
    return rng.sample(pool, min(CANDIDATES_PER_DAY, len(pool)))


# ---------- Sources ----------

def api_get(base, params):
    url = base + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.load(resp)
            time.sleep(1)
            return data
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503):
                raise
            time.sleep(int(e.headers.get("Retry-After") or 0) or 10 * (attempt + 1))
    raise RuntimeError(f"gave up on {url}")


def wikitext(base, title):
    data = api_get(base, {"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                          "titles": title, "redirects": 1})
    page = data["query"]["pages"][0]
    return (page["title"], page["revisions"][0]["slots"]["main"]["content"]) if "revisions" in page else (None, None)


def wikipedia_infobox(text):
    """Name/park from a Wikipedia {{Infobox roller coaster}}, if the article has one."""
    m = re.search(r"\{\{\s*Infobox[ _]roller[ _]coaster(.*?)\n\}\}", text, re.I | re.S)
    if not m:
        return None
    fields = dict(re.findall(r"^\s*\|\s*(\w+)\s*=\s*(.*)$", m.group(1), re.M))
    return {"name": ic.clean(fields.get("name", "")), "park": ic.clean(fields.get("park", "") or fields.get("location", ""))}


def find_wikipedia(coaster):
    """(title, plain text) of the coaster's own Wikipedia article, or (None, None).
    Only accepts an article whose roller-coaster infobox names the same park, since many
    coasters share names ("Batman: The Ride", "Goliath")."""
    queries = [f'"{coaster["name"]}" {coaster["park"]} roller coaster', f'{coaster["name"]} roller coaster']
    seen = set()
    for q in queries:
        result = api_get(WIKIPEDIA_API, {"action": "query", "list": "search", "srsearch": q, "srlimit": 4})
        if "query" not in result:
            print(f"    wikipedia search failed for {q!r}: {result.get('error', result)}")
            continue
        for hit in result["query"]["search"]:
            if hit["title"] in seen:
                continue
            seen.add(hit["title"])
            title, text = wikitext(WIKIPEDIA_API, hit["title"])
            box = wikipedia_infobox(text or "")
            if not box:
                continue
            names_match = any(ic.similar_name(box["name"] or title, n) for n in (coaster["name"], coaster.get("aka", "")) if n)
            if names_match and (not box["park"] or ic.same_park(box["park"], coaster["park"])):
                extract = api_get(WIKIPEDIA_API, {"action": "query", "prop": "extracts", "explaintext": 1,
                                                  "titles": title, "redirects": 1})["query"]["pages"][0].get("extract", "")
                return title, extract
    return None, None


def strip_wikitext(text):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", text, flags=re.S | re.I)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def gather_sources(coaster):
    sources = []
    wp_title, wp_text = find_wikipedia(coaster)
    if wp_text:
        sources.append({"name": "wikipedia", "title": wp_title, "text": wp_text,
                        "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(wp_title.replace(" ", "_"))})
    cp_title, cp_text = wikitext(COASTERPEDIA_API, coaster["page"])
    if cp_text:
        sources.append({"name": "coasterpedia", "title": cp_title, "text": strip_wikitext(cp_text),
                        "url": "https://coasterpedia.net/wiki/" + urllib.parse.quote(cp_title.replace(" ", "_"))})
    return sources


# ---------- Prompt + model ----------

def coaster_facts(coaster):
    facts = {k: coaster.get(k) for k in ("name", "aka", "park", "country", "maker", "type", "year", "height",
                                          "speed", "inversions", "status") if coaster.get(k) not in (None, "")}
    facts["height"] = f'{facts["height"]} ft'
    facts["speed"] = f'{facts["speed"]} mph'
    return facts


def source_blocks(coaster, sources):
    parts = [f"<coaster>\n{json.dumps(coaster_facts(coaster), indent=1, ensure_ascii=False)}\n</coaster>"]
    for s in sources:
        parts.append(f'<source name="{s["name"]}" title="{s["title"]}">\n{s["text"]}\n</source>')
    return "\n\n".join(parts)


def user_message(coaster, sources):
    return source_blocks(coaster, sources)


def read_prompt(path):
    text = path.read_text(encoding="utf-8")
    if "TODO" in text:
        raise SystemExit(f"Finish the prompt in {path.relative_to(ROOT)} first (it still says TODO).")
    return text


def api_key():
    """GEMINI_API_KEY from the environment (GitHub Actions secret) or the repo's .env file."""
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip().removeprefix("export ").strip() == "GEMINI_API_KEY":
                return value.strip().strip("'\"")
    raise SystemExit("No GEMINI_API_KEY: set it in the environment or in .env at the repo root.")


def call_gemini(system, contents, schema):
    """Structured-output call with retries, falling back through MODELS.
    Returns (parsed JSON, model that answered, response id)."""
    from google import genai  # only needed for real runs, not --dry-run
    from google.genai import errors, types

    client = genai.Client(api_key=api_key())
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_json_schema=schema,
        max_output_tokens=MAX_OUTPUT_TOKENS,
    )
    for model in MODELS:
        wait = RETRY_WAIT
        for attempt in range(1, RETRIES_PER_MODEL + 1):
            try:
                response = client.models.generate_content(model=model, contents=contents, config=config)
            except errors.APIError as e:
                if e.code not in (429, 500, 503):
                    raise  # bad key, bad request, etc.: retrying won't help
                print(f"    {model}: {e.code} {e.status} (attempt {attempt}/{RETRIES_PER_MODEL})")
                if attempt < RETRIES_PER_MODEL:
                    time.sleep(wait)
                    wait *= 2
                continue
            feedback = response.prompt_feedback
            if feedback and feedback.block_reason:
                raise RuntimeError(f"prompt blocked ({feedback.block_reason}); response {response.response_id}")
            candidate = (response.candidates or [None])[0]
            reason = candidate.finish_reason.name if candidate and candidate.finish_reason else "NO_CANDIDATE"
            if reason != "STOP":
                raise RuntimeError(f"generation stopped early ({reason}); response {response.response_id}")
            return json.loads(response.text), response.model_version or model, response.response_id
    raise RuntimeError(f"every model was unavailable: {', '.join(MODELS)}")


def write_clues(coaster, sources):
    data, model, response_id = call_gemini(read_prompt(SYSTEM_PROMPT_PATH), user_message(coaster, sources), OUTPUT_SCHEMA)
    return data["clues"], model, response_id


# ---------- Checks ----------

def warnings_for(coaster, clues):
    """Cheap automatic checks; anything flagged needs a human look before the day goes live."""
    out = []
    if not MIN_CLUES <= len(clues) <= MAX_CLUES:
        out.append(f"{len(clues)} clues (expected {MIN_CLUES}-{MAX_CLUES})")
    names = {ic.norm(n) for n in (coaster["name"], coaster.get("aka", "")) if n and len(ic.norm(n)) >= 4}
    park = ic.norm(coaster["park"])
    for i, clue in enumerate(clues, 1):
        text = ic.norm(clue["text"])
        if any(re.search(rf"\b{re.escape(n)}\b", text) for n in names):
            out.append(f"clue {i} contains the coaster's name")
        if park and i <= PARK_NAMED_FROM and re.search(rf"\b{re.escape(park)}\b", text):
            out.append(f"clue {i} names the park (allowed from clue {PARK_NAMED_FROM + 1})")
    return out


def code_checks(coaster, sources, clues):
    """Exact checks an LLM can miss: stats numbers must match the coaster's data, and each quoted
    piece of evidence must really appear in the source it cites. Returns problems (strings), which
    go into the puzzle's review warnings."""
    problems = []
    stat_numbers = {str(coaster.get(k)) for k in ("height", "speed", "inversions", "year") if coaster.get(k) is not None}
    texts = {s["name"]: ic.norm(s["text"]) for s in sources}
    for i, clue in enumerate(clues, 1):
        if clue["kind"] == "stats":
            wrong = [n for n in re.findall(r"\d+", clue["text"].replace(",", "")) if n not in stat_numbers]
            if wrong:
                problems.append(f"Clue {i}: number(s) {', '.join(wrong)} don't match the coaster's stats "
                                f"(height {coaster['height']} ft, speed {coaster['speed']} mph, "
                                f"{coaster['inversions']} inversions, opened {coaster['year']}).")
        if clue["kind"] == "name" or clue["source"] == "stats":
            continue  # name meanings are general knowledge; stats are checked by number above
        pieces = [ic.norm(p) for p in re.split(r"\.\.\.|…", clue["evidence"]) if len(ic.norm(p)) >= 15]
        haystack = texts.get(clue["source"], "")
        if not pieces or not all(p in haystack for p in pieces):
            problems.append(f"Clue {i}: its evidence quote isn't found word for word in the {clue['source']} source.")
    return problems


def label_by_position(clues):
    """The prompt fixes what each position is, so set each clue's kind (the label the game shows,
    e.g. "The park") from its position instead of trusting the model's labelling."""
    if len(clues) == len(CLUE_ORDER):
        for clue, kind in zip(clues, CLUE_ORDER):
            clue["kind"] = kind
    return clues


# ---------- Main ----------

def generate_day(day, coasters, dry_run):
    for coaster in candidates_for(day, coasters):
        sources = gather_sources(coaster)
        size = sum(len(s["text"]) for s in sources)
        label = f'{coaster["name"]} @ {coaster["park"]}'
        if size < MIN_SOURCE_CHARS:
            print(f"  skip {label}: only {size} chars of source text")
            continue
        summary = ", ".join(f"{s['name']} ({len(s['text'])} chars)" for s in sources)
        print(f"  {label}: sources {summary}")
        if dry_run:
            print("\n----- user message -----\n" + user_message(coaster, sources)[:3000] + "\n[…]\n")
            return
        clues, model, request_id = write_clues(coaster, sources)
        clues = label_by_position(clues)
        puzzle = {
            "date": day.isoformat(),
            "answer": {"name": coaster["name"], "park": coaster["park"], "page": coaster["page"]},
            "clues": [{"kind": c["kind"], "text": c["text"]} for c in clues],
            "review": {
                "reviewed": False,
                "warnings": warnings_for(coaster, clues) + code_checks(coaster, sources, clues),
                "evidence": [{"source": c["source"], "quote": c["evidence"]} for c in clues],
                "sources": [{"name": s["name"], "title": s["title"], "url": s["url"]} for s in sources],
                "model": model,
                "response_id": request_id,
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            },
        }
        TRIVIA_DIR.mkdir(parents=True, exist_ok=True)
        path = TRIVIA_DIR / f"{day.isoformat()}.json"
        path.write_text(json.dumps(puzzle, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        flags = puzzle["review"]["warnings"]
        print(f"  wrote {path.relative_to(ROOT)}" + (f"  ⚠ {'; '.join(flags)}" if flags else ""))
        return
    raise SystemExit(f"{day}: no candidate coaster had enough source text")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", type=dt.date.fromisoformat, help="generate this day only (YYYY-MM-DD)")
    ap.add_argument("--ahead", type=int, default=DAYS_AHEAD, help=f"fill today..today+N (default {DAYS_AHEAD})")
    ap.add_argument("--force", action="store_true", help="regenerate days that already have a file, if no one can play them yet")
    ap.add_argument("--replace-live", action="store_true",
                    help="also regenerate a day players may already have played (they'll see different clues)")
    ap.add_argument("--dry-run", action="store_true", help="gather sources and print the prompt; no API call")
    args = ap.parse_args()

    today = dt.date.today()
    days = [args.date] if args.date else [today + dt.timedelta(days=i) for i in range(args.ahead + 1)]
    coasters = load_coasters()
    # the newest date anywhere on Earth (UTC+14); a puzzle for that day or earlier may already be in play
    live_until = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=14)).date()
    for day in days:
        if (TRIVIA_DIR / f"{day.isoformat()}.json").exists():
            if not args.force:
                print(f"{day}: already generated")
                continue
            if day <= live_until and not args.replace_live:
                print(f"{day}: already live somewhere, so keeping its clues (use --replace-live to override)")
                continue
        print(f"{day}:")
        generate_day(day, coasters, args.dry_run)


if __name__ == "__main__":
    main()
