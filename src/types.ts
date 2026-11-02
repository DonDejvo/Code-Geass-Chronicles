export type Kind = 'character' | 'faction' | 'location' | 'equipment' | 'concept' | 'event';
export const KINDS: Kind[] = ['character', 'faction', 'location', 'equipment', 'concept', 'event'];
export const KIND_LABEL: Record<Kind, string> = {
  character: 'Character', faction: 'Faction', location: 'Location',
  equipment: 'Equipment', concept: 'Concept', event: 'Battle / event',
};
export const KIND_PLURAL: Record<Kind, string> = {
  character: 'Characters', faction: 'Factions', location: 'Locations',
  equipment: 'Equipment', concept: 'Concepts', event: 'Battles & events',
};

export interface Entity {
  id: string; title: string; kinds: Kind[]; wiki: string; summary: string;
  infobox: Record<string, string>; aliases: string[];
}
export interface DateInfo { kind: 'absolute' | 'relative' | 'unknown'; abs: string | null; rel: string | null; anchor: string | null }
export interface Ev {
  id: string; ep: string; order: number; idx: number; title: string; summary: string; source: string;
  links: Record<Kind, string[]>; flashback: boolean; date: DateInfo; conf: number; review: boolean; flags: string[];
  hay?: string; imp?: number;
}
export interface Episode {
  id: string; series: string; number: number | null; title: string; wiki: string; air: string | null;
  synopsis: string[]; order: number; source?: { source: string; url: string; note: string };
}
export interface Series { id: string; slot: number; label: string; note: string }
export interface Raw {
  meta: { generated: string; credit: string }; series: Series[]; episodes: Episode[]; entities: Entity[]; events: Ev[];
}

export type PageType = 'event' | 'entity' | 'episode';
export interface Page { type: PageType; id: string }

export type Field = Kind | 'episode' | 'series' | 'text';
export const FIELDS: Field[] = ['character', 'faction', 'location', 'equipment', 'concept', 'event', 'episode', 'series', 'text'];
export const FIELD_LABEL: Record<Field, string> = { ...KIND_LABEL, episode: 'Episode', series: 'Series', text: 'Text' };
export interface Rule { id: string; join: 'and' | 'or'; field: Field; op: 'is' | 'isnot'; value: string }
export interface Timeline { id: string; name: string; color: string; rules: Rule[] }

export interface Settings {
  axis: 'aligned' | 'packed';
  linkViews: boolean;
  labelScale: number;
  showDates: boolean;
  showEpisodes: boolean;
  maxLanes: number;
  inertia: boolean;
  highlightSearch: boolean;
  accent: 'gold' | 'violet' | 'crimson';
}
export const DEFAULT_SETTINGS: Settings = {
  axis: 'aligned', linkViews: true, labelScale: 1, showDates: true, showEpisodes: true,
  maxLanes: 6, inertia: true, highlightSearch: true, accent: 'gold',
};
export const TRACK_COLORS = ['#d9b552', '#a77bff', '#e0345f', '#38d6c4', '#f08a3c', '#7aa7ff'];
