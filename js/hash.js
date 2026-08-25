/* =============================================================================
 * Jezero Explorer — hash.js
 *
 * URL hash / permalink, exactly per docs/frontend-design.md §4.11:
 *
 *   #@77.45089,18.44463,15.20,62,285&sol=1215&exag=1.5&on=hs,cr,wp,samp,places&heli=72&tour=3&lite=1
 *
 *   @lon,lat,zoom,pitch,bearing     lon/lat 5 dp (≈0.6 m), zoom 2 dp, pitch and
 *                                   bearing whole degrees
 *   on=<short keys>                 visible layer groups; keys are FROZEN in
 *                                   config.js HASH_KEYS.ON_KEYS — printed QR
 *                                   codes outlive refactors
 *   sol, exag, heli, tour, lite, 3d scalars
 *
 * Rules that are not negotiable:
 *   - MapOptions has hash:false. We are the only writer.
 *   - Camera/state changes use history.replaceState, debounced 400 ms, so the
 *     Back button is not filled with pan noise.
 *   - pushState is RESERVED for tour steps, so phone Back walks the tour
 *     backwards (§4.10).
 *   - Every value is clamped. Unknown keys are ignored. A malformed hash gives
 *     the default view and never throws.
 *
 * Exports: initHash(app), parseHash(str), serialize(app), currentUrl(app)
 * Attaches: app.writeHash({push}), app.pushTourStep(n), app.copyLink(),
 *           app.scheduleHash()
 * ========================================================================== */

import { HASH_KEYS, VIEW, TUNING, TOUR, HELI_TOTALS, GLOBAL_STATE } from './config.js';

const ON_KEYS = HASH_KEYS.ON_KEYS;
const SCALAR_KEYS = HASH_KEYS.SCALAR_KEYS;

/* ---------------------------------------------------------------------------
 * Parsing — total tolerance. Anything unparsable is simply absent from the
 * result, and an absent value means "leave that part of the app alone".
 * ------------------------------------------------------------------------ */
/**
 * @param {string} raw location.hash, with or without the leading '#'
 * @returns {{cam?:object, on?:string[], scalars:object, raw:string}}
 */
export function parseHash(raw) {
  const out = { scalars: {}, raw: raw || '' };
  try {
    let s = String(raw || '');
    if (s.startsWith('#')) s = s.slice(1);
    if (!s) return out;
    for (const token of s.split('&')) {
      if (!token) continue;
      if (token.startsWith('@')) {
        const n = token.slice(1).split(',').map(Number);
        /* lon and lat are the only required members; the rest default. */
        if (Number.isFinite(n[0]) && Number.isFinite(n[1])) {
          out.cam = {
            lon: n[0],
            lat: n[1],
            zoom: Number.isFinite(n[2]) ? n[2] : undefined,
            pitch: Number.isFinite(n[3]) ? n[3] : undefined,
            bearing: Number.isFinite(n[4]) ? n[4] : undefined,
          };
        }
        continue;
      }
      const eq = token.indexOf('=');
      if (eq < 0) continue;
      const key = decodeURIComponent(token.slice(0, eq));
      const val = decodeURIComponent(token.slice(eq + 1));
      if (key === 'on') {
        out.on = val.split(',').filter((k) => Object.hasOwn(ON_KEYS, k));
        continue;
      }
      const kind = SCALAR_KEYS[key];
      if (!kind) continue;                       // unknown key: ignored, silently
      if (kind === 'int') {
        const v = parseInt(val, 10);
        if (Number.isFinite(v)) out.scalars[key] = v;
      } else if (kind === 'float') {
        const v = parseFloat(val);
        if (Number.isFinite(v)) out.scalars[key] = v;
      } else {
        out.scalars[key] = val === '1' || val === 'true';
      }
    }
  } catch (err) {
    console.warn('[jezero] unreadable URL hash — opening the default view.', err);
    return { scalars: {}, raw: raw || '' };
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------------------------------------------------------------------------
 * Serialising
 * ------------------------------------------------------------------------ */
function layerVisible(map, ids) {
  for (const id of ids) {
    if (!map.getLayer(id)) continue;
    /* getLayoutProperty returns undefined when the property was never set,
     * which the spec treats as 'visible'. */
    return (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none';
  }
  return null;                                   // no such layer in this style
}

/** @returns {string} the hash WITHOUT the leading '#' */
export function serialize(app) {
  const map = app.map;
  if (!map) return '';
  const c = map.getCenter();
  const parts = [
    `@${c.lng.toFixed(5)},${c.lat.toFixed(5)},${map.getZoom().toFixed(2)},` +
    `${Math.round(map.getPitch())},${Math.round(map.getBearing())}`,
  ];

  const on = [];
  for (const key of Object.keys(ON_KEYS)) {
    if (layerVisible(map, ON_KEYS[key]) === true) on.push(key);
  }
  if (on.length) parts.push(`on=${on.join(',')}`);

  const gs = map.getGlobalState ? (map.getGlobalState() || {}) : {};
  const sol = gs[GLOBAL_STATE.SOL];
  if (Number.isFinite(sol)) parts.push(`sol=${Math.round(sol)}`);

  const on3d = !!(app.get3D && app.get3D());
  if (on3d) parts.push('3d=1');

  const exag = app.getExaggeration ? app.getExaggeration() : null;
  if (Number.isFinite(exag) && (on3d || Math.abs(exag - VIEW.EXAG_DEFAULT) > 1e-6)) {
    parts.push(`exag=${Number(exag.toFixed(2))}`);
  }

  const flight = gs[GLOBAL_STATE.FLIGHT];
  if (Number.isFinite(flight) && flight > 0) parts.push(`heli=${Math.round(flight)}`);

  if (Number.isFinite(app.tourStop) && app.tourStop > 0) parts.push(`tour=${app.tourStop}`);
  /* A6 (2026-08-24) — contour emphasis. Only written when Bold is on, so every
   * ordinary link stays as short as it was and existing QR codes are untouched.
   * layers.js owns app.contourBold; map.js seeds it from the hash at build time
   * so a `crb=1` link is Bold in the first painted frame. */
  if (app.contourBold) parts.push('crb=1');
  if (app.lite) parts.push('lite=1');

  return parts.join('&');
}

/** Full absolute URL for the current view — what "Copy link" puts on the clipboard. */
export function currentUrl(app) {
  const base = location.href.split('#')[0];
  const h = serialize(app);
  return h ? `${base}#${h}` : base;
}

/* ---------------------------------------------------------------------------
 * Applying
 * ------------------------------------------------------------------------ */
function applyParsed(app, parsed, { animate = false } = {}) {
  const map = app.map;
  if (!map) return;
  const manifest = app.manifest;

  /* --- layer visibility -------------------------------------------------- */
  if (parsed.on) {
    const wanted = new Set(parsed.on);
    for (const key of Object.keys(ON_KEYS)) {
      const vis = wanted.has(key) ? 'visible' : 'none';
      for (const id of ON_KEYS[key]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
      }
    }
  }

  /* --- scalars ----------------------------------------------------------- */
  const s = parsed.scalars;

  if (Number.isFinite(s.sol)) {
    const maxSol = Number.isFinite(app.maxSol) ? app.maxSol : manifest.snapshot_sol;
    const sol = clamp(Math.round(s.sol), 0, maxSol);
    map.setGlobalStateProperty(GLOBAL_STATE.SOL, sol);
    app.emit('hash:sol', { sol });
  }

  if (Number.isFinite(s.exag) && app.setExaggeration) {
    app.setExaggeration(clamp(s.exag, VIEW.EXAG_MIN, VIEW.EXAG_MAX), { silent: true });
  }

  if (s['3d'] && app.set3D) app.set3D(true, { ease: false });

  /* A6 — contour emphasis. Same shape as `tour=N`: the value is published onto
   * `app` here because layers.js loads later (ui.js's loadFeatureModules runs
   * on 'ready'), and layers.js reads app.contourBold when it builds its panel.
   * A later back/forward that changes `crb` also lands here, so app.applyContourBold
   * is called when layers.js has already registered it. */
  const wantBold = !!s.crb;
  if (wantBold !== !!app.contourBold) {
    app.contourBold = wantBold;
    if (typeof app.applyContourBold === 'function') app.applyContourBold(wantBold);
  }

  if (Number.isFinite(s.heli)) {
    const flight = clamp(Math.round(s.heli), 1, HELI_TOTALS.flights);
    map.setGlobalStateProperty(GLOBAL_STATE.FLIGHT, flight);
    app.emit('hash:flight', { flight });
  }

  if (Number.isFinite(s.tour)) {
    const stop = clamp(Math.round(s.tour), 1, TOUR.length);
    /* F1 fix, 2026-08-23: PRESERVE `tour=` until tour.js consumes it.
     * initHash() ends with an immediate write(), and serialize() reads
     * app.tourStop — which was still undefined here, so the very first
     * replaceState dropped `tour=N` from the URL. tour.js loads much later
     * (ui.js's loadFeatureModules runs on the 'ready' event) and reads the
     * scalar straight off location.hash, so every `&tour=N` deep link died:
     * 0/5 loads landed in the stop before this line existed. Publishing the
     * stop into app.tourStop keeps every write (immediate or debounced)
     * round-tripping the key until the tour module takes ownership of it. */
    app.tourStop = stop;
    /* tour.js may not be loaded yet; it replays this event on registration. */
    app.emit('hash:tour', { stop });
  }

  /* --- camera last, so terrain/pitch caps are already in force ---------- */
  if (parsed.cam) {
    const pad = VIEW.BOUNDS_PAD_DEG;
    const [w, so, e, n] = manifest.imagery.bounds;
    const cam = {
      center: [
        clamp(parsed.cam.lon, w - pad, e + pad),
        clamp(parsed.cam.lat, so - pad, n + pad),
      ],
    };
    if (parsed.cam.zoom !== undefined) {
      cam.zoom = clamp(parsed.cam.zoom, VIEW.MIN_ZOOM, VIEW.MAX_ZOOM);
    }
    if (parsed.cam.pitch !== undefined) {
      cam.pitch = clamp(parsed.cam.pitch, 0, map.getMaxPitch());
    }
    if (parsed.cam.bearing !== undefined) {
      cam.bearing = ((parsed.cam.bearing % 360) + 360) % 360;
    }
    if (animate) map.easeTo({ ...cam, duration: 1200, essential: true });
    else map.jumpTo(cam);
  }

  app.emit('hashstate', parsed);
}

/* ---------------------------------------------------------------------------
 * initHash
 * ------------------------------------------------------------------------ */
export function initHash(app) {
  const map = app.map;
  if (!map) return;

  /* Everything we write ourselves is remembered so the hashchange listener can
   * ignore it — otherwise every pan would re-apply the view it just wrote. */
  const selfWritten = new Set();
  let timer = null;

  function write({ push = false } = {}) {
    const h = serialize(app);
    if (!h) return;
    const url = `${location.pathname}${location.search}#${h}`;
    if (!push && location.hash === `#${h}`) return;
    selfWritten.add(h);
    /* Keep the set small: only the last handful can plausibly race. */
    if (selfWritten.size > 8) selfWritten.delete(selfWritten.values().next().value);
    try {
      if (push) history.pushState({ jezero: true, tour: app.tourStop || 0 }, '', url);
      else history.replaceState({ jezero: true }, '', url);
    } catch (err) {
      /* Some embedded webviews refuse history writes. Not fatal, ever. */
      console.warn('[jezero] could not update the URL:', err.message);
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; write(); }, TUNING.HASH_DEBOUNCE_MS);
  }

  app.writeHash = write;
  app.scheduleHash = schedule;

  /** Tour steps are the ONLY pushState writers (§4.10). */
  app.pushTourStep = (n) => {
    app.tourStop = n;
    write({ push: true });
  };

  app.copyLink = async () => {
    const url = currentUrl(app);
    try {
      await navigator.clipboard.writeText(url);
      app.emit('toast', { msg: 'Link to this view copied to the clipboard.' });
    } catch {
      /* Clipboard API needs a secure context; http://127.0.0.1 counts, but a
       * plain-http LAN address does not. Fall back to a select-and-copy. */
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      app.emit('toast', {
        msg: ok ? 'Link to this view copied to the clipboard.'
          : 'Could not copy automatically — the link is in the address bar.',
        kind: ok ? 'info' : 'warn',
      });
      if (!ok) write();
    }
    return url;
  };

  /* --- parse once on load ------------------------------------------------ */
  const initial = parseHash(location.hash);
  try {
    applyParsed(app, initial, { animate: false });
  } catch (err) {
    console.warn('[jezero] could not apply the URL hash — default view.', err);
  }

  /* --- write on camera + state changes ---------------------------------- */
  for (const ev of ['moveend', 'zoomend', 'pitchend', 'rotateend']) map.on(ev, schedule);
  for (const ev of ['terrain', 'exag', 'sol', 'flight', 'layers']) app.on(ev, schedule);

  /* --- read on hashchange, skipping our own writes ---------------------- */
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace(/^#/, '');
    if (selfWritten.has(h)) { selfWritten.delete(h); return; }
    /* V5 fix, 2026-08-23: while tour.js unwinds the history entries the tour
     * pushed, the URLs it walks back through are stale tour views (our own
     * debounced replaceState overwrote the doorway entry during stop 1). Their
     * hashchanges must not be applied over tour.js's snapshot restore - that
     * is what made Esc after a full tour come back at stop 1. tour.js clears
     * the flag on a timer, so a jammed unwind cannot deafen us for good. */
    if (app.tourUnwinding) return;
    const parsed = parseHash(location.hash);
    try {
      applyParsed(app, parsed, { animate: true });
    } catch (err) {
      console.warn('[jezero] bad hash ignored.', err);
    }
  });

  /* Browser Back through a tour: popstate carries the step we pushed. */
  window.addEventListener('popstate', (e) => {
    const st = e.state;
    if (st && st.jezero && Number.isFinite(st.tour)) app.emit('tour:pop', { stop: st.tour });
  });

  const btn = document.getElementById('btn-copy-link');
  if (btn) btn.addEventListener('click', () => app.copyLink());

  /* One immediate write so the address bar shows a shareable link from the
   * first second, without a history entry. */
  write();
}
