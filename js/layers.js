/* =============================================================================
 * Jezero Explorer — layers.js
 *
 * Owns the LAYERS sidebar panel and the map popups (docs/frontend-design.md
 * §4.1 wireframe, §4.8 popups, §3.2 layer-id table, §0.6 raw-images API).
 *
 * Registration (per js/ui.js's contract):
 *   registerPanel('LAYERS', buildLayersPanel)   — called at module load; the
 *     shell is already up by the time feature modules import (ui.js builds it
 *     before `app.on('ready', loadFeatureModules)` fires), so this builds the
 *     panel immediately.
 *   export function init(app)                   — wires map-click popups and
 *     hit-layer cursor styling once the map exists.
 *
 * Hash sync mechanism (found in js/hash.js, reused verbatim — NOT reinvented):
 *   hash.js's serialize() reads layer visibility straight off the map
 *   (`map.getLayoutProperty(id, 'visibility')`) for every id in
 *   config.js HASH_KEYS.ON_KEYS, and initHash() subscribes its debounced
 *   `write()` to the app bus under several event names, one of which is
 *   'layers'. So every toggle here does exactly two things: (1) flip
 *   `visibility` on the frozen LAYER_IDS strings via map.setLayoutProperty,
 *   (2) `app.emit('layers', {...})` to ask hash.js to re-serialize and
 *   (debounced 400 ms) replaceState. No second hash writer is created.
 *
 * Failure philosophy (§7), matched here:
 *   - A layer missing from the style (LITE_OMIT_LAYERS, or contours when
 *     maplibre-contour failed to init) makes its toggle grey and disabled,
 *     never a throw — `map.getLayer(id)` is checked before every mutation.
 *   - A dataset that fails to load (`data:missing`) disables the toggle that
 *     depends on it; a later successful load (`data` ok:true, e.g. the
 *     deferred paleolake fetches, or the About panel's manual refresh)
 *     re-enables it.
 *   - The raw-images thumbnail strip is fully optional: skeletons while
 *     loading, the whole strip removed on empty/failed response, and the rest
 *     of the popup renders regardless (data.js's fetchRawImages already never
 *     throws; this module treats an empty array as the failure case too).
 * ========================================================================== */

import { registerPanel, LITE } from './ui.js';
import {
  HASH_KEYS, PALEOLAKE_LEVELS, HIGHSTAND_M, NASA, CONTOUR_LAYER_STYLE_KEY,
} from './config.js';
import { contourPaint, contourLabelStyle } from './style.js';

/** A6 — the eight line layers whose paint the emphasis control drives. */
const CONTOUR_LAYER_IDS = Object.keys(CONTOUR_LAYER_STYLE_KEY);

const ON_KEYS = HASH_KEYS.ON_KEYS;

/* ---------------------------------------------------------------------------
 * Small DOM / formatting helpers
 * ------------------------------------------------------------------------ */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** ISO baked date (§0.5) -> "March 12, 2024"; verbatim fallback, never throws. */
function friendlyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** "56_0" -> {site:"56", drive:"0"}; unrecognised formats show verbatim. */
function parseRmc(rmc) {
  if (rmc === undefined || rmc === null || rmc === '') return { site: null, drive: null };
  const m = String(rmc).match(/^(\d+)[_/-](\d+)$/);
  if (m) return { site: m[1], drive: m[2] };
  return { site: String(rmc), drive: null };
}

function fmtLevel(m) {
  const n = Math.round(m);
  return `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')} m`;
}

function seeAllImagesUrl(sol) {
  const s = Number.isFinite(sol) ? Math.round(sol) : 0;
  return `${NASA.RAW_IMAGES_PAGE}?begin_sol=${s}&end_sol=${s}`;
}

/* ---------------------------------------------------------------------------
 * Layer-visibility helpers (the same read/write shape hash.js uses, kept
 * local because hash.js does not export its private layerVisible()).
 * ------------------------------------------------------------------------ */
function groupPresent(map, ids) {
  return ids.some((id) => !!map.getLayer(id));
}

/** @returns {boolean|null} true/false if any id in the group exists, else null */
function groupVisible(map, ids) {
  for (const id of ids) {
    if (!map.getLayer(id)) continue;
    return (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none';
  }
  return null;
}

function setGroupVisible(map, ids, on) {
  const vis = on ? 'visible' : 'none';
  for (const id of ids) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
}

/* ---------------------------------------------------------------------------
 * Component-scoped styling. Injected once; everything else reuses the house
 * classes (.row .btn .toggle .hint .link-btn) already defined in style.css.
 * ------------------------------------------------------------------------ */
let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.id = 'jz-layers-style';
  s.textContent = `
    .jz-seg { margin: -2px 0 10px; }
    .jz-seg .jz-seg-label { flex: 0 0 auto; }
    .jz-seg .btn { flex: 1 1 0; text-align: center; }
    .jz-level-row .btn { flex: 1 1 auto; font-size: 11px; padding: 5px 3px; }
    label.toggle.is-unavailable { color: var(--muted); cursor: default; }
    .jz-sub-hint { margin: -4px 0 10px; }
    .pop-thumbs .sk { position: relative; overflow: hidden; }
    .pop-thumbs .sk::after {
      content: "";
      position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.10), transparent);
      animation: jz-skel-sweep 1.1s ease-in-out infinite;
    }
    @keyframes jz-skel-sweep {
      from { transform: translateX(-100%); }
      to   { transform: translateX(100%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .pop-thumbs .sk::after { animation: none; }
    }
  `;
  document.head.appendChild(s);
}

/* ---------------------------------------------------------------------------
 * A plain checkbox toggle bound to one HASH_KEYS.ON_KEYS group.
 * ------------------------------------------------------------------------ */
function buildSimpleToggle(body, app, { key, label, dataKeys, unavailableHint }) {
  const map = app.map;
  const ids = ON_KEYS[key];

  const row = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  row.append(input, el('span', null, label));
  body.appendChild(row);

  const hint = el('p', 'hint jz-sub-hint');
  hint.hidden = true;
  body.appendChild(hint);

  const present = groupPresent(map, ids);
  if (!present) {
    input.disabled = true;
    row.classList.add('is-unavailable');
    hint.hidden = false;
    hint.textContent = unavailableHint || 'Not available in this build.';
  } else {
    input.checked = groupVisible(map, ids) === true;
  }

  input.addEventListener('change', () => {
    setGroupVisible(map, ids, input.checked);
    app.emit('layers', { key, on: input.checked });
  });

  if (present && dataKeys && dataKeys.length) {
    const missing = new Set();
    const refresh = () => {
      const allMissing = dataKeys.every((k) => missing.has(k));
      input.disabled = allMissing;
      row.classList.toggle('is-unavailable', allMissing);
      hint.hidden = !allMissing;
      if (allMissing) hint.textContent = unavailableHint || 'Data unavailable in this build.';
    };
    app.on('data:missing', ({ key: k }) => {
      if (dataKeys.includes(k)) { missing.add(k); refresh(); }
    });
    app.on('data', ({ key: k, ok }) => {
      if (dataKeys.includes(k) && ok) { missing.delete(k); refresh(); }
    });
  }

  return { row, input };
}

/* ---------------------------------------------------------------------------
 * Contours: master toggle + 50 m / 10 m segmented interval (§4.1, §3.2 rows
 * 8-11). The two interval groups are never both visible; selecting one always
 * turns the master on, matching how the Paleolake level buttons behave below.
 * ------------------------------------------------------------------------ */
function buildContoursControl(body, app) {
  const map = app.map;
  const crIds = ON_KEYS.cr;
  const crfIds = ON_KEYS.crf;

  const row = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  row.append(input, el('span', null, 'Contours'));
  body.appendChild(row);

  const seg = el('div', 'row tight jz-seg');
  seg.append(el('span', 'hint jz-seg-label', 'Interval'));
  const btn50 = el('button', 'btn', '50 m');
  const btn10 = el('button', 'btn', '10 m');
  btn50.type = 'button';
  btn10.type = 'button';
  seg.append(btn50, btn10);
  body.appendChild(seg);

  const hint = el('p', 'hint jz-sub-hint');
  hint.hidden = true;
  body.appendChild(hint);

  const coarseAvailable = app.contoursAvailable && groupPresent(map, crIds);
  const fineAvailable = coarseAvailable && !LITE && groupPresent(map, crfIds);
  let interval = 'coarse';

  function applyVisibility() {
    const on = input.checked;
    setGroupVisible(map, crIds, on && interval === 'coarse');
    if (fineAvailable) setGroupVisible(map, crfIds, on && interval === 'fine');
    btn50.setAttribute('aria-pressed', String(interval === 'coarse'));
    btn10.setAttribute('aria-pressed', String(interval === 'fine'));
  }

  if (!coarseAvailable) {
    input.disabled = true;
    row.classList.add('is-unavailable');
    btn50.disabled = true;
    btn10.disabled = true;
    hint.hidden = false;
    hint.textContent = 'Contours unavailable in this build.';
  } else {
    const crOn = groupVisible(map, crIds) === true;
    const crfOn = fineAvailable && groupVisible(map, crfIds) === true;
    interval = crfOn ? 'fine' : 'coarse';
    input.checked = crOn || crfOn;
    if (!fineAvailable) {
      btn10.disabled = true;
      btn10.title = LITE ? 'Not available in lite mode.' : 'Fine contours unavailable in this build.';
    }
    applyVisibility();
  }

  input.addEventListener('change', () => {
    applyVisibility();
    app.emit('layers', { key: 'cr', on: input.checked });
  });
  btn50.addEventListener('click', () => {
    if (btn50.disabled) return;
    interval = 'coarse';
    input.checked = true;
    applyVisibility();
    app.emit('layers', { key: 'cr' });
  });
  btn10.addEventListener('click', () => {
    if (btn10.disabled) return;
    interval = 'fine';
    input.checked = true;
    applyVisibility();
    app.emit('layers', { key: 'crf' });
  });

  /* ---- A6 (2026-08-24): emphasis, Subtle | Bold --------------------------
   * The original palette was tan-on-tan at 0.6–1.8 px: legible on a monitor at
   * arm's length, invisible in a photograph or on the dome. Rather than making
   * everyone live with heavy lines, this is a second segmented control in the
   * same visual language as the interval buttons, and it is carried in the URL
   * (`crb=1`) so a beauty-shot permalink reproduces exactly what was framed.
   *
   * The switch is pure paint: eight setPaintProperty calls plus the label's
   * three. No source rebuild, no layer add/remove, so it is instant and cannot
   * disturb the contour tile cache. Values come from config.js CONTOUR_STYLE
   * via style.js's contourPaint(), the same function buildStyle() used — one
   * source of truth for both build time and runtime. */
  const emph = el('div', 'row tight jz-seg');
  emph.append(el('span', 'hint jz-seg-label', 'Weight'));
  const btnSubtle = el('button', 'btn', 'Subtle');
  const btnBold = el('button', 'btn', 'Bold');
  btnSubtle.type = 'button';
  btnBold.type = 'button';
  btnSubtle.title = 'Fine tan lines — the default map look.';
  btnBold.title = 'Heavy cream lines on a dark casing — for photographs, ' +
                  'projection and the dome.';
  emph.append(btnSubtle, btnBold);
  body.insertBefore(emph, hint);

  function applyEmphasis(bold, { silent = false } = {}) {
    app.contourBold = !!bold;
    for (const id of CONTOUR_LAYER_IDS) {
      if (!map.getLayer(id)) continue;
      const paint = contourPaint(id, bold ? 'bold' : 'subtle');
      for (const prop of Object.keys(paint)) {
        try { map.setPaintProperty(id, prop, paint[prop]); } catch { /* ignore */ }
      }
    }
    if (map.getLayer('contour-label')) {
      const ls = contourLabelStyle(bold ? 'bold' : 'subtle');
      try {
        map.setPaintProperty('contour-label', 'text-color', ls.color);
        map.setPaintProperty('contour-label', 'text-halo-color', ls.halo);
        map.setPaintProperty('contour-label', 'text-halo-width', ls.haloWidth);
        map.setLayoutProperty('contour-label', 'text-size', ls.size);
      } catch { /* ignore */ }
    }
    btnSubtle.setAttribute('aria-pressed', String(!bold));
    btnBold.setAttribute('aria-pressed', String(!!bold));
    /* 'layers' is what hash.js debounces a rewrite on, so `crb` round-trips. */
    if (!silent) app.emit('layers', { key: 'crb', on: !!bold });
  }

  btnSubtle.addEventListener('click', () => {
    if (btnSubtle.disabled) return;
    applyEmphasis(false);
  });
  btnBold.addEventListener('click', () => {
    if (btnBold.disabled) return;
    applyEmphasis(true);
  });

  if (!coarseAvailable) {
    btnSubtle.disabled = true;
    btnBold.disabled = true;
  } else {
    /* map.js already read `crb` off location.hash and built the style with it;
     * mirror that here without re-emitting, or the first hash write would fight
     * the deep link that set it. */
    applyEmphasis(!!app.contourBold, { silent: true });
    /* Let hash.js drive it too, for back/forward across a `crb` change. */
    app.applyContourBold = (bold) => applyEmphasis(!!bold, { silent: true });
  }
}

/* ---------------------------------------------------------------------------
 * Paleolake: master toggle + 4-level segmented selector (§4.1, §4.5). The
 * level buttons drive app.setPaleolakeLevel() (data.js), the shell's one
 * mechanism for swapping the `paleolake` GeoJSON source between the four
 * precomputed basin-clipped polygons.
 * ------------------------------------------------------------------------ */
function buildPaleolakeControl(body, app) {
  const map = app.map;
  const flIds = ON_KEYS.fl; // ['flood-fill', 'highstand-ring']

  const row = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  row.append(input, el('span', null, 'Paleolake'));
  body.appendChild(row);

  const seg = el('div', 'row tight jz-seg jz-level-row');
  seg.append(el('span', 'hint jz-seg-label', 'Level'));
  const levelBtns = PALEOLAKE_LEVELS.map((lvl) => {
    const b = el('button', 'btn', fmtLevel(lvl));
    b.type = 'button';
    b.dataset.level = String(lvl);
    if (lvl === HIGHSTAND_M) b.title = 'Highstand — where NASA found shoreline carbonates';
    return b;
  });
  seg.append(...levelBtns);
  body.appendChild(seg);

  const hint = el('p', 'hint jz-sub-hint');
  hint.hidden = true;
  body.appendChild(hint);

  let level = HIGHSTAND_M;
  const paint = () => {
    for (const b of levelBtns) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.level) === level));
    }
  };
  paint();

  const groupOk = groupPresent(map, flIds);
  if (!groupOk) {
    input.disabled = true;
    row.classList.add('is-unavailable');
    levelBtns.forEach((b) => { b.disabled = true; });
    hint.hidden = false;
    hint.textContent = 'Paleolake unavailable in this build.';
    return;
  }

  input.checked = groupVisible(map, flIds) === true;

  async function activate(lvl) {
    level = lvl;
    paint();
    input.checked = true;
    setGroupVisible(map, flIds, true);
    app.emit('layers', { key: 'fl', on: true });
    try {
      await app.setPaleolakeLevel(lvl);
    } catch (err) {
      console.warn('[jezero] setPaleolakeLevel failed:', err);
    }
  }

  input.addEventListener('change', () => {
    if (input.checked) {
      activate(level);
    } else {
      setGroupVisible(map, flIds, false);
      app.emit('layers', { key: 'fl', on: false });
    }
  });

  for (const b of levelBtns) {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      activate(Number(b.dataset.level));
    });
  }

  /* Deferred loads (data.js DEFERRED_KEYS) settle after idle, well after this
   * panel is built — disable just the levels that 404, and the whole control
   * only if every level failed. */
  const missing = new Set();
  const keyFor = (lvl) => `paleolake${Math.abs(Math.round(lvl))}`;
  function refresh() {
    for (const b of levelBtns) {
      b.disabled = missing.has(keyFor(Number(b.dataset.level)));
    }
    const allMissing = PALEOLAKE_LEVELS.every((lvl) => missing.has(keyFor(lvl)));
    input.disabled = allMissing;
    row.classList.toggle('is-unavailable', allMissing);
    hint.hidden = !allMissing;
    if (allMissing) hint.textContent = 'Paleolake data unavailable in this build.';
  }
  app.on('data:missing', ({ key: k }) => {
    if (PALEOLAKE_LEVELS.some((lvl) => keyFor(lvl) === k)) { missing.add(k); refresh(); }
  });
  app.on('data', ({ key: k, ok }) => {
    if (ok && PALEOLAKE_LEVELS.some((lvl) => keyFor(lvl) === k)) { missing.delete(k); refresh(); }
  });
}

/* ---------------------------------------------------------------------------
 * Elevation cursor (§4.7b). Not a style layer and not in HASH_KEYS — it is a
 * live crosshair readout map.js already implements behind app.setElevCursor /
 * app.getElevCursor. Session-only by design (mirrors how map.js seeds its
 * default from a hover-capability media query rather than the hash).
 * ------------------------------------------------------------------------ */
function buildElevCursorToggle(body, app) {
  const row = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  const hasApi = typeof app.setElevCursor === 'function';
  input.checked = hasApi && typeof app.getElevCursor === 'function' && !!app.getElevCursor();
  input.disabled = !hasApi;
  row.append(input, el('span', null, 'Elevation cursor'));
  body.appendChild(row);

  const hint = el('p', 'hint jz-sub-hint',
    'Shows the ground elevation under the pointer as you move over the map.');
  body.appendChild(hint);

  if (hasApi) {
    input.addEventListener('change', () => app.setElevCursor(input.checked));
  }
}

/* ---------------------------------------------------------------------------
 * Panel assembly (§4.1 order)
 * ------------------------------------------------------------------------ */
function buildLayersPanel(body, app) {
  if (!app || !app.map) {
    body.innerHTML = '<p class="panel-empty">Map not ready.</p>';
    return;
  }
  injectStyle();

  buildContoursControl(body, app);
  buildSimpleToggle(body, app, { key: 'hs', label: 'Hillshade' });
  buildSimpleToggle(body, app, {
    key: 'hyp', label: 'Elevation colours', unavailableHint: 'Not available in Lite mode.',
  });
  buildPaleolakeControl(body, app);
  buildSimpleToggle(body, app, { key: 'wp', label: 'Waypoints', dataKeys: ['waypoints'] });
  buildSimpleToggle(body, app, { key: 'samp', label: 'Samples', dataKeys: ['samples'] });
  buildSimpleToggle(body, app, { key: 'places', label: 'Place names', dataKeys: ['places'] });
  /* data.js loads 'traverse' normally but substitutes 'traverseLite' in lite
   * mode (same source id, different file) — only the active one ever fires a
   * data/data:missing event, so only it belongs in dataKeys. */
  buildSimpleToggle(body, app, {
    key: 'route', label: 'Full route', dataKeys: [LITE ? 'traverseLite' : 'traverse'],
  });
  buildSimpleToggle(body, app, { key: 'ell', label: 'Landing ellipse', dataKeys: ['ellipse'] });
  buildElevCursorToggle(body, app);
}

registerPanel('LAYERS', buildLayersPanel);

/* ===========================================================================
 * Popups (§4.8)
 * ========================================================================== */
const POPUP_OPTS = { closeButton: true, closeOnClick: true, maxWidth: '300px' };

/* --- waypoint popup ------------------------------------------------------ */
function waypointPopupHTML(app, props) {
  const sol = Number(props.sol);
  const date = friendlyDate(props.date);
  const km = Number(props.km);
  const elev = Number(props.elev);
  const { site, drive } = parseRmc(props.rmc);

  const solLine = Number.isFinite(sol)
    ? `SOL ${sol}${date ? ' · ' + date : ''}`
    : escapeHtml(String(props.sol ?? 'Waypoint'));

  const rows = [];
  if (Number.isFinite(km)) rows.push(`Total driven ${km.toFixed(2)} km`);
  if (Number.isFinite(elev) && typeof app.formatElevation === 'function') {
    const e = app.formatElevation(elev);
    if (e) rows.push(`Elevation ${escapeHtml(e)}`);
  }
  if (drive !== null) rows.push(`Site ${escapeHtml(site)}, drive ${escapeHtml(drive)}`);
  else if (site) rows.push(`RMC ${escapeHtml(site)}`);
  if (props.note) rows.push(escapeHtml(String(props.note)));

  return `
    <div class="pop-head">Waypoint</div>
    <div class="pop-title">${escapeHtml(solLine)}</div>
    ${rows.map((r) => `<div class="pop-row">${r}</div>`).join('')}
    <div class="pop-thumbs" data-thumbs></div>
    <div class="pop-links">
      <a href="${seeAllImagesUrl(sol)}" target="_blank" rel="noopener">See all images from this sol →</a>
      <a href="${NASA.MMGIS_MAP}" target="_blank" rel="noopener">Open in NASA's map →</a>
    </div>
  `;
}

function mountSkeletons(container, n = 4) {
  container.innerHTML = '';
  for (let i = 0; i < n; i++) container.appendChild(el('div', 'sk'));
}

async function fillThumbs(app, popup, container, sol) {
  if (!Number.isFinite(sol) || typeof app.fetchRawImages !== 'function') {
    container.remove();
    return;
  }
  mountSkeletons(container);
  let images = [];
  try {
    images = await app.fetchRawImages(sol);
  } catch {
    images = [];
  }
  /* The popup may have been closed, or the strip already removed, while the
   * fetch was in flight — never mutate detached DOM. */
  if (!container.isConnected || (typeof popup.isOpen === 'function' && !popup.isOpen())) return;
  if (!images || !images.length) {
    container.remove();
    return;
  }
  container.innerHTML = '';
  for (const im of images) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = im.thumb;
    img.alt = im.camera ? `${im.camera} — sol ${im.sol}` : `Raw image — sol ${im.sol}`;
    img.addEventListener('error', () => img.remove());
    if (im.full) {
      const a = document.createElement('a');
      a.href = im.full;
      a.target = '_blank';
      a.rel = 'noopener';
      a.appendChild(img);
      container.appendChild(a);
    } else {
      container.appendChild(img);
    }
  }
}

function wireWaypointPopup(app) {
  const { map, maplibregl } = app;
  if (!map || !maplibregl || !map.getLayer('waypoints-hit')) return;

  map.on('mouseenter', 'waypoints-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'waypoints-hit', () => { map.getCanvas().style.cursor = ''; });

  map.on('click', 'waypoints-hit', (e) => {
    /* A sample tube always sits on a waypoint, so both layer handlers fire for
     * one click and TWO popups stack (found in the integration pass,
     * 2026-08-23). The sample dot is the smaller, deliberately-aimed target and
     * §4.8 gives it "its own popup", so it wins; same query-and-bail idiom as
     * wireElevationClickPopup below. */
    if (map.getLayer('samples-dot')) {
      let onSample = [];
      try {
        onSample = map.queryRenderedFeatures(e.point, { layers: ['samples-dot'] });
      } catch {
        onSample = [];
      }
      if (onSample.length) return;
    }
    const f = e.features && e.features[0];
    if (!f) return;
    const props = f.properties || {};
    let popup;
    try {
      popup = new maplibregl.Popup(POPUP_OPTS)
        .setLngLat(e.lngLat)
        .setHTML(waypointPopupHTML(app, props))
        .addTo(map);
    } catch (err) {
      console.error('[jezero] waypoint popup failed:', err);
      return;
    }
    const container = popup.getElement && popup.getElement().querySelector('[data-thumbs]');
    if (container) fillThumbs(app, popup, container, Number(props.sol));
  });
}

/* --- sample popup --------------------------------------------------------- */
function samplePopupHTML(props) {
  const name = props.sample_name || props.sample_num || 'Sample';
  const rows = [];
  if (props.sample_type) rows.push(`Type: ${escapeHtml(props.sample_type)}`);
  if (props.rock_type) rows.push(`Rock type: ${escapeHtml(props.rock_type)}`);
  if (props.sample_location) rows.push(`Location: ${escapeHtml(props.sample_location)}`);

  /* §2 gotcha: sol/date may be raw strings ("194 & 196", "TBD") rather than a
   * clean number/ISO date — display verbatim, never Number()/Date() parsed. */
  const solDate = [];
  if (props.sol !== undefined && props.sol !== null && String(props.sol) !== '') {
    solDate.push(`Sol ${escapeHtml(String(props.sol))}`);
  }
  if (props.date) solDate.push(escapeHtml(String(props.date)));

  return `
    <div class="pop-head">Sample</div>
    <div class="pop-title">${escapeHtml(String(name))}</div>
    ${rows.map((r) => `<div class="pop-row">${r}</div>`).join('')}
    ${solDate.length ? `<div class="pop-row hint">${solDate.join(' · ')}</div>` : ''}
  `;
}

function wireSamplePopup(app) {
  const { map, maplibregl } = app;
  if (!map || !maplibregl || !map.getLayer('samples-dot')) return;

  map.on('mouseenter', 'samples-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'samples-dot', () => { map.getCanvas().style.cursor = ''; });

  map.on('click', 'samples-dot', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    try {
      new maplibregl.Popup(POPUP_OPTS)
        .setLngLat(e.lngLat)
        .setHTML(samplePopupHTML(f.properties || {}))
        .addTo(map);
    } catch (err) {
      console.error('[jezero] sample popup failed:', err);
    }
  });
}

/* --- click-anywhere elevation popup (§4.7a) ------------------------------- */
function wireElevationClickPopup(app) {
  const { map, maplibregl } = app;
  if (!map || !maplibregl || typeof app.elevAt !== 'function') return;

  const HIT_LAYERS = ['waypoints-hit', 'samples-dot'].filter((id) => map.getLayer(id));

  map.on('click', async (e) => {
    /* Don't stack a plain elevation popup on top of the richer waypoint/
     * sample popup when the click actually hit one of those features. */
    if (HIT_LAYERS.length) {
      let hits = [];
      try {
        hits = map.queryRenderedFeatures(e.point, { layers: HIT_LAYERS });
      } catch {
        hits = [];
      }
      if (hits.length) return;
    }
    let v = null;
    try {
      v = await app.elevAt(e.lngLat.lng, e.lngLat.lat);
    } catch {
      v = null;
    }
    if (v === null || v === undefined) return; // no DEM tile there yet — nothing to show
    const text = typeof app.formatElevation === 'function' ? app.formatElevation(v) : `${Math.round(v)} m`;
    try {
      new maplibregl.Popup(POPUP_OPTS)
        .setLngLat(e.lngLat)
        .setHTML(`<div class="pop-head">Elevation</div><div class="pop-row strong">${escapeHtml(text)}</div>`)
        .addTo(map);
    } catch (err) {
      console.error('[jezero] elevation popup failed:', err);
    }
  });
}

/* ---------------------------------------------------------------------------
 * init — called once by ui.js's loadFeatureModules, after app.map exists.
 * ------------------------------------------------------------------------ */
export function init(app) {
  try {
    wireWaypointPopup(app);
    wireSamplePopup(app);
    wireElevationClickPopup(app);
  } catch (err) {
    console.error('[jezero] layers.js init() failed:', err);
  }
}
