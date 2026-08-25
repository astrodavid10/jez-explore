/* =============================================================================
 * Jezero Explorer — timeline.js
 *
 * The mission TIMELINE: sol slider, play/pause, speed, "Follow rover" and
 * "Where is Percy now?" (docs/frontend-design.md §4.3, §4.9). This is the ONLY
 * file this module owns — everything below reads the shell's real, frozen
 * exports (config.js, ui.js, data.js, map.js, hash.js) rather than the design
 * doc's illustrative sketches.
 *
 * Hybrid render mechanism (§4.3), exactly as shipped in style.js:
 *   - `traverse` (persistent) and `traverse-active` (one feature, lineMetrics)
 *     are both GeoJSON sources built by style.js. `traverse.geojson` has one
 *     Feature per sol: the drive that ARRIVES at that sol. So the "drive in
 *     progress" while scrubbing between integer sol s and s+1 is exactly the
 *     traverse feature whose properties.sol === s+1.
 *   - On an integer sol change: map.setGlobalStateProperty('sol', s) (drives
 *     the frozen SOL_DONE/SOL_FUTURE filters on traverse-done/-future,
 *     waypoints-dot/-hit, heli-path in one call — see style.js), plus
 *     traverse-active.setData() with that one in-progress-drive feature (or
 *     empty on a rest day / at the very end).
 *   - Every frame in between: setPaintProperty('traverse-progress',
 *     'line-gradient', step(...)) reveals the active drive by fraction, and
 *     the rover marker is lerped along its real vertex-to-vertex distances.
 *   - The rAF loop only runs while actually playing; it is started/stopped by
 *     Play/Pause and is paused/resumed by the shell's 'pause'/'resume' bus
 *     events (visibilitychange), never running idle while scrubbing by hand.
 *
 * Shell APIs consumed (contracts read 1:1 off disk, see file header for each):
 *   config.js  GLOBAL_STATE.SOL, SPEEDS, LANDING, SNAPSHOT, PALETTE, TUNING
 *   ui.js      registerPanel, registerAction, toast, LITE (live binding)
 *   map.js     app.map, app.makeMarker, app.marsMetres, app.elevAt,
 *              app.formatElevation (already returns the exact
 *              "-2,481 m · +89 m above the landing site" string this panel
 *              needs — reused rather than re-derived, so it can never drift)
 *   data.js    app.fetchCurrentPosition() (§4.9 — already emits the 'badge'
 *              and 'toast' bus events on both success and failure, so this
 *              module only has to handle the map-side effects of success)
 *   hash.js    reads the sol already applied to global-state at load (hash.js
 *              runs before any feature module); writes back by emitting the
 *              bus event 'sol', which hash.js's initHash() already listens
 *              for and debounces (TUNING.HASH_DEBOUNCE_MS)
 *
 * Extension points for later modules (tour.js hasn't landed yet):
 *   registerAction('play-timeline', ({speed}) => ...)  — TOUR stop 4's action
 *   registerAction('timeline:goto', (sol) => ...)      — any stop with a
 *                                                         plain `sol` field
 * ========================================================================== */

import {
  GLOBAL_STATE, SPEEDS, LANDING, SNAPSHOT, PALETTE, TUNING,
} from './config.js';
import { registerPanel, registerAction, toast, LITE } from './ui.js';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

/* ---------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------ */
let APP = null;
let MAP = null;
let roverMarker = null;

/** DOM refs, filled once the panel (and the landscape pill) are built. */
const elements = {};

/** sol -> { coordinates:[[lon,lat],...], len_m, date, live? } */
let traverseBySol = new Map();
/** Ascending by sol: { sol, lon, lat, elev, km, date, live? }. Always seeded
 *  with a sol-0 landing entry so sol 0 renders correctly even before the
 *  pipeline's first real waypoint (which starts at sol 13). */
let waypointsSorted = [];

let traverseMissing = false;
let waypointsMissing = false;

let lastLiveSol = null;   // sol key of the synthetic "since snapshot" drive, if any

const state = {
  sol: 0,          // float — current scrub position
  playing: false,
  speedSec: SPEEDS.normal,
  follow: false,
};

let lastIntSol = -1;      // sentinel so the first applyIntegerSol() always runs
let rafId = null;
let lastFrameTime = 0;
let lastProcessedTime = 0;
let lastFollowTime = 0;

/* ---------------------------------------------------------------------------
 * Component-scoped styles. We do not edit style.css; a small injected <style>
 * covers the one thing the house classes don't give us (a big tabular-numeral
 * SOL readout) and one mobile-peek space saver.
 * ------------------------------------------------------------------------ */
function ensureStyle() {
  if (document.getElementById('tl-style')) return;
  const style = document.createElement('style');
  style.id = 'tl-style';
  style.textContent = `
    #tl-sol { font-size: 28px; font-weight: 700; color: #fff; line-height: 1.15; }
    #tl-date { margin: 1px 0 6px; }
    .tl-elev-line { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin: 0 0 6px; }
    #tl-note { margin: 2px 0 8px; }
    #tl-speed { margin-top: 2px; }
    #sol-pill .num { font-size: 15px; font-weight: 600; }
    #sol-pill input[type="range"] { width: 130px; height: 32px; }
    #sol-pill button { min-width: 32px; min-height: 32px; padding: 0; }
    /* PEEK (128 px) is a hard pixel clip (#panels{overflow:hidden}), not a
     * scroll area — drop the elevation line there so SOL + date + km + the
     * slider itself stay inside the visible band (§4.2). */
    @media (max-width: 899px) and (min-height: 501px) {
      body[data-detent="peek"] .tl-elev-line { display: none; }
    }
  `;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
 * Data indexing (§2 shapes: traverse one-Feature-per-sol props sol/len_m/date;
 * waypoints props sol/rmc/km/elev/date). Null-safe: a missing/failed dataset
 * just yields an empty index, never a throw (§7).
 * ------------------------------------------------------------------------ */
function buildTraverseIndex(fc) {
  const map = new Map();
  const feats = fc && Array.isArray(fc.features) ? fc.features : [];
  for (const f of feats) {
    const sol = Number(f?.properties?.sol);
    const coords = f?.geometry?.coordinates;
    if (!Number.isFinite(sol) || !Array.isArray(coords) || coords.length < 2) continue;
    map.set(sol, {
      coordinates: coords,
      len_m: Number(f.properties.len_m) || 0,
      date: f.properties.date || null,
    });
  }
  return map;
}

function buildWaypointsIndex(fc) {
  const feats = fc && Array.isArray(fc.features) ? fc.features : [];
  const list = feats
    .map((f) => ({
      sol: Number(f?.properties?.sol),
      lon: f?.geometry?.coordinates?.[0],
      lat: f?.geometry?.coordinates?.[1],
      elev: Number.isFinite(f?.properties?.elev) ? f.properties.elev : null,
      km: Number.isFinite(f?.properties?.km) ? f.properties.km : null,
      date: f?.properties?.date || null,
    }))
    .filter((w) => Number.isFinite(w.sol) && Number.isFinite(w.lon) && Number.isFinite(w.lat))
    .sort((a, b) => a.sol - b.sol);

  /* Edge case (§8): sol 0 has no waypoint of its own (the real data starts at
   * sol 13) but must still render as "landing marker only, 0.00 km". */
  if (!list.length || list[0].sol > LANDING.sol) {
    list.unshift({
      sol: LANDING.sol, lon: LANDING.lon, lat: LANDING.lat,
      elev: LANDING.elev, km: 0, date: LANDING.date,
    });
  }
  return list;
}

/** Last known waypoint at or before `sol` (binary search; ascending array). */
function findWaypointAtOrBefore(sol) {
  const arr = waypointsSorted;
  if (!arr.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].sol <= sol) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return arr[ans];
}

/** Real-distance lerp along a LineString's own vertices (ratio is
 *  SCALE-independent — the inflation cancels out of a fraction of total
 *  length), so the rover marker actually rides the drawn route. */
function lerpAlongLine(coords, frac) {
  if (!Array.isArray(coords) || !coords.length) return null;
  if (coords.length === 1 || !APP?.maplibregl) return coords[0];
  const LngLat = APP.maplibregl.LngLat;
  const segLens = [];
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = LngLat.convert(coords[i]).distanceTo(LngLat.convert(coords[i + 1]));
    segLens.push(d);
    total += d;
  }
  if (!(total > 0)) return coords[coords.length - 1];
  const target = clamp01(frac) * total;
  let acc = 0;
  for (let i = 0; i < segLens.length; i++) {
    const next = acc + segLens[i];
    if (next >= target || i === segLens.length - 1) {
      const segFrac = segLens[i] > 0 ? (target - acc) / segLens[i] : 0;
      const [lon0, lat0] = coords[i];
      const [lon1, lat1] = coords[i + 1];
      return [lon0 + (lon1 - lon0) * segFrac, lat0 + (lat1 - lat0) * segFrac];
    }
    acc = next;
  }
  return coords[coords.length - 1];
}

function computeRoverPosition(s, frac) {
  if (frac > 0) {
    const drive = traverseBySol.get(s + 1);
    if (drive) {
      const pos = lerpAlongLine(drive.coordinates, frac);
      if (pos) return pos;
    }
  }
  const wp = findWaypointAtOrBefore(s);
  return wp ? [wp.lon, wp.lat] : null;
}

/* ---------------------------------------------------------------------------
 * Small formatters
 * ------------------------------------------------------------------------ */
const DATE_FMT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
function formatEarthDate(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return DATE_FMT.format(d);
}

function getMaxSol() {
  if (Number.isFinite(APP?.maxSol)) return APP.maxSol;
  return APP?.manifest?.snapshot_sol ?? SNAPSHOT.sol;
}

/* ---------------------------------------------------------------------------
 * HUD
 * ------------------------------------------------------------------------ */
function syncSliders(value) {
  const v = String(Math.round(value));
  if (elements.slider && document.activeElement !== elements.slider) elements.slider.value = v;
  if (elements.pillSlider && document.activeElement !== elements.pillSlider) elements.pillSlider.value = v;
}

function updateKiosk(s) {
  const el = document.getElementById('kiosk-sol');
  if (!el || el.hidden) return;
  el.innerHTML = `SOL ${s}<span class="sub">Jezero Crater &middot; Mars</span>`;
}

function updateHUD(s) {
  const wp = findWaypointAtOrBefore(s);
  if (elements.sol) elements.sol.textContent = `SOL ${s}`;
  if (elements.pillSol) elements.pillSol.textContent = String(s);
  if (elements.date) elements.date.textContent = formatEarthDate(wp?.date) || '—';
  const km = Number.isFinite(wp?.km) ? wp.km : 0;
  if (elements.km) elements.km.textContent = `${km.toFixed(2)} km driven`;

  if (elements.elev || elements.elevRel) {
    if (Number.isFinite(wp?.elev) && typeof APP.formatElevation === 'function') {
      const full = APP.formatElevation(wp.elev);
      const sep = full.indexOf(' · ');
      if (elements.elev) elements.elev.textContent = sep >= 0 ? full.slice(0, sep) : full;
      if (elements.elevRel) elements.elevRel.textContent = sep >= 0 ? full.slice(sep + 3) : '';
    } else {
      if (elements.elev) elements.elev.textContent = '—';
      if (elements.elevRel) elements.elevRel.textContent = '';
    }
  }

  syncSliders(s);
  updateKiosk(s);
}

/* ---------------------------------------------------------------------------
 * Playback engine — the hybrid mechanism (§4.3)
 * ------------------------------------------------------------------------ */
function applyIntegerSol(s) {
  lastIntSol = s;
  if (typeof MAP.setGlobalStateProperty === 'function') {
    MAP.setGlobalStateProperty(GLOBAL_STATE.SOL, s);
  }
  const drive = traverseBySol.get(s + 1);
  const activeSrc = MAP.getSource && MAP.getSource('traverse-active');
  if (activeSrc) {
    if (drive) {
      activeSrc.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { sol: s + 1, len_m: drive.len_m, date: drive.date, live: !!drive.live },
          geometry: { type: 'LineString', coordinates: drive.coordinates },
        }],
      });
    } else {
      activeSrc.setData(EMPTY_FC);
    }
  }
  if (MAP.getLayer && MAP.getLayer('traverse-progress')) {
    /* undefined resets to the style's own value (no dasharray = solid). */
    MAP.setPaintProperty('traverse-progress', 'line-dasharray', drive && drive.live ? [2, 2] : undefined);
  }
  updateHUD(s);
  APP.emit('sol', { sol: s });   // hash.js already listens for this and debounces the write
}

function applyFrac(s, frac) {
  if (MAP.getLayer && MAP.getLayer('traverse-progress')) {
    MAP.setPaintProperty('traverse-progress', 'line-gradient',
      ['step', ['line-progress'], PALETTE.rover, clamp01(frac), 'rgba(0,0,0,0)']);
  }
  const pos = computeRoverPosition(s, frac);
  if (pos && roverMarker) roverMarker.setLngLat(pos);
}

function maybeFollow(force = false) {
  if (!state.follow || !roverMarker || !MAP) return;
  const now = performance.now();
  if (!force && now - lastFollowTime < TUNING.FOLLOW_EASE_MS) return;
  lastFollowTime = now;
  MAP.easeTo({ center: roverMarker.getLngLat(), duration: TUNING.FOLLOW_EASE_MS, essential: true });
}

/** One clean, self-contained jump — used by the slider, hash navigation and
 *  "Where is Percy now?". Always recomputes from scratch so hard/repeated
 *  scrubbing can never leave a stuck filter or an orphaned traverse-active
 *  feature (§8). */
function seekTo(target) {
  const maxSol = getMaxSol();
  const s = clamp(Math.round(Number(target) || 0), 0, maxSol);
  state.sol = s;
  lastFrameTime = 0;
  applyIntegerSol(s);
  applyFrac(s, 0);
  maybeFollow(true);
}

function easeMultiplier(sol, maxSol) {
  if (!(maxSol > 0)) return 1;
  const p = sol / maxSol;
  const edge = 0.06;
  if (p < edge) return 0.35 + 0.65 * (p / edge);
  if (p > 1 - edge) return 0.35 + 0.65 * ((1 - p) / edge);
  return 1;
}

function processFrame() {
  const maxSol = getMaxSol();
  const s = Math.min(maxSol, Math.floor(state.sol));
  if (s !== lastIntSol) applyIntegerSol(s);
  const frac = state.sol >= maxSol ? 0 : state.sol - s;
  applyFrac(s, frac);
  syncSliders(state.sol);
  maybeFollow();
}

function tick(now) {
  if (!lastFrameTime) lastFrameTime = now;
  const dt = Math.min(0.25, (now - lastFrameTime) / 1000);   // clamp a stall/tab-switch gap
  lastFrameTime = now;

  const maxSol = getMaxSol();
  if (state.playing && maxSol > 0) {
    const rate = maxSol / state.speedSec;                    // sols per second, whole-mission speed
    state.sol = Math.min(maxSol, state.sol + rate * easeMultiplier(state.sol, maxSol) * dt);
  }

  const minInterval = LITE ? 1000 / 30 : 0;                  // 30 fps cap in lite mode (§5)
  if (now - lastProcessedTime >= minInterval) {
    lastProcessedTime = now;
    processFrame();
  }

  if (state.playing && state.sol >= maxSol) {
    stopPlaying();
    return;
  }
  rafId = state.playing ? requestAnimationFrame(tick) : null;
}

function setPlayButtonUI(playing) {
  if (elements.play) {
    elements.play.textContent = playing ? '⏸ Pause' : '▶ Play';
    elements.play.setAttribute('aria-pressed', String(playing));
  }
  if (elements.pillPlay) {
    elements.pillPlay.textContent = playing ? '⏸' : '▶';
    elements.pillPlay.setAttribute('aria-pressed', String(playing));
  }
}

function startPlaying() {
  const maxSol = getMaxSol();
  if (state.sol >= maxSol) state.sol = 0;                    // replay from the top once finished
  state.playing = true;
  setPlayButtonUI(true);
  lastFrameTime = 0;
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function stopPlaying() {
  state.playing = false;
  setPlayButtonUI(false);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function togglePlay() {
  if (state.playing) stopPlaying(); else startPlaying();
}

function setSpeed(key) {
  if (!SPEEDS[key]) return;
  state.speedSec = SPEEDS[key];
  for (const btn of elements.speedBtns || []) {
    btn.setAttribute('aria-pressed', String(btn.dataset.speed === key));
  }
}

/* ---------------------------------------------------------------------------
 * "Where is Percy now?" (§4.9)
 *
 * data.js's fetchCurrentPosition() already emits the 'badge' (live/amber) and
 * 'toast' (failure) bus events — ui.js is already listening on both, so this
 * handler only has to do the map-side work on success: extend the slider's
 * ceiling, splice a "since snapshot" drive into BOTH traverse-active (for the
 * immediate reveal animation) and the persistent traverse source (so it stays
 * visible via traverse-done once you scrub past it, exactly like a real drive
 * rather than vanishing at the last frame), then jump there.
 * ------------------------------------------------------------------------ */
function setPercyBusy(busy) {
  if (!elements.percy) return;
  elements.percy.disabled = busy;
  elements.percy.textContent = busy ? 'Checking…' : '⤓ Where is Percy now?';
}

async function onPercyClick() {
  if (!APP || typeof APP.fetchCurrentPosition !== 'function') {
    toast('Live position lookup is not available in this build.', { kind: 'warn' });
    return;
  }
  setPercyBusy(true);
  try {
    const f = await APP.fetchCurrentPosition();
    if (!f) return;   // data.js already toasted a warning and set the amber badge
    const coords = f.geometry && f.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const [lon, lat] = coords;

    const solRaw = Number(f.properties?.sol ?? f.properties?.Sol);
    const prevMax = getMaxSol();
    const newMax = Number.isFinite(solRaw) ? Math.max(prevMax, Math.round(solRaw)) : prevMax + 1;
    APP.maxSol = newMax;
    if (elements.slider) elements.slider.max = String(newMax);
    if (elements.pillSlider) elements.pillSlider.max = String(newMax);

    if (newMax > prevMax) {
      const last = waypointsSorted[waypointsSorted.length - 1] || null;
      let elev = null;
      if (typeof APP.elevAt === 'function') {
        try { elev = await APP.elevAt(lon, lat); } catch { elev = null; }
      }
      const liveDate = f.properties?.date || f.properties?.Earth_date || f.properties?.earth_date || null;

      let kmTotal = last?.km ?? null;
      let lenM = null;
      if (last && Number.isFinite(last.lon) && Number.isFinite(last.lat) && typeof APP.marsMetres === 'function') {
        try {
          lenM = APP.marsMetres([last.lon, last.lat], [lon, lat]);
          kmTotal = (last.km || 0) + lenM / 1000;
        } catch { /* keep last.km */ }
      }

      /* Replace any earlier synthetic segment rather than accumulating one
       * per click. */
      if (lastLiveSol !== null) traverseBySol.delete(lastLiveSol);
      waypointsSorted = waypointsSorted.filter((w) => !w.live);
      waypointsSorted.push({ sol: newMax, lon, lat, elev, km: kmTotal, date: liveDate, live: true });
      lastLiveSol = newMax;

      if (last) {
        traverseBySol.set(newMax, {
          coordinates: [[last.lon, last.lat], [lon, lat]],
          len_m: lenM,
          date: liveDate,
          live: true,
        });
        const liveFeature = {
          type: 'Feature',
          properties: { sol: newMax, len_m: lenM, date: liveDate, live: true },
          geometry: { type: 'LineString', coordinates: [[last.lon, last.lat], [lon, lat]] },
        };
        const traverseSrc = MAP.getSource && MAP.getSource('traverse');
        if (traverseSrc) {
          const existing = (APP.data?.traverse?.features || []).filter((ft) => !ft?.properties?.live);
          traverseSrc.setData({ type: 'FeatureCollection', features: [...existing, liveFeature] });
        }
      }
    }

    if (state.playing) stopPlaying();
    seekTo(newMax);
    MAP.flyTo({ center: [lon, lat], zoom: Math.max(MAP.getZoom(), 15), duration: 1500, essential: true });
  } finally {
    setPercyBusy(false);
  }
}

/* ---------------------------------------------------------------------------
 * Disabled-state note (§7: data absent -> disabled panel + note, never a throw)
 * ------------------------------------------------------------------------ */
function setControlsDisabled(disabled) {
  const controls = [
    elements.slider, elements.play, elements.follow,
    elements.pillSlider, elements.pillPlay,
    ...(elements.speedBtns || []),
  ];
  for (const el of controls) if (el) el.disabled = disabled;
}

function evaluateDisabledState() {
  const bothMissing = traverseMissing && waypointsMissing;
  setControlsDisabled(bothMissing);
  if (elements.note) elements.note.hidden = !bothMissing;
}

/* ---------------------------------------------------------------------------
 * Data lifecycle — safe to call more than once (idempotent rebuild)
 * ------------------------------------------------------------------------ */
function refreshFromData() {
  traverseBySol = buildTraverseIndex(APP.data?.traverse || null);
  waypointsSorted = buildWaypointsIndex(APP.data?.waypoints || null);
  lastLiveSol = null;
  evaluateDisabledState();

  const maxSol = getMaxSol();
  if (elements.slider) elements.slider.max = String(maxSol);
  if (elements.pillSlider) elements.pillSlider.max = String(maxSol);

  const gs = (MAP.getGlobalState && MAP.getGlobalState()) || {};
  const initialSol = Number.isFinite(gs[GLOBAL_STATE.SOL]) ? gs[GLOBAL_STATE.SOL] : maxSol;
  seekTo(clamp(initialSol, 0, maxSol));
}

/* ---------------------------------------------------------------------------
 * DOM — landscape-phone floating pill (§4.2). Base CSS keeps #sol-pill
 * display:none outside the landscape-phone media query, so it is always safe
 * to fill in and un-hide.
 * ------------------------------------------------------------------------ */
function buildSolPill() {
  const host = document.getElementById('sol-pill');
  if (!host) return;
  host.innerHTML = `
    <button type="button" id="tl-pill-play" aria-pressed="false" title="Play/Pause">▶</button>
    <span class="num">SOL <span id="tl-pill-sol">0</span></span>
    <input type="range" id="tl-pill-slider" min="0" max="0" step="1" value="0" aria-label="Mission sol" />
  `;
  host.hidden = false;
  elements.pillPlay = host.querySelector('#tl-pill-play');
  elements.pillSol = host.querySelector('#tl-pill-sol');
  elements.pillSlider = host.querySelector('#tl-pill-slider');

  elements.pillPlay.addEventListener('click', togglePlay);
  elements.pillSlider.addEventListener('input', () => {
    if (state.playing) stopPlaying();
    seekTo(elements.pillSlider.value);
  });
}

/* ---------------------------------------------------------------------------
 * DOM — the TIMELINE panel (§4.1 order; kept for desktop and half/full sheet.
 * Peek-detent space is handled by the injected stylesheet above, not by
 * reordering these — see the comment there).
 * ------------------------------------------------------------------------ */
function buildTimelinePanel(body, app) {
  APP = app;
  MAP = app.map;
  ensureStyle();

  const maxSol = getMaxSol();
  body.innerHTML = `
    <div id="tl-sol" class="num">SOL ${maxSol}</div>
    <div id="tl-date" class="hint"></div>
    <div class="row tight">
      <span id="tl-km" class="num strong"></span>
    </div>
    <div class="tl-elev-line">
      <span id="tl-elev" class="num strong"></span>
      <span id="tl-elev-rel" class="hint"></span>
    </div>
    <input type="range" id="tl-slider" class="num" min="0" max="${maxSol}" step="1" value="${maxSol}"
           aria-label="Mission sol" />
    <div class="row">
      <button type="button" class="btn wide" id="tl-play" aria-pressed="false">▶ Play</button>
    </div>
    <div class="row tight" id="tl-speed" role="group" aria-label="Playback speed">
      <button type="button" class="btn" data-speed="slow" aria-pressed="false">Slow</button>
      <button type="button" class="btn" data-speed="normal" aria-pressed="true">Normal</button>
      <button type="button" class="btn" data-speed="fast" aria-pressed="false">Fast</button>
    </div>
    <label class="toggle">
      <input type="checkbox" id="tl-follow" /> Follow rover
    </label>
    <div class="row">
      <button type="button" class="link-btn" id="tl-percy">⤓ Where is Percy now?</button>
    </div>
    <p class="panel-empty" id="tl-note" hidden>Traverse and waypoint data aren't available yet —
      sol scrubbing is disabled until the pipeline produces them.</p>
  `;

  elements.sol = body.querySelector('#tl-sol');
  elements.date = body.querySelector('#tl-date');
  elements.km = body.querySelector('#tl-km');
  elements.elev = body.querySelector('#tl-elev');
  elements.elevRel = body.querySelector('#tl-elev-rel');
  elements.slider = body.querySelector('#tl-slider');
  elements.play = body.querySelector('#tl-play');
  elements.speedBtns = Array.from(body.querySelectorAll('#tl-speed [data-speed]'));
  elements.follow = body.querySelector('#tl-follow');
  elements.percy = body.querySelector('#tl-percy');
  elements.note = body.querySelector('#tl-note');

  elements.slider.addEventListener('input', () => {
    if (state.playing) stopPlaying();
    seekTo(elements.slider.value);
  });
  elements.play.addEventListener('click', togglePlay);
  for (const btn of elements.speedBtns) {
    btn.addEventListener('click', () => setSpeed(btn.dataset.speed));
  }
  elements.follow.addEventListener('change', () => {
    state.follow = elements.follow.checked;
    if (state.follow) maybeFollow(true);
  });
  elements.percy.addEventListener('click', onPercyClick);

  buildSolPill();

  /* A visible rover from the first frame, even before real data resolves;
   * refreshFromData() repositions it once the indices are built. */
  if (typeof app.makeMarker === 'function' && app.map) {
    roverMarker = app.makeMarker('rover', [LANDING.lon, LANDING.lat]).addTo(app.map);
  }

  /* If the core data set already settled before this panel was built, index
   * it now; otherwise init() picks it up on the 'data:ready' event. */
  if (app.data && (app.data.traverse || app.data.waypoints)) {
    refreshFromData();
  } else {
    updateHUD(maxSol);
  }
}

/* ---------------------------------------------------------------------------
 * init — bus wiring. Called exactly once by ui.js's loadFeatureModules, after
 * buildTimelinePanel has already run (registerPanel below builds it
 * immediately at import time, since the shell exists by 'ready').
 * ------------------------------------------------------------------------ */
export function init(app) {
  APP = app;
  MAP = app.map;

  app.on('data:missing', ({ key }) => {
    if (key === 'traverse') traverseMissing = true;
    if (key === 'waypoints') waypointsMissing = true;
  });
  app.on('data:ready', () => refreshFromData());

  /* External sol changes (hashchange, or a future tour.js) — always route
   * through the one seek path so nothing can desync from it. */
  app.on('hash:sol', ({ sol }) => {
    if (state.playing) stopPlaying();
    seekTo(sol);
  });

  /* Shell visibility control (§4.3, §5: iOS reclaims backgrounded WebGL). */
  app.on('pause', () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  });
  app.on('resume', () => {
    if (state.playing && !rafId) {
      lastFrameTime = 0;
      rafId = requestAnimationFrame(tick);
    }
  });

  /* TOUR stop 4 (§4.10, config.js TOUR[3]): action:'play-timeline', speed. */
  registerAction('play-timeline', (opts = {}) => {
    if (opts.speed) setSpeed(opts.speed);
    seekTo(0);
    startPlaying();
  });
  /* Generic hook for any tour stop with a plain `sol` field. */
  registerAction('timeline:goto', (sol) => {
    if (Number.isFinite(sol)) seekTo(sol);
  });
}

registerPanel('TIMELINE', buildTimelinePanel);
