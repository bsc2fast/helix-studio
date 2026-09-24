# Test files

## `cut-test-a4.pdf` — multi-page cut test

Five A4 pages, one cut shape each, drawn as red 0.1 mm hairlines. Source:
[`cut-test-a4.html`](cut-test-a4.html) (regenerate with the headless-Chrome
command at the top of that file).

| Page | Shape | Size to measure | Holes (Ø4 mm) | Where it sits on the page |
|---|---|---|---|---|
| 1 | square | 50 × 50 mm | 1 | top-left |
| 2 | circle | Ø 60 mm | 2 | centre |
| 3 | rounded rectangle, r 5 | 80 × 40 mm | 3 | bottom-right |
| 4 | hexagon | 70 mm point-to-point, 60.6 mm flat-to-flat | 4 | top-right |
| 5 | L-shape, 25 mm arms | 60 × 60 mm | 5 | bottom-left |

- **The hole count is the page number**, so each cut piece says where it came
  from. There is no text on purpose — text would be cut too.
- **The holes sit in the shape's top-left corner**, so a piece placed at 90°,
  180° or 270° shows it; the L-shape makes the rotation unmistakable.
- **Each shape sits somewhere different on its page**, so importing checks that
  every page is cropped to its artwork, not placed by its page position.

### Running it

1. Load the PDF, choose **A4** as the material size, and press **Include all
   pages** — the five shapes lay out on the sheet without overlapping.
2. Optionally rotate a page or two (the L-shape is the clearest).
3. Pick a cut preset for your material and **cut on scrap first**.
4. Check: every piece falls out cleanly, each has the right hole count, the
   sizes above are within a few tenths of a mm, and each piece sits where the
   bed picture showed it.
