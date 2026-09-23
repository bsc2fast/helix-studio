# Helix Studio

**[helix.sankhacooray.com](https://helix.sankhacooray.com)**

Turn a **PDF into laser jobs** for an Epilog Helix (or Mini) and send them over
the network — no VisiCut, no Windows-only Epilog driver, no CUPS printer queue.

It runs as a small local web app: you start a Python server on your own
machine, open `http://localhost:4060` in any browser, drop in a PDF, place it
on a picture of the bed, pick a material preset, and hit **Send**. The job
queues on the laser and you press **GO** on the machine itself.

```text
   PDF  ──▶  place on the bed  ──▶  pick material + preset  ──▶  Send  ──▶  press GO
```

* Works on macOS, Windows and Linux — the only interface is your browser.
* Nothing leaves your machine. The server binds to localhost, and the only
  outbound connection is to the laser on your own network.
* Material presets are Epilog's published suggested settings for a **30-watt**
  Helix/Mini, transcribed from the datasheet.

---

## ⚠️ Before anything else

A laser cutter is a fire hazard and a machine that can hurt you.

* **Never run a job unattended**, and keep the lid closed and extraction on.
* The shipped presets are **starting points from Epilog's datasheet for a 30 W
  tube**. Your machine's real power, optics and material differ. **Always test
  on scrap first.**
* The bed size and safe travel in `data/machine.json` are the calibration of
  *one specific machine*. **They are almost certainly wrong for yours** —
  see [Configure your machine](#3-configure-your-machine) before your first send.
  The server refuses out-of-bounds jobs, but that guard is only as good as
  the numbers you give it.
* This software is provided as-is, with no warranty (see [LICENSE](LICENSE)).
  You are responsible for what your laser does.

---

## Requirements

| What | Why | Notes |
|---|---|---|
| **Python 3.9+** | runs the server | `python3 --version` |
| **Pillow** | rasterises the artwork | installed with pip, below |
| **Poppler** | reads and renders the PDF (`pdfinfo`, `pdftocairo`) | a separate install, below |
| **An Epilog Helix / Mini on your network** | receives the job over LPD (port 515) | you need its IP address |

---

## Install

### 1. Install Poppler

**macOS** (with [Homebrew](https://brew.sh)):

```sh
brew install poppler
```

**Windows** (PowerShell):

```powershell
winget install --id oschwartz10612.Poppler
```

Then **close and reopen the terminal** so the new `PATH` takes effect. If
`pdfinfo -v` still isn't found, add Poppler's `bin` folder to your `PATH`
manually. (`choco install poppler` works too, if you use Chocolatey.)

**Linux**:

```sh
sudo apt install poppler-utils      # Debian / Ubuntu
sudo dnf install poppler-utils      # Fedora
```

Check it worked — this should print a version, not "command not found":

```sh
pdfinfo -v
```

### 2. Get Helix Studio and its Python dependency

```sh
git clone https://github.com/bsc2fast/helix-studio.git
cd helix-studio
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
python3 -m pip install -r requirements.txt
```

The virtual environment is optional but recommended; without it,
`python3 -m pip install --user -r requirements.txt` is fine.

### 3. Configure your machine

Copy the example config and edit it with your own laser's IP address and bed
measurements:

```sh
cp config.example.json config.json     # Windows: copy config.example.json config.json
```

```jsonc
{
  "laser_host": "192.168.1.6",   // your laser's IP address
  "machine": {
    "name": "Epilog Helix 24x18 (30W)",
    "bed_w_mm": 609.6,           // full bed, X = the long axis
    "bed_h_mm": 457.2,
    "usable_w_mm": 605.0,        // how far the head actually reaches, measured
    "usable_h_mm": 450.0,
    "safety_mm": 10.0            // no-go border; jobs crossing it are refused
  }
}
```

`config.json` is gitignored, so your settings survive a `git pull`. Any key you
leave out keeps the shipped default. **Find your laser's IP** on the machine's
own control panel, under its network/TCP-IP settings.

> Start conservative with `usable_*`. Widen it only after you have watched the
> head travel to that edge and clear the rails.

### 4. Run it

```sh
python3 server.py
```

It prints:

```text
helix-studio: settings from /path/to/helix-studio/config.json
helix-studio on http://127.0.0.1:4060  (laser 192.168.1.6)
```

Open <http://localhost:4060>. Leave the terminal running while you work; press
`Ctrl-C` to stop the server.

Useful flags — these beat `config.json`, which beats the shipped defaults:

```sh
python3 server.py --laser 10.0.0.9      # a different laser, just this once
python3 server.py --port 4070           # if 4060 is taken
python3 server.py --bind 0.0.0.0        # let other machines on the LAN use it
```

`HELIX_LASER_HOST`, `HELIX_PORT`, `HELIX_BIND` and `HELIX_CONFIG` do the same
as environment variables.

> `--bind 0.0.0.0` exposes the UI — and through it your laser — to everyone on
> the network, with no password. Only do that on a network you trust.

---

## Using it

1. **Drop a PDF** onto the page (or click to choose one). Vector artwork works
   best; the page is cropped to its ink, so whitespace around the design is
   ignored.
2. **Place it.** Drag the artwork around the bed picture, or type X/Y in mm.
   X/Y is measured from the laser's home corner (top-left). `Rotate` turns it
   in 90° steps, `Center` centres it in the safe area. The outline is green
   while the placement is legal and red once it crosses the dashed safety
   boundary — and **Send** is disabled while it is red. Pick a **material
   size** (A4, Arch B, Letter… — only sizes that fit the bed are listed) to see
   your stock drawn on the bed; drag it, or type its X/Y in the **Material**
   card, to match where the sheet really lies. `Rotate` on either card is only
   enabled when the turned sheet or artwork still fits from where it sits — the
   card says how far to move it when it doesn't.
   **Multi-page PDFs** list every page down the left. Page 1 starts on the bed;
   **Include** puts another page on in the first free spot, so several pages
   can be laid out on one larger sheet and sent as one job. Overlapping pages
   turn red and **Send** stays disabled until you move them apart.
3. **Pick material and thickness**, then a **preset**. Engrave presets (`▦`)
   raster the artwork; cut presets (`✂`) follow its vector lines. Presets that
   cannot cut through the thickness you chose are hidden.
4. **Send.** The job appears on the laser's queue; walk over and press **GO**.

**To engrave and then cut the same piece**, send twice: choose the engrave
preset and send, then switch to the cut preset and send again without moving
anything. Both jobs are placed from the same origin, so they line up.

---

## How it works

```text
PDF ──pdftocairo──► preview + raster ──┬──► engrave: 1-bit mask (PackBits)
                                       └──► cut: vector paths flattened to mm
                                                     │
                                                     ▼
                                         PJL / PCL + HP-GL over LPD:515
```

| Path | What it is |
|---|---|
| `server.py` | the local web server + REST API, and the out-of-bounds guard |
| `driver/epilog.py` | standalone Epilog driver (raster + vector + LPD send), ported from liblasercut. Vector cuts get a small **overcut** so the laser's start-of-vector firing lag doesn't leave the first edge uncut |
| `driver/laserlink.py` | is the laser reachable (LPD port probe), and a local-network scan to find it |
| `driver/pdfjob.py` | PDF → page size, colour raster, layer detection, vector extraction (Poppler + a compact SVG path flattener) |
| `data/materials.json` | Epilog Mini/Helix suggested settings, 30 W column |
| `data/machine.json` | the shipped bed calibration — override it in `config.json` |
| `web/` | the UI (one HTML file, one JS file, no build step, no dependencies) |

Speed and power are 0–100 %. Engraving is specified in **DPI**, cutting in
**frequency (Hz)**.

The REST API is small enough to drive from a script: `POST /api/import` with
raw PDF bytes (returns the page count and page 1), `GET /api/page/<id>/<n>` for
any other page, then `POST /api/send` with an `operation` and the placed pages
as `items: [{page, offset_mm: [x, y], rotation}]` — or a single `offset_mm` +
`rotation` for page 1, or a list of per-colour `assignments`. Placed pages must
not overlap; they go to the laser as one job.

---

## Troubleshooting

**`Poppler is required but pdfinfo is not on PATH`** — step 1 didn't take
effect. On Windows, reopen the terminal after installing.

**`Address already in use`** — something else holds port 4060. Use
`python3 server.py --port 4070`.

**The IP chip says Scan** — the laser didn't answer on port 515. Helix Studio
scans your local network for it (right away, then every 30 s) and switches to
the new address when it finds exactly one; if several printers answer it asks
which one is the laser. Send stays disabled until it's reachable.

**The job never arrives / Send hangs** — check `laser_host` is right and that
the machine is on and idle: `ping <laser-ip>`. The laser must be reachable on
TCP port 515, which means the same network segment as your computer, no VPN in
the way.

**"No printable artwork detected"** — the first page rendered blank. Check the
PDF isn't a single huge white image. For a multi-page PDF, include the page that
has the artwork from the page list on the left.

**A cut preset does nothing** — cutting follows *vector* paths. A PDF that
contains only a photo or a flattened bitmap has none; export vectors from your
design tool, or use an engrave preset instead.

**The engraving came out lighter or deeper than expected** — that is the
preset meeting your actual machine. Adjust speed/power in
`data/materials.json`, and test on scrap.

---

## License

MIT — see [LICENSE](LICENSE). Not affiliated with, or endorsed by, Epilog
Laser. "Epilog" and "Helix" are their trademarks.
