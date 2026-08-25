/* =============================================================================
 * Jez Explore — flood.js
 *
 * Owns the paleolake flood + hypsometric elevation-colors behaviors
 * (docs/frontend-design.md §4.5, §3.2 layer ids flood-fill / flood-tide /
 * highstand-ring / hypsometric, §2 paleolake-{2500,2450,2395,2350}.geojson).
 *
 * Two flood mechanisms, per the "honest feasibility" writeup:
 *   1. Default (ships everywhere): precomputed basin polygons on the `paleolake`
 *      source, swapped by app.setPaleolakeLevel() (already implemented in
 *      data.js — this module builds on it, it does NOT re-fetch or re-setData
 *      the polygons itself) + a `flood-fill` opacity cross-fade + the
 *      `highstand-ring` shoreline.
 *   2. Tour-stop-3 garnish (desktop, non-LITE, `flood-tide` layer present in
 *      the style): an animated color-relief rising tide via
 *      map.setPaintProperty('flood-tide','color-relief-color', floodRamp(L)),
 *      throttled to ~12 fps, that swaps to the static fill on completion.
 *      Falls back to a staged setData walk through the 4 polygon levels when
 *      the tide layer is unavailable (mobile / LITE / style omitted it).
 *
 * ---------------------------------------------------------------------------
 * Action API (registered with ui.js's registerAction — see ui.js header):
 *
 *   'flood:set'    (level:number|null) => Promise<number|null>
 *       Show the static basin polygon nearest `level` (snapped to one of
 *       config.js PALEOLAKE_LEVELS by app.setPaleolakeLevel), cross-fading
 *       fill-opacity 0 -> 0.55 the first time flood turns on, and showing
 *       highstand-ring. `null`/`undefined`/`false`/`0` turns the flood off
 *       (fades out, hides highstand-ring). No-ops with a toast if the data
 *       file for that level cannot be loaded, or if there is no map yet.
 *   'flood:off'    () => Promise<null>
 *       Convenience alias for flood:set(null).
 *   'flood:animate'(targetLevel:number, opts?) => Promise<void>
 *       Tour stop 3's "Fill the Lake": rises from opts.minLevel (default
 *       -2700) to targetLevel over opts.durationMs (default 6000) at
 *       opts.fps (default 12) using the flood-tide color-relief ramp, then
 *       swaps to the static fill at targetLevel. Guarded to desktop +
 *       non-LITE + flood-tide present in the style; otherwise runs the
 *       fallback staged walk (see below). The returned promise resolves once
 *       the animation has fully settled either way (finished, aborted by the
 *       frame-time guard, or canceled) — opts.onDone(completedCleanly:bool)
 *       fires at that same moment, so either can be used to sequence a tour
 *       step's "Next" affordance.
 *   'flood:cancel' () => void
 *       Stops whatever flood animation is in progress (tide or fallback),
 *       leaving whatever polygon was last shown on screen.
 *   'hypsometric:ramp'(opts?: {min,max,opacity}) => boolean
 *       Rebuilds the "Elevation colors" color-relief ramp (default
 *       -2750 -> -1550, matching style.js's static default) — for the tour
 *       or any future adjustment UI. Returns false (+ toast) if the
 *       `hypsometric` layer isn't in the style (LITE omits it).
 *
 * Also mirrored on the app namespace, per the shell's app.set3D()-style
 * pattern, for modules that would rather call directly than go through
 * runAction():
 *   app.flood = { setLevel, off, animate, cancel, isOn, getLevel, tideAvailable }
 *   app.hypsometric = { setRamp }
 *
 * Events emitted on the bus (distinct from data.js's own 'flood' event, which
 * this module also listens to in order to detect ensureData failures):
 *   'flood:change' { level, on, mode: 'fill'|'tide' }   whenever flood state settles
 *
 * Hash conformance (§4.11): the `fl` ON_KEY (-> ['flood-fill','highstand-ring'])
 * is applied generically by hash.js via plain layer-visibility toggles — this
 * module does not duplicate that. What hash.js CANNOT do is load the polygon
 * data (the `paleolake` source starts empty, per style.js) or pick a level (no
 * scalar hash key encodes one). So this module, once loaded, checks whether
 * flood-fill is already visible (an `on=fl` permalink applied before this
 * module's init() ran) and on every later 'hashstate' event, and ensures the
 * data for a sensible level (the map's current global-state FLOOD if it holds
 * a real level, else HIGHSTAND_M) gets loaded into the source.
 *
 * The frame-time guard from §7 (animation frame > ~90 ms -> abort to the
 * static fill + toast once) is implemented for the flood-tide rAF loop; the
 * fallback staged walk has no per-frame paint loop (discrete setData swaps on
 * a timer) so it has nothing analogous to guard.
 * ========================================================================== */

import { PALEOLAKE_LEVELS, HIGHSTAND_M, GLOBAL_STATE } from './config.js';
import { registerAction, toast, LITE } from './ui.js';
import { floodRamp } from './style.js';

/** Sentinel meaning "no flood level set" — matches style.js's initial state. */
const FLOOD_OFF_SENTINEL = -3000;

/** Same 10-stop palette as style.js's (unexported) hypsometricRamp(), so the
 * default here matches the style's built-in ramp exactly; parameterized on
 * min/max for 'hypsometric:ramp' adjustments. */
const HYPSO_COLORS = [
  '#2c1e3a', '#3b3a6b', '#3f6b8a', '#4f8f84', '#8a9a56',
  '#b99a4e', '#c87a45', '#d8a06e', '#e8cdae', '#f7f1e6',
];
const HYPSO_DEFAULT_MIN = -2750;
const HYPSO_DEFAULT_MAX = -1550;

let APP = null;

/**
 * The DEM encode offset (docs/frontend-design.md §9.3). Everything in this
 * module — global-state `flood`, currentLevel, PALEOLAKE_LEVELS, HIGHSTAND_M,
 * the static paleolake GeoJSON's `level` property — stays in REAL areoid
 * meters. The offset is applied at exactly two points, both of them an
 * `['elevation']` color ramp reading ENCODED tile values: floodRamp() and
 * buildHypsoRamp(). The static-polygon path never touches it.
 */
function elevOffset() {
  const m = APP && APP.manifest;
  return (m && m.dem && m.dem.elev_offset) || 0;
}

/* Flood state. `currentLevel` is retained across an off() so a future re-on
 * remembers the last level even though it is not authoritative until re-set. */
let floodOn = false;
let currentLevel = null;
let currentAnimation = null;    // { cancel() } | null
let pendingHideTimer = null;
let ensuringHashFlood = false;

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */
function isMobileLayout() {
  return window.matchMedia('(max-width: 899px)').matches;
}

function clearPendingHide() {
  if (pendingHideTimer) {
    clearTimeout(pendingHideTimer);
    pendingHideTimer = null;
  }
}

function emitChange(mode) {
  APP.emit('flood:change', { level: currentLevel, on: floodOn, mode });
}

/** Wrap a registered action so a rejected promise never becomes an unhandled
 * rejection (ui.js's runAction only catches SYNCHRONOUS throws). */
function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error('[jezero] flood.js action failed:', err);
      toast('Something went wrong with the paleolake flood.', { kind: 'error' });
      return null;
    }
  };
}

/**
 * Calls app.setPaleolakeLevel(target) (data.js — the single owner of
 * ensureData + setData for the paleolake source) and correlates its result
 * with the 'flood' bus event it emits ({level, ok}) so callers here can tell
 * a missing data file apart from a merely-different snapped level.
 * @returns {Promise<{ok:boolean, level:number|null}>}
 */
async function loadLevelData(target) {
  const app = APP;
  if (!app || !app.map || typeof app.setPaleolakeLevel !== 'function') {
    return { ok: false, level: null };
  }
  let evt = null;
  const off = app.on('flood', (d) => { evt = d; });
  let snapped = null;
  try {
    snapped = await app.setPaleolakeLevel(target);
  } finally {
    off();
  }
  if (evt && evt.level === snapped) return { ok: !!evt.ok, level: snapped };
  /* Unexpected event shape (or none) — data.js still returned a snapped
   * level, so assume the data made it in rather than false-alarming. */
  return { ok: snapped !== null && snapped !== undefined, level: snapped };
}

/* ---------------------------------------------------------------------------
 * Static fill (mechanism 1 — the one that ships everywhere)
 * ------------------------------------------------------------------------ */
function hideTideLayer() {
  const map = APP.map;
  if (map.getLayer('flood-tide')) {
    map.setLayoutProperty('flood-tide', 'visibility', 'none');
  }
}

function hideFillInstant() {
  const map = APP.map;
  if (map.getLayer('flood-fill')) {
    map.setLayoutProperty('flood-fill', 'visibility', 'none');
  }
}

/** @param {boolean} fadeIn true only on an off->on transition; false when
 *  already on (switching levels should not flicker the polygon). */
function showStaticFill(fadeIn) {
  const map = APP.map;
  clearPendingHide();
  hideTideLayer();
  if (map.getLayer('flood-fill')) {
    map.setLayoutProperty('flood-fill', 'visibility', 'visible');
    if (fadeIn) {
      map.setPaintProperty('flood-fill', 'fill-opacity', 0);
      requestAnimationFrame(() => {
        if (map.getLayer('flood-fill')) map.setPaintProperty('flood-fill', 'fill-opacity', 0.55);
      });
    } else {
      map.setPaintProperty('flood-fill', 'fill-opacity', 0.55);
    }
  }
  if (map.getLayer('highstand-ring')) {
    map.setLayoutProperty('highstand-ring', 'visibility', 'visible');
  }
}

function fadeOff() {
  const app = APP;
  const map = app.map;
  cancelAnimation();
  clearPendingHide();
  if (map.getLayer('flood-fill')) {
    map.setPaintProperty('flood-fill', 'fill-opacity', 0);
  }
  hideTideLayer();
  if (map.getLayer('highstand-ring')) {
    map.setLayoutProperty('highstand-ring', 'visibility', 'none');
  }
  floodOn = false;
  /* Drop layout visibility after the opacity transition finishes, so a
   * hidden-but-still-'visible' layer isn't left costing hit-testing/paint. */
  pendingHideTimer = setTimeout(() => {
    pendingHideTimer = null;
    if (app.map && app.map.getLayer('flood-fill')) {
      app.map.setLayoutProperty('flood-fill', 'visibility', 'none');
    }
  }, 420);
  if (map.setGlobalStateProperty) {
    map.setGlobalStateProperty(GLOBAL_STATE.FLOOD, FLOOD_OFF_SENTINEL);
  }
  emitChange('fill');
  return null;
}

/**
 * @param {number|null|undefined|false} level one of PALEOLAKE_LEVELS (snapped
 *   to nearest by data.js) or a falsy value to turn the flood off.
 * @returns {Promise<number|null>} the snapped level actually applied, or null
 */
async function setLevel(level) {
  const app = APP;
  if (!app || !app.map || typeof app.setPaleolakeLevel !== 'function') {
    toast('Paleolake control is not available in this build.', { kind: 'warn' });
    return null;
  }
  cancelAnimation();
  clearPendingHide();

  if (level === null || level === undefined || level === false || level === 0) {
    return fadeOff();
  }
  const target = Number(level);
  if (!Number.isFinite(target)) return null;

  const wasOn = floodOn;
  const { ok, level: snapped } = await loadLevelData(target);
  if (!ok) {
    toast('Paleolake data for that level is not available yet.', { kind: 'warn' });
    return null;
  }
  showStaticFill(!wasOn);
  currentLevel = snapped;
  floodOn = true;
  emitChange('fill');
  return snapped;
}

function off() {
  return setLevel(null);
}

/* ---------------------------------------------------------------------------
 * Animated tide (mechanism 2 — tour-stop-3 garnish)
 * ------------------------------------------------------------------------ */
function tideAvailable() {
  const app = APP;
  if (!app || !app.map) return false;
  if (LITE) return false;
  if (isMobileLayout()) return false;
  return !!app.map.getLayer('flood-tide');
}

function cancelAnimation() {
  if (currentAnimation) {
    try { currentAnimation.cancel(); } catch (err) { console.warn('[jezero] flood animation cancel failed:', err); }
    currentAnimation = null;
  }
}

/** @returns {Promise<boolean>} resolves once settled (cleanly or aborted) —
 *  mirrors animateFallback's timing so animate() can `await` either path
 *  uniformly; opts.onDone fires at the same moment either way. */
function animateTide(target, opts) {
  const app = APP;
  const map = app.map;
  const minLevel = Number.isFinite(opts.minLevel) ? opts.minLevel : -2700;
  const durationMs = opts.durationMs || 6000;
  const fps = opts.fps || 12;
  const frameBudget = 1000 / fps;

  hideFillInstant();
  if (map.getLayer('flood-tide')) {
    map.setPaintProperty('flood-tide', 'color-relief-color', floodRamp(minLevel, elevOffset()));
    map.setLayoutProperty('flood-tide', 'visibility', 'visible');
  }

  let aborted = false;
  let toasted = false;
  let rafId = null;
  const startTime = performance.now();
  let lastFrame = startTime;
  let lastUpdate = 0;

  return new Promise((resolve) => {
  function settle(clean) {
    currentAnimation = null;
    if (map.getLayer('flood-tide')) {
      map.setPaintProperty('flood-tide', 'color-relief-color', floodRamp(target, elevOffset()));
    }
    setLevel(target).then((snapped) => {
      currentLevel = snapped ?? target;
      if (!clean && !toasted) {
        toasted = true;
        toast('The animated flood was running slowly, so it switched to the standard view.', { kind: 'warn' });
      }
      emitChange('fill');
      if (typeof opts.onDone === 'function') opts.onDone(clean);
      resolve(clean);
    });
  }

  function tick(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    /* §7 frame-time guard: a single stalled frame aborts to the static fill
     * rather than let the animation limp along. */
    if (dt > 90) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (!aborted) { aborted = true; settle(false); }
      return;
    }
    const elapsed = now - startTime;
    if (elapsed - lastUpdate >= frameBudget || lastUpdate === 0) {
      lastUpdate = elapsed;
      const t = Math.min(1, elapsed / durationMs);
      const L = minLevel + (target - minLevel) * t;
      if (map.getLayer('flood-tide')) {
        map.setPaintProperty('flood-tide', 'color-relief-color', floodRamp(L, elevOffset()));
      }
    }
    if (elapsed >= durationMs) {
      rafId = null;
      settle(true);
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  currentAnimation = {
    cancel() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      hideTideLayer();
      resolve(false);
    },
  };
  rafId = requestAnimationFrame(tick);
  });
}

/** Mobile / LITE / no-flood-tide fallback: a staged setData walk through the
 * basin levels up to the target, ~2 s per stage, opacity cross-fade on the
 * first one only. */
async function animateFallback(target, opts) {
  const app = APP;
  const map = app.map;
  const stageMs = opts.stageMs || 2000;
  const snapTarget = PALEOLAKE_LEVELS.reduce(
    (best, l) => (Math.abs(l - target) < Math.abs(best - target) ? l : best),
    PALEOLAKE_LEVELS[0]
  );
  const levels = PALEOLAKE_LEVELS.filter((l) => l <= snapTarget);
  if (!levels.length) levels.push(PALEOLAKE_LEVELS[0]);

  let canceled = false;
  let timer = null;
  let wakeStage = null;           /* resolver of the inter-stage sleep */
  currentAnimation = {
    cancel() {
      canceled = true;
      if (timer) clearTimeout(timer);
      /* Settle the pending sleep, otherwise the loop hangs at its await and
       * the promise/onDone never fire (found by the tour agent, 2026-08-23). */
      if (wakeStage) wakeStage();
    },
  };

  hideTideLayer();
  const wasOn = floodOn;
  let reachedAny = false;

  /* Every exit path funnels through finish(): clears the animation handle and
   * always fires onDone, so awaiting callers settle on cancel too. */
  const finish = (clean) => {
    currentAnimation = null;
    emitChange('fill');
    if (typeof opts.onDone === 'function') opts.onDone(clean);
    return clean;
  };

  for (let i = 0; i < levels.length; i++) {
    if (canceled) return finish(false);
    const { ok, level: snapped } = await loadLevelData(levels[i]);
    if (canceled) return finish(false);
    if (!ok) {
      toast('Paleolake data is not fully available — showing what loaded.', { kind: 'warn' });
      break;
    }
    showStaticFill(i === 0 && !wasOn);
    currentLevel = snapped;
    floodOn = true;
    reachedAny = true;
    if (i < levels.length - 1) {
      await new Promise((resolve) => { wakeStage = resolve; timer = setTimeout(resolve, stageMs); });
      wakeStage = null;
      if (canceled) return finish(false);
    }
  }

  return finish(reachedAny && !canceled);
}

/**
 * @param {number} [targetLevel] defaults to the highstand (-2395, tour stop 3)
 * @param {{minLevel?:number, durationMs?:number, fps?:number, stageMs?:number,
 *          onDone?:(cleanly:boolean)=>void}} [opts]
 */
async function animate(targetLevel, opts = {}) {
  const app = APP;
  if (!app || !app.map) return;
  cancelAnimation();
  clearPendingHide();
  const target = Number.isFinite(Number(targetLevel)) ? Number(targetLevel) : HIGHSTAND_M;

  floodOn = true;
  if (app.map.getLayer('highstand-ring')) {
    app.map.setLayoutProperty('highstand-ring', 'visibility', 'visible');
  }

  /* Both branches resolve only once the animation has fully settled (cleanly
   * or aborted/canceled), so callers can `await animate(...)` uniformly;
   * opts.onDone(cleanly) fires at the same moment as this promise settling. */
  if (tideAvailable()) {
    await animateTide(target, opts);
  } else {
    await animateFallback(target, opts);
  }
}

/* ---------------------------------------------------------------------------
 * Hypsometric elevation-colors ramp
 * ------------------------------------------------------------------------ */
/** @param {number} min @param {number} max both in REAL areoid meters. */
function buildHypsoRamp(min = HYPSO_DEFAULT_MIN, max = HYPSO_DEFAULT_MAX) {
  const n = HYPSO_COLORS.length;
  const off = elevOffset();          // ['elevation'] yields ENCODED meters
  const expr = ['interpolate', ['linear'], ['elevation']];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    expr.push(min + (max - min) * t + off, HYPSO_COLORS[i]);
  }
  return expr;
}

/** Defensive: style.js already sets the default ramp when it builds the
 * `hypsometric` layer. Only (re)set it here if it is somehow missing. */
function ensureHypsoRampDefault() {
  const map = APP.map;
  if (!map.getLayer('hypsometric')) return;
  const existing = map.getPaintProperty('hypsometric', 'color-relief-color');
  if (!existing) {
    map.setPaintProperty('hypsometric', 'color-relief-color', buildHypsoRamp());
  }
}

/** @param {{min?:number, max?:number, opacity?:number}} [opts] */
function setHypsoRamp(opts = {}) {
  const map = APP.map;
  if (!map || !map.getLayer('hypsometric')) {
    toast('Elevation colors are not available in this build.', { kind: 'warn' });
    return false;
  }
  const min = Number.isFinite(opts.min) ? opts.min : HYPSO_DEFAULT_MIN;
  const max = Number.isFinite(opts.max) ? opts.max : HYPSO_DEFAULT_MAX;
  map.setPaintProperty('hypsometric', 'color-relief-color', buildHypsoRamp(min, max));
  if (Number.isFinite(opts.opacity)) {
    map.setPaintProperty('hypsometric', 'color-relief-opacity', opts.opacity);
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * Hash conformance (§4.11) — see header note. hash.js flips flood-fill /
 * highstand-ring visibility generically via the `fl` ON_KEY; this module fills
 * in the data + level that generic mechanism cannot know about.
 * ------------------------------------------------------------------------ */
function isFloodFillVisible() {
  const map = APP.map;
  if (!map || !map.getLayer('flood-fill')) return false;
  const vis = map.getLayoutProperty('flood-fill', 'visibility');
  return (vis ?? 'visible') !== 'none';
}

async function ensureDataForAlreadyVisibleFlood() {
  if (ensuringHashFlood || !isFloodFillVisible()) return;
  ensuringHashFlood = true;
  try {
    const app = APP;
    const map = app.map;
    const gs = map.getGlobalState ? map.getGlobalState() : null;
    const cur = gs ? gs[GLOBAL_STATE.FLOOD] : null;
    const level = Number.isFinite(cur) && cur > FLOOD_OFF_SENTINEL ? cur : HIGHSTAND_M;
    floodOn = true;   // hash already made the layer visible; don't re-fade it
    const { ok, level: snapped } = await loadLevelData(level);
    if (ok) {
      showStaticFill(false);
      currentLevel = snapped;
      emitChange('fill');
    } else {
      toast('Paleolake data is not available yet.', { kind: 'warn' });
    }
  } finally {
    ensuringHashFlood = false;
  }
}

/* ---------------------------------------------------------------------------
 * init — called by ui.js's loadFeatureModules once the map is ready, i.e.
 * after createMap(), initHash() (initial hash already applied) and initData()
 * have all run (see boot.js).
 * ------------------------------------------------------------------------ */
export function init(app) {
  APP = app;

  const map = app.map;
  if (map && map.getLayer('flood-fill')) {
    map.setPaintProperty('flood-fill', 'fill-opacity-transition', { duration: 400, delay: 0 });
  }
  ensureHypsoRampDefault();

  const setLevelSafe = safe(setLevel);
  const offSafe = safe(off);
  const animateSafe = safe(animate);

  registerAction('flood:set', setLevelSafe);
  registerAction('flood:off', offSafe);
  registerAction('flood:animate', animateSafe);
  registerAction('flood:cancel', cancelAnimation);
  registerAction('hypsometric:ramp', setHypsoRamp);

  app.flood = {
    setLevel: setLevelSafe,
    off: offSafe,
    animate: animateSafe,
    cancel: cancelAnimation,
    isOn: () => floodOn,
    getLevel: () => currentLevel,
    tideAvailable,
  };
  app.hypsometric = { setRamp: setHypsoRamp };

  /* An `on=fl` permalink is applied by hash.js's initial parse BEFORE this
   * module loads (initHash runs before the 'ready' event feature modules wait
   * on) — catch that case once here, then stay conformant on later changes. */
  ensureDataForAlreadyVisibleFlood();

  app.on('hashstate', (parsed) => {
    if (!parsed || !parsed.on) return;
    if (parsed.on.includes('fl')) {
      ensureDataForAlreadyVisibleFlood();
    } else if (floodOn || currentAnimation) {
      /* Hash explicitly turned `fl` off (hash.js already hid flood-fill and
       * highstand-ring) — stop any animation and drop the tide layer too,
       * since flood-tide is not itself a member of any ON_KEY group. */
      cancelAnimation();
      hideTideLayer();
      floodOn = false;
    }
  });
}
