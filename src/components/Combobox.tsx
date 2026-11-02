import { useId, useMemo, useRef, useState } from 'react';
import { fold } from '../lib/fold';

export interface Opt { id: string; label: string; sub?: string; weight?: number; alt?: string }

export function rank(options: Opt[], q: string, limit = 60): Opt[] {
  const f = fold(q);
  const byWeight = (a: Opt, b: Opt) => (b.weight ?? 0) - (a.weight ?? 0) || a.label.localeCompare(b.label);
  if (!f) return options.slice().sort(byWeight).slice(0, limit);
  const toks = f.split(' ');
  const scored: { o: Opt; sc: number }[] = [];
  for (const o of options) {
    const l = fold(o.label);
    let sc = -1;
    if (l.startsWith(f)) sc = 0;
    else if (l.split(' ').some((w) => w.startsWith(f))) sc = 1;
    else if (toks.every((t) => l.includes(t))) sc = 2;
    else if (o.alt && toks.every((t) => fold(o.alt!).includes(t))) sc = 3;
    if (sc >= 0) scored.push({ o, sc });
  }
  return scored.sort((a, b) => a.sc - b.sc || byWeight(a.o, b.o)).slice(0, limit).map((x) => x.o);
}

/** Text input with an auto-suggest list (keyboard: ↑ ↓ Enter Esc). Selecting stores the option id. */
export function Combobox({ options, value, onChange, placeholder, autoFocus, ariaLabel }: {
  options: Opt[]; value: string; onChange: (id: string) => void; placeholder?: string; autoFocus?: boolean; ariaLabel?: string;
}) {
  const uid = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.id === value);
  const list = useMemo(() => rank(options, q), [options, q]);
  const choose = (o: Opt) => { onChange(o.id); setOpen(false); setQ(''); input.current?.blur(); };
  return (
    <div className="combo">
      <input
        ref={input} type="text" autoFocus={autoFocus} autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={open} aria-controls={`${uid}-list`} aria-autocomplete="list" aria-label={ariaLabel}
        aria-activedescendant={open && list[hi] ? `${uid}-${hi}` : undefined}
        placeholder={placeholder ?? 'Type to search…'}
        value={open ? q : selected?.label ?? (value ? `⚠ ${value}` : '')}
        onFocus={(e) => { setOpen(true); setQ(''); setHi(0); e.currentTarget.select(); }}
        onBlur={() => setOpen(false)}
        onChange={(e) => { setQ(e.target.value); setHi(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(list.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter' && open && list[hi]) { e.preventDefault(); choose(list[hi]); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && (
        <ul id={`${uid}-list`} className="combo-list" role="listbox">
          {list.length === 0 && <li className="combo-empty">No match</li>}
          {list.map((o, i) => (
            <li key={o.id} id={`${uid}-${i}`} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }} onMouseEnter={() => setHi(i)}>
              <span>{o.label}</span>{o.sub && <small>{o.sub}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
