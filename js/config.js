/* =============================================================================
 * Jez Explore — config.js
 *
 *                        *** FROZEN CONTRACTS ***
 *
 * Everything exported from this file is a contract shared by every module in
 * the app. Feature agents (timeline.js, layers.js, ingenuity.js, tour.js,
 * flood/hypsometric) MUST NOT change any of the following:
 *
 *   LAYER_IDS      layer id strings — style.js creates them, panels toggle them
 *   HASH_KEYS      URL short keys — printed QR codes outlive refactors, so
 *                  these are permanent. NEVER renumber, rename or reuse a key.
 *   GLOBAL_STATE   map global-state property names driving filters + paint
 *   DATA_FILES     data/ file names produced by the pipeline
 *
 * Additive change is fine (a new layer id, a new hash key at the end of the
 * table). Renaming or repurposing an existing entry is a breaking change and
 * needs David's sign-off, not an agent's judgement call.
 *
 * References: docs/frontend-design.md §2 (data), §3.2 (layers), §4.10 (tour),
 * §4.11 (hash). docs/pipeline-design.md "Frontend contract (verbatim)".
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * Scale — the single biggest correctness issue in the project.
 *
 * The tiles are Mars data relabelled into a "pretend Earth" WebMercatorQuad
 * grid, so all horizontal distances come out inflated by
 *     SCALE = 6378137 / 3396190 = 1.878027
 * while DEM values stay true Mars meters. Read the real value from
 * tiles/manifest.json (body.scale); this constant is only the fallback used if
 * the manifest cannot be loaded. Never hardcode 1.878027 anywhere else.
 * -------------------------------------------------------------------------- */
export const SCALE = 1.878027;

/** Vertical datum note, surfaced in About and popups. */
export const VERTICAL_DATUM = 'Mars2000 areoid';

/* -----------------------------------------------------------------------------
 * Mission anchors (verified against NASA data — see docs/frontend-design.md §8)
 * -------------------------------------------------------------------------- */
export const LANDING = {
  name: 'Octavia E. Butler Landing',
  lon: 77.45088572,
  lat: 18.44462715,
  elev: -2569.91,
  sol: 0,
  date: '2021-02-18',
};

/** Fallback snapshot if data/snapshot.json is missing. */
export const SNAPSHOT = {
  sol: 1955,
  date: '2026-08-20',
  km: 44.98,
  lon: 77.232871,
  lat: 18.435599,
  elev: -1937.45,
};

/** Ingenuity mission totals, for the panel header. */
export const HELI_TOTALS = { flights: 72, km: 18.139, airtime_s: 7740 };

/* -----------------------------------------------------------------------------
 * FROZEN: layer ids (docs/frontend-design.md §3.2, bottom → top)
 *
 * The design table numbers 27 rows; two rows carry two layers each (row 2/2b
 * imagery + imagery-hi, row 14 depot-fill + depot-line), so there are 29 layer
 * id strings in render order. Order in this array IS the render order — style.js
 * builds the style in exactly this sequence, and any layer inserted later must
 * use map.addLayer(layer, beforeId) with an id from this list.
 * -------------------------------------------------------------------------- */
export const LAYER_IDS = [
  'bg',                   //  1  background
  'imagery',              //  2  raster z6–15
  'imagery-hi',           //  2b raster z16–17
  'imagery-ultra',        //  3  raster z18 (cross-origin pack; added only if probed)
  'hypsometric',          //  4  color-relief elevation colors
  'flood-fill',           //  5  paleolake polygons
  'flood-tide',           //  6  color-relief animated tide (desktop/tour only)
  'hillshade',            //  7  hillshade — ON by default
  /* A5 (2026-08-24): each contour line now sits on a dark CASING drawn just
   * underneath it — the USGS-topo trick. Tan lines on tan Mars were nearly
   * invisible at crater scale; a casing separates the line from the terrain
   * without having to shout with color. The casings carry zero opacity in the
   * 'subtle' preset, so the default look is a line, not a line-plus-outline.
   * Additive to this frozen list: no existing id moved, so printed QR links
   * keep working (they address short keys, and `cr`/`crf` simply cover more
   * layer ids now). */
  'contour-minor-case',   //  8a casing under contour-minor
  'contour-minor',        //  8  coarse contours, level 0
  'contour-major-case',   //  9a casing under contour-major
  'contour-major',        //  9  coarse contours, level 1
  'contour-fine-minor-case', // 10a casing under contour-fine-minor
  'contour-fine-minor',   // 10  fine contours, level 0 (z>=14)
  'contour-fine-major-case', // 11a casing under contour-fine-major
  'contour-fine-major',   // 11  fine contours, level 1 (z>=14)
  'highstand-ring',       // 12  −2395 m shoreline ring
  'ellipse-line',         // 13  landing target ellipse
  'depot-fill',           // 14  Three Forks depot polygon
  'depot-line',           // 14  Three Forks depot outline
  'traverse-future',      // 15  drives after the current sol
  'traverse-done',        // 16  drives up to the current sol — ON by default
  'traverse-progress',    // 17  line-gradient reveal of the drive in progress
  'heli-path',            // 18  all flight ground tracks up to the current sol
  'heli-path-sel',        // 19  selected flight, emphasized
  'heli-ribbon',          // 20  fill-extrusion altitude ribbon
  'waypoints-dot',        // 21  end-of-drive parking spots
  'waypoints-hit',        // 22  invisible 16 px touch target for the above
  'samples-dot',          // 23  sample tubes
  'places-label',         // 24  place names (first symbol layer → wins collisions)
  'samples-label',        // 25  sample names
  'contour-label',        // 26  "−2450 m" along major contours
  'airfield-label',       // 27  Ingenuity airfields (Ingenuity mode only)
];

/** Layers that are omitted from the style entirely in lite mode (§5). */
export const LITE_OMIT_LAYERS = ['hypsometric', 'flood-tide', 'heli-ribbon'];

/* -----------------------------------------------------------------------------
 * FROZEN: URL hash short keys (docs/frontend-design.md §4.11)
 *
 * Two namespaces:
 *   1. ON_KEYS — members of the comma-separated `on=` list. Each maps a short
 *      key to the layer ids it shows/hides. A key present in `on=` means
 *      "visible"; absent means "hidden".
 *   2. SCALAR_KEYS — top-level `key=value` pairs.
 *
 * Note the deliberate quirk: `heli` exists in BOTH namespaces. In `on=heli` it
 * means "flight ground tracks visible"; as `heli=72` it means "flight 72 is
 * selected". That is how the design froze it and printed QR codes may already
 * depend on it — do not "fix" it.
 * -------------------------------------------------------------------------- */
export const HASH_KEYS = {
  ON_KEYS: {
    hs:     ['hillshade'],
    cr:     ['contour-minor-case', 'contour-minor',
             'contour-major-case', 'contour-major', 'contour-label'],
    crf:    ['contour-fine-minor-case', 'contour-fine-minor',
             'contour-fine-major-case', 'contour-fine-major'],
    hyp:    ['hypsometric'],
    fl:     ['flood-fill', 'highstand-ring'],
    wp:     ['waypoints-dot', 'waypoints-hit'],
    samp:   ['samples-dot', 'samples-label', 'depot-fill', 'depot-line'],
    places: ['places-label'],
    route:  ['traverse-future'],
    ell:    ['ellipse-line'],
    heli:   ['heli-path', 'heli-path-sel'],
    rib:    ['heli-ribbon'],
  },
  /* value type per scalar key: 'int' | 'float' | 'bool' */
  SCALAR_KEYS: {
    sol:  'int',
    exag: 'float',
    heli: 'int',
    tour: 'int',
    lite: 'bool',
    '3d': 'bool',
    /* A6 (2026-08-24): contour emphasis. `crb=1` = the Bold preset, so a
     * beauty-shot permalink reproduces the heavy contours exactly. Absent or 0
     * = Subtle, the default. Additive scalar — old links are unaffected. */
    crb:  'bool',
  },
};

/** Short keys visible by default, i.e. the default `on=` set. */
export const DEFAULT_ON = ['hs', 'cr', 'wp', 'samp', 'places'];

/* -----------------------------------------------------------------------------
 * FROZEN: map global-state property names (§4.3, §4.4)
 * One setGlobalStateProperty call drives filters AND paint across layers.
 * -------------------------------------------------------------------------- */
export const GLOBAL_STATE = {
  SOL: 'sol',       // integer sol — filters traverse/waypoints/heli-path
  FLIGHT: 'flight', // selected Ingenuity flight number — filters heli-path-sel
  VSCALE: 'vscale', // SCALE * uiExaggeration — scales the altitude ribbon
  FLOOD: 'flood',   // paleolake water level in meters (areoid)
};

/* -----------------------------------------------------------------------------
 * FROZEN: data file names (docs/frontend-design.md §2)
 * All relative to the site root. data.js loads these with Promise.allSettled;
 * any one of them may be absent without breaking the app.
 * -------------------------------------------------------------------------- */
export const DATA_FILES = {
  waypoints:       'data/waypoints.geojson',
  traverse:        'data/traverse.geojson',
  traverseLite:    'data/traverse-lite.geojson',
  heliFlights:     'data/heli-flights.json',
  heliPaths:       'data/heli-paths.geojson',
  samples:         'data/samples.geojson',
  depot:           'data/depot.geojson',
  ellipse:         'data/landing-ellipse.geojson',
  highstand:       'data/highstand-ring.geojson',
  places:          'data/places.geojson',
  snapshot:        'data/snapshot.json',
  paleolake2500:   'data/paleolake-2500.geojson',
  paleolake2450:   'data/paleolake-2450.geojson',
  paleolake2395:   'data/paleolake-2395.geojson',
  paleolake2350:   'data/paleolake-2350.geojson',
};

/** Lazily fetched per-flight altitude arrays. NN is zero-padded to 2 digits. */
export const HELI_ALT_TEMPLATE = 'data/heli-alt/flight-{NN}.json';

/** Paleolake levels in meters (areoid), shallow → deep. */
export const PALEOLAKE_LEVELS = [-2500, -2450, -2395, -2350];

/** The mapped-out highstand — where NASA found carbonates on the inner margin. */
export const HIGHSTAND_M = -2395;

/* -----------------------------------------------------------------------------
 * NASA live endpoints (§0.4 — names are case-sensitive; wrong guesses 403)
 * -------------------------------------------------------------------------- */
export const NASA = {
  BASE: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/',
  WAYPOINTS_CURRENT: 'M20_waypoints_current.json',
  HELI_CURRENT: 'm20_heli_waypoints_current.json',
  RAW_IMAGES:
    'https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json',
  RAW_IMAGES_PAGE: 'https://mars.nasa.gov/mars2020/multimedia/raw-images/',
  MMGIS_MAP: 'https://mars.nasa.gov/maps/location/?mission=M20',
  /* The API's own camera filter is silently ignored — filter client-side in
   * this order of preference and take the first four. */
  CAMERA_PREFERENCE: [
    'MCZ_LEFT', 'MCZ_RIGHT', 'NAVCAM_LEFT', 'NAVCAM_RIGHT', 'FRONT_HAZCAM_LEFT_A',
  ],
  TIMEOUT_MS: 6000,
};

/* -----------------------------------------------------------------------------
 * Palette — house dark theme plus the map-specific colors from §3
 * -------------------------------------------------------------------------- */
export const PALETTE = {
  /* house chrome (mirrored in style.css custom props) */
  bg: '#111',
  panel: '#1c1c1f',
  panel2: '#25252a',
  border: '#333',
  text: '#ddd',
  muted: '#888',
  accent: '#5ad0ff',
  danger: '#ff6060',

  /* map */
  mapBackground: '#0a0a0c',
  rover: '#ffd166',            // traverse, waypoints, rover marker
  roverStroke: '#241a06',
  heli: '#5ad0ff',             // flight paths, ribbon, Ingenuity marker
  sample: '#ff9f40',           // sample tubes, depot
  contourMinor: '#8a7a5c',
  contourMajor: '#c9b58c',
  contourLabel: '#e0d4b6',
  contourLabelHalo: '#1a1510',
  flood: '#2a6ea8',
  future: '#555555',

  /* hillshade */
  shade: '#000000',
  highlight: '#e8dccb',
  shadeAccent: '#3b2f26',

  /* labels */
  placeLabel: '#efe7d8',
  placeLabelHalo: '#14100c',
};

/** Sky block (§3) — a thin Martian dust atmosphere, fading out as you zoom in. */
export const SKY = {
  'sky-color': '#171310',
  'horizon-color': '#6d5138',
  'fog-color': '#2b211a',
  'horizon-fog-blend': 0.55,
  'sky-horizon-blend': 0.6,
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 13, 0.15, 15, 0],
};

/* -----------------------------------------------------------------------------
 * Contour thresholds — [minor, major] per zoom. major is a multiple of minor.
 * The 50 m coarse default echoes the Digistar dome convention.
 * -------------------------------------------------------------------------- */
export const CONTOURS = {
  /* A4 (2026-08-24) — DENSER. The old table was 200 m minor / 1000 m major at
   * z11, which is a catastrophe for this particular crater: the floor spans
   * only ~175 m from the landing site (−2570) to the highstand (−2395), so the
   * entire crater floor drew ONE line, sometimes none. Halved twice at the
   * crater-scale zooms, which is where the whole map is looked at. Verified in
   * the real app: no generation lag, no label thrash
   * (work/audit/c1_crater_default.png vs c3_bold_dense.png). */
  coarse: {
    8: [500, 2000], 9: [200, 1000], 10: [100, 500], 11: [50, 250],
    12: [25, 100], 13: [25, 100], 14: [25, 100], 15: [25, 100], 16: [25, 100],
  },
  /* Fine stays as designed: contours are generated from the DEM at
   * contour_maxzoom 13 (the gapless ceiling — z14+ DEM covers only the 1 m
   * HiRISE footprint), so 9.65 m/px is the posting floor and a 10 m interval is
   * already at the resolution limit. Denser here would draw noise. */
  fine:   { 13: [20, 100], 14: [10, 50], 15: [10, 50], 16: [10, 50], 17: [10, 50] },
  shared: { elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours', overzoom: 1, subsampleBelow: 100 },
};

/* -----------------------------------------------------------------------------
 * A6 (2026-08-24) — contour emphasis presets. ONE source of truth, read by
 * style.js when it builds the layers and by layers.js when the visitor flips
 * the Subtle/Bold control at runtime (setPaintProperty only — no layer churn,
 * no source rebuild, so switching is instant).
 *
 * `subtle` is the default and is a modest lift on the original palette.
 * `bold` is for photography: cream lines over a dark casing, roughly double
 * width. On the dome and in stills this is the difference between "is that a
 * contour?" and a topographic map of Jezero.
 *
 * Widths/opacities are zoom-interpolated [z10 -> z15] for coarse and
 * [z14 -> z17] for fine, matching the ranges those layers actually draw over.
 * -------------------------------------------------------------------------- */
export const CONTOUR_STYLE = {
  subtle: {
    minor:     { color: '#d8c49a', w: [0.7, 1.1], o: [0.50, 0.75] },
    major:     { color: '#f0dfb8', w: [1.3, 2.0], o: [0.65, 0.90] },
    minorCase: { color: '#20160c', w: [0.0, 0.0], o: [0.00, 0.00] },
    majorCase: { color: '#1a1208', w: [0.0, 0.0], o: [0.00, 0.00] },
    fineMinor:     { color: '#d8c49a', w: [0.5, 0.9], o: [0.70, 0.70] },
    fineMajor:     { color: '#f0dfb8', w: [1.0, 1.6], o: [0.85, 0.85] },
    fineMinorCase: { color: '#20160c', w: [0.0, 0.0], o: [0.00, 0.00] },
    fineMajorCase: { color: '#1a1208', w: [0.0, 0.0], o: [0.00, 0.00] },
    label: { color: '#e0d4b6', halo: '#1a1510', haloWidth: 1.4, size: 10 },
  },
  /* Bold is LIGHT BLUE, not cream (David, 2026-08-24: "make it a nice light
   * blue color to really pop"). Blue is the direct complement of Jezero's
   * rust-and-tan terrain, so it separates from the ground far harder than any
   * warm line can - a cream contour is fighting the same hue family as the
   * dust. The two blues carry the hierarchy: the index (major) line is the
   * paler, brighter one so it reads as the one carrying the number, with the
   * more saturated sky blue for the intermediate lines. Casings are tinted
   * blue-black rather than neutral so the pairing does not read as two
   * unrelated colors at small sizes. Kin to the house accent #5ad0ff. */
  bold: {
    minor:     { color: '#6fd3f7', w: [0.9, 1.5], o: [0.88, 0.88] },
    major:     { color: '#cdeeff', w: [1.8, 2.8], o: [1.00, 1.00] },
    minorCase: { color: '#07131c', w: [2.0, 3.4], o: [0.55, 0.55] },
    majorCase: { color: '#050e15', w: [3.2, 5.0], o: [0.72, 0.72] },
    fineMinor:     { color: '#6fd3f7', w: [0.7, 1.2], o: [0.88, 0.88] },
    fineMajor:     { color: '#cdeeff', w: [1.4, 2.2], o: [1.00, 1.00] },
    fineMinorCase: { color: '#07131c', w: [1.8, 2.8], o: [0.55, 0.55] },
    fineMajorCase: { color: '#050e15', w: [2.6, 4.0], o: [0.72, 0.72] },
    label: { color: '#e6f6ff', halo: '#04101a', haloWidth: 2.0, size: 11 },
  },
};

/** Which contour layer id takes which CONTOUR_STYLE key. Shared by style.js
 *  (build time) and layers.js (runtime switch) so the two cannot drift. */
export const CONTOUR_LAYER_STYLE_KEY = {
  'contour-minor-case': 'minorCase',
  'contour-minor': 'minor',
  'contour-major-case': 'majorCase',
  'contour-major': 'major',
  'contour-fine-minor-case': 'fineMinorCase',
  'contour-fine-minor': 'fineMinor',
  'contour-fine-major-case': 'fineMajorCase',
  'contour-fine-major': 'fineMajor',
};

/** Zoom stops the width/opacity pairs above interpolate between. */
export const CONTOUR_ZOOM_STOPS = { coarse: [10, 15], fine: [14, 17] };

/* -----------------------------------------------------------------------------
 * Camera / view defaults
 * -------------------------------------------------------------------------- */
export const VIEW = {
  MIN_ZOOM: 8,
  MAX_ZOOM: 19.5,
  MAX_PITCH_DESKTOP: 80,
  MAX_PITCH_MOBILE: 60,
  MAX_PITCH_LITE: 55,
  BOUNDS_PAD_DEG: 0.05,
  PITCH_3D: 62,
  EXAG_MIN: 1,
  EXAG_MAX: 3,
  EXAG_DEFAULT: 1.5,
  ULTRA_MINZOOM: 17.5,   // where the cross-origin z18 layer starts drawing
  /* opening view: the whole crater, flat */
  INITIAL: { center: [77.4, 18.44], zoom: 10.8, pitch: 0, bearing: 0 },
};

/** Timeline speeds — seconds for the whole mission (§4.3). */
export const SPEEDS = { slow: 120, normal: 60, fast: 30 };

/* -----------------------------------------------------------------------------
 * FROZEN-ish: named views (§4.1 "VIEWS"). Six buttons; ids are used in the
 * hash-free "jump to" API and in tour bookkeeping, so keep the ids stable.
 * Cameras derive from the verified anchors and the tour stops.
 * -------------------------------------------------------------------------- */
export const BOOKMARKS = [
  { id: 'crater',  label: 'Whole crater', center: [77.4000, 18.4400], zoom: 10.8, pitch: 0,  bearing: 0 },
  { id: 'landing', label: 'Landing',      center: [77.45089, 18.44463], zoom: 16.0, pitch: 0,  bearing: 0 },
  { id: 'delta',   label: 'Delta front',  center: [77.4030, 18.4589], zoom: 13.6, pitch: 62, bearing: 285 },
  { id: 'depot',   label: 'Three Forks',  center: [77.4079, 18.4529], zoom: 17.2, pitch: 45, bearing: 30 },
  { id: 'heli72',  label: 'Ingenuity 72', center: [77.3225, 18.4973], zoom: 16.4, pitch: 60, bearing: 250 },
  { id: 'rim',     label: 'Rim (now)',    center: [77.23287, 18.43560], zoom: 15.4, pitch: 65, bearing: 100 },
];

/* -----------------------------------------------------------------------------
 * FROZEN: the 8-stop tour (docs/frontend-design.md §4.10, verbatim).
 *
 * `layers` lists the hash ON_KEYS visible at that stop (the tour sets layer
 * state from these, so a stop's layer set is expressible as a permalink).
 * `action` names an optional behavior the owning feature module implements.
 * -------------------------------------------------------------------------- */
export const TOUR = [
  {
    id: 1,
    title: 'Seven Minutes, One Crater',
    cam: { center: [77.4509, 18.4446], zoom: 14.2, pitch: 0, bearing: 0 },
    sol: 0,
    terrain: false,
    layers: ['hs', 'ell', 'places'],
    caption:
      'On February 18, 2021, Perseverance dropped into this 45-kilometer bowl — Jezero Crater — ' +
      'and touched down right here, at a spot the team named for the writer Octavia E. Butler. ' +
      'The thin white outline is the target it had to hit.',
  },
  {
    id: 2,
    title: 'A Lake With a River Delta',
    cam: { center: [77.4030, 18.4589], zoom: 13.6, pitch: 62, bearing: 285 },
    sol: 0,
    terrain: true,
    exag: 1.5,
    layers: ['hs', 'cr', 'places'],
    caption:
      'Head west and the flat crater floor climbs into a fan of layered rock — a river delta. ' +
      'Long ago a river poured through a gap in the rim and dropped its sediment into a lake, ' +
      'building the cliffs ahead of us.',
  },
  {
    id: 3,
    title: 'Fill the Lake',
    cam: { center: [77.3800, 18.4600], zoom: 12.2, pitch: 55, bearing: 300 },
    sol: 0,
    terrain: true,
    exag: 1.5,
    layers: ['hs', 'fl', 'places'],
    action: 'flood-rise',      // flood module animates the tide up to −2395 m
    flood: HIGHSTAND_M,
    caption:
      "Raise the water to about 2,395 meters below Mars' zero elevation and the whole crater floor " +
      "disappears. The shoreline lands exactly where Perseverance found carbonate-rich rock along " +
      "the crater's inner margin — the kind of rock that forms in water.",
  },
  {
    id: 4,
    title: "Percy's 45 Kilometres",
    cam: { center: [77.3500, 18.4600], zoom: 11.6, pitch: 0, bearing: 0 },
    sol: 0,
    terrain: false,
    layers: ['hs', 'cr', 'wp', 'places'],
    action: 'play-timeline',   // timeline module plays sol 0 → now at Fast
    speed: 'fast',
    caption:
      "Every gold dot is a place the rover parked at the end of a day's drive. Watch five and a half " +
      'Earth years compress into thirty seconds — a little over 45 kilometers, every meter of it ' +
      'steered by drivers on Earth, one Martian day at a time.',
  },
  {
    id: 5,
    title: 'The Depot at Three Forks',
    cam: { center: [77.4079, 18.4529], zoom: 17.2, pitch: 45, bearing: 30 },
    sol: null,                 // null = leave the timeline where it is
    terrain: true,
    layers: ['hs', 'samp', 'wp'],
    caption:
      'In early 2023 the rover set ten sealed sample tubes on the ground here, spaced far enough apart ' +
      'that a future lander could collect them one at a time. It is the first cache of material ever ' +
      'staged on the surface of another planet.',
  },
  {
    id: 6,
    title: 'Cheyava Falls',
    cam: { center: [77.3052, 18.4975], zoom: 17.5, pitch: 50, bearing: 0 },
    sol: 1215,
    terrain: true,
    layers: ['hs', 'samp', 'wp'],
    caption:
      'In July 2024, in the old river channel that fed the lake, Perseverance drilled a rock nicknamed ' +
      'Cheyava Falls. Its leopard-like spots are the sort of chemistry microbes can leave behind — which ' +
      'is exactly why that core, Sapphire Canyon, is on the list to come home.',
  },
  {
    id: 7,
    title: "Ingenuity's Last Flight",
    cam: { center: [77.3225, 18.4973], zoom: 16.4, pitch: 60, bearing: 250 },
    sol: null,
    terrain: true,
    layers: ['hs', 'heli', 'rib'],
    action: 'heli-mode',       // ingenuity module enters heli mode, selects 72
    flight: 72,
    caption:
      'Ingenuity was built for five flights. It made seventy-two. On January 18, 2024, on a short hop ' +
      'over this sand, it clipped a rotor blade landing and never flew again — after a little over two ' +
      'hours of total airtime on another world.',
  },
  {
    id: 8,
    title: 'Up on the Rim',
    cam: { center: [77.2329, 18.4356], zoom: 15.4, pitch: 65, bearing: 100 },
    sol: 'current',            // 'current' = live sol if fetched, else snapshot
    terrain: true,
    layers: ['hs', 'cr', 'wp', 'places'],
    caption:
      'Perseverance is here now, more than six hundred meters higher than where it landed, up on the ' +
      "crater's western rim. The rock up here was shattered and lifted by the impact that dug the crater " +
      '— the oldest material the rover has ever touched.',
  },
];

/* -----------------------------------------------------------------------------
 * Attribution (§6) — also mirrored in tiles/manifest.json credits.
 * -------------------------------------------------------------------------- */
/* One line, not four: the expanded control ate ~35 % of a phone screen and
 * overlapped the scale bar (integration pass 2026-08-23). Full per-dataset
 * credits live in the About panel and per-source attribution strings. */
export const ATTRIBUTION = [
  'NASA/JPL-Caltech · UArizona/HiRISE · MSSS · ESA/DLR/FU Berlin · USGS · INTUITIVE® Planetarium',
];

/** Per-source attribution strings, attached to the style sources. */
export const SOURCE_ATTRIBUTION = {
  imagery: 'NASA/JPL-Caltech/MSSS · UArizona/HiRISE',
  imageryHi: 'NASA/JPL-Caltech/UArizona (HiRISE)',
  dem: 'HiRISE DTMs · HRSC (ESA/DLR/FU Berlin) · USGS Astrogeology',
  nasa: 'NASA/JPL-Caltech (MMGIS)',
};

/** Marker artwork, sized per §3.2. */
export const MARKERS = {
  rover:  { url: 'assets/rover.svg',  size: 28 },
  heli:   { url: 'assets/heli.svg',   size: 24 },
  sample: { url: 'assets/sample.svg', size: 20 },
};

/** Misc tunables that more than one module needs. */
export const TUNING = {
  HASH_DEBOUNCE_MS: 400,
  ELEV_THROTTLE_MS: 100,
  ELEV_CACHE_TILES: 24,
  PROBE_TIMEOUT_MS: 3000,
  TOAST_MS: 4200,
  FOLLOW_EASE_MS: 600,
  TILE_CACHE: 320,
  TILE_CACHE_LITE: 100,
};
