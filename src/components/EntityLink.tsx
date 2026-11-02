import type { ReactNode } from 'react';
import { fold } from '../lib/fold';
import { primaryKind } from '../lib/data';
import { useApp } from '../state/store';

export function EntityLink({ id, children }: { id: string; children?: ReactNode }) {
  const { ds, act } = useApp();
  const e = ds.entities.get(id);
  if (!e) return <>{children}</>;
  return (
    <a className={`elink k-${primaryKind(e)}`} href={`#/entity/${id}`} title={e.title}
      onClick={(ev) => { ev.preventDefault(); act.openPage({ type: 'entity', id }); }}>
      {children ?? e.title}
    </a>
  );
}

/** Renders wiki text, turning [[Page Title]] into links to entity pages when we have them. */
export function Rich({ text }: { text: string }) {
  const { ds } = useApp();
  const out: ReactNode[] = [];
  const re = /\[\[(.+?)\]\]/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const target = m[1].split('#')[0];
    const id = ds.aliasIndex.get(fold(target));
    out.push(id ? <EntityLink key={i++} id={id}>{target.replace(/_/g, ' ')}</EntityLink> : <span key={i++}>{target.replace(/_/g, ' ')}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
