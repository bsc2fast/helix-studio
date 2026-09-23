// Helix Studio site — static assets with a few safety headers.
// There is no API here: the marketing site is read-only, and the app itself
// only ever runs on the visitor's own machine.
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
