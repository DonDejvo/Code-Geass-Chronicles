import type { Ev } from '../types';

export const STEP = 120;     // world distance between events of one episode
export const EP_GAP = 170;   // world distance between the last event of an episode and the next episode's first
export const PAD = 150;

export interface Tick { x: number; ep: string }
export interface World { x: Map<string, number>; ticks: Tick[]; width: number }

/** Events are laid out in story order; episodes are separated by a wider gap. */
export function computeWorld(events: Ev[]): World {
  const x = new Map<string, number>();
  const ticks: Tick[] = [];
  let cursor = PAD;
  let i = 0;
  while (i < events.length) {
    const ep = events[i].ep;
    let j = i;
    while (j < events.length && events[j].ep === ep) j++;
    ticks.push({ x: cursor - EP_GAP / 2, ep });
    for (let n = 0; i + n < j; n++) x.set(events[i + n].id, cursor + n * STEP);
    cursor += (j - i - 1) * STEP + EP_GAP;
    i = j;
  }
  return { x, ticks, width: events.length ? cursor - EP_GAP + PAD : PAD * 2 };
}

export interface ChipPlan { lane: number; w: number; text: string }
export interface DatePlan { row: number; w: number; text: string }
export interface Plan { chips: Map<string, ChipPlan>; dates: Map<string, DatePlan> }

interface Span { l: number; r: number }
const overlaps = (list: Span[], l: number, r: number) => list.some((s) => l < s.r && r > s.l);

/**
 * Greedy label placement at one zoom level (screen px = world x * k).
 * Important events are placed first, so zooming out keeps the meaningful labels and zooming in
 * reveals the rest. The result does not depend on the pan position, so labels never jump while dragging.
 * Flag style: a pole rises from the point to the label's lane, so a pole also blocks lower lanes.
 */
export function planLabels(o: {
  events: Ev[]; x: Map<string, number>; k: number; measure: (t: string) => number; measureDate?: (t: string) => number;
  maxLanes: number; maxChip: number; padX: number; gap: number;
  dateText: (e: Ev) => string | null; dateRows: number;
}): Plan {
  const chips = new Map<string, ChipPlan>();
  const lanes: Span[][] = Array.from({ length: o.maxLanes }, () => []);
  const order = [...o.events].sort((a, b) => (b.imp ?? 0) - (a.imp ?? 0) || a.order - b.order);
  for (const e of order) {
    const px = (o.x.get(e.id) ?? 0) * o.k;
    const w = Math.min(o.maxChip, o.measure(e.title) + o.padX * 2);
    const l = px - 1, r = px + w + o.gap;
    for (let lane = 0; lane < o.maxLanes; lane++) {
      if (overlaps(lanes[lane], l, r)) continue;
      let poleBlocked = false;
      for (let b = 0; b < lane && !poleBlocked; b++) poleBlocked = overlaps(lanes[b], px - 5, px + 5);
      if (poleBlocked) continue;
      lanes[lane].push({ l, r });
      for (let b = 0; b < lane; b++) lanes[b].push({ l: px - 5, r: px + 5 });
      chips.set(e.id, { lane, w, text: e.title });
      break;
    }
  }
  const dates = new Map<string, DatePlan>();
  const rows: Span[][] = Array.from({ length: o.dateRows }, () => []);
  for (const e of o.events) {
    const text = o.dateText(e);
    if (!text) continue;
    const px = (o.x.get(e.id) ?? 0) * o.k;
    const w = (o.measureDate ?? o.measure)(text);
    const l = px - w / 2 - 4, r = px + w / 2 + 4;
    for (let row = 0; row < o.dateRows; row++) {
      if (overlaps(rows[row], l, r)) continue;
      rows[row].push({ l, r });
      dates.set(e.id, { row, w, text });
      break;
    }
  }
  return { chips, dates };
}
