# Helix Studio

A small local web tool that turns a **PDF into laser jobs** for the Epilog
Helix and sends them over the network — no VisiCut, no Windows driver, no CUPS.

Import a PDF → it detects colour "layers" → assign each colour to **cut** or
**engrave**, pick a **material** (Epilog's suggested settings load
automatically) → **Send**. Jobs queue on the laser; you press **GO** to run.

## Run

VS Code: **Run and Debug → "Serve Helix Studio + open browser"**
(serves <http://localhost:4060>, opens Chrome). Or:

```sh
python3 server.py      # then open http://localhost:4060
```

Requirements (already present on this Mac): **Poppler** (`pdftocairo`,
`pdfinfo`), **Pillow**, Python 3. The laser is reached over Ethernet at
`192.168.1.6:515` — see `../farewell-coasters/LASER-SETUP.md`.

## How it works

```text
PDF ──pdftocairo──► preview + colour raster ──► detect layers (colours)
                         │                            │
                         │ engrave                    │ cut
                         ▼                            ▼
              raster mask per colour        vector paths per colour
              (1-bit, PackBits)             (SVG flattened to mm)
                         └──────────► epilog.py ◄──────┘
                              PJL/PCL + HP-GL over LPD:515
```

- `driver/epilog.py` — standalone Epilog driver (vector + raster + LPD send),
  ported from liblasercut. Vector cuts get a small **overcut** so the first
  edge isn't left uncut by the laser's start-of-vector firing lag.
- `driver/pdfjob.py` — PDF → page info, colour raster, layer detection, and
  vector extraction (via Poppler + a compact SVG path flattener).
- `data/materials.json` — Epilog Mini/Helix suggested settings, **30-watt
  column**, transcribed from the official datasheet. Drives the material
  dropdown; these are *starting points* — always test on scrap.
- `server.py` — local web server + REST API.
- `web/` — the UI.

## Placement & bed safety (calibration)

Artwork is **cropped to its ink bounding box** and placed at your **X/Y offset**
from the machine home corner (top-left) — so a small design on a big page
engraves near the origin, not at its page position (this was the original
"head drives into the Y wall" bug).

- **`data/machine.json`** is the bed calibration: `bed_w_mm` / `bed_h_mm`, a
  conservative `usable_w_mm` / `usable_h_mm`, and a `margin_mm`. The server
  **refuses any job** whose placed artwork would exceed `usable − margin`, so a
  job can't drive the head into a wall. Start conservative; widen only after a
  frame test confirms the head clears the rails.
- The UI shows a **bed-placement preview** (artwork rectangle inside the bed,
  green = fits, red = out of bounds) and disables sending when out of bounds.
- **Frame test** button: traces the artwork's bounding box at low power so you
  can watch the head walk the perimeter and confirm it stays on the material
  *before* committing to the real burn.

## Settings notation

`speed` / `power` are 0–100 %. Engraving uses **DPI**; cutting uses **frequency
(Hz)**. Every material's operations come straight from the datasheet.

## Status / next

- ✅ Import, preview, layer detection, material auto-settings, engrave (raster),
  cut (vector), dry-run, send over LPD — all working end to end.
- Each assigned colour is sent as its **own job** (aligned to the same origin);
  combining same-DPI parts into one job is a possible enhancement.
- Colour layers come from the rendered raster; very finely anti-aliased art may
  merge near-colours. Use distinct flat colours per operation (Lightburn-style).
