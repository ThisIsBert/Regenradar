(function () {
  const WMS_BASE_URL = "https://maps.dwd.de/geoserver/wms";
  const BRIGHT_SKY_WEATHER_URL = "https://api.brightsky.dev/weather";
  const NOW_LAYER = "dwd:Niederschlagsradar";
  const FILM_LAYER = "dwd:Radar_rv_product_1x1km_ger";
  const HEIDELBERG_CENTER = [49.39875, 8.67243];
  const INITIAL_BOUNDS = [
    [49.16875, 8.22243],
    [49.62875, 9.12243]
  ];
  const MAX_ZOOM_STEPS = 3;

  const STEP_MINUTES = 5;
  const STEP_MS = STEP_MINUTES * 60 * 1000;
  const FILM_WINDOW_MINUTES = 60;
  const FILM_PARALLEL_REQUESTS = 5;
  const PULL_REFRESH_THRESHOLD = 90;
  const RADAR_PADDING_FACTOR = 0.08;
  const FORECAST_SLOT_COUNT = 7;
  const FORECAST_STEP_HOURS = 2;
  const FORECAST_TTL_MS = 15 * 60 * 1000;
  const FORECAST_PREVIEW_PARAM = new URLSearchParams(window.location.search).get("forecastPreview");
  const WEATHER_ICON_PATHS = {
    clearDay: "./icons/weather/klar_tag.svg",
    clearNight: "./icons/weather/klar_nacht.svg",
    partlyCloudyDay: "./icons/weather/teils_bewoelkt_tag.svg",
    partlyCloudyNight: "./icons/weather/teils_bewoelkt_nacht.svg",
    cloudy: "./icons/weather/bewoelkt.svg",
    rain: "./icons/weather/regen.svg",
    thunderstorm: "./icons/weather/gewitter.svg",
    fog: "./icons/weather/nebel.svg"
  };

  const mapEl = document.getElementById("map");
  const loadingState = document.getElementById("loadingState");
  const timelineTrack = document.getElementById("timelineTrack");
  const timelineMarker = document.getElementById("timelineMarker");
  const timelineStart = document.getElementById("timelineStart");
  const timelineMid = document.getElementById("timelineMid");
  const timelineEnd = document.getElementById("timelineEnd");
  const forecastStatus = document.getElementById("forecastStatus");
  const forecastSlots = document.getElementById("forecastSlots");

  let map;
  let radarOverlayLayer;
  let radarBaseBounds;
  let currentFilmRunId = 0;
  let touchStartY = 0;
  let pullTriggered = false;
  let isScrubbing = false;
  let pendingSeekRatio = null;
  let seekRafId = 0;

  let currentAnchorTime = null;
  let currentFrames = [];
  let currentForecastRunId = 0;
  let forecastCache = null;

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

  function formatDateParam(date) {
    return date.toISOString().slice(0, 10);
  }

  function formatForecastTime(date) {
    return date.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function roundTemperature(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return "--";
    }
    return Math.round(value);
  }

  function formatProbability(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return null;
    }
    return `${Math.round(value)} % Regen`;
  }

  function formatPrecipitation(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return null;
    }
    return `${value.toFixed(1)} mm/h`;
  }

  function getForecastDetailLine(entry) {
    const probabilityLine = formatProbability(entry.precipitationProbability);
    if (probabilityLine) {
      return probabilityLine;
    }

    if (entry.precipitation === 0) {
      return "0 % Regen";
    }

    return formatPrecipitation(entry.precipitation) || "Keine Details";
  }

  function describeCloudCover(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return "Wolken unklar";
    }
    if (value < 15) {
      return "Fast klar";
    }
      if (value < 40) {
      return "Leicht bewölkt";
      }
    if (value < 70) {
      return "Wolkig";
    }
      if (value < 90) {
      return "Stark bewölkt";
      }
      return "Bedeckt";
    }

  function isNightTime(date) {
    const hour = date.getHours();
    return hour >= 20 || hour < 6;
  }

  function getForecastCardTone(date) {
    return isNightTime(date) ? "night" : "day";
  }

  function getForecastCardPalette(tone, cloudCover) {
    const cover = typeof cloudCover === "number" && !Number.isNaN(cloudCover) ? Math.max(0, Math.min(100, cloudCover)) : 50;
    const ratio = cover / 100;

    if (tone === "night") {
      const startLightness = 6 + ratio * 16;
      const endLightness = 11 + ratio * 18;
      const saturation = 18 - ratio * 16;
      return {
        top: `hsl(220 ${Math.max(2, saturation)}% ${startLightness}%)`,
        bottom: `hsl(220 ${Math.max(1, saturation - 3)}% ${endLightness}%)`
      };
    }

    const startSaturation = 92 - ratio * 78;
    const endSaturation = 82 - ratio * 70;
    const startLightness = 74 - ratio * 14;
    const endLightness = 58 - ratio * 12;
    return {
      top: `hsl(200 ${startSaturation}% ${startLightness}%)`,
      bottom: `hsl(205 ${endSaturation}% ${endLightness}%)`
    };
  }

  function getForecastIconPresentation(entry) {
    const icon = String(entry.icon || "");
    const condition = String(entry.condition || "");
    const isNight = isNightTime(entry.timestamp);

    if (icon.includes("thunderstorm") || condition.includes("thunder")) {
      return { src: WEATHER_ICON_PATHS.thunderstorm, alt: "Gewitter" };
    }
    if (icon.includes("snow") || condition.includes("snow") || icon.includes("sleet")) {
      return { src: WEATHER_ICON_PATHS.thunderstorm, alt: "Schauer" };
    }
    if (icon.includes("rain") || condition.includes("rain")) {
      return { src: WEATHER_ICON_PATHS.rain, alt: "Regen" };
    }
    if (icon.includes("fog") || condition.includes("fog")) {
      return { src: WEATHER_ICON_PATHS.fog, alt: "Nebel" };
    }
    if (icon.includes("partly-cloudy") || condition.includes("partly-cloudy")) {
      return {
        src: isNight ? WEATHER_ICON_PATHS.partlyCloudyNight : WEATHER_ICON_PATHS.partlyCloudyDay,
        alt: "Teilweise bewölkt"
      };
    }
    if (icon.includes("cloud") || icon.includes("overcast") || condition.includes("cloud")) {
      return { src: WEATHER_ICON_PATHS.cloudy, alt: "Bewölkt" };
    }
    return {
      src: isNight ? WEATHER_ICON_PATHS.clearNight : WEATHER_ICON_PATHS.clearDay,
      alt: isNight ? "Klarer Nachthimmel" : "Sonnig"
    };
  }

  function setForecastStatus(message, hidden) {
    forecastStatus.textContent = message;
    forecastStatus.classList.toggle("hidden", Boolean(hidden));
  }

  function clearForecastSlots() {
    forecastSlots.innerHTML = "";
  }

  function buildForecastUrl(date) {
    const params = new URLSearchParams({
      lat: String(HEIDELBERG_CENTER[0]),
      lon: String(HEIDELBERG_CENTER[1]),
      date: formatDateParam(date),
      tz: "Europe/Berlin"
    });
    return `${BRIGHT_SKY_WEATHER_URL}?${params.toString()}`;
  }

  async function fetchForecastDay(date) {
    const response = await fetch(buildForecastUrl(date));
    if (!response.ok) {
      throw new Error("Vorhersage konnte nicht geladen werden.");
    }
    const payload = await response.json();
    return Array.isArray(payload.weather) ? payload.weather : [];
  }

  function normalizeForecastEntries(entries) {
    return entries
      .map(function (entry) {
        return {
          timestamp: new Date(entry.timestamp),
          temperature: typeof entry.temperature === "number" ? entry.temperature : null,
          cloudCover: typeof entry.cloud_cover === "number" ? entry.cloud_cover : null,
          precipitation: typeof entry.precipitation === "number" ? entry.precipitation : null,
          precipitationProbability:
            typeof entry.precipitation_probability === "number" ? entry.precipitation_probability : null,
          icon: entry.icon || "",
          condition: entry.condition || ""
        };
      })
      .filter(function (entry) {
        return !Number.isNaN(entry.timestamp.getTime());
      })
      .sort(function (a, b) {
        return a.timestamp.getTime() - b.timestamp.getTime();
      });
  }

  function parsePreviewCloudCoverValues() {
    if (!FORECAST_PREVIEW_PARAM) {
      return null;
    }

    if (FORECAST_PREVIEW_PARAM === "demo") {
      return [0, 18, 36, 54, 72, 88, 100];
    }

    const values = FORECAST_PREVIEW_PARAM
      .split(",")
      .map(function (value) {
        return Number.parseInt(value.trim(), 10);
      })
      .filter(function (value) {
        return Number.isFinite(value);
      })
      .map(function (value) {
        return Math.max(0, Math.min(100, value));
      });

    return values.length ? values : null;
  }

  function buildPreviewForecastEntries(now) {
    const cloudCovers = parsePreviewCloudCoverValues();
    if (!cloudCovers) {
      return null;
    }

    const startTime = new Date(now);
    startTime.setMinutes(0, 0, 0);

    return cloudCovers.slice(0, FORECAST_SLOT_COUNT).map(function (cloudCover, index) {
      const timestamp = new Date(startTime.getTime() + index * FORECAST_STEP_HOURS * 60 * 60 * 1000);
      return {
        timestamp,
        temperature: 12 + index,
        cloudCover,
        precipitation: cloudCover > 70 ? 0.6 : 0,
        precipitationProbability: cloudCover > 50 ? Math.round(cloudCover * 0.7) : 0,
        icon: cloudCover > 75 ? "cloudy" : cloudCover > 45 ? "partly-cloudy-day" : "clear-day",
        condition: cloudCover > 75 ? "cloudy" : cloudCover > 45 ? "partly-cloudy" : "clear"
      };
    });
  }

  function selectForecastEntries(entries, now) {
    const startTime = new Date(now);
    startTime.setMinutes(0, 0, 0);

    const futureEntries = entries.filter(function (entry) {
      return entry.timestamp.getTime() >= startTime.getTime();
    });

    if (!futureEntries.length) {
      return [];
    }

    const selected = [futureEntries[0]];
    let lastIncluded = futureEntries[0].timestamp.getTime();

    for (let i = 1; i < futureEntries.length && selected.length < FORECAST_SLOT_COUNT; i += 1) {
      const candidate = futureEntries[i];
      const diffHours = (candidate.timestamp.getTime() - lastIncluded) / (60 * 60 * 1000);
      if (diffHours >= FORECAST_STEP_HOURS - 0.01) {
        selected.push(candidate);
        lastIncluded = candidate.timestamp.getTime();
      }
    }

    return selected;
  }

  function renderForecast(entries) {
    clearForecastSlots();

    entries.forEach(function (entry, index) {
      const slotEl = document.createElement("article");
      const icon = getForecastIconPresentation(entry);
      const detailLine = getForecastDetailLine(entry);
      const cloudCover = typeof entry.cloudCover === "number" ? Math.max(0, Math.min(100, entry.cloudCover)) : null;
      const cloudLabel = describeCloudCover(cloudCover);
      const cardTone = getForecastCardTone(entry.timestamp);
      const palette = getForecastCardPalette(cardTone, cloudCover);
      const skyAriaLabel =
        cloudCover === null ? "Wolkenlage unbekannt" : `${cloudLabel}, ${Math.round(cloudCover)} Prozent Wolken`;
      slotEl.className = `forecast-slot forecast-slot-${cardTone}${index === 0 ? " current" : ""}`;
      slotEl.setAttribute("aria-label", `${index === 0 ? "Jetzt" : formatForecastTime(entry.timestamp)}: ${skyAriaLabel}`);
      slotEl.style.setProperty("--forecast-bg-top", palette.top);
      slotEl.style.setProperty("--forecast-bg-bottom", palette.bottom);

      slotEl.innerHTML = `
        <p class="forecast-time">${index === 0 ? "Jetzt" : formatForecastTime(entry.timestamp)}</p>
        <div class="forecast-icon">
          <img class="forecast-icon-image" src="${icon.src}" alt="${icon.alt}">
        </div>
        <p class="forecast-temp">${roundTemperature(entry.temperature)}&thinsp;&deg;</p>
        <p class="forecast-cloud-label">${cloudLabel}</p>
        <p class="forecast-detail">${detailLine}</p>
      `;

      forecastSlots.appendChild(slotEl);
    });
  }

  async function loadForecast(forceReload) {
    const now = new Date();
    const previewEntries = buildPreviewForecastEntries(now);

    if (previewEntries) {
      renderForecast(previewEntries);
      setForecastStatus("", true);
      return;
    }

    if (
      !forceReload &&
      forecastCache &&
      now.getTime() - forecastCache.loadedAt < FORECAST_TTL_MS
    ) {
      renderForecast(forecastCache.entries);
      setForecastStatus("", true);
      return;
    }

    currentForecastRunId += 1;
    const runId = currentForecastRunId;
    setForecastStatus("Lade Prognose ...", false);

    try {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const results = await Promise.all([fetchForecastDay(now), fetchForecastDay(tomorrow)]);

      if (runId !== currentForecastRunId) {
        return;
      }

      const merged = normalizeForecastEntries(results[0].concat(results[1]));
      const selected = selectForecastEntries(merged, now);

      if (!selected.length) {
        clearForecastSlots();
        setForecastStatus("Keine Prognose verfuegbar.", false);
        return;
      }

      forecastCache = {
        entries: selected,
        loadedAt: now.getTime(),
        updatedAt: selected[0].timestamp
      };

      renderForecast(selected);
      setForecastStatus("", true);
    } catch (_error) {
      if (runId !== currentForecastRunId) {
        return;
      }
      clearForecastSlots();
      setForecastStatus("Prognose gerade nicht verfuegbar.", false);
    }
  }

  function getRadarRequestState() {
    const requestBounds = radarBaseBounds || L.latLngBounds(INITIAL_BOUNDS);
    const sw = map.options.crs.project(requestBounds.getSouthWest());
    const ne = map.options.crs.project(requestBounds.getNorthEast());
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
      zoomControl: true,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      tap: true,
      touchZoom: true,
      fadeAnimation: false,
      maxBoundsViscosity: 1.0
    });

    const initialBounds = L.latLngBounds(INITIAL_BOUNDS);
    map.fitBounds(initialBounds, { animate: false, padding: [0, 0] });
    map.setView(HEIDELBERG_CENTER, map.getZoom(), { animate: false });
    const startZoom = map.getZoom();
    const startViewBounds = map.getBounds();
    radarBaseBounds = startViewBounds.pad(RADAR_PADDING_FACTOR);
    map.setMinZoom(startZoom);
    map.setMaxZoom(startZoom + MAX_ZOOM_STEPS);
    map.setMaxBounds(startViewBounds);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      subdomains: "abcd",
      minZoom: startZoom,
      maxZoom: startZoom + MAX_ZOOM_STEPS
    }).addTo(map);

    L.circleMarker(HEIDELBERG_CENTER, {
      radius: 4,
      color: "#ffffff",
      weight: 1.5,
      fillColor: "#e33a3a",
      fillOpacity: 1,
      interactive: false
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

  function showFrame(frame, _index, anchorTime) {
    if (!frame) {
      return;
    }

    const overlayBounds = radarBaseBounds || INITIAL_BOUNDS;
    if (!radarOverlayLayer) {
      radarOverlayLayer = L.imageOverlay(frame.url, overlayBounds, {
        opacity: 0.88,
        interactive: false
      }).addTo(map);
    } else {
      const overlayEl = radarOverlayLayer.getElement();
      if (overlayEl) {
        overlayEl.src = frame.url;
      } else {
        radarOverlayLayer.setUrl(frame.url);
      }
      radarOverlayLayer.setBounds(overlayBounds);
      if (!map.hasLayer(radarOverlayLayer)) {
        radarOverlayLayer.addTo(map);
      }
    }
    updateTimelineMarkerByTime(frame.frameTime, anchorTime);
  }

  function setTimelineReadyState(isReady) {
    timelineTrack.classList.toggle("ready", Boolean(isReady));
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
    const state = getRadarRequestState();
    const frameByIndex = new Array(timeline.length);
    let nextIndex = 0;
    let loadedCount = 0;

    const publish = function () {
      if (runId !== currentFilmRunId) {
        return;
      }
      if (typeof onUpdate !== "function") {
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

  function queueSeekByRatio(ratio) {
    pendingSeekRatio = ratio;
    if (seekRafId) {
      return;
    }
    seekRafId = window.requestAnimationFrame(function () {
      seekRafId = 0;
      if (pendingSeekRatio === null) {
        return;
      }
      const ratioToApply = pendingSeekRatio;
      pendingSeekRatio = null;
      seekByRatio(ratioToApply);
    });
  }

  function loadRadarImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = function () {
        resolve();
      };
      img.onerror = function () {
        reject(new Error("Radarbild konnte nicht geladen werden."));
      };
      img.src = url;
    });
  }

  async function loadCurrentRadarWithFilm() {
    if (!map || isScrubbing) {
      return;
    }

    currentFilmRunId += 1;
    const runId = currentFilmRunId;

    const slot = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);
    const state = getRadarRequestState();
    const currentUrl = buildRadarUrl({
      layer: NOW_LAYER,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      cacheBuster: slot.getTime()
    });

    setTimelineReadyState(false);
    currentAnchorTime = slot;
    currentFrames = [];
    updateTimelineLabels(slot);
    updateTimelineMarkerByTime(slot, slot);
    loadingState.classList.remove("hidden");

    try {
      await loadRadarImage(currentUrl);
    } catch (_error) {
      if (runId !== currentFilmRunId) {
        return;
      }
      return;
    }
    showFrame({ url: currentUrl, frameTime: slot }, 0, slot);

    if (runId !== currentFilmRunId) {
      return;
    }

    const frames = await buildRadarFilmFramesParallel(runId, slot, FILM_LAYER);

    if (runId !== currentFilmRunId) {
      return;
    }

    currentFrames = frames;
    loadingState.classList.add("hidden");
    setTimelineReadyState(true);
  }

  function loadCurrentView(forceForecastReload) {
    loadCurrentRadarWithFilm();
    loadForecast(Boolean(forceForecastReload));
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
      timelineTrack.setPointerCapture(event.pointerId);
      queueSeekByRatio(getRatioFromClientX(event.clientX));
    });

    timelineTrack.addEventListener("pointermove", function (event) {
      if (!isScrubbing) {
        return;
      }
      queueSeekByRatio(getRatioFromClientX(event.clientX));
    });

    timelineTrack.addEventListener("pointerup", function (event) {
      if (!isScrubbing) {
        return;
      }
      queueSeekByRatio(getRatioFromClientX(event.clientX));
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

  document.addEventListener(
    "touchstart",
    function (event) {
      if (event.touches.length !== 1 || isScrubbing || mapEl.contains(event.target)) {
        return;
      }
      touchStartY = event.touches[0].clientY;
      pullTriggered = false;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    function (event) {
      if (event.touches.length !== 1 || isScrubbing || pullTriggered || mapEl.contains(event.target)) {
        return;
      }
      if (window.scrollY > 0) {
        return;
      }

      const deltaY = event.touches[0].clientY - touchStartY;
      if (deltaY > PULL_REFRESH_THRESHOLD) {
        pullTriggered = true;
        loadCurrentView(true);
      }
    },
    { passive: true }
  );

  document.addEventListener(
    "touchend",
    function () {
      pullTriggered = false;
    },
    { passive: true }
  );

  initMap();
  initTimelineScrub();
  loadCurrentView();

  window.addEventListener(
    "resize",
    debounce(function () {
      if (!map) {
        return;
      }

      map.invalidateSize(false);
      frameCache.clear();
      if (!isScrubbing) {
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
