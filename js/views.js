/* =============================================================================
 * Jezero Explorer - views.js
 *
 * The VIEWS panel (docs/frontend-design.md §4.1 wireframe): six named views
 * from config.js BOOKMARKS, each one button, each one flyTo.
 *
 * Added 2026-08-23 (fix F4). The panel id 'VIEWS' has been in ui.js's frozen
 * PANELS list since the shell was built, so it showed "Not built yet." until
 * this module registered a builder for it. ui.js needed exactly one line -
 * './views.js' in FEATURE_MODULES - and nothing else in the shell changed.
 *
 * ---------------------------------------------------------------------------
 * Contracts consumed (verified against the files, 2026-08-23)
 * ---------------------------------------------------------------------------
 *   config.js  BOOKMARKS  [{id, label, center:[lon,lat], zoom, pitch, bearing}]
 *              VIEW.PITCH_3D is NOT used here: each bookmark carries its own
 *              pitch, and the ids are stable (config.js says so), so this
 *              module never invents a camera.
 *   ui.js      registerPanel('VIEWS', fn), toast(msg, {kind})
 *   map.js     app.map, app.set3D(on, {ease}), app.get3D(),
 *              app.settleTerrainView(cam)   the shared 3D settle (see below)
 *              plus the easeTo/flyTo pitch re-assertion wrapper, which every
 *              flight below goes through untouched - the pitch a bookmark asks
 *              for is the pitch it gets, even with terrain on.
 *
 * ---------------------------------------------------------------------------
 * Why a bookmark with pitch > 0 turns 3D on first
 * ---------------------------------------------------------------------------
 * Mirrors tour.js's applyTerrain(): state through the owning module first
 * (app.set3D, so LITE and the §7 perf watchdog still apply), {ease:false} so
 * set3D's own 900 ms pitch ease cannot fight the one flyTo below, and only
 * then the camera. A pitch-0 bookmark leaves terrain exactly as the visitor
 * left it - "Whole crater" is a framing, not a 2D switch.
 *
 * app.settleTerrainView(cam) is called after the flight lands for the same
 * reason tour.js calls it: MapLibre leaves the centre elevation at 0 after a
 * flight, so farZ collapses, the scene stops painting, and (since the DEM is
 * encoded +4000 m and the terrain is therefore ABOVE a 0 anchor) MapLibre's
 * "camera inside terrain" guard can lift the camera and rewrite the zoom. It is
 * handed the BOOKMARK's camera so it can re-assert it before re-deriving the
 * anchor — the ordering matters, see map.js (docs/frontend-design.md §9.3).
 * ========================================================================== */

import { registerPanel, toast } from './ui.js';
import { BOOKMARKS } from './config.js';

/** Same feel as the tour's stop moves, a little quicker - this is navigation,
 *  not narration (tour.js uses 2600 ms / curve 1.3). */
const FLY_MS = 1800;
const FLY_CURVE = 1.3;

let APP = null;

/**
 * @param {object} bm one BOOKMARKS entry
 */
function goTo(bm) {
  const app = APP;
  const map = app && app.map;
  if (!map) return;

  const wants3D = Number(bm.pitch) > 0;
  if (wants3D && app.set3D && !(app.get3D && app.get3D())) {
    app.set3D(true, { ease: false });
  }

  /* One camera move. Pitch is still clamped to map.getMaxPitch() because lite
   * (55) and mobile (60) cap it; the old z>=16.2 / 66 deg terrain-on ceiling is
   * gone, retired by the DEM encode offset (docs/frontend-design.md §9.3). */
  const cam = {
    center: bm.center,
    zoom: bm.zoom,
    pitch: Math.min(Number(bm.pitch) || 0, map.getMaxPitch()),
    bearing: Number(bm.bearing) || 0,
  };
  try {
    map.flyTo({ ...cam, duration: FLY_MS, curve: FLY_CURVE, essential: true });
  } catch (err) {
    console.warn('[jezero] views: flyTo failed, jumping instead -', err);
    try { map.jumpTo(cam); } catch { /* give up quietly */ }
    return;
  }

  /* Settle the 3D view once the flight lands (no-op with terrain off), handing
   * over this bookmark's camera so a guard-lifted zoom can be put back. */
  if (typeof app.settleTerrainView === 'function') {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      map.off('moveend', settle);
      setTimeout(() => app.settleTerrainView(cam), 450);
    };
    const timer = setTimeout(settle, FLY_MS + 900);
    map.on('moveend', settle);
  }

  app.emit('view', { id: bm.id });
}

/* ---------------------------------------------------------------------------
 * Panel
 * ------------------------------------------------------------------------ */
function buildViewsPanel(body, app) {
  APP = app;
  if (!app || !app.map) {
    body.innerHTML = '<p class="panel-empty">Map not ready.</p>';
    return;
  }

  const row = document.createElement('div');
  row.className = 'row';
  for (const bm of BOOKMARKS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = bm.label;
    btn.dataset.view = bm.id;
    btn.title = Number(bm.pitch) > 0
      ? `${bm.label} - 3D, ${Math.round(bm.pitch)} deg tilt`
      : `${bm.label} - looking straight down`;
    btn.addEventListener('click', () => {
      try {
        goTo(bm);
      } catch (err) {
        console.error('[jezero] views: could not fly to', bm.id, err);
        toast('That view could not be opened.', { kind: 'error' });
      }
    });
    row.appendChild(btn);
  }
  body.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Tilted views turn 3D terrain on. The vertical ' +
    'exaggeration slider is at the top right - 1x is true Mars.';
  body.appendChild(hint);
}

registerPanel('VIEWS', buildViewsPanel);

/* ---------------------------------------------------------------------------
 * init - called once by ui.js's loadFeatureModules, after the map exists.
 * The panel builder above may well have run before this (registerPanel builds
 * immediately when the shell is already up), which is why it captures APP too.
 * ------------------------------------------------------------------------ */
export function init(app) {
  APP = app;
  /* Additive convenience for a dome control surface / the hash-free "jump to"
   * API config.js mentions. Ids come from BOOKMARKS and are stable. */
  app.views = {
    ids: BOOKMARKS.map((b) => b.id),
    goto: (id) => {
      const bm = BOOKMARKS.find((b) => b.id === id);
      if (!bm) {
        console.warn(`[jezero] views: no such view "${id}". Known: ` +
                     BOOKMARKS.map((b) => b.id).join(', '));
        return false;
      }
      goTo(bm);
      return true;
    },
  };
}
