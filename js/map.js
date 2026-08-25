/* =============================================================================
 * Jez Explore — map.js
 *
 * Owns the Map object and everything welded to it:
 *   - the maplibre-contour DemSource, constructed BEFORE `new Map` (§3.3)
 *   - MapOptions (maxBounds, zoom/pitch caps, lite tuning, hash:false)
 *   - the custom Mars scale bar (MapLibre's ScaleControl reads 1.878× too long)
 *   - the 3D toggle + vertical-exaggeration slider
 *   - the client-side terrarium elevation readout, exposed as app.elevAt()
 *   - the rover/Ingenuity marker factory
 *   - webglcontextlost and visibilitychange handling
 *
 * Everything here degrades: no DEM tiles → no contours, flat terrain, "—" in
 * the elevation readout, and the map still opens (§7).
 *
 * DEM ENCODE OFFSET (docs/frontend-design.md §9.3). The pipeline encodes
 * h + manifest.dem.elev_offset (4000 m) so no emitted tile value is negative.
 * This file subtracts it in exactly ONE place — decode() inside
 * makeElevationReader — and nothing else here needs to know: hillshade is a
 * gradient, and setTerrain only needs a self-consistent surface. What the offset
 * bought is in app.settleTerrainView's comment: the whole family of MapLibre
 * all-negative-DEM camera defects is gone, and with it a pitch ceiling and a
 * pitch re-assertion wrapper that used to live in this file.
 *
 * Exports:
 *   createMap(app)          async; resolves once the style has loaded
 *   niceRound(v)            pure helper, exported for the scale-bar unit check
 *   formatElevation(m)      "−2,481 m · +89 m above the landing site"
 *
 * Attached to the app namespace for the feature modules:
 *   app.map, app.demSource, app.contoursAvailable, app.SCALE
 *   app.elevAt(lon, lat) -> Promise<number|null>      terrarium decode
 *   app.formatElevation(m), app.marsMetres(a, b)
 *   app.makeMarker(kind, lngLat, extra) -> Marker
 *   app.set3D(on, {ease, exag}), app.get3D()
 *   app.setExaggeration(ui, {silent}), app.getExaggeration()
 *   app.setElevCursor(on), app.getElevCursor()
 *   app.settleTerrainView(cam?)   post-flight 3D settle; pass the camera you
 *                                 intended (tour.js, views.js do)
 *   app.terrainAnchorOffsetPx()   diagnostic: 0 px when the anchor is healthy
 * ========================================================================== */

import {
  VIEW, TUNING, MARKERS, ATTRIBUTION, GLOBAL_STATE, LANDING, SCALE as SCALE_FALLBACK,
} from './config.js';
import { buildStyle, hillshadeExaggeration } from './style.js';

/* ---------------------------------------------------------------------------
 * URL helpers
 *
 * maplibre-contour's DEM manager runs inside a Blob-URL worker, where a
 * RELATIVE fetch has no usable base URL. So the DemSource must be given an
 * absolute demUrlPattern. `new URL()` cannot be used for this: the URL parser
 * percent-encodes { and } (they are in the path percent-encode set), which
 * would turn tiles/dem/{z}/... into tiles/dem/%7Bz%7D/... and 404 forever.
 * Hence the manual join.
 * ------------------------------------------------------------------------ */
function absoluteTileUrl(pattern) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(pattern)) return pattern;          // already absolute
  if (pattern.startsWith('/')) return location.origin + pattern;
  const dir = location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');
  return dir + pattern;
}

/* ---------------------------------------------------------------------------
 * Scale bar
 * ------------------------------------------------------------------------ */
/** 1-2-5 rounding: the largest "nice" number <= v. Exported for verification. */
export function niceRound(v) {
  if (!(v > 0)) return 0;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const mult = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  return mult * pow;
}

function formatMarsDistance(m) {
  if (m >= 1000) {
    const km = m / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
  }
  return `${Math.round(m)} m`;
}

/**
 * The map is a Mars dataset relabelled onto an Earth-radius Mercator grid, so
 * every horizontal measurement MapLibre makes is inflated by SCALE. Divide once,
 * here, and never again anywhere else.
 */
function makeScaleBar(app, maxPx = 110) {
  const wrap = document.getElementById('scalebar');
  if (!wrap) return () => {};
  const bar = wrap.querySelector('.bar');
  const label = wrap.querySelector('.label');
  const { map, SCALE } = app;

  return function update() {
    const c = map.getContainer();
    const y = Math.round(c.clientHeight / 2);
    const a = map.unproject([10, y]);
    const b = map.unproject([10 + maxPx, y]);
    const earthM = a.distanceTo(b);
    if (!Number.isFinite(earthM) || earthM <= 0) return;
    const marsM = earthM / SCALE;
    const nice = niceRound(marsM);
    if (!nice) return;
    bar.style.width = `${Math.round((nice / marsM) * maxPx)}px`;
    label.textContent = formatMarsDistance(nice);
  };
}

/* ---------------------------------------------------------------------------
 * Terrarium elevation decoder (§4.7)
 *
 * Primary readout on purpose: it works in 2D, it is independent of the terrain
 * exaggeration, and it needs no terrain at all. queryTerrainElevation() returns
 * exaggeration-multiplied values and null without terrain, so it can never be
 * the source of truth here.
 * ------------------------------------------------------------------------ */
function makeElevationReader(manifest) {
  const z = manifest.dem.maxzoom;
  const pattern = manifest.dem.path;
  /* The pipeline encodes h + elev_offset so the tiles carry no negatives
   * (docs/frontend-design.md §9.3). This is the ONLY place in the app that
   * decodes a DEM pixel, so it is the only place that subtracts it. */
  const offset = manifest.dem.elev_offset || 0;
  const cache = new Map();               // insertion-ordered → cheap LRU
  const limit = TUNING.ELEV_CACHE_TILES; // 24
  let inFlight = 0;
  let canvas = null;
  let ctx2d = null;

  function surface(w, h) {
    if (canvas && canvas.width === w && canvas.height === h) return ctx2d;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    }
    ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    return ctx2d;
  }

  function lruGet(key) {
    if (!cache.has(key)) return undefined;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  function lruSet(key, value) {
    cache.set(key, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  }

  async function tileData(tx, ty) {
    const key = `${tx}/${ty}`;
    const hit = lruGet(key);
    if (hit !== undefined) return hit;
    /* One fetch at a time: a fast mousemove would otherwise open dozens. */
    if (inFlight >= 1) return null;
    inFlight += 1;
    try {
      const url = pattern
        .replace('{z}', String(z))
        .replace('{x}', String(tx))
        .replace('{y}', String(ty));
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) { lruSet(key, null); return null; }
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const c = surface(bmp.width, bmp.height);
      c.drawImage(bmp, 0, 0);
      const img = c.getImageData(0, 0, bmp.width, bmp.height);
      /* Read dimensions from the ImageData, NOT the bitmap: close() zeroes
       * bmp.width/height per spec, which silently clamped every lookup to
       * pixel (0,0) of the tile (spike S7 root cause, 2026-08-23). */
      const rec = { data: img.data, w: img.width, h: img.height };
      if (typeof bmp.close === 'function') bmp.close();
      lruSet(key, rec);
      return rec;
    } catch {
      lruSet(key, null);
      return null;
    } finally {
      inFlight -= 1;
    }
  }

  /**
   * Terrarium: encoded = (R * 256 + G + B / 256) − 32768. Real areoid meters are
   * that minus the pipeline's encode offset (0 for an un-offset tile set).
   */
  function decode(rec, px, py) {
    const x = Math.max(0, Math.min(rec.w - 1, px));
    const y = Math.max(0, Math.min(rec.h - 1, py));
    const i = (y * rec.w + x) * 4;
    return rec.data[i] * 256 + rec.data[i + 1] + rec.data[i + 2] / 256 - 32768 - offset;
  }

  /**
   * @returns {Promise<number|null>} meters on the Mars2000 areoid, or null if
   *   the tile is missing, still loading, or a fetch is already in flight.
   */
  return async function elevAt(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85) return null;
    const n = 2 ** z;
    const fx = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    if (tx < 0 || ty < 0 || tx >= n || ty >= n) return null;

    const rec = await tileData(tx, ty);
    if (!rec) return null;

    /* Bilinear between pixel centers. Samples are clamped inside the tile, so
     * a point in the outer half-pixel of a tile edge is nearest-neighbor
     * rather than interpolated across the seam — sub-meter at 2.4 m/px. */
    const sx = (fx - tx) * rec.w - 0.5;
    const sy = (fy - ty) * rec.h - 0.5;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const dx = sx - x0;
    const dy = sy - y0;
    const e00 = decode(rec, x0, y0);
    const e10 = decode(rec, x0 + 1, y0);
    const e01 = decode(rec, x0, y0 + 1);
    const e11 = decode(rec, x0 + 1, y0 + 1);
    const top = e00 * (1 - dx) + e10 * dx;
    const bot = e01 * (1 - dx) + e11 * dx;
    const v = top * (1 - dy) + bot * dy;
    return Number.isFinite(v) ? v : null;
  };
}

const fmt0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "−2,481 m · +89 m above the landing site" */
export function formatElevation(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return '';
  const abs = `${m < 0 ? '−' : ''}${fmt0.format(Math.abs(Math.round(m)))} m`;
  const rel = Math.round(m - LANDING.elev);
  const relStr = `${rel >= 0 ? '+' : '−'}${fmt0.format(Math.abs(rel))} m ${rel >= 0 ? 'above' : 'below'} the landing site`;
  return `${abs} · ${relStr}`;
}

/* ---------------------------------------------------------------------------
 * createMap
 * ------------------------------------------------------------------------ */
export async function createMap(app) {
  const { maplibregl, mlcontour, manifest } = app;
  const SCALE = manifest.body.scale || SCALE_FALLBACK;
  app.SCALE = SCALE;
  const LITE = !!app.lite;

  /* --- DemSource, strictly before `new Map` -------------------------------
   * Registers two custom protocols on maplibregl. If this throws (the library
   * is v5-era, spike S1), contours are simply omitted and everything else
   * carries on: buildStyle(…, null, …) drops the contour sources and layers. */
  let demSource = null;
  try {
    demSource = new mlcontour.DemSource({
      url: absoluteTileUrl(manifest.dem.path),
      encoding: manifest.dem.encoding,           // 'terrarium'
      /* 13, NOT the DEM maxzoom of 16 — the gapless contour ceiling (§3.3). */
      maxzoom: manifest.dem.contour_maxzoom,
      worker: !LITE,
      cacheSize: LITE ? 40 : 120,
      timeoutMs: 12000,
    });
    demSource.setupMaplibre(maplibregl);
  } catch (err) {
    demSource = null;
    console.error('[jezero] maplibre-contour failed to initialize — contour ' +
                  'layers will be omitted. Everything else still works.', err);
  }
  app.demSource = demSource;
  app.contoursAvailable = !!demSource;

  /* --- style ------------------------------------------------------------- */
  /* A6 (2026-08-24): a `crb=1` deep link must land on Bold contours in the very
   * first painted frame, not flip to them a moment later. hash.js runs AFTER
   * the map exists, so the flag is read straight off location.hash here — the
   * same trick tour.js uses for `tour=N`. layers.js owns it from then on. */
  const bold = /(^|#|&)crb=1(&|$)/.test(location.hash || '');
  app.contourBold = bold;
  const style = buildStyle(manifest, demSource, {
    lite: LITE, terrain: false, contourBold: bold,
  });

  /* --- map options ------------------------------------------------------- */
  const isMobile = window.matchMedia('(max-width: 899px)').matches;
  const maxPitch = LITE ? VIEW.MAX_PITCH_LITE
    : isMobile ? VIEW.MAX_PITCH_MOBILE
      : VIEW.MAX_PITCH_DESKTOP;

  const opts = {
    container: 'map',
    style,
    center: VIEW.INITIAL.center,
    zoom: VIEW.INITIAL.zoom,
    pitch: VIEW.INITIAL.pitch,
    bearing: VIEW.INITIAL.bearing,
    minZoom: VIEW.MIN_ZOOM,
    /* Source maxzoom is 17 (18 with the pack); the map goes deeper and lets
     * MapLibre overzoom, which keeps marker and label precision (§3.4). */
    maxZoom: VIEW.MAX_ZOOM,
    /* Non-negotiable for a general audience: no gray void to pan into. */
    maxBounds: manifest.padBounds(VIEW.BOUNDS_PAD_DEG),
    maxPitch,
    /* We own the URL (js/hash.js) — never fight MapLibre's own hash writer. */
    hash: false,
    attributionControl: false,
    maxTileCacheSize: LITE ? TUNING.TILE_CACHE_LITE : TUNING.TILE_CACHE,
    fadeDuration: LITE ? 0 : 300,
    anisotropicFilterPitch: LITE ? 90 : 20,
    terrainSkirtLength: 'auto',
    /* Terrain is OFF at first load for a fast first paint (§4.6). */
    dragRotate: true,
    cooperativeGestures: false,
  };
  if (LITE) opts.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

  const map = new maplibregl.Map(opts);
  app.map = map;

  /* REMOVED by the elevation-offset migration (docs/frontend-design.md §9.3):
   * an easeTo/flyTo wrapper that re-asserted a collapsed pitch with a 250 ms
   * ease. The collapse (spike S2: a requested 65° landing at ~46°) was
   * MapLibre's `Camera._elevateCameraIfInsideTerrain()` rewriting the camera
   * because an all-negative DEM made every camera look "inside the terrain".
   * With the DEM encoded +4000 m that guard no longer fires. Re-measured over
   * the 6 tilted bookmarks and all 8 tour stops with the wrapper deleted: every
   * animated move lands on its requested pitch to 0.00°, so the wrapper is
   * pure latency and one more thing to reason about. */

  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: ATTRIBUTION,
  }), 'bottom-right');

  /* ---------------------------------------------------------------------
   * Make the (i) button EXPAND the credits instead of hiding them.
   *
   * 2026-08-24, reported from the live site: "what is the little info (i) at
   * the bottom right? I'm not seeing anything in its box."
   *
   * The full credit string is 260 characters — 1545 px of text — and style.css
   * caps it to one ellipsised line so it cannot wrap across the map or hang off
   * a phone screen. That cap is right, but it left MapLibre's own toggle doing
   * the only thing it knows how to do: hide that one clipped line, then show it
   * again. So the (i) appeared to empty its own box and never revealed the
   * three quarters of the NASA/ESA/DLR/USGS credits that were clipped off the
   * right-hand edge. Those attributions are a condition of using the imagery,
   * not decoration, so "unreadable but technically present" is not good enough.
   *
   * Here the button keeps MapLibre's control permanently in its shown state and
   * toggles our own `jz-attrib-open` class instead, which style.css renders as
   * a wrapped, fully readable block. Capture (`true`) so this runs before
   * MapLibre's own handler, and stopPropagation so its collapse never fires.
   * ------------------------------------------------------------------ */
  const attribEl = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
  const attribBtn = attribEl && attribEl.querySelector('.maplibregl-ctrl-attrib-button');
  if (attribEl && attribBtn) {
    attribBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      /* MapLibre may have removed this on a previous click; keep it shown so
       * the credit line never disappears entirely. */
      attribEl.classList.add('maplibregl-compact-show');
      const open = attribEl.classList.toggle('jz-attrib-open');
      attribBtn.setAttribute('aria-expanded', String(open));
      attribBtn.setAttribute('title', open ? 'Hide full credits' : 'Show full credits');
    }, true);
    attribBtn.setAttribute('aria-expanded', 'false');
    attribBtn.setAttribute('title', 'Show full credits');
    /* Belt and braces for hover: the whole string as a native tooltip. */
    const inner = attribEl.querySelector('.maplibregl-ctrl-attrib-inner');
    if (inner) inner.setAttribute('title', inner.textContent.trim());
  }

  /* REMOVED by the elevation-offset migration (docs/frontend-design.md §9.3):
   * a dynamic pitch ceiling that clamped maxPitch to 66 whenever terrain was on
   * above zoom 16.2, to fence off "3D blackout variant B" — a deterministic
   * all-black scene in the pitch band 68-71 deg at z >= ~16.4. That band was the
   * same MapLibre guard as everything else in this family: with an all-negative
   * DEM it rewrote the camera, and the frustum came out unpaintable. Re-measured
   * at z16.5 with terrain on and the ceiling deleted, requesting 60/66/68/69/70/
   * 71/72/75/80 deg: every one lands EXACTLY (before: 68->51.62, 70->59.49,
   * 80->66.96, and the zoom itself fell to 12.65-13.99), farZ 30,535 -> 228,755,
   * and nothing blacks out. So the desktop 80 deg / mobile 60 / lite 55 static
   * ceilings from config.js are the only pitch caps left. */

  /* Tile 404s are expected before the pipeline stages tiles, and MapLibre fires
   * them as map 'error' events. Log the first few, then go quiet — an
   * unhandled 'error' event otherwise prints a wall of red at boot. */
  let errCount = 0;
  map.on('error', (e) => {
    const msg = (e && e.error && e.error.message) || 'unknown map error';
    if (errCount < 8) console.warn('[jezero] map:', msg);
    else if (errCount === 8) console.warn('[jezero] further map errors suppressed.');
    errCount += 1;
  });

  await new Promise((resolve) => {
    if (map.loaded()) resolve();
    else map.once('load', resolve);
  });

  /* --- global state ------------------------------------------------------ */
  /* Defaults come from style.state; vscale is re-asserted here because the
   * exaggeration slider's starting value, not SCALE alone, defines it. */
  let uiExag = VIEW.EXAG_DEFAULT;
  let terrainOn = false;
  map.setGlobalStateProperty(GLOBAL_STATE.VSCALE, SCALE * uiExag);

  /* --- scale bar -------------------------------------------------------- */
  const updateScale = makeScaleBar(app);
  updateScale();
  map.on('move', updateScale);
  map.on('zoom', updateScale);
  window.addEventListener('resize', updateScale);

  /* --- elevation readout ------------------------------------------------ */
  const elevAt = makeElevationReader(manifest);
  app.elevAt = elevAt;
  app.formatElevation = formatElevation;

  const elevEl = document.getElementById('elev-readout');
  let elevCursor = window.matchMedia('(hover: hover)').matches && !app.kiosk;
  let elevLast = 0;

  async function showElevation(lngLat) {
    if (!elevEl) return;
    const v = await elevAt(lngLat.lng, lngLat.lat);
    if (v === null) return;
    elevEl.textContent = formatElevation(v);
  }

  map.on('mousemove', (e) => {
    if (!elevCursor) return;
    const now = performance.now();
    if (now - elevLast < TUNING.ELEV_THROTTLE_MS) return;
    elevLast = now;
    showElevation(e.lngLat);
  });
  map.on('mouseout', () => { if (elevEl && elevCursor) elevEl.textContent = ''; });

  /** Layer panel toggle: live crosshair elevation on/off. */
  app.setElevCursor = (on) => {
    elevCursor = !!on;
    if (!on && elevEl) elevEl.textContent = '';
    app.emit('elevcursor', { on: elevCursor });
  };
  app.getElevCursor = () => elevCursor;

  /* --- Mars-meter distance helper -------------------------------------- */
  /** True Mars ground distance between two LngLat-likes, in meters. */
  app.marsMetres = (a, b) => {
    const A = maplibregl.LngLat.convert(a);
    const B = maplibregl.LngLat.convert(b);
    return A.distanceTo(B) / SCALE;
  };

  /* --- markers ---------------------------------------------------------- */
  /**
   * @param {'rover'|'heli'|'sample'} kind
   * @param {[number,number]} lngLat
   * @param {object} [extra] extra Marker options
   */
  app.makeMarker = (kind, lngLat, extra = {}) => {
    const spec = MARKERS[kind] || MARKERS.rover;
    const el = document.createElement('div');
    el.className = `jz-marker jz-marker-${kind}`;
    el.style.width = `${spec.size}px`;
    el.style.height = `${spec.size}px`;
    const img = document.createElement('img');
    img.src = spec.url;
    img.alt = kind;
    /* A missing SVG must not leave an invisible marker with no clue why. */
    img.addEventListener('error', () => {
      el.style.background = kind === 'heli' ? '#5ad0ff' : '#ffd166';
      el.style.borderRadius = '50%';
      console.warn(`[jezero] marker art missing: ${spec.url}`);
    });
    el.appendChild(img);
    return new maplibregl.Marker({
      element: el,
      /* v6: dims the marker when terrain hides it, and adds
       * .maplibregl-marker-covered for further styling. */
      opacityWhenCovered: 0.25,
      ...extra,
    }).setLngLat(lngLat);
  };

  /* --- 3D terrain + exaggeration --------------------------------------- */
  const btn3d = document.getElementById('btn-3d');
  const btn3dMobile = document.getElementById('btn-3d-mobile');
  const exagWrap = document.getElementById('exag-wrap');
  const exagInput = document.getElementById('exag');
  const exagOut = document.getElementById('exag-val');

  function paintHillshade() {
    if (!map.getLayer('hillshade')) return;
    /* Double shading (relief + real shadows) looks muddy — ×0.4 in 3D (§3.3). */
    map.setPaintProperty('hillshade', 'hillshade-exaggeration',
      hillshadeExaggeration(terrainOn ? 0.4 : 1));
  }

  function applyTerrain() {
    if (terrainOn) {
      map.setTerrain({ source: 'dem-terrain', exaggeration: SCALE * uiExag });
    } else {
      map.setTerrain(null);
    }
    paintHillshade();
  }

  /* ---------------------------------------------------------------------------
   * S2 — the stale terrain anchor, CLOSED by the elevation-offset migration.
   * (docs/frontend-design.md §9.3; every number below was measured in this app.)
   *
   * MapLibre anchors the 3D camera to `transform.elevation`: the ground height
   * under the map center. With terrain on it re-derives that value in exactly
   * two places — inside `setTerrain`, and when a DEM tile ARRIVES while no
   * camera animation holds `elevationFreeze`. A flyTo to somewhere new loads
   * every DEM tile it needs DURING the flight (freeze on), so nothing arrives
   * afterwards and the anchor is left at 0. That was true before the offset and
   * it is still true after it — the offset does not fix staleness.
   *
   * What the offset DID fix is everything that made the honest cure unshippable.
   * The DEM now encodes h + 4000 m, so terrain sits at roughly +4,100…+5,800 m
   * (encoded × SCALE × uiExag) instead of −5,500…−7,200 m, and
   * `Camera._elevateCameraIfInsideTerrain()`'s fractional-zoom query — which
   * answers 0 because a fractional zoom cannot match a DEM tile id — now reads
   * as ground BELOW every camera instead of above it. Measured at z16.5 with
   * terrain on, requesting pitch 60/66/68/69/70/71/72/75/80:
   *   before the offset  every one was rewritten (80° → 66.96°, z16.5 → 12.65)
   *   after  the offset  every one landed EXACTLY, farZ 30,535 → 228,755
   * which is also why the old z≥16.2 pitch ceiling and the easeTo/flyTo pitch
   * re-assertion wrapper are gone: the "blackout variant B" pitch band 68–71°
   * and the animated-move pitch collapse were both this guard.
   *
   * So the settle now does the honest thing, with public API only:
   *   1. put the CONFIGURED camera back — while the anchor was stale the guard
   *      may have lifted the camera out of the terrain (stop 5's z17.2 came back
   *      as 14.711, stop 6's z17.5 as 14.544);
   *   2. then re-derive the anchor with a zoom-less `setCenter`, which is the
   *      one public call that updates `transform.elevation`.
   * ORDER MATTERS: a jumpTo carrying a zoom zeroes the anchor again, so
   * deriving first and jumping second undoes the fix (measured).
   *
   * Result over all 8 tour stops: every camera exact, background fraction 0.000
   * everywhere, and the intended framing at last — viewport span across the map
   * area 4.085 km → 0.395 km at stop 7, 3.555 → 0.243 at stop 5, 3.487 → 0.197
   * at stop 6, and `terrainAnchorOffsetPx()` 1,882 px → 0 px.
   *
   * @param {{center:[number,number]|object, zoom:number, pitch:number,
   *          bearing:number}} [cam] the camera the caller intends. Omit it and
   *   the current camera is re-asserted instead, which is right for the manual
   *   3D button (nothing flew anywhere) but not for a tour stop or a bookmark.
   * @returns {boolean} true if a settle was issued
   * ------------------------------------------------------------------------ */
  app.settleTerrainView = (cam) => {
    if (!terrainOn || !map.getTerrain()) return false;
    if (map.isMoving()) return false;      // never fight a gesture or animation
    if (cam && cam.center) {
      map.jumpTo({
        center: cam.center,
        zoom: Number.isFinite(cam.zoom) ? cam.zoom : map.getZoom(),
        pitch: Number.isFinite(cam.pitch) ? cam.pitch : map.getPitch(),
        bearing: Number.isFinite(cam.bearing) ? cam.bearing : map.getBearing(),
      });
    }
    /* Zoom-less jumpTo == the only public API that re-derives the anchor. */
    map.setCenter(map.getCenter());
    return true;
  };

  /* ---------------------------------------------------------------------------
   * The same cure, applied automatically to every settled camera move.
   *
   * settleTerrainView() only runs where something calls it — tour.js and
   * views.js. Everything ELSE that moves the camera programmatically with
   * terrain already on (hash.js applying a hashchange, ingenuity.js flying to a
   * flight, a jumpTo straight after the 3D button) lands with the same stale
   * anchor and, because the DEM is now encoded ABOVE zero, the same collapsed
   * frustum. Measured: 3D button, then jumpTo z16.5/p70 → anchor 0, farZ
   * 10,100, background fraction 0.939; one re-derive → anchor 4,505, farZ
   * 120,973, background 0.001, same camera.
   *
   * Before the offset those paths got away with it (a 0 anchor over NEGATIVE
   * terrain inflates farZ instead of collapsing it — 41,519 at stop 7 — so the
   * scene painted, merely framed 5–9× too wide). It is the offset that makes
   * this worth a global guard, so the guard ships with it.
   *
   * A zoom-less setCenter is a camera no-op — measured to preserve zoom, pitch
   * and bearing exactly, including the 14.711 a lifted camera was left at — so
   * this cannot fight a gesture. `reanchoring` swallows the moveend that
   * setCenter itself fires synchronously; without it this recurses forever.
   * ------------------------------------------------------------------------ */
  let reanchoring = false;
  map.on('moveend', () => {
    if (reanchoring || !terrainOn || !map.getTerrain()) return;
    reanchoring = true;
    try {
      map.setCenter(map.getCenter());
    } finally {
      reanchoring = false;
    }
  });

  /**
   * How far the map center projects from the center of the canvas, in pixels:
   * a few px when MapLibre's terrain anchor matches the ground, 700–1,900 px
   * when it is stale. 0 in 2D. Diagnostic only — nothing in the app behaves
   * differently on it — but it is the cheapest console read on whether the
   * anchor is healthy.
   */
  app.terrainAnchorOffsetPx = () => {
    if (!terrainOn || !map.getTerrain()) return 0;
    const c = map.getCenter();
    const p = map.project([c.lng, c.lat]);
    const h = map.getContainer().clientHeight || 1;
    return Math.abs(p.y - h / 2);
  };

  /**
   * @param {boolean} on
   * @param {{ease?:boolean, exag?:number}} [o]
   */
  app.set3D = (on, o = {}) => {
    const next = !!on;
    if (typeof o.exag === 'number') uiExag = clampExag(o.exag);
    if (next === terrainOn && o.exag === undefined) return;
    terrainOn = next;
    applyTerrain();
    if (btn3d) btn3d.setAttribute('aria-pressed', String(terrainOn));
    if (btn3dMobile) btn3dMobile.setAttribute('aria-pressed', String(terrainOn));
    if (exagWrap) exagWrap.hidden = !terrainOn;
    if (o.ease !== false) {
      map.easeTo({
        pitch: terrainOn ? Math.min(VIEW.PITCH_3D, maxPitch) : 0,
        duration: terrainOn ? 900 : 700,
        essential: true,
      });
    }
    app.emit('terrain', { on: terrainOn, exag: uiExag });
    if (terrainOn) {
      watchTerrainPerf();
      /* Turning 3D on with {ease:true} runs a 900 ms pitch ease, which freezes
       * the terrain anchor exactly as a tour flight does — nudge once it ends,
       * so the manual 3D button cannot land on a blacked-out frame either. */
      if (o.ease !== false) map.once('moveend', () => app.settleTerrainView());
      else app.settleTerrainView();
    }
  };
  app.get3D = () => terrainOn;

  function clampExag(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return VIEW.EXAG_DEFAULT;
    return Math.min(VIEW.EXAG_MAX, Math.max(VIEW.EXAG_MIN, n));
  }

  /** UI 1× = true Mars: terrain.exaggeration = SCALE × ui (§0.2). */
  app.setExaggeration = (v, { silent = false } = {}) => {
    uiExag = clampExag(v);
    if (exagInput) exagInput.value = String(uiExag);
    if (exagOut) exagOut.textContent = `${uiExag.toFixed(1)}×`;
    /* One call keeps the Ingenuity ribbon glued to the terrain (§4.4). */
    map.setGlobalStateProperty(GLOBAL_STATE.VSCALE, SCALE * uiExag);
    if (terrainOn) map.setTerrain({ source: 'dem-terrain', exaggeration: SCALE * uiExag });
    if (!silent) app.emit('exag', { exag: uiExag });
  };
  app.getExaggeration = () => uiExag;

  if (btn3d) btn3d.addEventListener('click', () => app.set3D(!terrainOn));
  if (btn3dMobile) btn3dMobile.addEventListener('click', () => app.set3D(!terrainOn));
  if (exagInput) {
    exagInput.min = String(VIEW.EXAG_MIN);
    exagInput.max = String(VIEW.EXAG_MAX);
    exagInput.value = String(uiExag);
    exagInput.addEventListener('input', () => app.setExaggeration(exagInput.value));
  }
  if (exagOut) exagOut.textContent = `${uiExag.toFixed(1)}×`;

  const btnNorth = document.getElementById('btn-north');
  if (btnNorth) {
    btnNorth.addEventListener('click', () => {
      map.easeTo({ bearing: 0, duration: 500, essential: true });
    });
  }

  /* Lite is a style-level decision (layers are omitted, not hidden), so the
   * toggle rewrites the hash and reloads rather than pretending to hot-swap. */
  const btnLite = document.getElementById('btn-lite');
  if (btnLite) {
    btnLite.setAttribute('aria-pressed', String(LITE));
    btnLite.addEventListener('click', () => {
      const want = LITE ? '0' : '1';
      const h = location.hash.replace(/([&#])lite=[01]/, '$1').replace(/&&+/g, '&');
      location.hash = `${h.startsWith('#') ? h : `#${h}`}&lite=${want}`.replace('#&', '#');
      location.reload();
    });
  }

  /* Terrain perf watchdog (§7): if the first two seconds of 3D are slow, drop
   * the exaggeration and say so rather than letting it stutter. */
  function watchTerrainPerf() {
    const frames = [];
    let last = performance.now();
    let stop = false;
    const started = last;
    const sample = (now) => {
      if (stop) return;
      frames.push(now - last);
      last = now;
      if (now - started > 2000) {
        stop = true;
        if (frames.length > 10) {
          const sorted = frames.slice().sort((a, b) => a - b);
          const p50 = sorted[Math.floor(sorted.length / 2)];
          if (p50 > 45 && uiExag > VIEW.EXAG_MIN) {
            app.setExaggeration(VIEW.EXAG_MIN);
            app.emit('toast', {
              msg: '3D was running slowly, so the vertical exaggeration was reset to 1×.',
              kind: 'warn',
            });
          }
        }
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }

  /* --- context loss (iOS reclaims backgrounded WebGL) ------------------- */
  const lostBar = document.getElementById('context-lost');
  const canvas = map.getCanvas();
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (lostBar) lostBar.hidden = false;
    app.emit('contextlost', {});
    console.error('[jezero] WebGL context lost — rendering halted.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (lostBar) lostBar.hidden = true;
    app.emit('contextrestored', {});
  });
  if (lostBar) {
    lostBar.querySelector('button').addEventListener('click', () => location.reload());
  }

  /* --- pause/resume bus (timeline + replay loops subscribe) ------------- */
  document.addEventListener('visibilitychange', () => {
    app.emit(document.hidden ? 'pause' : 'resume', { reason: 'visibility' });
  });

  /* --- final touches ---------------------------------------------------- */
  /* Sanity log for the georeferencing check in §8: the landing site's decoded
   * elevation should read −2569.9 ± 0.05. Cheap, once, dev-visible. */
  elevAt(LANDING.lon, LANDING.lat).then((v) => {
    if (v === null) {
      console.info('[jezero] DEM tiles not present yet — elevation readout inactive.');
    } else if (Math.abs(v - LANDING.elev) > 1.0) {
      /* Assert, don't just log: an unnoticed 0.6 m "info" line masked the S7
       * decode bug. ±1 m covers 1/16 m quantization + bilinear resampling. */
      console.error(`[jezero] LANDING-SITE DEM CHECK FAILED: decoded ${v.toFixed(3)} m ` +
                    `vs NASA ${LANDING.elev} (tolerance ±1 m) — elevation readouts are suspect.`);
    } else {
      console.info(`[jezero] landing-site DEM check OK: ${v.toFixed(3)} m ` +
                   `(NASA ${LANDING.elev}, ±1 m)`);
    }
  });

  app.emit('map', { map });
  return map;
}
