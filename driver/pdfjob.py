#!/usr/bin/env python3
"""
pdfjob.py — turn a PDF into laser parts using Poppler CLI tools + Pillow.

  * pdf_info(path)                 -> {pages, width_mm, height_mm} (page 1)
  * render_rgb(path, dpi, page)    -> PIL RGB raster of the page
  * detect_layers(rgb)             -> [{color, hex, coverage}]  (ink colors)
  * raster_from_colors(rgb, dpi, colors, tol) -> (PIL 'L' image, w_mm, h_mm)
  * extract_vectors(path, page)    -> {hexcolor: [polylines_mm]}  (for cutting)

No Python PDF wheels required (Poppler: pdfinfo / pdftocairo).
"""

import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image

PT_PER_MM = 72.0 / 25.4  # PDF user-space points per mm


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def pdf_info(path):
    out = _run(["pdfinfo", path])
    pages = 1
    w_pt = h_pt = None
    for line in out.splitlines():
        if line.startswith("Pages:"):
            pages = int(line.split(":", 1)[1].strip())
        elif line.startswith("Page size:"):
            m = re.search(r"([\d.]+)\s*x\s*([\d.]+)\s*pts", line)
            if m:
                w_pt, h_pt = float(m.group(1)), float(m.group(2))
    return {
        "pages": pages,
        "width_mm": round(w_pt / PT_PER_MM, 2) if w_pt else None,
        "height_mm": round(h_pt / PT_PER_MM, 2) if h_pt else None,
    }


def render_rgb(path, dpi, page=1):
    """Render one page to an RGB PIL image at the given DPI (white background)."""
    with tempfile.TemporaryDirectory() as td:
        prefix = os.path.join(td, "pg")
        _run(["pdftocairo", "-png", "-r", str(dpi), "-f", str(page), "-l",
              str(page), "-singlefile", path, prefix])
        img = Image.open(prefix + ".png").convert("RGB")
        img.load()
        return img


def _norm_color(c):
    """Normalize an SVG/CSS color to #rrggbb (handles rgb(%.%,.%) and rgb(r,g,b))."""
    if not c:
        return "#000000"
    c = c.strip()
    if c.startswith("#"):
        if len(c) == 4:
            return "#" + "".join(ch * 2 for ch in c[1:])
        return c.lower()
    m = re.match(r"rgb\(([^)]*)\)", c)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        vals = []
        for p in parts:
            if p.endswith("%"):
                vals.append(int(round(float(p[:-1]) * 255 / 100)))
            else:
                vals.append(int(round(float(p))))
        if len(vals) >= 3:
            return "#%02x%02x%02x" % (vals[0], vals[1], vals[2])
    return c.lower()


def detect_layers(rgb, max_colors=8, min_coverage=0.01):
    """Find distinct ink colors (ignores white/near-white background)."""
    small = rgb.copy()
    small.thumbnail((400, 400))
    q = small.convert("RGB").quantize(colors=max_colors + 4)
    pal = q.getpalette()
    counts = q.getcolors() or []
    total = sum(c for c, _ in counts)
    layers = []
    for count, idx in sorted(counts, reverse=True):
        r, g, b = pal[idx * 3:idx * 3 + 3]
        if r > 245 and g > 245 and b > 245:
            continue  # background
        cov = count / total if total else 0
        if cov < min_coverage:
            continue
        layers.append({
            "rgb": [r, g, b],
            "hex": "#%02x%02x%02x" % (r, g, b),
            "coverage": round(cov, 4),
        })
        if len(layers) >= max_colors:
            break
    return layers


def raster_from_colors(rgb, colors=None, tol=48):
    """
    Build a grayscale ('L') burn image: dark (0) where a pixel matches one of
    `colors` (list of [r,g,b]); white (255) elsewhere. If colors is None, burn
    every non-white pixel. Returns (image, width_mm_at_render_dpi placeholder).
    Caller supplies dpi/offset when constructing the RasterPart.
    """
    src = rgb.convert("RGB")
    w, h = src.size
    out = Image.new("L", (w, h), 255)
    sp = src.load()
    op = out.load()
    if colors:
        cset = [tuple(c) for c in colors]
        for y in range(h):
            for x in range(w):
                r, g, b = sp[x, y]
                for (cr, cg, cb) in cset:
                    if abs(r - cr) <= tol and abs(g - cg) <= tol and abs(b - cb) <= tol:
                        op[x, y] = 0
                        break
    else:
        for y in range(h):
            for x in range(w):
                r, g, b = sp[x, y]
                if not (r > 245 and g > 245 and b > 245):
                    op[x, y] = 0
    return out


# ---------------------------------------------------------------------------
# Vector extraction (for CUT) — pdftocairo SVG + a compact path flattener
# ---------------------------------------------------------------------------
SVG_NS = "{http://www.w3.org/2000/svg}"


def _matmul(a, b):
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return (a0 * b0 + a2 * b1, a1 * b0 + a3 * b1,
            a0 * b2 + a2 * b3, a1 * b2 + a3 * b3,
            a0 * b4 + a2 * b5 + a4, a1 * b4 + a3 * b5 + a5)


def _apply(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def _parse_transform(s):
    m = (1, 0, 0, 1, 0, 0)
    if not s:
        return m
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s):
        v = [float(t) for t in re.split(r"[\s,]+", args.strip()) if t]
        if name == "matrix" and len(v) == 6:
            m = _matmul(m, tuple(v))
        elif name == "translate":
            m = _matmul(m, (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0))
        elif name == "scale":
            sx = v[0]; sy = v[1] if len(v) > 1 else v[0]
            m = _matmul(m, (sx, 0, 0, sy, 0, 0))
    return m


def _flatten_path(d, steps=16):
    """Parse an SVG path 'd' into polylines (lists of (x,y)); flatten beziers."""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtZz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    i = 0
    polys = []
    cur = []
    x = y = 0.0
    start = (0.0, 0.0)
    cmd = None

    def num():
        nonlocal i
        val = float(toks[i]); i += 1
        return val

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t; i += 1
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            if cur:
                polys.append(cur)
            px, py = num(), num()
            x, y = (x + px, y + py) if rel else (px, py)
            cur = [(x, y)]; start = (x, y); cmd = "l" if rel else "L"
        elif c == "L":
            px, py = num(), num()
            x, y = (x + px, y + py) if rel else (px, py)
            cur.append((x, y))
        elif c == "H":
            px = num(); x = x + px if rel else px; cur.append((x, y))
        elif c == "V":
            py = num(); y = y + py if rel else py; cur.append((x, y))
        elif c in ("C", "S", "Q", "T"):
            if c == "C":
                x1, y1, x2, y2, ex, ey = (num() for _ in range(6))
                if rel: x1+=x; y1+=y; x2+=x; y2+=y; ex+=x; ey+=y
            elif c == "S":
                x2, y2, ex, ey = (num() for _ in range(4))
                if rel: x2+=x; y2+=y; ex+=x; ey+=y
                x1, y1 = x, y
            elif c == "Q":
                qx, qy, ex, ey = (num() for _ in range(4))
                if rel: qx+=x; qy+=y; ex+=x; ey+=y
                x1, y1 = x + 2/3*(qx-x), y + 2/3*(qy-y)
                x2, y2 = ex + 2/3*(qx-ex), ey + 2/3*(qy-ey)
            else:  # T -> treat as line to endpoint
                ex, ey = num(), num()
                if rel: ex+=x; ey+=y
                x1, y1, x2, y2 = x, y, ex, ey
            for s in range(1, steps + 1):
                u = s / steps; mu = 1 - u
                bx = mu**3*x + 3*mu**2*u*x1 + 3*mu*u**2*x2 + u**3*ex
                by = mu**3*y + 3*mu**2*u*y1 + 3*mu*u**2*y2 + u**3*ey
                cur.append((bx, by))
            x, y = ex, ey
        elif c == "Z":
            if cur:
                cur.append(start)
                polys.append(cur); cur = []
            x, y = start
    if cur:
        polys.append(cur)
    return polys


def extract_vectors(path, page=1):
    """Return {hexcolor: [polylines in mm]} from the PDF's vector content."""
    with tempfile.TemporaryDirectory() as td:
        svg = os.path.join(td, "v.svg")
        _run(["pdftocairo", "-svg", "-f", str(page), "-l", str(page), path, svg])
        tree = ET.parse(svg)
    root = tree.getroot()
    vh = root.get("height", "0")
    # walk the tree carrying transforms; collect stroked/filled paths by color
    result = {}

    def walk(el, m):
        m = _matmul(m, _parse_transform(el.get("transform", "")))
        tag = el.tag.replace(SVG_NS, "")
        if tag == "path" and el.get("d"):
            color = el.get("stroke") or el.get("fill") or "#000000"
            if color == "none":
                color = el.get("fill", "#000000")
            color = _norm_color(color)
            for poly in _flatten_path(el.get("d")):
                pts_mm = []
                for (px, py) in poly:
                    tx, ty = _apply(m, px, py)
                    pts_mm.append((tx / PT_PER_MM, ty / PT_PER_MM))
                result.setdefault(color, []).append(pts_mm)
        for child in el:
            walk(child, m)

    walk(root, (1, 0, 0, 1, 0, 0))
    return result
