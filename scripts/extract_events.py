#!/usr/bin/env python3
"""
Code Geass timeline: LLM event extraction over the scraper's export/ folder.

Setup (PowerShell):
    pip install anthropic
    $env:ANTHROPIC_API_KEY = "sk-ant-..."

Usage:
    python extract_events.py --dry-run                      # prompt size check, no API calls
    python extract_events.py --only R1-01 Akito-01 --force  # test on a few episodes first
    python extract_events.py                                # everything (resumable: skips done episodes)

Reads : export/episodes/*.json, export/entities_names.json, export/aliases.json
Writes: events/<episode>.json (one per episode), events/events_all.json (merged, in story order),
        events/_errors.json (episodes that failed)
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

import anthropic

MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 16000
CHUNK = 15            # paragraphs per request (long synopses are split into parts)
REVIEW_CONFIDENCE = 0.6

# ---------------------------------------------------------------------------
# JSON schema (tool input_schema -> forced structured output)
# ---------------------------------------------------------------------------
EVENT_SCHEMA = {
    "type": "object",
    "properties": {
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scene_idx": {"type": "integer",
                                  "description": "Index shown in [brackets] of the paragraph this event comes from."},
                    "title": {"type": "string", "description": "Short neutral title, max 10 words."},
                    "summary": {"type": "string",
                                "description": "1-2 sentences, only facts stated in the source text."},
                    "source_text": {"type": "string",
                                    "description": "Exact sentence(s) from the synopsis that support this event."},
                    "characters": {"type": "array", "items": {"type": "string"},
                                   "description": "Names copied EXACTLY from the allowed character list."},
                    "factions": {"type": "array", "items": {"type": "string"},
                                 "description": "Names copied EXACTLY from the allowed faction list."},
                    "locations": {"type": "array", "items": {"type": "string"},
                                  "description": "Names copied EXACTLY from the allowed location list."},
                    "is_flashback": {"type": "boolean",
                                     "description": "True only if the text clearly places the event earlier than the present timeline."},
                    "date": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["absolute", "relative", "unknown"]},
                            "absolute_text": {"type": ["string", "null"],
                                              "description": "Date exactly as written in the source. Null unless kind=absolute."},
                            "relative_text": {"type": ["string", "null"],
                                              "description": "Phrase as written (e.g. 'one year later'). Null unless kind=relative."},
                            "relative_anchor": {"type": ["string", "null"],
                                                "description": "What the offset is measured from, if stated. Else null."},
                        },
                        "required": ["kind", "absolute_text", "relative_text", "relative_anchor"],
                    },
                    "confidence": {"type": "number",
                                   "description": "0.0-1.0. Lower it if participants, date or event boundary are unclear."},
                },
                "required": ["scene_idx", "title", "summary", "source_text", "characters", "factions",
                             "locations", "is_flashback", "date", "confidence"],
            },
        }
    },
    "required": ["events"],
}
TOOL = {"name": "record_events",
        "description": "Record the plot events extracted from the synopsis paragraphs.",
        "input_schema": EVENT_SCHEMA}

SYSTEM_PROMPT = """You extract plot events from Code Geass episode synopses for a timeline database.

RULES
1. Only use information stated in the synopsis. Never use outside knowledge to add events, names or dates.
2. One event = one meaningful plot beat (a decision, battle, reveal, death, meeting, political move). Do not make an event per sentence; merge trivial sentences into the beat they belong to.
3. List events in the order they are told. scene_idx is the [number] of the paragraph the event is in.
4. Character, faction and location names MUST be copied exactly from the ALLOWED lists below. If someone or something is not in the lists, leave it out. Never invent or translate names.
5. Paragraphs mark wikilinks as [[Page Title]], or as `Shown text ([[Page Title]])` when the text differs. Use these as hints: e.g. "Zero ([[Lelouch vi Britannia]])" means Zero is Lelouch vi Britannia, so list "Lelouch vi Britannia".
6. Dates:
   - "absolute": only if a calendar date or year (e.g. an a.t.b. date) is written in the text. Copy it verbatim into absolute_text.
   - "relative": phrases like "one year later" or "three days after the rebellion". Copy verbatim into relative_text, and name the anchor in relative_anchor if the text gives one.
   - "unknown": the default. Most scenes have no date. Do NOT guess dates.
7. is_flashback is true only if the text clearly signals an earlier time period (flashback, "years ago", childhood scenes).
8. source_text must be copied verbatim from the paragraph text (you may leave out the [[ ]] link markup).
9. Be conservative with confidence: use below 0.6 when unsure about participants, flashback status, or the event boundary.
"""


def system_blocks(entities):
    """Entity lists never change between episodes, so mark them cacheable (cheaper repeated calls)."""
    lists = "\n\n".join(
        f"ALLOWED {label}:\n{json.dumps(entities[key], ensure_ascii=False)}"
        for label, key in (("CHARACTERS", "characters"), ("FACTIONS", "factions"), ("LOCATIONS", "locations")))
    return [{"type": "text", "text": SYSTEM_PROMPT + "\n" + lists, "cache_control": {"type": "ephemeral"}}]


def build_user_prompt(ep, paragraphs, start, total):
    numbered = "\n\n".join(f"[{start + i}] {p}" for i, p in enumerate(paragraphs))
    num = ep.get("number")
    head = f"EPISODE: {ep.get('series_label') or ep.get('season') or 'Unknown series'} - "
    head += (f"Episode {num} - " if num is not None else "") + ep["title"]
    note = f"\nSERIES CONTEXT: {ep['series_note']}" if ep.get("series_note") else ""
    part = ""
    if total > len(paragraphs):
        part = (f"\nThis request covers paragraphs {start}-{start + len(paragraphs) - 1} of {total}. "
                f"Only extract events from the paragraphs below.")
    return f"""{head}{note}{part}

SYNOPSIS (numbered paragraphs):
{numbered}

Extract the events by calling record_events."""


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------
_client = None


def get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def call_llm(system, user_prompt):
    for attempt in range(4):
        try:
            resp = get_client().messages.create(
                model=MODEL, max_tokens=MAX_TOKENS, system=system, tools=[TOOL],
                tool_choice={"type": "tool", "name": "record_events"},
                messages=[{"role": "user", "content": user_prompt}])
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
            time.sleep(5 * (attempt + 1))
            continue
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("Output truncated (max_tokens). Lower CHUNK in this script.")
        for block in resp.content:
            if block.type == "tool_use":
                events = block.input.get("events", [])
                return json.loads(events) if isinstance(events, str) else events
        raise RuntimeError("Model returned no tool call")
    raise RuntimeError("API failed after 4 retries")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def _plain(s):
    """Lowercase, drop [[ ]] markup and extra whitespace."""
    return re.sub(r"\s+", " ", s.replace("[[", "").replace("]]", "")).strip().lower()


def _no_parens(s):
    return re.sub(r"\s*\([^()]*\)", "", s)


def in_text(snippet, full_plain):
    sn = _plain(snippet)
    return bool(sn) and (sn in full_plain or _no_parens(sn) in _no_parens(full_plain))


class Resolver:
    """Maps model output (canonical names or wiki aliases, any case) to canonical entity titles."""

    def __init__(self, entities, aliases):
        self.lookup = {}   # kind -> {lowercase name: canonical}
        self.alts = {}     # canonical -> [lowercase alias names]
        for kind, names in entities.items():
            self.lookup[kind] = {n.lower(): n for n in names}
        for alias, canon in aliases.items():
            for kind, names in entities.items():
                if canon.lower() in self.lookup[kind]:
                    self.lookup[kind].setdefault(alias.lower(), self.lookup[kind][canon.lower()])
                    self.alts.setdefault(canon, []).append(alias.lower())

    def resolve(self, kind, name):
        return self.lookup[kind].get(name.strip().lower())

    def supported(self, canon, para_plain, linked):
        """Is this entity actually mentioned in the paragraph (by name, alias, linked page or a name token)?"""
        if canon in linked:
            return True
        base = _no_parens(canon.lower()).strip()
        cands = [base] + self.alts.get(canon, [])
        if any(c and c in para_plain for c in cands):
            return True
        tokens = [t for t in re.findall(r"[a-zà-ÿ0-9.']+", base) if len(t) >= 4]
        return any(re.search(rf"\b{re.escape(t)}\b", para_plain) for t in tokens)


def validate(events, paragraphs, para_links, resolver):
    full_plain = _plain("\n".join(paragraphs))
    kinds = (("characters", "characters"), ("factions", "factions"), ("locations", "locations"))
    for ev in events:
        flags = []
        idx = ev.get("scene_idx", -1)
        in_range = isinstance(idx, int) and 0 <= idx < len(paragraphs)
        if not in_range:
            flags.append("bad_scene_idx")
        para_plain = _plain(paragraphs[idx]) if in_range else full_plain
        linked = {l["title"] for l in para_links[idx]} if in_range else set()

        for field, kind in kinds:
            kept, unknown, unsupported = [], [], []
            for name in ev[field]:
                canon = resolver.resolve(kind, name)
                if not canon:
                    unknown.append(name)
                elif canon not in kept:
                    kept.append(canon)
                    if not resolver.supported(canon, para_plain, linked):
                        unsupported.append(canon)
            ev[field] = kept
            if unknown:
                flags.append(f"unknown_{field}: {unknown}")
            if unsupported:
                flags.append(f"{field}_not_in_paragraph: {unsupported}")
        ev["linked_not_listed"] = sorted(
            l for l in linked if l not in set(ev["characters"] + ev["factions"] + ev["locations"]))

        if not in_text(ev["source_text"], full_plain):
            flags.append("source_text_not_verbatim")
        d = ev["date"]
        if d["kind"] == "absolute" and not (d.get("absolute_text") and in_text(d["absolute_text"], full_plain)):
            flags.append("absolute_date_not_in_source")
        if d["kind"] == "relative" and not (d.get("relative_text") and in_text(d["relative_text"], full_plain)):
            flags.append("relative_date_not_in_source")
        if d["kind"] == "unknown":
            d["absolute_text"] = d["relative_text"] = d["relative_anchor"] = None

        ev["review_flags"] = flags
        ev["needs_review"] = bool(flags) or ev["confidence"] < REVIEW_CONFIDENCE
    return events


# ---------------------------------------------------------------------------
# Per-episode / batch runner
# ---------------------------------------------------------------------------
def extract_episode(doc, system, resolver):
    ep, paragraphs, links = doc["episode"], doc["paragraphs"], doc["paragraph_links"]
    total, events = len(paragraphs), []
    for start in range(0, total, CHUNK):
        chunk = paragraphs[start:start + CHUNK]
        events += call_llm(system, build_user_prompt(ep, chunk, start, total))
    events.sort(key=lambda e: e.get("scene_idx", 0))
    events = validate(events, paragraphs, links, resolver)
    for i, ev in enumerate(events):
        # (series_slot, episode number, position told) -> places spin-offs like Akito between R1 and R2
        ev["story_order"] = [ep.get("series_slot", 99), ep.get("number") or 0, i]
        ev["episode_title"] = ep["title"]
    return events


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", default="export")
    ap.add_argument("--out", default="events")
    ap.add_argument("--only", nargs="*", help="episode file names without .json, e.g. R1-01 Akito-02")
    ap.add_argument("--force", action="store_true", help="re-extract episodes that already have output")
    ap.add_argument("--include-fallback", action="store_true",
                    help="also process episodes whose synopsis section was not found (whole page text)")
    ap.add_argument("--dry-run", action="store_true", help="no API calls; print prompt sizes")
    args = ap.parse_args(argv)

    export, out = Path(args.export), Path(args.out)
    entities = json.loads((export / "entities_names.json").read_text(encoding="utf-8"))
    aliases = json.loads((export / "aliases.json").read_text(encoding="utf-8"))
    resolver = Resolver(entities, aliases)
    system = system_blocks(entities)
    out.mkdir(exist_ok=True)

    files = sorted((export / "episodes").glob("*.json"))
    if args.only:
        files = [f for f in files if f.stem in set(args.only)]
    docs = []
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        docs.append((f.stem, d))
    docs.sort(key=lambda x: (x[1]["episode"].get("series_slot", 99), x[1]["episode"].get("number") or 999, x[0]))

    print(f"{len(docs)} episodes | entities: " + ", ".join(f"{k}={len(v)}" for k, v in entities.items()))
    if args.dry_run:
        print(f"system prompt ~{len(system[0]['text']) // 4} tokens (cached after first call)")
    errors, done, skipped = {}, 0, 0
    for stem, doc in docs:
        target = out / f"{stem}.json"
        if not doc["paragraphs"]:
            print(f"  skip {stem}: no paragraphs"); skipped += 1; continue
        if doc.get("synopsis_fallback") and not args.include_fallback:
            print(f"  skip {stem}: no synopsis section found (use --include-fallback to force)"); skipped += 1; continue
        if target.exists() and not args.force:
            skipped += 1; continue
        if args.dry_run:
            n = sum(len(p) for p in doc["paragraphs"])
            print(f"  {stem}: {len(doc['paragraphs'])} paragraphs, ~{n // 4} tokens synopsis")
            continue
        try:
            events = extract_episode(doc, system, resolver)
        except Exception as e:  # keep going; report at the end
            errors[stem] = str(e)
            print(f"  FAILED {stem}: {e}")
            continue
        target.write_text(json.dumps({"episode": doc["episode"], "model": MODEL, "events": events},
                                     indent=2, ensure_ascii=False), encoding="utf-8")
        rev = sum(e["needs_review"] for e in events)
        print(f"  {stem}: {len(events)} events, {rev} need review")
        done += 1

    if args.dry_run:
        return
    merged = []
    for f in out.glob("*.json"):
        if f.name.startswith("_") or f.name == "events_all.json":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        merged += [{**ev, "episode": d["episode"]["title"], "season": d["episode"]["season"],
                    "episode_number": d["episode"]["number"]} for ev in d["events"]]
    merged.sort(key=lambda e: e["story_order"])
    (out / "events_all.json").write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "_errors.json").write_text(json.dumps(errors, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone: {done} extracted, {skipped} skipped, {len(errors)} failed. "
          f"{len(merged)} events total, {sum(e['needs_review'] for e in merged)} flagged for review "
          f"-> {out / 'events_all.json'}")


if __name__ == "__main__":
    main()