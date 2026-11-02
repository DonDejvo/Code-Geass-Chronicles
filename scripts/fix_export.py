#!/usr/bin/env python3
"""
fix_export.py - offline post-processing of the scraper's export/ folder.

    python fix_export.py                      # export/ -> export_fixed/
    python fix_export.py --export export --out export_fixed

Fixes
  1. Entity kinds. Category:Organizations holds everything (vehicles, cities, clubs, weapons...).
     Each entity is re-classified as character | faction | location | equipment | concept | event
     (nations count as faction AND location). Signals: infobox keys, then title/summary wording,
     then manual kind_overrides.json. Variants like "X/Genesic Re;Code" and "List of ..." are dropped
     from the lists.
  2. Links. Every [[link]] in every synopsis is re-resolved (underscores, accents, case, aliases,
     link_rules.json). Wrong wiki redirects (e.g. Saitama Ghetto -> United States of Japan) are
     overridden; non-entity pages (battles, concepts) become stubs; junk links are ignored.
  3. Missing episodes. synopsis_overrides.json can create or fill episodes the wiki has no usable
     synopsis for (Akito 3 and 4). Coverage is audited against EXPECTED.

Outputs (in --out): entities_names.json (characters/factions/locations for the LLM),
entities_other.json (equipment/concepts/events, used only for link resolution), entities_full.json,
aliases.json, series.json, episodes/*.json, fix_report.txt.
Everything is deterministic and needs no network. Edit the three JSON rule files and re-run.
"""
import argparse
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

EXPECTED = {"R1": 25, "R2": 25, "Akito": 5}
WIKI_BASE = "https://codegeass.fandom.com/wiki/"

# ---------------------------------------------------------------- default rules (written to disk if absent)
DEFAULT_LINK_RULES = {
    "_doc": "ignore: link text dropped. map: force a target (a canonical entity title). "
            "stub: page not in the entity categories; kind is location|faction|event|concept.",
    "ignore": ["Viceroy", "Area System", "knight", "a.t.b.", "List of characters", "Japanese", "Elevens"],
    "map": {
        "Area 11": "United States of Japan",
        "Special Administrative Zone": "Special Administrative Zone of Japan",
        "Julius Kingsley": "Lelouch vi Britannia",
    },
    "stub": {
        "Saitama Ghetto": {"kind": "location"},
        "Black Rebellion": {"kind": "event"},
        "Battle of Narita": {"kind": "event"},
        "Second Assault on Tokyo Settlement": {"kind": "event"},
        "Geass": {"kind": "concept"},
        "Ragnarök": {"kind": "concept"},
        "Sakuradite": {"kind": "concept"},
    },
}
DEFAULT_KIND_OVERRIDES = {
    "_doc": "title -> character|faction|location|equipment|concept|event|nation (= faction + location)",
    "Britannian Search and Rescue": "faction",
    "C.C. Cell Control Drug Counter": "equipment",
    "Irregular": "concept",
    "Steiner Konzern": "faction",
    "Leung Tan": "equipment",
    "Monarchy of Britannia": "faction",
    "Nobles": "concept",
    "Knight (Honorary Title)": "concept",
    "Britannian Infantry": "faction",
    "Mesh": "equipment",
    "Pavlova": "equipment",
    "Zero Squad": "faction",
    "Energy Wing System": "equipment",
    "Sand Panels": "equipment",
    "Thought Elevator": "equipment",
    "F.L.E.I.J.A.": "equipment",
    "Factsphere Sensor": "equipment",
    "Vehicles": "concept",
    "Small Arms": "concept",
    "United States Charter": "concept",
}

# ---------------------------------------------------------------- classification
CHAR_KEYS = {"gender", "hair", "eye", "age", "born", "voice", "relatives", "blood", "zodiac", "nationality",
             "occupation", "full name", "nickname", "death", "rank", "allegiance"}
MACH_KEYS = {"kmfgen", "modelnumber", "manufacturer", "manufacture", "standardequipment", "operators",
             "knownpilots", "developedfrom", "developedinto", "standardfixedarmaments",
             "standardhandheldarmaments", "crew", "engine", "armament", "codename", "equipment",
             "classification", "weight", "height", "animeappearances", "mangaappearances", "gameappearances"}
NATION_KEYS = {"state head", "capital", "government type", "flag"}
ORG_KEYS = {"leader", "founder", "founded", "headquarters", "members", "formed"}

FACTION_TITLE = re.compile(r"\b(Army|Military|Force|Forces|Knights|Order|Squad|Squadron|Guard|Guards|Resistance|"
                           r"Council|Alliance|Federation|Front|Group|Unit|Club|Corps|Police|Legion|Faction|Agency|"
                           r"Team|Company|Konzern|Navy|Regiment|Mercenaries|Cult|Directorate)\b")
FACTION_PRED = re.compile(r"organi[sz]ation|\bunit\b|\bgroup\b|\bforce\b|\bforces\b|\barmy\b|military|\bbranch\b|"
                          r"agency|squad|\border\b|\bcorps\b|\bcompany\b|manufactur|\bteam\b|\bclub\b|faction|"
                          r"resistance|government|federation|alliance|\bcouncil\b|\bguard|\blegion\b|mercenar|"
                          r"\bcult\b|police|\bdivision\b|\bregiment\b|\bcoalition\b|\bcorporation\b", re.I)
EQUIP_RX = re.compile(r"weapon|device|system|\bdrug\b|sword|rifle|cannon|knife|\bmine\b|grenade|carrier|fortress|"
                      r"automaton|mecha|vehicle|aircraft|knightmare|sensor|armament|technology|tonfa|projectile|"
                      r"blade|panels?\b|transponder|\bcoat\b|\bship\b|\btank\b|\bjeep\b|truck|\btrain\b|\bplane\b|"
                      r"helicopter|\bboat\b|submarine|battleship|destroyer|zeppelin|balloon|ambulance|\bAPC\b|"
                      r"\bIFV\b|VTOL|fighter|munition|\bbomb|missile|\bgun\b|armou?r|shield|engine|\bkey\b|hover", re.I)
LOC_RX = re.compile(r"\b(city|capital|island|district|region|mountains?|lake|seaport|port|academy|prison|museum|"
                    r"theme park|mall|garden|palace|consulate|ghetto|settlement|concession|territory|tower|"
                    r"village|temple|shrine|gate|continent|prefecture|province|town|facility|castle|zone|"
                    r"complex|stadium|school|site)\b", re.I)
PERSON_START = re.compile(r"^\W*(an? |the )?(organi[sz]ation|secret organi[sz]ation|unit|group|state|city|capital|"
                          r"honorary title|social class|highest social class|conventional foot|list of)", re.I)


def predicate(summary):
    parts = re.split(r"\b(?:is|are|was|were|refers to)\b", summary or "", maxsplit=1, flags=re.I)
    return (parts[1] if len(parts) > 1 else summary or "").strip()


def classify(e, overrides):
    """Return (kind, why). kind: character|faction|location|nation|equipment|concept|variant|meta."""
    t, orig = e["title"], e["kind"]
    keys = {k.lower() for k in e["infobox"]}
    if t in overrides:
        return overrides[t], "manual override"
    if t.lower().startswith("list of"):
        return "meta", "list page"
    if "/" in t:
        return "variant", "alternate-continuity page"
    pred = predicate(e["summary"])
    c, m = len(keys & CHAR_KEYS), len(keys & MACH_KEYS)
    org, nation = bool(keys & ORG_KEYS), bool(keys & NATION_KEYS)
    loc = "usage" in keys or "location" in keys
    if c >= 3:
        return "character", "character infobox"
    if nation:
        return "nation", "nation infobox"
    if m >= 3 and not org:
        return "equipment", "machine infobox"
    if loc and not org:
        return "location", "location infobox"
    if org:
        return "faction", "organization infobox"
    # --- weak signals: no/sparse infobox
    if orig == "character":
        if PERSON_START.search(pred):
            return "faction" if re.match(r"\W*(an? |the )?(organi|unit|group|conventional)", pred, re.I) else "concept", "predicate"
        return "character", "kept (Characters category)"
    if orig == "location":
        return "location", "kept (Locations category)"
    # originally "faction": needs positive evidence
    if " Club" in t or FACTION_TITLE.search(t):
        return "faction", "title wording"
    head = pred[:80]
    if FACTION_PRED.search(pred[:70]):
        return "faction", "summary wording"
    if EQUIP_RX.search(head):
        return "equipment", "summary wording"
    if LOC_RX.search(pred[:70]):
        return "location", "summary wording"
    return "concept", "no signal (default)"


# ---------------------------------------------------------------- text helpers
def fold(s):
    s = (s or "").replace("_", " ")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[’'`]s\b", "", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def stems(s):
    return {w[:4] for w in re.findall(r"[a-z0-9]+", fold(s)) if len(w) >= 3}


def load_json(path, default=None):
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def dump(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", default="export")
    ap.add_argument("--out", default="export_fixed")
    ap.add_argument("--rules", default="link_rules.json")
    ap.add_argument("--kinds", default="kind_overrides.json")
    ap.add_argument("--synopses", default="synopsis_overrides.json")
    args = ap.parse_args()
    src, out = Path(args.export), Path(args.out)
    (out / "episodes").mkdir(parents=True, exist_ok=True)
    for name, default in ((args.rules, DEFAULT_LINK_RULES), (args.kinds, DEFAULT_KIND_OVERRIDES)):
        if not Path(name).exists():
            dump(name, default)
            print(f"wrote default {name} (edit it and re-run)")
    rules, overrides = load_json(args.rules), {k: v for k, v in load_json(args.kinds).items() if not k.startswith("_")}
    synopses = load_json(args.synopses, {})
    report = []

    # ---- 1. entities
    full = load_json(src / "entities_full.json")
    aliases_in = load_json(src / "aliases.json")
    series = load_json(src / "series.json", {})
    ents = {}
    for e in full:
        kind, why = classify(e, overrides)
        e["orig_kind"], e["kind"], e["why"] = e["kind"], kind, why
        e["kinds"] = ["faction", "location"] if kind == "nation" else [kind]
        e["variant_of"] = e["title"].split("/")[0] if kind == "variant" else None
        ents[e["title"]] = e
    for name, spec in rules["stub"].items():
        if name not in ents:
            ents[name] = {"title": name, "kind": spec["kind"], "kinds": [spec["kind"]], "orig_kind": "stub",
                          "why": "link_rules stub", "wiki_url": WIKI_BASE + name.replace(" ", "_"),
                          "infobox": {}, "summary": "", "variant_of": None, "stub": True}
    counts = Counter(e["kind"] for e in ents.values())
    report.append("ENTITY KINDS (after fix): " + ", ".join(f"{k}={v}" for k, v in counts.most_common()))
    report.append("ENTITY KINDS (before):    " + ", ".join(f"{k}={v}" for k, v in Counter(e["orig_kind"] for e in ents.values()).most_common()))
    moved = Counter((e["orig_kind"], e["kind"]) for e in ents.values() if e["orig_kind"] != e["kind"])
    report.append("moves (was -> now): " + ", ".join(f"{a}->{b}: {n}" for (a, b), n in moved.most_common()))

    names = {"characters": [], "factions": [], "locations": []}
    other = {"equipment": [], "concepts": [], "events": []}
    for t, e in sorted(ents.items()):
        if "character" in e["kinds"]: names["characters"].append(t)
        if "faction" in e["kinds"]: names["factions"].append(t)
        if "location" in e["kinds"]: names["locations"].append(t)
        if e["kind"] == "equipment": other["equipment"].append(t)
        if e["kind"] == "concept": other["concepts"].append(t)
        if e["kind"] == "event": other["events"].append(t)

    # ---- 2. link index
    index, how_alias = {}, {}
    for t, e in ents.items():
        if e["kind"] in ("variant", "meta"):
            continue
        index.setdefault(fold(t), t)
    for a, c in aliases_in.items():
        if c in ents and ents[c]["kind"] not in ("variant", "meta"):
            index.setdefault(fold(a), c)
            how_alias[fold(a)] = c
    for t, e in ents.items():            # variant pages point back to the base page
        if e["kind"] == "variant" and e["variant_of"] in ents:
            index.setdefault(fold(t), e["variant_of"])
    ignore = {fold(x) for x in rules["ignore"]}
    forced = {fold(k): v for k, v in rules["map"].items()}
    stub_idx = {fold(k): k for k in rules["stub"]}
    ep_titles = set()
    weak, unresolved, resolved_n, total_n = Counter(), Counter(), 0, 0

    def resolve(target):
        nonlocal resolved_n
        f = fold(target.split("#")[0])
        if not f:
            return None
        if f in ignore:
            return ("ignored", None)
        if f in forced:
            return ("ok", forced[f])
        if f in stub_idx:
            return ("ok", stub_idx[f])
        if f in index:
            canon = index[f]
            if f in how_alias and not (stems(target) & stems(canon)):
                weak[(target.replace("_", " "), canon)] += 1
            return ("ok", canon)
        if f.endswith("(episode)") or f in ep_titles:
            return ("ref", target.replace("_", " "))
        return ("unresolved", None)

    def build_links(paragraphs):
        nonlocal total_n, resolved_n
        links, refs = [], []
        for p in paragraphs:
            pl, pr, seen = [], [], set()
            for tgt in re.findall(r"\[\[(.+?)\]\]", p):
                total_n += 1
                status, canon = resolve(tgt)
                if status == "ok":
                    resolved_n += 1
                    if canon in seen:
                        continue
                    seen.add(canon)
                    e = ents[canon]
                    if set(e["kinds"]) & {"character", "faction", "location"}:
                        pl.append({"title": canon, "kind": e["kinds"][0], "kinds": e["kinds"]})
                    else:
                        pr.append({"title": canon, "kind": e["kind"]})
                elif status == "ref":
                    pr.append({"title": canon, "kind": "episode"})
                elif status == "unresolved":
                    unresolved[tgt.replace("_", " ")] += 1
            links.append(pl)
            refs.append(pr)
        return links, refs

    # ---- 3. episodes
    ep_docs = {}
    for f in sorted((src / "episodes").glob("*.json")):
        d = load_json(f)
        ep_docs[f.stem] = d
        ep_titles.add(fold(d["episode"]["title"]))
    slot_of = {s: v["slot"] for s, v in series.items()}
    for season, items in synopses.items():
        if season.startswith("_"):
            continue
        for num, spec in items.items():
            stem = f"{season}-{int(num):02d}"
            cur = ep_docs.get(stem)
            if cur and cur["paragraphs"] and not cur.get("synopsis_fallback"):
                report.append(f"synopsis override for {stem} skipped: wiki synopsis present")
                continue
            base = cur["episode"] if cur else {
                "season": season, "number": int(num), "title": spec["title"],
                "wiki_url": WIKI_BASE + spec["title"].replace(" ", "_"), "air_date": spec.get("air_date"),
                "series_slot": slot_of.get(season, 99), "series_label": series.get(season, {}).get("label", season),
                "series_note": series.get(season, {}).get("note", "")}
            ep_docs[stem] = {"episode": base, "synopsis_fallback": False, "paragraphs": spec["paragraphs"],
                             "paragraph_links": [], "infobox": cur["infobox"] if cur else {},
                             "synopsis_source": {"source": spec.get("source"), "url": spec.get("source_url"),
                                                 "note": "not from the Fandom wiki; verify against it"}}
            ep_titles.add(fold(base["title"]))
            report.append(f"{'filled' if cur else 'created'} {stem} from synopsis_overrides ({spec.get('source')})")

    for stem, d in ep_docs.items():
        d["paragraph_links"], d["paragraph_refs"] = build_links(d["paragraphs"])
        d["episode"]["display_title"] = re.sub(r"\s*\(episode\)$", "", d["episode"]["title"], flags=re.I)
        dump(out / "episodes" / f"{stem}.json", d)

    # ---- 4. write entity files
    full_out = sorted(ents.values(), key=lambda e: (e["kind"], e["title"]))
    dump(out / "entities_full.json", full_out)
    dump(out / "entities_names.json", names)
    dump(out / "entities_other.json", other)
    merged_aliases = dict(aliases_in)
    for t, e in ents.items():
        if e["kind"] == "variant" and e["variant_of"] in ents:
            merged_aliases.setdefault(t, e["variant_of"])
    for k, v in rules["map"].items():
        merged_aliases[k] = v
    dump(out / "aliases.json", merged_aliases)
    dump(out / "series.json", series)

    # ---- 5. report
    report.append(f"\nLINKS: {resolved_n}/{total_n} resolved to entities, {sum(unresolved.values())} unresolved")
    if unresolved:
        report.append("unresolved link targets (add to link_rules.json as stub/ignore/map): "
                      + ", ".join(f"{k} x{v}" for k, v in unresolved.most_common()))
    if weak:
        report.append("weak alias matches (wiki redirect shares no words with its target; check they are right):")
        report += [f"   [[{a}]] -> {c}  x{n}" for (a, c), n in weak.most_common()]
    report.append("\nEPISODE COVERAGE")
    per = defaultdict(set)
    for d in ep_docs.values():
        e = d["episode"]
        if d["paragraphs"] and not d.get("synopsis_fallback"):
            per[e["season"]].add(e["number"])
    for season, n in EXPECTED.items():
        miss = [i for i in range(1, n + 1) if i not in per[season]]
        report.append(f"   {season}: {len(per[season] & set(range(1, n + 1)))}/{n} with synopsis" + (f"  MISSING {miss}" if miss else ""))
    empty = [s for s, d in ep_docs.items() if not d["paragraphs"]]
    if empty:
        report.append("   no synopsis text (ignored by extraction): " + ", ".join(sorted(empty)))
    review = [e for e in ents.values() if e["why"] in ("no signal (default)", "summary wording", "predicate")]
    report.append(f"\nLOW-CONFIDENCE CLASSIFICATIONS ({len(review)}): fix wrong ones in {args.kinds}")
    for e in sorted(review, key=lambda e: (e["kind"], e["title"])):
        report.append(f"   {e['kind']:9} {e['title']}   [{e['why']}]")
    (out / "fix_report.txt").write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    print(f"\nWrote {out}/  ->  use:  python extract_events.py --export {out}")


if __name__ == "__main__":
    main()