#!/usr/bin/env python3
"""
epilog.py — standalone Epilog Legend/Helix driver (vector + raster).

Wire protocol: LPD (RFC 1179) on TCP 515 carrying PJL/PCL + HP-GL/2, ported
faithfully from VisiCut's liblasercut EpilogCutter. No VisiCut/Java/CUPS needed.

A JOB is a list of PARTS sharing one DPI (coordinate + raster resolution):
  * VectorPart : polylines in mm  + power/speed/frequency/focus  (cut / score)
  * RasterPart : a 1-bit PIL image + power/speed/focus            (engrave)

SAFETY: a sent job only queues on the laser. It fires only when the operator
presses GO on the machine. Power/speed are material-dependent — always test.
"""

import math
import socket

ESC = b"\x1b"
FOCUSWIDTH = 0.0252  # mm per focus unit (liblasercut)

BED_W_MM = 609.6  # 24"
BED_H_MM = 304.8  # 12"


def mm2focus(mm):
    return int(mm / FOCUSWIDTH)


def mm2units(mm, dpi):
    return int(round(mm / 25.4 * dpi))


# =============================================================================
# Part descriptors
# =============================================================================
class VectorPart:
    def __init__(self, polylines_mm, power, speed, frequency, focus_mm=0.0):
        self.polylines_mm = polylines_mm
        self.power = int(power)
        self.speed = int(speed)
        self.frequency = int(frequency)
        self.focus_mm = float(focus_mm)


class RasterPart:
    """image: a PIL Image; placed with its top-left at (x_mm, y_mm)."""
    def __init__(self, image, power, speed, dpi, x_mm=0.0, y_mm=0.0, focus_mm=0.0):
        self.image = image
        self.power = int(power)
        self.speed = int(speed)
        self.dpi = int(dpi)
        self.x_mm = float(x_mm)
        self.y_mm = float(y_mm)
        self.focus_mm = float(focus_mm)


# =============================================================================
# Geometry helpers
# =============================================================================
def _apply_overcut(polylines_mm, overcut_mm):
    """For closed loops, extend past the closure into the first edge so the
    laser's start-of-vector firing lag doesn't leave the first edge uncut."""
    if overcut_mm <= 0:
        return polylines_mm
    out = []
    for pl in polylines_mm:
        if len(pl) >= 3 and pl[0] == pl[-1]:
            x0, y0 = pl[0]
            x1, y1 = pl[1]
            dx, dy = x1 - x0, y1 - y0
            d = math.hypot(dx, dy)
            if d > 0:
                ext = min(overcut_mm, d)
                pl = pl + [(x0 + dx / d * ext, y0 + dy / d * ext)]
        out.append(pl)
    return out


def rect_polyline(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]


# =============================================================================
# PJL / PCL / HP-GL generation
# =============================================================================
def _pjl_header(title, dpi, autofocus):
    o = bytearray()
    o += ESC + b"%%-12345X@PJL JOB NAME=%s\r\n" % title.encode("ascii", "replace")
    o += ESC + b"E@PJL ENTER LANGUAGE=PCL\r\n"
    o += ESC + (b"&y1A" if autofocus else b"&y0A")
    o += ESC + b"&y0C" + ESC + b"&y0Z" + ESC + b"&l0U" + ESC + b"&l0Z"
    o += ESC + b"&u%dD" % dpi
    o += ESC + b"*p0X" + ESC + b"*p0Y"
    return bytes(o)


def _pjl_footer():
    return ESC + b"E" + ESC + b"%-12345X" + b"@PJL EOJ \r\n"


def _dummy_raster(dpi, max_x_u, max_y_u):
    o = bytearray()
    o += ESC + b"*t%dR" % dpi + ESC + b"*r0F"
    o += ESC + b"&y0P" + ESC + b"&z100S" + ESC + b"&y0A"
    o += ESC + b"*r%dT" % max_y_u + ESC + b"*r%dS" % max_x_u
    o += ESC + b"*b2M" + ESC + b"&y0O" + ESC + b"*r1A" + ESC + b"*rC"
    return bytes(o)


def _dummy_vector():
    return ESC + b"%1B" + b"IN;" + b"WF0;"


def _vector_pcl(part, dpi, overcut_mm):
    pls_mm = _apply_overcut(part.polylines_mm, overcut_mm)
    pls_u = [[(mm2units(x, dpi), mm2units(y, dpi)) for (x, y) in pl] for pl in pls_mm]
    o = bytearray()
    o += ESC + b"%1B" + b"IN;"
    o += b"WF%d;" % mm2focus(part.focus_mm)
    o += b"XR%04d;" % part.frequency
    o += b"YP%03d;" % part.power
    o += b"ZS%03d;" % part.speed
    for pl in pls_u:
        if len(pl) < 2:
            continue
        o += b"PU%d,%d;" % (pl[0][0], pl[0][1])
        o += b"PD%d,%d" % (pl[1][0], pl[1][1])
        for (x, y) in pl[2:]:
            o += b",%d,%d" % (x, y)
        o += b";"
    o += b"WF0;"
    return bytes(o)


def _packbits(row):
    """TIFF PackBits over a bytes row (port of liblasercut encode())."""
    out = bytearray()
    i, n = 0, len(row)
    while i < n:
        p = i + 1
        while p < n and p < i + 128 and row[p] == row[i]:
            p += 1
        if p - i >= 2:                      # run
            out.append((1 - (p - i)) & 0xFF)
            out.append(row[i])
            i = p
        else:                               # literal
            p = i
            while p < n and p < i + 127 and (p + 1 == n or row[p] != row[p + 1]):
                p += 1
            out.append((p - i - 1) & 0xFF)
            out += row[i:p]
            i = p
    return bytes(out)


def _pack_row_bits(pixels, burn):
    """Pack a list of booleans (burn?) into bytes, MSB = leftmost pixel."""
    out = bytearray((len(pixels) + 7) // 8)
    for x, on in enumerate(pixels):
        if on:
            out[x >> 3] |= (0x80 >> (x & 7))
    return bytes(out)


def _raster_pcl(part, threshold=128):
    """1-bit, unidirectional raster (mode 2M). Burns dark pixels."""
    img = part.image.convert("L")
    w, h = img.size
    px = img.load()
    ox = mm2units(part.x_mm, part.dpi)
    oy = mm2units(part.y_mm, part.dpi)
    max_x = ox + w
    max_y = oy + h

    o = bytearray()
    o += ESC + b"*t%dR" % part.dpi + ESC + b"*r0F"
    o += ESC + b"&y%dP" % part.power + ESC + b"&z%dS" % part.speed
    o += ESC + b"&y%dA" % mm2focus(part.focus_mm)
    o += ESC + b"*r%dT" % max_y + ESC + b"*r%dS" % max_x
    o += ESC + b"*b2M" + ESC + b"&y0O" + ESC + b"*r1A"

    left_to_right = True
    for y in range(h):
        row = _pack_row_bits([px[x, y] < threshold for x in range(w)], True)
        # strip leading / trailing zero bytes
        jump = 0
        start = 0
        while start < len(row) and row[start] == 0:
            start += 1
            jump += 1
        end = len(row)
        while end > start and row[end - 1] == 0:
            end -= 1
        seg = row[start:end]
        if not seg:
            continue
        o += ESC + b"*p%dX" % (ox + jump * 8)
        o += ESC + b"*p%dY" % (oy + y)
        if left_to_right:
            o += ESC + b"*b%dA" % len(seg)
            data = seg
        else:                       # right-to-left: negative count, reversed bytes
            o += ESC + b"*b%dA" % (-len(seg))
            data = seg[::-1]
        enc = _packbits(data)
        ln = len(enc)
        pcks = ln // 8 + (1 if ln % 8 else 0)
        o += ESC + b"*b%dW" % (pcks * 8)
        o += enc
        o += b"\x80" * (pcks * 8 - ln)   # pad to declared byte count
        left_to_right = not left_to_right   # bidirectional, toggle per emitted row
    o += ESC + b"*rC"
    return bytes(o), max_x, max_y


def build_job(parts, dpi, title="job", autofocus=False, overcut_mm=0.5):
    """Assemble one PJL job (bytes) from a list of parts sharing `dpi`."""
    if not parts:
        raise ValueError("no parts")
    body = bytearray()
    bounds_x = [1]
    bounds_y = [1]
    rendered = []
    for p in parts:
        if isinstance(p, RasterPart):
            data, mx, my = _raster_pcl(p)
            rendered.append(("raster", data))
            bounds_x.append(mx)
            bounds_y.append(my)
        elif isinstance(p, VectorPart):
            rendered.append(("vector", _vector_pcl(p, dpi, overcut_mm)))
            allpts = [pt for pl in p.polylines_mm for pt in pl]
            if allpts:
                bounds_x.append(max(mm2units(x, dpi) for x, _ in allpts))
                bounds_y.append(max(mm2units(y, dpi) for _, y in allpts))
        else:
            raise TypeError("unknown part %r" % p)

    job = bytearray()
    job += _pjl_header(title, dpi, autofocus)
    if rendered[0][0] != "raster":
        job += _dummy_raster(dpi, max(bounds_x), max(bounds_y))
    for kind, data in rendered:
        job += data
    if rendered[-1][0] != "vector":
        job += _dummy_vector()
    job += _pjl_footer()
    job += b"\x00" * 4096
    return bytes(job)


# =============================================================================
# LPD transport (RFC 1179)
# =============================================================================
def _ack(sock, timeout):
    sock.settimeout(timeout)
    b = sock.recv(1)
    if b == b"":
        raise IOError("connection closed awaiting ack")
    if b != b"\x00":
        raise IOError("unexpected LPD response: %r" % b)


def send_lpd(host, data, port=515, jobname="001", user="helix",
             title="job", require_ack=True, timeout=10):
    localhost = (socket.gethostname().split(".")[0] or "mac")[:31]
    df = ("dfA%s%s" % (jobname, localhost)).encode()
    cf = ("cfA%s%s" % (jobname, localhost)).encode()
    control = bytearray()
    control += b"H%s\n" % localhost.encode()
    control += b"P%s\n" % user.encode()
    control += b"J%s\n" % title.encode("ascii", "replace")
    control += b"ldfA%s%s\n" % (jobname.encode(), localhost.encode())
    control += b"UdfA%s%s\n" % (jobname.encode(), localhost.encode())
    control += b"N%s\n" % title.encode("ascii", "replace")

    with socket.create_connection((host, port), timeout=timeout) as s:
        s.sendall(b"\x02\n")
        if require_ack:
            _ack(s, timeout)
        s.sendall(b"\x02%d %s\n" % (len(control), cf))
        if require_ack:
            _ack(s, timeout)
        s.sendall(bytes(control) + b"\x00")
        if require_ack:
            _ack(s, timeout)
        s.sendall(b"\x03%d %s\n" % (len(data), df))
        if require_ack:
            _ack(s, timeout)
        s.sendall(data + b"\x00")
        if require_ack:
            _ack(s, timeout)
    return True
