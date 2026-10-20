#!/usr/bin/env python3
"""Writes engrave-cut-test.pdf with exact geometry (no browser scaling):
an A6 page with a 50 mm square drawn as a 0.1 mm red hairline (the cut) and
a solid 30 mm square centred inside it (the engraving). After one engrave +
cut job the piece measures 50.0 mm and the engraved square 30.0 mm, 10.0 mm
in from every edge — proving the cut and the engraving share scale and origin."""
PT = 72 / 25.4
W, H = 105, 148                      # A6, mm


def box(x, y, w, h):                 # mm, top-left origin -> PDF rectangle op
    return "%.4f %.4f %.4f %.4f re" % (x * PT, (H - y - h) * PT, w * PT, h * PT)


content = "\n".join([
    "1 0 0 RG %.4f w" % (0.1 * PT), box(20, 20, 50, 50), "S",   # red 0.1 mm hairline: cut
    "0 0 0 rg", box(30, 30, 30, 30), "f",                       # solid black: engrave
]).encode()
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.4f %.4f] /Contents 4 0 R >>" % (W * PT, H * PT)).encode(),
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
]
out, offs = bytearray(b"%PDF-1.4\n"), []
for i, o in enumerate(objs, 1):
    offs.append(len(out))
    out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
out += b"".join(b"%010d 00000 n \n" % o for o in offs)
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(__file__.rsplit("/", 1)[0] + "/engrave-cut-test.pdf", "wb").write(out)
print("wrote engrave-cut-test.pdf")
