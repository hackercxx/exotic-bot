// Freebuff Sites worker for the EXOTIC BOT web frontend.
// Serves the prebuilt Vite SPA from assets; the platform injects env.ASSETS
// and, with "spa": true in the manifest, handles the index.html fallback.
export default {
  async fetch(request, env) {
    if (!env.ASSETS) {
      return new Response('Assets binding unavailable', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
