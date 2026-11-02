import { useEffect, useRef } from 'react';
import { useApp } from '../state/store';
import { EntityPage, EpisodePage, EventPage, titleOf } from './Pages';

export function DetailStack() {
  const { ds, state, act } = useApp();
  const { stack } = state;
  const sheet = useRef<HTMLDivElement>(null);
  const open = stack.length > 0;
  const openedAt = useRef(0);
  useEffect(() => { if (open) openedAt.current = performance.now(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); act.closeTop(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, act]);

  // Move focus into the sheet when it opens or the top page changes.
  useEffect(() => { if (open) sheet.current?.focus({ preventScroll: true }); }, [open, stack.length]);

  const prev = stack[stack.length - 2];
  const back = prev ? titleOf(ds, prev) : 'Timeline';
  return (
    <div className={`detail${open ? ' open' : ''}`} aria-hidden={!open}
      // Opening from a canvas tap is followed by a synthesized click at the same point; swallow it so it cannot hit the scrim or a link.
      onClickCapture={(e) => { if (performance.now() - openedAt.current < 450) { e.stopPropagation(); e.preventDefault(); } }}>
      <div className="detail-scrim" onClick={() => act.closeAll()} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Details" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <button className="btn back" onClick={() => act.closeTop()}><span aria-hidden>←</span> <span className="bl">Back to {back}</span></button>
          {stack.length > 1 && <button className="btn ghost small" onClick={() => act.closeAll()}>Close all</button>}
          <button className="icon-btn" aria-label="Close" onClick={() => act.closeAll()}>×</button>
        </header>
        <div className="sheet-pages">
          {stack.map((p, i) => (
            <div key={`${i}:${p.type}:${p.id}`} className={`sheet-page${i === stack.length - 1 ? ' top' : ''}`} aria-hidden={i !== stack.length - 1}>
              {p.type === 'event' ? <EventPage id={p.id} /> : p.type === 'entity' ? <EntityPage id={p.id} /> : <EpisodePage id={p.id} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
