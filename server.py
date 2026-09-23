#!/usr/bin/env python3
"""
helix-studio server — local web workbench that turns a PDF into laser jobs and
sends them to the Epilog Helix.

  GET  /                     -> web UI
  GET  /api/materials        -> materials.json (Epilog 30W suggested settings)
  POST /api/import           -> body = raw PDF bytes; returns preview + layers
  GET  /preview/<id>.png     -> rendered preview
  POST /api/send             -> JSON assignments; builds & sends jobs (or dry-run)

Bound to 127.0.0.1 by default. Depends on: Poppler CLI + Pillow + driver/*.
"""

import argparse
import json
import os
import shutil
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "driver"))
import epilog          # noqa: E402
import pdfjob          # noqa: E402

DEFAULT_PORT = 4060
DEFAULT_BIND = "127.0.0.1"
DEFAULT_LASER_HOST = "192.168.1.6"
PREVIEW_DPI = 120
MAX_UPLOAD = 64 * 1024 * 1024

CFG = {}        # filled by load_config() before the server starts

SESSIONS = {}   # id -> {pdf_path, preview_png, info}
TMPDIR = os.path.join(HERE, ".sessions")
os.makedirs(TMPDIR, exist_ok=True)


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
        if path == "/api/config":
            mc = CFG["machine"]
            return self._send_json({"laser_host": CFG["laser_host"], "machine": mc,
                                    "machines": [mc]})
        if path.startswith("/preview/"):
            sid = path[len("/preview/"):].rsplit(".", 1)[0]
            s = SESSIONS.get(sid)
            if not s:
                return self._send_json({"error": "unknown session"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(s["preview_png"])))
            self.end_headers()
            return self.wfile.write(s["preview_png"])
        return self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        try:
            if self.path == "/api/import":
                return self.handle_import()
            if self.path == "/api/send":
                return self.handle_send()
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
        rgb = pdfjob.render_rgb(pdf_path, dpi=PREVIEW_DPI, page=1)
        buf = BytesIO()
        rgb.save(buf, "PNG")
        layers = pdfjob.detect_layers(rgb)
        # extracted vector geometry (page-mm), simplified, for the cut-line overlay
        vectors = []
        try:
            for pls in pdfjob.extract_vectors(pdf_path, page=1).values():
                for pl in pls:
                    simp = []
                    for (x, y) in pl:
                        p = [round(x, 1), round(y, 1)]
                        if not simp or abs(p[0] - simp[-1][0]) + abs(p[1] - simp[-1][1]) > 0.3:
                            simp.append(p)
                    if len(simp) >= 2:
                        vectors.append(simp)
        except Exception:
            vectors = []
        bbox = pdfjob.content_bbox_mm(rgb, PREVIEW_DPI)
        content = None
        if bbox:
            content = {
                "x0_mm": round(bbox[0], 2), "y0_mm": round(bbox[1], 2),
                "w_mm": round(bbox[2] - bbox[0], 2), "h_mm": round(bbox[3] - bbox[1], 2),
            }
        SESSIONS[sid] = {"pdf_path": pdf_path, "preview_png": buf.getvalue(), "info": info}
        return self._send_json({
            "id": sid,
            "info": info,
            "preview": "/preview/%s.png" % sid,
            "preview_px": rgb.size,
            "layers": layers,
            "content_mm": content,
            "vectors": vectors,
        })

    def handle_send(self):
        req = json.loads(self._read_body().decode())
        sid = req["id"]
        s = SESSIONS.get(sid)
        if not s:
            return self._send_json({"error": "unknown session"}, 404)
        host = req.get("host", CFG["laser_host"])
        offset = req.get("offset_mm", [0, 0])
        ox, oy = float(offset[0]), float(offset[1])
        autofocus = bool(req.get("autofocus", False))
        dry_run = bool(req.get("dry_run", False))
        mc = CFG["machine"]

        # --- global content bbox (mm) so all layers crop/translate consistently ---
        bbox_rgb = pdfjob.render_rgb(s["pdf_path"], dpi=PREVIEW_DPI, page=1)
        bbox = pdfjob.content_bbox_mm(bbox_rgb, PREVIEW_DPI)
        if not bbox:
            return self._send_json({"error": "the PDF appears blank"}, 400)
        bx0, by0, bx1, by1 = bbox
        cw, ch = bx1 - bx0, by1 - by0

        # rotation (clockwise degrees) swaps the placed dimensions for 90/270
        R = int(req.get("rotation", 0)) % 360
        if R not in (0, 90, 180, 270):
            R = 0
        rw, rh = (cw, ch) if R in (0, 180) else (ch, cw)

        # --- HARD safety-boundary guard (keep the head off the rails) ---
        safety = mc.get("safety_mm", mc.get("margin_mm", 3))
        min_x = min_y = safety
        max_x = min(mc["usable_w_mm"], mc["bed_w_mm"] - safety)
        max_y = min(mc["usable_h_mm"], mc["bed_h_mm"] - safety)
        placement = {
            "content_w_mm": round(rw, 2), "content_h_mm": round(rh, 2),
            "x_mm": round(ox, 2), "y_mm": round(oy, 2),
            "extent_x_mm": round(ox + rw, 2), "extent_y_mm": round(oy + rh, 2),
            "min_x_mm": round(min_x, 2), "min_y_mm": round(min_y, 2),
            "limit_x_mm": round(max_x, 2), "limit_y_mm": round(max_y, 2),
            "rotation": R,
        }
        if ox < min_x - 0.01 or oy < min_y - 0.01 or ox + rw > max_x + 0.01 or oy + rh > max_y + 0.01:
            return self._send_json({
                "error": "OUT OF BOUNDS — inside the %g mm safety margin. "
                         "Content %.0f×%.0f mm at (%.0f,%.0f) reaches (%.0f,%.0f); "
                         "allowed area is (%.0f,%.0f)–(%.0f,%.0f)."
                         % (safety, rw, rh, ox, oy, ox + rw, oy + rh, min_x, min_y, max_x, max_y),
                "placement": placement, "blocked": True,
            }, 400)

        # ---- single-operation send: one preset applied to the whole artwork ----
        op = req.get("operation")
        if op and op.get("type") in ("engrave", "cut"):
            title = op["type"]
            if op["type"] == "engrave":
                dpi = int(op["dpi"])
                rgb = pdfjob.render_rgb(s["pdf_path"], dpi=dpi, page=1)
                mask = pdfjob.raster_from_colors(rgb, colors=None)  # all ink
                cx0 = int(round(bx0 / 25.4 * dpi)); cy0 = int(round(by0 / 25.4 * dpi))
                cx1 = int(round(bx1 / 25.4 * dpi)); cy1 = int(round(by1 / 25.4 * dpi))
                mask = _rot_image(mask.crop((cx0, cy0, cx1, cy1)), R)
                part = epilog.RasterPart(mask, power=op["power"], speed=op["speed"],
                                         dpi=dpi, x_mm=ox, y_mm=oy)
                job = epilog.build_job([part], dpi=dpi, title=title, autofocus=autofocus)
            else:
                polylines = []
                for pls in pdfjob.extract_vectors(s["pdf_path"], page=1).values():
                    polylines.extend(pls)
                if not polylines:
                    return self._send_json({"error": "no vector lines found to cut"}, 400)
                polylines = [[(lambda rx, ry: (rx + ox, ry + oy))(*_rot_point(x - bx0, y - by0, R, cw, ch))
                              for (x, y) in pl] for pl in polylines]
                part = epilog.VectorPart(polylines, power=op["power"], speed=op["speed"],
                                         frequency=op.get("freq", 500))
                job = epilog.build_job([part], dpi=epilog.VECTOR_DPI, title=title, autofocus=autofocus)
            sent = not dry_run
            if sent:
                epilog.send_lpd(host, job, jobname="001", title=title,
                                require_ack=not req.get("no_ack", False))
            return self._send_json({"jobs": [{"title": title, "bytes": len(job), "sent": sent}],
                                    "dry_run": dry_run, "host": host, "placement": placement})

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
                rgb = pdfjob.render_rgb(s["pdf_path"], dpi=dpi, page=1)
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
                    vecs = pdfjob.extract_vectors(s["pdf_path"], page=1)
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
