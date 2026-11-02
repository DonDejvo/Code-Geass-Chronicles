#!/usr/bin/env python3
"""
Code Geass fandom wiki scraper (MediaWiki API -> SQLite -> JSON export).

Stages (run in order, or `all`):
    python scrape_codegeass.py discover [keyword ...]   # find real category names
    python scrape_codegeass.py links "Page Title" [--section X] [--add character --season Akito]
    python scrape_codegeass.py fetch                    # download raw wikitext + redirects/aliases
    python scrape_codegeass.py parse                    # infoboxes, synopsis paragraphs, entity links
    python scrape_codegeass.py export                   # JSON files for extract_events.py
    python scrape_codegeass.py all

Setup:
    pip install requests mwparserfromhell

IMPORTANT
  * Edit CATEGORIES below after running `discover`. The names there are best guesses.
  * Set CONTACT to your email/URL (descriptive User-Agent is polite and expected).
  * Wiki text is CC BY-SA. Credit the Code Geass Wiki and keep the license if you publish data.
  * Raw wikitext is stored first, so you can re-run `parse` as often as you like without re-scraping.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import mwparserfromhell as mwp
import requests

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
WIKI = os.environ.get("WIKI", "codegeass.fandom.com")
API = f"https://{WIKI}/api.php"
BASE_URL = f"https://{WIKI}/wiki/"
CONTACT = "dada542cz@gmail.com"
USER_AGENT = f"CodeGeassTimelineBot/0.1 ({CONTACT})"
DELAY = 1.0  # seconds between requests
DB_PATH = "codegeass.db"
EXPORT_DIR = Path("export")
OVERRIDES_FILE = Path("episode_overrides.json")  # optional: {"Page Title": 7}

# Category names verified with `discover`.
# "depth" = how many levels of subcategories to follow.
# All episodes (R1, R2, Akito, ...) live together in Category:Episodes (57 pages + 2 subcats),
# so the season is NOT given here: it is detected per episode (see SEASON_RULES below).
CATEGORIES = {
    "episode": {"depth": 1, "seasons": {"": ["Category:Episodes"]}},
    "character": {"depth": 1, "seasons": {"": ["Category:Characters"]}},
    "faction": {"depth": 1, "seasons": {"": ["Category:Organizations"]}},
    "location": {"depth": 1, "seasons": {"": ["Category:Locations"]}},
}

# Extra pages added by the `links` command (or by hand): [{"title","kind","season"}]
EXTRA_PAGES_FILE = Path("extra_pages.json")
VALID_KINDS = ("episode", "character", "faction", "location")

# Where each series sits in IN-UNIVERSE chronology (NOT air date). `slot` only gives a first-pass
# ordering; exact interleaving is refined later from in-universe dates / relative-date resolution.
SERIES = {
    "R1": {"slot": 1, "label": "Lelouch of the Rebellion (R1)", "note": ""},
    "Akito": {
        "slot": 2,
        "label": "Code Geass: Akito the Exiled (OVA, 5 episodes)",
        "note": "Theatrical OVA spin-off set in Europe (E.U. front), 2017 a.t.b. The wiki describes it "
                "as a midquel between R1 and R2, after the rise of the Black Knights. Its events run "
                "in parallel to the main story and mostly involve different characters.",
    },
    "R2": {"slot": 3, "label": "Lelouch of the Rebellion R2", "note": ""},
}

# Season detection for pages from Category:Episodes. Rules are tried in order against, in priority:
#   1. infobox values (season / series / anime / ...), 2. the page's [[Category:...]] tags,
#   3. the subcategory the page was found in, 4. the page title.
# First rule that matches wins. Run `parse` and check the printed per-season counts; fix rules or
# use SEASON_OVERRIDES_FILE ({"Page Title": "R2"}) for the leftovers.
SEASON_RULES = [
    ("Akito", re.compile(r"akito", re.I)),
    ("R2", re.compile(r"\bR2\b|rebellion\s+r2|season\s*2|second\s+season", re.I)),
    ("R1", re.compile(r"\bR1\b|lelouch of the rebellion|season\s*1|first\s+season", re.I)),
    # Numbering scheme in titles: R1 = "Stage N", R2 = "Turn N" (also covers sound episodes like "Stage 3.25")
    ("R1", re.compile(r"^stage\s*\d", re.I)),
    ("R2", re.compile(r"^turn\s*\d", re.I)),
]
# The wiki's episode list page has one section per series; every episode linked inside a section
# inherits that section's season. This catches the ~50 regular episodes whose pages say nothing.
EPISODE_LIST_PAGES = re.compile(r"^episode list$", re.I)
NUMERIC_SEASONS = {"1": "R1", "2": "R2"}  # infobox `season = 1`; Akito is caught by name instead
SEASON_INFOBOX_KEYS =("season", "series", "anime", "show", "title", "part", "media")
SEASON_OVERRIDES_FILE = Path("season_overrides.json")  # optional: {"Page Title": "R2"}
# Pages in Category:Episodes that are lists/hubs, not single episodes (matched against the title).
EXCLUDE_EPISODE_TITLES = re.compile(r"^(list of|episodes?$|episode guide|category:)|episode list$", re.I)

# Episodes that do not belong in the timeline: sound episodes / drama CDs ("Stage 3.25", "Turn 0.56")
# and recap episodes. Recaps are detected from the lead sentence / page categories; anything the
# detector misses can be listed in EXCLUDE_FILE (["Page Title", ...]).
SOUND_EPISODE_TITLES = re.compile(r"^(stage|turn)\s*\d+\.\d+", re.I)
RECAP_RX = re.compile(r"\brecaps?\b", re.I)
EXCLUDE_FILE = Path("excluded_episodes.json")


def exclusion_reason(title, wikitext, manual):
    if title in manual:
        return "manual"
    if SOUND_EPISODE_TITLES.match(title):
        return "sound episode"
    body = wikitext[wikitext.find("\n}}") + 3:] if wikitext.lstrip().startswith("{{") else wikitext
    if RECAP_RX.search(body.strip()[:400]) or any(RECAP_RX.search(c) for c in page_categories(wikitext)):
        return "recap"
    return None


SYNOPSIS_HEADINGS = re.compile(r"^(synopsis|summary|plot|episode summary|story|plot summary)$", re.I)
AIRDATE_KEYS = ("airdate", "air date", "aired", "first aired", "airing date", "air_date")
NUMBER_KEYS = ("episode", "number", "ep", "no", "turn", "stage", "episode number", "episode no")

# ----------------------------------------------------------------------------
# HTTP / API helpers
# ----------------------------------------------------------------------------
session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def api(params):
    p = {"format": "json", "formatversion": 2, **params}
    for attempt in range(5):
        try:
            r = session.get(API, params=p, timeout=30)
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
        except (requests.RequestException, ValueError):
            time.sleep(2 ** attempt)
            continue
        time.sleep(DELAY)
        if "error" in data:
            raise RuntimeError(f"API error: {data['error']}")
        return data
    raise RuntimeError("API request failed after retries")


def api_all(params):
    """Yield every page of a continued API query."""
    cont = {}
    while True:
        data = api({**params, **cont})
        yield data
        if "continue" not in data:
            return
        cont = data["continue"]


def category_members_ex(cat, depth=0, _seen=None):
    """Yield (title, category_it_was_found_in) for articles (ns 0), following subcategories to `depth`."""
    _seen = _seen if _seen is not None else set()
    if cat in _seen:
        return
    _seen.add(cat)
    subcats = []
    for data in api_all({"action": "query", "list": "categorymembers", "cmtitle": cat,
                         "cmlimit": "500", "cmtype": "page|subcat"}):
        for m in data["query"]["categorymembers"]:
            if m["ns"] == 0:
                yield m["title"], cat
            elif m["ns"] == 14:
                subcats.append(m["title"])
    if depth > 0:
        for sc in subcats:
            yield from category_members_ex(sc, depth - 1, _seen)


def category_members(cat, depth=0):
    for title, _ in category_members_ex(cat, depth):
        yield title


def fetch_wikitext(titles):
    """Fetch raw wikitext for up to 50 titles. Returns {title: wikitext}."""
    data = api({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                "titles": "|".join(titles)})
    out = {}
    for page in data["query"]["pages"]:
        if page.get("missing"):
            continue
        try:
            out[page["title"]] = page["revisions"][0]["slots"]["main"]["content"]
        except (KeyError, IndexError):
            pass
    return out


def fetch_redirects(titles):
    """Return [(alias, canonical_title)] for up to 50 titles."""
    pairs = []
    for data in api_all({"action": "query", "prop": "redirects", "titles": "|".join(titles),
                         "rdlimit": "max", "rdnamespace": 0}):
        for page in data["query"]["pages"]:
            for rd in page.get("redirects", []):
                pairs.append((rd["title"], page["title"]))
    return pairs


# ----------------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
    title TEXT PRIMARY KEY, kind TEXT, season TEXT, wikitext TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, title TEXT);
CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT UNIQUE, wiki_url TEXT,
    infobox_name TEXT, infobox_json TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, number INTEGER, title TEXT UNIQUE,
    wiki_url TEXT, air_date TEXT, infobox_json TEXT, synopsis_fallback INTEGER);
CREATE TABLE IF NOT EXISTS episode_paragraphs (
    episode_title TEXT, idx INTEGER, text TEXT, links_json TEXT,
    PRIMARY KEY (episode_title, idx));
"""


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    return conn


def url_for(title):
    return BASE_URL + title.replace(" ", "_")


# ----------------------------------------------------------------------------
# Wikitext parsing helpers
# ----------------------------------------------------------------------------
_NS_PREFIX = re.compile(r"(?i)^:?(file|image|category|media|special|template):")
LB, RB = "\u27e6", "\u27e7"  # placeholders that survive strip_code()


def clean(code, keep_links=True):
    """
    Wikitext -> plain text. Wikilinks are kept as [[Target]] (or `Shown text ([[Target]])`
    when the display text differs, e.g. "Zero ([[Lelouch vi Britannia]])").
    """
    if isinstance(code, str):
        code = mwp.parse(code)
    for tag in code.filter_tags(matches=lambda t: str(t.tag).strip().lower() in ("ref", "gallery", "references")):
        try:
            code.remove(tag)
        except ValueError:
            pass
    for link in code.filter_wikilinks():
        title = str(link.title).strip()
        try:
            if _NS_PREFIX.match(title):
                code.remove(link)
                continue
            target = title.lstrip(":").split("#")[0].strip()
            text = str(link.text).strip() if link.text is not None else None
            if not keep_links or not target:
                code.replace(link, text or target)
            elif text and text.lower() != target.lower():
                code.replace(link, f"{text} ({LB}{target}{RB})")
            else:
                code.replace(link, f"{LB}{target}{RB}")
        except ValueError:
            pass
    text = code.strip_code(normalize=True, collapse=True)
    text = text.replace(LB, "[[").replace(RB, "]]")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def parse_infobox(code):
    """Return (template_name, {param: cleaned_value}) for the first infobox-like template."""
    for tpl in code.filter_templates(recursive=False):
        name = str(tpl.name).strip()
        if "infobox" in name.lower():
            info = {}
            for p in tpl.params:
                key = str(p.name).strip()
                val = clean(p.value)
                if key and val:
                    info[key] = re.sub(r"\s*\n\s*", "; ", val)
            return name, info
    return None, {}


def split_paragraphs(text, min_len=25):
    paras = []
    for chunk in re.split(r"\n\s*\n|\n", text):
        chunk = chunk.strip()
        if len(chunk) < min_len or chunk.startswith(("{|", "|", "!", "}")):
            continue
        paras.append(chunk)
    return paras


def synopsis_paragraphs(code):
    """Return (paragraphs, used_fallback)."""
    for sec in code.get_sections(levels=[2], include_headings=True):
        heads = sec.filter_headings()
        if heads and SYNOPSIS_HEADINGS.match(str(heads[0].title).strip()):
            sec.remove(heads[0])
            # drop deeper headings so only prose remains
            for h in sec.filter_headings():
                sec.remove(h)
            return split_paragraphs(clean(sec)), False
    return split_paragraphs(clean(code)), True


def norm(s):
    return re.sub(r"\s+", " ", s.strip().lower())


def first_int(text):
    m = re.search(r"\d+", text or "")
    return int(m.group()) if m else None


def episode_number(info, title, overrides):
    if title in overrides:
        return overrides[title]
    for k, v in info.items():
        if k.lower().replace("_", " ") in NUMBER_KEYS:
            n = first_int(v)
            if n is not None:
                return n
    return None


def episode_airdate(info):
    for k, v in info.items():
        if k.lower().replace("_", " ") in AIRDATE_KEYS:
            return v
    return None


def page_categories(wikitext):
    """Category names from [[Category:X]] tags in raw wikitext."""
    return [c.strip() for c in re.findall(r"\[\[\s*Category\s*:\s*([^\]|]+)", wikitext, re.I)]


def build_list_map(conn):
    """{normalized episode title: season} from sections of the 'Episode List' page(s)."""
    out = {}
    for title, wt in conn.execute("SELECT title, wikitext FROM pages WHERE kind='episode'").fetchall():
        if not EPISODE_LIST_PAGES.match(title):
            continue
        code = mwp.parse(wt)
        for sec in code.get_sections(include_headings=True):
            heads = sec.filter_headings()
            if not heads:
                continue
            head = str(heads[0].title)
            season = next((s for s, rx in SEASON_RULES if rx.search(head)), None)
            if not season:
                continue
            for link in sec.filter_wikilinks():
                t = str(link.title).strip().lstrip(":").split("#")[0]
                if t and not _NS_PREFIX.match(t):
                    out.setdefault(norm(t), season)
    return out


def detect_season(title, info, wikitext, hint, overrides, list_map=None):
    """Return (season, how). `hint` = category the page was found in (or the stored season)."""
    if title in overrides:
        return overrides[title], "override"
    if hint in SERIES:  # explicit season from extra_pages.json
        return hint, "explicit"
    if list_map:
        base = re.sub(r"\s*\(episode\)$", "", title, flags=re.I)
        for key in (norm(title), norm(base)):
            if key in list_map:
                return list_map[key], "episode-list"
    info_vals = [v.strip() for k, v in info.items() if k.lower().replace("_", " ") in SEASON_INFOBOX_KEYS]
    for v in info_vals:  # infobox says `season = 1` / `season = 2`
        if v in NUMERIC_SEASONS:
            return NUMERIC_SEASONS[v], "infobox-number"
    info_text = " | ".join(info_vals)
    # lead sentence: "... is the second episode of ''[[Code Geass: Lelouch of the Rebellion R2]]''"
    body = wikitext[wikitext.find("\n}}") + 3:] if wikitext.lstrip().startswith("{{") else wikitext
    lead = body.strip()[:600]
    sources = (("infobox", info_text),
               ("lead", lead),
               ("page-category", " | ".join(page_categories(wikitext))),
               ("subcategory", hint or ""),
               ("title", title))
    for how, text in sources:
        if not text:
            continue
        for season, rx in SEASON_RULES:
            if rx.search(text):
                return season, how
    return "", "unknown"


def load_extra_pages():
    if EXTRA_PAGES_FILE.exists():
        return json.loads(EXTRA_PAGES_FILE.read_text(encoding="utf-8"))
    return []


# ----------------------------------------------------------------------------
# Stage: links  (seed pages from an overview page, e.g. the Akito series page)
# ----------------------------------------------------------------------------
MAIN_TEMPLATES = ("main", "main article", "see also", "further")


def cmd_links(page, section=None, add=None, season=""):
    texts = fetch_wikitext([page])
    if not texts:
        sys.exit(f"Page not found: {page}")
    code = mwp.parse(next(iter(texts.values())))
    scopes = [code]
    if section:
        scopes = [sec for sec in code.get_sections(include_headings=True)
                  if sec.filter_headings() and section.lower() in str(sec.filter_headings()[0].title).lower()]
        if not scopes:
            sys.exit(f"No section containing '{section}' on {page}")
    titles = []

    def add_title(t):
        t = t.strip().lstrip(":").split("#")[0].strip()
        if t and not _NS_PREFIX.match(t) and t not in titles:
            titles.append(t)

    for sc in scopes:
        for link in sc.filter_wikilinks():
            add_title(str(link.title))
        for tpl in sc.filter_templates():  # {{Main|Ryo Sayama}} style links
            if str(tpl.name).strip().lower() in MAIN_TEMPLATES and tpl.params:
                add_title(str(tpl.params[0].value))
    for t in titles:
        print(t)
    print(f"\n{len(titles)} titles.")
    if add:
        if add not in VALID_KINDS:
            sys.exit(f"--add must be one of {VALID_KINDS}")
        extra = load_extra_pages()
        known = {e["title"] for e in extra}
        new = [{"title": t, "kind": add, "season": season} for t in titles if t not in known]
        EXTRA_PAGES_FILE.write_text(json.dumps(extra + new, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Added {len(new)} pages as kind={add} season='{season}' to {EXTRA_PAGES_FILE}")


# ----------------------------------------------------------------------------
# Stage: discover
# ----------------------------------------------------------------------------
def cmd_inspect(unknown_only=True):
    """Debug: show what the parser sees on episode pages (infobox keys, categories, number, season)."""
    conn = db()
    for title, season, number, ib in conn.execute(
            "SELECT title, season, number, infobox_json FROM episodes ORDER BY season, number"):
        if unknown_only and season and number is not None:
            continue
        wt = conn.execute("SELECT wikitext FROM pages WHERE title=?", (title,)).fetchone()[0]
        print(f"\n== {title}  season={season or '?'} number={number}")
        print("   infobox keys:", list(json.loads(ib).keys())[:12])
        print("   categories  :", page_categories(wt)[:8])


def cmd_show(title, n=3000):
    """Debug: print the first n chars of the stored raw wikitext of a page."""
    conn = db()
    row = conn.execute("SELECT wikitext FROM pages WHERE title=?", (title,)).fetchone()
    if not row:
        sys.exit(f"Not in database: {title}")
    print(row[0][:n])


def cmd_discover(keywords):
    keywords = [k.lower() for k in (keywords or ["episode", "character", "organi", "faction", "location",
                                                  "place", "geass", "special", "ova", "movie"])]
    print(f"Categories on {WIKI} containing any of {keywords}:\n")
    found = []
    for data in api_all({"action": "query", "list": "allcategories", "aclimit": "500", "acprop": "size"}):
        for c in data["query"]["allcategories"]:
            name = c["category"]
            if any(k in name.lower() for k in keywords):
                found.append((name, c.get("pages", 0), c.get("subcats", 0)))
    for name, pages, subs in sorted(found):
        print(f"  Category:{name}   pages={pages} subcats={subs}")
    print("\nCopy the right ones into CATEGORIES at the top of this script.")


# ----------------------------------------------------------------------------
# Stage: fetch
# ----------------------------------------------------------------------------
def cmd_fetch(refresh=False):
    conn = db()
    existing = {r[0] for r in conn.execute("SELECT title FROM pages")}
    wanted = {}  # title -> (kind, season)
    for kind, cfg in CATEGORIES.items():
        for season, cats in cfg["seasons"].items():
            for cat in cats:
                n = 0
                for title, found_in in category_members_ex(cat, cfg["depth"]):
                    if kind == "episode":
                        if EXCLUDE_EPISODE_TITLES.search(title) or SOUND_EPISODE_TITLES.match(title):
                            continue
                        # no fixed season: remember which (sub)category it came from as a hint
                        wanted.setdefault(title, (kind, season or found_in))
                    else:
                        wanted.setdefault(title, (kind, season))
                    n += 1
                print(f"[{kind}/{season or '-'}] {cat}: {n} pages")
                if n == 0:
                    print("   ^ empty! Check the category name with `discover`.")

    extras = load_extra_pages()
    for item in extras:
        wanted.setdefault(item["title"], (item["kind"], item.get("season", "")))
    if extras:
        print(f"[extra] {len(extras)} pages from {EXTRA_PAGES_FILE}")

    todo = [t for t in wanted if refresh or t not in existing]
    print(f"\nDownloading wikitext for {len(todo)} pages ({len(wanted) - len(todo)} cached)...")
    now = datetime.now(timezone.utc).isoformat()
    for i in range(0, len(todo), 50):
        batch = todo[i:i + 50]
        texts = fetch_wikitext(batch)
        for title, wt in texts.items():
            kind, season = wanted[title]
            conn.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?)", (title, kind, season, wt, now))
        conn.commit()
        print(f"  {min(i + 50, len(todo))}/{len(todo)}")

    print("\nDownloading redirects (aliases)...")
    entity_titles = [r[0] for r in conn.execute("SELECT title FROM pages WHERE kind != 'episode'")]
    for i in range(0, len(entity_titles), 50):
        for alias, canon in fetch_redirects(entity_titles[i:i + 50]):
            conn.execute("INSERT OR REPLACE INTO aliases VALUES (?,?)", (alias, canon))
        conn.commit()
    print("Fetch done.")


# ----------------------------------------------------------------------------
# Stage: parse
# ----------------------------------------------------------------------------
def cmd_parse():
    conn = db()
    for t in ("entities", "episodes", "episode_paragraphs"):
        conn.execute(f"DELETE FROM {t}")
    overrides = json.loads(OVERRIDES_FILE.read_text()) if OVERRIDES_FILE.exists() else {}
    season_overrides = json.loads(SEASON_OVERRIDES_FILE.read_text()) if SEASON_OVERRIDES_FILE.exists() else {}

    # --- entities
    rows = conn.execute("SELECT title, kind, wikitext FROM pages WHERE kind != 'episode'").fetchall()
    for title, kind, wt in rows:
        if wt.lstrip().lower().startswith("#redirect"):
            continue
        code = mwp.parse(wt)
        ib_name, info = parse_infobox(code)
        paras = split_paragraphs(clean(code), min_len=40)
        conn.execute(
            "INSERT OR REPLACE INTO entities (kind,title,wiki_url,infobox_name,infobox_json,summary) VALUES (?,?,?,?,?,?)",
            (kind, title, url_for(title), ib_name, json.dumps(info, ensure_ascii=False),
             paras[0] if paras else ""))
    conn.commit()

    # --- link resolver: entity title or alias -> (canonical title, kind)
    resolver = {}
    for title, kind in conn.execute("SELECT title, kind FROM entities"):
        resolver[norm(title)] = (title, kind)
    for alias, canon in conn.execute("SELECT alias, title FROM aliases"):
        hit = resolver.get(norm(canon))
        if hit:
            resolver.setdefault(norm(alias), hit)

    # --- episodes
    rows = conn.execute("SELECT title, season, wikitext FROM pages WHERE kind = 'episode'").fetchall()
    unresolved = []
    no_season = []
    how_count = {}
    list_map = build_list_map(conn)
    if list_map:
        print(f"Episode List page mapped {len(list_map)} titles to seasons.")
    manual_excl = set(json.loads(EXCLUDE_FILE.read_text())) if EXCLUDE_FILE.exists() else set()
    excluded = []
    for title, hint, wt in rows:
        if (wt.lstrip().lower().startswith("#redirect") or EPISODE_LIST_PAGES.match(title)
                or EXCLUDE_EPISODE_TITLES.search(title)):
            continue
        reason = exclusion_reason(title, wt, manual_excl)
        if reason:
            excluded.append((title, reason))
            continue
        code = mwp.parse(wt)
        ib_name, info = parse_infobox(code)
        season, how = detect_season(title, info, wt, hint, season_overrides, list_map)
        how_count[how] = how_count.get(how, 0) + 1
        if not season:
            no_season.append(title)
        number = episode_number(info, title, overrides)
        if number is None:
            unresolved.append(title)
        paras, fallback = synopsis_paragraphs(code)
        conn.execute(
            "INSERT OR REPLACE INTO episodes (season,number,title,wiki_url,air_date,infobox_json,synopsis_fallback) "
            "VALUES (?,?,?,?,?,?,?)",
            (season, number, title, url_for(title), episode_airdate(info),
             json.dumps(info, ensure_ascii=False), int(fallback)))
        for i, p in enumerate(paras):
            links, seen = [], set()
            for target in re.findall(r"\[\[(.+?)\]\]", p):
                hit = resolver.get(norm(target))
                if hit and hit[0] not in seen:
                    seen.add(hit[0])
                    links.append({"title": hit[0], "kind": hit[1]})
            conn.execute("INSERT OR REPLACE INTO episode_paragraphs VALUES (?,?,?,?)",
                         (title, i, p, json.dumps(links, ensure_ascii=False)))
    conn.commit()

    # --- fill missing episode numbers from the infobox previous/next chain
    # (e.g. episode 1 has no number but episode 2 says |previous = <episode 1>)
    eps = conn.execute("SELECT title, season, number, infobox_json FROM episodes").fetchall()
    by_name = {re.sub(r"\s*\(episode\)$", "", t, flags=re.I).lower(): (t, s, n) for t, s, n, _ in eps}
    filled = 0
    for t, s, n, ib in eps:
        if n is not None:
            continue
        base = re.sub(r"\s*\(episode\)$", "", t, flags=re.I).lower()
        for t2, s2, n2, ib2 in eps:
            if n2 is None or s2 != s:
                continue
            info2 = json.loads(ib2)
            prev = re.sub(r"\s*\(episode\)$", "", info2.get("previous", ""), flags=re.I).lower()
            nxt = re.sub(r"\s*\(episode\)$", "", info2.get("next", ""), flags=re.I).lower()
            guess = n2 - 1 if prev == base else n2 + 1 if nxt == base else None
            if guess is not None and guess >= 1:
                conn.execute("UPDATE episodes SET number=? WHERE title=?", (guess, t))
                filled += 1
                break
    conn.commit()
    if filled:
        print(f"Filled {filled} missing episode numbers from previous/next links.")

    n_ent = conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
    n_ep = conn.execute("SELECT COUNT(*) FROM episodes").fetchone()[0]
    n_fb = conn.execute("SELECT COUNT(*) FROM episodes WHERE synopsis_fallback=1").fetchone()[0]
    print(f"Parsed {n_ent} entities, {n_ep} episodes.")
    if excluded:
        print(f"Excluded {len(excluded)} episodes (sound episodes / recaps):")
        for t, why in excluded:
            print(f"   - {t}  [{why}]")
        print(f"   ^ review: wrongly excluded? the recap detector looks for 'recap' in the lead/categories. "
              f"Add missed ones to {EXCLUDE_FILE}.")
    print("Episodes per season: " + ", ".join(
        f"{s or '(unknown)'}={n}" for s, n in conn.execute(
            "SELECT season, COUNT(*) FROM episodes GROUP BY season ORDER BY season")))
    print("Season detected via: " + ", ".join(f"{k}={v}" for k, v in sorted(how_count.items())))
    if no_season:
        print(f"WARNING: season unknown for {len(no_season)} pages (probably specials/hubs). "
              f"Add them to {SEASON_OVERRIDES_FILE}, e.g. " + json.dumps({no_season[0]: "R1"}))
        for t in no_season[:20]:
            print("   -", t)
    if n_fb:
        print(f"WARNING: {n_fb} episodes had no 'Synopsis/Summary/Plot' section; whole page used. "
              f"Check SYNOPSIS_HEADINGS.")
    if unresolved:
        print(f"WARNING: no episode number found for {len(unresolved)} pages. "
              f"Add them to {OVERRIDES_FILE}, e.g. " + json.dumps({unresolved[0]: 1}))
        for t in unresolved[:15]:
            print("   -", t)


# ----------------------------------------------------------------------------
# Stage: export
# ----------------------------------------------------------------------------
def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def cmd_export():
    conn = db()
    (EXPORT_DIR / "episodes").mkdir(parents=True, exist_ok=True)

    entities = {"characters": [], "factions": [], "locations": []}
    plural = {"character": "characters", "faction": "factions", "location": "locations"}
    full = []
    for kind, title, url, ib, summary in conn.execute(
            "SELECT kind, title, wiki_url, infobox_json, summary FROM entities ORDER BY title"):
        entities[plural[kind]].append(title)
        full.append({"kind": kind, "title": title, "wiki_url": url,
                     "infobox": json.loads(ib), "summary": summary})
    aliases = {a: t for a, t in conn.execute("SELECT alias, title FROM aliases")}
    (EXPORT_DIR / "entities_names.json").write_text(json.dumps(entities, indent=2, ensure_ascii=False), encoding="utf-8")
    (EXPORT_DIR / "entities_full.json").write_text(json.dumps(full, indent=2, ensure_ascii=False), encoding="utf-8")
    (EXPORT_DIR / "aliases.json").write_text(json.dumps(aliases, indent=2, ensure_ascii=False), encoding="utf-8")

    (EXPORT_DIR / "series.json").write_text(json.dumps(SERIES, indent=2, ensure_ascii=False), encoding="utf-8")
    count = 0
    ep_rows = conn.execute(
        "SELECT season, number, title, wiki_url, air_date, infobox_json, synopsis_fallback FROM episodes"
    ).fetchall()
    ep_rows.sort(key=lambda r: (SERIES.get(r[0], {}).get("slot", 99),
                                r[1] if r[1] is not None else 999, r[2]))
    for season, number, title, url, air, ib, fb in ep_rows:
        meta = SERIES.get(season, {})
        paras = conn.execute(
            "SELECT text, links_json FROM episode_paragraphs WHERE episode_title=? ORDER BY idx", (title,)
        ).fetchall()
        doc = {
            "episode": {"season": season, "number": number, "title": title, "wiki_url": url, "air_date": air,
                        "series_slot": meta.get("slot", 99), "series_label": meta.get("label", season),
                        "series_note": meta.get("note", "")},
            "synopsis_fallback": bool(fb),
            "paragraphs": [p[0] for p in paras],
            "paragraph_links": [json.loads(p[1]) for p in paras],
            "infobox": json.loads(ib),
        }
        fname = f"{season or 'X'}-{number:02d}" if number is not None else f"{season or 'X'}-{slug(title)}"
        (EXPORT_DIR / "episodes" / f"{fname}.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
        count += 1
    print(f"Exported {count} episodes + {sum(len(v) for v in entities.values())} entities to {EXPORT_DIR}/")
    print("Feed each episodes/*.json into extract_events.py (paragraphs + entities_names.json).")


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover")
    d.add_argument("keywords", nargs="*")
    f = sub.add_parser("fetch")
    f.add_argument("--refresh", action="store_true", help="re-download pages already cached")
    l = sub.add_parser("links", help="list/seed pages linked from an overview page")
    l.add_argument("page")
    l.add_argument("--section", help="only links inside sections whose heading contains this text")
    l.add_argument("--add", choices=VALID_KINDS, help="save listed pages to extra_pages.json as this kind")
    l.add_argument("--season", default="", help="season/series key for --add (e.g. Akito)")
    sub.add_parser("parse")
    sub.add_parser("inspect", help="show infobox keys/categories of episodes with unknown season/number")
    s = sub.add_parser("show", help="print stored raw wikitext of a page")
    s.add_argument("title")
    s.add_argument("--chars", type=int, default=3000)
    sub.add_parser("export")
    sub.add_parser("all")
    args = ap.parse_args()

    if args.cmd == "discover":
        cmd_discover(args.keywords)
    elif args.cmd == "fetch":
        cmd_fetch(args.refresh)
    elif args.cmd == "links":
        cmd_links(args.page, args.section, args.add, args.season)
    elif args.cmd == "parse":
        cmd_parse()
    elif args.cmd == "show":
        cmd_show(args.title, args.chars)
    elif args.cmd == "inspect":
        cmd_inspect()
    elif args.cmd == "export":
        cmd_export()
    elif args.cmd == "all":
        cmd_fetch()
        cmd_parse()
        cmd_export()


if __name__ == "__main__":
    sys.exit(main())