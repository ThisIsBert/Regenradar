(function () {
  const MODE_RADAR = "radar";
  const MODE_CLOUD = "cloud";

  const WMS_BASE_URL = "https://maps.dwd.de/geoserver/wms";
  const NOW_LAYER = "dwd:Niederschlagsradar";
  const FILM_LAYER = "dwd:Radar_rv_product_1x1km_ger";
  const CLOUD_API_URL = "https://api.open-meteo.com/v1/forecast";
  const CLOUD_GRID_COLS = 8;
  const CLOUD_GRID_ROWS = 8;
  const CLOUD_RENDER_COLS = 34;
  const CLOUD_RENDER_ROWS = 42;
  const CLOUD_SOURCE_PAD_LAT = 0.45;
  const CLOUD_SOURCE_PAD_LON = 0.65;
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
  const CLOUD_START_THRESHOLD = 6;
  const CLOUD_YIELD_EVERY = 4;
  const CLOUD_CACHE_TTL_MS = 20 * 60 * 1000;
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
  const modeCloudBtn = document.getElementById("modeCloudBtn");

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
  let cloudSeriesPromise = null;
  let cloudSeriesFetchedAt = 0;

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

  function buildCloudGridPoints() {
    const minLat = FIXED_BOUNDS[0][0] - CLOUD_SOURCE_PAD_LAT;
    const maxLat = FIXED_BOUNDS[1][0] + CLOUD_SOURCE_PAD_LAT;
    const minLon = FIXED_BOUNDS[0][1] - CLOUD_SOURCE_PAD_LON;
    const maxLon = FIXED_BOUNDS[1][1] + CLOUD_SOURCE_PAD_LON;
    const points = [];

    for (let row = 0; row < CLOUD_GRID_ROWS; row += 1) {
      for (let col = 0; col < CLOUD_GRID_COLS; col += 1) {
        const x = CLOUD_GRID_COLS === 1 ? 0.5 : col / (CLOUD_GRID_COLS - 1);
        const y = CLOUD_GRID_ROWS === 1 ? 0.5 : row / (CLOUD_GRID_ROWS - 1);
        points.push({
          lat: minLat + (maxLat - minLat) * y,
          lon: minLon + (maxLon - minLon) * x,
          x,
          y
        });
      }
    }

    return points;
  }

  const CLOUD_GRID_POINTS = buildCloudGridPoints();

  function buildCloudApiUrl(points) {
    const params = new URLSearchParams({
      latitude: points.map((point) => point.lat.toFixed(4)).join(","),
      longitude: points.map((point) => point.lon.toFixed(4)).join(","),
      hourly: "cloud_cover",
      models: "ecmwf_ifs025",
      timezone: "UTC",
      past_days: "1",
      forecast_days: "2"
    });

    return `${CLOUD_API_URL}?${params.toString()}`;
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

  function setModeButtons() {
    const radarActive = currentMode === MODE_RADAR;
    modeRadarBtn.classList.toggle("active", radarActive);
    modeCloudBtn.classList.toggle("active", !radarActive);
    modeRadarBtn.setAttribute("aria-pressed", String(radarActive));
    modeCloudBtn.setAttribute("aria-pressed", String(!radarActive));
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

  function normalizeCloudSeriesForPoint(pointData) {
    if (!pointData || !pointData.hourly || !Array.isArray(pointData.hourly.time)) {
      return [];
    }

    const times = pointData.hourly.time;
    const values = Array.isArray(pointData.hourly.cloud_cover) ? pointData.hourly.cloud_cover : [];

    return times
      .map((timeIso, index) => {
        const isoUtc = /Z$|[+-]\d{2}:\d{2}$/.test(timeIso) ? timeIso : `${timeIso}Z`;
        const timeMs = Date.parse(isoUtc);
        if (!Number.isFinite(timeMs)) {
          return null;
        }

        return {
          timeMs,
          value: Number(values[index] ?? 0)
        };
      })
      .filter(Boolean);
  }

  function normalizeCloudGridResponse(data, gridPoints) {
    const pointsData = Array.isArray(data) ? data : [data];

    return gridPoints.map((gridPoint) => {
      let best = null;
      let bestDist = Infinity;

      for (let i = 0; i < pointsData.length; i += 1) {
        const candidate = pointsData[i];
        const lat = Number(candidate && candidate.latitude);
        const lon = Number(candidate && candidate.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          continue;
        }

        const dLat = lat - gridPoint.lat;
        const dLon = lon - gridPoint.lon;
        const dist = dLat * dLat + dLon * dLon;
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }

      return {
        x: gridPoint.x,
        y: gridPoint.y,
        series: normalizeCloudSeriesForPoint(best)
      };
    });
  }

  async function getCloudGridData() {
    const now = Date.now();
    if (cloudSeriesPromise && now - cloudSeriesFetchedAt < CLOUD_CACHE_TTL_MS) {
      return cloudSeriesPromise;
    }

    cloudSeriesFetchedAt = now;
    cloudSeriesPromise = fetch(buildCloudApiUrl(CLOUD_GRID_POINTS), { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Cloud source unavailable");
        }
        return response.json();
      })
      .then((data) => normalizeCloudGridResponse(data, CLOUD_GRID_POINTS))
      .catch((error) => {
        cloudSeriesPromise = null;
        throw error;
      });

    return cloudSeriesPromise;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function interpolateCloudValue(a, b, ratio) {
    return a.value + (b.value - a.value) * ratio;
  }

  function cloudValueAtTime(targetTime, series) {
    if (!series.length) {
      return 0;
    }

    const targetMs = targetTime.getTime();
    if (targetMs <= series[0].timeMs) {
      return series[0].value;
    }

    const last = series[series.length - 1];
    if (targetMs >= last.timeMs) {
      return last.value;
    }

    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1];
      const next = series[i];
      if (targetMs <= next.timeMs) {
        const ratio = (targetMs - prev.timeMs) / (next.timeMs - prev.timeMs);
        return interpolateCloudValue(prev, next, ratio);
      }
    }

    return last.value;
  }

  function buildCloudFieldAtTime(targetTime, gridData) {
    return gridData.map((point) => ({
      x: point.x,
      y: point.y,
      value: clampPercent(cloudValueAtTime(targetTime, point.series))
    }));
  }

  function sampleCloudField(normalizedX, normalizedY, fieldPoints) {
    let weighted = 0;
    let weightSum = 0;

    for (let i = 0; i < fieldPoints.length; i += 1) {
      const point = fieldPoints[i];
      const dx = normalizedX - point.x;
      const dy = normalizedY - point.y;
      const distSq = dx * dx + dy * dy;
      const weight = 1 / (distSq + 0.0035);
      weighted += point.value * weight;
      weightSum += weight;
    }

    if (!weightSum) {
      return 0;
    }

    return clampPercent(weighted / weightSum);
  }

  function structuredNoise(normalizedX, normalizedY, timeBucket) {
    const a = Math.sin((normalizedX * 17.3 + timeBucket * 0.11) * Math.PI * 2);
    const b = Math.sin((normalizedY * 13.7 - timeBucket * 0.09) * Math.PI * 2);
    const c = Math.sin(((normalizedX + normalizedY) * 11.1 + timeBucket * 0.05) * Math.PI * 2);
    return (a + b + c) / 6 + 0.5;
  }

  function buildCloudDataUrl(fieldPoints, width, height, frameTimeMs) {
    const sampleCols = CLOUD_RENDER_COLS;
    const sampleRows = CLOUD_RENDER_ROWS;
    const detailCanvas = document.createElement("canvas");
    detailCanvas.width = sampleCols;
    detailCanvas.height = sampleRows;
    const detailCtx = detailCanvas.getContext("2d");
    if (!detailCtx) {
      return "";
    }

    const imageData = detailCtx.createImageData(sampleCols, sampleRows);
    const pixels = imageData.data;
    const timeBucket = Math.round(frameTimeMs / STEP_MS);

    for (let row = 0; row < sampleRows; row += 1) {
      for (let col = 0; col < sampleCols; col += 1) {
        const nx = sampleCols === 1 ? 0.5 : col / (sampleCols - 1);
        const ny = sampleRows === 1 ? 0.5 : row / (sampleRows - 1);
        const base = sampleCloudField(nx, ny, fieldPoints);

        // Light neighborhood smoothing avoids checkerboard artifacts.
        const xOffset = 1 / Math.max(2, sampleCols - 1);
        const yOffset = 1 / Math.max(2, sampleRows - 1);
        const smoothed =
          base * 0.5 +
          sampleCloudField(Math.max(0, nx - xOffset), ny, fieldPoints) * 0.125 +
          sampleCloudField(Math.min(1, nx + xOffset), ny, fieldPoints) * 0.125 +
          sampleCloudField(nx, Math.max(0, ny - yOffset), fieldPoints) * 0.125 +
          sampleCloudField(nx, Math.min(1, ny + yOffset), fieldPoints) * 0.125;

        const noise = structuredNoise(nx, ny, timeBucket);
        const contrasted = clampPercent((smoothed - 14) * 1.9 + (noise - 0.5) * 12);

        const alpha = Math.max(0, Math.min(255, Math.round((0.06 + (contrasted / 100) * 0.72) * 255)));
        const gray = Math.max(92, Math.min(245, Math.round(245 - (contrasted / 100) * 128)));
        const pixelIndex = (row * sampleCols + col) * 4;
        pixels[pixelIndex] = gray;
        pixels[pixelIndex + 1] = gray;
        pixels[pixelIndex + 2] = gray;
        pixels[pixelIndex + 3] = alpha;
      }
    }

    detailCtx.putImageData(imageData, 0, 0);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.max(1, Math.round(width));
    outCanvas.height = Math.max(1, Math.round(height));
    const outCtx = outCanvas.getContext("2d");
    if (!outCtx) {
      return "";
    }

    outCtx.clearRect(0, 0, outCanvas.width, outCanvas.height);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(detailCanvas, 0, 0, outCanvas.width, outCanvas.height);

    return outCanvas.toDataURL("image/png");
  }

  async function preloadCloudFrame(frameTime, state) {
    const timeIso = formatIsoTime(frameTime);
    const key = cacheKey("cloud", timeIso, state);
    if (frameCache.has(key)) {
      return frameCache.get(key);
    }

    const gridData = await getCloudGridData();
    const fieldPoints = buildCloudFieldAtTime(frameTime, gridData);
    const url = buildCloudDataUrl(fieldPoints, state.width, state.height, frameTime.getTime());

    return preloadImageFrame(key, url, frameTime);
  }

  async function buildRadarFilmFramesParallel(runId, anchorTime, onUpdate) {
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
          const frame = await preloadRadarFrame(FILM_LAYER, timeline[index], state);
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

  async function buildCloudFramesProgressive(runId, anchorTime, onUpdate) {
    const timeline = createFilmTimeline(anchorTime);
    const state = getMapState();
    const frameByIndex = new Array(timeline.length);
    let loadedCount = 0;

    for (let index = 0; index < timeline.length; index += 1) {
      if (runId !== currentFilmRunId) {
        return frameByIndex.filter(Boolean);
      }

      try {
        const frame = await preloadCloudFrame(timeline[index], state);
        frameByIndex[index] = frame;
        loadedCount += 1;
      } catch (_error) {
        // Einzelne fehlende Frames ignorieren.
      }

      onUpdate({
        frames: frameByIndex.filter(Boolean),
        loadedCount,
        totalCount: timeline.length
      });

      if (index % CLOUD_YIELD_EVERY === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

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

  async function loadCurrentRadar() {
    if (!map || isFilmPlaying || isScrubbing || currentMode !== MODE_RADAR) {
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

  async function loadCurrentCloud() {
    if (!map || isFilmPlaying || isScrubbing || currentMode !== MODE_CLOUD) {
      return;
    }

    loadingState.classList.remove("hidden");

    const slot = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);
    const state = getMapState();

    try {
      const frame = await preloadCloudFrame(slot, state);
      if (currentMode !== MODE_CLOUD) {
        return;
      }

      showFrame(frame, 0, slot);
      loadingState.classList.add("hidden");
      currentAnchorTime = slot;
      updateTimelineLabels(slot);
      updateTimelineMarkerByTime(slot, slot);
      currentFrames = [];
      setFilmIdleButton();
    } catch (_error) {
      loadingState.classList.remove("hidden");
    }
  }

  function loadCurrentView() {
    if (currentMode === MODE_CLOUD) {
      loadCurrentCloud();
      return;
    }

    loadCurrentRadar();
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

    const startThreshold = modeAtStart === MODE_CLOUD ? CLOUD_START_THRESHOLD : FILM_START_THRESHOLD;
    const frameBuilder = modeAtStart === MODE_CLOUD ? buildCloudFramesProgressive : buildRadarFilmFramesParallel;

    const frames = await frameBuilder(runId, anchorTime, function (update) {
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

  modeCloudBtn.addEventListener("click", function () {
    switchMode(MODE_CLOUD);
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
