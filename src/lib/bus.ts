export interface View { cx: number; k: number }
export const K_MAX = 2.6;

/**
 * Holds the pan/zoom of every timeline outside React, so dragging never re-renders React.
 * `cx` is the world x at the centre of the canvas, which survives resizing and works when views are linked.
 */
export class ViewBus {
  private views = new Map<string, View>();
  private subs = new Set<() => void>();
  private saveSubs = new Set<(v: Record<string, View>) => void>();
  linked = true;
  private anim = 0;

  constructor(initial: Record<string, View> = {}) {
    for (const [k, v] of Object.entries(initial)) this.views.set(k, v);
  }
  get(id: string) { return this.views.get(id); }
  has(id: string) { return this.views.has(id); }
  init(id: string, v: View) { if (!this.views.has(id)) this.views.set(id, v); }
  forget(id: string) { this.views.delete(id); this.emit(); }
  snapshot(): Record<string, View> { return Object.fromEntries(this.views); }

  set(id: string, v: View, propagate = true) {
    if (this.linked && propagate) for (const key of this.views.keys()) this.views.set(key, { ...v });
    this.views.set(id, { ...v });
    this.emit();
  }
  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  onSave(fn: (v: Record<string, View>) => void) { this.saveSubs.add(fn); return () => { this.saveSubs.delete(fn); }; }
  private emit() { this.subs.forEach((f) => f()); this.saveSubs.forEach((f) => f(this.snapshot())); }

  /** Smoothly move several timelines (used by "Locate on timeline"). */
  flyTo(targets: Record<string, View>, ms = 650) {
    cancelAnimationFrame(this.anim);
    const from = new Map<string, View>();
    for (const id of Object.keys(targets)) from.set(id, this.views.get(id) ?? targets[id]);
    const t0 = performance.now();
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms), e = ease(t);
      for (const [id, to] of Object.entries(targets)) {
        const f = from.get(id)!;
        // interpolate zoom in log space so it feels even
        this.views.set(id, { cx: f.cx + (to.cx - f.cx) * e, k: Math.exp(Math.log(f.k) + (Math.log(to.k) - Math.log(f.k)) * e) });
      }
      this.emit();
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }
  stop() { cancelAnimationFrame(this.anim); }
}
