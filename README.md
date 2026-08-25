# Jez Explore — `site/`

Static web app: a zoomable map of Jezero Crater with Perseverance's traverse, Ingenuity's
flights, 3D terrain, contours and the paleolake. No build step, native ES modules, two vendored
libraries. This folder is the deployable unit (repo: **`jez-explore`**, live at
<https://astrodavid10.github.io/jez-explore/>).

Design authority: `../docs/frontend-design.md` (frontend) and `../docs/pipeline-design.md`
(tiles + data contract). Project rules: `../CLAUDE.md`.

---

## Running it locally

```
serve.bat
```

That serves this folder on <http://127.0.0.1:8714> and opens a browser.

> **Double-clicking `index.html` will NOT work.** MapLibre GL JS 6.x is ESM-only and derives
> its web-worker URL from `import.meta.url`; the bundle contains an explicit
> `if (!/^https?:/.test(import.meta.url)) return ''`, so under `file://` the worker never
> loads and no map appears. Any static HTTP server is fine (`serve.bat`, `npx serve -l 8714`,
> nginx, GitHub Pages) — but it must be a server.

Nothing else is required: no npm install, no bundler, no environment variables.

### Boot with `tiles/` and `data/` absent

The app is designed to come up on an empty repository (§7 of the frontend design):

| Missing | Behavior |
|---|---|
| `tiles/manifest.json` | `js/manifest.js` falls back to the pipeline contract defaults and logs it; the app still boots |
| `tiles/img/**`, `tiles/imghi/**` | raster layers render nothing; you see the `#0a0a0c` background layer. Map pans, zooms, clamps to bounds |
| `tiles/dem/**` | contours produce no features, 3D terrain stays flat, the elevation readout shows nothing, `hillshade` draws nothing. No errors that stop anything |
| `data/**` | `Promise.allSettled`; every GeoJSON source stays an empty FeatureCollection and a `data:missing` event fires per file so panels can disable their toggles |
| z18 imagery pack | 3-second probe at boot; the source and layer are never added, z17 overzooms, About says "not installed" |
| `maplibre-contour` init failure | contour sources/layers omitted from the style, everything else unaffected |
| **No WebGL2** | **the only fatal case** — `#static-fallback` is shown (hero image, explainer, NASA link) and the app never starts |

Expect these in the console on a bare checkout, all of them harmless:
`tiles/manifest.json` info line (if absent), a handful of tile 404 warnings (suppressed after
8), `data/*.geojson unavailable` info lines, and 404s for the not-yet-written feature modules
(`js/timeline.js`, `js/layers.js`, `js/ingenuity.js`, `js/flood.js`, `js/tour.js`) — `js/ui.js`
imports those opportunistically so the feature agents never have to edit the shell.

---

## Layout

```
index.html      boot banner, global error listeners, WebGL2 fallback, OG meta
style.css       house dark theme, 320 px sidebar / 3-detent bottom sheet / landscape drawer
serve.bat       local HTTP server on 127.0.0.1:8714
ABOUT.md        the About panel's text, in Markdown
js/
  boot.js       WebGL2 gate, CDN→vendor library fallback (3 tiers), glyph sanity fetch
  config.js     *** FROZEN CONTRACTS *** LAYER_IDS, HASH_KEYS, GLOBAL_STATE, DATA_FILES,
                TOUR (8 stops), BOOKMARKS, SCALE fallback, palette
  manifest.js   loads tiles/manifest.json, probes the z18 pack, normalizes
  style.js      buildStyle(manifest, demSource, opts) → the whole style object
  map.js        DemSource → Map, Mars scale bar, 3D + exaggeration, elevation readout, markers
  hash.js       #@lon,lat,zoom,pitch,bearing&… (frozen short keys), replaceState/pushState
  ui.js         sidebar/sheet shell, panel + action registry, toasts, badge, About, kiosk
  data.js       allSettled loader → setData, live NASA position, raw-image thumbnails
fonts/          Noto Sans Regular + Bold glyph PBFs (0-255)
vendor/         maplibre-gl 6.5.0 (.mjs ×3 + .css), maplibre-contour 0.1.0, both LICENSEs
assets/         rover.svg, heli.svg, sample.svg, USSRC_IP_logo.svg  (+ hero-jezero.jpg — TODO)
tiles/          manifest.json (+ img/ imghi/ dem/ — produced by the pipeline)
data/           GeoJSON/JSON — produced by the pipeline
```

### Adding a feature module (for the parallel feature agents)

`js/ui.js` dynamically imports `./timeline.js`, `./layers.js`, `./ingenuity.js`, `./flood.js`
and `./tour.js` after the map is ready. Create yours and register into the shell — **no edits to
the shell files are needed**:

```js
import { registerPanel, registerAction, toast, setBadge, LITE } from './ui.js';

registerPanel('TIMELINE', (body, app) => { /* build into `body` */ });
registerAction('tour:start', () => { /* powers the header button */ });
export function init(app) { /* optional; called once, after the map is ready */ }
```

Panel ids are frozen: `TIMELINE`, `VIEWS`, `LAYERS`, `INGENUITY`, `ABOUT` (ABOUT is owned by
`ui.js`). The app namespace (`window.jezero`) carries `map`, `manifest`, `SCALE`, `demSource`,
`elevAt`, `marsMetres`, `makeMarker`, `set3D`, `setExaggeration`, `data`, `ensureData`,
`fetchCurrentPosition`, `fetchRawImages`, plus the `on/off/emit` bus. Layer ids, hash keys,
global-state names and data file names all come from `js/config.js` and must not be renamed.

---

## Provenance of `tiles/` and `data/`

Both are generated — never hand-edited — by the pipeline in `../pipeline/`:

- `tiles/img/`, `tiles/imghi/` ← `p04_warp_imagery.py` + `p05_tile_imagery.py`
  (WebP q80, WebMercatorQuad, XYZ, 256 px)
- `tiles/dem/` ← `p06_dem_merge_warp.py` + `p07_terrarium.py`
  (Terrarium PNG, 256 px, quantized to 1/16 m; `.encoder.json` stamps the format)
- `tiles/manifest.json` ← the pipeline; **single source of truth** for paths, zoom caps,
  bounds and `body.scale` (1.878027). Nothing in `js/` may hardcode those numbers
- `data/*.geojson`, `data/*.json` ← `p08_vectors.py`, `p10_contour_ring.py` from the NASA
  snapshots in `../raw/nasa/` and David's Ingenuity trajectories
- Staging: the pipeline writes `../out/tiles` and `../out/data`, which are then copied into
  `tiles/` and `data/` here

Source data credits are in `ABOUT.md` and in `js/config.js` `ATTRIBUTION`.

---

## Status (2026-08-24)

Everything in the original build is done and verified in a real browser: the shell, all six
feature modules, the pipeline p01–p12, and the QA gate suite. What follows is what is still
open, and it is short.

| Item | Status |
|---|---|
| DEM zoom 16 | **deliberately not published.** 209.5 MB and 10,290 files for a mean pixel difference of 1.2/255 — at z16 the terrain moves ~6 cm per pixel while the HiRISE imagery draped on it is 25–50 cm. `dem.maxzoom` is 15 and MapLibre overzooms; nothing 404s. The tiles are kept on the build machine — `python pipeline/dem_z16_park.py --restore` puts them back in one command |
| Drilled sample locations | 22 samples ship, but `sol` is a string, so they cannot be filtered by the timeline yet. Backlog item D1 |
| `places.geojson` | 3 derivable entries (landing site, Wright Brothers Field, Three Forks). The ~11 named geological features need verified coordinates and have not been guessed at |
| Mobile | in scope and functional — 3-detent bottom sheet, 44 px targets, lite auto-detect. A dedicated pass on a real handset is backlog item D2 |
| Dome network | the offline-vendored boot path has been simulated but not run on the dome's isolated network |

## Deploying (GitHub Pages)

Published 2026-08-24 to the `astrodavid10` account. Kept here as the runbook.

- Two repositories: **`jez-explore`** (this folder) and **`jez-explore-z18`** (the z18 imagery
  pack, `../tilepacks/z18/`). Splitting them keeps this repo inside Pages' comfortable size
  range and lets the deep-zoom pack be optional
- `.nojekyll` at the root of both (already present here) — without it Pages' Jekyll pass drops
  paths beginning with `_` and can mangle the tile trees
- **Never use Git LFS.** GitHub Pages serves LFS pointer files as-is; every tile would 404
- Commit tiles in **per-zoom batches**, not one giant commit
- GitHub Pages sends `Access-Control-Allow-Origin: *` on everything (verified), so the
  cross-origin z18 pack works from the main site
- After publishing, set the real account name in `tiles/manifest.json`
  (`imagery_ultra.url` + `.probe`) and add `assets/hero-jezero.jpg`
- Budget gate (pipeline QA 9g): site content ≤ 700 MB and no single file > 50 MB.
  Currently **467.8 MB** published (zooms above the manifest's maxzoom are reported as
  parked and excluded — see `pipeline/dem_z16_park.py`)
