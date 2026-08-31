/* =============================================================================
 * Jez Explore — ui.js
 *
 * The chrome: sidebar on desktop, three-detent bottom sheet on phones, right
 * drawer on landscape phones, toasts, the data-currency badge, the About panel,
 * ?kiosk=1, ?shot=1 (capture mode), and lite-mode reporting.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION API — how the feature agents plug in WITHOUT editing this file
 * ---------------------------------------------------------------------------
 * Create a new module under js/ named in FEATURE_MODULES below (timeline.js,
 * layers.js, ingenuity.js, tour.js, flood.js). ui.js dynamically imports each
 * one after the map is ready; a module that does not exist is a silent no-op.
 *
 * In your module:
 *
 *   import { registerPanel, registerAction, toast, LITE } from './ui.js';
 *
 *   registerPanel('PERCY', (body, app) => {
 *     //  `body` is an empty <div class="panel-body">, already in the DOM on
 *     //  desktop and inside the sheet on mobile. Build into it. Reuse the
 *     //  house classes: .row .btn .toggle .hint .link-btn .num, and
 *     //  <input type="range"> already has 44 px touch targets.
 *   });
 *
 *   registerAction('tour:start', () => { ... });   // powers the header button
 *
 *   export function init(app) { ... }              // optional; called once,
 *                                                  // after the map is ready
 *
 * Panel ids: PERCY, GINNY, LAYERS, VIEWS, ABOUT.
 * Registering the same id twice replaces the builder — last one wins, and the
 * panel is rebuilt immediately if the shell already exists.
 *
 * E2 (2026-08-25) — Percy and Ginny are PEERS.
 *
 * David: "Perseverance and Ingenuity are almost treated like different modes.
 * They should both be treated in the same way in the menu." They were not:
 * Ginny owned a tab named after her AND an explicit mode you entered and
 * exited, while Percy had no panel at all — he was implicit in a tab called
 * "Time" and a row of checkboxes in "Layers".
 *
 * The old ids TIMELINE and INGENUITY are gone. They were never a published
 * contract — nothing outside the app addresses a panel id (the URL hash
 * addresses LAYER ids and scalar keys, which are untouched), so this rename
 * is safe in a way that renaming a HASH_KEY would not be.
 *
 * Two structural consequences, both deliberate:
 *
 *   1. The sol slider is NOT in either vehicle's panel. It filters the rover
 *      traverse AND the flight tracks, so parking it inside "Percy" would
 *      just recreate the asymmetry one level down. It lives in #clock, a
 *      persistent strip that belongs to neither and drives both.
 *   2. "Enter Ingenuity mode" is deleted. Her tracks are ordinary layers now,
 *      on by default and toggled from Map like everything else. The
 *      `heli-mode` action and the `on=heli` hash key still work — printed QR
 *      codes and tour stop 7 call them — they just drive layer visibility
 *      instead of a mode flag.
 *
 * Action names used by this shell: 'tour:start' (header button),
 * 'data:refresh-all' (About panel link).
 *
 * Other things a feature module can rely on:
 *   toast(msg, {kind:'info'|'warn'|'error', ms})   or app.emit('toast', {...})
 *   setBadge({state:'snapshot'|'live'|'amber', sol, note})
 *   setDetent('peek'|'half'|'full')   openPanel('LAYERS')
 *   LITE      live binding, true in lite mode (§5)
 *   app.on('ready'|'pause'|'resume'|'terrain'|'exag'|'data'|…, fn)
 * ========================================================================== */

import { SNAPSHOT, TOUR, HELI_TOTALS, VERTICAL_DATUM } from './config.js';

/** Feature modules, imported opportunistically. Missing files are fine. */
const FEATURE_MODULES = [
  './timeline.js',
  './layers.js',
  './views.js',        // F4, 2026-08-23: the VIEWS panel (was "Not built yet.")
  './ingenuity.js',
  './flood.js',
  './tour.js',
];

/** FROZEN panel order + the mobile tab each panel belongs to. */
export const PANELS = [
  /* Order matters: on desktop every panel is visible and this IS the stacking
   * order down the sidebar, so the two vehicles sit together at the top with
   * the map controls beneath them. On mobile it is the tab order. */
  { id: 'PERCY', title: 'Perseverance', tab: 'percy' },
  { id: 'GINNY', title: 'Ingenuity', tab: 'ginny' },
  { id: 'LAYERS', title: 'Layers', tab: 'map' },
  { id: 'VIEWS', title: 'Views', tab: 'map' },
  { id: 'ABOUT', title: 'About & credits', tab: 'info' },
];

/* The nicknames are the labels. "Percy" and "Ginny" are what the mission team
 * and the public actually call them, they fit a phone tab strip where
 * "Perseverance" does not, and putting them side by side is the clearest
 * possible statement that the two are peers. The panel TITLES stay formal
 * ("Perseverance", "Ingenuity") so the app never looks like it is guessing. */
const TABS = [
  { id: 'percy', label: 'Percy' },
  { id: 'ginny', label: 'Ginny' },
  { id: 'map', label: 'Map' },
  { id: 'info', label: 'ⓘ' },
];

/** The tab shown on first load, and the fallback when body.dataset.tab is unset. */
const DEFAULT_TAB = 'percy';

/** Lite mode (§5). A live binding — importers see the value initUI resolves. */
export let LITE = false;

const builders = new Map();   // panel id -> buildFn
const actions = new Map();    // action name -> fn
let APP = null;
let shellReady = false;

/* ---------------------------------------------------------------------------
 * Public registration API
 * ------------------------------------------------------------------------ */
/**
 * @param {'PERCY'|'GINNY'|'LAYERS'|'VIEWS'|'ABOUT'} id
 * @param {(body:HTMLElement, app:object) => void} buildFn
 */
export function registerPanel(id, buildFn) {
  if (!PANELS.some((p) => p.id === id)) {
    console.error(`[jezero] registerPanel: unknown panel "${id}". ` +
                  `Known ids: ${PANELS.map((p) => p.id).join(', ')}`);
    return;
  }
  builders.set(id, buildFn);
  if (shellReady) buildPanel(id);
}

/** @param {string} name @param {(...args:any[]) => any} fn */
export function registerAction(name, fn) {
  actions.set(name, fn);
  if (name === 'tour:start') {
    const btn = document.getElementById('btn-tour');
    if (btn) btn.disabled = false;
  }
  if (name === 'data:refresh-all') {
    const btn = document.getElementById('about-refresh');
    if (btn) btn.disabled = false;
  }
}

/** @returns {boolean} true if an action was registered and ran. */
export function runAction(name, ...args) {
  const fn = actions.get(name);
  if (!fn) return false;
  try {
    fn(...args);
  } catch (err) {
    console.error(`[jezero] action "${name}" threw:`, err);
    toast('Something went wrong with that control.', { kind: 'error' });
  }
  return true;
}

function buildPanel(id) {
  const section = document.querySelector(`section.panel[data-panel="${id}"]`);
  if (!section) return;
  const body = section.querySelector('.panel-body');
  const fn = builders.get(id);
  if (!body || !fn) return;
  body.textContent = '';
  try {
    fn(body, APP);
  } catch (err) {
    console.error(`[jezero] panel "${id}" failed to build:`, err);
    body.innerHTML = '<p class="panel-empty">This section could not be built.</p>';
  }
}

/* ---------------------------------------------------------------------------
 * Toasts
 * ------------------------------------------------------------------------ */
/** @param {string} msg @param {{kind?:string, ms?:number}} [o] */
export function toast(msg, o = {}) {
  const host = document.getElementById('toasts');
  if (!host) { console.info('[jezero] toast:', msg); return; }
  const el = document.createElement('div');
  el.className = `toast ${o.kind && o.kind !== 'info' ? o.kind : ''}`.trim();
  el.textContent = msg;
  host.appendChild(el);
  const ms = o.ms || 4200;
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
  return el;
}

/* ---------------------------------------------------------------------------
 * Data-currency badge
 * ------------------------------------------------------------------------ */
/**
 * @param {{state?:'snapshot'|'live'|'amber', sol?:number, note?:string}} o
 */
export function setBadge(o = {}) {
  const el = document.getElementById('badge');
  if (!el) return;
  const sol = Number.isFinite(o.sol) ? o.sol : (APP?.manifest?.snapshot_sol ?? SNAPSHOT.sol);
  el.classList.remove('live', 'amber');
  if (o.state === 'live') {
    el.classList.add('live');
    el.textContent = `Live · sol ${sol}`;
  } else if (o.state === 'amber') {
    el.classList.add('amber');
    el.textContent = o.note || `Data as of sol ${sol} · offline`;
  } else {
    el.textContent = o.note || `Data as of sol ${sol}`;
  }
  el.title = o.note || `Mission data snapshot taken ${APP?.manifest?.snapshot_date || SNAPSHOT.date}.`;
}

/* ---------------------------------------------------------------------------
 * Sheet detents (mobile)
 * ------------------------------------------------------------------------ */
const DETENTS = ['peek', 'half', 'full'];

/** @param {'peek'|'half'|'full'} name */
export function setDetent(name) {
  if (!DETENTS.includes(name)) return;
  document.body.dataset.detent = name;
  APP?.emit('detent', { detent: name });
}

export function getDetent() {
  return document.body.dataset.detent || 'peek';
}

/** Bring a panel into view — raises the sheet and selects the right tab. */
export function openPanel(id) {
  const panel = PANELS.find((p) => p.id === id);
  if (!panel) return;
  if (isMobile()) {
    selectTab(panel.tab);
    if (getDetent() === 'peek') setDetent('half');
  }
  const section = document.querySelector(`section.panel[data-panel="${id}"]`);
  if (section) section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function isMobile() {
  return window.matchMedia('(max-width: 899px)').matches;
}

function isLandscapePhone() {
  return window.matchMedia('(max-width: 899px) and (max-height: 500px)').matches;
}

function selectTab(tabId) {
  document.body.dataset.tab = tabId;
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tabId));
  }
  applyPanelVisibility();
}

function applyPanelVisibility() {
  const mobile = isMobile();
  const tab = document.body.dataset.tab || DEFAULT_TAB;
  for (const p of PANELS) {
    const section = document.querySelector(`section.panel[data-panel="${p.id}"]`);
    if (!section) continue;
    section.hidden = mobile ? p.tab !== tab : false;
  }
}

/* ---------------------------------------------------------------------------
 * Shell construction
 * ------------------------------------------------------------------------ */
function buildShell(app) {
  const panelsHost = document.getElementById('panels');
  const tabsHost = document.getElementById('tabs');
  if (!panelsHost) throw new Error('#panels is missing from index.html');

  panelsHost.textContent = '';
  for (const p of PANELS) {
    const section = document.createElement('section');
    section.className = 'panel';
    section.dataset.panel = p.id;
    const h = document.createElement('h2');
    h.className = 'panel-title';
    h.textContent = p.title;
    const body = document.createElement('div');
    body.className = 'panel-body';
    /* Placeholder until a feature module registers a builder. Deliberately
     * worded so a tile-less / data-less boot does not look broken. */
    body.innerHTML = '<p class="panel-empty">Loading…</p>';
    section.append(h, body);
    panelsHost.appendChild(section);
  }

  if (tabsHost) {
    tabsHost.textContent = '';
    for (const t of TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'tab';
      b.dataset.tab = t.id;
      b.textContent = t.label;
      b.setAttribute('aria-selected', String(t.id === DEFAULT_TAB));
      b.addEventListener('click', () => {
        selectTab(t.id);
        if (getDetent() === 'peek') setDetent('half');
      });
      tabsHost.appendChild(b);
    }
  }

  document.body.dataset.tab = DEFAULT_TAB;
  applyPanelVisibility();
}

/* ---------------------------------------------------------------------------
 * Sheet drag. touch-action:none is set on #dock-handle ONLY (style.css) — any
 * wider and the panels would stop scrolling.
 * ------------------------------------------------------------------------ */
function wireSheet(app) {
  const dock = document.getElementById('dock');
  const handle = document.getElementById('dock-handle');
  const btnSheet = document.getElementById('btn-sheet');
  if (!dock || !handle) return;

  let dragging = false;
  let startY = 0;
  let startH = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let moved = false;
  let pointerId = null;

  const heightOf = (name) => {
    const probe = { peek: '--peek-h', half: '--half-h', full: '--full-h' }[name];
    const raw = getComputedStyle(document.documentElement).getPropertyValue(probe).trim();
    if (raw.endsWith('px')) return parseFloat(raw);
    /* vh / dvh values: resolve against the viewport. */
    const num = parseFloat(raw);
    if (Number.isFinite(num)) return (num / 100) * (window.visualViewport?.height || window.innerHeight);
    return name === 'peek' ? 128 : name === 'half' ? window.innerHeight * 0.55 : window.innerHeight * 0.9;
  };

  function snap(h) {
    const targets = DETENTS.map((d) => ({ d, h: heightOf(d) }));
    /* Velocity biases the choice: a fast flick keeps going. */
    const biased = h - velocity * 120;
    let best = targets[0];
    for (const t of targets) {
      if (Math.abs(t.h - biased) < Math.abs(best.h - biased)) best = t;
    }
    return best.d;
  }

  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    if (isLandscapePhone()) return;              // landscape uses tap-to-toggle
    dragging = true;
    moved = false;
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    startH = dock.getBoundingClientRect().height;
    dock.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const dt = Math.max(1, e.timeStamp - lastT);
    velocity = (e.clientY - lastY) / dt;          // px per ms, + = downward
    lastY = e.clientY;
    lastT = e.timeStamp;
    const h = Math.min(heightOf('full'), Math.max(heightOf('peek'), startH - dy));
    dock.style.height = `${h}px`;
    e.preventDefault();
  });

  function endDrag(e) {
    if (!dragging || (e && pointerId !== null && e.pointerId !== pointerId)) return;
    dragging = false;
    pointerId = null;
    dock.classList.remove('dragging');
    const h = dock.getBoundingClientRect().height;
    dock.style.height = '';
    if (moved) setDetent(snap(h));
    else {
      /* A tap cycles forward, wrapping at the top. */
      const i = DETENTS.indexOf(getDetent());
      setDetent(DETENTS[(i + 1) % DETENTS.length]);
    }
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  handle.addEventListener('keydown', (e) => {
    const i = DETENTS.indexOf(getDetent());
    if (e.key === 'ArrowUp') { setDetent(DETENTS[Math.min(DETENTS.length - 1, i + 1)]); e.preventDefault(); }
    if (e.key === 'ArrowDown') { setDetent(DETENTS[Math.max(0, i - 1)]); e.preventDefault(); }
    if (e.key === 'Enter' || e.key === ' ') { setDetent(DETENTS[(i + 1) % DETENTS.length]); e.preventDefault(); }
  });

  /* Landscape drawer: the handle is a tab on the drawer's left edge. */
  handle.addEventListener('click', () => {
    if (isLandscapePhone()) setDetent(getDetent() === 'peek' ? 'half' : 'peek');
  });

  if (btnSheet) {
    btnSheet.addEventListener('click', () => {
      setDetent(getDetent() === 'peek' ? 'half' : 'peek');
    });
  }
}

/* ---------------------------------------------------------------------------
 * About panel (§6) — mirrored in ABOUT.md
 * ------------------------------------------------------------------------ */
function aboutHTML(app) {
  const m = app.manifest || {};
  const snapSol = m.snapshot_sol ?? SNAPSHOT.sol;
  const snapDate = m.snapshot_date ?? SNAPSHOT.date;
  const scale = (m.body && m.body.scale) || 1.878027;
  const ultra = app.manifest && app.manifest.imagery_ultra
    ? (app.manifest.ultraAvailable ? 'installed' : 'not installed')
    : 'not configured';

  return `
    <p><strong>Jez Explore</strong> lets you explore Jezero Crater on Mars alongside
      NASA's <em>Perseverance</em> rover and the <em>Ingenuity</em> helicopter. Jezero is the
      45-kilometer impact basin that held a lake and a river delta more than three billion
      years ago. <em>Perseverance</em> landed there on February 18, 2021, and
      <em>Ingenuity</em> made the first 72 powered flights on another world above it.</p>

    <p>Drag the sol slider to replay the whole mission — ${HELI_TOTALS.flights} helicopter
      flights included — turn on 3D terrain, raise the ancient lake to its shoreline, and
      follow the rover from the crater floor up onto the western rim.</p>

    <h3>Who made it</h3>
    <p>Built by <strong>A. David Weigel</strong> — <i class="brand-intuitive">INTUITIVE</i><sup class="brand-reg">&#174;</sup>&nbsp;Planetarium,
      U.S.&nbsp;Space&nbsp;&amp;&nbsp;Rocket Center — as a companion to the planetarium's
      Mars programs. <em>Data to Dome, Dome to Phone:</em> the same NASA data that drives
      the 20-meter dome downtown drives this page in your hand, from the same blended
      elevation and imagery mosaics.</p>

    <h3>How the map was made</h3>
    <p>Orbital imagery (HiRISE, CTX and HRSC) and several elevation models were blended into
      seamless regional mosaics, then cut into standard web map tiles with GDAL. Elevation is
      stored as Terrarium-encoded PNGs, so your browser decodes real meters out of the
      colors — that is where the contour lines, the 3D relief and the elevation readout all
      come from.</p>
    <p><strong>One honest caveat about scale.</strong> Web maps assume Earth. To use ordinary
      web-map tiles, the Mars data is relabelled onto an Earth-sized Mercator grid, which
      stretches every horizontal distance by a factor of
      ${scale.toFixed(6)} (Earth's radius 6,378,137&nbsp;m ÷ Mars' 3,396,190&nbsp;m).
      Vertical values are untouched, true Mars meters. This app divides that factor back out
      everywhere it matters: the scale bar, every distance we quote, and the 3D relief — so
      "1×" vertical exaggeration really is true Mars, not a flattened version of it.</p>

    <h3>Why the elevations are negative</h3>
    <p>Mars has no sea level. Heights are measured from the <em>areoid</em>
      (${VERTICAL_DATUM}) — a mathematical surface of constant gravity that stands in for
      one. Jezero's floor happens to sit about 2,600&nbsp;meters <em>below</em> that zero, so
      contour labels read "−2,450&nbsp;m" and so on. The rover is now more than
      600&nbsp;meters higher than where it landed, and still below zero.</p>
    <p>In 3D, a flooded lake is drawn as shading over the ground rather than a flat water
      surface — it shows you which ground is under water, not a mirror-flat lake.</p>

    <h3>Data currency</h3>
    <p>Mission data snapshot: <strong>sol ${snapSol}</strong> (${snapDate}).
      "Where is Percy now?" asks NASA for the latest position live; everything else is the
      snapshot committed with this page. Highest-resolution imagery pack: <strong>${ultra}</strong>.</p>
    <p><button type="button" class="link-btn" id="about-refresh" disabled>Update all mission
      data from NASA</button> <span class="hint">(a few megabytes — desktop recommended)</span></p>

    <h3>Data sources &amp; credits</h3>
    <!-- E1 (2026-08-25): this list is now the app's ONLY attribution. The
         MapLibre credit box was removed from the bottom-right corner of the
         map (David: "hard to read and crowds the UI"), so everything the
         imagery and elevation providers are owed is stated here, in full and
         unclipped, rather than ellipsised into one line over the terrain. -->
    <p class="hint">Every map layer in this app comes from the sources below.</p>
    <ul class="credits">
      <li>Imagery: NASA/JPL-Caltech/UArizona (HiRISE) · NASA/JPL-Caltech/MSSS (CTX)</li>
      <li>MSR HiRISE orthomosaic &amp; DTM: USGS Astrogeology Science Center
        (Mars 2020 TRN, soc_003, Aug&nbsp;2024) — doi:10.5066/P13CPYYU</li>
      <li>Elevation: HiRISE DTMs (NASA/JPL/UArizona) · HRSC (ESA/DLR/FU&nbsp;Berlin) ·
        USGS Astrogeology</li>
      <li>Traverse, sample and flight data: NASA/JPL-Caltech, via the NASA MMGIS team</li>
      <li>Tiles, blend and this application: A. David Weigel, <i class="brand-intuitive">INTUITIVE</i><sup class="brand-reg">&#174;</sup>&nbsp;Planetarium,
        U.S. Space &amp; Rocket Center</li>
    </ul>

    <h3>Software</h3>
    <p>MapLibre GL JS 6.5.0 and maplibre-contour 0.1.0, both 3-clause BSD; full license text
      ships in <code>vendor/</code>. Map fonts: Noto Sans (SIL Open Font License). No
      trackers, no cookies, no analytics.</p>

    <h3>NASA's own map</h3>
    <p>This is a companion, not a replacement — for the complete, authoritative mission map
      see <a href="https://mars.nasa.gov/maps/location/?mission=M20" target="_blank"
      rel="noopener">NASA's Mars 2020 map</a>.</p>

    <p class="about-logo"><img src="assets/USSRC_IP_logo.svg" alt="U.S. Space &amp; Rocket Center — INTUITIVE Planetarium" onerror="this.remove()" /></p>
  `;
}

/* ---------------------------------------------------------------------------
 * E5 (2026-08-25) — clean capture, with a way back out.
 *
 * David: "I'm not sure where the button to take a completely UI free image is,
 * does that exist?" It did not. D4 shipped the MODE (`?shot=1`, which strips
 * every scrap of chrome) but never shipped a control that reaches it, so the
 * only way in was to hand-edit the URL.
 *
 * The hard part is not entering capture mode, it is LEAVING it: `body.shot`
 * hides all chrome with `!important`, so the button that got you in is the
 * first thing to disappear. Two independent ways out, plus a toast that says
 * so on the way in, because this runs on a kiosk in a planetarium where nobody
 * can edit a URL:
 *
 *   - Escape
 *   - a single click/tap anywhere on the page
 *
 * The mode is NOT written to the URL hash. A permalink that opens with the UI
 * stripped and no obvious way back is a trap to hand someone, and `?shot=1`
 * already exists for the deliberate, scripted case (reel.py uses it).
 * ------------------------------------------------------------------------ */
function initShotMode(app) {
  const btn = document.getElementById('btn-shot');

  /* No toast on the way in: `body.shot #toasts` is hidden with !important, so
   * a toast here would be a call that renders nothing. The way back out is
   * advertised on the button itself (title) and is forgiving enough that it
   * does not need advertising: any click anywhere, or Escape. */
  function setShot(on) {
    document.body.classList.toggle('shot', !!on);
    if (btn) btn.setAttribute('aria-pressed', String(!!on));
  }

  if (btn) btn.addEventListener('click', () => setShot(!document.body.classList.contains('shot')));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('shot')) setShot(false);
  });

  /* Capture (`true`) so this wins before the map's own handlers, and only while
   * the mode is on — otherwise every click on the app would run this. */
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('shot')) return;
    /* Let the corner hint's own link (the emblem) still work. */
    if (e.target && e.target.closest && e.target.closest('#brand-mark')) return;
    setShot(false);
  }, true);

  /* `?shot=1` still wins at boot; this only syncs the button's state to it. */
  if (btn) btn.setAttribute('aria-pressed', String(!!app.shot));
}

function buildAbout(body, app) {
  body.innerHTML = aboutHTML(app);
  const refresh = body.querySelector('#about-refresh');
  if (refresh) {
    if (actions.has('data:refresh-all')) refresh.disabled = false;
    refresh.addEventListener('click', () => {
      if (!runAction('data:refresh-all')) {
        toast('Live data refresh is not available in this build.', { kind: 'warn' });
      }
    });
  }
}

/* ---------------------------------------------------------------------------
 * Feature-module loading
 * ------------------------------------------------------------------------ */
async function loadFeatureModules(app) {
  for (const path of FEATURE_MODULES) {
    try {
      const mod = await import(path);
      if (typeof mod.init === 'function') {
        try {
          await mod.init(app);
        } catch (err) {
          console.error(`[jezero] ${path} init() threw:`, err);
        }
      }
      console.info(`[jezero] feature module loaded: ${path}`);
    } catch (err) {
      /* Not present yet (404) or failed to parse. Either way the shell stands —
       * that graceful degradation is the point (§7) and does not change.
       *
       * A8 (2026-08-24): this used to be a bare `catch {}`. A 404 is expected
       * and harmless, but so is a SYNTAX ERROR to this code path — a typo in
       * any feature module made the whole module vanish with no console trace
       * at all, leaving a panel reading "Not built yet." and no way to tell the
       * two causes apart. Distinguish them: a genuine 404 stays quiet (the
       * browser prints its own line), anything else is a real defect and says
       * so loudly. */
      const msg = (err && err.message) || String(err);
      const looks404 = /Failed to fetch dynamically imported module|NetworkError|404/i.test(msg);
      if (looks404) {
        console.info(`[jezero] feature module absent (skipped): ${path}`);
      } else {
        console.error(
          `[jezero] feature module FAILED TO LOAD: ${path} — its panel will ` +
          `read "Not built yet." and its features are missing. This is a bug ` +
          `in the module, not a missing file.`, err
        );
      }
    }
  }
  /* Any panel still without a builder says so plainly. */
  for (const p of PANELS) {
    if (builders.has(p.id)) continue;
    const body = document.querySelector(`section.panel[data-panel="${p.id}"] .panel-body`);
    if (body) {
      body.innerHTML = '<p class="panel-empty">Not built yet.</p>';
    }
  }
}

/* ---------------------------------------------------------------------------
 * initUI — called by boot.js BEFORE the map is created, because the map
 * controls attach to DOM this function guarantees exists.
 * ------------------------------------------------------------------------ */
export function initUI(app) {
  APP = app;
  LITE = !!app.lite;

  document.body.classList.toggle('lite', LITE);
  document.body.classList.toggle('kiosk', !!app.kiosk);
  /* D4 — `?shot=1`. See style.css `body.shot`. */
  document.body.classList.toggle('shot', !!app.shot);
  initShotMode(app);
  document.body.classList.add(isMobile() ? 'mobile' : 'desktop');
  if (!document.body.dataset.detent) document.body.dataset.detent = 'peek';

  /* --vh fallback for browsers without dvh (iOS < 15.4). Recomputed on resize
   * and on visualViewport changes, which is what actually moves on iOS. */
  const setVh = () => {
    const h = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--vh', `${h / 100}px`);
  };
  setVh();
  window.addEventListener('resize', setVh);
  window.visualViewport?.addEventListener('resize', setVh);

  buildShell(app);
  wireSheet(app);

  /* Breakpoint changes flip between sidebar and sheet layout. */
  const mq = window.matchMedia('(max-width: 899px)');
  const onBreak = () => {
    document.body.classList.toggle('mobile', mq.matches);
    document.body.classList.toggle('desktop', !mq.matches);
    applyPanelVisibility();
  };
  mq.addEventListener('change', onBreak);

  /* About is the one panel this module owns. */
  registerPanel('ABOUT', buildAbout);

  /* Tour button — enabled as soon as a tour module registers the action. */
  const btnTour = document.getElementById('btn-tour');
  if (btnTour) {
    btnTour.disabled = !actions.has('tour:start');
    btnTour.addEventListener('click', () => {
      if (!runAction('tour:start')) {
        toast(`The ${TOUR.length}-stop tour is not available in this build yet.`, { kind: 'warn' });
      }
    });
  }

  /* Kiosk (?kiosk=1): dome mode — chrome away, big sol readout on the map. */
  const kioskEl = document.getElementById('kiosk-sol');
  if (app.kiosk && kioskEl) {
    kioskEl.hidden = false;
    const sol = app.manifest?.snapshot_sol ?? SNAPSHOT.sol;
    kioskEl.innerHTML = `SOL ${sol}<span class="sub">Jezero Crater · Mars</span>`;
  }

  setBadge({ state: 'snapshot' });

  /* Bus wiring: anything in the app can raise a toast or move the badge
   * without importing this module (avoids import cycles). */
  app.on('toast', (d) => toast(d && d.msg ? d.msg : String(d), d || {}));
  app.on('badge', (d) => setBadge(d || {}));

  /* Escape closes the sheet / leaves the tour to its own handler. */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMobile() && getDetent() !== 'peek') setDetent('peek');
  });

  shellReady = true;
  /* Anything registered before the shell existed (module-scope registrations in
   * eagerly imported modules) is built now. */
  for (const id of builders.keys()) buildPanel(id);

  /* Feature modules need the map, so they wait for it. */
  app.on('ready', () => { loadFeatureModules(app); });

  app.ui = {
    registerPanel, registerAction, runAction, toast, setBadge,
    setDetent, getDetent, openPanel, PANELS,
  };

  return app.ui;
}
