#!/usr/bin/env python3
"""Parse saved Captain Coaster ranking pages into data/ranking.json.

The pages are saved by hand from https://captaincoaster.com/en/ranking/?filters[continent]=N&page=P
(50 coasters per page; save every page needed for each continent). Both a normal "Save page as"
and a saved view-source: page work.

    python3 scripts/parse_rankings.py                  # data/*ranking*.html
    python3 scripts/parse_rankings.py path/to/a.html ...

Only the top N per continent are kept (LIMITS below). import_coasterpedia.py then matches
these against Coasterpedia and uses the matches as the daily/infinite answer pool.
"""

import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "data" / "ranking.json"

# Captain Coaster continent filter id -> (name, how many top entries to keep; None = all)
CONTINENTS = {
    "2": ("America", 325),
    "1": ("Europe", 50),
    "3": ("Asia", 50),
    "5": ("Oceania", None),
    "4": ("Africa", None),
}

ENTRY = re.compile(r'<li\b[^>]*>\s*<a href="/\w+/coasters/(\d+)/([^"]+)"(.*?)</a>\s*</li>', re.S)
# Page 1 shows the top spots as big photo cards ("podium") instead of list rows.
PODIUM = re.compile(r'<a href="/\w+/coasters/(\d+)/([^"]+)" data-cover(.*?)</a>', re.S)


def page_source(path):
    """Raw HTML, unwrapping a saved view-source: page if needed."""
    text = path.read_text(encoding="utf-8")
    if 'class="line-content"' in text:
        lines = re.findall(r'<td class="line-content">(.*?)</td>', text, flags=re.S)
        text = "\n".join(html.unescape(re.sub(r"<[^>]+>", "", line)) for line in lines)
    return text


def text_of(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def parse_entry(cc_id, slug, body):
    rank = re.search(r'text-brand tabular-nums">\s*(\d+)', body)
    name = re.search(r'<span class="block font-semibold leading-tight"\s*>(.*?)</span>', body, re.S)
    truncs = re.findall(r'<span class="block truncate[^"]*">(.*?)</span>', body, re.S)
    columns = re.findall(r'<span class="hidden min-w-0 truncate @3xl/ledger:block text-muted-strong">(.*?)</span>', body, re.S)
    world = re.search(r"World #(\d+)", body)
    return {
        "rank": int(rank.group(1)) if rank else None,
        "world_rank": int(world.group(1)) if world else None,
        "cc_id": int(cc_id),
        "name": text_of(name.group(1)) if name else slug,
        "park": text_of(truncs[0]) if truncs else "",
        "maker": text_of(columns[0]) if columns else "",
        "country": text_of(columns[1]) if len(columns) > 1 else "",
    }


def parse_podium(cc_id, slug, body):
    rank = re.search(r'text-podium-[^"]*">\s*(\d+)\s*<', body)
    name = re.search(r'<span class="line-clamp-2[^"]*"\s*>(.*?)</span>', body, re.S)
    park_maker = re.search(r'<span class="truncate">(.*?)</span>', body, re.S)
    park, _, maker = text_of(park_maker.group(1)).partition(" – ") if park_maker else ("", "", "")
    world = re.search(r"World #(\d+)", body)
    return {
        "rank": int(rank.group(1)) if rank else None,
        "world_rank": int(world.group(1)) if world else None,
        "cc_id": int(cc_id),
        "name": text_of(name.group(1)) if name else slug,
        "park": park,
        "maker": maker,
        "country": "",  # not shown on podium cards
    }


def parse_file(path):
    """(continent id, entries) for one saved page."""
    src = page_source(path)
    m = re.search(r'filters(?:%5B|\[)continent(?:%5D|\])=(\d+)', src)
    if not m or m.group(1) not in CONTINENTS:
        raise SystemExit(f"{path.name}: can't tell which continent this ranking page is filtered to")
    entries = [parse_podium(*x) for x in PODIUM.findall(src)] + [parse_entry(*x) for x in ENTRY.findall(src)]
    return m.group(1), [e for e in entries if e["rank"] is not None]


def main():
    paths = [Path(p) for p in sys.argv[1:]] or sorted((ROOT / "data").glob("*ranking*.html"))
    if not paths:
        raise SystemExit("No ranking pages found. Save them as data/*ranking*.html or pass paths.")

    # A continent's ranking spans several pages of 50; merge every saved page per continent.
    by_continent = {}
    for path in paths:
        cid, entries = parse_file(path)
        merged = by_continent.setdefault(cid, {})
        for e in entries:
            merged[e["cc_id"]] = {**merged.get(e["cc_id"], {}), **{k: v for k, v in e.items() if v}}

    results = []
    for cid, merged in sorted(by_continent.items(), key=lambda kv: list(CONTINENTS).index(kv[0])):
        continent, limit = CONTINENTS[cid]
        entries = sorted(merged.values(), key=lambda e: e["rank"])
        ranks = [e["rank"] for e in entries]
        wanted = limit or ranks[-1]
        missing = sorted(set(range(1, wanted + 1)) - set(ranks))
        if missing:
            raise SystemExit(
                f"{continent}: missing ranks {missing[0]}–{missing[-1]} (saved pages cover {len(ranks)} ranks). "
                f"Save the missing pages: /en/ranking/?filters[continent]={cid}&page=N (50 per page)."
            )
        kept = entries[:wanted]
        for e in kept:
            e.setdefault("country", "")
            e["continent"] = continent
        print(f"{continent:8} {len(entries):4} ranks saved, kept top {len(kept)}")
        results += kept

    OUT_PATH.write_text(json.dumps(results, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(results)} ranked coasters to {OUT_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
