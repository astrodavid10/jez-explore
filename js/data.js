/* =============================================================================
 * Jez Explore — data.js
 *
 * Loads the pipeline's data/ files into the (initially empty) GeoJSON sources
 * and provides the two live NASA helpers.
 *
 * Failure philosophy (§7): Promise.allSettled, never Promise.all. A missing
 * file costs exactly one disabled toggle. Nothing here can stop the map from
 * opening, and with data/ entirely absent every layer simply stays empty.
 *
 * Exports:
 *   initData(app)                     kicks off the core load, wires helpers
 *   fetchCurrentPosition()            -> Feature | null   (§4.9)
 *   fetchCurrentHeliPosition()        -> Feature | null
 *   fetchRawImages(sol)               -> [{thumb, full, camera, ...}] up to 4 (§0.6)
 *
 * Attached to app:
 *   app.data                          { key: parsed JSON }   (only what loaded)
 *   app.dataAvailable(key)            boolean
 *   app.ensureData(key)               Promise — loads on demand, dedupes
 *   app.setPaleolakeLevel(level)      -3200 … -2350; swaps the flood polygons
 *   app.fetchCurrentPosition, app.fetchCurrentHeliPosition, app.fetchRawImages
 *
 * Events emitted on the bus:
 *   'data'         { key, ok, data?, error? }   per file, always
 *   'data:missing' { key }                      convenience for toggle disabling
 *   'data:ready'   { available:[], missing:[] } after the core set settles
 *   'live'         { ok, rover?, heli?, sol? }  after a current-position fetch
 * ========================================================================== */

import {
  DATA_FILES, HELI_ALT_TEMPLATE, PALEOLAKE_LEVELS, HIGHSTAND_M, NASA, SNAPSHOT,
  GLOBAL_STATE,
} from './config.js';
import { registerAction, toast } from './ui.js';

/* Which style source each data file feeds. Keys not listed here are data-only
 * (heli-flights.json, snapshot.json) or are swapped in by a feature module. */
const SOURCE_OF = {
  waypoints: 'waypoints',
  traverse: 'traverse',
  traverseLite: 'traverse',
  heliPaths: 'heli-paths',
  samples: 'samples',
  depot: 'depot',
  ellipse: 'ellipse',
  highstand: 'highstand',
  places: 'places',
};

/** Loaded eagerly at boot — the initial-payload budget (§2, < 300 KB gz). */
const CORE_KEYS = [
  'snapshot', 'waypoints', 'traverse', 'samples', 'depot', 'ellipse',
  'places', 'highstand',
];

/** Loaded on idle after the core set, or on demand via ensureData(). */
const DEFERRED_KEYS = [
  'heliFlights', 'heliPaths',
  'paleolake2500', 'paleolake2450', 'paleolake2395', 'paleolake2350',
];

const store = Object.create(null);      // key -> parsed JSON
const inFlight = new Map();             // key -> Promise
const failed = new Set();
let APP = null;

/* ---------------------------------------------------------------------------
 * Low-level fetch
 * ------------------------------------------------------------------------ */
async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function pushToSource(key, data) {
  const app = APP;
  if (!app || !app.map) return;
  const srcId = SOURCE_OF[key];
  if (!srcId) return;
  const src = app.map.getSource(srcId);
  if (!src || typeof src.setData !== 'function') return;
  /* A FeatureCollection is expected; anything else is a pipeline bug, and
   * setData would throw inside MapLibre where it is harder to see. */
  if (!data || data.type !== 'FeatureCollection') {
    console.warn(`[jezero] ${DATA_FILES[key]} is not a FeatureCollection — not loaded.`);
    return;
  }
  src.setData(data);
}

/**
 * @param {string} key a key of DATA_FILES
 * @param {{reload?:boolean}} [o]
 * @returns {Promise<any|null>} null on any failure (never throws)
 */
function loadOne(key, o = {}) {
  const url = DATA_FILES[key];
  if (!url) {
    console.error(`[jezero] unknown data key "${key}"`);
    return Promise.resolve(null);
  }
  if (!o.reload) {
    if (key in store) return Promise.resolve(store[key]);
    if (inFlight.has(key)) return inFlight.get(key);
  }

  const p = fetchJSON(url, { cache: o.reload ? 'reload' : 'default' })
    .then((data) => {
      store[key] = data;
      failed.delete(key);
      pushToSource(key, data);
      APP?.emit('data', { key, ok: true, data });
      return data;
    })
    .catch((err) => {
      failed.add(key);
      /* Expected before the pipeline runs — info, not error. */
      console.info(`[jezero] ${url} unavailable (${err.message}) — the layers and ` +
                   'controls that need it stay off.');
      APP?.emit('data', { key, ok: false, error: err });
      APP?.emit('data:missing', { key });
      return null;
    })
    .finally(() => { inFlight.delete(key); });

  inFlight.set(key, p);
  return p;
}

/* ---------------------------------------------------------------------------
 * Paleolake level swapping (§4.5 mechanism 1)
 * ------------------------------------------------------------------------ */
function keyForLevel(level) {
  const nearest = PALEOLAKE_LEVELS.reduce(
    (best, l) => (Math.abs(l - level) < Math.abs(best - level) ? l : best),
    PALEOLAKE_LEVELS[0]
  );
  return { key: `paleolake${Math.abs(nearest)}`, level: nearest };
}

async function setPaleolakeLevel(level) {
  const { key, level: snapped } = keyForLevel(level);
  const data = await loadOne(key);
  const app = APP;
  if (!app || !app.map) return null;
  const src = app.map.getSource('paleolake');
  if (data && src) src.setData(data);
  if (app.map.getGlobalState) app.map.setGlobalStateProperty(GLOBAL_STATE.FLOOD, snapped);
  app.emit('flood', { level: snapped, ok: !!data });
  return snapped;
}

/* ---------------------------------------------------------------------------
 * Live NASA helpers
 * ------------------------------------------------------------------------ */
function firstFeature(fc) {
  if (!fc) return null;
  if (fc.type === 'Feature') return fc;
  if (Array.isArray(fc.features) && fc.features.length) return fc.features[0];
  return null;
}

/**
 * "Where is Percy now?" (§4.9). One small file, hard 6 s ceiling, never blocks
 * anything. Failure is a null return plus an amber badge — the snapshot stands.
 * @returns {Promise<object|null>} a GeoJSON Feature, or null
 */
export async function fetchCurrentPosition() {
  const url = NASA.BASE + NASA.WAYPOINTS_CURRENT;
  try {
    const fc = await fetchJSON(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NASA.TIMEOUT_MS),
    });
    const f = firstFeature(fc);
    if (!f) throw new Error('no features in the current-position response');
    const sol = Number(f.properties?.sol ?? f.properties?.Sol);
    APP?.emit('live', { ok: true, rover: f, sol: Number.isFinite(sol) ? sol : null });
    APP?.emit('badge', { state: 'live', sol: Number.isFinite(sol) ? sol : undefined });
    return f;
  } catch (err) {
    console.info('[jezero] live rover position unavailable:', err.name || err.message);
    APP?.emit('live', { ok: false, error: err });
    APP?.emit('badge', {
      state: 'amber',
      note: `Data as of sol ${APP?.manifest?.snapshot_sol ?? SNAPSHOT.sol} · NASA unreachable`,
    });
    APP?.emit('toast', {
      msg: "Couldn't reach NASA for the latest position — showing the stored snapshot.",
      kind: 'warn',
    });
    return null;
  }
}

/** Same, for Ingenuity's last known position. @returns {Promise<object|null>} */
export async function fetchCurrentHeliPosition() {
  try {
    const fc = await fetchJSON(NASA.BASE + NASA.HELI_CURRENT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(NASA.TIMEOUT_MS),
    });
    return firstFeature(fc);
  } catch (err) {
    console.info('[jezero] live heli position unavailable:', err.name || err.message);
    return null;
  }
}

/**
 * Raw images for a sol, for waypoint popups (§0.6).
 *
 * The API's own `condition_1=...:instrument:in` camera filter is silently
 * IGNORED (verified), so we ask for 40 images from the sol and choose
 * client-side by camera preference.
 *
 * @param {number} sol
 * @param {number} [want] how many to return (default 4)
 * @returns {Promise<Array<{imageid:string, sol:number, camera:string, thumb:string, full:string, date:string}>>}
 */
export async function fetchRawImages(sol, want = 4) {
  const s = Math.max(0, Math.round(Number(sol) || 0));
  const url = `${NASA.RAW_IMAGES}&num=40&page=0&order=sol+desc` +
              `&condition_2=${s}%3Asol%3Agte&condition_3=${s}%3Asol%3Alte`;
  try {
    const json = await fetchJSON(url, { signal: AbortSignal.timeout(NASA.TIMEOUT_MS) });
    const images = Array.isArray(json.images) ? json.images : [];
    const rank = (cam) => {
      const i = NASA.CAMERA_PREFERENCE.indexOf(cam);
      return i < 0 ? NASA.CAMERA_PREFERENCE.length : i;
    };
    const picked = images
      .map((im) => ({
        imageid: im.imageid,
        sol: im.sol,
        camera: (im.camera && im.camera.instrument) || '',
        date: im.date_taken_utc || '',
        thumb: (im.image_files && (im.image_files.small || im.image_files.medium)) || '',
        full: (im.image_files && (im.image_files.large || im.image_files.full_res ||
               im.image_files.medium)) || '',
      }))
      .filter((im) => im.thumb)
      .sort((a, b) => rank(a.camera) - rank(b.camera));
    return picked.slice(0, want);
  } catch (err) {
    /* §7: the thumbnail strip is hidden; the popup is still complete. */
    console.info(`[jezero] raw-images API unavailable for sol ${s}:`, err.name || err.message);
    return [];
  }
}

/** Per-flight altitude arrays, lazily (§2). @returns {Promise<object|null>} */
export async function fetchHeliAltitude(flight) {
  const nn = String(Math.round(flight)).padStart(2, '0');
  const url = HELI_ALT_TEMPLATE.replace('{NN}', nn);
  try {
    return await fetchJSON(url);
  } catch (err) {
    console.info(`[jezero] ${url} unavailable:`, err.message);
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * initData
 * ------------------------------------------------------------------------ */
export function initData(app) {
  APP = app;
  app.data = store;
  app.dataAvailable = (key) => key in store && store[key] !== null;
  app.ensureData = (key) => loadOne(key);
  app.setPaleolakeLevel = setPaleolakeLevel;
  app.fetchCurrentPosition = fetchCurrentPosition;
  app.fetchCurrentHeliPosition = fetchCurrentHeliPosition;
  app.fetchRawImages = fetchRawImages;
  app.fetchHeliAltitude = fetchHeliAltitude;
  app.dataFailed = failed;

  /* Lite mode swaps in the 6 m-decimated traverse (§5). Same source id, so no
   * layer or expression anywhere needs to know. */
  const core = CORE_KEYS.map((k) => (k === 'traverse' && app.lite ? 'traverseLite' : k));

  const settle = Promise.allSettled(core.map((k) => loadOne(k)));

  settle.then(() => {
    const available = core.filter((k) => k in store);
    const missing = core.filter((k) => !(k in store));
    /* snapshot.json is the authority for the initial sol; the manifest is the
     * fallback. Both agree in a healthy build. */
    const snap = store.snapshot;
    if (snap && Number.isFinite(snap.sol)) {
      app.snapshot = snap;
      app.maxSol = Math.max(app.maxSol || 0, snap.sol);
      app.emit('badge', { state: 'snapshot', sol: snap.sol });
    } else {
      app.snapshot = { ...SNAPSHOT, sol: app.manifest?.snapshot_sol ?? SNAPSHOT.sol };
      app.maxSol = app.maxSol || app.snapshot.sol;
    }
    app.emit('data:ready', { available, missing });
    if (missing.length === core.length) {
      console.info('[jezero] no data/ files found — the map is running on tiles ' +
                   'alone. Run the pipeline (p08/p10) and copy out/data → site/data.');
    }

    /* Deferred set on idle: present when a feature module wants it, but never
     * competing with the first paint. */
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
    idle(() => {
      for (const k of DEFERRED_KEYS) loadOne(k);
    });
  });

  /* The About panel's "Update all mission data from NASA" link (§4.9). It
   * re-reads the staged data/ files bypassing the HTTP cache and asks NASA for
   * the current positions. Re-slimming NASA's full 2.3 MB traverse is a
   * pipeline job (p08/p09), not something to do in the browser. */
  registerAction('data:refresh-all', async () => {
    toast('Refreshing mission data…');
    const keys = [...core, ...DEFERRED_KEYS.filter((k) => k in store)];
    await Promise.allSettled(keys.map((k) => loadOne(k, { reload: true })));
    const f = await fetchCurrentPosition();
    toast(f ? 'Mission data refreshed, and NASA answered with the latest position.'
      : 'Local mission data refreshed. NASA did not answer — the snapshot stands.',
    { kind: f ? 'info' : 'warn' });
  });

  return settle;
}

/** Exported for feature modules that want the level table without importing config. */
export { PALEOLAKE_LEVELS, HIGHSTAND_M };
