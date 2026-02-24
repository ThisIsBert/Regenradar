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

  let map;
  let filmTimerId;
  let isFilmPlaying = false;
  let currentFilmRunId = 0;
  let touchStartY = 0;
  let pullTriggered = false;
  let isScrubbing = false;

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

  function showFrame(frame, index, anchorTime) {
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

  function loadCurrentRadar() {
    if (!map || isFilmPlaying || isScrubbing) {
      return;
    }

    loadingState.classList.remove("hidden");

    const slot = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);
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

  function createFilmTimeline(anchorTime) {
    const timeline = [];
    for (let minute = -FILM_WINDOW_MINUTES; minute <= FILM_WINDOW_MINUTES; minute += STEP_MINUTES) {
      timeline.push(new Date(anchorTime.getTime() + minute * 60 * 1000));
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

  async function buildFilmFramesParallel(runId, anchorTime, onUpdate) {
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

  async function startFilm() {
    if (!map || isFilmPlaying) {
      return;
    }

    stopFilmTimer();
    currentFilmRunId += 1;
    const runId = currentFilmRunId;
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

    const frames = await buildFilmFramesParallel(runId, anchorTime, function (update) {
      if (runId !== currentFilmRunId) {
        return;
      }

      liveFrames.length = 0;
      liveFrames.push.apply(liveFrames, update.frames);
      filmBtn.textContent = `Film laden ${update.loadedCount}/${update.totalCount}`;

      if (!started && liveFrames.length >= FILM_START_THRESHOLD) {
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

    if (runId !== currentFilmRunId) {
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
        loadCurrentRadar();
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
  loadCurrentRadar();

  window.addEventListener(
    "resize",
    debounce(function () {
      if (!map) {
        return;
      }

      map.invalidateSize(false);
      frameCache.clear();
      if (!isFilmPlaying && !isScrubbing) {
        loadCurrentRadar();
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
