#!/usr/bin/env python3
"""
helix-studio server — local web workbench that turns a PDF into laser jobs and
sends them to the Epilog Helix.

  GET  /                     -> web UI
  GET  /api/materials        -> materials.json (Epilog 30W suggested settings)
  POST /api/import           -> body = raw PDF bytes; returns page count + page 1
  GET  /api/page/<id>/<n>    -> page n: preview url, content bbox, cut-line vectors
  GET  /preview/<id>/<n>.png -> page n rendered (/preview/<id>.png = page 1)
  GET  /thumb/<id>/<n>.png   -> small render of page n for the page rail
  POST /api/send             -> one operation over the placed pages ("items", each
                                {doc, page, offset_mm, rotation} — pages may come
                                from several imported PDFs), or per-colour
                                assignments; builds & sends (or dry-run)
  GET  /api/prefs            -> the last setup (material, thickness, sheet + where
                                it lies, machine, adopted laser), from prefs.json
  POST /api/prefs            -> merge a few of those keys back into prefs.json
  GET  /api/finishes         -> your own material colours (finishes.json)
  POST /api/finishes         -> replace them (from the Settings page)
  POST /api/timings          -> log how long a sent job really took (timings.json)
  GET  /api/images           -> picture files in web/img/ (material/machine photos)
  GET  /api/laser/status     -> {host, online, busy}: is the laser's LPD port up?
  POST /api/laser/scan       -> sweep the local /24s for LPD hosts; adopts the
                                laser when exactly one answers (or body {host})

Bound to 127.0.0.1 by default. Depends on: Poppler CLI + Pillow + driver/*.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import re
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "driver"))
import epilog          # noqa: E402
import pdfjob          # noqa: E402
import laserlink       # noqa: E402

DEFAULT_PORT = 4060
DEFAULT_BIND = "127.0.0.1"
DEFAULT_LASER_HOST = "192.168.1.6"
PREVIEW_DPI = 120
THUMB_DPI = 36
THUMB_PX = 260   # longest side of a page-rail thumbnail
MAX_UPLOAD = 64 * 1024 * 1024

CFG = {}        # filled by load_config() before the server starts

# one entry per imported PDF; several may be open at once and a single job can
# mix pages from any of them
SESSIONS = {}   # id -> {pdf_path, name, info, pages: {n: page geometry}, thumbs: {n: png}}
# held for the length of an LPD send: the laser takes one connection at a time,
# so the status probe must not knock on port 515 mid-job
SENDING = threading.Lock()
TMPDIR = os.path.join(HERE, ".sessions")
os.makedirs(TMPDIR, exist_ok=True)

# What the app remembers between runs, so a new session starts where the last
# one left off. It is a convenience file, not configuration: config.json still
# wins, and deleting prefs.json only costs you the dropdown positions.
PREFS_PATH = os.path.join(HERE, "prefs.json")
# key -> (kind, limit). Anything else the UI sends is dropped on the floor.
PREF_SPEC = {
    "machine": ("text", 120),      # machine name, as the dropdown shows it
    "material": ("text", 120),     # material name from materials.json
    "finish": ("text", 40),        # its colour, as the material picker names it
    "thickness": ("text", 12),     # the thickness option's value ("3")
    "sheet": ("text", 40),         # stock size id ("A3|L")
    "sheet_off": ("xy", None),     # where that sheet lies on the bed, mm
    "laser_host": ("host", 60),    # the laser adopted by a scan
    "units": ("text", 4),          # "mm" or "in" — display only, everything stays mm
    "decode": ("decode", None),    # how a page splits into cut lines and engraving
}


def clean_decode(d):
    """The decode setting (Settings → Cut lines), in a shape we trust:
    mode hairline | color | stroke, the hairline width, the cut colour, and
    whether plain Cut presets follow it ("decoded") or cut every path ("all")."""
    d = d if isinstance(d, dict) else {}
    out = dict(pdfjob.DECODE_DEFAULT, plain="all")
    if d.get("mode") in pdfjob.DECODE_MODES:
        out["mode"] = d["mode"]
    try:
        mm = float(d.get("max_mm", out["max_mm"]))
        if math.isfinite(mm):
            out["max_mm"] = round(min(2.0, max(0.01, mm)), 3)
    except (TypeError, ValueError):
        pass
    if isinstance(d.get("color"), str) and HEX.fullmatch(d["color"]):
        out["color"] = d["color"].lower()
    if d.get("plain") in ("all", "decoded"):
        out["plain"] = d["plain"]
    return out


DECODE_HINT = {
    "hairline": "draw the outlines to cut as hairline strokes (%(max_mm)g mm or thinner)",
    "color": "draw the outlines to cut in %(color)s (Settings → Cut lines)",
    "stroke": "draw the outlines to cut as stroked lines, not fills",
}


def load_prefs():
    try:
        with open(PREFS_PATH) as f:
            saved = json.load(f)
        return clean_prefs(saved) if isinstance(saved, dict) else {}
    except (OSError, ValueError):
        return {}   # missing or damaged: start fresh rather than fail the app


def clean_prefs(patch):
    """Keep the known keys, in the shapes we expect. The file is written by
    this app for this app, but it is on disk and hand-editable, so nothing from
    it is trusted any further than a dropdown value."""
    out = {}
    for k, v in patch.items():
        kind = PREF_SPEC.get(k)
        if not kind:
            continue
        kind, limit = kind
        if v is None or v == "":
            out[k] = ""        # an explicit "nothing chosen"
        elif kind == "text" and isinstance(v, str) and len(v) <= limit:
            out[k] = v
        elif kind == "host" and isinstance(v, str) and len(v) <= limit and re.fullmatch(r"[\w.\-:]+", v):
            out[k] = v
        elif kind == "decode" and isinstance(v, dict):
            out[k] = clean_decode(v)
        elif kind == "xy" and isinstance(v, dict):
            try:
                xy = {a: round(float(v.get(a, 0)), 2) for a in ("x", "y")}
            except (TypeError, ValueError):
                continue
            # NaN and inf survive float() but json.dump writes them as bare NaN /
            # Infinity, which no JSON parser will read back — including the UI's
            if all(math.isfinite(n) and abs(n) < 10000 for n in xy.values()):
                out[k] = xy
    return out


def save_prefs(patch):
    """Merge a patch into prefs.json and write it whole, atomically — a crash
    mid-write must not leave a half-file that the next start can't read."""
    prefs = load_prefs()
    prefs.update(clean_prefs(patch))
    tmp = PREFS_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(prefs, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, PREFS_PATH)
    except OSError as e:
        print("helix-studio: could not save prefs.json (%s)" % e)
    return prefs


# Your own material colours and stock sizes, added on the Settings page beside the built-in
# ones (which live in the front-end and can't be edited). Gitignored, like
# config.json, so a `git pull` never touches them.
FINISHES_PATH = os.path.join(HERE, "finishes.json")
HEX = re.compile(r"#[0-9a-fA-F]{6}")


def clean_finishes(data):
    """Keep well-formed entries only — colours {material, name, base, mark,
    see_through, text?} and sizes {material, name, w, h} (mm, 1–2000)."""
    out = []
    items = data.get("custom") if isinstance(data, dict) else None
    for c in (items if isinstance(items, list) else [])[:500]:
        if not isinstance(c, dict):
            continue
        mat, name = c.get("material"), c.get("name")
        base, mark = c.get("base"), c.get("mark")
        if not (isinstance(mat, str) and 0 < len(mat) <= 120 and isinstance(name, str)
                and 0 < len(name.strip()) <= 40 and isinstance(base, str) and HEX.fullmatch(base)
                and isinstance(mark, str) and HEX.fullmatch(mark)):
            continue
        item = {"material": mat, "name": name.strip(), "base": base.lower(), "mark": mark.lower(),
                "see_through": bool(c.get("see_through"))}
        text = c.get("text")   # the contrast ink, worked out by the page from `base`
        if isinstance(text, str) and HEX.fullmatch(text):
            item["text"] = text.lower()
        out.append(item)
    sizes = []
    items = data.get("sizes") if isinstance(data, dict) else None
    for z in (items if isinstance(items, list) else [])[:500]:
        if not isinstance(z, dict):
            continue
        mat, name = z.get("material"), z.get("name")
        try:
            w, h = float(z.get("w")), float(z.get("h"))
        except (TypeError, ValueError):
            continue
        if not (isinstance(mat, str) and 0 < len(mat) <= 120 and isinstance(name, str)
                and 0 < len(name.strip()) <= 40 and "|" not in name and 1 <= w <= 2000 and 1 <= h <= 2000):
            continue
        sizes.append({"material": mat, "name": name.strip(), "w": round(w, 1), "h": round(h, 1)})
    return {"custom": out, "sizes": sizes}


def load_finishes():
    try:
        with open(FINISHES_PATH) as f:
            return clean_finishes(json.load(f))
    except (OSError, ValueError):
        return {"custom": [], "sizes": []}


def save_finishes(data):
    """Replace finishes.json whole, atomically (same reasoning as prefs.json)."""
    clean = clean_finishes(data)
    tmp = FINISHES_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(clean, f, indent=2)
            f.write("\n")
        os.replace(tmp, FINISHES_PATH)
    except OSError as e:
        print("helix-studio: could not save finishes.json (%s)" % e)
    return clean


def load_materials():
    with open(os.path.join(HERE, "data", "materials.json")) as f:
        return json.load(f)


def load_machine():
    with open(os.path.join(HERE, "data", "machine.json")) as f:
        return json.load(f)


def load_config(argv=None):
    """Settings in layers, each one overriding the one before it:

        built-in defaults
          <- data/machine.json        (bed calibration shipped with the repo)
          <- config.json              (yours; gitignored, survives a git pull)
          <- prefs.json               (laser_host only, and only when config.json
                                       doesn't name one: the laser a scan adopted)
          <- HELIX_* environment vars
          <- command-line flags

    config.json takes the same shape as the returned dict, e.g.
    {"laser_host": "10.0.0.9", "machine": {"bed_w_mm": 610, "safety_mm": 12}};
    its "machine" keys are merged over the shipped calibration, so you only
    name the ones you are changing. See config.example.json.
    """
    cfg = {"bind": DEFAULT_BIND, "port": DEFAULT_PORT,
           "laser_host": DEFAULT_LASER_HOST, "machine": load_machine()}

    path = os.environ.get("HELIX_CONFIG", os.path.join(HERE, "config.json"))
    if os.path.exists(path):
        with open(path) as f:
            user = json.load(f)
        cfg["machine"].update(user.pop("machine", {}) or {})
        cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
        cfg["config_path"] = path
        from_config = set(user)
    else:
        from_config = set()

    # a laser adopted by a scan is remembered, but never over an explicit
    # config.json — editing that file must always win
    if "laser_host" not in from_config:
        saved = load_prefs().get("laser_host")
        if saved:
            cfg["laser_host"] = saved

    if os.environ.get("HELIX_LASER_HOST"): cfg["laser_host"] = os.environ["HELIX_LASER_HOST"]
    if os.environ.get("HELIX_PORT"):       cfg["port"] = int(os.environ["HELIX_PORT"])
    if os.environ.get("HELIX_BIND"):       cfg["bind"] = os.environ["HELIX_BIND"]

    ap = argparse.ArgumentParser(description="Helix Studio — PDF to Epilog laser jobs.")
    ap.add_argument("--laser", metavar="IP", help="laser IP address (LPD port 515)")
    ap.add_argument("--port", type=int, help="port for the web UI (default %d)" % DEFAULT_PORT)
    ap.add_argument("--bind", metavar="ADDR",
                    help="interface to bind (default %s — localhost only)" % DEFAULT_BIND)
    args = ap.parse_args(argv)
    if args.laser: cfg["laser_host"] = args.laser
    if args.port:  cfg["port"] = args.port
    if args.bind:  cfg["bind"] = args.bind
    return cfg


def preflight():
    """Fail early, and with an actionable message, when a dependency is absent.
    Poppler ships as command-line tools, so it is the one people don't have."""
    missing = [t for t in ("pdfinfo", "pdftocairo") if not shutil.which(t)]
    if missing:
        hint = {"darwin": "brew install poppler",
                "win32": "winget install --id oschwartz10612.Poppler  "
                         "(or choco install poppler) — then reopen the terminal",
                }.get(sys.platform, "sudo apt install poppler-utils   # or: sudo dnf install poppler-utils")
        sys.exit("helix-studio: Poppler is required but %s not on PATH.\n  %s"
                 % (" and ".join(missing) + (" is" if len(missing) == 1 else " are"), hint))
    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit("helix-studio: Pillow is required.\n  python3 -m pip install -r requirements.txt")


def _rot_point(x, y, R, cw, ch):
    """Rotate a point in a [0,cw]x[0,ch] box clockwise by R deg (0/90/180/270),
    keeping it in the positive quadrant. Matches PIL rotate(-R, expand)."""
    if R == 90:
        return (ch - y, x)
    if R == 180:
        return (cw - x, ch - y)
    if R == 270:
        return (y, cw - x)
    return (x, y)


# ---------- job time estimate ----------
# Display only — it never changes what is sent. The Helix engraves both ways,
# row by row, each row trimmed to its burned bytes (driver/epilog.py), so a
# raster takes about
#     rows × turnaround  +  swept length ÷ (k × speed%)
# and a cut about  paths × start-up  +  path length ÷ (k × speed%).
# Epilog doesn't publish the head speed, so both numbers are fitted to jobs
# timed on the machine: timings.json (gitignored) grows as times are logged,
# seeded with the first one measured.
TIMINGS_PATH = os.path.join(HERE, "timings.json")
SEED_TIMINGS = {"raster": [
    # sound-prasanth.pdf, wood, Clipart/Text 600 DPI S30 P100 — 11 min 47 s (2026-10-16)
    {"rows": 2741, "span_mm": 242287.6, "speed": 30, "dpi": 600, "seconds": 707, "seed": True},
], "vector": []}
DEFAULT_TURN_S = {"raster": 0.06, "vector": 0.2}         # per row / per path, until it can be fitted
DEFAULT_MM_S_PER_PCT = {"raster": 15.0, "vector": 7.6}   # head speed per 1 % (guesses until timed)


def load_timings():
    out = {"raster": list(SEED_TIMINGS["raster"]), "vector": list(SEED_TIMINGS["vector"])}
    try:
        with open(TIMINGS_PATH) as f:
            saved = json.load(f)
        for k in ("raster", "vector"):
            out[k] += [t for t in saved.get(k, []) if isinstance(t, dict)]
    except (OSError, ValueError):
        pass
    return out


def fit_time_model(kind, samples):
    """(turnaround s, s per (mm/speed%), calibrated?) from timed jobs:
    T = a*n + b*len/speed, n = rows (raster) or paths (vector)."""
    n_key, l_key = ("rows", "span_mm") if kind == "raster" else ("paths", "length_mm")
    pts = [(t[n_key], t[l_key] / max(1, t["speed"]), t["seconds"]) for t in samples
           if t.get(n_key) and t.get(l_key) and t.get("speed") and t.get("seconds")]
    if len(pts) >= 2:   # least squares through the origin, two unknowns
        snn = sum(n * n for n, _, _ in pts); sll = sum(l * l for _, l, _ in pts)
        snl = sum(n * l for n, l, _ in pts)
        snt = sum(n * t for n, _, t in pts); slt = sum(l * t for _, l, t in pts)
        det = snn * sll - snl * snl
        if det > 1e-9 * snn * sll:
            a = (snt * sll - slt * snl) / det
            b = (slt * snn - snt * snl) / det
            if a > 0 and b > 0:
                return a, b, True
    a = DEFAULT_TURN_S[kind]
    if pts:   # one job (or a degenerate set): keep the turnaround, fit the speed
        bs = [(t - a * n) / l for n, l, t in pts if l > 0 and t > a * n]
        if bs:
            return a, sum(bs) / len(bs), True
    return a, 1.0 / DEFAULT_MM_S_PER_PCT[kind], False


def raster_stats(img, dpi):
    """Rows the head sweeps and their total length, exactly as the driver emits
    them: dark (< 128) pixels burn, each row trimmed to whole bytes."""
    mask = img.convert("L").point(lambda v: 1 if v < 128 else 0)
    w, h = mask.size
    data = mask.tobytes()   # one byte per pixel, 1 = burn: find/rfind per row run in C
    rows = span_px = 0
    for y in range(h):
        x0 = data.find(1, y * w, (y + 1) * w)
        if x0 < 0:
            continue
        x1 = data.rfind(1, y * w, (y + 1) * w)
        rows += 1
        span_px += ((x1 - y * w) // 8 - (x0 - y * w) // 8 + 1) * 8
    return {"rows": rows, "span_mm": round(span_px / dpi * 25.4, 1), "dpi": dpi}


def vector_stats(polylines):
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for pl in polylines for a, b in zip(pl, pl[1:]))
    return {"paths": sum(1 for pl in polylines if len(pl) > 1), "length_mm": round(length, 1)}


def estimate(kind, stats, speed):
    a, b, calibrated = fit_time_model(kind, load_timings()[kind])
    n = stats["rows"] if kind == "raster" else stats["paths"]
    l = stats["span_mm"] if kind == "raster" else stats["length_mm"]
    # a and b come back too, so the page can redo the sum for another speed
    return dict(stats, kind=kind, speed=speed, calibrated=calibrated, a=a, b=b,
                seconds=round(a * n + b * l / max(1, speed)))


def combo_burn_mask(pdf_path, page, dpi, dec, fast=False):
    """The engraving for an engrave + cut job, before the cut lines are blanked:
    every non-white pixel burns (fast_burn_mask for estimates — the same rule —
    or the driver's own raster_from_colors for a real send). In colour mode every
    pixel in the cut colour is knocked out too, so a thick red line leaves
    nothing behind wherever its path sits."""
    rgb = pdfjob.render_rgb(pdf_path, dpi=dpi, page=page).convert("RGB")
    mask = fast_burn_mask(rgb) if fast else pdfjob.raster_from_colors(rgb, colors=None)
    if dec["mode"] == "color":
        target = tuple(int(dec["color"][i:i + 2], 16) for i in (1, 3, 5))
        r, g, b = ImageChops.difference(rgb, Image.new("RGB", rgb.size, target)).split()
        far = ImageChops.lighter(ImageChops.lighter(r, g), b)      # the largest channel difference
        mask.paste(255, mask=far.point(lambda v: 255 if v <= 80 else 0))
        # and its lighter tints — the anti-aliased edge where the line meets white
        # paper, a few pixels that would each cost a whole sweep of the head:
        # same hue, saturated at all, at least nearly as bright. A darker shade
        # in the artwork (maroon beside red) is still engraved.
        th, ts, tv = Image.new("RGB", (1, 1), target).convert("HSV").getpixel((0, 0))
        if ts >= 40:   # a grey or black cut colour has no hue to match
            hh, ss, vv = rgb.convert("HSV").split()
            hue = hh.point(lambda h: 255 if min(abs(h - th), 256 - abs(h - th)) <= 12 else 0)
            sat = ss.point(lambda v: 255 if v >= 3 else 0)    # a grey edge (black art) has none
            lit = vv.point(lambda v: 255 if v >= tv * 0.85 else 0)
            mask.paste(255, mask=ImageChops.multiply(ImageChops.multiply(hue, sat), lit))
    return mask


def fast_burn_mask(rgb):
    """The same rule as pdfjob.raster_from_colors(colors=None) — a pixel burns
    unless all three channels are > 245 — done with PIL instead of a Python
    loop. Used for estimates only; a real send still builds its raster with
    the driver's own function."""
    r, g, b = rgb.convert("RGB").split()
    darkest = ImageChops.darker(ImageChops.darker(r, g), b)
    return darkest.point(lambda v: 255 if v > 245 else 0)


def log_timing(t):
    """Add one timed job (from the page) to timings.json."""
    kind = t.get("kind")
    if kind not in ("raster", "vector"):
        raise ValueError("kind must be raster or vector")
    keys = ("rows", "span_mm", "dpi") if kind == "raster" else ("paths", "length_mm")
    rec = {k: float(t[k]) for k in keys}
    rec["speed"] = float(t["speed"]); rec["seconds"] = float(t["seconds"])
    if not (1 <= rec["speed"] <= 100 and 1 <= rec["seconds"] <= 48 * 3600):
        raise ValueError("speed or time out of range")
    try:
        with open(TIMINGS_PATH) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = {}
    saved.setdefault(kind, []).append(rec)
    tmp = TIMINGS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(saved, f, indent=2)
    os.replace(tmp, TIMINGS_PATH)
    return rec


def _rot_image(img, R):
    if R in (90, 180, 270):
        return img.rotate(-R, expand=True)  # negative = clockwise; exact for 90s
    return img


def _simplify(polylines):
    """Round to 0.1 mm and drop sub-0.3 mm steps — enough for the on-screen
    cut-line overlay, and a fraction of the JSON."""
    out = []
    for pl in polylines:
        simp = []
        for (x, y) in pl:
            p = [round(x, 1), round(y, 1)]
            if not simp or abs(p[0] - simp[-1][0]) + abs(p[1] - simp[-1][1]) > 0.3:
                simp.append(p)
        if len(simp) >= 2:
            out.append(simp)
    return out


def load_page(s, n):
    """Geometry of page n at PREVIEW_DPI, computed once per session and cached:
    the preview PNG, the ink bbox (mm) and the simplified vectors."""
    n = int(n)
    if not 1 <= n <= s["info"]["pages"]:
        raise ValueError("the PDF has no page %d" % n)
    pg = s["pages"].get(n)
    if pg:
        return pg
    rgb = pdfjob.render_rgb(s["pdf_path"], dpi=PREVIEW_DPI, page=n)
    buf = BytesIO()
    rgb.save(buf, "PNG")
    try:
        allv = [pl for pls in pdfjob.extract_vectors(s["pdf_path"], page=n).values() for pl in pls]
    except Exception:
        allv = []
    # the box every check works from must hold the ink AND every vector: a cut
    # path the render doesn't show (clipped away, or hairline) still gets cut,
    # so it must still be inside the bounds / overlap checks
    bbox = pdfjob.content_bbox_mm(rgb, PREVIEW_DPI)
    pts = [p for pl in allv for p in pl]
    if pts:
        vb = (min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts))
        bbox = vb if not bbox else (min(bbox[0], vb[0]), min(bbox[1], vb[1]),
                                    max(bbox[2], vb[2]), max(bbox[3], vb[3]))
    try:   # every path with its paint, so the page can decode cut lines under any mode
        paths = [{"p": _simplify(q["pts"]), "s": q["stroke"],
                  "w": round(q["stroke_mm"], 3) if q["stroke_mm"] is not None else None, "f": q["fill"]}
                 for q in pdfjob.extract_paths(s["pdf_path"], n)]
    except Exception:
        paths = []
    pg = {"rgb": rgb, "preview_png": buf.getvalue(),
          "bbox": bbox, "vectors": _simplify(allv), "paths": [q for q in paths if q["p"]],
          "size_mm": (rgb.size[0] / PREVIEW_DPI * 25.4, rgb.size[1] / PREVIEW_DPI * 25.4),
          "images": page_images(s["pdf_path"], n)}
    s["pages"][n] = pg
    return pg


def page_images(pdf_path, n):
    """The bitmap images placed on page n, with their effective resolution as
    placed (pdfimages' x/y-ppi). Display only — it tells the user whether a
    page is pure vector or carries pictures, and how sharp those will burn.
    Soft masks are the alpha of an image already listed, so they're skipped."""
    exe = shutil.which("pdfimages")
    if not exe:
        return None   # unknown, not "none"
    try:
        out = subprocess.run([exe, "-list", "-f", str(n), "-l", str(n), pdf_path],
                             capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    imgs = []
    for line in out.splitlines()[2:]:
        f = line.split()
        if len(f) >= 14 and f[2] in ("image", "stencil"):
            try:
                imgs.append({"w": int(f[3]), "h": int(f[4]), "ppi": min(int(f[12]), int(f[13]))})
            except ValueError:
                pass
    return imgs


def page_json(sid, n, pg):
    b = pg["bbox"]
    return {
        "page": n,
        "width_mm": round(pg["size_mm"][0], 2), "height_mm": round(pg["size_mm"][1], 2),
        "preview": "/preview/%s/%d.png" % (sid, n),
        "content_mm": {
            "x0_mm": round(b[0], 2), "y0_mm": round(b[1], 2),
            "w_mm": round(b[2] - b[0], 2), "h_mm": round(b[3] - b[1], 2),
        } if b else None,
        "vectors": pg["vectors"],
        "paths": pg.get("paths", []),
        "images": pg.get("images"),
    }


def _overlap(a, b):
    """Placed rects (x, y, w, h) overlap by more than a hair (touching is fine)."""
    return (min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]) > 0.01 and
            min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]) > 0.01)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        sys.stderr.write("[srv] " + (a[0] % a[1:]) + "\n")

    # ---- helpers ----
    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, ctype):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_png(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        if n > MAX_UPLOAD:
            raise ValueError("upload too large")
        return self.rfile.read(n)

    # ---- routes ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._send_file(os.path.join(HERE, "web", "index.html"), "text/html")
        if path == "/app.js":
            return self._send_file(os.path.join(HERE, "web", "app.js"), "text/javascript")
        if path == "/picker.js":
            return self._send_file(os.path.join(HERE, "web", "picker.js"), "text/javascript")
        # pictures for the visual picker (web/img/) — a flat folder, names checked
        m = re.fullmatch(r"/img/([\w-]+)\.(jpg|jpeg|png|webp|svg)", path)
        if m:
            f = os.path.join(HERE, "web", "img", "%s.%s" % m.groups())
            if not os.path.isfile(f):
                return self._send_json({"error": "not found"}, 404)
            ctype = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                     "webp": "image/webp", "svg": "image/svg+xml"}[m.group(2)]
            return self._send_file(f, ctype)
        if path == "/api/images":   # what web/img/ holds, so the picker asks only for real files
            d = os.path.join(HERE, "web", "img")
            names = sorted(n for n in os.listdir(d) if re.fullmatch(r"[\w-]+\.(jpg|jpeg|png|webp|svg)", n)) \
                if os.path.isdir(d) else []
            return self._send_json(names)
        if path == "/api/materials":
            return self._send_json(load_materials())
        if path == "/api/prefs":
            return self._send_json(load_prefs())
        if path == "/api/finishes":
            return self._send_json(load_finishes())
        if path == "/api/config":
            mc = CFG["machine"]
            return self._send_json({"laser_host": CFG["laser_host"], "machine": mc,
                                    "machines": [mc]})
        if path == "/api/laser/status":
            host = CFG["laser_host"]
            if SENDING.locked():
                return self._send_json({"host": host, "online": True, "busy": True})
            return self._send_json({"host": host, "online": laserlink.probe(host), "busy": False})
        m = re.fullmatch(r"/(api/page|preview|thumb)/(\w+)(?:/(\d+))?(\.png)?", path)
        if m:
            kind, sid, n = m.group(1), m.group(2), int(m.group(3) or 1)
            s = SESSIONS.get(sid)
            if not s:
                return self._send_json({"error": "unknown session"}, 404)
            try:
                if kind == "api/page":
                    return self._send_json(page_json(sid, n, load_page(s, n)))
                if kind == "preview":
                    return self._send_png(load_page(s, n)["preview_png"])
                return self._send_png(self._thumb(s, n))
            except ValueError as e:
                return self._send_json({"error": str(e)}, 404)
        return self._send_json({"error": "not found"}, 404)

    def _thumb(self, s, n):
        if not 1 <= n <= s["info"]["pages"]:
            raise ValueError("the PDF has no page %d" % n)
        png = s["thumbs"].get(n)
        if png is None:
            img = pdfjob.render_rgb(s["pdf_path"], dpi=THUMB_DPI, page=n)
            img.thumbnail((THUMB_PX, THUMB_PX))
            buf = BytesIO()
            img.save(buf, "PNG")
            png = s["thumbs"][n] = buf.getvalue()
        return png

    def do_POST(self):
        try:
            if self.path == "/api/import":
                return self.handle_import()
            if self.path == "/api/send":
                return self.handle_send()
            if self.path == "/api/prefs":
                patch = json.loads(self._read_body().decode() or "{}")
                return self._send_json(save_prefs(patch if isinstance(patch, dict) else {}))
            if self.path == "/api/timings":
                t = json.loads(self._read_body().decode() or "{}")
                try:
                    return self._send_json(log_timing(t if isinstance(t, dict) else {}))
                except (KeyError, TypeError, ValueError) as e:
                    return self._send_json({"error": "bad timing: %s" % e}, 400)
            if self.path == "/api/finishes":
                data = json.loads(self._read_body().decode() or "{}")
                return self._send_json(save_finishes(data))
            if self.path == "/api/laser/scan":
                return self.handle_scan()
            return self._send_json({"error": "not found"}, 404)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._send_json({"error": str(e)}, 500)

    def handle_import(self):
        data = self._read_body()
        if not data[:4] == b"%PDF":
            return self._send_json({"error": "not a PDF"}, 400)
        sid = uuid.uuid4().hex[:12]
        pdf_path = os.path.join(TMPDIR, sid + ".pdf")
        with open(pdf_path, "wb") as f:
            f.write(data)
        info = pdfjob.pdf_info(pdf_path)
        s = SESSIONS[sid] = {"pdf_path": pdf_path, "name": self._upload_name(),
                             "info": info, "pages": {}, "thumbs": {}}
        pg = load_page(s, 1)
        # page 1 flattened into the top level (the original single-page shape),
        # plus "pages" so the UI knows to show the page rail
        out = page_json(sid, 1, pg)
        out.update({"id": sid, "name": s["name"], "info": info, "pages": info["pages"],
                    "preview_px": pg["rgb"].size, "layers": pdfjob.detect_layers(pg["rgb"])})
        return self._send_json(out)

    def _upload_name(self):
        """The dropped file's name, sent in X-Filename (percent-encoded). Only
        ever shown back to the user, so it is reduced to a bare file name."""
        raw = urllib.parse.unquote(self.headers.get("X-Filename", "") or "")
        name = os.path.basename(raw.replace("\\", "/")).strip()
        name = "".join(ch for ch in name if ch.isprintable() and ch not in '"<>')
        return name[:120] or "document.pdf"

    def handle_scan(self):
        """Body {} sweeps the network; body {"host": ip} adopts that host (the
        user's pick when the sweep found more than one LPD device). The adopted
        host lasts until the server restarts — config.json is left alone."""
        req = json.loads(self._read_body().decode() or "{}")
        if req.get("host"):
            CFG["laser_host"] = req["host"]
            save_prefs({"laser_host": CFG["laser_host"]})
            return self._send_json({"host": CFG["laser_host"], "online": laserlink.probe(req["host"])})
        res = laserlink.scan(extra_hosts=[CFG["laser_host"]])
        found = res["found"]
        if CFG["laser_host"] in found or len(found) == 1:
            # the configured laser came back, or exactly one LPD device is on the LAN
            if CFG["laser_host"] not in found:
                CFG["laser_host"] = found[0]
                save_prefs({"laser_host": CFG["laser_host"]})
            return self._send_json(dict(res, host=CFG["laser_host"], online=True))
        return self._send_json(dict(res, host=CFG["laser_host"], online=False))

    def handle_send(self):
        req = json.loads(self._read_body().decode())
        sid = req.get("id")
        host = req.get("host", CFG["laser_host"])
        autofocus = bool(req.get("autofocus", False))
        dry_run = bool(req.get("dry_run", False))
        # estimate_only: work out the job's time without building it (implies dry_run)
        estimate_only = bool(req.get("estimate_only", False))
        dry_run = dry_run or estimate_only
        mc = CFG["machine"]
        safety = mc.get("safety_mm", mc.get("margin_mm", 3))
        min_x = min_y = safety
        max_x = min(mc["usable_w_mm"], mc["bed_w_mm"] - safety)
        max_y = min(mc["usable_h_mm"], mc["bed_h_mm"] - safety)

        # "items" places several pages on one bed; each may name its own "doc"
        # (an imported PDF), so one job can mix pages from several files. The
        # older single-page shape (offset_mm + rotation, page 1 of "id") is one item.
        items = req.get("items") or [{"page": 1, "offset_mm": req.get("offset_mm", [0, 0]),
                                      "rotation": req.get("rotation", 0)}]
        placed = []
        for it in items:
            did = it.get("doc") or sid
            ds = SESSIONS.get(did)
            if not ds:
                return self._send_json({"error": "unknown session"}, 404)
            n = int(it.get("page", 1))
            bbox = load_page(ds, n)["bbox"]
            if not bbox:
                return self._send_json({"error": "page %d appears blank" % n}, 400)
            bx0, by0, bx1, by1 = bbox
            cw, ch = bx1 - bx0, by1 - by0
            # rotation (clockwise degrees) swaps the placed dimensions for 90/270
            R = int(it.get("rotation", 0)) % 360
            if R not in (0, 90, 180, 270):
                R = 0
            rw, rh = (cw, ch) if R in (0, 180) else (ch, cw)
            ox, oy = float(it["offset_mm"][0]), float(it["offset_mm"][1])
            placed.append({"doc": did, "s": ds, "key": (did, n),
                           "page": n, "bbox": bbox, "cw": cw, "ch": ch, "R": R,
                           "ox": ox, "oy": oy, "rw": rw, "rh": rh})
        if not placed:
            return self._send_json({"error": "no pages on the bed"}, 400)
        s = placed[0]["s"]

        # with pages from more than one file on the bed, "page 3" is ambiguous:
        # say which file each one came from
        many_docs = len({p["doc"] for p in placed}) > 1
        def where(p):
            if not many_docs:
                return "page %d" % p["page"]
            return "%s page %d" % (p["s"].get("name") or p["doc"], p["page"])

        placements = [{
            "doc": p["doc"], "name": p["s"].get("name"), "page": p["page"],
            "content_w_mm": round(p["rw"], 2), "content_h_mm": round(p["rh"], 2),
            "x_mm": round(p["ox"], 2), "y_mm": round(p["oy"], 2),
            "extent_x_mm": round(p["ox"] + p["rw"], 2), "extent_y_mm": round(p["oy"] + p["rh"], 2),
            "min_x_mm": round(min_x, 2), "min_y_mm": round(min_y, 2),
            "limit_x_mm": round(max_x, 2), "limit_y_mm": round(max_y, 2),
            "rotation": p["R"],
        } for p in placed]
        placement = placements[0] if len(placements) == 1 else placements

        # --- HARD safety-boundary guard (keep the head off the rails) ---
        for p in placed:
            ox, oy, rw, rh = p["ox"], p["oy"], p["rw"], p["rh"]
            if ox < min_x - 0.01 or oy < min_y - 0.01 or ox + rw > max_x + 0.01 or oy + rh > max_y + 0.01:
                return self._send_json({
                    "error": "OUT OF BOUNDS — %sinside the %g mm safety margin. "
                             "Content %.0f×%.0f mm at (%.0f,%.0f) reaches (%.0f,%.0f); "
                             "allowed area is (%.0f,%.0f)–(%.0f,%.0f)."
                             % ("%s is " % where(p) if len(placed) > 1 else "",
                                safety, rw, rh, ox, oy, ox + rw, oy + rh, min_x, min_y, max_x, max_y),
                    "placement": placement, "blocked": True,
                }, 400)
        # --- pages must not overlap: the laser would burn/cut the shared area twice ---
        for i, a in enumerate(placed):
            for b in placed[i + 1:]:
                if _overlap((a["ox"], a["oy"], a["rw"], a["rh"]), (b["ox"], b["oy"], b["rw"], b["rh"])):
                    return self._send_json({
                        "error": "OVERLAP — %s and %s overlap on the bed; move them apart."
                                 % (where(a), where(b)),
                        "placement": placement, "blocked": True,
                    }, 400)

        op = req.get("operation")
        # how a page splits into cut lines and engraving (Settings → Cut lines)
        dec = clean_decode(req.get("decode"))
        # ---- engrave + cut in ONE job: the raster first, then the cuts ----
        # The cut lines are what the decode mode says (pdfjob.is_cut);
        # everything else is engraved, with the cut lines blanked out of the
        # raster so a line isn't engraved before it's cut. Both parts share the
        # job; the vector part's coordinates stay at 1200/in (epilog.build_job).
        if op and op.get("type") == "combo":
            eop, cop = op["engrave"], op["cut"]
            dpi = int(eop["dpi"])
            vecs, masks, cuts = {}, [], []
            for p in placed:
                if p["key"] not in vecs:
                    vecs[p["key"]] = [q for q in pdfjob.extract_paths(p["s"]["pdf_path"], p["page"])
                                      if pdfjob.is_cut(q, dec)]
                if not vecs[p["key"]]:
                    return self._send_json({"error": "no cut lines on %s — %s, or use an engrave preset"
                                                     % (where(p), DECODE_HINT[dec["mode"]] % dec),
                                            "placement": placement}, 400)
            for p in placed:
                if estimate_only:   # cached per page, dpi and (colour mode) cut colour
                    cache = p["s"].setdefault("est_masks", {})
                    ck = (p["page"], dpi, "combo", dec["color"] if dec["mode"] == "color" else "")
                    if ck not in cache:
                        cache[ck] = combo_burn_mask(p["s"]["pdf_path"], p["page"], dpi, dec, fast=True)
                    full = cache[ck].copy()
                else:
                    full = combo_burn_mask(p["s"]["pdf_path"], p["page"], dpi, dec)
                # blank the cut lines out of the engraving: a band as wide as the
                # line plus 0.4 mm (at least 0.4 mm — the anti-aliased edge, and
                # the ~0.1 % scale pdftocairo gives stroked paths, so a path can sit
                # ~0.1–0.2 mm off its drawn line); a filled shape that is a cut (an
                # outlined stroke) is blanked whole
                draw = ImageDraw.Draw(full)
                px = lambda pl: [(x / 25.4 * dpi, y / 25.4 * dpi) for x, y in pl]
                for q in vecs[p["key"]]:
                    w = max(3, int(round(max(0.4, (q["stroke_mm"] or 0) + 0.4) / 25.4 * dpi)))
                    for pl in q["pts"]:
                        if q["stroke"] is None and len(pl) > 2:
                            draw.polygon(px(pl), fill=255)
                        draw.line(px(pl), fill=255, width=w, joint="curve")
                bx0, by0, bx1, by1 = p["bbox"]
                cx0 = int(round(bx0 / 25.4 * dpi)); cy0 = int(round(by0 / 25.4 * dpi))
                cx1 = int(round(bx1 / 25.4 * dpi)); cy1 = int(round(by1 / 25.4 * dpi))
                masks.append((p, _rot_image(full.crop((cx0, cy0, cx1, cy1)), p["R"])))
                cuts.extend([[(lambda rx, ry: (rx + p["ox"], ry + p["oy"]))(
                                  *_rot_point(x - bx0, y - by0, p["R"], p["cw"], p["ch"]))
                              for (x, y) in pl] for q in vecs[p["key"]] for pl in q["pts"]])
            ux = min(p["ox"] for p in placed)
            uy = min(p["oy"] for p in placed)
            U = lambda mm: epilog.mm2units(mm, dpi)
            spots = [(U(p["ox"]) - U(ux), U(p["oy"]) - U(uy), m) for p, m in masks]
            sheet = Image.new("L", (max(x + m.size[0] for x, _, m in spots),
                                    max(y + m.size[1] for _, y, m in spots)), 255)
            for x, y, m in spots:
                box = (x, y, x + m.size[0], y + m.size[1])
                sheet.paste(ImageChops.darker(sheet.crop(box), m), box)
            r_est = estimate("raster", raster_stats(sheet, dpi), eop["speed"])
            v_est = estimate("vector", vector_stats(cuts), cop["speed"])
            est = {"kind": "combo", "seconds": r_est["seconds"] + v_est["seconds"],
                   "calibrated": r_est["calibrated"] and v_est["calibrated"], "parts": [r_est, v_est]}
            if estimate_only:
                return self._send_json({"estimate": est, "placement": placement})
            parts = []
            if ImageChops.invert(sheet).getbbox() is not None:   # anything left to engrave
                parts.append(epilog.RasterPart(sheet, power=eop["power"], speed=eop["speed"],
                                               dpi=dpi, x_mm=ux, y_mm=uy))
            parts.append(epilog.VectorPart(cuts, power=cop["power"], speed=cop["speed"],
                                           frequency=cop.get("freq", 500)))
            job = epilog.build_job(parts, dpi=dpi, title="engrave+cut", autofocus=autofocus)
            sent = not dry_run
            if sent:
                with SENDING:
                    epilog.send_lpd(host, job, jobname="001", title="engrave+cut",
                                    require_ack=not req.get("no_ack", False))
            return self._send_json({"jobs": [{"title": "engrave+cut", "bytes": len(job), "sent": sent}],
                                    "dry_run": dry_run, "host": host, "placement": placement,
                                    "estimate": est})

        # ---- single-operation send: one preset applied to every placed page ----
        if op and op.get("type") in ("engrave", "cut"):
            title = op["type"]
            if op["type"] == "engrave":
                dpi = int(op["dpi"])
                # each page: render at the job dpi, crop to its ink bbox, rotate;
                # then paste them all into ONE raster spanning every page. Rows are
                # positioned absolutely and blank ones are skipped, so the gaps
                # between pages cost nothing and it stays a single raster part.
                masks, renders = [], {}
                for p in placed:
                    if p["key"] not in renders and estimate_only:
                        # cached per page and dpi; the same burn rule, faster
                        cache = p["s"].setdefault("est_masks", {})
                        ck = (p["page"], dpi)
                        if ck not in cache:
                            cache[ck] = fast_burn_mask(
                                pdfjob.render_rgb(p["s"]["pdf_path"], dpi=dpi, page=p["page"]))
                        renders[p["key"]] = cache[ck]
                    elif p["key"] not in renders:
                        rgb = pdfjob.render_rgb(p["s"]["pdf_path"], dpi=dpi, page=p["page"])
                        renders[p["key"]] = pdfjob.raster_from_colors(rgb, colors=None)  # all ink
                    bx0, by0, bx1, by1 = p["bbox"]
                    cx0 = int(round(bx0 / 25.4 * dpi)); cy0 = int(round(by0 / 25.4 * dpi))
                    cx1 = int(round(bx1 / 25.4 * dpi)); cy1 = int(round(by1 / 25.4 * dpi))
                    masks.append((p, _rot_image(renders[p["key"]].crop((cx0, cy0, cx1, cy1)), p["R"])))
                ux = min(p["ox"] for p in placed)
                uy = min(p["oy"] for p in placed)
                # offsets via the driver's own mm->units rounding, so every page lands on
                # exactly the pixel it would if it were sent on its own
                U = lambda mm: epilog.mm2units(mm, dpi)
                spots = [(U(p["ox"]) - U(ux), U(p["oy"]) - U(uy), m) for p, m in masks]
                sheet = Image.new("L", (max(x + m.size[0] for x, _, m in spots),
                                        max(y + m.size[1] for _, y, m in spots)), 255)
                for x, y, m in spots:
                    box = (x, y, x + m.size[0], y + m.size[1])
                    sheet.paste(ImageChops.darker(sheet.crop(box), m), box)
                est = estimate("raster", raster_stats(sheet, dpi), op["speed"])
                if estimate_only:
                    return self._send_json({"estimate": est, "placement": placement})
                part = epilog.RasterPart(sheet, power=op["power"], speed=op["speed"],
                                         dpi=dpi, x_mm=ux, y_mm=uy)
                job = epilog.build_job([part], dpi=dpi, title=title, autofocus=autofocus)
            else:
                polylines, vecs = [], {}
                for p in placed:
                    if p["key"] not in vecs and dec["plain"] == "decoded":
                        # Settings → Cut lines → plain cuts follow the decode mode
                        vecs[p["key"]] = [pl for q in pdfjob.extract_paths(p["s"]["pdf_path"], p["page"])
                                          if pdfjob.is_cut(q, dec) for pl in q["pts"]]
                    elif p["key"] not in vecs:
                        vecs[p["key"]] = [pl for pls in pdfjob.extract_vectors(
                            p["s"]["pdf_path"], page=p["page"]).values() for pl in pls]
                    bx0, by0 = p["bbox"][0], p["bbox"][1]
                    polylines.extend([[(lambda rx, ry: (rx + p["ox"], ry + p["oy"]))(
                                           *_rot_point(x - bx0, y - by0, p["R"], p["cw"], p["ch"]))
                                       for (x, y) in pl] for pl in vecs[p["key"]]])
                if not polylines:
                    return self._send_json({"error": "no vector lines found to cut"}, 400)
                est = estimate("vector", vector_stats(polylines), op["speed"])
                if estimate_only:
                    return self._send_json({"estimate": est, "placement": placement})
                part = epilog.VectorPart(polylines, power=op["power"], speed=op["speed"],
                                         frequency=op.get("freq", 500))
                job = epilog.build_job([part], dpi=epilog.VECTOR_DPI, title=title, autofocus=autofocus)
            sent = not dry_run
            if sent:
                with SENDING:
                    epilog.send_lpd(host, job, jobname="001", title=title,
                                    require_ack=not req.get("no_ack", False))
            return self._send_json({"jobs": [{"title": title, "bytes": len(job), "sent": sent}],
                                    "dry_run": dry_run, "host": host, "placement": placement,
                                    "estimate": est})

        # ---- per-colour assignments: the original single-page path (first item) ----
        p = placed[0]
        s = p["s"]
        bx0, by0, bx1, by1 = p["bbox"]
        cw, ch, R, ox, oy = p["cw"], p["ch"], p["R"], p["ox"], p["oy"]
        assignments = [a for a in req.get("assignments", []) if a.get("op") in ("engrave", "cut")]
        if not assignments:
            return self._send_json({"error": "no engrave/cut assignments"}, 400)

        vecs = None
        jobs_summary = []
        jobno = 0
        for a in assignments:
            jobno += 1
            title = "%s-%s" % (a.get("op"), a.get("hex", "").lstrip("#") or jobno)
            if a["op"] == "engrave":
                dpi = int(a["dpi"])
                rgb = pdfjob.render_rgb(s["pdf_path"], dpi=dpi, page=p["page"])
                mask = pdfjob.raster_from_colors(rgb, colors=[a["rgb"]] if a.get("rgb") else None)
                # crop to global content bbox (px at this dpi), then rotate
                cx0 = int(round(bx0 / 25.4 * dpi)); cy0 = int(round(by0 / 25.4 * dpi))
                cx1 = int(round(bx1 / 25.4 * dpi)); cy1 = int(round(by1 / 25.4 * dpi))
                mask = _rot_image(mask.crop((cx0, cy0, cx1, cy1)), R)
                part = epilog.RasterPart(mask, power=a["power"], speed=a["speed"],
                                         dpi=dpi, x_mm=ox, y_mm=oy)
                job = epilog.build_job([part], dpi=dpi, title=title, autofocus=autofocus)
            else:  # cut
                if vecs is None:
                    vecs = pdfjob.extract_vectors(s["pdf_path"], page=p["page"])
                polylines = vecs.get(a.get("hex"), [])
                if not polylines:
                    jobs_summary.append({"title": title, "skipped": "no vector paths for %s" % a.get("hex")})
                    continue
                # base-local -> rotate -> place at offset
                polylines = [[(lambda rx, ry: (rx + ox, ry + oy))(*_rot_point(x - bx0, y - by0, R, cw, ch))
                              for (x, y) in pl] for pl in polylines]
                part = epilog.VectorPart(polylines, power=a["power"], speed=a["speed"],
                                         frequency=a.get("freq", 500))
                job = epilog.build_job([part], dpi=epilog.VECTOR_DPI, title=title, autofocus=autofocus)

            if dry_run:
                jobs_summary.append({"title": title, "bytes": len(job), "sent": False})
            else:
                with SENDING:
                    epilog.send_lpd(host, job, jobname="%03d" % jobno, title=title,
                                    require_ack=not req.get("no_ack", False))
                jobs_summary.append({"title": title, "bytes": len(job), "sent": True})

        return self._send_json({"jobs": jobs_summary, "dry_run": dry_run,
                                "host": host, "placement": placement})


def main():
    preflight()
    CFG.update(load_config())
    srv = ThreadingHTTPServer((CFG["bind"], CFG["port"]), Handler)
    if "config_path" in CFG:
        print("helix-studio: settings from %s" % CFG["config_path"])
    print("helix-studio on http://%s:%d  (laser %s)"
          % (CFG["bind"], CFG["port"], CFG["laser_host"]))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
