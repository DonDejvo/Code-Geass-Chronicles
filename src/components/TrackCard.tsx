import { memo, useRef } from 'react';
import type { DataSet } from '../lib/data';
import type { ViewBus } from '../lib/bus';
import type { World } from '../lib/layout';
import { describeRules } from '../lib/filter';
import type { Ev, Settings, Timeline } from '../types';
import { TimelineCanvas, type CanvasHandle } from './TimelineCanvas';

interface Props {
  timeline: Timeline; events: Ev[]; world: World; ds: DataSet; settings: Settings; bus: ViewBus;
  highlight: Set<string>; fontTick: number; active: boolean; canRemove: boolean;
  onOpen: (id: string) => void; onEdit: () => void; onRemove: () => void; onActivate: () => void;
}

export const TrackCard = memo(function TrackCard(p: Props) {
  const h = useRef<CanvasHandle>(null);
  const expr = describeRules(p.timeline.rules, p.ds);
  return (
    <section className={`track${p.active ? ' active' : ''}`} style={{ ['--tc' as string]: p.timeline.color }} onPointerDown={p.onActivate} aria-label={p.timeline.name}>
      <header className="track-head">
        <span className="swatch" aria-hidden />
        <h2 title={p.timeline.name}>{p.timeline.name}</h2>
        <span className="count" title="events shown">{p.events.length}</span>
        <span className="expr" title={expr}>{expr || 'all events'}</span>
        <span className="grow" />
        <button className="icon-btn" aria-label="Zoom out" onClick={() => h.current?.zoom(1 / 1.5)}>−</button>
        <button className="icon-btn" aria-label="Zoom in" onClick={() => h.current?.zoom(1.5)}>+</button>
        <button className="icon-btn" aria-label="Fit whole timeline" title="Fit" onClick={() => h.current?.fit()}>⤢</button>
        <button className="icon-btn" aria-label="Edit filters" title="Edit filters" onClick={p.onEdit}>⚙</button>
        {p.canRemove && <button className="icon-btn" aria-label="Remove timeline" onClick={p.onRemove}>×</button>}
      </header>
      <div className="track-body">
        <TimelineCanvas ref={h} timeline={p.timeline} events={p.events} world={p.world} ds={p.ds} settings={p.settings}
          bus={p.bus} highlight={p.highlight} onOpen={p.onOpen} fontTick={p.fontTick} />
        {p.events.length === 0 && <div className="empty">No events match these filters.</div>}
      </div>
    </section>
  );
});
