/* =============================================================================
 * Jez Explore — manifest.js
 *
 * tiles/manifest.json is the single source of truth for tile paths, zoom caps,
 * bounds, the DEM encoding and — critically — the 1.878027 Mars/Earth radius
 * scale. Nothing else in the app may hardcode those numbers.
 *
 * This module:
 *   - loads the manifest (never fatal: falls back to the pipeline contract so
 *     the app still boots into a "waiting for tiles" state, §7)
 *   - probes the optional cross-origin z18 imagery pack with a 3 s timeout
 *   - returns one resolved, normalized object
 * ========================================================================== */

import { SCALE, TUNING, VERTICAL_DATUM } from './config.js';

/* ---------------------------------------------------------------------------
 * Fallback manifest — verbatim from docs/pipeline-design.md "Frontend contract".
 * Used only if tiles/manifest.json is absent or unparsable. The app boots, the
 * sources point at paths that 404 harmlessly, and the UI says so.
 * ------------------------------------------------------------------------ */
const FALLBACK = {
  generated: null,
  snapshot_sol: 1955,
  snapshot_date: '2026-08-20',
  body: { name: 'Mars', radius_m: 3396190, proxy_radius_m: 6378137, scale: SCALE },
  vertical_datum: VERTICAL_DATUM,
  imagery: {
    path: 'tiles/img/{z}/{x}/{y}.webp', tileSize: 256, minzoom: 6, maxzoom: 15,
    bounds: [76.15996, 17.10996, 78.74005, 19.69005],
  },
  imagery_hi: {
    path: 'tiles/imghi/{z}/{x}/{y}.webp', tileSize: 256, minzoom: 16, maxzoom: 17,
    bounds: [77.22302, 18.30679, 77.58391, 18.66936],
  },
  imagery_ultra: null,
  dem: {
    path: 'tiles/dem/{z}/{x}/{y}.png', encoding: 'terrarium', tileSize: 256,
    minzoom: 6, maxzoom: 16, contour_maxzoom: 13,
    bounds: [76.15996, 17.10996, 78.74005, 19.69005],
    elev_min: -2720, elev_max: -1620,
    /* 0, not 4000: the fallback is only used when tiles/manifest.json is
     * missing, in which case there are no tiles to decode either. A wrong
     * non-zero default would silently shift every readout by kilometers. */
    elev_offset: 0,
  },
  credits: [],
};

/* ---------------------------------------------------------------------------
 * Probe the z18 pack. A HEAD is cheapest, but GitHub Pages and some proxies
 * answer HEAD oddly, so fall back to a ranged GET. Either way: 3 s ceiling,
 * a boolean answer, and never a thrown error.
 * ------------------------------------------------------------------------ */
async function probeUltra(url) {
  if (!url) return false;
  /* The manifest ships with a placeholder account until the z18 pack repo is
   * published; probing it just sprays CORS errors into the console at boot. */
  if (url.includes('ACCT_PLACEHOLDER')) {
    console.info('[jezero] z18 pack URL is still the placeholder — probe skipped.');
    return false;
  }
  const attempt = async (method, headers) => {
    const res = await fetch(url, {
      method,
      headers,
      mode: 'cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(TUNING.PROBE_TIMEOUT_MS),
    });
    return res.ok;
  };
  try {
    if (await attempt('HEAD')) return true;
  } catch { /* fall through to GET */ }
  try {
    /* Range keeps the probe to a couple of hundred bytes on a hit. */
    return await attempt('GET', { Range: 'bytes=0-255' });
  } catch (err) {
    console.info('[jezero] z18 pack not reachable —', err.name || err.message);
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Normalization. Guards against a hand-edited manifest: missing tileSize,
 * missing encoding, a contour_maxzoom above the DEM maxzoom, and so on.
 * ------------------------------------------------------------------------ */
function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function bounds4(v, fallback) {
  return Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) ? v : fallback;
}

function normalize(m) {
  const out = {
    generated: m.generated ?? null,
    snapshot_sol: num(m.snapshot_sol, FALLBACK.snapshot_sol),
    snapshot_date: m.snapshot_date || FALLBACK.snapshot_date,
    vertical_datum: m.vertical_datum || VERTICAL_DATUM,
    credits: Array.isArray(m.credits) ? m.credits : [],
    body: {
      name: (m.body && m.body.name) || 'Mars',
      radius_m: num(m.body && m.body.radius_m, 3396190),
      proxy_radius_m: num(m.body && m.body.proxy_radius_m, 6378137),
      /* If the manifest omits scale, derive it rather than trusting a constant. */
      scale: num(
        m.body && m.body.scale,
        num(m.body && m.body.proxy_radius_m, 6378137) /
          num(m.body && m.body.radius_m, 3396190)
      ),
    },
  };

  const img = m.imagery || FALLBACK.imagery;
  out.imagery = {
    path: img.path || FALLBACK.imagery.path,
    tileSize: num(img.tileSize, 256),
    minzoom: num(img.minzoom, 6),
    maxzoom: num(img.maxzoom, 15),
    bounds: bounds4(img.bounds, FALLBACK.imagery.bounds),
  };

  const hi = m.imagery_hi;
  out.imagery_hi = hi
    ? {
        path: hi.path || FALLBACK.imagery_hi.path,
        tileSize: num(hi.tileSize, 256),
        minzoom: num(hi.minzoom, 16),
        maxzoom: num(hi.maxzoom, 17),
        bounds: bounds4(hi.bounds, FALLBACK.imagery_hi.bounds),
      }
    : null;

  const ultra = m.imagery_ultra;
  out.imagery_ultra = ultra && ultra.url
    ? {
        url: ultra.url,
        tileSize: num(ultra.tileSize, 256),
        minzoom: num(ultra.minzoom, 18),
        maxzoom: num(ultra.maxzoom, 18),
        bounds: bounds4(ultra.bounds, FALLBACK.imagery_hi.bounds),
        probe: ultra.probe || null,
      }
    : null;

  const dem = m.dem || FALLBACK.dem;
  const demMax = num(dem.maxzoom, 16);
  out.dem = {
    path: dem.path || FALLBACK.dem.path,
    /* Style-spec default is "mapbox"; ours is always terrarium and the encoder
     * stamps it. Setting it explicitly is not optional. */
    encoding: dem.encoding || 'terrarium',
    tileSize: num(dem.tileSize, 256),
    minzoom: num(dem.minzoom, 6),
    maxzoom: demMax,
    /* maplibre-contour ceiling. 13 is deliberate (9.66 m/px → gapless 10 m
     * contours). Clamp so a bad manifest cannot ask for tiles that don't exist. */
    contour_maxzoom: Math.min(num(dem.contour_maxzoom, 13), demMax),
    bounds: bounds4(dem.bounds, FALLBACK.dem.bounds),
    /* elev_min/elev_max are REAL meters on the areoid and always have been.
     * They are NOT shifted by elev_offset — ingenuity.js uses elev_min as its
     * absolute-mode REF against per-vertex `gnd` values that come from data/,
     * which the pipeline writes in real meters. */
    elev_min: num(dem.elev_min, -2720),
    elev_max: num(dem.elev_max, -1620),
    /* Meters ADDED to every sample by p07_terrarium.py --offset before
     * terrarium-encoding it, so the tiles carry no negative values and
     * MapLibre's 3D camera stops mis-handling an all-negative DEM
     * (docs/frontend-design.md §9.3). This is the ONE place the app learns the
     * number; everything that decodes a DEM tile or writes an `['elevation']`
     * expression reads it from here. Never hardcode it. */
    elev_offset: num(dem.elev_offset, 0),
  };

  return out;
}

/* ---------------------------------------------------------------------------
 * Public entry
 * ------------------------------------------------------------------------ */
export async function loadManifest() {
  let raw = null;
  try {
    const res = await fetch('tiles/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn(
      '[jezero] tiles/manifest.json unavailable — falling back to the pipeline ' +
      'contract defaults. Tiles will 404 until the pipeline stages them. ' +
      `Cause: ${err.message}`
    );
  }

  const manifest = normalize(raw || FALLBACK);
  manifest.manifestLoaded = raw !== null;

  /* The pack lives in a separate repo and may simply not exist yet. */
  manifest.ultraAvailable = manifest.imagery_ultra
    ? await probeUltra(manifest.imagery_ultra.probe || null)
    : false;

  if (manifest.imagery_ultra && !manifest.ultraAvailable) {
    console.info(
      '[jezero] highest-resolution (z18) imagery pack not installed — z17 will ' +
      'overzoom instead.'
    );
  }

  /* Convenience: the map's clamp bounds, imagery bounds padded per §3.4. */
  const [w, s, e, n] = manifest.imagery.bounds;
  manifest.padBounds = (padDeg) => [
    [w - padDeg, s - padDeg],
    [e + padDeg, n + padDeg],
  ];

  return manifest;
}
