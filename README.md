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
   boundary — and **Send** is disabled while it is red.
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
| `driver/pdfjob.py` | PDF → page size, colour raster, layer detection, vector extraction (Poppler + a compact SVG path flattener) |
| `data/materials.json` | Epilog Mini/Helix suggested settings, 30 W column |
| `data/machine.json` | the shipped bed calibration — override it in `config.json` |
| `web/` | the UI (one HTML file, one JS file, no build step, no dependencies) |

Speed and power are 0–100 %. Engraving is specified in **DPI**, cutting in
**frequency (Hz)**.

The REST API is small enough to drive from a script: `POST /api/import` with
raw PDF bytes, then `POST /api/send` with a placement and either a single
`operation` or a list of per-colour `assignments`.

---

## Troubleshooting

**`Poppler is required but pdfinfo is not on PATH`** — step 1 didn't take
effect. On Windows, reopen the terminal after installing.

**`Address already in use`** — something else holds port 4060. Use
`python3 server.py --port 4070`.

**The job never arrives / Send hangs** — check `laser_host` is right and that
the machine is on and idle: `ping <laser-ip>`. The laser must be reachable on
TCP port 515, which means the same network segment as your computer, no VPN in
the way.

**"No printable artwork detected"** — the first page rendered blank. Check the
PDF isn't a single huge white image, or that the artwork isn't on page 2.

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
