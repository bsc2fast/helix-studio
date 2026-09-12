#!/usr/bin/env python3
"""
raster_test.py — send a solid filled square as a RASTER engrave, to isolate
whether raster works at all through our driver (vs. the PDF/mask pipeline).

Usage:
  python3 tools/raster_test.py            # 15mm square, 150dpi, low power, prompts
  python3 tools/raster_test.py --dry-run  # build only
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "driver"))
import epilog  # noqa: E402
from PIL import Image  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.6")
    ap.add_argument("--size", type=float, default=15.0, help="square side (mm)")
    ap.add_argument("--x", type=float, default=5.0)
    ap.add_argument("--y", type=float, default=5.0)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--power", type=int, default=40)
    ap.add_argument("--speed", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", help="save raw job bytes (dry-run)")
    ap.add_argument("--no-ack", action="store_true")
    a = ap.parse_args()

    px = max(1, int(round(a.size / 25.4 * a.dpi)))
    img = Image.new("L", (px, px), 0)   # solid black = full burn
    part = epilog.RasterPart(img, power=a.power, speed=a.speed, dpi=a.dpi,
                             x_mm=a.x, y_mm=a.y)
    job = epilog.build_job([part], dpi=a.dpi, title="raster-test")
    print("solid %gmm square, %d dpi (%dx%d px), P=%d S=%d -> %d bytes"
          % (a.size, a.dpi, px, px, a.power, a.speed, len(job)))

    if a.dry_run:
        if a.out:
            open(a.out, "wb").write(job)
            print("wrote", a.out)
        return
    print("\n*** queue RASTER engrave on %s ***  (laser fires on GO)" % a.host)
    if input("type 'send': ").strip().lower() != "send":
        print("aborted"); return
    epilog.send_lpd(a.host, job, jobname="800", title="raster-test",
                    require_ack=not a.no_ack)
    print("sent. Load scrap acrylic, close lid, exhaust ON, press GO.")


if __name__ == "__main__":
    main()
