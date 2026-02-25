const CACHE_NAME = "regenradar-shell-v12";
const OSM_TILE_CACHE = "regenradar-osm-v1";
const VENDOR_CACHE = "regenradar-vendor-v1";
const ACTIVE_CACHES = [CACHE_NAME, OSM_TILE_CACHE, VENDOR_CACHE];
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !ACTIVE_CACHES.includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  // Dynamische Wetterdaten niemals dauerhaft im SW cachen, damit sie frisch bleiben.
  if (request.url.includes("maps.dwd.de/geoserver/wms")) {
    return;
  }

  if (request.url.includes("api.open-meteo.com/v1/forecast")) {
    return;
  }

  if (url.hostname === "tile.openstreetmap.org") {
    event.respondWith(cacheFirst(request, OSM_TILE_CACHE));
    return;
  }

  if (url.hostname === "unpkg.com") {
    event.respondWith(cacheFirst(request, VENDOR_CACHE));
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, CACHE_NAME, "./index.html"));
    return;
  }

  if (isSameOrigin) {
    event.respondWith(networkFirst(request, CACHE_NAME));
    return;
  }

  event.respondWith(cacheFirst(request, CACHE_NAME));
});

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);

    if (response && response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) {
        return fallback;
      }
    }

    throw error;
  }
}

async function cacheFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);

    if (response && (response.ok || response.type === "opaque")) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) {
        return fallback;
      }
    }

    throw error;
  }
}
