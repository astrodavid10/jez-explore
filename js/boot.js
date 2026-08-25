/* =============================================================================
 * Jez Explore — boot.js
 *
 * Entry module. Order of operations matters (docs/frontend-design.md §1.2, §7):
 *
 *   1. vendored CSS is already linked from index.html (always local — the dome
 *      network is isolated, and a missing stylesheet is not recoverable)
 *   2. WebGL2 probe BEFORE importing the engine. No WebGL2 → static fallback
 *      panel and stop. This is the ONLY fatal failure in the app.
 *   3. dynamic import of maplibre-gl + maplibre-contour, three CDN tiers:
 *      unpkg → jsdelivr → ./vendor/. MapLibre v6 is ESM-only and derives its
 *      worker URL from import.meta.url, so all three vendored .mjs files must
 *      sit side by side and the page MUST be served over http(s).
 *   4. manifest load + optional z18 probe
 *   5. glyph sanity fetch (a 404 here makes every text layer silently vanish)
 *   6. map construction, then the shell modules
 *
 * Nothing after step 2 may prevent the map from opening.
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * Boot banner helpers. The banner is created in index.html so it paints before
 * any module executes; the global error listeners there also target it.
 * ------------------------------------------------------------------------ */
const bannerEl = () => document.getElementById('boot-status');

function status(msg) {
  const el = bannerEl();
  if (el) el.textContent = msg;
  return msg;
}

function fatal(msg) {
  const el = bannerEl();
  if (el) {
    el.classList.add('fatal');
    el.textContent = msg;
  }
  console.error('[jezero] fatal:', msg);
}

function teardownBanner() {
  const el = bannerEl();
  if (el && !el.classList.contains('fatal')) el.remove();
}

/* ---------------------------------------------------------------------------
 * Step 2 — WebGL2 gate
 * ------------------------------------------------------------------------ */
function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

function showStaticFallback() {
  const el = document.getElementById('static-fallback');
  const app = document.getElementById('app');
  if (app) app.hidden = true;
  if (el) el.hidden = false;
  const banner = bannerEl();
  if (banner) banner.remove();
}

/* ---------------------------------------------------------------------------
 * Step 3 — library loading, three tiers
 * ------------------------------------------------------------------------ */
const CDNS = [
  ['https://unpkg.com/maplibre-gl@6.5.0/dist/maplibre-gl.mjs',
   'https://cdn.jsdelivr.net/npm/maplibre-contour@0.1.0/dist/index.mjs'],
  ['https://cdn.jsdelivr.net/npm/maplibre-gl@6.5.0/dist/maplibre-gl.mjs',
   'https://unpkg.com/maplibre-contour@0.1.0/dist/index.mjs'],
  /* '../vendor/', NOT './vendor/'. A relative specifier in dynamic import()
   * resolves against the IMPORTING MODULE's URL, and this file is served from
   * /js/, so './vendor/…' asked for /js/vendor/maplibre-gl.mjs and 404'd —
   * every tier failed and the app showed the fatal banner instead of a map.
   * Found only by blocking both CDNs (spike S6, integration pass 2026-08-23);
   * with the CDNs reachable this tier never ran, so it was invisible.
   * (index.html's stylesheet href is page-relative, hence plain 'vendor/'.) */
  ['../vendor/maplibre-gl.mjs',
   '../vendor/maplibre-contour.mjs'],
];

async function loadLibraries() {
  let maplibregl = null;
  let mlcontour = null;
  let lastErr = null;

  for (let i = 0; i < CDNS.length; i++) {
    const [glUrl, contourUrl] = CDNS[i];
    const tier = i === CDNS.length - 1 ? 'vendored' : new URL(glUrl).host;
    status(`Loading the map engine (${tier})…`);
    try {
      /* `import * as` — MapLibre v6 has no default export. */
      const gl = await import(glUrl);
      /* maplibre-contour DOES have a default export. Loaded second and in the
       * same try block so a half-loaded tier falls through to the next. */
      const contour = (await import(contourUrl)).default;
      maplibregl = gl;
      mlcontour = contour;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[jezero] library tier ${i + 1}/${CDNS.length} failed:`, err);
    }
  }

  if (!maplibregl) {
    throw new Error(
      'Could not load the map engine. ' +
      (lastErr && lastErr.message ? lastErr.message : 'unknown error')
    );
  }
  return { maplibregl, mlcontour };
}

/* ---------------------------------------------------------------------------
 * Step 5 — glyph sanity fetch (§7, spike S10)
 * A missing glyph PBF does not throw anywhere: text layers just render nothing.
 * Check once at boot and complain loudly in the console.
 * ------------------------------------------------------------------------ */
async function checkGlyphs() {
  /* 0-255 covers ASCII; 8704-8959 covers U+2212 MINUS SIGN, which every
   * contour/elevation label uses ("−2450 m") — spike S7 found it missing. */
  const url = encodeURI('fonts/Noto Sans Regular/0-255.pbf');
  const urlMinus = encodeURI('fonts/Noto Sans Regular/8704-8959.pbf');
  try {
    const resMinus = await fetch(urlMinus, { cache: 'force-cache' });
    if (!resMinus.ok) {
      console.error('[jezero] glyph range 8704-8959 (minus sign) missing — ' +
                    'elevation labels will fall back to local glyph rendering.');
    }
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    /* A real fontstack PBF is tens of KB; an HTML error page is small and
     * starts with '<'. Both checks are cheap. */
    const firstByte = new Uint8Array(buf.slice(0, 1))[0];
    if (buf.byteLength < 4096 || firstByte === 0x3c /* '<' */) {
      throw new Error(`suspicious payload (${buf.byteLength} bytes)`);
    }
    return true;
  } catch (err) {
    console.error(
      '[jezero] GLYPHS MISSING OR BROKEN — every text layer (place names, ' +
      'contour labels, sample names) will be silently invisible. Expected ' +
      `"fonts/Noto Sans Regular/0-255.pbf" and "…/Noto Sans Bold/0-255.pbf". ` +
      `Cause: ${err.message}`
    );
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Lite mode detection (§5). Exported through the app namespace so every module
 * reads one answer. `lite=1` / `lite=0` in the hash always wins.
 * ------------------------------------------------------------------------ */
function detectLite() {
  const hash = location.hash || '';
  /* (^|#|&): a bare "#lite=1" (exactly what the lite button writes when no
   * other hash keys exist) must match too — found in the offset pass. */
  if (/(^|#|&)lite=1(&|$)/.test(hash)) return true;
  if (/(^|#|&)lite=0(&|$)/.test(hash)) return false;
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory ?? 8;
  const narrow = window.matchMedia('(max-width: 700px)').matches;
  return cores <= 4 || mem <= 4 || narrow;
}

/* ---------------------------------------------------------------------------
 * Minimal event bus. Feature modules subscribe via window.jezero.on(...).
 * Deliberately tiny — an EventTarget with a friendlier signature.
 * ------------------------------------------------------------------------ */
function makeBus() {
  const target = new EventTarget();
  return {
    on(name, fn) {
      const wrapped = (e) => fn(e.detail);
      fn.__jz = fn.__jz || new Map();
      fn.__jz.set(name, wrapped);
      target.addEventListener(name, wrapped);
      return () => target.removeEventListener(name, wrapped);
    },
    off(name, fn) {
      const wrapped = fn.__jz && fn.__jz.get(name);
      if (wrapped) target.removeEventListener(name, wrapped);
    },
    emit(name, detail) {
      target.dispatchEvent(new CustomEvent(name, { detail }));
    },
  };
}

/* ===========================================================================
 * Boot
 * ======================================================================== */
async function boot() {
  /* Step 2 — the only fatal gate. */
  if (!hasWebGL2()) {
    showStaticFallback();
    console.error('[jezero] WebGL2 unavailable — static fallback shown.');
    return;
  }

  /* Step 3 */
  let libs;
  try {
    libs = await loadLibraries();
  } catch (err) {
    fatal(err.message + ' — check your network or firewall.');
    return;
  }
  const { maplibregl, mlcontour } = libs;

  /* App namespace. Established before anything else so early failures in the
   * shell modules still leave something inspectable in the console. */
  const bus = makeBus();
  const params = new URLSearchParams(location.search);
  const app = {
    version: '0.1.0',
    maplibregl,
    mlcontour,
    lite: detectLite(),
    kiosk: params.get('kiosk') === '1',
    /* D4 — capture mode: `?shot=1` strips every scrap of UI for a
     * publication-ready screenshot. Read here rather than in ui.js so
     * the flag exists before the shell paints and there is no frame in
     * which the chrome is visible. */
    shot: params.get('shot') === '1',
    map: null,
    demSource: null,
    manifest: null,
    SCALE: null,
    panels: null,
    on: bus.on,
    off: bus.off,
    emit: bus.emit,
  };
  window.jezero = app;

  /* Step 4 — manifest and the optional z18 pack probe. */
  status('Reading tile manifest…');
  const { loadManifest } = await import('./manifest.js');
  const manifest = await loadManifest();
  app.manifest = manifest;
  app.SCALE = manifest.body.scale;

  /* Step 5 — glyphs (non-blocking result, but awaited so the log lands early). */
  app.glyphsOk = await checkGlyphs();

  /* Step 6 — shell modules. Imported dynamically so a syntax error in one of
   * them surfaces on the banner instead of blanking the page. */
  status('Building the map…');
  const [{ initUI }, { createMap }, { initHash }, { initData }] = await Promise.all([
    import('./ui.js'),
    import('./map.js'),
    import('./hash.js'),
    import('./data.js'),
  ]);

  /* UI shell first: it owns the DOM containers the map controls attach to and
   * the toast helper the later steps use to report trouble. */
  initUI(app);

  try {
    await createMap(app);
  } catch (err) {
    fatal('The map could not be created: ' + err.message);
    console.error(err);
    return;
  }

  /* Hash before data: the parsed view is applied to a live map, and data
   * arriving later just calls setData on sources that already exist. */
  initHash(app);
  initData(app);

  teardownBanner();
  bus.emit('ready', app);
  console.info(
    `[jezero] ready — v${app.version}, scale ${app.SCALE}, ` +
    `lite=${app.lite}, kiosk=${app.kiosk}, shot=${app.shot}, ` +
    `z18 pack=${manifest.ultraAvailable ? 'installed' : 'not installed'}`
  );
}

boot().catch((err) => {
  fatal('Startup failed: ' + (err && err.message ? err.message : String(err)));
  console.error(err);
});
