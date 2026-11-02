# Code Geass Chronicles

React 18 + TypeScript + Vite. Timelines use Canvas2D and pointer events; menus, filters and detail pages are plain HTML.

    npm install
    npm run dev        # http://localhost:5173
    npm run build      # type-check + production build into dist/
    npm test           # filter-logic tests

## Data
`public/data/timeline.json` is generated from the pipeline output:

    python scripts/build_data.py --fixed ../export_fixed --events ../events/events_all.json --out public/data/timeline.json

Re-run it whenever `events_all.json` grows (R2, Akito). Events without a stated date are ordered by story order.

## Notes
- State (timelines, filters, settings, search, open pages, pan/zoom) is saved in localStorage key `gcw:v1`.
- Each opened detail page is a browser-history entry, so Back / Esc closes one page at a time.
- Text from the Code Geass Fandom wiki is CC BY-SA.
