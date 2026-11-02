import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DataSet } from '../lib/data';
import { epCode, whenLabel } from '../lib/data';
import { K_MAX, type View, type ViewBus } from '../lib/bus';
import { planLabels, STEP, type Plan, type World } from '../lib/layout';
import type { Ev, Settings, Timeline } from '../types';

export interface CanvasHandle { zoom(factor: number): void; fit(): void }
interface Props {
  timeline: Timeline; events: Ev[]; world: World; ds: DataSet; settings: Settings; bus: ViewBus;
  highlight: Set<string>; onOpen: (eventId: string) => void; fontTick: number;
}
interface Hit { id: string; kind: 'chip' | 'dot'; x: number; y: number; w: number; h: number }
interface Tip { id: string; x: number; y: number }

const C = {
  bg0: '#0d0817', bg1: '#06040a', text: '#f1ebff', muted: '#a396c4', dim: '#6d6290',
  gold: '#d9b552', chip: 'rgba(20,12,34,0.94)', chipHover: 'rgba(48,28,82,0.98)', grid: 'rgba(167,123,255,0.06)',
};
const FONT = '"Chakra Petch", system-ui, -apple-system, "Segoe UI", sans-serif';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function chipPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) {
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h); ctx.lineTo(x + c, y + h); ctx.lineTo(x, y + h - c); ctx.closePath();
}
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export const TimelineCanvas = forwardRef<CanvasHandle, Props>(function TimelineCanvas(props, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 320, h: 220, dpr: 1 });
  const hits = useRef<Hit[]>([]);
  const hoverId = useRef<string | null>(null);
  const raf = useRef(0);
  const planCache = useRef<{ key: string; world: World; events: Ev[]; plan: Plan } | null>(null);
  const measureCache = useRef(new Map<string, number>());
  const propsRef = useRef(props);
  propsRef.current = props;
  const [tip, setTip] = useState<Tip | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [pointer, setPointer] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; cx: number; moved: boolean; t0: number; samples: { t: number; x: number }[] } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; k0: number; mid: number; worldMid: number } | null>(null);
  const inertia = useRef(0);

  const scaleOf = (w: number, st: Settings) => clamp(w / 1000 + 0.5, 0.84, 1.2) * st.labelScale;
  const kMinOf = (w: number, world: World) => Math.min(K_MAX, Math.max(0.012, (w - 60) / world.width));
  const clampView = (v: View): View => {
    const { world } = propsRef.current;
    return { k: clamp(v.k, kMinOf(size.current.w, world), K_MAX), cx: clamp(v.cx, 0, world.width) };
  };
  const defaultView = (): View => {
    const { world, events } = propsRef.current;
    const w = size.current.w;
    const k = clamp(w / (120 * 6), 0.35, 1.15);
    const first = events.length ? world.x.get(events[0].id) ?? 0 : 0;
    return { k, cx: first + (w * 0.42) / k - 70 };
  };
  const getView = (): View => {
    const { bus, timeline } = propsRef.current;
    let v = bus.get(timeline.id);
    if (!v) { v = clampView(defaultView()); bus.init(timeline.id, v); }
    return v;
  };
  const setView = (v: View) => propsRef.current.bus.set(propsRef.current.timeline.id, clampView(v));

  const zoomAt = useCallback((sx: number, f: number) => {
    const v = getView(), w = size.current.w;
    const k2 = clamp(v.k * f, kMinOf(w, propsRef.current.world), K_MAX);
    const worldAt = (sx - w / 2) / v.k + v.cx;
    setView({ k: k2, cx: worldAt - (sx - w / 2) / k2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    zoom: (f) => zoomAt(size.current.w / 2, f),
    fit: () => {
      const { world } = propsRef.current;
      const k = kMinOf(size.current.w, world);
      const { bus, timeline } = propsRef.current;
      const ids = bus.linked ? Object.keys(bus.snapshot()) : [timeline.id];
      bus.flyTo(Object.fromEntries((ids.length ? ids : [timeline.id]).map((id) => [id, { k, cx: world.width / 2 }])), 450);
    },
  }), [zoomAt]);

  // ------------------------------------------------------------------ painting
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const P = propsRef.current;
    const { w, h, dpr } = size.current;
    const s = scaleOf(w, P.settings);
    const view = getView();
    const { k, cx } = view;
    const sx = (wx: number) => (wx - cx) * k + w / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // background
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, C.bg0); g.addColorStop(1, C.bg1);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const hatch = 38 * s;
    ctx.beginPath();
    for (let x = -((cx * k * 0.5) % hatch) - hatch; x < w + h; x += hatch) { ctx.moveTo(x, 0); ctx.lineTo(x - h * 0.6, h); }
    ctx.stroke();

    const color = P.timeline.color;
    const below = (P.settings.showEpisodes ? 58 : 36) * s;
    const laneH = 28 * s, chipH = 22 * s, fontPx = 12.5 * s;
    const maxLanes = Math.max(1, Math.min(P.settings.maxLanes, Math.floor((h - below - 24 * s) / laneH)));
    let axisY = h - below; // bottom-anchored until we know how tall the label stack is
    const font = `600 ${fontPx}px ${FONT}`;
    const small = `500 ${10.5 * s}px ${FONT}`;

    const measure = (t: string, f: string) => {
      const key = f + '|' + t;
      let m = measureCache.current.get(key);
      if (m === undefined) { ctx.font = f; m = ctx.measureText(t).width; measureCache.current.set(key, m); }
      return m;
    };
    hits.current = [];

    if (!P.events.length) {
      ctx.fillStyle = C.muted; ctx.font = `500 ${14 * s}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No events match this timeline’s filters', w / 2, h / 2 - 10 * s);
      ctx.fillStyle = C.dim; ctx.font = small;
      ctx.fillText('Open the menu to change the rules', w / 2, h / 2 + 12 * s);
      return;
    }

    // plan labels (cached per zoom level)
    const key = [k.toFixed(4), s.toFixed(3), maxLanes, P.settings.showDates].join('|');
    let plan = planCache.current;
    if (!plan || plan.key !== key || plan.world !== P.world || plan.events !== P.events) {
      const dateText = (e: Ev) => (P.settings.showDates ? whenLabel(P.ds, e).date : null);
      const p = planLabels({
        events: P.events, x: P.world.x, k, maxLanes, maxChip: 230 * s, padX: 9 * s, gap: 8 * s,
        measure: (t) => measure(t, font), measureDate: (t) => measure(t, small), dateText, dateRows: 2,
      });
      plan = planCache.current = { key, world: P.world, events: P.events, plan: p };
    }
    const chips = plan.plan.chips;

    // center the whole stack (chips + axis + dates/episodes) vertically in the free space
    let topLane = -1;
    for (const c of chips.values()) if (c.lane > topLane) topLane = c.lane;
    const above = topLane < 0 ? 12 * s : 16 * s + topLane * laneH + chipH;
    const slack = h - below - above - 8 * s;
    if (slack > 0) axisY -= slack / 2;

    // episode separators + labels
    if (P.settings.showEpisodes) {
      ctx.font = small; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      let lastR = -1e9;
      for (const t of P.world.ticks) {
        const x = sx(t.x);
        if (x < -300 || x > w + 40) continue;
        ctx.strokeStyle = 'rgba(217,181,82,0.13)'; ctx.setLineDash([3 * s, 5 * s]);
        ctx.beginPath(); ctx.moveTo(x, 8 * s); ctx.lineTo(x, axisY + 16 * s); ctx.stroke(); ctx.setLineDash([]);
        const ep = P.ds.episodes.get(t.ep);
        const code = epCode(P.ds, t.ep);
        const wide = `${code}  ${ep?.title ?? ''}`;
        const room = Math.max(0, (P.world.ticks.find((n) => n.x > t.x)?.x ?? t.x + 400) * k - t.x * k - 12);
        const label = measure(wide, small) < room ? wide : measure(code, small) < room ? code : '';
        if (label && x + 6 > lastR) {
          ctx.fillStyle = C.gold; ctx.globalAlpha = 0.85; ctx.fillText(label, x + 6, axisY + 44 * s);
          ctx.globalAlpha = 1; lastR = x + 6 + measure(label, small) + 8;
        }
      }
    }

    // axis
    const x0 = sx(P.world.x.get(P.events[0].id)! - 60), x1 = sx(P.world.x.get(P.events[P.events.length - 1].id)! + 60);
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 14 * s; ctx.strokeStyle = color; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.moveTo(Math.max(-5, x0), axisY); ctx.lineTo(Math.min(w + 5, x1), axisY); ctx.stroke();
    ctx.restore();

    // dates under points
    if (P.settings.showDates) {
      ctx.font = small; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const e of P.events) {
        const d = plan.plan.dates.get(e.id);
        if (!d) continue;
        const x = sx(P.world.x.get(e.id)!);
        if (x < -120 || x > w + 120) continue;
        ctx.fillStyle = C.text; ctx.globalAlpha = 0.9;
        ctx.fillText(d.text, x, axisY + (15 + d.row * 13) * s);
        ctx.globalAlpha = 1;
      }
    }

    // flags + dots
    const drawChip = (e: Ev, hover: boolean) => {
      const c = chips.get(e.id);
      if (!c) return;
      const x = sx(P.world.x.get(e.id)!);
      if (x > w + 4 || x + c.w < -4) return;
      const bottom = axisY - 16 * s - c.lane * laneH, top = bottom - chipH;
      const match = P.highlight.has(e.id);
      ctx.strokeStyle = hexA(color, hover ? 0.9 : 0.45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, axisY); ctx.lineTo(x, bottom); ctx.stroke();
      chipPath(ctx, x, top, c.w, chipH, 6 * s);
      ctx.fillStyle = hover ? C.chipHover : C.chip; ctx.fill();
      ctx.strokeStyle = match ? '#ffffff' : hexA(color, hover ? 1 : 0.7); ctx.lineWidth = match ? 1.8 : 1; ctx.stroke();
      ctx.fillStyle = color; ctx.fillRect(x, top + 3 * s, 2.5 * s, chipH - 6 * s);
      ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.text;
      let txt = c.text;
      const avail = c.w - 18 * s;
      if (measure(txt, font) > avail) {
        while (txt.length > 1 && measure(txt + '…', font) > avail) txt = txt.slice(0, -1);
        txt += '…';
      }
      ctx.fillText(txt, x + 9 * s, top + chipH / 2 + 0.5);
      hits.current.push({ id: e.id, kind: 'chip', x, y: top, w: c.w, h: chipH });
    };
    let hovered: Ev | null = null;
    for (const e of P.events) {
      const x = sx(P.world.x.get(e.id)!);
      if (x < -300 || x > w + 40) continue;
      if (e.id === hoverId.current) { hovered = e; continue; }
      drawChip(e, false);
    }
    if (hovered) drawChip(hovered, true);

    const gap = STEP * k * (P.settings.axis === 'aligned' ? 1 : 1);
    const dense = gap < 11 * s;                       // far zoomed out: tiny, outline-free dots so they read as a beaded line
    const r = dense ? Math.max(1.4, gap * 0.36) : 5 * s;
    for (const e of P.events) {
      const x = sx(P.world.x.get(e.id)!);
      if (x < -20 || x > w + 20) continue;
      const hov = e.id === hoverId.current, match = P.highlight.has(e.id);
      ctx.save();
      if (hov || match) { ctx.shadowColor = match ? '#fff' : color; ctx.shadowBlur = 12 * s; }
      ctx.lineWidth = 2 * s; ctx.strokeStyle = color;
      if (e.flashback) { // hollow diamond = happened before the episode's present
        ctx.beginPath(); ctx.moveTo(x, axisY - r * 1.35); ctx.lineTo(x + r * 1.35, axisY); ctx.lineTo(x, axisY + r * 1.35); ctx.lineTo(x - r * 1.35, axisY); ctx.closePath();
        ctx.fillStyle = C.bg1; ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, axisY, r * (hov ? 1.25 : 1), 0, Math.PI * 2);
        ctx.fillStyle = e.review ? C.bg1 : color; ctx.fill();
        if (e.review) ctx.stroke();
        else if (!dense) { ctx.strokeStyle = C.bg1; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
      ctx.restore();
      if (match) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, axisY, r * 2, 0, Math.PI * 2); ctx.stroke(); }
      hits.current.push({ id: e.id, kind: 'dot', x: x - 13, y: axisY - 13, w: 26, h: 26 });
    }
  }, []);

  const invalidate = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; paint(); });
  }, [paint]);

  // ------------------------------------------------------------------ lifecycle
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      size.current = { w: Math.max(120, r.width), h: Math.max(120, r.height), dpr };
      canvas.width = Math.round(size.current.w * dpr); canvas.height = Math.round(size.current.h * dpr);
      canvas.style.width = size.current.w + 'px'; canvas.style.height = size.current.h + 'px';
      measureCache.current.clear(); planCache.current = null;
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    const unsub = props.bus.subscribe(invalidate);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const v = getView();
        setView({ ...v, cx: v.cx + (e.deltaX || e.deltaY) / v.k });
      } else {
        zoomAt(e.clientX - rect.left, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => { ro.disconnect(); unsub(); canvas.removeEventListener('wheel', onWheel); cancelAnimationFrame(raf.current); raf.current = 0; cancelAnimationFrame(inertia.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { planCache.current = null; invalidate(); },
    [props.events, props.world, props.settings, props.timeline.color, props.highlight, props.fontTick, invalidate]);

  // ------------------------------------------------------------------ interaction
  const hitTest = (x: number, y: number, touch: boolean): string | null => {
    const pad = touch ? 8 : 2;
    const list = hits.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (h.kind === 'chip' && x >= h.x - pad && x <= h.x + h.w + pad && y >= h.y - pad && y <= h.y + h.h + pad) return h.id;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (h.kind === 'dot' && x >= h.x - pad && x <= h.x + h.w + pad && y >= h.y - pad && y <= h.y + h.h + pad) return h.id;
    }
    return null;
  };
  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current!.setPointerCapture(e.pointerId);
    cancelAnimationFrame(inertia.current);
    propsRef.current.bus.stop();
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      drag.current = { id: e.pointerId, sx: p.x, sy: p.y, cx: getView().cx, moved: false, t0: performance.now(), samples: [{ t: performance.now(), x: p.x }] };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const v = getView(), mid = (a.x + b.x) / 2;
      pinch.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: v.k, mid, worldMid: (mid - size.current.w / 2) / v.k + v.cx };
      if (drag.current) drag.current.moved = true;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = (a.x + b.x) / 2, d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const k = clamp(pinch.current.k0 * (d / pinch.current.d0), kMinOf(size.current.w, propsRef.current.world), K_MAX);
      setView({ k, cx: pinch.current.worldMid - (mid - size.current.w / 2) / k });
      return;
    }
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.sx;
      if (!d.moved && Math.hypot(dx, p.y - d.sy) > 5) { d.moved = true; setGrabbing(true); setTip(null); hoverId.current = null; }
      if (d.moved) {
        const v = getView();
        setView({ k: v.k, cx: d.cx - dx / v.k });
        const now = performance.now();
        d.samples.push({ t: now, x: p.x });
        while (d.samples.length > 2 && now - d.samples[0].t > 90) d.samples.shift();
      }
      return;
    }
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      const id = hitTest(p.x, p.y, false);
      if (id !== hoverId.current) {
        hoverId.current = id; setPointer(!!id); invalidate();
        const hit = id ? hits.current.find((h) => h.id === id && h.kind === 'chip') ?? hits.current.find((h) => h.id === id) : null;
        setTip(id && hit ? { id, x: Math.min(size.current.w - 250, Math.max(8, hit.x)), y: hit.y } : null);
      }
    }
  };
  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    const p = local(e);
    pointers.current.delete(e.pointerId);
    if (pinch.current) { if (pointers.current.size < 2) pinch.current = null; drag.current = null; setGrabbing(false); return; }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null; setGrabbing(false);
    if (cancelled) return;
    if (!d.moved) {
      const id = hitTest(p.x, p.y, e.pointerType !== 'mouse');
      if (id) propsRef.current.onOpen(id);
      return;
    }
    const s0 = d.samples[0], s1 = d.samples[d.samples.length - 1];
    const dt = s1.t - s0.t;
    if (!propsRef.current.settings.inertia || dt < 8 || performance.now() - s1.t > 80) return;
    let vx = -(s1.x - s0.x) / dt / getView().k; // world units per ms
    let last = performance.now();
    const step = (now: number) => {
      const dtn = now - last; last = now;
      const v = getView();
      vx *= Math.exp(-dtn / 340);
      if (Math.abs(vx * v.k) < 0.015) return;
      setView({ k: v.k, cx: v.cx + vx * dtn });
      inertia.current = requestAnimationFrame(step);
    };
    inertia.current = requestAnimationFrame(step);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const v = getView();
    const map: Record<string, () => void> = {
      ArrowLeft: () => setView({ ...v, cx: v.cx - 160 / v.k }), ArrowRight: () => setView({ ...v, cx: v.cx + 160 / v.k }),
      '+': () => zoomAt(size.current.w / 2, 1.3), '=': () => zoomAt(size.current.w / 2, 1.3), '-': () => zoomAt(size.current.w / 2, 1 / 1.3),
      Home: () => setView({ ...v, cx: 0 }), End: () => setView({ ...v, cx: propsRef.current.world.width }),
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  };

  const tipEv = tip ? props.ds.eventById.get(tip.id) : null;
  const when = tipEv ? whenLabel(props.ds, tipEv) : null;
  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef} tabIndex={0} role="img"
        aria-label={`Timeline “${props.timeline.name}” with ${props.events.length} events. Drag to pan, scroll or pinch to zoom, arrow keys to move.`}
        style={{ cursor: grabbing ? 'grabbing' : pointer ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e, false)} onPointerCancel={(e) => endPointer(e, true)}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !drag.current) { hoverId.current = null; setPointer(false); setTip(null); invalidate(); } }}
        onDoubleClick={(e) => { const r = canvasRef.current!.getBoundingClientRect(); zoomAt(e.clientX - r.left, 1.9); }}
        onKeyDown={onKeyDown}
      />
      {tip && tipEv && (
        <div className="tip" style={{ left: tip.x, top: Math.max(4, tip.y - 8), transform: 'translateY(-100%)' }}>
          <strong>{tipEv.title}</strong>
          <span>{when!.text}</span>
        </div>
      )}
    </div>
  );
});
