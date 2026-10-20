# site/ — helix.sankhacooray.com

The marketing site: one static `public/index.html`, served by a Cloudflare
Worker (`src/index.js`) on the custom domain `helix.sankhacooray.com`.

```sh
cd site
npm install
npx wrangler dev        # local preview
npx wrangler deploy     # publish
```

Deploying needs Cloudflare credentials: either `CLOUDFLARE_API_TOKEN` in the
environment or a one-time `npx wrangler login`.

**Screenshots** in `public/assets/` are captured from the app itself with the
neutral sample in `sample/` — no customer or personal designs.
`sample/sample.pdf` is `sample/sample.html` printed to PDF by headless Chrome
(page 5 is the engrave + cut coaster: its edge is a 0.1 mm hairline). With the
app running (`python3 server.py`), retake every view in dark and light with

```sh
node site/sample/shots.mjs      # writes public/assets/<view>-<theme>.png
```

then convert to JPEG and resize (hero 2000 px wide, the rest 1600):

```sh
cd site/public/assets
for f in *-dark.png *-light.png; do w=1600; case $f in hero-*) w=2000;; esac
  sips -s format jpeg -s formatOptions 80 --resampleWidth $w "$f" --out "${f%.png}.jpg" && rm "$f"; done
```

The script starts its own headless Chrome, shows the laser chip connected, and
puts `prefs.json` back the way it found it.

**Share card and icons**: `og-card.jpg` (1200×630) is a designed card — brand,
headline and a crop of the hero shot — rendered with headless Chrome. The
icons (`icon.svg`, 192/512, maskable 512, 180 apple-touch) come from the app's
own `web/img/helix-icon.svg`; the manifest is `public/manifest.webmanifest`.
