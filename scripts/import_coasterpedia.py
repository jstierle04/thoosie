#!/usr/bin/env python3
"""Import roller coasters from Coasterpedia (https://coasterpedia.net) into data/coasters.js.

Coasterpedia content is CC BY-SA 4.0, so the generated data file is too.
See data/LICENSE.

Usage:
    python3 scripts/import_coasterpedia.py            # use cached pages if present
    python3 scripts/import_coasterpedia.py --refresh  # re-download everything

Standard library only. Also marks the daily/infinite answer pool (see POOL_SIZE below).

Downloads ~4,000 pages in batches of 50 (~90 requests,
one per second), caches the raw wikitext, then parses each page's
{{Infobox roller coaster}} into the fields the game uses.
"""

import argparse
import difflib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API = "https://coasterpedia.net/w/api.php"
USER_AGENT = "ThoosieImporter/0.1 (daily coaster guessing game; https://coasterpedia.net data, CC BY-SA)"
# Racing/dueling coasters (Lightning Racer, Racer 75, ...) use the multitrack infobox, with
# per-track stats as height/height2, speed/speed2, ...
INFOBOX_TEMPLATES = ["Template:Infobox roller coaster", "Template:Infobox coaster multitrack"]
REQUEST_DELAY = 1.0  # seconds between requests; be polite to a volunteer-run wiki

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = ROOT / "data" / ".cache" / "coasterpedia-pages.json"
OUT_PATH = ROOT / "data" / "coasters.js"
FEATURED_PATH = ROOT / "data" / "featured.txt"
EXCLUDE_PATH = ROOT / "data" / "exclude.txt"
RANKING_PATH = ROOT / "data" / "ranking.json"  # from scripts/parse_rankings.py
DISCARDED_PATH = ROOT / "data" / "ranking-discarded.txt"
OVERRIDES_PATH = ROOT / "data" / "overrides.txt"

# Daily/infinite answers, plus data/featured.txt, minus data/exclude.txt:
#   - if data/ranking.json exists: every ranked coaster that matches a complete Coasterpedia entry;
#   - otherwise: the POOL_SIZE best-known POOL_STATUSES coasters by article length (a fame proxy).
POOL_SIZE = 300
POOL_STATUSES = {"operating"}

# Coasters with these statuses are left out of the game entirely (not even guessable).
DROP_STATUSES = {"defunct"}

# True: only answer-pool coasters are written out, so they're the only ones you can guess.
# False: every complete, non-dropped Coasterpedia coaster is guessable.
GUESSABLE_ONLY_ANSWERS = True

M_TO_FT = 3.28084
KMH_TO_MPH = 0.621371

# Coasterpedia country strings -> continent. Unmapped countries are reported at the end.
CONTINENTS = {
    "North America": [
        "USA", "United States", "Canada", "Mexico", "Guatemala", "Costa Rica", "Panama",
        "Puerto Rico", "Dominican Republic", "Honduras", "El Salvador", "Jamaica", "Cuba",
        "Nicaragua", "Bahamas", "Trinidad and Tobago",
    ],
    "South America": [
        "Brazil", "Argentina", "Chile", "Colombia", "Peru", "Venezuela", "Ecuador",
        "Uruguay", "Paraguay", "Bolivia",
    ],
    "Europe": [
        "UK", "United Kingdom", "England", "Scotland", "Wales", "Northern Ireland", "Ireland",
        "France", "Germany", "Spain", "Portugal", "Italy", "Netherlands", "Belgium",
        "Luxembourg", "Switzerland", "Austria", "Denmark", "Sweden", "Norway", "Finland",
        "Iceland", "Poland", "Czech Republic", "Czechia", "Slovakia", "Hungary", "Slovenia",
        "Croatia", "Serbia", "Bosnia and Herzegovina", "Montenegro", "North Macedonia",
        "Albania", "Greece", "Bulgaria", "Romania", "Moldova", "Ukraine", "Belarus",
        "Lithuania", "Latvia", "Estonia", "Russia", "Turkey", "Türkiye", "Cyprus", "Malta",
        "Georgia", "Armenia", "Azerbaijan", "Andorra", "Monaco", "San Marino",
    ],
    "Asia": [
        "China", "Japan", "South Korea", "North Korea", "Taiwan", "Hong Kong", "Macau",
        "Mongolia", "India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Thailand",
        "Vietnam", "Malaysia", "Singapore", "Indonesia", "Philippines", "Cambodia", "Laos",
        "Myanmar", "Kazakhstan", "Uzbekistan", "Turkmenistan", "Kyrgyzstan", "Tajikistan",
        "Iran", "Iraq", "Israel", "Jordan", "Lebanon", "Syria", "Saudi Arabia", "UAE",
        "United Arab Emirates", "Qatar", "Kuwait", "Bahrain", "Oman", "Yemen",
    ],
    "Africa": [
        "Egypt", "Morocco", "Algeria", "Tunisia", "Libya", "South Africa", "Nigeria",
        "Kenya", "Ghana", "Ethiopia", "Tanzania", "Mauritius", "Botswana", "Angola",
    ],
    "Oceania": ["Australia", "New Zealand"],
}
CONTINENT_OF = {country.lower(): cont for cont, countries in CONTINENTS.items() for country in countries}
COUNTRY_ALIASES = {"united states": "USA", "united kingdom": "UK", "united arab emirates": "UAE", "czechia": "Czech Republic"}

# Long manufacturer names -> what enthusiasts actually call them (keeps ticket cells readable).
MAKER_SHORT = {
    "Bolliger & Mabillard": "B&M",
    "Rocky Mountain Construction": "RMC",
    "Great Coasters International": "GCI",
    "Philadelphia Toboggan Coasters": "PTC",
    "Philadelphia Toboggan Company": "PTC",
    "Custom Coasters International": "CCI",
    "S&S Worldwide": "S&S",
    "S&S Power": "S&S",
    "Arrow Dynamics": "Arrow",
    "Arrow Development": "Arrow",
    "Mack Rides": "Mack",
    "Maurer Rides": "Maurer",
    "Maurer Söhne": "Maurer",
    "Premier Rides": "Premier",
    "Chance Rides": "Chance",
    "The Gravity Group": "Gravity Group",
    "Morgan Manufacturing": "Morgan",
}


# ---------- Fetching ----------

def api_get(params):
    params = {**params, "format": "json", "formatversion": "2", "maxlag": "5"}
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                wait = int(e.headers.get("Retry-After") or 10 * (attempt + 1))
                print(f"  HTTP {e.code}, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        if data.get("error", {}).get("code") == "maxlag":
            time.sleep(5 * (attempt + 1))
            continue
        if "error" in data:
            raise RuntimeError(data["error"])
        return data
    raise RuntimeError(f"giving up on {url}")


def fetch_pages(template):
    """Every article that uses the given infobox template, with its current wikitext."""
    pages = {}
    cont = {}
    while True:
        data = api_get({
            "action": "query",
            "generator": "embeddedin",
            "geititle": template,
            "geinamespace": "0",
            "geilimit": "50",
            "prop": "revisions",
            "rvprop": "content|ids",
            "rvslots": "main",
            **cont,
        })
        for p in data.get("query", {}).get("pages", []):
            entry = pages.setdefault(p["pageid"], {"title": p["title"]})
            revs = p.get("revisions")
            if revs:
                entry["revid"] = revs[0]["revid"]
                entry["wikitext"] = revs[0]["slots"]["main"]["content"]
        print(f"  {len(pages)} pages", end="\r", file=sys.stderr)
        if "continue" not in data:
            break
        cont = data["continue"]
        time.sleep(REQUEST_DELAY)
    print(file=sys.stderr)
    return list(pages.values())


# ---------- Wikitext parsing ----------

INFOBOX_START = re.compile(r"\{\{\s*Infobox[ _](?:roller[ _]coaster|coaster[ _]multitrack)\s*(?=[|}])", re.I)


def extract_infobox(wikitext):
    """Return {param: raw value} for the first coaster infobox, or None."""
    m = INFOBOX_START.search(wikitext)
    if not m:
        return None
    i = m.end()
    depth_tpl, depth_link = 1, 0
    params, buf = [], []
    while i < len(wikitext):
        two = wikitext[i:i + 2]
        if two == "{{":
            depth_tpl += 1; buf.append(two); i += 2; continue
        if two == "}}":
            depth_tpl -= 1
            if depth_tpl == 0:
                params.append("".join(buf))
                break
            buf.append(two); i += 2; continue
        if two == "[[":
            depth_link += 1; buf.append(two); i += 2; continue
        if two == "]]":
            depth_link = max(0, depth_link - 1); buf.append(two); i += 2; continue
        ch = wikitext[i]
        if ch == "|" and depth_tpl == 1 and depth_link == 0:
            params.append("".join(buf)); buf = []
        else:
            buf.append(ch)
        i += 1
    box = {}
    for p in params:
        if "=" in p:
            k, v = p.split("=", 1)
            box[k.strip().lower()] = v.strip()
    return box


def clean(value):
    """Wikitext -> plain text, keeping only the first line."""
    if not value:
        return ""
    s = re.sub(r"<!--.*?-->", "", value, flags=re.S)
    s = re.sub(r"<ref[^>]*/>", "", s, flags=re.I)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.I | re.S)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    # innermost templates first: {{name|first|...}} -> first
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"\{\{[^{}|]*(?:\|([^{}|]*))?[^{}]*\}\}", lambda m: m.group(1) or "", s)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)  # [[target|text]] / [[text]]
    s = s.replace("'''", "").replace("''", "")
    s = s.replace("&nbsp;", " ")
    first = next((line.strip() for line in s.split("\n") if line.strip()), "")
    return re.sub(r"\s+", " ", first).strip(" ,;")


def number(value):
    m = re.search(r"\d[\d,]*(?:\.\d+)?", clean(value))
    return float(m.group().replace(",", "")) if m else None


def year(value):
    m = re.search(r"\b(18[5-9]\d|19\d\d|20\d\d)\b", clean(value))
    return int(m.group(1)) if m else None


def coaster_type(box):
    track = clean(box.get("track_material", "")).lower()
    support = clean(box.get("support_material", "")).lower()
    if track.startswith("wood"):
        return "Wood"
    if track.startswith("steel") and support.startswith("wood"):
        return "Hybrid"
    if track:
        return "Steel"
    return None


def maker(box):
    # Classic woodies often list only a designer (e.g. "The Gravity Group, LLC"), so fall back to it.
    name = next((clean(box.get(k, "")) for k in ("manufacturer", "builder", "designer") if clean(box.get(k, ""))), "Unknown")
    name = re.sub(r",?\s+(LLC|Inc\.?|GmbH|Ltd\.?)$", "", name)
    return MAKER_SHORT.get(name, name)


def strip_disambig(title):
    return re.sub(r"\s*\([^)]*\)$", "", title)


def page_identity(page):
    """Name/park/country of a page whose stats may be incomplete (used to explain ranking discards)."""
    box = extract_infobox(page.get("wikitext", "")) or {}
    country = clean(box.get("country", ""))
    return {
        "name": strip_disambig(page["title"]),
        "aka": clean(box.get("name", "")),
        "park": clean(box.get("park", "")),
        "country": COUNTRY_ALIASES.get(country.lower(), country),
        "status": clean(box.get("status", "")).lower(),
        "page": page["title"],
    }


NUMERIC_FIELDS = {"year", "height", "speed", "inversions"}


def load_overrides():
    """data/overrides.txt: "Coasterpedia page title | field=value, field=value" -> {title: {field: value}}."""
    out = {}
    if OVERRIDES_PATH.exists():
        for line in OVERRIDES_PATH.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            title, _, fields = (part.strip() for part in line.partition("|"))
            for pair in fields.split(","):
                key, _, value = (x.strip() for x in pair.partition("="))
                out.setdefault(title, {})[key] = int(value) if key in NUMERIC_FIELDS else value
    return out


OVERRIDES = load_overrides()


def parse_page(page):
    box = extract_infobox(page.get("wikitext", ""))
    if box is None:
        return None, "no infobox"

    metric = clean(box.get("units", "")).lower() != "imperial"  # template default is metric
    # multitrack infoboxes: use track 1, falling back to track 2 where track 1 is blank
    for key in ("height", "speed", "inversions", "rider_inversions"):
        if not clean(box.get(key, "")) and clean(box.get(key + "2", "")):
            box[key] = box[key + "2"]
    height = number(box.get("height"))
    speed = number(box.get("speed"))
    if height is not None and metric:
        height *= M_TO_FT
    if speed is not None and metric:
        speed *= KMH_TO_MPH

    inv_raw = box.get("rider_inversions") or box.get("inversions")
    inversions = number(inv_raw) if inv_raw is not None else None

    country = clean(box.get("country", ""))
    country = COUNTRY_ALIASES.get(country.lower(), country)

    coaster = {
        # The page title tracks renames; the infobox name is sometimes the old one (Mantis -> Rougarou).
        "name": strip_disambig(page["title"]),
        "park": clean(box.get("park", "")),
        "country": country,
        "continent": CONTINENT_OF.get(country.lower()),
        "maker": maker(box),
        "type": coaster_type(box),
        "year": year(box.get("opened", "")),
        "height": round(height) if height is not None else None,
        "speed": round(speed) if speed is not None else None,
        "inversions": int(inversions) if inversions is not None else None,
        "status": clean(box.get("status", "")).lower() or None,
        "page": page["title"],
    }
    aka = clean(box.get("name", ""))
    if aka and norm(aka) != norm(coaster["name"]):
        coaster["aka"] = aka  # searchable in the game, so old names still find the coaster
    coaster["_article_len"] = len(page.get("wikitext", ""))
    # A coaster with a blank inversions field almost always has none, but only trust
    # that if the page has otherwise-complete stats.
    if coaster["inversions"] is None and height is not None and speed is not None:
        coaster["inversions"] = 0

    coaster.update(OVERRIDES.get(page["title"], {}))  # hand-filled gaps, see data/overrides.txt
    if coaster["inversions"] is None and coaster["height"] and coaster["speed"]:
        coaster["inversions"] = 0
    coaster["continent"] = CONTINENT_OF.get(coaster["country"].lower())

    missing = [k for k in ("park", "country", "type", "year", "height", "speed") if not coaster[k]]
    if missing:
        return None, "missing " + "+".join(missing)
    return coaster, None


# ---------- Answer pool ----------

def norm(s):
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def match_list(path, coasters):
    """Lines are "Name @ Park" (park optional; old names work too). Returns (matched, unmatched lines)."""
    if not path.exists():
        return [], []
    by_name = {}
    for c in coasters:
        for n in {norm(c["name"]), norm(c.get("aka", ""))} - {""}:
            by_name.setdefault(n, []).append(c)
    matched, unmatched = [], []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name, _, park = (part.strip() for part in line.partition("@"))
        candidates = list({id(c): c for c in by_name.get(norm(name), [])}.values())
        if park:
            exact = [c for c in candidates if norm(c["park"]) == norm(park)]
            loose = [c for c in candidates if norm(park) in norm(c["park"]) or norm(c["park"]) in norm(park)]
            candidates = exact or loose
        if len(candidates) == 1:
            matched.append(candidates[0])
        else:
            unmatched.append(f"{line}  ({'ambiguous' if candidates else 'not found'})")
    return matched, unmatched


PARK_STOPWORDS = {"the", "park", "theme", "amusement", "resort", "and", "of", "de", "la", "le", "parc"}
# Chain names say nothing about which park it is: "Six Flags Great America" vs "Six Flags Great Adventure".
PARK_CHAIN_WORDS = {"six", "flags", "busch", "gardens", "universal", "universals", "studios", "disney", "disneys",
                    "warner", "bros", "seaworld", "cedar", "fair", "parques", "reunidos", "merlin"}
# Captain Coaster park name (normalized) -> Coasterpedia's, for renames and nicknames.
PARK_ALIASES = {
    "six flags st louis": "mid america adventure",
    "lake winnie": "lake winnepesaukah",
}


def name_keys(name):
    """Normalized spellings to compare on: as-is, without "(…)", without a leading "the"."""
    keys = {norm(name), norm(re.sub(r"\([^)]*\)", "", name))}
    keys |= {k[4:] for k in keys if k.startswith("the ")}
    keys |= {k.replace(" ", "") for k in keys}  # "F.L.Y." / "FLY", "Powder Keg" / "PowderKeg"
    return keys - {""}


def same_park(a, b):
    a, b = norm(a), norm(b)
    a, b = PARK_ALIASES.get(a, a), PARK_ALIASES.get(b, b)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    ta = set(a.split()) - PARK_STOPWORDS - PARK_CHAIN_WORDS
    tb = set(b.split()) - PARK_STOPWORDS - PARK_CHAIN_WORDS
    if not ta or not tb:
        return False
    small, big = sorted((ta, tb), key=len)
    if len(small) >= 2 and small <= big:  # "Abu Dhabi" within "Yas Island Abu Dhabi"
        return True
    # share most of the distinctive words ("Great America" vs "Great Adventure" shares only half)
    return len(ta & tb) / len(big) > 0.5


def similar_name(a, b):
    a, b = norm(a).replace(" ", ""), norm(b).replace(" ", "")
    if min(len(a), len(b)) >= 5 and (a in b or b in a):  # "VelociCoaster" vs "Jurassic World VelociCoaster"
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def match_ranking(entries, records):
    """records: (kind, coaster-or-identity) for every Coasterpedia page; kind is ok/incomplete/defunct.
    Returns (matched ok coasters in rank order, [(entry, reason)] discards)."""
    by_key = {}
    for rec in records:
        _, c = rec
        for k in name_keys(c["name"]) | name_keys(c.get("aka", "")):
            by_key.setdefault(k, []).append(rec)

    matched, discarded, seen = [], [], set()
    for e in entries:
        cands = list({id(r): r for k in name_keys(e["name"]) for r in by_key.get(k, [])}.values())
        hits = [r for r in cands if same_park(e["park"], r[1]["park"])]
        if not hits:  # renamed/rebranded: similar name at the same park
            hits = [r for r in records if same_park(e["park"], r[1]["park"]) and similar_name(e["name"], r[1]["name"])]
        if not hits:
            discarded.append((e, "no matching coaster on Coasterpedia"))
            continue
        # prefer a usable entry (an older defunct incarnation can share the name)
        kind, c = next((r for r in hits if r[0] == "ok"), hits[0])
        if kind == "incomplete":
            discarded.append((e, f"Coasterpedia page \"{c['page']}\" has incomplete stats ({c['reason']})"))
        elif kind == "defunct":
            discarded.append((e, f"Coasterpedia lists \"{c['page']}\" as defunct"))
        elif id(c) not in seen:
            seen.add(id(c))
            matched.append(c)
    return matched, discarded


def mark_answers(coasters, dropped, incomplete):
    if RANKING_PATH.exists():
        entries = json.loads(RANKING_PATH.read_text(encoding="utf-8"))
        records = [("ok", c) for c in coasters] + [("defunct", c) for c in dropped] + [
            ("defunct" if c["status"] in DROP_STATUSES else "incomplete", c) for c in incomplete
        ]
        ranked, discarded = match_ranking(entries, records)
        source = f"{len(ranked)} of {len(entries)} Captain Coaster-ranked coasters ({RANKING_PATH.relative_to(ROOT)})"
        DISCARDED_PATH.write_text(
            "# Ranked coasters left out of the answer pool. Regenerated by import_coasterpedia.py.\n"
            + "".join(f"{e['continent']} #{e['rank']}: {e['name']} @ {e['park']}  -- {why}\n" for e, why in discarded),
            encoding="utf-8",
        )
    else:
        eligible = [c for c in coasters if c["status"] in POOL_STATUSES]
        ranked = sorted(eligible, key=lambda c: -c["_article_len"])[:POOL_SIZE]
        discarded = []
        cutoff = ranked[-1]["_article_len"] if ranked else 0
        source = f"{len(ranked)} best-known {'/'.join(sorted(POOL_STATUSES))} by article length (cutoff {cutoff} chars)"
    # match against dropped coasters too, so a featured defunct coaster is reported as such
    featured, unmatched_f = match_list(FEATURED_PATH, coasters + dropped)
    dropped_ids = {id(c) for c in dropped}
    unmatched_f += [f"{c['name']} @ {c['park']}  ({c['status']}, so not in the game)" for c in featured if id(c) in dropped_ids]
    featured = [c for c in featured if id(c) not in dropped_ids]
    excluded, unmatched_x = match_list(EXCLUDE_PATH, coasters)
    excluded_ids = {id(c) for c in excluded}
    pool = {id(c): c for c in ranked + featured if id(c) not in excluded_ids}
    for c in pool.values():
        c["answer"] = True
    return {
        "source": source,
        "discarded": discarded,
        "featured_only": [c for c in featured if id(c) not in {id(r) for r in ranked}],
        "excluded": len(excluded),
        "total": len(pool),
        "unmatched": [(FEATURED_PATH, unmatched_f), (EXCLUDE_PATH, unmatched_x)],
    }


# ---------- Main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download pages even if cached")
    args = ap.parse_args()

    # cache: {template: [pages]} (an older cache was a bare list of standard-infobox pages)
    cache = json.loads(CACHE_PATH.read_text(encoding="utf-8")) if CACHE_PATH.exists() and not args.refresh else {}
    if isinstance(cache, list):
        cache = {INFOBOX_TEMPLATES[0]: cache}
    for template in INFOBOX_TEMPLATES:
        if template in cache:
            print(f"Using {len(cache[template])} cached pages for {template}; --refresh to re-download")
        else:
            print(f"Downloading pages using {template} from Coasterpedia…")
            cache[template] = fetch_pages(template)
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    pages = list({p["title"]: p for template in INFOBOX_TEMPLATES for p in cache[template]}.values())

    coasters, skipped, incomplete = [], Counter(), []
    for page in pages:
        coaster, reason = parse_page(page)
        if coaster:
            coasters.append(coaster)
        else:
            skipped[reason] += 1
            incomplete.append({**page_identity(page), "reason": reason})

    unused = set(OVERRIDES) - {p["title"] for p in pages}
    if unused:
        print(f"Warning: {OVERRIDES_PATH.relative_to(ROOT)} names pages that don't exist: {sorted(unused)}")

    # Same name at the same park (e.g. a page per incarnation): keep the newest.
    deduped = {}
    for c in sorted(coasters, key=lambda c: c["year"]):
        deduped[(norm(c["name"]), norm(c["park"]))] = c
    coasters = sorted(deduped.values(), key=lambda c: (norm(c["name"]), norm(c["park"])))
    dropped = [c for c in coasters if c["status"] in DROP_STATUSES]
    coasters = [c for c in coasters if c["status"] not in DROP_STATUSES]

    pool = mark_answers(coasters, dropped, incomplete)
    for c in coasters:
        del c["_article_len"]
    not_answers = sum(1 for c in coasters if not c.get("answer"))
    if GUESSABLE_ONLY_ANSWERS:
        coasters = [c for c in coasters if c.get("answer")]

    header = (
        "// Generated by scripts/import_coasterpedia.py — do not edit by hand.\n"
        "// Data from Coasterpedia (https://coasterpedia.net), CC BY-SA 4.0. See data/LICENSE.\n"
        "// height: feet, speed: mph, year: year opened.\n"
    )
    body = ",\n".join("  " + json.dumps(c, ensure_ascii=False) for c in coasters)
    OUT_PATH.write_text(f"{header}window.COASTERS = [\n{body}\n];\n", encoding="utf-8")

    # ---- report ----
    print(f"\nWrote {len(coasters)} coasters to {OUT_PATH.relative_to(ROOT)}")
    print(f"Left out {len(dropped)} {'/'.join(sorted(DROP_STATUSES))} coasters")
    if GUESSABLE_ONLY_ANSWERS:
        print(f"Left out {not_answers} complete coasters that aren't in the answer pool (GUESSABLE_ONLY_ANSWERS)")
    print(f"Skipped {sum(skipped.values())} pages:")
    for reason, n in skipped.most_common(8):
        print(f"  {n:5}  {reason}")
    no_continent = Counter(c["country"] for c in coasters if not c["continent"])
    if no_continent:
        print("Countries with no continent mapping (add to CONTINENTS):")
        print("  " + ", ".join(f"{k} ({v})" for k, v in no_continent.most_common()))
    print(f"Answer pool: {pool['total']} coasters")
    print(f"  {pool['source']}")
    print(f"  +{len(pool['featured_only'])} more from {FEATURED_PATH.relative_to(ROOT)}, -{pool['excluded']} via {EXCLUDE_PATH.relative_to(ROOT)}")
    for c in pool["featured_only"]:
        print(f"    + {c['name']} @ {c['park']}")
    if pool["discarded"]:
        reasons = Counter(why.split(" (")[0].split('"')[0].strip() for _, why in pool["discarded"])
        print(f"  {len(pool['discarded'])} ranked coasters discarded (listed in {DISCARDED_PATH.relative_to(ROOT)}):")
        for why, n in reasons.most_common():
            print(f"    {n:4}  {why}")
    for path, lines in pool["unmatched"]:
        if lines:
            print(f"Unmatched lines in {path.relative_to(ROOT)}:")
            for line in lines:
                print("  " + line)


if __name__ == "__main__":
    main()
