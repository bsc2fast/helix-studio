#!/usr/bin/env python3
"""
vector_test.py — cut a square OUTLINE (vector) to test cutting: placement,
overcut (first-edge fix), and cut-through quality.

Usage:
  python3 tools/vector_test.py --x 100 --y 100          # 10mm square, acrylic-cut defaults
  python3 tools/vector_test.py --x 100 --y 100 --dry-run
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "driver"))
import epilog  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.6")
    ap.add_argument("--size", type=float, default=10.0, help="square side (mm)")
    ap.add_argument("--x", type=float, default=100.0)
    ap.add_argument("--y", type=float, default=100.0)
    ap.add_argument("--power", type=int, default=90, help="acrylic cut ~90-100")
    ap.add_argument("--speed", type=int, default=10, help="acrylic cut ~9-10")
    ap.add_argument("--frequency", type=int, default=5000, help="acrylic cut ~5000 Hz")
    ap.add_argument("--dpi", type=int, default=epilog.VECTOR_DPI,
                    help="vector coordinate resolution (machine fixed at 1200)")
    ap.add_argument("--overcut", type=float, default=0.5, help="mm re-cut of first edge")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--no-ack", action="store_true")
    a = ap.parse_args()

    rect = epilog.rect_polyline(a.x, a.y, a.size, a.size)
    part = epilog.VectorPart([rect], power=a.power, speed=a.speed, frequency=a.frequency)
    job = epilog.build_job([part], dpi=a.dpi, title="vector-test", overcut_mm=a.overcut)
    print("%gmm square outline at (%g,%g)  P=%d S=%d F=%dHz overcut=%gmm -> %d bytes"
          % (a.size, a.x, a.y, a.power, a.speed, a.frequency, a.overcut, len(job)))
    if a.dry_run:
        if a.out:
            open(a.out, "wb").write(job); print("wrote", a.out)
        return
    print("\n*** queue VECTOR CUT on %s ***  (laser fires on GO)" % a.host)
    if input("type 'send': ").strip().lower() != "send":
        print("aborted"); return
    epilog.send_lpd(a.host, job, jobname="700", title="vector-test",
                    require_ack=not a.no_ack)
    print("sent. Load scrap acrylic, close lid, exhaust ON, press GO.")


if __name__ == "__main__":
    main()
