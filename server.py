#!/usr/bin/env python3
"""
helix-studio server — local web workbench that turns a PDF into laser jobs and
sends them to the Epilog Helix.

  GET  /                     -> web UI
  GET  /api/materials        -> materials.json (Epilog 30W suggested settings)
  POST /api/import           -> body = raw PDF bytes; returns preview + layers
  GET  /preview/<id>.png     -> rendered preview
  POST /api/send             -> JSON assignments; builds & sends jobs (or dry-run)

Bound to 127.0.0.1 only. Depends on: Poppler CLI + Pillow + driver/*.
"""

import json
import os
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "driver"))
import epilog          # noqa: E402
import pdfjob          # noqa: E402

PORT = 4060
HOST = "127.0.0.1"
LASER_HOST = "192.168.1.6"
PREVIEW_DPI = 120
MAX_UPLOAD = 64 * 1024 * 1024

SESSIONS = {}   # id -> {pdf_path, preview_png, info}
TMPDIR = os.path.join(HERE, ".sessions")
os.makedirs(TMPDIR, exist_ok=True)


def load_materials():
    with open(os.path.join(HERE, "data", "materials.json")) as f:
        return json.load(f)


def load_machine():
    with open(os.path.join(HERE, "data", "machine.json")) as f:
        return json.load(f)


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
            mc = load_machine()
            return self._send_json({"laser_host": LASER_HOST, "machine": mc,
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
        })

    def handle_send(self):
        req = json.loads(self._read_body().decode())
        sid = req["id"]
        s = SESSIONS.get(sid)
        if not s:
            return self._send_json({"error": "unknown session"}, 404)
        host = req.get("host", LASER_HOST)
        offset = req.get("offset_mm", [0, 0])
        ox, oy = float(offset[0]), float(offset[1])
        autofocus = bool(req.get("autofocus", False))
        dry_run = bool(req.get("dry_run", False))
        mc = load_machine()

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

        # --- HARD bed-boundary guard (refuse jobs that would exceed the table) ---
        max_w = mc["usable_w_mm"] - mc["margin_mm"]
        max_h = mc["usable_h_mm"] - mc["margin_mm"]
        placement = {
            "content_w_mm": round(rw, 2), "content_h_mm": round(rh, 2),
            "x_mm": round(ox, 2), "y_mm": round(oy, 2),
            "extent_x_mm": round(ox + rw, 2), "extent_y_mm": round(oy + rh, 2),
            "limit_x_mm": round(max_w, 2), "limit_y_mm": round(max_h, 2),
            "rotation": R,
        }
        if ox < 0 or oy < 0 or ox + rw > max_w or oy + rh > max_h:
            return self._send_json({
                "error": "OUT OF BOUNDS — job would exceed the bed and hit a wall. "
                         "Content %.0f×%.0f mm at (%.0f,%.0f) reaches (%.0f,%.0f); "
                         "usable limit is (%.0f,%.0f)."
                         % (rw, rh, ox, oy, ox + rw, oy + rh, max_w, max_h),
                "placement": placement, "blocked": True,
            }, 400)

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
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("helix-studio on http://%s:%d  (laser %s)" % (HOST, PORT, LASER_HOST))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
