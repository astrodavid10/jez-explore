# About Jez Explore

*This file mirrors the About panel inside the app (`js/ui.js` → `aboutHTML`). Keep the two in
step; the panel is the version the public reads.*

## What this is

**Jez Explore** lets you explore Jezero Crater on Mars alongside NASA's *Perseverance* rover
and the *Ingenuity* helicopter. Jezero is the 45-kilometer impact basin that held a lake and a
river delta more than three billion years ago. *Perseverance* landed there on February 18,
2021, and *Ingenuity* made the first 72 powered flights on another world above it.

Drag the sol slider to replay the whole mission, turn on 3D terrain, raise the ancient lake to
its shoreline, and follow the rover from the crater floor up onto the western rim.

## Who made it

Built by **A. David Weigel** — *INTUITIVE*® Planetarium, U.S. Space & Rocket Center — as a
companion to the planetarium's Mars programs.

*Data to Dome, Dome to Phone:* the same NASA data that drives the 20-meter dome downtown
drives this page in your hand, from the same blended elevation and imagery mosaics.

## How the map was made

Orbital imagery (HiRISE, CTX and HRSC) and several elevation models were blended into seamless
regional mosaics, then cut into standard web map tiles with GDAL (`gdal raster tile`,
WebMercatorQuad, 256 px, XYZ). Elevation ships as Terrarium-encoded PNGs, so the browser
decodes real meters out of the pixel colors — that is the single source for the contour lines,
the 3D relief and the elevation readout.

### One honest caveat about scale

Web maps assume Earth. To use ordinary web-map tiles, the Mars data is relabelled onto an
Earth-sized Mercator grid ("pretend Earth"), which stretches every horizontal distance by

```
SCALE = 6,378,137 m (Earth radius) / 3,396,190 m (Mars radius) = 1.878027
```

Vertical values are untouched — true Mars meters on the areoid. The app divides that factor
back out everywhere it matters:

| Thing | Correction |
|---|---|
| Scale bar | custom control, ground distance ÷ 1.878027 (MapLibre's own `ScaleControl` is never used) |
| Any quoted distance | `marsMetres(a, b) = a.distanceTo(b) / SCALE` |
| 3D relief | `terrain.exaggeration = SCALE × ui`, so the slider's **1× is true Mars** |
| Ingenuity altitude ribbon | `height = agl × SCALE × ui` (the `vscale` global-state property) |

`SCALE` is read from `tiles/manifest.json`; it is never hardcoded outside `js/config.js`'s
fallback.

## Why the elevations are negative

Mars has no sea level. Heights are measured from the **areoid** (Mars2000) — a mathematical
surface of constant gravity that stands in for one. Jezero's floor sits about 2,600 meters
*below* that zero, so contour labels read "−2,450 m" and so on. The rover is now more than 600
meters higher than where it landed, and still below zero.

The paleolake is drawn from basin-clipped polygons at −2500, −2450, −2395 and −2350 m. The
−2395 m level is the mapped highstand — the shoreline where Perseverance found carbonate-rich
rock along the crater's inner margin. In 3D, a flooded level is drawn as shading over the
ground rather than a flat water surface: it shows which ground is under water, not a
mirror-flat lake.

## Data currency

Mission data is a committed snapshot (sol 1955 / 2026-08-20 at the time of writing; the app
reads the real values from `tiles/manifest.json` and `data/snapshot.json`). "Where is Percy
now?" asks NASA for the latest position live, with a 6-second timeout; if that fails the
snapshot stands and the badge turns amber. A full re-slim of NASA's mission files is a pipeline
job, not a browser one.

## Credits

- **Imagery:** NASA/JPL-Caltech/UArizona (HiRISE) · NASA/JPL-Caltech/MSSS (CTX)
- **Elevation:** HiRISE DTMs (NASA/JPL/UArizona) · HRSC (ESA/DLR/FU Berlin) · USGS Astrogeology
- **Traverse, sample and flight data:** NASA/JPL-Caltech, via the NASA MMGIS team
- **Tiles, blend and this application:** A. David Weigel, *INTUITIVE*® Planetarium,
  U.S. Space & Rocket Center

## Software

- [MapLibre GL JS](https://maplibre.org/) 6.5.0 — 3-clause BSD (`vendor/LICENSE-maplibre-gl.txt`)
- [maplibre-contour](https://github.com/onthegomap/maplibre-contour) 0.1.0 — 3-clause BSD
  (`vendor/LICENSE-maplibre-contour.txt`)
- Map label fonts: Noto Sans (SIL Open Font License), vendored as glyph PBFs in `fonts/`

No trackers, no cookies, no analytics. Everything the page needs is either in this repository
or fetched directly from NASA at the moment you ask for it.

## NASA's own map

This is a companion, not a replacement. For the complete, authoritative mission map see
[NASA's Mars 2020 map](https://mars.nasa.gov/maps/location/?mission=M20).
