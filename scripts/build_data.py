#!/usr/bin/env python3
"""
build_data.py - turn the pipeline output into the single JSON file the frontend loads.

    python scripts/build_data.py --fixed ../export_fixed --events ../events/events_all.json
    (defaults: --fixed export_fixed  --events events/events_all.json  --out public/data/timeline.json)

Re-run it whenever you extract more episodes (R2, Akito...). Only entities that are referenced by an
event or by an episode synopsis are shipped, so the file stays small.
"""
import argparse, json, re, unicodedata
from datetime import datetime, timezone
from pathlib import Path

CREDIT = ("Data: Code Geass Wiki on Fandom (CC BY-SA 3.0). Event extraction by Claude. "
          "Akito episodes 3-4 synopses are paraphrased from Wikipedia (CC BY-SA 4.0).")
DROP_INFOBOX = {"image", "caption", "flag", "name", "gallery", "imagesize", "image2", "caption2", "width"}
KINDS = ("character", "faction", "location", "equipment", "concept", "event")


def fold(s):
    s = (s or "").replace("_", " ")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[’'`]s\b", "", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", fold(s)).strip("-") or "x"


def pretty_key(k):
    k = re.sub(r"([a-z])([A-Z])", r"\1 \2", k.replace("_", " "))
    return k.strip().capitalize()


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixed", default="export_fixed")
    ap.add_argument("--events", default="events/events_all.json")
    ap.add_argument("--out", default="public/data/timeline.json")
    a = ap.parse_args()
    fixed = Path(a.fixed)

    ents_in = [e for e in load(fixed / "entities_full.json") if e["kind"] not in ("variant", "meta")]
    aliases_in = load(fixed / "aliases.json")
    series_in = load(fixed / "series.json")
    by_title = {e["title"]: e for e in ents_in}
    alias_of = {}
    for al, canon in aliases_in.items():
        if canon in by_title:
            alias_of.setdefault(canon, []).append(al)
    fold_index = {}
    for e in ents_in:
        fold_index.setdefault(fold(e["title"]), e["title"])
    for al, canon in aliases_in.items():
        if canon in by_title:
            fold_index.setdefault(fold(al), canon)

    # ---- episodes
    episodes, ep_docs = [], {}
    for f in sorted((fixed / "episodes").glob("*.json")):
        d = load(f)
        e = d["episode"]
        if not d["paragraphs"] or d.get("synopsis_fallback") or e.get("number") is None:
            continue
        eid = f"{e['season']}-{int(e['number']):02d}"
        ep_docs[eid] = d
        item = {"id": eid, "series": e["season"], "number": e["number"], "title": e.get("display_title") or e["title"],
                "wiki": e["wiki_url"], "air": e.get("air_date"), "synopsis": d["paragraphs"],
                "order": e.get("series_slot", 99) * 1000 + int(e["number"])}
        if d.get("synopsis_source"):
            item["source"] = d["synopsis_source"]
        episodes.append(item)
    episodes.sort(key=lambda x: x["order"])

    # ---- events
    raw_events = sorted(load(a.events), key=lambda e: e["story_order"])
    used, events, skipped = set(), [], 0
    ep_ids = {e["id"] for e in episodes}
    for order, ev in enumerate(raw_events):
        eid = f"{ev['season']}-{int(ev['episode_number']):02d}"
        if eid not in ep_ids:
            skipped += 1
            continue
        links = {k: [] for k in KINDS}
        for field, kind in (("characters", "character"), ("factions", "faction"), ("locations", "location")):
            for t in ev[field]:
                if t in by_title:
                    links[kind].append(slug(t)); used.add(t)
        # equipment / concepts / battles come from the episode's [[links]] that this event's text mentions
        words = lambda x: " " + re.sub(r"[^a-z0-9]+", " ", fold(x)).strip() + " "
        hay = words(f"{ev['title']} {ev['summary']}")
        for para in ep_docs[eid].get("paragraph_refs", []):
            for r in para:
                t = r["title"]
                if t not in by_title:
                    continue
                names = [t] + alias_of.get(t, [])
                if any(len(fold(n)) >= 4 and words(n) in hay for n in names):
                    kind = by_title[t]["kind"]
                    if kind in links and slug(t) not in links[kind]:
                        links[kind].append(slug(t)); used.add(t)
        d = ev["date"]
        events.append({"id": f"{eid}-{ev['story_order'][2]}", "ep": eid, "order": len(events), "idx": ev["story_order"][2],
                       "title": ev["title"], "summary": ev["summary"], "source": ev["source_text"], "links": links,
                       "flashback": bool(ev["is_flashback"]),
                       "date": {"kind": d["kind"], "abs": d.get("absolute_text"), "rel": d.get("relative_text"), "anchor": d.get("relative_anchor")},
                       "conf": ev["confidence"], "review": bool(ev["needs_review"]), "flags": ev.get("review_flags", [])})

    # ---- entities referenced by synopsis links as well
    for d in ep_docs.values():
        for p in d["paragraphs"]:
            for tgt in re.findall(r"\[\[(.+?)\]\]", p):
                t = fold_index.get(fold(tgt.split("#")[0]))
                if t:
                    used.add(t)
    entities = []
    for t in sorted(used):
        e = by_title[t]
        summ = (e.get("summary") or "").strip()
        if re.match(r"^(is|was|are|were)\b", summ):
            summ = f"{t} {summ}"
        ib = {pretty_key(k): v for k, v in e["infobox"].items() if k.lower() not in DROP_INFOBOX and str(v).strip()}
        entities.append({"id": slug(t), "title": t, "kinds": [k for k in e["kinds"] if k in KINDS], "wiki": e["wiki_url"],
                         "summary": summ, "infobox": ib, "aliases": sorted(set(alias_of.get(t, [])))})
    ids = [e["id"] for e in entities]
    assert len(ids) == len(set(ids)), "slug collision between entity titles"

    out = {"meta": {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "credit": CREDIT},
           "series": [{"id": k, **v} for k, v in sorted(series_in.items(), key=lambda kv: kv[1]["slot"])],
           "episodes": episodes, "entities": entities, "events": events}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kinds = {}
    for e in events:
        for k, v in e["links"].items():
            kinds[k] = kinds.get(k, 0) + len(v)
    print(f"{len(events)} events ({skipped} skipped: episode has no synopsis), {len(episodes)} episodes, "
          f"{len(entities)} entities -> {a.out} ({Path(a.out).stat().st_size // 1024} KB)")
    print("event links per kind:", kinds)


if __name__ == "__main__":
    main()
