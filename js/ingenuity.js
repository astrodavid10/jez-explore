/* =============================================================================
 * Jez Explore — ingenuity.js
 *
 * INGENUITY mode: the sol-filtered flight list, the per-flight card (stats +
 * hand-rolled SVG altitude chart + replay), the client-built fill-extrusion
 * altitude ribbon, and the Ingenuity ground-track layer group. Implements
 * docs/frontend-design.md §4.4 against the REAL shell contracts in config.js /
 * ui.js / map.js / data.js / hash.js — those override the design doc's code
 * sketches wherever the two differ.
 *
 * Shell APIs this module consumes (nothing here edits another file):
 *   ui.js      registerPanel('INGENUITY', fn), registerAction, toast, LITE
 *   map.js     app.map, app.SCALE, app.get3D(), app.makeMarker('heli', ll)
 *   data.js    app.ensureData('heliFlights'|'heliPaths'), app.fetchHeliAltitude(n)
 *   hash.js    reads/writes happen through map.getGlobalState / setGlobalStateProperty
 *              and layer visibility — this module never touches location.hash directly
 *   config.js  GLOBAL_STATE.{SOL,FLIGHT,VSCALE}, HASH_KEYS.ON_KEYS.heli,
 *              HELI_TOTALS, HIGHSTAND_M, PALETTE, SCALE fallback
 *   style.js   pre-built sources/layers: heli-paths, heli-ribbon, heli-airfields,
 *              heli-path / heli-path-sel / heli-ribbon / airfield-label layers.
 *              heli-ribbon and its layer are OMITTED ENTIRELY in lite mode
 *              (config.js LITE_OMIT_LAYERS) — every ribbon call below is a
 *              no-op guarded by map.getLayer('heli-ribbon').
 *
 * Bus events consumed: 'sol', 'hash:sol' (current sol, for the list filter),
 *   'hash:flight' (deep-linked flight selection), 'terrain' (3D on/off, gates
 *   the ribbon checkbox), 'pause' (visibility change, pauses replay), 'data'
 *   (catches a later heli-flights.json load/refresh), 'hashstate' (A3 — re-sync
 *   heliModeOn after hash.js applies `on=heli`), 'view' (A2 — the 'heli72'
 *   VIEWS bookmark enters Ingenuity mode and selects flight 72).
 * Bus events emitted: 'flight' (so hash.js's own 'flight' subscription
 *   schedules a hash rewrite of the `heli=` scalar), 'layers' (so hash.js's
 *   'layers' subscription schedules a rewrite of the `on=` set after this
 *   module changes heli-path/heli-path-sel/heli-ribbon/airfield-label
 *   visibility). Neither hash.js nor config.js is edited to make this work —
 *   both events are already in hash.js's generic subscription list.
 *
 * registerAction('heli-mode', flightOrStop) is exposed for the not-yet-built
 * tour.js: tour stop 7 carries `action: 'heli-mode', flight: 72` (config.js
 * TOUR[6]), and runAction('heli-mode', ...) is the established pattern for a
 * tour action ('tour:start', 'data:refresh-all' already use it). app.ingenuity
 * is also exposed as a plain fallback API. This is a guess at the integration
 * seam, documented here and in the build report — nothing about it required
 * touching tour.js.
 * ========================================================================== */

import {
  GLOBAL_STATE, HASH_KEYS, HELI_TOTALS, HIGHSTAND_M, PALETTE,
  SCALE as SCALE_FALLBACK,
} from './config.js';
import { registerPanel, registerAction, toast, LITE } from './ui.js';

/* -----------------------------------------------------------------------------
 * RIBBON_MODE — spike S3 flag (design doc §4.4 / §9 S3), the ONE switch that
 * decides how the altitude ribbon's base/height are measured:
 *
 *   'terrain-relative'  (default) fill-extrusion is measured from the actual
 *      terrain surface under each quad: base 0, top = agl. This is what
 *      style.js's own static paint expression assumes (base:0,
 *      height: agl*vscale) and is the right answer if MapLibre's
 *      fill-extrusion respects terrain the way S3's 20-minute spike is meant
 *      to confirm (one quad, height 50, over a slope, terrain on/off).
 *
 *   'absolute'  fill-extrusion is measured from a flat zero plane instead
 *      (the "gotcha" S3 exists to catch): base = gnd - REF, top = gnd + agl -
 *      REF, REF = manifest.dem.elev_min. Every per-vertex `gnd` value from
 *      the heli-alt files feeds this directly — no pipeline change needed to
 *      flip it.
 *
 * Both formulas are implemented as plain per-feature `base_m` / `top_m`
 * properties computed in JS in ribbonExtent() below; the single MapLibre
 * paint expression this module installs (applyRibbonPaintExpression) is
 * IDENTICAL for both modes — `['*', ['get','base_m'], vscale]` — so flipping
 * this constant is the only change spike S3's verdict requires. See the
 * build report for what integration must eyeball to decide.
 *
 * SETTLED — integration pass, 2026-08-23. Both halves measured in the real app
 * (MapLibre GL 6.5.0), so nobody needs to re-litigate this:
 *
 *   1. fill-extrusion IS terrain-relative. A 100 m quad placed off-center over
 *      ground 20.1 m above the view center rose exactly as predicted when the
 *      exaggeration went 1 -> 3 (predicted 7.9 px, observed 8.0 px). So
 *      'terrain-relative' with base 0 is correct — keep it.
 *
 *   2. MapLibre does NOT multiply fill-extrusion heights by the terrain
 *      exaggeration. A quad with a LITERAL height of 200 rendered 128 px tall
 *      at exaggeration 1 and 130 px at exaggeration 3 (ratio 1.016), while
 *      tripling the meters instead (200 -> 600) gave 363 px (ratio 2.836).
 *      Therefore the `['*', ['get','top_m'], ['global-state','vscale']]` below
 *      does NOT double-apply: it is the ONLY thing scaling the ribbon, and
 *      removing it would leave the ribbon at true-Mars height on terrain
 *      inflated by SCALE x uiExag — i.e. sunk into the hillsides.
 *      End-to-end confirmation on flight 61 (max AGL 23.98 m), camera fixed:
 *      ribbon 100 px tall at UI 1x, 313 px at UI 3x — ratio 3.13, not 9.
 * -------------------------------------------------------------------------- */
const RIBBON_MODE = 'terrain-relative'; // | 'absolute'

/** Ribbon width in true Mars meters (design §4.4: "3 Mars meters wide"). */
const RIBBON_WIDTH_M = 3;
/** E3: floating flight-path tube — square in section, so width == 2 x half. */
const TRACK_WIDTH_M = 2.5;
const TRACK_HALF_M = 1.25;
/** Floating-heli leader quad width during replay (design §4.4: "1 m-wide"). */
const LEADER_WIDTH_M = 1;
/** Floating-heli hexagon radius during replay (not specced exactly; small). */
const HELI_HEX_RADIUS_M = 1.5;
/** Floating-heli hexagon vertical half-extent (design §4.4: "base agl-3, height agl+3"). */
const HELI_HOVER_HALF_M = 3;

const M_PER_DEG_LAT = 111320;

/* ---------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------ */
let APP = null;
let manifest = null;
let SCALE = SCALE_FALLBACK;

let currentSol = 0;
let currentFlight = 0;
let heliModeOn = false;
/** A2: a flight the 'heli72' bookmark asked for before heli-flights.json landed. */
let pendingBookmarkFlight = 0;

let flightsIndex = [];        // heli-flights.json, sorted by flight number
let flightById = new Map();

let panelBody = null;
let headerEl = null;
let listEl = null;
let cardHost = null;

let currentAlt = null;        // fetched heli-alt/flight-NN.json for the selected flight
let ribbonBaseFeatures = [];  // the static ribbon quads for the selected flight
let trackFeatures = [];       // E3: the floating flight-path quads for that flight
let chart = null;             // { setPlayhead(t|null) }

let replayPlaying = false;
let replayRate = 1;           // 1 or 4
let replayRAF = 0;
let replayLastTs = 0;
let replaySimT = 0;
let replayMarker = null;
/** F2: the PERSISTENT Ginny marker — Percy has had one since day one. */
let heliMarker = null;
/** F4: follow-helicopter, mutually exclusive with timeline.js's follow-rover. */
let followHeli = false;

/* ---------------------------------------------------------------------------
 * Small pure helpers
 * ------------------------------------------------------------------------ */
function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function extractNumber(detail, key) {
  if (detail == null) return null;
  if (typeof detail === 'number') return Number.isFinite(detail) ? detail : null;
  const v = detail[key];
  return Number.isFinite(v) ? v : null;
}

function formatDuration(s) {
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatDist(m) {
  if (!Number.isFinite(m)) return '—';
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

function formatAirtime(s) {
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** "-2398.8 m" — a real typographic minus, matching map.js's formatElevation. */
function fmtElev(m) {
  if (!Number.isFinite(m)) return '—';
  const v = Math.round(m * 10) / 10;
  return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} m`;
}

/** Whole-meter version, for round constants like HIGHSTAND_M. */
function fmtElevInt(m) {
  const v = Math.round(m);
  return `${v < 0 ? '−' : ''}${Math.abs(v)} m`;
}

/** Degrees-of-longitude per meter at a given latitude (Earth-proxy grid). */
function degLonPerM(lat) {
  return 1 / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
}

/* ---------------------------------------------------------------------------
 * Reading current shell state (map global-state is the source of truth;
 * these are only used to seed module state at init and are not polled).
 * ------------------------------------------------------------------------ */
function readGlobalState(key, fallback) {
  const map = APP && APP.map;
  if (!map || typeof map.getGlobalState !== 'function') return fallback;
  const gs = map.getGlobalState() || {};
  return Number.isFinite(gs[key]) ? gs[key] : fallback;
}

function readSol() {
  const fallback = Number.isFinite(APP.maxSol) ? APP.maxSol : (manifest.snapshot_sol || 0);
  return Math.round(readGlobalState(GLOBAL_STATE.SOL, fallback));
}

function readFlight() {
  return Math.round(readGlobalState(GLOBAL_STATE.FLIGHT, 0));
}

function layerVisible(id) {
  const map = APP.map;
  if (!map || !map.getLayer(id)) return false;
  return (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none';
}

/* ---------------------------------------------------------------------------
 * Ingenuity ground-track mode (the `heli` ON_KEYS group: heli-path +
 * heli-path-sel, plus the additive airfield-label layer). This is distinct
 * from the `heli=N` SCALAR selection — config.js's frozen quirk, not ours.
 * ------------------------------------------------------------------------ */
function setHeliModeOn(on) {
  const map = APP.map;
  if (!map) return;
  heliModeOn = !!on;
  for (const id of HASH_KEYS.ON_KEYS.heli) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', heliModeOn ? 'visible' : 'none');
  }
  if (map.getLayer('airfield-label')) {
    map.setLayoutProperty('airfield-label', 'visibility', heliModeOn ? 'visible' : 'none');
  }
  if (!heliModeOn) setRibbonVisible(false);
  updateModeButton();
  APP.emit('layers', {});
}

/**
 * The ONE owner of #ing-mode-btn's state, including `.disabled`.
 *
 * A1 (2026-08-24): it did not own `.disabled` before, and that made the button
 * permanently dead. registerPanel() builds the panel SYNCHRONOUSLY, which
 * happens in init() below BEFORE `await ensureData('heliFlights')` resolves —
 * so buildIngenuityPanel() saw an empty flightsIndex, took the "not available
 * in this build" branch and set `modeBtn.disabled = true`. Milliseconds later
 * the fetch landed and renderHeader()/renderList() repainted the panel with all
 * 72 flights, but nothing ever cleared the flag. The result looked finished —
 * correct header, full flight list — with the only control that turns the
 * layers on grayed out forever. Nothing else in this module was broken.
 *
 * Fix: `.disabled` is derived from flightsIndex here, and renderList() calls
 * this on every repaint, so the button follows the data instead of a snapshot
 * of it taken before the data existed.
 */
/* E2: there is no mode button any more. Kept as a no-op rather than deleted
 * because renderList() and setHeliModeOn() both call it on every repaint,
 * and A1 (the bug where this button stuck disabled forever) is exactly the
 * kind of regression a half-removed call site reintroduces. */
function updateModeButton() {}

/**
 * A3 (2026-08-24): re-derive heliModeOn from what the layers are ACTUALLY
 * doing. init() reads layer visibility exactly once, but hash.js applies
 * `on=heli` after every feature module has initialized — so a deep link left
 * the tracks visible while this module still believed the mode was off (button
 * reading "Enter Ingenuity mode", ribbon gated off). Subscribed to 'hashstate',
 * which hash.js emits after applying a parsed hash; this module emits 'layers',
 * never 'hashstate', so there is no feedback loop.
 */
/** A2: apply a bookmark's flight once heli-flights.json has landed. */
function drainPendingBookmarkFlight() {
  if (!pendingBookmarkFlight) return;
  const n = pendingBookmarkFlight;
  pendingBookmarkFlight = 0;
  if (flightById.has(n)) selectFlight(n);
}

function syncModeFromLayers() {
  const on = layerVisible('heli-path');
  if (on === heliModeOn) return;
  heliModeOn = on;
  updateModeButton();
}

/* ---------------------------------------------------------------------------
 * Airfields (heli-airfields source -> airfield-label layer, layer 27, style.js
 * additive addition). Built once the flight index is available: one point per
 * distinct arrival airfield, named and positioned from the flight that landed
 * there.
 * ------------------------------------------------------------------------ */
/**
 * F2 (2026-08-25, David: "Ingenuity does not have a stylized little marker like
 * Perseverance does and we should make something for it").
 *
 * The art existed — `assets/heli.svg`, and makeMarker('heli', ...) — but it was
 * only ever created as `replayMarker` during a flight replay and removed the
 * moment replay stopped. So Percy had a permanent marker on the map and Ginny
 * had one for a few seconds at a time. This gives her the same standing
 * presence: a marker at wherever she is for the current sol.
 *
 * "Where Ginny is" at sol S = the landing site of the last flight she completed
 * at or before S. Before flight 1 (sol 58) she has not flown, so the marker is
 * hidden rather than parked at 0,0 — she was folded under the rover then, and
 * showing her flying on sol 0 would be a lie.
 */
function heliPositionAtSol(sol) {
  let best = null;
  for (const f of flightsIndex) {
    if (!Number.isFinite(f.sol) || f.sol > sol) continue;
    if (!Number.isFinite(f.lon) || !Number.isFinite(f.lat)) continue;
    if (!best || f.sol > best.sol || (f.sol === best.sol && f.flight > best.flight)) best = f;
  }
  return best;
}

function updateHeliMarker() {
  if (!APP || !APP.map || typeof APP.makeMarker !== 'function') return;
  const at = heliPositionAtSol(currentSol);
  if (!at) {
    if (heliMarker) { heliMarker.remove(); heliMarker = null; }
    return;
  }
  if (!heliMarker) {
    heliMarker = APP.makeMarker('heli', [at.lon, at.lat]);
    heliMarker.addTo(APP.map);
    const el = heliMarker.getElement && heliMarker.getElement();
    if (el) el.title = `Ingenuity — after flight ${at.flight} (sol ${at.sol})`;
  } else {
    heliMarker.setLngLat([at.lon, at.lat]);
    const el = heliMarker.getElement && heliMarker.getElement();
    if (el) el.title = `Ingenuity — after flight ${at.flight} (sol ${at.sol})`;
  }
  maybeFollowHeli();
}

/**
 * F4 (2026-08-25, David: "we have a follow rover toggle but not follow
 * helicopter (these should be mutually exclusive from one another)").
 *
 * The two live in different modules, so exclusivity is arbitrated on the event
 * bus rather than by one module reaching into the other: whichever is switched
 * on emits `follow`, and the other stands down when it hears a `follow` naming
 * someone else. That keeps timeline.js and ingenuity.js independent and means a
 * third follower could be added later without touching either.
 */
function setFollowHeli(on) {
  followHeli = !!on;
  const ck = panelBody && panelBody.querySelector('#ing-follow');
  if (ck) ck.checked = followHeli;
  if (followHeli) {
    APP.emit('follow', { who: 'heli' });
    maybeFollowHeli(true);
  }
}

function maybeFollowHeli(force = false) {
  if (!followHeli || !heliMarker || !APP.map) return;
  APP.map.easeTo({ center: heliMarker.getLngLat(), duration: force ? 600 : 400, essential: true });
}

function buildAirfields() {
  const map = APP.map;
  const src = map && map.getSource('heli-airfields');
  if (!src) return;
  /* F3 (2026-08-25): carry `sol` so the airfield dots can be SOL_DONE-filtered
   * exactly like Percy's waypoints — an airfield appears when Ginny first
   * lands there, not from sol 0. Keep the EARLIEST sol per site: a field she
   * used four times should appear on the first visit, not the last. */
  const seen = new Map();
  for (const f of flightsIndex) {
    if (!f.to) continue;
    const prev = seen.get(f.to);
    if (!prev) seen.set(f.to, { coords: [f.lon, f.lat], sol: f.sol, flight: f.flight });
    else if (Number.isFinite(f.sol) && f.sol < prev.sol) {
      seen.set(f.to, { coords: [f.lon, f.lat], sol: f.sol, flight: f.flight });
    }
  }
  const features = [...seen.entries()].map(([name, v]) => ({
    type: 'Feature',
    properties: { name, sol: v.sol, flight: v.flight },
    geometry: { type: 'Point', coordinates: v.coords },
  }));
  src.setData({ type: 'FeatureCollection', features });
}

/* ---------------------------------------------------------------------------
 * Header stats — computed from heli-flights.json, never hardcoded. Falls
 * back to config.js's HELI_TOTALS only until the data arrives.
 * ------------------------------------------------------------------------ */
function computeTotals() {
  if (!flightsIndex.length) return HELI_TOTALS;
  const km = flightsIndex.reduce((s, f) => s + (f.dist_m || 0), 0) / 1000;
  const airtime_s = flightsIndex.reduce((s, f) => s + (f.dur_s || 0), 0);
  return { flights: flightsIndex.length, km, airtime_s };
}

function renderHeader() {
  if (!headerEl) return;
  const t = computeTotals();
  headerEl.textContent =
    `${t.flights} flights · ${t.km.toFixed(2)} km · ${formatAirtime(t.airtime_s)} airtime`;
}

/* ---------------------------------------------------------------------------
 * Flight list — 44 px rows, filtered by the current sol (matches the same
 * `sol <= state` comparison style.js already bakes into the heli-path filter,
 * so the panel list and the map's ground tracks always agree).
 * ------------------------------------------------------------------------ */
function renderList() {
  if (!listEl) return;
  /* A1: the button's enabled state follows the data on every repaint. This is
   * the call that un-sticks it after the async heli-flights.json load. */
  updateModeButton();
  if (!flightsIndex.length) return; // handled by the "not available" branch in init()
  const rows = flightsIndex.filter((f) => f.sol <= currentSol);
  if (!rows.length) {
    listEl.innerHTML =
      `<p class="panel-empty">No flights yet at sol ${currentSol} — Ingenuity's first ` +
      `flight was sol ${flightsIndex[0].sol}.</p>`;
    return;
  }
  listEl.innerHTML = '';
  for (const f of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'veh-row' + (f.flight === currentFlight ? ' sel' : '');
    row.innerHTML =
      `<span class="veh-num">#${String(f.flight).padStart(2, '0')}</span>` +
      `<span class="veh-mid">${f.date}</span>` +
      `<span class="veh-a num">${Math.round(f.max_alt_m)} m</span>` +
      `<span class="veh-b num">${formatDuration(f.dur_s)}</span>`;
    row.addEventListener('click', () => selectFlight(f.flight));
    listEl.appendChild(row);
  }
}

/* ---------------------------------------------------------------------------
 * fly-to (used both automatically on selection and by the [Fly to] button)
 * ------------------------------------------------------------------------ */
function flyToFlight(n) {
  const map = APP.map;
  if (!map) return;
  const paths = APP.data && APP.data.heliPaths;
  const feat = paths && Array.isArray(paths.features)
    ? paths.features.find((ft) => ft.properties && ft.properties.flight === n)
    : null;
  const coords = feat && feat.geometry && feat.geometry.type === 'LineString'
    ? feat.geometry.coordinates
    : null;
  if (coords && coords.length > 1) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    if (minLon === maxLon) { minLon -= 0.0006; maxLon += 0.0006; }
    if (minLat === maxLat) { minLat -= 0.0006; maxLat += 0.0006; }
    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 70, maxZoom: 18, duration: 900, essential: true,
    });
    return;
  }
  const f = flightById.get(n);
  if (f) map.easeTo({ center: [f.lon, f.lat], zoom: 16.4, duration: 900, essential: true });
}

/* ---------------------------------------------------------------------------
 * Ribbon geometry (design §4.4 quad construction, RIBBON_MODE-aware)
 * ------------------------------------------------------------------------ */

/**
 * @param {number} agl meters above ground
 * @param {number} gnd areoid elevation of the ground under this sample
 * @param {number} ref manifest.dem.elev_min
 * @param {boolean} [hover] true for the floating-heli hexagon (agl +/- 3 m)
 * @returns {{base_m:number, top_m:number}} true Mars meters; the paint
 *   expression this module installs multiplies both by global-state vscale.
 */
function ribbonExtent(agl, gnd, ref, hover = false) {
  const half = hover ? HELI_HOVER_HALF_M : 0;
  if (RIBBON_MODE === 'absolute') {
    return {
      base_m: gnd + (hover ? agl - half : 0) - ref,
      top_m: gnd + agl + half - ref,
    };
  }
  /* 'terrain-relative': ribbon/leader quads sit on the terrain (base 0); only
   * the hover hexagon floats around the current altitude. */
  return {
    base_m: hover ? agl - half : 0,
    top_m: agl + half,
  };
}

/** The static per-flight ribbon: one quad per consecutive sample pair. */
function buildRibbonFeatures(alt) {
  const n = alt.t.length;
  if (n < 2) return [];
  const midLat = alt.lat[Math.floor(n / 2)] ?? alt.lat[0];
  const wDeg = (RIBBON_WIDTH_M * SCALE) / (M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));
  const half = wDeg / 2;
  const ref = manifest.dem.elev_min;
  const feats = [];
  for (let i = 0; i < n - 1; i++) {
    const lon0 = alt.lon[i];
    const lat0 = alt.lat[i];
    const lon1 = alt.lon[i + 1];
    const lat1 = alt.lat[i + 1];
    if (lon0 === lon1 && lat0 === lat1) continue; // degenerate (zero-length) pair
    const midAgl = (alt.agl[i] + alt.agl[i + 1]) / 2;
    const midGnd = (alt.gnd[i] + alt.gnd[i + 1]) / 2;
    const midT = (alt.t[i] + alt.t[i + 1]) / 2;
    const ext = ribbonExtent(midAgl, midGnd, ref, false);
    feats.push({
      type: 'Feature',
      properties: { kind: 'ribbon', agl: midAgl, gnd: midGnd, t: midT, ...ext },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon0 - half, lat0], [lon1 - half, lat1],
          [lon1 + half, lat1], [lon0 + half, lat0],
          [lon0 - half, lat0],
        ]],
      },
    });
  }
  return feats;
}

/**
 * E3 (2026-08-25) — the flight path floating at its true altitude.
 *
 * David: "ingenuity in theory has 3D flight paths on the D drive somewhere...
 * let's incorporate those if possible."
 *
 * They are already here. `data/heli-alt/flight-NN.json` carries lon/lat/agl/gnd
 * for every flight, decimated to ~2 Hz by p08 from the 60 Hz IAU_MARS
 * trajectories in `D:\\05_ingenuity\\outputs\\flight_NN\\trajectory.csv`. What was
 * missing was a rendering that shows the trajectory AS a trajectory: the
 * existing `heli-ribbon` is a curtain hanging from the helicopter down to the
 * ground, which answers "how high?" but flattens the flight into a wall.
 *
 * This builds the path itself — a box-section tube centred on the altitude, so
 * a tilted camera shows the real arc of each flight hanging over the terrain.
 * Vertical half-thickness and horizontal half-width are equal, in TRUE Mars
 * metres, so the tube reads as square in section rather than as a ribbon seen
 * edge-on.
 *
 * One subtlety worth stating, because it is the same trap the ribbon hit in
 * spike S3: horizontal sizes are in DEGREES on a grid inflated by SCALE, so the
 * width is multiplied by SCALE; vertical sizes are true Mars metres and must
 * NOT be, because global-state vscale is the only thing that scales them.
 */
function buildTrackFeatures(alt) {
  const n = alt.t.length;
  if (n < 2) return [];
  const midLat = alt.lat[Math.floor(n / 2)] ?? alt.lat[0];
  const wDeg = (TRACK_WIDTH_M * SCALE) / (M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));
  const half = wDeg / 2;
  const ref = manifest.dem.elev_min;
  const feats = [];
  for (let i = 0; i < n - 1; i++) {
    const lon0 = alt.lon[i];
    const lat0 = alt.lat[i];
    const lon1 = alt.lon[i + 1];
    const lat1 = alt.lat[i + 1];
    if (lon0 === lon1 && lat0 === lat1) continue;
    const midAgl = (alt.agl[i] + alt.agl[i + 1]) / 2;
    const midGnd = (alt.gnd[i] + alt.gnd[i + 1]) / 2;
    /* Hug the altitude: base and top straddle agl by half the tube thickness.
     * ribbonExtent()'s `hover` branch already expresses exactly this shape, but
     * at the replay hexagon's 3 m half-extent; TRACK_HALF_M is the slimmer one
     * a path wants, so the arithmetic is inlined rather than adding a third
     * meaning to that function's flag. */
    const base = RIBBON_MODE === 'absolute'
      ? midGnd + midAgl - TRACK_HALF_M - ref
      : midAgl - TRACK_HALF_M;
    const top = RIBBON_MODE === 'absolute'
      ? midGnd + midAgl + TRACK_HALF_M - ref
      : midAgl + TRACK_HALF_M;
    feats.push({
      type: 'Feature',
      properties: { kind: 'track', agl: midAgl, gnd: midGnd, base_m: base, top_m: top },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon0 - half, lat0], [lon1 - half, lat1],
          [lon1 + half, lat1], [lon0 + half, lat0],
          [lon0 - half, lat0],
        ]],
      },
    });
  }
  return feats;
}

function pushTrackSource() {
  const map = APP.map;
  const src = map && map.getSource('heli-track');
  if (!src) return;
  src.setData({ type: 'FeatureCollection', features: trackFeatures });
}

function setTrack3DVisible(on) {
  const map = APP.map;
  if (!map || !map.getLayer('heli-track-3d')) return;
  map.setLayoutProperty('heli-track-3d', 'visibility', on ? 'visible' : 'none');
  if (on) pushTrackSource();
  APP.emit('layers', {});
}

/** The floating-heli hexagon + 1 m leader quad shown during replay (§4.4). */
function buildHoverFeatures(sample) {
  const ref = manifest.dem.elev_min;
  const dLon = degLonPerM(sample.lat);
  const dLat = 1 / M_PER_DEG_LAT;

  const leaderHalfM = (LEADER_WIDTH_M * SCALE) / 2;
  const lw = leaderHalfM * dLon;
  const lh = leaderHalfM * dLat;
  const leaderExt = ribbonExtent(sample.agl, sample.gnd, ref, false);
  const leader = {
    type: 'Feature',
    properties: { kind: 'leader', agl: sample.agl, gnd: sample.gnd, t: sample.t, ...leaderExt },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [sample.lon - lw, sample.lat - lh], [sample.lon + lw, sample.lat - lh],
        [sample.lon + lw, sample.lat + lh], [sample.lon - lw, sample.lat + lh],
        [sample.lon - lw, sample.lat - lh],
      ]],
    },
  };

  const hexRM = HELI_HEX_RADIUS_M * SCALE;
  const hexRLon = hexRM * dLon;
  const hexRLat = hexRM * dLat;
  const ring = [];
  for (let k = 0; k <= 6; k++) {
    const ang = (Math.PI / 3) * k;
    ring.push([sample.lon + hexRLon * Math.cos(ang), sample.lat + hexRLat * Math.sin(ang)]);
  }
  const hoverExt = ribbonExtent(sample.agl, sample.gnd, ref, true);
  const hover = {
    type: 'Feature',
    properties: { kind: 'heli', agl: sample.agl, gnd: sample.gnd, t: sample.t, ...hoverExt },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
  return [leader, hover];
}

/** The one paint expression that serves BOTH RIBBON_MODE values (see the
 * header note): base/height are always `['*', ['get', 'base_m'|'top_m'],
 * vscale]`; only the JS that fills base_m/top_m (ribbonExtent above) differs
 * by mode. A no-op in lite mode, where heli-ribbon is not in the style. */
function applyRibbonPaintExpression() {
  const map = APP.map;
  if (!map || !map.getLayer('heli-ribbon')) return;
  const vscaleExpr = ['global-state', GLOBAL_STATE.VSCALE];
  map.setPaintProperty('heli-ribbon', 'fill-extrusion-base', ['*', ['get', 'base_m'], vscaleExpr]);
  map.setPaintProperty('heli-ribbon', 'fill-extrusion-height', ['*', ['get', 'top_m'], vscaleExpr]);
}

function pushRibbonSource(extraFeatures = []) {
  const map = APP.map;
  const src = map && map.getSource('heli-ribbon');
  if (!src) return;
  src.setData({ type: 'FeatureCollection', features: ribbonBaseFeatures.concat(extraFeatures) });
}

function clearRibbonSource() {
  const map = APP.map;
  const src = map && map.getSource('heli-ribbon');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
  /* E3: the floating path is per-flight too, so it clears with the ribbon —
   * otherwise deselecting a flight leaves last flight's tube hanging in the
   * air over the new one. */
  trackFeatures = [];
  const tsrc = map && map.getSource('heli-track');
  if (tsrc) tsrc.setData({ type: 'FeatureCollection', features: [] });
}

function ribbonLayerVisible() {
  return layerVisible('heli-ribbon');
}

function setRibbonVisible(on) {
  const map = APP.map;
  if (!map || !map.getLayer('heli-ribbon')) return;
  map.setLayoutProperty('heli-ribbon', 'visibility', on ? 'visible' : 'none');
  if (on) pushRibbonSource();
  APP.emit('layers', {});
}

function updateRibbonAvailabilityUI() {
  const on3d = !!(APP.get3D && APP.get3D());
  const ck = cardHost && cardHost.querySelector('#ing-ribbon-toggle');
  if (ck && !on3d && ck.checked) {
    ck.checked = false;
    setRibbonVisible(false);
  }
  /* E3: turning 3D off must drop the floating path too, or it collapses onto
   * the ground plane and reads as a stray magenta smear across the terrain. */
  const tk = cardHost && cardHost.querySelector('#ing-track-toggle');
  if (tk && !on3d && tk.checked) {
    tk.checked = false;
    setTrack3DVisible(false);
  }
}

/* ---------------------------------------------------------------------------
 * Altitude interpolation, shared by the chart playhead, the replay loop and
 * the drag-to-scrub handler.
 * ------------------------------------------------------------------------ */
function interpSample(alt, t) {
  const ts = alt.t;
  const n = ts.length;
  const tc = clampNum(t, ts[0], ts[n - 1]);
  let i = 0;
  while (i < n - 2 && ts[i + 1] < tc) i += 1;
  const t0 = ts[i];
  const t1 = ts[i + 1];
  const span = t1 - t0;
  const f = span > 0 ? (tc - t0) / span : 0;
  const lerp = (a, b) => a + (b - a) * f;
  return {
    lon: lerp(alt.lon[i], alt.lon[i + 1]),
    lat: lerp(alt.lat[i], alt.lat[i + 1]),
    agl: lerp(alt.agl[i], alt.agl[i + 1]),
    gnd: lerp(alt.gnd[i], alt.gnd[i + 1]),
    t: tc,
  };
}

/* ---------------------------------------------------------------------------
 * Inline SVG altitude chart (~280x72, hand-rolled per design §1.1 — no chart
 * library). Drag-to-scrub and tap-to-seek both funnel through replaySeek().
 * ------------------------------------------------------------------------ */
function buildChart(host, alt) {
  const W = 280;
  const H = 72;
  const padL = 4;
  const padR = 4;
  const padT = 6;
  const padB = 6;
  const n = alt.t.length;
  const tMax = alt.t[n - 1] || 1;
  const aglMax = Math.max(1, ...alt.agl);
  const xAt = (t) => padL + (t / tMax) * (W - padL - padR);
  const yAt = (a) => H - padB - (a / aglMax) * (H - padT - padB);

  let line = '';
  for (let i = 0; i < n; i++) {
    line += `${i === 0 ? 'M' : 'L'}${xAt(alt.t[i]).toFixed(1)},${yAt(alt.agl[i]).toFixed(1)} `;
  }
  const area = `${line}L${xAt(tMax).toFixed(1)},${(H - padB).toFixed(1)} ` +
    `L${xAt(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;

  const svgns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('class', 'ing-chart');
  svg.innerHTML =
    `<path d="${area}" fill="rgba(181,123,255,0.20)" stroke="none"></path>` +
    `<path d="${line}" fill="none" stroke="${PALETTE.heli}" stroke-width="1.4"></path>` +
    `<line id="ing-playhead" x1="0" y1="${padT}" x2="0" y2="${H - padB}" ` +
    `stroke="#fff" stroke-width="1" stroke-dasharray="2,2" opacity="0"></line>` +
    `<circle id="ing-playdot" r="3" fill="#fff" opacity="0"></circle>` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="ing-chart-hit"></rect>`;
  host.innerHTML = '';
  host.appendChild(svg);

  const playhead = svg.querySelector('#ing-playhead');
  const playdot = svg.querySelector('#ing-playdot');
  const hit = svg.querySelector('.ing-chart-hit');

  function setPlayhead(t) {
    if (t === null || t === undefined) {
      playhead.setAttribute('opacity', '0');
      playdot.setAttribute('opacity', '0');
      return;
    }
    const sample = interpSample(alt, t);
    const x = xAt(sample.t);
    playhead.setAttribute('x1', x.toFixed(1));
    playhead.setAttribute('x2', x.toFixed(1));
    playhead.setAttribute('opacity', '0.85');
    playdot.setAttribute('cx', x.toFixed(1));
    playdot.setAttribute('cy', yAt(sample.agl).toFixed(1));
    playdot.setAttribute('opacity', '1');
  }

  function tFromEvent(e) {
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
    const px = clampNum(clientX - rect.left, 0, rect.width);
    return (px / rect.width) * tMax;
  }

  let dragging = false;
  hit.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { hit.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    replaySeek(tFromEvent(e));
  });
  hit.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    replaySeek(tFromEvent(e));
  });
  const endDrag = () => { dragging = false; };
  hit.addEventListener('pointerup', endDrag);
  hit.addEventListener('pointercancel', endDrag);

  return { setPlayhead, tMax };
}

/* ---------------------------------------------------------------------------
 * Replay (real-time, with a 4x toggle). Moves the DOM heli marker and the
 * chart playhead unconditionally; only pushes the floating-heli hexagon +
 * leader quad into heli-ribbon when 3D is on AND the ribbon is visible
 * (pushing them while the layer is hidden would just be wasted setData calls).
 * ------------------------------------------------------------------------ */
function applySeek(t) {
  if (!currentAlt) return;
  const sample = interpSample(currentAlt, t);
  if (!replayMarker) {
    replayMarker = APP.makeMarker('heli', [sample.lon, sample.lat]);
    replayMarker.addTo(APP.map);
  } else {
    replayMarker.setLngLat([sample.lon, sample.lat]);
  }
  if (chart) chart.setPlayhead(t);
  if (APP.get3D && APP.get3D() && ribbonLayerVisible()) {
    pushRibbonSource(buildHoverFeatures(sample));
  }
}

function updateReplayButton() {
  const btn = cardHost && cardHost.querySelector('#ing-replay');
  if (!btn || !currentAlt) return;
  btn.textContent = replayPlaying ? '⏸ Pause' : '▶ Replay';
}

function tickReplay(now) {
  if (!replayPlaying || !currentAlt) return;
  const dt = replayLastTs ? (now - replayLastTs) / 1000 : 0;
  replayLastTs = now;
  const tMax = currentAlt.t[currentAlt.t.length - 1];
  replaySimT += dt * replayRate;
  if (replaySimT >= tMax) {
    applySeek(tMax);
    pauseReplay();
    return;
  }
  applySeek(replaySimT);
  replayRAF = requestAnimationFrame(tickReplay);
}

function startReplay() {
  if (!currentAlt) return;
  const tMax = currentAlt.t[currentAlt.t.length - 1];
  if (replaySimT >= tMax) replaySimT = 0;
  replayPlaying = true;
  replayLastTs = 0;
  updateReplayButton();
  replayRAF = requestAnimationFrame(tickReplay);
}

function pauseReplay() {
  replayPlaying = false;
  if (replayRAF) cancelAnimationFrame(replayRAF);
  replayRAF = 0;
  updateReplayButton();
}

function stopReplay() {
  pauseReplay();
  replaySimT = 0;
  if (replayMarker) { replayMarker.remove(); replayMarker = null; }
  if (chart) chart.setPlayhead(null);
  pushRibbonSource(); // strip any hover features, keep the static ribbon
}

/** Drag-to-scrub / tap-to-seek on the chart: always pauses playback. */
function replaySeek(t) {
  if (!currentAlt) return;
  replaySimT = clampNum(t, 0, currentAlt.t[currentAlt.t.length - 1]);
  if (replayPlaying) pauseReplay();
  applySeek(replaySimT);
}

/* ---------------------------------------------------------------------------
 * Flight card
 * ------------------------------------------------------------------------ */
async function fetchAndBuildChart(f) {
  const chartHost = cardHost.querySelector('#ing-chart-host');
  const replayBtn = cardHost.querySelector('#ing-replay');
  if (chartHost) chartHost.innerHTML = '<p class="hint">Loading altitude profile…</p>';

  const alt = await APP.fetchHeliAltitude(f.flight);
  if (currentFlight !== f.flight) return; // a different flight was picked meanwhile

  if (!alt || !Array.isArray(alt.t) || alt.t.length < 2) {
    if (chartHost) chartHost.innerHTML = '<p class="hint">Altitude profile unavailable for this flight.</p>';
    if (replayBtn) { replayBtn.disabled = true; replayBtn.textContent = 'Replay unavailable'; }
    currentAlt = null;
    ribbonBaseFeatures = [];
    clearRibbonSource();
    return;
  }

  currentAlt = alt;
  chart = chartHost ? buildChart(chartHost, alt) : null;
  ribbonBaseFeatures = buildRibbonFeatures(alt);
  if (ribbonLayerVisible()) pushRibbonSource();
  /* E3: the floating path is built from the same samples in the same pass —
   * it costs one extra loop over ~114 points and guarantees the tube and the
   * ribbon can never describe different flights. */
  trackFeatures = buildTrackFeatures(alt);
  if (layerVisible('heli-track-3d')) pushTrackSource();
  if (replayBtn) { replayBtn.disabled = false; replayBtn.textContent = '▶ Replay'; }
}

function wireCardControls(f) {
  const replayBtn = cardHost.querySelector('#ing-replay');
  const rateBtn = cardHost.querySelector('#ing-rate');
  const flyBtn = cardHost.querySelector('#ing-flyto');
  const ribbonCk = cardHost.querySelector('#ing-ribbon-toggle');
  const ribbonWrap = cardHost.querySelector('#ing-ribbon-wrap');
  const liteNote = cardHost.querySelector('#ing-lite-note-card');

  if (replayBtn) {
    replayBtn.disabled = true;
    replayBtn.textContent = 'Loading…';
    replayBtn.addEventListener('click', () => {
      if (!currentAlt) return;
      if (replayPlaying) pauseReplay(); else startReplay();
    });
  }

  if (rateBtn) {
    rateBtn.textContent = replayRate === 4 ? '4x' : '1x';
    rateBtn.setAttribute('aria-pressed', String(replayRate === 4));
    rateBtn.addEventListener('click', () => {
      replayRate = replayRate === 4 ? 1 : 4;
      rateBtn.textContent = replayRate === 4 ? '4x' : '1x';
      rateBtn.setAttribute('aria-pressed', String(replayRate === 4));
    });
  }

  if (flyBtn) flyBtn.addEventListener('click', () => flyToFlight(f.flight));

  if (LITE) {
    if (ribbonWrap) ribbonWrap.hidden = true;
    if (liteNote) liteNote.hidden = false;
  } else if (ribbonCk) {
    const map = APP.map;
    if (!map || !map.getLayer('heli-ribbon')) {
      ribbonCk.disabled = true;
      if (ribbonWrap) ribbonWrap.title = 'Altitude ribbon unavailable in this build.';
    } else {
      ribbonCk.checked = ribbonLayerVisible();
      ribbonCk.addEventListener('change', () => {
        if (ribbonCk.checked && !(APP.get3D && APP.get3D())) {
          ribbonCk.checked = false;
          toast('Turn on 3D to see the altitude ribbon.', { kind: 'warn' });
          return;
        }
        setRibbonVisible(ribbonCk.checked);
      });
    }
  }

  /* E3 — the floating flight path. Same shape as the ribbon control above,
   * including the "turn on 3D first" guard: a fill-extrusion with no terrain
   * under it draws flat on the ground plane and looks like a bug rather than a
   * flight. Wired separately rather than folded into the ribbon's handler so
   * either can be shown without the other — the ribbon answers "how high", the
   * path answers "what shape", and they are legitimately useful apart. */
  const trackCk = cardHost.querySelector('#ing-track-toggle');
  const trackWrap = cardHost.querySelector('#ing-track-wrap');
  if (trackCk) {
    if (!APP.map || !APP.map.getLayer('heli-track-3d')) {
      trackCk.disabled = true;
      if (trackWrap) trackWrap.title = '3D flight path unavailable in this build.';
    } else {
      trackCk.checked = layerVisible('heli-track-3d');
      trackCk.addEventListener('change', () => {
        if (trackCk.checked && !(APP.get3D && APP.get3D())) {
          trackCk.checked = false;
          toast('Turn on 3D to see the flight path at altitude.', { kind: 'warn' });
          return;
        }
        setTrack3DVisible(trackCk.checked);
      });
    }
  }
}

function renderCard() {
  if (!cardHost) return;
  if (!currentFlight) {
    cardHost.hidden = true;
    cardHost.innerHTML = '';
    return;
  }
  const f = flightById.get(currentFlight);
  if (!f) {
    cardHost.hidden = false;
    cardHost.innerHTML = '<p class="panel-empty">Flight data unavailable.</p>';
    return;
  }
  cardHost.hidden = false;

  const note = f.flight === 72
    ? `<p class="hint">Landed at ${fmtElev(f.elev)} — on the ${fmtElevInt(HIGHSTAND_M)} ` +
      'ancient shoreline, the paleolake highstand where Perseverance found carbonate-rich rock.</p>'
    : '';

  cardHost.innerHTML =
    `<h3>Flight ${f.flight} <span class="hint">· sol ${f.sol} · ${f.date}</span></h3>` +
    '<div class="row tight">' +
    `<span>${formatDist(f.dist_m)}</span><span class="hint">dist</span>` +
    '<span class="spacer"></span>' +
    `<span>${Math.round(f.max_alt_m)} m</span><span class="hint">max AGL</span>` +
    '<span class="spacer"></span>' +
    `<span>${formatDuration(f.dur_s)}</span><span class="hint">duration</span>` +
    '</div>' +
    `<p class="hint">${f.from} -&gt; ${f.to}</p>` +
    '<div id="ing-chart-host"></div>' +
    note +
    '<div class="row">' +
    '<button type="button" class="btn" id="ing-replay">Loading…</button>' +
    '<button type="button" class="btn" id="ing-rate" aria-pressed="false">1x</button>' +
    '<button type="button" class="btn" id="ing-flyto">Fly to</button>' +
    '</div>' +
    `<label class="toggle" id="ing-ribbon-wrap"${LITE ? ' hidden' : ''}>` +
    '<input type="checkbox" id="ing-ribbon-toggle" />Show 3D altitude ribbon</label>' +
    /* E3: the flight path itself, at altitude. Listed after the ribbon
     * because the ribbon is the established control and this is the new
     * one; both are lite-omitted for the same reason (fill-extrusion). */
    `<label class="toggle" id="ing-track-wrap"${LITE ? ' hidden' : ''}>` +
    '<input type="checkbox" id="ing-track-toggle" />Show 3D flight path</label>' +
    `<p class="hint" id="ing-lite-note-card"${LITE ? '' : ' hidden'}>` +
    'Lite mode: the 3D altitude ribbon is off — ground track and chart only.</p>';

  wireCardControls(f);
  fetchAndBuildChart(f);
}

/* ---------------------------------------------------------------------------
 * Selecting a flight
 * ------------------------------------------------------------------------ */
function selectFlight(n, opts = {}) {
  const f = flightById.get(n);
  if (!f) {
    toast(`Flight ${n} is not in the index.`, { kind: 'warn' });
    return;
  }
  stopReplay();
  currentFlight = n;
  currentAlt = null;
  ribbonBaseFeatures = [];
  clearRibbonSource();

  if (!opts.fromHash) {
    if (!heliModeOn) setHeliModeOn(true);
    if (APP.map) APP.map.setGlobalStateProperty(GLOBAL_STATE.FLIGHT, n);
    APP.emit('flight', { flight: n });
  }

  renderList();
  renderCard();
  flyToFlight(n);
}

/* ---------------------------------------------------------------------------
 * Panel
 * ------------------------------------------------------------------------ */
/**
 * E2 (2026-08-25): the "Enter / Exit Ingenuity mode" button is GONE.
 *
 * David: the two vehicles "are almost treated like different modes... they
 * should both be treated in the same way in the menu." A mode you enter was
 * the single biggest expression of that asymmetry — Percy never had one, and
 * nothing about a helicopter requires the map to change modes to draw its
 * path. Her tracks are ordinary layers now: on by default, toggled from Map
 * beside Percy's, and the panel is purely a list + card like his.
 *
 * `setHeliModeOn` survives as the implementation of the `heli-mode` action and
 * the `on=heli` hash key, which printed QR codes and tour stop 7 both call. It
 * is no longer reachable from the UI, and nothing calls it to turn Ginny OFF.
 */
function buildIngenuityPanel(body) {
  panelBody = body;
  body.innerHTML =
    '<p class="veh-header" id="ing-header">Loading Ingenuity flight index…</p>' +
    `<p class="hint" id="ing-lite-note"${LITE ? '' : ' hidden'}>` +
    'Lite mode: ground track and chart only — the 3D altitude ribbon is off.</p>' +
    /* F4: Ginny's half of the follow pair, placed exactly where Percy's sits
     * in his panel so the two vehicles keep reading as peers. */
    '<label class="toggle">' +
    '<input type="checkbox" id="ing-follow" /> Follow helicopter</label>' +
    '<div class="ing-card" id="ing-card" hidden></div>' +
    '<div class="veh-list" id="ing-list"><p class="panel-empty">Loading…</p></div>';

  headerEl = body.querySelector('#ing-header');
  listEl = body.querySelector('#ing-list');
  cardHost = body.querySelector('#ing-card');

  const followCk = body.querySelector('#ing-follow');
  if (followCk) {
    followCk.checked = followHeli;
    followCk.addEventListener('change', () => setFollowHeli(followCk.checked));
  }

  if (flightsIndex.length) {
    renderHeader();
    renderList();
    if (currentFlight) renderCard();
  } else {
    listEl.innerHTML = '<p class="panel-empty">Ingenuity flight data is not available in this build.</p>';
  }
}

/* ---------------------------------------------------------------------------
 * Scoped stylesheet — injected once. Reuses the shell's house classes
 * (.row .btn .hint .toggle .spacer .num .panel-empty) wherever they already
 * fit; only the flight-list rows and the chart need bespoke rules.
 * ------------------------------------------------------------------------ */
function injectStyle() {
  if (document.getElementById('ingenuity-style')) return;
  const style = document.createElement('style');
  style.id = 'ingenuity-style';
  style.textContent = `
    .ing-header { margin: 2px 0 10px; font-size: 12.5px; }
    .ing-list {
      max-height: 260px;
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      border: 1px solid var(--border, #333);
      border-radius: var(--radius, 4px);
      margin-bottom: 10px;
    }
    .ing-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 44px;
      padding: 0 8px;
      background: none;
      border: 0;
      border-bottom: 1px solid var(--border, #333);
      color: var(--text, #ddd);
      font: inherit;
      text-align: left;
      cursor: pointer;
      touch-action: manipulation;
    }
    .ing-row:last-child { border-bottom: 0; }
    .ing-row:hover, .ing-row.sel { background: var(--panel2, #25252a); }
    /* E6: the panel agrees with the map — these were --accent (chrome cyan),
       which no longer matches the turquoise Ginny is drawn in. */
    .ing-row.sel { color: #fff; box-shadow: inset 2px 0 0 var(--heli, #b57bff); }
    .ing-num { flex: 0 0 34px; color: var(--heli, #b57bff); font-weight: 600; }
    .ing-sol { flex: 0 0 56px; color: var(--muted, #888); }
    .ing-date { flex: 1 1 auto; color: var(--muted, #888); font-size: 11px; }
    .ing-alt, .ing-dur { flex: 0 0 auto; font-size: 11.5px; }
    .ing-card { padding-top: 6px; border-top: 1px solid var(--border, #333); }
    .ing-card[hidden] { display: none; }
    .ing-card h3 { font-size: 14px; margin: 4px 0 6px; }
    .ing-chart {
      display: block;
      width: 100%;
      height: auto;
      margin: 6px 0;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 3px;
    }
    .ing-chart-hit { cursor: crosshair; touch-action: none; }
  `;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
 * init(app) — called once by ui.js's loadFeatureModules, after 'ready'
 * (map, hash and the core data set already exist by this point).
 * ------------------------------------------------------------------------ */
export async function init(app) {
  APP = app;
  manifest = app.manifest;
  SCALE = app.SCALE || manifest.body.scale || SCALE_FALLBACK;

  injectStyle();

  currentSol = readSol();
  currentFlight = readFlight();
  heliModeOn = layerVisible('heli-path');

  applyRibbonPaintExpression();

  APP.on('sol', (d) => {
    const sol = extractNumber(d, 'sol');
    if (sol !== null) { currentSol = Math.round(sol); renderList(); updateHeliMarker(); }
  });
  APP.on('hash:sol', (d) => {
    const sol = extractNumber(d, 'sol');
    if (sol !== null) { currentSol = Math.round(sol); renderList(); updateHeliMarker(); }
  });
  /* F4: stand down when somebody else claims the camera. */
  APP.on('follow', (d) => {
    if (d && d.who && d.who !== 'heli' && followHeli) {
      followHeli = false;
      const ck = panelBody && panelBody.querySelector('#ing-follow');
      if (ck) ck.checked = false;
    }
  });
  APP.on('hash:flight', (d) => {
    const flight = extractNumber(d, 'flight');
    if (flight !== null && flight > 0) selectFlight(Math.round(flight), { fromHash: true });
  });
  APP.on('terrain', () => updateRibbonAvailabilityUI());
  APP.on('pause', () => { if (replayPlaying) pauseReplay(); });

  /* A3 — a deep link (`#on=heli`) turns the layers on behind this module's
   * back. Re-derive the flag once the hash has been applied. */
  APP.on('hashstate', () => syncModeFromLayers());

  /* A2 (2026-08-24) — the "Ingenuity 72" VIEWS button flew the camera to the
   * flight-72 site and left heli-path at visibility:none, so the most obvious
   * way into Ingenuity showed the visitor nothing at all. views.js already
   * emits 'view' with the bookmark id after every jump (config.js BOOKMARKS
   * id 'heli72'), so this module can own the behavior without views.js or
   * config.js being touched — same seam as the tour's 'heli-mode' action. */
  APP.on('view', (d) => {
    if (!d || d.id !== 'heli72') return;
    setHeliModeOn(true);
    if (flightById.has(72)) selectFlight(72);
    else pendingBookmarkFlight = 72;   // data still in flight; init() picks it up
  });
  APP.on('data', (d) => {
    if (!d || d.key !== 'heliFlights' || !d.ok || !Array.isArray(d.data)) return;
    flightsIndex = d.data.slice().sort((a, b) => a.flight - b.flight);
    flightById = new Map(flightsIndex.map((f) => [f.flight, f]));
    buildAirfields();
    renderHeader();
    renderList();
    updateHeliMarker();
    drainPendingBookmarkFlight();
  });

  registerPanel('GINNY', buildIngenuityPanel);

  const data = await APP.ensureData('heliFlights');
  if (Array.isArray(data) && data.length) {
    flightsIndex = data.slice().sort((a, b) => a.flight - b.flight);
    flightById = new Map(flightsIndex.map((f) => [f.flight, f]));
    buildAirfields();
    renderHeader();
    renderList();
    updateHeliMarker();
    if (currentFlight && flightById.has(currentFlight)) {
      selectFlight(currentFlight, { fromHash: true });
    }
    drainPendingBookmarkFlight();
  } else if (listEl) {
    listEl.innerHTML = '<p class="panel-empty">Ingenuity flight data is not available in this build.</p>';
    if (headerEl) headerEl.textContent = 'Ingenuity flight data is not available in this build.';
  }

  /* heli-paths.geojson is used lazily by flyToFlight()'s bounds fit; kick the
   * fetch off now so it is usually ready by the time a flight is picked. */
  APP.ensureData('heliPaths');

  /* Bridge for tour.js (not yet built): tour stop 7 carries
   * `action: 'heli-mode', flight: 72` (config.js). Accepts either a bare
   * flight number or a stop-shaped object with a `.flight` field. */
  registerAction('heli-mode', (arg) => {
    const flightNum = typeof arg === 'number' ? arg
      : (arg && Number.isFinite(arg.flight) ? arg.flight : null);
    setHeliModeOn(true);
    if (Number.isFinite(flightNum)) selectFlight(flightNum);
  });

  app.ingenuity = {
    enterMode: () => setHeliModeOn(true),
    exitMode: () => setHeliModeOn(false),
    isModeOn: () => heliModeOn,
    selectFlight: (n) => selectFlight(n),
  };
}
