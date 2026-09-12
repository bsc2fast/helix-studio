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
            return self._send_json({"laser_host": LASER_HOST, "bed_mm": [epilog.BED_W_MM, epilog.BED_H_MM]})
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
        SESSIONS[sid] = {"pdf_path": pdf_path, "preview_png": buf.getvalue(), "info": info}
        return self._send_json({
            "id": sid,
            "info": info,
            "preview": "/preview/%s.png" % sid,
            "preview_px": rgb.size,
            "layers": layers,
        })

    def handle_send(self):
        req = json.loads(self._read_body().decode())
        sid = req["id"]
        s = SESSIONS.get(sid)
        if not s:
            return self._send_json({"error": "unknown session"}, 404)
        host = req.get("host", LASER_HOST)
        offset = req.get("offset_mm", [0, 0])
        autofocus = bool(req.get("autofocus", False))
        dry_run = bool(req.get("dry_run", False))
        assignments = [a for a in req.get("assignments", []) if a.get("op") in ("engrave", "cut")]
        if not assignments:
            return self._send_json({"error": "no engrave/cut assignments"}, 400)

        # cache vector extraction only if needed
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
                part = epilog.RasterPart(mask, power=a["power"], speed=a["speed"],
                                         dpi=dpi, x_mm=offset[0], y_mm=offset[1])
                job = epilog.build_job([part], dpi=dpi, title=title, autofocus=autofocus)
            else:  # cut
                if vecs is None:
                    vecs = pdfjob.extract_vectors(s["pdf_path"], page=1)
                hexc = a.get("hex")
                polylines = vecs.get(hexc, [])
                if not polylines:
                    # fall back: any near-color match
                    for k, v in vecs.items():
                        if k == hexc:
                            polylines = v
                if not polylines:
                    jobs_summary.append({"title": title, "skipped": "no vector paths for %s" % hexc})
                    continue
                polylines = [[(x + offset[0], y + offset[1]) for (x, y) in pl] for pl in polylines]
                dpi = 500
                part = epilog.VectorPart(polylines, power=a["power"], speed=a["speed"],
                                         frequency=a.get("freq", 500))
                job = epilog.build_job([part], dpi=dpi, title=title, autofocus=autofocus)

            if dry_run:
                jobs_summary.append({"title": title, "bytes": len(job), "sent": False})
            else:
                epilog.send_lpd(host, job, jobname="%03d" % jobno, title=title,
                                require_ack=not req.get("no_ack", False))
                jobs_summary.append({"title": title, "bytes": len(job), "sent": True})

        return self._send_json({"jobs": jobs_summary, "dry_run": dry_run, "host": host})


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("helix-studio on http://%s:%d  (laser %s)" % (HOST, PORT, LASER_HOST))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
