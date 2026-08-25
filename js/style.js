/* =============================================================================
 * Jezero Explorer — style.js
 *
 * buildStyle(manifest, demSource, opts) → a plain MapLibre style object.
 * Implements docs/frontend-design.md §3 (sources, the 29 layers of the §3.2
 * table, the §3.3 expressions, the sky block).
 *
 * Two design decisions worth restating here, because they look like mistakes:
 *
 * 1. GeoJSON sources are created with EMPTY FeatureCollections, not with a
 *    `data: 'data/foo.geojson'` URL. The pipeline may not have produced a given
 *    file yet, and a source pointed at a missing URL logs a source-load error
 *    and leaves the source in a failed state. Starting empty and letting
 *    data.js Promise.allSettled the files and setData the winners means a
 *    missing dataset costs exactly one disabled toggle and nothing else (§7).
 *
 * 2. There are two raster-dem sources with identical definitions:
 *    `dem-terrain` and `dem-shade`. Sharing one source between setTerrain and a
 *    hillshade layer triggers a MapLibre warnonce and can fight over tile
 *    state. Both point at maplibre-contour's shared DEM protocol URL, so the
 *    underlying PNGs are still fetched and decoded once (§0.7).
 *
 * Interpolate stop inputs must be numeric literals, so anything that has to
 * animate against global state (the flood tide ramp) is repainted with
 * setPaintProperty by its owning module — see floodRamp() below.
 *
 * 3. THE DEM ENCODE OFFSET (docs/frontend-design.md §9.3). The pipeline encodes
 *    h + `manifest.dem.elev_offset` (4000 m) so the tiles carry no negative
 *    values. Consequences for this file, all of them local:
 *      · `['elevation']` inside a color-relief ramp reads the ENCODED value, so
 *        every colour stop in hypsometricRamp() and floodRamp() is written as
 *        realMetres + offset. Callers keep passing REAL metres.
 *      · maplibre-contour's `ele` property is likewise encoded, so the contour
 *        LABEL subtracts the offset — but the contour THRESHOLDS do not change
 *        at all. They are intervals (2000/1000/500/250/200/100/50/20/10 m) and
 *        4000 is a multiple of every one of them, so each isoline still lands on
 *        a true-elevation multiple; only the printed number needed fixing.
 *      · hillshade and terrain need nothing: a gradient is offset-invariant, and
 *        terrain only needs the surface to be self-consistent (that is the whole
 *        point of the offset).
 * ========================================================================== */

import {
  LAYER_IDS, LITE_OMIT_LAYERS, GLOBAL_STATE, PALETTE, SKY, CONTOURS,
  VIEW, HIGHSTAND_M, SOURCE_ATTRIBUTION,
  CONTOUR_STYLE, CONTOUR_LAYER_STYLE_KEY, CONTOUR_ZOOM_STOPS,
} from './config.js';

/** An empty source payload — every GeoJSON source starts here. */
const EMPTY = { type: 'FeatureCollection', features: [] };

/* ---------------------------------------------------------------------------
 * Reusable expressions
 * ------------------------------------------------------------------------ */

/** Features at or before the current sol. */
const SOL_DONE = ['<=', ['get', 'sol'], ['global-state', GLOBAL_STATE.SOL]];
/** Features still in the rover's future. */
const SOL_FUTURE = ['>', ['get', 'sol'], ['global-state', GLOBAL_STATE.SOL]];

/**
 * Hillshade exaggeration curve (§3.3). Carries the areobrowser feel at low
 * zoom and gets out of the way at z16+ where HiRISE has real shadows.
 * @param {number} mult 1 for 2D, 0.4 when 3D terrain is on (double shading
 *                      reads as mud).
 */
export function hillshadeExaggeration(mult = 1) {
  return [
    'interpolate', ['linear'], ['zoom'],
    8, 0.60 * mult,
    11, 0.50 * mult,
    13, 0.30 * mult,
    15, 0.10 * mult,
    16.5, 0.0,
  ];
}

/**
 * Hypsometric ramp for the "Elevation colours" layer. Static −2750 → −1550 in
 * REAL metres, covering the full Jezero range with headroom at both ends.
 * @param {number} [offset] manifest.dem.elev_offset — added to every stop
 *   because `['elevation']` yields the ENCODED value (see header note 3).
 */
function hypsometricRamp(offset = 0) {
  const o = offset;
  return [
    'interpolate', ['linear'], ['elevation'],
    -2750 + o, '#2c1e3a',
    -2600 + o, '#3b3a6b',
    -2500 + o, '#3f6b8a',
    -2400 + o, '#4f8f84',
    -2300 + o, '#8a9a56',
    -2150 + o, '#b99a4e',
    -2000 + o, '#c87a45',
    -1850 + o, '#d8a06e',
    -1700 + o, '#e8cdae',
    -1550 + o, '#f7f1e6',
  ];
}

/**
 * Rising-tide ramp for the `flood-tide` color-relief layer (§4.5). Exported
 * because interpolate stops cannot read global state: the flood module calls
 * map.setPaintProperty('flood-tide','color-relief-color', floodRamp(level, off))
 * on each animation step (throttled to ~12 fps).
 * @param {number} L water level in REAL metres (areoid) — global-state `flood`
 *   and every caller stay in real metres; the conversion happens only here.
 * @param {number} [offset] manifest.dem.elev_offset (see header note 3).
 */
export function floodRamp(L, offset = 0) {
  const l = L + offset;
  return [
    'interpolate', ['linear'], ['elevation'],
    l - 400, 'rgba(10,30,70,0.92)',
    l - 60, 'rgba(24,74,140,0.85)',
    l - 8, 'rgba(90,200,255,0.75)',
    l, 'rgba(190,240,255,0.55)',
    l + 0.5, 'rgba(0,0,0,0)',
  ];
}

/**
 * A6 (2026-08-24) — the paint object for ONE contour layer under ONE emphasis
 * preset. Exported because layers.js hands the very same objects to
 * setPaintProperty when the visitor flips Subtle/Bold: build-time and runtime
 * therefore cannot drift, and switching costs three paint properties per layer
 * with no source rebuild and no layer churn.
 *
 * @param {string} id      one of CONTOUR_LAYER_STYLE_KEY's keys
 * @param {'subtle'|'bold'} preset
 * @returns {object} a MapLibre line paint object
 */
export function contourPaint(id, preset = 'subtle') {
  const key = CONTOUR_LAYER_STYLE_KEY[id];
  const spec = (CONTOUR_STYLE[preset] || CONTOUR_STYLE.subtle)[key];
  if (!spec) return {};
  const [z0, z1] = id.includes('-fine-')
    ? CONTOUR_ZOOM_STOPS.fine : CONTOUR_ZOOM_STOPS.coarse;
  return {
    'line-color': spec.color,
    'line-width': ['interpolate', ['linear'], ['zoom'], z0, spec.w[0], z1, spec.w[1]],
    'line-opacity': ['interpolate', ['linear'], ['zoom'], z0, spec.o[0], z1, spec.o[1]],
  };
}

/** A6 — the contour LABEL's paint/layout under one preset (same rationale). */
export function contourLabelStyle(preset = 'subtle') {
  return (CONTOUR_STYLE[preset] || CONTOUR_STYLE.subtle).label;
}

/**
 * Contour label text: "−2450 m", with a real typographic minus.
 * maplibre-contour computes `ele` from the ENCODED tile values, so the offset
 * comes back off here. The thresholds themselves are untouched — 4000 is a
 * multiple of every interval in CONTOURS, so the isolines stay on true
 * elevations and only this label needed the subtraction.
 * @param {number} [offset] manifest.dem.elev_offset
 */
function contourLabelText(offset = 0) {
  const ele = offset
    ? ['-', ['get', CONTOURS.shared.elevationKey], offset]
    : ['get', CONTOURS.shared.elevationKey];
  return [
    'concat',
    ['case', ['<', ele, 0], '−', ''],
    ['to-string', ['abs', ele]],
    ' m',
  ];
}

/* ---------------------------------------------------------------------------
 * Sources
 * ------------------------------------------------------------------------ */
function buildSources(manifest, demSource, opts) {
  const sources = {};

  sources.imagery = {
    type: 'raster',
    tiles: [manifest.imagery.path],
    tileSize: manifest.imagery.tileSize,
    minzoom: manifest.imagery.minzoom,
    maxzoom: manifest.imagery.maxzoom,
    bounds: manifest.imagery.bounds,
    attribution: SOURCE_ATTRIBUTION.imagery,
  };

  if (manifest.imagery_hi) {
    sources['imagery-hi'] = {
      type: 'raster',
      tiles: [manifest.imagery_hi.path],
      tileSize: manifest.imagery_hi.tileSize,
      minzoom: manifest.imagery_hi.minzoom,
      maxzoom: manifest.imagery_hi.maxzoom,
      bounds: manifest.imagery_hi.bounds,
      attribution: SOURCE_ATTRIBUTION.imageryHi,
    };
  }

  /* Cross-origin z18 pack — added only when the boot probe found it. The tight
   * bounds are what stop a 404 storm when someone pans off the footprint. */
  if (manifest.imagery_ultra && manifest.ultraAvailable) {
    sources['imagery-ultra'] = {
      type: 'raster',
      tiles: [manifest.imagery_ultra.url],
      tileSize: manifest.imagery_ultra.tileSize,
      minzoom: manifest.imagery_ultra.minzoom,
      maxzoom: manifest.imagery_ultra.maxzoom,
      bounds: manifest.imagery_ultra.bounds,
      attribution: SOURCE_ATTRIBUTION.imageryHi,
    };
  }

  /* Two identical raster-dem sources, different ids — see the header note.
   * When maplibre-contour is unavailable we fall back to the raw PNG path so
   * terrain and hillshade still work; only contours are lost. */
  const demTiles = demSource ? [demSource.sharedDemProtocolUrl] : [manifest.dem.path];
  const demDef = {
    type: 'raster-dem',
    tiles: demTiles,
    /* Style-spec default is "mapbox" and default tileSize is 512. Both wrong
     * for us; both stated explicitly. */
    encoding: manifest.dem.encoding,
    tileSize: manifest.dem.tileSize,
    minzoom: manifest.dem.minzoom,
    maxzoom: manifest.dem.maxzoom,
    bounds: manifest.dem.bounds,
    attribution: SOURCE_ATTRIBUTION.dem,
  };
  sources['dem-terrain'] = { ...demDef };
  sources['dem-shade'] = { ...demDef };

  /* Contour vector tiles, synthesised on the fly by maplibre-contour from the
   * same terrarium PNGs. maxzoom = DEM ceiling + 1 so MapLibre overzooms the
   * deepest generated tile rather than asking for one that cannot exist. */
  if (demSource) {
    const shared = CONTOURS.shared;
    sources.contours = {
      type: 'vector',
      tiles: [demSource.contourProtocolUrl({ ...shared, thresholds: CONTOURS.coarse })],
      maxzoom: manifest.dem.contour_maxzoom + 1,
    };
    /* Present but hidden by default: toggled with layer `visibility`, never by
     * swapping source definitions (that churns the whole tile pyramid). */
    if (!opts.lite) {
      sources['contours-fine'] = {
        type: 'vector',
        tiles: [demSource.contourProtocolUrl({ ...shared, thresholds: CONTOURS.fine })],
        maxzoom: manifest.dem.contour_maxzoom + 1,
      };
    }
  }

  /* --- GeoJSON, all starting empty (see header note 1) ------------------- */
  const geo = (extra) => ({ type: 'geojson', data: EMPTY, attribution: SOURCE_ATTRIBUTION.nasa, ...extra });

  sources.traverse = geo();
  /* lineMetrics is required for ['line-progress'] / line-gradient — this is
   * the single in-progress drive that the timeline reveals fractionally. */
  sources['traverse-active'] = geo({ lineMetrics: true });
  sources.waypoints = geo();
  sources.samples = geo();
  sources.depot = geo();
  sources.ellipse = geo();
  sources.places = geo({ attribution: undefined });
  sources.highstand = geo({ attribution: undefined });
  sources.paleolake = geo({ attribution: undefined });
  sources['heli-paths'] = geo();
  /* Built client-side per selected flight by ingenuity.js. */
  sources['heli-ribbon'] = geo({ attribution: undefined });
  /* Not named in §3.1 but layer 27 (airfield-label) needs a home; ingenuity.js
   * fills it from heli-flights.json's from/to airfield names. Documented
   * addition, additive only. */
  sources['heli-airfields'] = geo({ attribution: undefined });

  return sources;
}

/* ---------------------------------------------------------------------------
 * Layers — in LAYER_IDS order, which is render order (bottom → top)
 * ------------------------------------------------------------------------ */
function buildLayers(manifest, demSource, opts) {
  const hasContours = !!demSource;
  const hasFine = hasContours && !opts.lite;
  /* A6 — which CONTOUR_STYLE preset this style is built with. layers.js can
   * flip it later with setPaintProperty; this is only the starting state. */
  const contourPreset = opts.contourBold ? 'bold' : 'subtle';
  const V = (on) => ({ visibility: on ? 'visible' : 'none' });
  /* Encoded-vs-real conversion for the two color-relief ramps and the contour
   * label — the only three expressions in the app that see DEM values. */
  const eOff = manifest.dem.elev_offset || 0;

  const layers = [];

  /* 1 — background */
  layers.push({
    id: 'bg', type: 'background',
    paint: { 'background-color': PALETTE.mapBackground },
  });

  /* 2 — base imagery */
  layers.push({
    id: 'imagery', type: 'raster', source: 'imagery',
    paint: { 'raster-fade-duration': 200 },
  });

  /* 2b — HiRISE imagery */
  if (manifest.imagery_hi) {
    layers.push({
      id: 'imagery-hi', type: 'raster', source: 'imagery-hi',
      paint: { 'raster-fade-duration': 200 },
    });
  }

  /* 3 — z18 pack, only present when probed */
  if (manifest.imagery_ultra && manifest.ultraAvailable) {
    layers.push({
      id: 'imagery-ultra', type: 'raster', source: 'imagery-ultra',
      minzoom: VIEW.ULTRA_MINZOOM,
      paint: { 'raster-fade-duration': 200 },
    });
  }

  /* Lite mode drops the expensive layers from the style entirely (§5) rather
   * than hiding them — a hidden color-relief layer still costs tile decode. */
  const keep = (id) => !(opts.lite && LITE_OMIT_LAYERS.includes(id));

  /* 4 — hypsometric elevation colours (omitted entirely in lite mode) */
  if (keep('hypsometric')) {
    layers.push({
      id: 'hypsometric', type: 'color-relief', source: 'dem-shade',
      layout: V(false),
      paint: {
        'color-relief-color': hypsometricRamp(eOff),
        /* color-relief-color has transition:false, but the opacity DOES
         * transition — cross-fades go through opacity. */
        'color-relief-opacity': 0.45,
      },
    });
  }

  /* 5 — paleolake polygons (the mechanism that ships: basin-clipped, correct) */
  layers.push({
    id: 'flood-fill', type: 'fill', source: 'paleolake',
    layout: V(false),
    paint: {
      'fill-color': PALETTE.flood,
      'fill-opacity': 0.55,
      'fill-outline-color': 'rgba(120,200,255,0.5)',
    },
  });

  /* 6 — animated rising tide (tour garnish; desktop, non-lite) */
  if (keep('flood-tide')) {
    layers.push({
      id: 'flood-tide', type: 'color-relief', source: 'dem-shade',
      minzoom: 10.5,
      layout: V(false),
      paint: {
        'color-relief-color': floodRamp(HIGHSTAND_M, eOff),
        'color-relief-opacity': 0.9,
      },
    });
  }

  /* 7 — hillshade, the one raster overlay that is on by default */
  layers.push({
    id: 'hillshade', type: 'hillshade', source: 'dem-shade',
    layout: V(true),
    paint: {
      'hillshade-exaggeration': hillshadeExaggeration(opts.terrain ? 0.4 : 1),
      'hillshade-method': 'igor',
      'hillshade-shadow-color': PALETTE.shade,
      'hillshade-highlight-color': PALETTE.highlight,
      'hillshade-accent-color': PALETTE.shadeAccent,
      'hillshade-illumination-direction': 315,
      'hillshade-illumination-anchor': 'map',
    },
  });

  /* 8–11 — contours (A4/A5/A6, 2026-08-24).
   *
   * Eight layers now, not four: every isoline is drawn TWICE, a dark casing
   * first and the bright line on top. Ordering inside this array is what makes
   * that work — MapLibre draws in array order, so each `-case` must be pushed
   * immediately before the line it sits under, and the minor pair must precede
   * the major pair so index contours win where the two cross.
   *
   * All eight paints come from CONTOUR_STYLE (config.js), which layers.js also
   * reads when the visitor flips Subtle/Bold. In the 'subtle' preset the
   * casings carry width 0 / opacity 0, so they cost nothing and the default map
   * looks like plain lines — the casing only materialises in 'bold'. */
  if (hasContours) {
    for (const id of ['contour-minor-case', 'contour-minor',
                      'contour-major-case', 'contour-major']) {
      const level = id.startsWith('contour-minor') ? 0 : 1;
      layers.push({
        id, type: 'line', source: 'contours', 'source-layer': 'contours',
        filter: ['==', ['get', CONTOURS.shared.levelKey], level],
        layout: { ...V(true), 'line-join': 'round', 'line-cap': 'round' },
        paint: contourPaint(id, contourPreset),
      });
    }
  }
  if (hasFine) {
    for (const id of ['contour-fine-minor-case', 'contour-fine-minor',
                      'contour-fine-major-case', 'contour-fine-major']) {
      const level = id.startsWith('contour-fine-minor') ? 0 : 1;
      layers.push({
        id, type: 'line', source: 'contours-fine', 'source-layer': 'contours',
        minzoom: 14,
        filter: ['==', ['get', CONTOURS.shared.levelKey], level],
        layout: { ...V(false), 'line-join': 'round', 'line-cap': 'round' },
        paint: contourPaint(id, contourPreset),
      });
    }
  }

  /* 12 — the −2395 m highstand ring, shown with the flood layers */
  layers.push({
    id: 'highstand-ring', type: 'line', source: 'highstand',
    layout: { ...V(false), 'line-cap': 'round' },
    paint: {
      'line-color': PALETTE.accent,
      'line-width': 1.6,
      'line-dasharray': [3, 2],
      'line-opacity': 0.9,
    },
  });

  /* 13 — landing target ellipse */
  layers.push({
    id: 'ellipse-line', type: 'line', source: 'ellipse',
    layout: V(false),
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.45,
      'line-width': 1.4,
      'line-dasharray': [4, 3],
    },
  });

  /* 14 — Three Forks sample depot */
  layers.push({
    id: 'depot-fill', type: 'fill', source: 'depot',
    layout: V(true),
    paint: { 'fill-color': PALETTE.sample, 'fill-opacity': 0.18 },
  });
  layers.push({
    id: 'depot-line', type: 'line', source: 'depot',
    layout: V(true),
    paint: { 'line-color': PALETTE.sample, 'line-width': 1.4, 'line-opacity': 0.85 },
  });

  /* 15 — the route ahead of the rover */
  layers.push({
    id: 'traverse-future', type: 'line', source: 'traverse',
    filter: SOL_FUTURE,
    layout: { ...V(false), 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': PALETTE.future,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.0, 16, 2.0],
      'line-dasharray': [2, 2],
      'line-opacity': 0.7,
    },
  });

  /* 16 — the route already driven: the app's signature line */
  layers.push({
    id: 'traverse-done', type: 'line', source: 'traverse',
    filter: SOL_DONE,
    layout: { ...V(true), 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': PALETTE.rover,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 3.0],
      'line-opacity': 0.95,
    },
  });

  /* 17 — the drive in progress, revealed by line-gradient over line-progress.
   * The timeline repaints only this one property between integer sols. */
  layers.push({
    id: 'traverse-progress', type: 'line', source: 'traverse-active',
    layout: { ...V(true), 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 3.0],
      'line-gradient': ['step', ['line-progress'], PALETTE.rover, 1, 'rgba(0,0,0,0)'],
    },
  });

  /* 18–19 — Ingenuity ground tracks */
  layers.push({
    id: 'heli-path', type: 'line', source: 'heli-paths',
    filter: SOL_DONE,
    layout: { ...V(false), 'line-join': 'round' },
    paint: { 'line-color': PALETTE.heli, 'line-opacity': 0.55, 'line-width': 1.2 },
  });
  layers.push({
    id: 'heli-path-sel', type: 'line', source: 'heli-paths',
    filter: ['==', ['get', 'flight'], ['global-state', GLOBAL_STATE.FLIGHT]],
    layout: { ...V(false), 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': PALETTE.heli, 'line-opacity': 1, 'line-width': 2.6 },
  });

  /* 20 — altitude ribbon. Height is AGL scaled by global-state vscale, which
   * the exaggeration slider drives, so the ribbon stays glued to the terrain.
   * (Spike S3 decides whether base/height are measured from the terrain
   * surface or the zero plane; if the latter, ingenuity.js switches to
   * absolute base/height using the per-vertex `gnd` values.) */
  if (keep('heli-ribbon')) {
    layers.push({
      id: 'heli-ribbon', type: 'fill-extrusion', source: 'heli-ribbon',
      layout: V(false),
      paint: {
        'fill-extrusion-color': PALETTE.heli,
        'fill-extrusion-opacity': 0.35,
        'fill-extrusion-height': ['*', ['get', 'agl'], ['global-state', GLOBAL_STATE.VSCALE]],
        'fill-extrusion-base': 0,
        'fill-extrusion-vertical-gradient': true,
      },
    });
  }

  /* 21 — end-of-drive parking spots */
  layers.push({
    id: 'waypoints-dot', type: 'circle', source: 'waypoints',
    filter: SOL_DONE,
    layout: V(true),
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 5],
      'circle-color': PALETTE.rover,
      'circle-stroke-color': PALETTE.roverStroke,
      'circle-stroke-width': 1,
    },
  });

  /* 22 — invisible fat hit target so a finger can actually hit a waypoint */
  layers.push({
    id: 'waypoints-hit', type: 'circle', source: 'waypoints',
    filter: SOL_DONE,
    layout: V(true),
    paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)' },
  });

  /* 23 — sample tubes */
  layers.push({
    id: 'samples-dot', type: 'circle', source: 'samples',
    layout: V(true),
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7],
      'circle-color': PALETTE.sample,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.2,
    },
  });

  /* 24 — place names. First symbol layer in the stack, so it wins every
   * label collision against sample and contour labels. */
  layers.push({
    id: 'places-label', type: 'symbol', source: 'places',
    layout: {
      ...V(true),
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 12, 17, 15],
      'text-max-width': 8,
      'text-padding': 6,
      'symbol-sort-key': ['coalesce', ['get', 'minzoom'], 10],
    },
    paint: {
      'text-color': PALETTE.placeLabel,
      'text-halo-color': PALETTE.placeLabelHalo,
      'text-halo-width': 1.4,
    },
  });

  /* 25 — sample names */
  layers.push({
    id: 'samples-label', type: 'symbol', source: 'samples',
    minzoom: 14,
    layout: {
      ...V(true),
      'text-field': ['get', 'sample_name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': PALETTE.sample,
      'text-halo-color': PALETTE.placeLabelHalo,
      'text-halo-width': 1.2,
    },
  });

  /* 26 — contour elevation labels, along the major contours only. They read
   * negative on purpose; About explains the areoid. */
  if (hasContours) {
    layers.push({
      id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours',
      filter: ['==', ['get', CONTOURS.shared.levelKey], 1],
      minzoom: 11,
      layout: {
        ...V(true),
        'symbol-placement': 'line-center',
        'text-field': contourLabelText(eOff),
        'text-font': ['Noto Sans Regular'],
        /* A6: size/colour/halo follow the emphasis preset too, so a Bold map
         * does not end up with heavyweight lines and hairline numbers. */
        'text-size': contourLabelStyle(contourPreset).size,
        'text-padding': 8,
        'text-rotation-alignment': 'map',
        'text-optional': true,
      },
      paint: {
        'text-color': contourLabelStyle(contourPreset).color,
        'text-halo-color': contourLabelStyle(contourPreset).halo,
        'text-halo-width': contourLabelStyle(contourPreset).haloWidth,
      },
    });
  }

  /* 27 — Ingenuity airfield names, only in Ingenuity mode */
  layers.push({
    id: 'airfield-label', type: 'symbol', source: 'heli-airfields',
    minzoom: 13,
    layout: {
      ...V(false),
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10.5,
      'text-offset': [0, -1.2],
      'text-anchor': 'bottom',
      'text-optional': true,
    },
    paint: {
      'text-color': PALETTE.heli,
      'text-halo-color': '#06202c',
      'text-halo-width': 1.3,
    },
  });

  return layers;
}

/* ---------------------------------------------------------------------------
 * Public entry
 * ------------------------------------------------------------------------ */
/**
 * @param {object} manifest resolved manifest from manifest.js
 * @param {object|null} demSource maplibre-contour DemSource, or null if the
 *        library failed to initialise (contours are then omitted, §7)
 * @param {object} [opts]
 * @param {boolean} [opts.lite]    drop the expensive layers entirely (§5)
 * @param {boolean} [opts.terrain] 3D on at build time (scales hillshade ×0.4)
 * @param {boolean} [opts.contourBold] A6 — start on the Bold contour preset
 *        (a `crb=1` deep link); layers.js can flip it at runtime either way
 * @returns {object} MapLibre style specification
 */
export function buildStyle(manifest, demSource, opts = {}) {
  const o = { lite: false, terrain: false, contourBold: false, ...opts };

  const style = {
    version: 8,
    name: 'Jezero Explorer',
    /* Explicit — never let v6 decide to render a globe. */
    projection: { type: 'mercator' },
    glyphs: 'fonts/{fontstack}/{range}.pbf',
    /* No sprite sheet: the few icons we need go in via map.addImage(). The
     * `sprite` key is OMITTED rather than set to undefined — the style
     * validator dispatches on key presence and would log
     * "string or array expected, undefined found". */
    /* Initial global state. One setGlobalStateProperty call then drives
     * filters and paint across many layers at once.
     *
     * SHAPE, verified against vendor/maplibre-gl.mjs 6.5.0: Style._createLayers
     * calls setGlobalState(stylesheet.state) which does
     *     for (const k in state) this._globalState[k] = state[k].default
     * so each entry MUST be an object with a `default` key. A bare value
     * (`{ sol: 1955 }`) validates fine — the `state` validator only checks
     * "is an object" — and then silently initialises every property to
     * undefined, which makes every global-state filter evaluate against
     * undefined and hides the traverse/waypoint layers at load. The design doc
     * §3 sketch shows the bare-value form; this is the corrected shape. */
    state: {
      [GLOBAL_STATE.SOL]: { default: manifest.snapshot_sol },
      [GLOBAL_STATE.FLIGHT]: { default: 0 },
      [GLOBAL_STATE.VSCALE]: { default: manifest.body.scale },
      [GLOBAL_STATE.FLOOD]: { default: -3000 },
    },
    sky: { ...SKY },
    sources: buildSources(manifest, demSource, o),
    layers: buildLayers(manifest, demSource, o),
  };

  /* Cheap contract check: any layer we emit must be a known frozen id, and the
   * order we emit must be a subsequence of LAYER_IDS. A violation here means a
   * feature agent and config.js have drifted apart. */
  if (typeof console !== 'undefined') {
    let cursor = -1;
    for (const layer of style.layers) {
      const idx = LAYER_IDS.indexOf(layer.id);
      if (idx < 0) {
        console.error(`[jezero] style layer "${layer.id}" is not in config.js LAYER_IDS`);
      } else if (idx <= cursor) {
        console.error(`[jezero] style layer "${layer.id}" is out of LAYER_IDS order`);
      } else {
        cursor = idx;
      }
    }
  }

  return style;
}
