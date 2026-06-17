// ProQure service worker.
// Strategy is deliberately conservative so it can never serve stale app code:
//   - Navigations / HTML  -> NETWORK-FIRST (a new deploy always wins when online;
//                            cache is only used as an offline fallback).
//   - Same-origin assets  -> stale-while-revalidate (Vite hashes filenames, so
//                            cached assets are always correct for their build).
//   - /api/* and any cross-origin (Supabase, Resend, OpenRouter) -> NOT handled
//                            here at all; they always go straight to the network.
// Bump CACHE when you want to force-drop old cached assets.
const CACHE = "proqure-v1";
const PRECACHE = ["/", "/offline.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // never touch writes
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;  // Supabase / Resend / OpenRouter etc. -> network
  if (url.pathname.startsWith("/api/")) return;     // API -> always network

  // Navigations: network-first, fall back to cache, then the offline page.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        return (await caches.match(req)) || (await caches.match("/")) || (await caches.match("/offline.html"));
      }
    })());
    return;
  }

  // Other same-origin GETs (hashed assets, icons): stale-while-revalidate.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response("", { status: 504 });
  })());
});
