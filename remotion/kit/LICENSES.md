# Kit data licences

## world.ts (map scene outlines)
- Source: Natural Earth 110m admin-0 country outlines (naturalearthdata.com).
- Licence: public domain (Natural Earth terms of use; no attribution required).
- Origin in this repo: carried over from the old kit's `src/lib/geo/world.ts` (header there says Natural Earth 110m, public domain), then merged to plain rings and rounded to 0.5 degree (about 38 KB).
- Bundled as a TS array; nothing is fetched at render time.
