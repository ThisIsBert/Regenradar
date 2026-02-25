(function () {
  const MODE_RADAR = "radar";
  const MODE_RADOLAN = "radolan";

  const WMS_BASE_URL = "https://maps.dwd.de/geoserver/wms";
  const NOW_LAYER = "dwd:Niederschlagsradar";
  const FILM_LAYER = "dwd:Radar_rv_product_1x1km_ger";
  const RADOLAN_LAYER = "dwd:RADOLAN-RY";
  const FIXED_BOUNDS = [
    [49.17, 8.05],
    [49.63, 8.95]
  ];

  const STEP_MINUTES = 5;
  const STEP_MS = STEP_MINUTES * 60 * 1000;
  const FILM_WINDOW_MINUTES = 60;
  const FILM_FRAME_DELAY_MS = 350;
  const FILM_PARALLEL_REQUESTS = 5;
  const FILM_START_THRESHOLD = 8;
  const PULL_REFRESH_THRESHOLD = 90;

  const mapEl = document.getElementById("map");
  const radarImage = document.getElementById("radarImage");
  const filmBtn = document.getElementById("filmBtn");
  const loadingState = document.getElementById("loadingState");
  const timelineTrack = document.getElementById("timelineTrack");
  const timelineMarker = document.getElementById("timelineMarker");
  const timelineStart = document.getElementById("timelineStart");
  const timelineMid = document.getElementById("timelineMid");
  const timelineEnd = document.getElementById("timelineEnd");
  const modeRadarBtn = document.getElementById("modeRadarBtn");
  const modeRadolanBtn = document.getElementById("modeRadolanBtn");

  let map;
  let filmTimerId;
  let isFilmPlaying = false;
  let currentFilmRunId = 0;
  let touchStartY = 0;
  let pullTriggered = false;
  let isScrubbing = false;
  let currentMode = MODE_RADAR;

  let currentAnchorTime = null;
  let currentFrames = [];

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

  function updateTimelineLabels(anchorTime) {
    const start = new Date(anchorTime.getTime() - FILM_WINDOW_MINUTES * 60 * 1000);
    const end = new Date(anchorTime.getTime() + FILM_WINDOW_MINUTES * 60 * 1000);
    timelineStart.textContent = formatTime(start);
    timelineMid.textContent = formatTime(anchorTime);
    timelineEnd.textContent = formatTime(end);
  }

  function updateTimelineMarkerByTime(frameTime, anchorTime) {
    const frameMs = frameTime.getTime();
    const anchorMs = anchorTime.getTime();
    const minMs = anchorMs - FILM_WINDOW_MINUTES * 60 * 1000;
    const maxMs = anchorMs + FILM_WINDOW_MINUTES * 60 * 1000;
    const clamped = Math.max(minMs, Math.min(maxMs, frameMs));
    const ratio = (clamped - minMs) / (maxMs - minMs);
    timelineMarker.style.left = `${ratio * 100}%`;
  }

  function stopFilmTimer() {
    if (filmTimerId) {
      window.clearInterval(filmTimerId);
      filmTimerId = undefined;
    }
  }

  function showFrame(frame, _index, anchorTime) {
    if (!frame) {
      return;
    }

    radarImage.onload = null;
    radarImage.onerror = null;
    radarImage.src = frame.url;
    updateTimelineMarkerByTime(frame.frameTime, anchorTime);
  }

  function setFilmIdleButton() {
    filmBtn.disabled = false;
    filmBtn.textContent = "Film starten";
  }

  function getCurrentRadarLikeLayer(mode) {
    if (mode === MODE_RADOLAN) {
      return RADOLAN_LAYER;
    }
    return mode === MODE_RADAR ? NOW_LAYER : "";
  }

  function getCurrentFilmLayer(mode) {
    if (mode === MODE_RADOLAN) {
      return RADOLAN_LAYER;
    }
    return mode === MODE_RADAR ? FILM_LAYER : "";
  }

  function setModeButtons() {
    const radarActive = currentMode === MODE_RADAR;
    const radolanActive = currentMode === MODE_RADOLAN;
    modeRadarBtn.classList.toggle("active", radarActive);
    modeRadolanBtn.classList.toggle("active", radolanActive);
    modeRadarBtn.setAttribute("aria-pressed", String(radarActive));
    modeRadolanBtn.setAttribute("aria-pressed", String(radolanActive));
  }

  function createFilmTimeline(anchorTime) {
    const timeline = [];
    for (let minute = -FILM_WINDOW_MINUTES; minute <= FILM_WINDOW_MINUTES; minute += STEP_MINUTES) {
      timeline.push(new Date(anchorTime.getTime() + minute * 60 * 1000));
    }
    return timeline;
  }

  function cacheKey(kind, timeIso, state) {
    return `${kind}|${timeIso}|${state.width}x${state.height}|${state.bbox}`;
  }

  function preloadImageFrame(key, url, frameTime) {
    if (frameCache.has(key)) {
      return frameCache.get(key);
    }

    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = function () {
        resolve({ url, frameTime });
      };
      img.onerror = function () {
        reject(new Error(`Frame failed for ${key}`));
      };
      img.src = url;
    });

    frameCache.set(key, promise);
    return promise;
  }

  function preloadRadarFrame(layer, frameTime, state) {
    const timeIso = formatIsoTime(frameTime);
    const key = cacheKey(layer, timeIso, state);
    const url = buildRadarUrl({
      layer,
      time: timeIso,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      cacheBuster: frameTime.getTime()
    });

    return preloadImageFrame(key, url, frameTime);
  }

  async function buildRadarFilmFramesParallel(runId, anchorTime, layer, onUpdate) {
    const timeline = createFilmTimeline(anchorTime);
    const state = getMapState();
    const frameByIndex = new Array(timeline.length);
    let nextIndex = 0;
    let loadedCount = 0;

    const publish = function () {
      if (runId !== currentFilmRunId) {
        return;
      }
      onUpdate({
        frames: frameByIndex.filter(Boolean),
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
          const frame = await preloadRadarFrame(layer, timeline[index], state);
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

  function playFramesOnce(getFrames, anchorTime, isLoadingDone) {
    let index = 0;

    const tick = function () {
      const frames = getFrames();
      if (!frames.length) {
        return;
      }

      if (index >= frames.length) {
        index = frames.length - 1;
      }

      showFrame(frames[index], index, anchorTime);

      const nextIndex = index + 1;
      if (nextIndex < frames.length) {
        index = nextIndex;
        return;
      }

      if (isLoadingDone()) {
        stopFilmTimer();
        isFilmPlaying = false;
        setFilmIdleButton();
      }
    };

    tick();
    filmTimerId = window.setInterval(tick, FILM_FRAME_DELAY_MS);
  }

  function getRatioFromClientX(clientX) {
    const rect = timelineTrack.getBoundingClientRect();
    if (!rect.width) {
      return 0;
    }
    const raw = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, raw));
  }

  function seekByRatio(ratio) {
    if (!currentFrames.length || !currentAnchorTime) {
      return;
    }

    const index = Math.max(0, Math.min(currentFrames.length - 1, Math.round(ratio * (currentFrames.length - 1))));
    showFrame(currentFrames[index], index, currentAnchorTime);
  }

  async function loadCurrentRadarLike() {
    if (!map || isFilmPlaying || isScrubbing) {
      return;
    }

    const layer = getCurrentRadarLikeLayer(currentMode);
    if (!layer) {
      return;
    }

    loadingState.classList.remove("hidden");

    const slot = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);
    const state = getMapState();
    const url = buildRadarUrl({
      layer,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      cacheBuster: slot.getTime()
    });

    radarImage.onload = function () {
      loadingState.classList.add("hidden");
      currentAnchorTime = slot;
      updateTimelineLabels(slot);
      updateTimelineMarkerByTime(slot, slot);
      currentFrames = [];
      setFilmIdleButton();
    };

    radarImage.onerror = function () {
      loadingState.classList.remove("hidden");
    };

    radarImage.src = url;
  }

  function loadCurrentView() {
    loadCurrentRadarLike();
  }

  async function startFilm() {
    if (!map || isFilmPlaying) {
      return;
    }

    stopFilmTimer();
    currentFilmRunId += 1;
    const runId = currentFilmRunId;
    const modeAtStart = currentMode;
    const anchorTime = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);

    isFilmPlaying = true;
    filmBtn.disabled = true;
    filmBtn.textContent = "Film laden...";
    loadingState.classList.remove("hidden");

    currentAnchorTime = anchorTime;
    updateTimelineLabels(anchorTime);

    const liveFrames = [];
    let started = false;
    let loadingDone = false;

    const startThreshold = FILM_START_THRESHOLD;
    const radarLikeFilmLayer = getCurrentFilmLayer(modeAtStart);

    const frames = await buildRadarFilmFramesParallel(runId, anchorTime, radarLikeFilmLayer, function (update) {
      if (runId !== currentFilmRunId || modeAtStart !== currentMode) {
        return;
      }

      liveFrames.length = 0;
      liveFrames.push.apply(liveFrames, update.frames);
      filmBtn.textContent = `Film laden ${update.loadedCount}/${update.totalCount}`;

      if (!started && liveFrames.length >= startThreshold) {
        started = true;
        filmBtn.disabled = false;
        filmBtn.textContent = "Film laeuft";
        loadingState.classList.add("hidden");
        playFramesOnce(
          function () {
            return liveFrames;
          },
          anchorTime,
          function () {
            return loadingDone;
          }
        );
      }
    });

    if (runId !== currentFilmRunId || modeAtStart !== currentMode) {
      return;
    }

    loadingDone = true;
    currentFrames = frames;

    if (frames.length < 3) {
      loadingState.classList.remove("hidden");
      isFilmPlaying = false;
      setFilmIdleButton();
      return;
    }

    if (!started) {
      loadingState.classList.add("hidden");
      filmBtn.disabled = false;
      filmBtn.textContent = "Film laeuft";
      playFramesOnce(
        function () {
          return frames;
        },
        anchorTime,
        function () {
          return true;
        }
      );
      return;
    }

    currentFrames = liveFrames.slice();
    filmBtn.disabled = false;
  }

  function initTimelineScrub() {
    if (!timelineTrack) {
      return;
    }

    timelineTrack.addEventListener("pointerdown", function (event) {
      if (!currentFrames.length) {
        return;
      }

      isScrubbing = true;
      stopFilmTimer();
      isFilmPlaying = false;
      setFilmIdleButton();

      timelineTrack.setPointerCapture(event.pointerId);
      seekByRatio(getRatioFromClientX(event.clientX));
    });

    timelineTrack.addEventListener("pointermove", function (event) {
      if (!isScrubbing) {
        return;
      }
      seekByRatio(getRatioFromClientX(event.clientX));
    });

    timelineTrack.addEventListener("pointerup", function (event) {
      if (!isScrubbing) {
        return;
      }
      seekByRatio(getRatioFromClientX(event.clientX));
      isScrubbing = false;
    });

    timelineTrack.addEventListener("pointercancel", function () {
      isScrubbing = false;
    });
  }

  function debounce(fn, delayMs) {
    let timeoutId;
    return function () {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(fn, delayMs);
    };
  }

  function switchMode(mode) {
    if (mode === currentMode) {
      return;
    }

    currentMode = mode;
    stopFilmTimer();
    isFilmPlaying = false;
    currentFilmRunId += 1;
    currentFrames = [];
    setFilmIdleButton();
    setModeButtons();
    loadCurrentView();
  }

  modeRadarBtn.addEventListener("click", function () {
    switchMode(MODE_RADAR);
  });

  modeRadolanBtn.addEventListener("click", function () {
    switchMode(MODE_RADOLAN);
  });

  filmBtn.addEventListener("click", startFilm);

  mapEl.addEventListener(
    "touchstart",
    function (event) {
      if (event.touches.length !== 1 || isFilmPlaying || isScrubbing) {
        return;
      }
      touchStartY = event.touches[0].clientY;
      pullTriggered = false;
    },
    { passive: true }
  );

  mapEl.addEventListener(
    "touchmove",
    function (event) {
      if (isFilmPlaying || isScrubbing || pullTriggered || event.touches.length !== 1) {
        return;
      }

      const deltaY = event.touches[0].clientY - touchStartY;
      if (deltaY > PULL_REFRESH_THRESHOLD) {
        pullTriggered = true;
        loadCurrentView();
      }
    },
    { passive: true }
  );

  mapEl.addEventListener(
    "touchend",
    function () {
      pullTriggered = false;
    },
    { passive: true }
  );

  initMap();
  initTimelineScrub();
  setModeButtons();
  loadCurrentView();

  window.addEventListener(
    "resize",
    debounce(function () {
      if (!map) {
        return;
      }

      map.invalidateSize(false);
      frameCache.clear();
      if (!isFilmPlaying && !isScrubbing) {
        loadCurrentView();
      }
    }, 250)
  );

  if ("serviceWorker" in navigator) {
    let reloading = false;

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloading) {
        return;
      }

      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("./sw.js")
      .then(function (registration) {
        registration.update();

        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        registration.addEventListener("updatefound", function () {
          const newWorker = registration.installing;
          if (!newWorker) {
            return;
          }

          newWorker.addEventListener("statechange", function () {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              newWorker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch(function () {
        // Kein Blocking: App soll auch ohne SW laufen.
      });
  }
})();
