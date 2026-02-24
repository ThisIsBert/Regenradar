(function () {
  const WMS_BASE_URL = "https://maps.dwd.de/geoserver/wms";
  const RADAR_LAYER = "dwd:Niederschlagsradar";
  const FIXED_BOUNDS = [
    [49.17, 8.05],
    [49.63, 8.95]
  ];
  const REFRESH_MS = 5 * 60 * 1000;

  const mapEl = document.getElementById("map");
  const radarImage = document.getElementById("radarImage");
  const refreshBtn = document.getElementById("refreshBtn");
  const timestamp = document.getElementById("timestamp");
  const loadingState = document.getElementById("loadingState");
  let map;

  function getFiveMinuteSlot(date) {
    return new Date(Math.floor(date.getTime() / REFRESH_MS) * REFRESH_MS);
  }

  function buildMapUrl(options) {
    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: RADAR_LAYER,
      STYLES: options.styles || "",
      FORMAT: "image/png",
      TRANSPARENT: options.transparent ? "true" : "false",
      SRS: "EPSG:3857",
      BBOX: options.bbox,
      WIDTH: String(options.width),
      HEIGHT: String(options.height),
      _: String(options.cacheBuster)
    });

    return `${WMS_BASE_URL}?${params.toString()}`;
  }

  function getMapState() {
    const bounds = map.getBounds();
    const sw = map.options.crs.project(bounds.getSouthWest());
    const ne = map.options.crs.project(bounds.getNorthEast());
    const size = map.getSize();

    return {
      bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`,
      width: Math.max(1, Math.round(size.x)),
      height: Math.max(1, Math.round(size.y))
    };
  }

  function buildRadarUrl(date) {
    const slot = getFiveMinuteSlot(date);
    const state = getMapState();
    return buildMapUrl({
      transparent: true,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      cacheBuster: slot.getTime()
    });
  }

  function initMap() {
    if (!window.L) {
      loadingState.textContent = "Karte konnte nicht geladen werden";
      return;
    }

    map = L.map(mapEl, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      touchZoom: false
    });

    const fixedBounds = L.latLngBounds(FIXED_BOUNDS);
    map.fitBounds(fixedBounds, { animate: false, padding: [0, 0] });
    const lockedZoom = map.getZoom();
    map.setMinZoom(lockedZoom);
    map.setMaxZoom(lockedZoom);
    map.setMaxBounds(fixedBounds.pad(0.05));

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap contributors',
      minZoom: lockedZoom,
      maxZoom: lockedZoom
    }).addTo(map);
  }

  function updateTimestamp(date) {
    const time = date.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit"
    });
    timestamp.textContent = `Stand: ${time}`;
  }

  function loadRadar() {
    if (!map) {
      return;
    }

    loadingState.classList.remove("hidden");

    const now = new Date();
    const url = buildRadarUrl(now);

    radarImage.onload = function () {
      loadingState.classList.add("hidden");
      updateTimestamp(now);
    };

    radarImage.onerror = function () {
      loadingState.classList.remove("hidden");
      loadingState.textContent = "Radar derzeit nicht verfuegbar";
    };

    radarImage.src = url;
  }

  function debounce(fn, delayMs) {
    let timeoutId;
    return function () {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(fn, delayMs);
    };
  }

  refreshBtn.addEventListener("click", loadRadar);

  initMap();
  loadRadar();
  window.setInterval(loadRadar, REFRESH_MS);

  window.addEventListener(
    "resize",
    debounce(function () {
      if (!map) {
        return;
      }

      map.invalidateSize(false);
      loadRadar();
    }, 250)
  );

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {
      // Kein Blocking: App soll auch ohne SW laufen.
    });
  }
})();
