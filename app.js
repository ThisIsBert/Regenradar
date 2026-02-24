(function () {
  const WMS_BASE_URL = "https://maps.dwd.de/geoserver/wms";
  const NOW_LAYER = "dwd:Niederschlagsradar";
  const FILM_LAYER = "dwd:Radar_rv_product_1x1km_ger";
  const FIXED_BOUNDS = [
    [49.17, 8.05],
    [49.63, 8.95]
  ];
  const STEP_MINUTES = 5;
  const STEP_MS = STEP_MINUTES * 60 * 1000;
  const AUTO_REFRESH_MS = STEP_MS;
  const FILM_WINDOW_MINUTES = 60;
  const FILM_FRAME_DELAY_MS = 350;
  const FILM_PARALLEL_REQUESTS = 5;
  const FILM_START_THRESHOLD = 8;

  const mapEl = document.getElementById("map");
  const radarImage = document.getElementById("radarImage");
  const refreshBtn = document.getElementById("refreshBtn");
  const filmBtn = document.getElementById("filmBtn");
  const timestamp = document.getElementById("timestamp");
  const filmStatus = document.getElementById("filmStatus");
  const loadingState = document.getElementById("loadingState");

  let map;
  let autoRefreshTimerId;
  let filmTimerId;
  let isFilmPlaying = false;
  let currentFilmRunId = 0;
  const frameCache = new Map();

  function getFiveMinuteSlot(date) {
    return new Date(Math.floor(date.getTime() / STEP_MS) * STEP_MS);
  }

  function formatTime(date) {
    return date.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatIsoTime(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function setFilmStatus(text) {
    filmStatus.textContent = `Film: ${text}`;
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

  function buildRadarUrl(options) {
    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: options.layer,
      STYLES: "",
      FORMAT: "image/png",
      TRANSPARENT: "true",
      SRS: "EPSG:3857",
      BBOX: options.bbox,
      WIDTH: String(options.width),
      HEIGHT: String(options.height),
      _: String(options.cacheBuster)
    });

    if (options.time) {
      params.set("TIME", options.time);
    }

    return `${WMS_BASE_URL}?${params.toString()}`;
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
      attribution: "&copy; OpenStreetMap contributors",
      minZoom: lockedZoom,
      maxZoom: lockedZoom
    }).addTo(map);
  }

  function updateNowTimestamp(date) {
    timestamp.textContent = `Stand: ${formatTime(date)}`;
  }

  function updateFilmTimestamp(date) {
    timestamp.textContent = `Filmzeit: ${formatTime(date)}`;
  }

  function loadCurrentRadar() {
    if (!map || isFilmPlaying) {
      return;
    }

    loadingState.classList.remove("hidden");
    loadingState.textContent = "Lade Radarbild...";

    const now = new Date();
    const slot = new Date(getFiveMinuteSlot(now).getTime() - STEP_MS);
    const state = getMapState();
    const url = buildRadarUrl({
      layer: NOW_LAYER,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      cacheBuster: slot.getTime()
    });

    radarImage.onload = function () {
      loadingState.classList.add("hidden");
      updateNowTimestamp(slot);
      setFilmStatus("aus");
    };

    radarImage.onerror = function () {
      loadingState.classList.remove("hidden");
      loadingState.textContent = "Radar derzeit nicht verfuegbar";
    };

    radarImage.src = url;
  }

  function createFilmTimeline() {
    const anchor = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);
    const timeline = [];

    for (let minute = -FILM_WINDOW_MINUTES; minute <= FILM_WINDOW_MINUTES; minute += STEP_MINUTES) {
      timeline.push(new Date(anchor.getTime() + minute * 60 * 1000));
    }

    return timeline;
  }

  function cacheKey(layer, timeIso, state) {
    return `${layer}|${timeIso}|${state.width}x${state.height}|${state.bbox}`;
  }

  function preloadFrame(layer, frameTime, state) {
    const timeIso = formatIsoTime(frameTime);
    const key = cacheKey(layer, timeIso, state);
    if (frameCache.has(key)) {
      return frameCache.get(key);
    }

    const url = buildRadarUrl({
      layer,
      time: timeIso,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      cacheBuster: frameTime.getTime()
    });

    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = function () {
        resolve({ url, frameTime });
      };
      img.onerror = function () {
        reject(new Error(`Frame failed for ${timeIso}`));
      };
      img.src = url;
    });

    frameCache.set(key, promise);
    return promise;
  }

  async function buildFilmFramesParallel(runId, onUpdate) {
    const timeline = createFilmTimeline();
    const state = getMapState();
    const frameByIndex = new Array(timeline.length);
    let nextIndex = 0;
    let loadedCount = 0;

    const publish = function () {
      if (runId !== currentFilmRunId) {
        return;
      }

      const frames = frameByIndex.filter(Boolean);
      onUpdate({
        frames,
        loadedCount,
        totalCount: timeline.length
      });
    };

    async function worker() {
      while (nextIndex < timeline.length) {
        const index = nextIndex;
        nextIndex += 1;

        if (runId !== currentFilmRunId) {
          return;
        }

        try {
          const frame = await preloadFrame(FILM_LAYER, timeline[index], state);
          frameByIndex[index] = frame;
          loadedCount += 1;
          publish();
        } catch (_error) {
          // Einzelne fehlende Frames ignorieren.
        }
      }
    }

    const workers = [];
    const workerCount = Math.min(FILM_PARALLEL_REQUESTS, timeline.length);
    for (let i = 0; i < workerCount; i += 1) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return frameByIndex.filter(Boolean);
  }

  function stopFilmPlayback(options) {
    const resetToNow = options && options.resetToNow;
    currentFilmRunId += 1;
    isFilmPlaying = false;
    filmBtn.textContent = "Film -60/+60 min";
    filmBtn.disabled = false;

    if (filmTimerId) {
      window.clearInterval(filmTimerId);
      filmTimerId = undefined;
    }

    if (resetToNow) {
      loadCurrentRadar();
    }

    if (!autoRefreshTimerId) {
      autoRefreshTimerId = window.setInterval(loadCurrentRadar, AUTO_REFRESH_MS);
    }
  }

  function playFrames(frames) {
    let index = 0;

    const renderFrame = function () {
      if (!frames.length) {
        return;
      }

      if (index >= frames.length) {
        index = 0;
      }

      const frame = frames[index];
      radarImage.src = frame.url;
      updateFilmTimestamp(frame.frameTime);
      setFilmStatus(`${index + 1}/${frames.length}`);
      index = (index + 1) % frames.length;
    };

    renderFrame();
    filmTimerId = window.setInterval(renderFrame, FILM_FRAME_DELAY_MS);
  }

  async function toggleFilm() {
    if (!map) {
      return;
    }

    if (isFilmPlaying) {
      stopFilmPlayback({ resetToNow: true });
      return;
    }

    isFilmPlaying = true;
    currentFilmRunId += 1;
    const runId = currentFilmRunId;

    filmBtn.textContent = "Film stoppen";
    filmBtn.disabled = true;
    loadingState.classList.remove("hidden");
    loadingState.textContent = "Lade Filmframes...";
    setFilmStatus("lade");

    if (autoRefreshTimerId) {
      window.clearInterval(autoRefreshTimerId);
      autoRefreshTimerId = undefined;
    }

    const liveFrames = [];
    let started = false;
    const frames = await buildFilmFramesParallel(runId, function (update) {
      if (runId !== currentFilmRunId) {
        return;
      }

      liveFrames.length = 0;
      liveFrames.push.apply(liveFrames, update.frames);
      setFilmStatus(`lade ${update.loadedCount}/${update.totalCount}`);

      if (!started && liveFrames.length >= FILM_START_THRESHOLD) {
        started = true;
        loadingState.classList.add("hidden");
        playFrames(liveFrames);
      }
    });

    if (runId !== currentFilmRunId) {
      return;
    }

    filmBtn.disabled = false;

    if (frames.length < 3) {
      loadingState.classList.remove("hidden");
      loadingState.textContent = "Film derzeit nicht verfuegbar";
      stopFilmPlayback({ resetToNow: false });
      return;
    }

    if (!started) {
      loadingState.classList.add("hidden");
      playFrames(frames);
    }
  }

  function debounce(fn, delayMs) {
    let timeoutId;
    return function () {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(fn, delayMs);
    };
  }

  refreshBtn.addEventListener("click", function () {
    stopFilmPlayback({ resetToNow: false });
    loadCurrentRadar();
    if (!autoRefreshTimerId) {
      autoRefreshTimerId = window.setInterval(loadCurrentRadar, AUTO_REFRESH_MS);
    }
  });

  filmBtn.addEventListener("click", toggleFilm);

  initMap();
  loadCurrentRadar();
  autoRefreshTimerId = window.setInterval(loadCurrentRadar, AUTO_REFRESH_MS);

  window.addEventListener(
    "resize",
    debounce(function () {
      if (!map) {
        return;
      }

      map.invalidateSize(false);
      frameCache.clear();
      if (!isFilmPlaying) {
        loadCurrentRadar();
      }
    }, 250)
  );

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {
      // Kein Blocking: App soll auch ohne SW laufen.
    });
  }
})();
