/* =============================================================================
 * Jezero Explorer - tour.js
 *
 * STORY MODE: the 8-stop guided tour (docs/frontend-design.md §4.10), the
 * dome-show companion. This module owns exactly one file. Every behaviour below
 * is driven through the REAL, on-disk contracts of the other modules - the
 * design doc's sketches lose to what config.js / ui.js / map.js / hash.js /
 * timeline.js / flood.js / ingenuity.js actually export.
 *
 * ---------------------------------------------------------------------------
 * Shell APIs consumed (verified 1:1 against the files, 2026-08-23)
 * ---------------------------------------------------------------------------
 *   config.js   TOUR (8 frozen stops, captions verbatim), HASH_KEYS.ON_KEYS,
 *               LAYER_IDS, GLOBAL_STATE.{SOL,FLIGHT,FLOOD}, HIGHSTAND_M,
 *               SNAPSHOT, VIEW
 *   ui.js       registerAction(name, fn), runAction(name, ...args) -> boolean,
 *               toast(msg, {kind}), LITE (live binding)
 *               NOTE: runAction returns a BOOLEAN, not the action's return
 *               value, so anything that has to be awaited is called through
 *               the module's own app.* mirror instead (app.flood.animate).
 *   map.js      app.map, app.set3D(on, {ease, exag}), app.get3D(),
 *               app.setExaggeration(v, {silent}), app.getExaggeration()
 *   hash.js     app.pushTourStep(n)   the ONLY pushState writer in the app
 *               app.writeHash({push}) replaceState
 *               app.tourStop          read by hash.js's serialize() -> `tour=`
 *               parseHash(str)        exported; used to read `tour=` on load
 *               bus 'tour:pop'        popstate carrying a pushed step
 *               bus 'hash:tour'       hashchange carrying `tour=`
 *   timeline.js registerAction('play-timeline', {speed}) - stop 4
 *               registerAction('timeline:goto', sol)
 *               bus 'hash:sol' {sol}  -> timeline stopPlaying() + seekTo(); the
 *               only lever that both parks the sol AND halts playback
 *               #tl-follow            the "Follow rover" checkbox. seekTo() and
 *               the play loop both call maybeFollow() -> easeTo(rover), which
 *               would hijack every stop's camera, so the tour switches the real
 *               control off (dispatching 'change' so timeline.js stays its
 *               owner) and restores it on exit.
 *   flood.js    app.flood.animate(target, opts) -> Promise, app.flood.cancel(),
 *               app.flood.setLevel(level|null), app.flood.off(),
 *               app.flood.isOn(), app.flood.getLevel()
 *               actions 'flood:animate' | 'flood:cancel' | 'flood:set'
 *   ingenuity.js registerAction('heli-mode', {flight}|number),
 *               app.ingenuity.{enterMode, exitMode, isModeOn, selectFlight}
 *   style.css   #tour-card (positioned desktop bottom-center / above the peek
 *               sheet on mobile / narrowed on landscape phones) and the
 *               .tour-step / .tour-title / .tour-caption / .tour-nav classes
 *               the shell already staged; body.tour dims #dock to 40 %;
 *               body.kiosk already hides #dock, #topbar, #map-tools, #readout,
 *               so in kiosk the card is the only chrome left standing.
 *
 * ---------------------------------------------------------------------------
 * Stop engine
 * ---------------------------------------------------------------------------
 * Entering stop N:
 *   0. snapshot the pre-tour world ONCE, at tour entry only
 *   1. invalidate any in-flight stop action (token bump + flood cancel +
 *      timeline halt)
 *   2. apply state through the OWNING module: layer visibility (ON_KEYS),
 *      terrain + exaggeration (app.set3D / app.setExaggeration), sol
 *      (timeline), and - for stop 7 only - Ingenuity mode
 *   3. write history (pushState on advance, replaceState on entry / history
 *      navigation)
 *   4. exactly ONE camera move: flyTo({...cam, duration 2600, curve 1.3})
 *   5. after the camera settles, the stop's own action:
 *        stop 3  await app.flood.animate(-2395)
 *        stop 4  runAction('play-timeline', {speed: 'fast'})
 *      (stop 7's 'heli-mode' runs in step 2 on purpose - ingenuity.js's
 *      selectFlight() ends in flyToFlight(), and the tour's single flyTo has
 *      to be the last camera word, so the bridge is called BEFORE it.)
 *
 * Exit (card close / Esc / walking back out of stop 1 / manual Ingenuity mode):
 *   cancel actions, restore the snapshot exactly (flood, heli mode, every
 *   LAYER_IDS visibility, sol, exaggeration, 3D, camera), clear `tour=` and
 *   unwind the history entries the tour pushed so the Back button is not
 *   trapped behind the tour.
 * ========================================================================== */

import {
  TOUR, HASH_KEYS, LAYER_IDS, GLOBAL_STATE, HIGHSTAND_M, SNAPSHOT,
} from './config.js';
import { registerAction, runAction, toast, LITE } from './ui.js';
import { parseHash } from './hash.js';

const ON_KEYS = HASH_KEYS.ON_KEYS;

/** §4.10: one flyTo per stop, 2600 ms, curve 1.3, essential. */
const FLY_MS = 2600;
const FLY_CURVE = 1.3;
/** Restore is a shorter, plainer move - it is not part of the show. */
const RESTORE_MS = 1600;
/** Stop 3's rising tide (flood.js's own documented defaults, stated here so a
 *  dome operator can see the timing in one place). */
const FLOOD_MS = 6000;
const FLOOD_MIN_LEVEL = -2700;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------ */
let APP = null;
let MAP = null;

let active = false;
let index = -1;            // 0-based index into TOUR
let runToken = 0;          // bumped to invalidate pending async stop actions
let snapshot = null;       // pre-tour world, captured once at entry
let pushDepth = 0;         // history entries this tour session pushed
let unwinding = 0;         // popstate events to swallow while unwinding
let reentryBlockUntil = 0; // ignore stale `tour=` signals just after an exit
let terrainNoted = false;  // §4.6 one-time 3D toast, once per tour session

let cardEl = null;
let titleEl = null;
let captionEl = null;
let stepEl = null;
let countEl = null;
let backBtn = null;
let nextBtn = null;

/** Listeners installed for the duration of a tour, removed on exit. */
let detachers = [];

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */
/** Toasts are chatter on a dome. Kiosk mode gets none of them. */
function notify(msg, o) {
  if (APP && APP.kiosk) return;
  toast(msg, o || {});
}

function globalState() {
  if (!MAP || typeof MAP.getGlobalState !== 'function') return {};
  return MAP.getGlobalState() || {};
}

/** Same rule hash.js's serializer uses: the first present layer of a group
 *  decides, and an unset visibility means visible. */
function layerVisible(id) {
  if (!MAP || !MAP.getLayer(id)) return null;
  return (MAP.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none';
}

function setLayerVisible(id, on) {
  if (!MAP || !MAP.getLayer(id)) return;
  MAP.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

/** The live sol ceiling: data.js's app.maxSol if "Where is Percy now?" or the
 *  snapshot has landed, else the manifest, else the config fallback. */
function maxSol() {
  if (APP && Number.isFinite(APP.maxSol)) return APP.maxSol;
  if (APP && APP.snapshot && Number.isFinite(APP.snapshot.sol)) return APP.snapshot.sol;
  const fromManifest = APP && APP.manifest ? APP.manifest.snapshot_sol : null;
  return Number.isFinite(fromManifest) ? fromManifest : SNAPSHOT.sol;
}

/**
 * Resolve after the camera has stopped, or after the flight should have
 * finished - whichever comes first. MapLibre fires one 'moveend' per gesture,
 * but a tile-starved flyTo can be quiet, hence the belt-and-braces timer.
 */
function cameraSettled(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (MAP) MAP.off('moveend', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms + 500);
    if (MAP) MAP.on('moveend', finish);
    else finish();
  });
}

/** Never let a stop action hang the engine (see the flood.js note in init). */
function withDeadline(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch((err) => {
      console.warn('[jezero] tour: stop action rejected -', err);
    }),
    new Promise((resolve) => { setTimeout(resolve, ms); }),
  ]);
}

/* ---------------------------------------------------------------------------
 * Card styles. style.css already positions #tour-card and styles .tour-step /
 * .tour-title / .tour-caption / .tour-nav; this only adds the bits the shell
 * could not know about - 44 px nav targets (§4.10) and the counter.
 * ------------------------------------------------------------------------ */
function ensureStyle() {
  if (document.getElementById('tour-style')) return;
  const s = document.createElement('style');
  s.id = 'tour-style';
  s.textContent = `
    #tour-card .tour-nav .btn { min-height: 44px; min-width: 88px; font-size: 13px; }
    #tour-card .tour-nav .tour-count {
      color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums;
      min-width: 44px; text-align: center;
    }
    #tour-card .tour-nav .tour-close {
      min-width: 44px; padding: 0; font-size: 15px; line-height: 1;
    }
    #tour-card .tour-title { color: #fff; font-weight: 600; }
    #tour-card .tour-dots { display: flex; gap: 5px; margin: 0 0 8px; }
    #tour-card .tour-dots i {
      width: 100%; height: 3px; border-radius: 2px; background: var(--border);
    }
    #tour-card .tour-dots i.done { background: #4a5a63; }
    #tour-card .tour-dots i.now { background: var(--accent); }
    /* Kiosk: the card IS the interface, so give it room and weight. */
    body.kiosk #tour-card { width: min(760px, calc(100% - 48px)); bottom: 34px; }
    body.kiosk #tour-card .tour-title { font-size: 22px; }
    body.kiosk #tour-card .tour-caption { font-size: 16px; }
    @media (prefers-reduced-motion: reduce) {
      #tour-card { transition: none; }
    }
  `;
  document.head.appendChild(s);
}

/* ---------------------------------------------------------------------------
 * Card
 *
 * Chrome glyphs are written as HTML entities so this file stays pure ASCII
 * while still rendering the exact characters §4.10 specifies. Titles and
 * captions come out of config.js TOUR through textContent - verbatim, never
 * rewritten, never parsed as markup.
 * ------------------------------------------------------------------------ */
function buildCard() {
  cardEl = document.getElementById('tour-card');
  if (!cardEl) {
    console.warn('[jezero] tour: #tour-card is missing from index.html - ' +
                 'the tour will still drive the map, without a card.');
    return;
  }
  ensureStyle();

  const dots = TOUR.map(() => '<i></i>').join('');
  cardEl.innerHTML =
    '<p class="tour-step" id="tour-step"></p>' +
    '<h2 class="tour-title" id="tour-title"></h2>' +
    `<div class="tour-dots" id="tour-dots">${dots}</div>` +
    '<p class="tour-caption" id="tour-caption"></p>' +
    '<div class="tour-nav">' +
      '<button type="button" class="btn" id="tour-back">&lsaquo; Back</button>' +
      '<span class="tour-count" id="tour-count"></span>' +
      '<button type="button" class="btn" id="tour-next">Next &rsaquo;</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn tour-close" id="tour-close" ' +
        'aria-label="Leave the tour" title="Leave the tour (Esc)">&#10005;</button>' +
    '</div>';

  stepEl = cardEl.querySelector('#tour-step');
  titleEl = cardEl.querySelector('#tour-title');
  captionEl = cardEl.querySelector('#tour-caption');
  countEl = cardEl.querySelector('#tour-count');
  backBtn = cardEl.querySelector('#tour-back');
  nextBtn = cardEl.querySelector('#tour-next');

  backBtn.addEventListener('click', () => goBack());
  nextBtn.addEventListener('click', () => goNext());
  cardEl.querySelector('#tour-close').addEventListener('click', () => exitTour({ reason: 'close' }));

  cardEl.setAttribute('role', 'region');
  cardEl.setAttribute('aria-live', 'polite');
  cardEl.setAttribute('aria-label', 'Guided tour');
}

function renderCard() {
  if (!cardEl) return;
  const stop = TOUR[index];
  const n = index + 1;
  const total = TOUR.length;

  stepEl.textContent = `Stop ${n} of ${total}`;
  titleEl.textContent = stop.title;
  captionEl.textContent = stop.caption;      // verbatim from config.js
  countEl.innerHTML = `${n}&nbsp;/&nbsp;${total}`;

  const dots = cardEl.querySelectorAll('#tour-dots i');
  dots.forEach((el, i) => {
    el.className = i === index ? 'now' : (i < index ? 'done' : '');
  });

  backBtn.disabled = index <= 0;
  nextBtn.innerHTML = index >= total - 1 ? 'Finish' : 'Next &rsaquo;';

  cardEl.hidden = false;
}

/* ---------------------------------------------------------------------------
 * Snapshot / restore
 *
 * Captured ONCE, at tour entry. Layer visibility is recorded per layer id over
 * the whole frozen LAYER_IDS list rather than per ON_KEY group, so groups the
 * tour never touches by name (flood-tide, airfield-label, heli-ribbon,
 * traverse-progress) come back exactly as they were too.
 * ------------------------------------------------------------------------ */
function takeSnapshot() {
  const gs = globalState();
  const c = MAP.getCenter();
  const layers = {};
  for (const id of LAYER_IDS) {
    const vis = layerVisible(id);
    if (vis !== null) layers[id] = vis;
  }
  return {
    cam: {
      center: [c.lng, c.lat],
      zoom: MAP.getZoom(),
      pitch: MAP.getPitch(),
      bearing: MAP.getBearing(),
    },
    sol: Number.isFinite(gs[GLOBAL_STATE.SOL]) ? gs[GLOBAL_STATE.SOL] : null,
    flight: Number.isFinite(gs[GLOBAL_STATE.FLIGHT]) ? gs[GLOBAL_STATE.FLIGHT] : null,
    on3d: !!(APP.get3D && APP.get3D()),
    exag: APP.getExaggeration ? APP.getExaggeration() : null,
    layers,
    flood: APP.flood
      ? { on: !!APP.flood.isOn(), level: APP.flood.getLevel() }
      : null,
    heliMode: APP.ingenuity ? !!APP.ingenuity.isModeOn() : null,
    follow: !!(document.getElementById('tl-follow') || {}).checked,
    hash: location.hash,
  };
}

function restoreSnapshot(snap) {
  if (!snap) return;

  /* 1. Feature modules first - they own layers of their own and would
   *    otherwise fight the blanket visibility restore below. */
  if (APP.flood) {
    if (snap.flood && snap.flood.on && Number.isFinite(snap.flood.level)) {
      APP.flood.setLevel(snap.flood.level);
    } else {
      APP.flood.off();
    }
  } else {
    runAction('flood:cancel');
  }

  if (APP.ingenuity && snap.heliMode !== null) {
    if (snap.heliMode) APP.ingenuity.enterMode();
    else APP.ingenuity.exitMode();
  }

  /* 2. Exact layer visibility. */
  for (const id of Object.keys(snap.layers)) setLayerVisible(id, snap.layers[id]);
  APP.emit('layers', { source: 'tour:restore' });

  /* The Ingenuity card's ribbon checkbox reads the layer at build time and has
   * no resync hook, so mirror the restored truth into it - cosmetically only,
   * with no 'change' event, since the layer is already where it belongs. */
  const ribbonCk = document.getElementById('ing-ribbon-toggle');
  if (ribbonCk && !ribbonCk.disabled) {
    ribbonCk.checked = layerVisible('heli-ribbon') === true;
  }

  /* 3. Selected flight (filters heli-path-sel through global state). */
  if (MAP.setGlobalStateProperty) {
    MAP.setGlobalStateProperty(GLOBAL_STATE.FLIGHT,
      Number.isFinite(snap.flight) ? snap.flight : 0);
  }

  /* 4. Sol - back through the timeline so its HUD and rover marker agree.
   *    "Follow rover" stays off until after the camera move below, so this
   *    seek cannot fire a follow easeTo mid-restore. */
  if (Number.isFinite(snap.sol)) applySol(snap.sol);

  /* 5. Terrain. setExaggeration first so set3D cannot ease the pitch on a
   *    stale exaggeration, and always {ease:false} - the camera move below is
   *    the only one we want. */
  if (APP.setExaggeration && Number.isFinite(snap.exag)) {
    APP.setExaggeration(snap.exag, { silent: true });
  }
  if (APP.set3D) APP.set3D(!!snap.on3d, { ease: false });

  /* 6. Camera. */
  try {
    MAP.flyTo({
      center: snap.cam.center,
      zoom: snap.cam.zoom,
      pitch: Math.min(snap.cam.pitch, MAP.getMaxPitch()),
      bearing: snap.cam.bearing,
      duration: RESTORE_MS,
      curve: FLY_CURVE,
      essential: true,
    });
  } catch (err) {
    console.warn('[jezero] tour: could not restore the camera -', err);
  }

  /* 7. "Follow rover", last. If it was on before the tour, its own 600 ms
   *    easeTo to the rover is issued after (and therefore supersedes) the
   *    camera restore above - which is exactly where following would have had
   *    the camera anyway. */
  if (snap.follow) setFollow(true);
}

/* ---------------------------------------------------------------------------
 * Applying one stop's state, always through the owning module
 * ------------------------------------------------------------------------ */
/** `layers` is a list of frozen ON_KEYS short keys (config.js TOUR). */
function applyLayers(keys) {
  const wanted = new Set(Array.isArray(keys) ? keys : []);
  for (const key of Object.keys(ON_KEYS)) {
    const on = wanted.has(key);
    for (const id of ON_KEYS[key]) setLayerVisible(id, on);
  }
  /* hash.js already subscribes to 'layers' and rewrites `on=` (debounced). */
  APP.emit('layers', { source: 'tour' });
}

function applyTerrain(stop) {
  if (!APP.set3D) return;
  const want = !!stop.terrain;
  if (want && APP.setExaggeration && Number.isFinite(stop.exag)) {
    APP.setExaggeration(stop.exag, { silent: true });
  }
  const wasOn = !!(APP.get3D && APP.get3D());
  /* Never let set3D ease the camera: the stop's single flyTo owns pitch. And
   * never force terrain by calling setTerrain directly - LITE and the §7 perf
   * watchdog live inside app.set3D, and this has to degrade with them. */
  APP.set3D(want, { ease: false });
  if (want && !wasOn && !terrainNoted && !LITE) {
    terrainNoted = true;
    notify('3D terrain is on for this stop. The vertical exaggeration slider ' +
           'is at the top right - 1x is true Mars.');
  }
}

/**
 * One route for every sol change in this module.
 *  - 'hash:sol' is what timeline.js listens to, and its handler does
 *    stopPlaying() BEFORE seekTo() - so this is simultaneously the "park the
 *    sol" and the "halt playback" lever.
 *  - 'timeline:goto' doubles as an existence probe: runAction returns false
 *    when timeline.js never loaded, in which case the global-state property is
 *    driven directly so the traverse/waypoint/heli filters still move.
 */
function applySol(sol) {
  if (!Number.isFinite(sol)) return;
  const s = clamp(Math.round(sol), 0, maxSol());
  const routed = runAction('timeline:goto', s);
  APP.emit('hash:sol', { sol: s });
  if (!routed && MAP.setGlobalStateProperty) {
    MAP.setGlobalStateProperty(GLOBAL_STATE.SOL, s);
  }
}

/** `sol` in a stop: a number, null ("leave it"), or 'current'. */
function applyStopSol(stop) {
  if (stop.sol === null || stop.sol === undefined) return;
  if (stop.sol === 'current') { applySol(maxSol()); return; }
  applySol(Number(stop.sol));
}

/**
 * "Follow rover" has to be off for the whole tour.
 *
 * timeline.js's seekTo() ends in maybeFollow(true) and its play loop calls
 * maybeFollow() every frame; both are easeTo(center: rover, 600 ms), which
 * would drag the camera away from every stop and completely hijack stop 4's
 * playback. There is no action for the checkbox, so the tour drives the real
 * control (#tl-follow) and dispatches the 'change' event timeline.js is
 * already listening for - its own handler stays the single owner of the flag.
 *
 * @returns {boolean} the checkbox state before this call
 */
function setFollow(on) {
  const ck = document.getElementById('tl-follow');
  if (!ck) return false;
  const before = !!ck.checked;
  if (before !== !!on) {
    ck.checked = !!on;
    ck.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return before;
}

/** Park playback wherever it is, without moving the sol. */
function haltPlayback() {
  const gs = globalState();
  const cur = gs[GLOBAL_STATE.SOL];
  if (Number.isFinite(cur)) APP.emit('hash:sol', { sol: Math.round(cur) });
}

function cancelStopActions() {
  if (APP.flood && typeof APP.flood.cancel === 'function') APP.flood.cancel();
  else runAction('flood:cancel');
  haltPlayback();
}

/* ---------------------------------------------------------------------------
 * Stop 7's Ingenuity bridge
 *
 * Run BEFORE the stop's flyTo: ingenuity.js's selectFlight() finishes with
 * flyToFlight() (fitBounds/easeTo, 900 ms), and §4.10 allows the tour exactly
 * one camera move - so the bridge fires first and the tour's flyTo, issued
 * afterwards, is the last word.
 *
 * The 'rib' key in stop 7's `layers` has already made heli-ribbon visible by
 * this point, and applyTerrain() has already turned 3D on. That ordering is
 * what makes the ribbon build itself: ingenuity.js's wireCardControls() seeds
 * its checkbox from ribbonLayerVisible(), and fetchAndBuildChart() pushes the
 * ribbon geometry when the same test passes. Nothing here reimplements it.
 * ------------------------------------------------------------------------ */
let ignoreFlightUntil = 0;

function applyHeliMode(stop) {
  const flight = Number.isFinite(stop.flight) ? stop.flight : null;
  /* Our own selectFlight() will emit 'flight'; don't read that as the user
   * manually entering Ingenuity mode. */
  ignoreFlightUntil = performance.now() + 2000;

  if (runAction('heli-mode', { flight })) return;
  if (APP.ingenuity) {
    APP.ingenuity.enterMode();
    if (flight !== null) APP.ingenuity.selectFlight(flight);
    return;
  }
  /* ingenuity.js absent or failed to parse: the ground-track layers are still
   * turned on by the stop's `layers` (the 'heli' + 'rib' ON_KEYS), so the stop
   * degrades to a camera move plus a caption. Say so once, quietly. */
  console.warn('[jezero] tour stop 7: no Ingenuity bridge ' +
               '(registerAction("heli-mode") / app.ingenuity are both absent) - ' +
               'showing the ground track only.');
  notify('Ingenuity mode is not available in this build - showing the flight ' +
         'path only.', { kind: 'warn' });
}

/* ---------------------------------------------------------------------------
 * The camera: exactly one flyTo per stop (§4.10)
 * ------------------------------------------------------------------------ */
function flyToStop(stop) {
  const cam = stop.cam || {};
  try {
    MAP.flyTo({
      center: cam.center,
      zoom: cam.zoom,
      /* LITE caps maxPitch at 55 and phones at 60 (map.js) - clamp rather than
       * hand MapLibre a pitch it will silently reinterpret. */
      pitch: Math.min(Number(cam.pitch) || 0, MAP.getMaxPitch()),
      bearing: Number(cam.bearing) || 0,
      duration: FLY_MS,
      curve: FLY_CURVE,
      essential: true,
    });
  } catch (err) {
    console.warn('[jezero] tour: flyTo failed, jumping instead -', err);
    try { MAP.jumpTo({ center: cam.center, zoom: cam.zoom }); } catch { /* give up */ }
  }
}

/* ---------------------------------------------------------------------------
 * The 3D settle - F3's fix (2026-08-23), rewritten by the elevation-offset
 * migration (docs/frontend-design.md 9.3)
 *
 * A stop that lands with terrain on leaves MapLibre's terrain anchor
 * (transform.elevation) at 0: every DEM tile the flight needs arrives DURING
 * the flight, while MapLibre's elevationFreeze is on, so its own re-derive
 * never runs. With the DEM now encoded +4000 m the ground under the centre is
 * around +4,100 m, so a 0 anchor leaves the camera anchored ~4 km BELOW the
 * terrain: farZ collapses (2,273 instead of 20,097 at stop 5) and the scene
 * blacks out, AND Camera._elevateCameraIfInsideTerrain lifts the camera out of
 * the hill, rewriting stop 5's z17.2 to 14.711 and stop 6's z17.5 to 14.544.
 *
 * One cause, one cure: hand app.settleTerrainView() the stop's CONFIGURED
 * camera. It re-asserts that camera and then re-derives the anchor at it (the
 * ordering rule and the numbers are in map.js). Measured over all 8 stops:
 * every camera exact, background fraction 0.000, and the intended framing at
 * last - stop 5's viewport span 3.555 km -> 0.243 km, stop 7's 4.085 -> 0.395.
 *
 * Fired and forgotten, never awaited: stop 3's tide and stop 4's playback must
 * not wait on it. Token-guarded so a Next during the settle abandons it, and
 * gated on stop.terrain so stop 4's camera cannot be touched during playback.
 * ------------------------------------------------------------------------ */
async function settleStop(token, stop) {
  if (!stop.terrain || typeof APP.settleTerrainView !== 'function') return;
  await cameraSettled(FLY_MS);
  await new Promise((resolve) => { setTimeout(resolve, 450); });
  if (token !== runToken || !active) return;
  const cam = stop.cam || {};
  APP.settleTerrainView(cam.center ? {
    center: cam.center,
    zoom: cam.zoom,
    /* Same clamp flyToStop uses - LITE/mobile cap maxPitch lower. */
    pitch: Math.min(Number(cam.pitch) || 0, MAP.getMaxPitch()),
    bearing: Number(cam.bearing) || 0,
  } : undefined);
}

/* ---------------------------------------------------------------------------
 * enterStop - the state machine's one transition
 * ------------------------------------------------------------------------ */
/**
 * @param {number} i 0-based index into TOUR
 * @param {{push?:boolean, fromHistory?:boolean}} [o]
 *   push        true for a Next/Back advance (history.pushState via hash.js)
 *   fromHistory true when a popstate/hashchange drove us here (no history write)
 */
async function enterStop(i, o = {}) {
  if (!active || !MAP) return;
  const idx = clamp(i, 0, TOUR.length - 1);
  const stop = TOUR[idx];

  /* Any pending stop action from the previous stop is now stale. */
  const token = ++runToken;
  cancelStopActions();

  index = idx;
  renderCard();

  /* --- 1. state, through the owning modules ---------------------------- */
  /* Re-asserted every stop, not just at entry: the sidebar is only dimmed, so
   * a visitor can re-tick "Follow rover" mid-tour and steal the camera. */
  setFollow(false);
  applyLayers(stop.layers);
  applyTerrain(stop);
  applyStopSol(stop);
  if (stop.action === 'heli-mode') applyHeliMode(stop);

  /* --- 2. history / URL ------------------------------------------------ */
  if (o.push && typeof APP.pushTourStep === 'function') {
    pushDepth += 1;
    APP.pushTourStep(stop.id);
  } else {
    APP.tourStop = stop.id;
    if (typeof APP.writeHash === 'function') APP.writeHash();
  }

  /* --- 3. the one camera move ------------------------------------------ */
  flyToStop(stop);

  /* --- 3b. the 3D settle (see settleStop) - not awaited ---------------- */
  settleStop(token, stop);

  /* --- 4. post-camera action ------------------------------------------- */
  if (stop.action === 'flood-rise') {
    await cameraSettled(FLY_MS);
    if (token !== runToken || !active) return;
    const target = Number.isFinite(stop.flood) ? stop.flood : HIGHSTAND_M;
    const opts = { minLevel: FLOOD_MIN_LEVEL, durationMs: FLOOD_MS };
    if (APP.flood && typeof APP.flood.animate === 'function') {
      /* flood.js's mobile/LITE fallback path leaves its promise pending when
       * cancelled mid-stage (animateFallback's cancel() clears the stage timer
       * without resolving), so the await gets a deadline. */
      await withDeadline(APP.flood.animate(target, opts), FLOOD_MS + 9000);
    } else if (!runAction('flood:animate', target, opts)) {
      /* No flood module at all: fall back to the static polygon if something
       * else can set it, otherwise the highstand ring alone tells the story. */
      runAction('flood:set', target);
    }
    return;
  }

  if (stop.action === 'play-timeline') {
    await cameraSettled(FLY_MS);
    if (token !== runToken || !active) return;
    const speed = stop.speed || 'fast';
    if (!runAction('play-timeline', { speed })) {
      console.warn('[jezero] tour stop 4: timeline.js did not register ' +
                   '"play-timeline" - the traverse will not animate.');
    }
  }
}

/* ---------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------ */
function goNext() {
  if (!active) return;
  if (index >= TOUR.length - 1) {
    /* Finishing takes the same exit as the close button: the pre-tour view
     * comes back, which is the natural place to start exploring by hand. */
    exitTour({ reason: 'finish' });
    notify('That is the tour. The map is yours - drag, zoom, and drag the sol ' +
           'slider to replay the mission.');
    return;
  }
  enterStop(index + 1, { push: true });
}

/**
 * Card Back mirrors the browser Back button rather than competing with it: if
 * this session pushed a history entry, walk it; otherwise (a `tour=` deep link
 * dropped us mid-tour) step the stop directly.
 */
function goBack() {
  if (!active || index <= 0) return;
  if (pushDepth > 0) {
    try { history.back(); return; } catch { /* fall through */ }
  }
  enterStop(index - 1, {});
}

function gotoStop(n, o = {}) {
  const idx = clamp(Math.round(n) - 1, 0, TOUR.length - 1);
  if (!active) { startTour({ stop: idx + 1 }); return; }
  if (idx === index) return;
  enterStop(idx, o);
}

/* ---------------------------------------------------------------------------
 * Interruptions (§4.10)
 *
 * A hand on the map does NOT end the tour - it only cancels whatever the
 * current stop was doing on its own. Next/Back keep working; the card stays.
 * Only user-driven camera events count, so the tour's own flyTo can never
 * interrupt itself: dragstart / wheel / boxzoomstart are user-only in
 * MapLibre, and zoom/rotate/pitch starts are gated on e.originalEvent.
 * ------------------------------------------------------------------------ */
function onUserGesture() {
  if (!active) return;
  runToken += 1;                 // stale-out any awaiting stop action
  cancelStopActions();
}

function wireInterruptions() {
  const always = ['dragstart', 'wheel', 'boxzoomstart'];
  const gated = ['zoomstart', 'rotatestart', 'pitchstart'];

  for (const ev of always) {
    const fn = () => onUserGesture();
    MAP.on(ev, fn);
    detachers.push(() => MAP.off(ev, fn));
  }
  for (const ev of gated) {
    const fn = (e) => { if (e && e.originalEvent) onUserGesture(); };
    MAP.on(ev, fn);
    detachers.push(() => MAP.off(ev, fn));
  }

  /* Manually entering Ingenuity mode is a different intent from the tour -
   * leave gracefully and put the world back. The capture-phase listener sees
   * the click before ingenuity.js toggles the mode. */
  const onClick = (e) => {
    if (!active || !e.target || !e.target.closest) return;
    if (e.target.closest('#ing-mode-btn')) exitTour({ reason: 'ingenuity' });
  };
  document.addEventListener('click', onClick, true);
  detachers.push(() => document.removeEventListener('click', onClick, true));

  /* ingenuity.js emits 'flight' only for a user-driven selection (selectFlight
   * with fromHash unset) - our own stop-7 bridge is masked by the timestamp. */
  const offFlight = APP.on('flight', () => {
    if (!active) return;
    if (performance.now() < ignoreFlightUntil) return;
    exitTour({ reason: 'ingenuity' });
  });
  detachers.push(offFlight);

  /* Keys: <- previous, -> next, Esc leave. Arrows are yielded to text fields,
   * selects and range inputs (the sol slider keeps its own arrow keys); Esc
   * always reaches the tour. Buttons are NOT excluded, because the card's own
   * Next button is where the tour puts keyboard focus. */
  const onKey = (e) => {
    if (!active) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable ||
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) {
      if (e.key !== 'Escape') return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (e.key === 'Escape') { e.preventDefault(); exitTour({ reason: 'escape' }); }
  };
  window.addEventListener('keydown', onKey);
  detachers.push(() => window.removeEventListener('keydown', onKey));

  /* History. hash.js's own popstate handler emits 'tour:pop' from the pushed
   * state object, but its debounced replaceState (fired on every moveend
   * during a stop) rewrites that entry's state WITHOUT the tour field - so the
   * URL's `tour=` key is the only reliable signal. Both are handled, and
   * gotoStop() de-duplicates when they arrive together. */
  const onPop = () => {
    if (!active) return;
    if (unwinding > 0) { unwinding -= 1; return; }
    const raw = parseHash(location.hash).scalars.tour;
    if (!Number.isFinite(raw) || raw < 1) {
      /* Walked back out through the tour's doorway entry - leave, and leave
       * the history alone: the browser already did the unwinding. */
      pushDepth = 0;
      exitTour({ reason: 'back-out', keepHistory: true });
      return;
    }
    const target = clamp(Math.round(raw), 1, TOUR.length);
    /* Back shrinks the pushed depth, Forward grows it again, so the card's
     * Back button keeps choosing history.back() only while there is really
     * something of ours to walk. */
    pushDepth = target < index + 1 ? Math.max(0, pushDepth - 1) : pushDepth + 1;
    gotoStop(target, { fromHistory: true });
  };
  window.addEventListener('popstate', onPop);
  detachers.push(() => window.removeEventListener('popstate', onPop));
}

/* ---------------------------------------------------------------------------
 * Enter / leave
 * ------------------------------------------------------------------------ */
/** @param {{stop?:number}} [o] 1-based stop to open on (default 1) */
function startTour(o = {}) {
  if (!APP || !MAP) return;
  const target = clamp(Math.round(Number(o.stop) || 1), 1, TOUR.length);

  if (active) { gotoStop(target); return; }

  snapshot = takeSnapshot();
  active = true;
  pushDepth = 0;
  unwinding = 0;
  terrainNoted = false;
  index = -1;

  document.body.classList.add('tour');
  if (!cardEl) buildCard();
  wireInterruptions();

  /* Entry replaces rather than pushes, so the entry the user was already on
   * becomes the tour's doorway: walking back out of stop 1 lands exactly where
   * they started. Advances (Next) push from here. */
  enterStop(target - 1, {});

  if (nextBtn) {
    /* Give the keyboard somewhere sensible to be, without stealing focus on
     * touch (where the focus ring would just be noise). */
    if (window.matchMedia('(hover: hover)').matches) nextBtn.focus({ preventScroll: true });
  }
  APP.emit('tour', { active: true, stop: target });
}

/**
 * @param {{reason?:string, keepHistory?:boolean}} [o]
 *   keepHistory true when a popstate already walked us out of the tour, so
 *   there is nothing left to unwind.
 */
function exitTour(o = {}) {
  if (!active) return;
  active = false;
  runToken += 1;

  const depth = pushDepth;
  pushDepth = 0;
  reentryBlockUntil = performance.now() + 1500 + 60 * depth;
  const snap = snapshot;
  snapshot = null;
  index = -1;

  for (const off of detachers) {
    try { off(); } catch (err) { console.warn('[jezero] tour: detach failed -', err); }
  }
  detachers = [];

  document.body.classList.remove('tour');
  if (cardEl) cardEl.hidden = true;

  cancelStopActions();
  restoreSnapshot(snap);

  /* Clear `tour=` (hash.js's serialize() reads app.tourStop) and hand the Back
   * button back. Unwinding the entries this session pushed returns the user to
   * the history position they started from, instead of leaving N tour URLs
   * between them and wherever they came from. */
  APP.tourStop = 0;
  if (!o.keepHistory && depth > 0) {
    unwinding = depth;
    /* V5 fix, 2026-08-23: the entry history.go() lands on is the tour's doorway,
     * and hash.js's debounced replaceState rewrote that entry during stop 1's
     * flight - so its URL carries stop 1's camera and sol, not the pre-tour
     * view. Landing on it fires a hashchange, and hash.js applied it straight
     * over the restore above: Esc after Next x7 came back at stop 1
     * (z14.20 / sol 0) instead of the opening view (z10.80 / sol 1955).
     * restoreSnapshot() is the authority while we unwind; hash.js reads this
     * flag and stands down until the timer below clears it. */
    APP.tourUnwinding = true;
    try {
      history.go(-depth);
    } catch (err) {
      unwinding = 0;
      APP.tourUnwinding = false;
      console.warn('[jezero] tour: could not unwind history -', err);
    }
    /* The go() is asynchronous and may deliver fewer events than asked for
     * (an embedded webview that refuses history writes delivers none), so the
     * suppression is always released on a timer and the URL normalised then. */
    setTimeout(() => {
      unwinding = 0;
      APP.tourUnwinding = false;
      APP.tourStop = 0;
      if (typeof APP.writeHash === 'function') APP.writeHash();
    }, 250 + 60 * depth);
  } else if (typeof APP.writeHash === 'function') {
    APP.writeHash();
  }

  APP.emit('tour', { active: false, reason: o.reason || 'exit' });
}

/* ---------------------------------------------------------------------------
 * init - called once by ui.js's loadFeatureModules, after the map, the initial
 * hash and the core data set all exist (see boot.js step 6).
 * ------------------------------------------------------------------------ */
export function init(app) {
  APP = app;
  MAP = app.map;
  if (!MAP) {
    console.warn('[jezero] tour.js: no map - the tour is unavailable.');
    return;
  }

  ensureStyle();
  buildCard();

  /* The sidebar's "START THE TOUR" button already exists in index.html and
   * ui.js enables it the moment this action is registered. */
  registerAction('tour:start', (arg) => {
    const stop = typeof arg === 'number' ? arg
      : (arg && Number.isFinite(arg.stop) ? arg.stop : 1);
    startTour({ stop });
  });
  /* Additive conveniences for a dome control surface / future UI. */
  registerAction('tour:exit', () => exitTour({ reason: 'action' }));
  registerAction('tour:goto', (n) => gotoStop(Number(n)));

  /* hash.js emits this from its initial parse (before this module loaded) and
   * on every later hashchange. The initial one is gone by now, so the load-time
   * deep link is read straight off the URL below. */
  app.on('hash:tour', ({ stop }) => {
    if (!Number.isFinite(stop)) return;
    /* Unwinding the tour's history on exit walks back through URLs that still
     * carry `tour=`; those must not drag the visitor back into the tour. */
    if (unwinding > 0 || performance.now() < reentryBlockUntil) return;
    gotoStop(stop, { fromHistory: true });
  });

  /* hash.js's own popstate -> 'tour:pop' path. Kept as a second source (see
   * the note in wireInterruptions about replaceState dropping state.tour);
   * gotoStop() no-ops when it names the stop we are already on. */
  app.on('tour:pop', ({ stop }) => {
    if (!active || unwinding > 0) return;
    if (Number.isFinite(stop) && stop >= 1) gotoStop(stop, { fromHistory: true });
  });

  /* A backgrounded tab stops delivering rAF, so flood.js's frame-time guard
   * would abort the tide on resume and toast "running slowly" at a visitor who
   * merely took a phone call. Settle the lake to its finished level instead and
   * stale out the pending await. Playback is left alone - timeline.js already
   * pauses and resumes its own loop on these events. */
  app.on('pause', () => {
    if (!active) return;
    const stop = TOUR[index];
    runToken += 1;
    if (stop && stop.action === 'flood-rise') {
      const target = Number.isFinite(stop.flood) ? stop.flood : HIGHSTAND_M;
      if (APP.flood && typeof APP.flood.setLevel === 'function') APP.flood.setLevel(target);
      else runAction('flood:set', target);
    }
  });
  app.on('contextlost', () => { if (active) exitTour({ reason: 'contextlost' }); });

  app.tour = {
    start: (n) => startTour({ stop: n }),
    exit: () => exitTour({ reason: 'api' }),
    goto: (n) => gotoStop(Number(n)),
    next: goNext,
    back: goBack,
    isActive: () => active,
    stop: () => (active ? index + 1 : 0),
    stops: TOUR.length,
  };

  /* Deep link: `#...&tour=3` opens straight into stop 3, and the pre-tour
   * snapshot is the state the hash itself just applied - so closing the card
   * returns the visitor to the view their QR code pointed at. */
  const deep = parseHash(location.hash).scalars.tour;
  if (Number.isFinite(deep) && deep >= 1) {
    startTour({ stop: clamp(Math.round(deep), 1, TOUR.length) });
  }
}
