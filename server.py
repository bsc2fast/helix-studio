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
import sys
import threading
import re
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

from PIL import Image, ImageChops

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
    "thickness": ("text", 12),     # the thickness option's value ("3")
    "sheet": ("text", 40),         # stock size id ("A3|L")
    "sheet_off": ("xy", None),     # where that sheet lies on the bed, mm
    "laser_host": ("host", 60),    # the laser adopted by a scan
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
    pg = {"rgb": rgb, "preview_png": buf.getvalue(),
          "bbox": bbox, "vectors": _simplify(allv),
          "size_mm": (rgb.size[0] / PREVIEW_DPI * 25.4, rgb.size[1] / PREVIEW_DPI * 25.4)}
    s["pages"][n] = pg
    return pg


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
        if path == "/api/materials":
            return self._send_json(load_materials())
        if path == "/api/prefs":
            return self._send_json(load_prefs())
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

        # ---- single-operation send: one preset applied to every placed page ----
        op = req.get("operation")
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
                    if p["key"] not in renders:
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
                part = epilog.RasterPart(sheet, power=op["power"], speed=op["speed"],
                                         dpi=dpi, x_mm=ux, y_mm=uy)
                job = epilog.build_job([part], dpi=dpi, title=title, autofocus=autofocus)
            else:
                polylines, vecs = [], {}
                for p in placed:
                    if p["key"] not in vecs:
                        vecs[p["key"]] = [pl for pls in pdfjob.extract_vectors(
                            p["s"]["pdf_path"], page=p["page"]).values() for pl in pls]
                    bx0, by0 = p["bbox"][0], p["bbox"][1]
                    polylines.extend([[(lambda rx, ry: (rx + p["ox"], ry + p["oy"]))(
                                           *_rot_point(x - bx0, y - by0, p["R"], p["cw"], p["ch"]))
                                       for (x, y) in pl] for pl in vecs[p["key"]]])
                if not polylines:
                    return self._send_json({"error": "no vector lines found to cut"}, 400)
                part = epilog.VectorPart(polylines, power=op["power"], speed=op["speed"],
                                         frequency=op.get("freq", 500))
                job = epilog.build_job([part], dpi=epilog.VECTOR_DPI, title=title, autofocus=autofocus)
            sent = not dry_run
            if sent:
                with SENDING:
                    epilog.send_lpd(host, job, jobname="001", title=title,
                                    require_ack=not req.get("no_ack", False))
            return self._send_json({"jobs": [{"title": title, "bytes": len(job), "sent": sent}],
                                    "dry_run": dry_run, "host": host, "placement": placement})

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
