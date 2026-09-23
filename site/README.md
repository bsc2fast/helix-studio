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
environment or a one-time `npx wrangler login`. The screenshots in
`public/assets/` are captured from the app itself with the sample artwork in
this repo — no customer or personal designs.
