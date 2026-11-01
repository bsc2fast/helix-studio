#!/usr/bin/env python3
"""
pltpdf.py — read a .plt (HPGL) cut file and turn it into a one-page vector PDF,
so it goes through the normal PDF import unchanged.

  * looks_like_hpgl(data)   -> bool        (sniff, so the upload's name doesn't matter)
  * parse(text)             -> [polyline]  (mm, origin bottom-left, Y up)
  * plt_to_pdf(data)        -> PDF bytes   (raises ValueError when there's nothing to cut)

Every pen-down path becomes a red (#ff0000), 0.05 mm stroke with no fill, so it
counts as a cut line in all three decode modes (hairline, colour, stroke). The
user still decides: a Cut preset cuts along it, an Engrave preset burns it as a
fine line. The page is the paths' bounding box plus a 1 mm margin, in the
plotter's own orientation.

Understands HPGL as cutters and plotters write it: IN, SP, PU, PD, PA, PR (with
any number of x,y pairs), at the standard 40 units per mm. Other commands
(TB, CT, VS, PG, …) are ignored.
"""

import re
import zlib

UNITS_PER_MM = 40.0
PT_PER_MM = 72.0 / 25.4
CUT_STROKE_MM = 0.05
MARGIN_MM = 1.0

_SNIFF = re.compile(rb"(?:^|;)\s*(?:IN|PU|PD|PA|SP)\s*(?:-?\d|;)", re.I)


def looks_like_hpgl(data):
    """True for HPGL text: not a PDF, and pen commands within the first few KB
    (the cutter's files carry ~1 KB of padding before IN;)."""
    return not data[:4] == b"%PDF" and bool(_SNIFF.search(data[:8192]))


def parse(text):
    """Pen-down paths as polylines in mm (origin bottom-left, Y up)."""
    polylines, cur = [], None
    x = y = 0.0
    relative = False
    for raw in text.split(";"):
        cmd = raw.strip()
        if len(cmd) < 2:
            continue
        op = cmd[:2].upper()
        nums = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", cmd[2:])]
        if op == "PA":
            relative = False
        elif op == "PR":
            relative = True
        elif op not in ("PU", "PD"):
            continue
        pairs = list(zip(nums[0::2], nums[1::2]))
        if op == "PU" or (op in ("PA", "PR") and cur is None):
            if cur is not None and len(cur) > 1:
                polylines.append(cur)
            cur = None
            for px, py in pairs:
                x, y = (x + px, y + py) if relative else (px, py)
            continue
        # PD, or PA/PR while the pen is down: draw to each point
        if cur is None:
            cur = [(x, y)]
        for px, py in pairs:
            x, y = (x + px, y + py) if relative else (px, py)
            cur.append((x, y))
    if cur is not None and len(cur) > 1:
        polylines.append(cur)
    return [[(px / UNITS_PER_MM, py / UNITS_PER_MM) for px, py in pl] for pl in polylines]


def plt_to_pdf(data):
    """HPGL bytes -> a one-page PDF (bytes) of red hairline cut paths."""
    polylines = parse(data.decode("latin-1"))
    if not polylines:
        raise ValueError("no cut paths (PU/PD) in this .plt")
    xs = [p[0] for pl in polylines for p in pl]
    ys = [p[1] for pl in polylines for p in pl]
    x0, y0 = min(xs) - MARGIN_MM, min(ys) - MARGIN_MM
    w_mm, h_mm = max(xs) + MARGIN_MM - x0, max(ys) + MARGIN_MM - y0

    def pt(p):   # plotter Y-up matches PDF user space, so only shift + scale
        return "%.3f %.3f" % ((p[0] - x0) * PT_PER_MM, (p[1] - y0) * PT_PER_MM)

    ops = ["1 0 0 RG", "%.4f w" % (CUT_STROKE_MM * PT_PER_MM), "1 J 1 j"]
    for pl in polylines:
        ops.append(pt(pl[0]) + " m")
        ops.extend(pt(p) + " l" for p in pl[1:])
        ops.append("S")
    stream = zlib.compress("\n".join(ops).encode("ascii"), 9)

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.3f %.3f] /Contents 4 0 R /Resources << >> >>"
         % (w_mm * PT_PER_MM, h_mm * PT_PER_MM)).encode("ascii"),
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)
