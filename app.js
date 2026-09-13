(function () {
  const WMS_BASE_URL = "https://maps.dwd.de/geoserver/wms";
  const BRIGHT_SKY_WEATHER_URL = "https://api.brightsky.dev/weather";
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
  const RADAR_REQUEST_TIMEOUT_MS = 20000;
  const PULL_REFRESH_THRESHOLD = 90;
  const RADAR_PADDING_FACTOR = 0.08;
  const FORECAST_SLOT_COUNT = 14;
  const FORECAST_STEP_HOURS = 1;
  const FORECAST = window.ForecastModel;
  const FORECAST_TTL_MS = 15 * 60 * 1000;
  const RESUME_REFRESH_DEBOUNCE_MS = 1500;
  const FORECAST_QUERY_PARAMS = new URLSearchParams(window.location.search);
  const FORECAST_PREVIEW_PARAM = FORECAST_QUERY_PARAMS.get("forecastPreview");
  const PRECIPITATION_PREVIEW_PARAM = FORECAST_QUERY_PARAMS.get("precipitationPreview");

  const mapEl = document.getElementById("map");
  const loadingState = document.getElementById("loadingState");
  const radarStatus = document.getElementById("radarStatus");
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
  let lastSuccessfulRadarSlot = null;
  let requestedRadarSlot = null;
  let radarRunController = null;
  let currentFrames = [];
  let currentForecastRunId = 0;
  let forecastCache = null;
  let forecastController = null;
  let renderedForecastHour = null;
  let lastForecastAttemptAt = 0;
  let lastResumeRefreshAt = 0;

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

  function formatForecastTime(date) {
    return FORECAST.time(date);
  }

  function roundTemperature(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return "--";
    }
    return Math.round(value);
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
    return FORECAST.isNight(date, HEIDELBERG_CENTER[0], HEIDELBERG_CENTER[1]);
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

  function getForecastSkyVisual(tone, cloudCover) {
    const cover = typeof cloudCover === "number" && !Number.isNaN(cloudCover) ? Math.max(0, Math.min(100, cloudCover)) : 50;
    const ratio = cover / 100;

    if (tone === "night") {
      return {
        cloudOpacity: (0.18 + ratio * 0.68).toFixed(2),
        cloudDensity: (0.3 + ratio * 0.56).toFixed(2),
        hazeOpacity: (0.1 + ratio * 0.28).toFixed(2),
        glowOpacity: (0.2 - ratio * 0.15).toFixed(2)
      };
    }

    return {
      cloudOpacity: (0.14 + ratio * 0.62).toFixed(2),
      cloudDensity: (0.24 + ratio * 0.56).toFixed(2),
      hazeOpacity: (0.07 + ratio * 0.26).toFixed(2),
      glowOpacity: (0.3 - ratio * 0.22).toFixed(2)
    };
  }

  function getForecastSkyPattern(cloudCover) {
    const cover = typeof cloudCover === "number" && !Number.isNaN(cloudCover) ? Math.max(0, Math.min(100, cloudCover)) : 50;
    return cover >= 65 ? "closed" : "open";
  }

  function getForecastPrecipitationPresentation(entry) {
    return FORECAST.precipitation(entry);
  }

  function renderPrecipitationDrops(dropCount) {
    if (dropCount === null) return '<span class="forecast-unknown">?</span>';
    if (dropCount === 0) return '<span class="forecast-dry">–</span>';
    return '<svg class="forecast-drop" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 1C10 6 2 14 2 20a10 10 0 0 0 20 0C22 14 14 6 12 1Z" fill="currentColor"/></svg>'.repeat(dropCount);
  }

  function renderSpecialWeather(weather) {
    if (!weather) return '';
    const paths = {
      storm: '<path d="M14 1 5 14h7l-2 9 10-14h-7Z" fill="#ffe081" stroke="none"/>',
      snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M8 4l4 3 4-3M8 20l4-3 4 3"/>',
      sleet: '<path d="M7 2v12M2 5l10 6M2 11l10-6M18 12c-1 3-4 5-4 7a4 4 0 0 0 8 0c0-2-3-4-4-7Z"/>',
      hail: '<path d="M4 8h16M6 4h12"/><circle cx="5" cy="15" r="2"/><circle cx="12" cy="20" r="2"/><circle cx="19" cy="15" r="2"/>',
      fog: '<path d="M3 6h18M1 12h22M4 18h16"/>'
    };
    return `<svg class="forecast-weather-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">${paths[weather.symbol]}</svg><span>${weather.label}</span>`;
  }

  function setForecastStatus(message, hidden) {
    forecastStatus.textContent = message;
    forecastStatus.classList.toggle("hidden", Boolean(hidden));
  }

  function clearForecastSlots() {
    forecastSlots.innerHTML = "";
  }

  function buildForecastUrl(date) {
    const start = FORECAST.hourStart(date);
    const params = new URLSearchParams({
      lat: String(HEIDELBERG_CENTER[0]),
      lon: String(HEIDELBERG_CENTER[1]),
      date: start.toISOString(),
      last_date: new Date(start.getTime() + FORECAST_SLOT_COUNT * FORECAST.HOUR_MS).toISOString(),
      tz: FORECAST.TIME_ZONE
    });
    return `${BRIGHT_SKY_WEATHER_URL}?${params.toString()}`;
  }

  async function fetchForecastDay(date, controller) {
    const timer = window.setTimeout(function () { controller.abort(); }, 15000);
    try {
      const response = await fetch(buildForecastUrl(date), { signal: controller.signal });
      if (!response.ok) throw new Error("Vorhersage konnte nicht geladen werden.");
      const payload = await response.json();
      return Array.isArray(payload.weather) ? payload.weather : [];
    } finally {
      window.clearTimeout(timer);
    }
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

  function parsePreviewPrecipitationValues() {
    if (!PRECIPITATION_PREVIEW_PARAM) {
      return null;
    }

    if (PRECIPITATION_PREVIEW_PARAM === "demo") {
      return [
        { precipitation: 0, precipitationProbability: 0 },
        { precipitation: 0.2, precipitationProbability: 30 },
        { precipitation: 0.2, precipitationProbability: 85 },
        { precipitation: 0.8, precipitationProbability: 55 },
        { precipitation: 1.8, precipitationProbability: 85 },
        { precipitation: 3.4, precipitationProbability: 95 },
        { precipitation: 2.4, precipitationProbability: 20 }
      ];
    }

    const values = PRECIPITATION_PREVIEW_PARAM
      .split(",")
      .map(function (item) {
        const parts = item.split(":");
        if (!parts.length) {
          return null;
        }

        const precipitation = Number.parseFloat(parts[0].trim());
        const probability = parts.length > 1 ? Number.parseFloat(parts[1].trim()) : null;

        if (!Number.isFinite(precipitation) && !Number.isFinite(probability)) {
          return null;
        }

        return {
          precipitation: Number.isFinite(precipitation) ? Math.max(0, precipitation) : null,
          precipitationProbability: Number.isFinite(probability) ? Math.max(0, Math.min(100, probability)) : null
        };
      })
      .filter(function (value) {
        return value !== null;
      });

    return values.length ? values : null;
  }

  function buildPreviewForecastEntries(now) {
    const cloudCovers = parsePreviewCloudCoverValues();
    const precipitationValues = parsePreviewPrecipitationValues();
    if (!cloudCovers && !precipitationValues) {
      return null;
    }

    const startTime = FORECAST.hourStart(now);

    return Array.from({ length: FORECAST_SLOT_COUNT }, function (_unused, index) {
      const timestamp = new Date(startTime.getTime() + index * FORECAST_STEP_HOURS * 60 * 60 * 1000);
      const cloudCover = cloudCovers ? cloudCovers[Math.min(index, cloudCovers.length - 1)] : 50;
      const precipitationPreview = precipitationValues ? precipitationValues[Math.min(index, precipitationValues.length - 1)] : null;

      return {
        timestamp,
        endTime: new Date(timestamp.getTime() + FORECAST.HOUR_MS),
        temperature: 12 + index,
        cloudCover,
        precipitation:
          precipitationPreview && precipitationPreview.precipitation !== null
            ? precipitationPreview.precipitation
            : cloudCover > 70
              ? 0.6
              : 0,
        precipitationProbability:
          precipitationPreview && precipitationPreview.precipitationProbability !== null
            ? precipitationPreview.precipitationProbability
            : cloudCover > 50
              ? Math.round(cloudCover * 0.7)
              : 0,
        icon: cloudCover > 75 ? "cloudy" : cloudCover > 45 ? "partly-cloudy-day" : "clear-day",
        condition: cloudCover > 75 ? "cloudy" : cloudCover > 45 ? "partly-cloudy" : "clear"
      };
    });
  }

  function selectForecastEntries(entries, now) {
    return FORECAST.selectIntervals(entries, now, FORECAST_SLOT_COUNT);
  }

  function renderForecast(entries) {
    const now = new Date();
    const hour = FORECAST.hourStart(now).getTime();
    const scrollLeft = renderedForecastHour === hour ? forecastSlots.scrollLeft : 0;
    clearForecastSlots();
    renderedForecastHour = hour;
    entries.forEach(function (entry) {
      const slotEl = document.createElement("article");
      const precipitation = getForecastPrecipitationPresentation(entry);
      const cloudCover = Number.isFinite(entry.cloudCover) ? Math.max(0, Math.min(100, entry.cloudCover)) : null;
      const cardTone = getForecastCardTone(entry.timestamp);
      const palette = getForecastCardPalette(cardTone, cloudCover);
      const skyVisual = getForecastSkyVisual(cardTone, cloudCover);
      const special = FORECAST.specialWeather(entry);
      const isCurrent = now >= entry.timestamp && now < entry.endTime;
      const day = FORECAST.dayLabel(entry.timestamp, now);
      const interval = FORECAST.intervalLabel(entry.timestamp, entry.endTime);
      const skyLabel = cloudCover === null ? "Wolkenlage unbekannt" : `${describeCloudCover(cloudCover)}, ${Math.round(cloudCover)} Prozent Wolken`;
      slotEl.className = `forecast-slot forecast-slot-${cardTone}${isCurrent ? " current" : ""}${cloudCover === null ? " forecast-slot-unknown" : ""}`;
      slotEl.setAttribute("aria-label", `${day}, ${interval}${isCurrent ? ", laufende Stunde" : ""}: ${Number.isFinite(entry.temperature) ? `${roundTemperature(entry.temperature)} Grad` : "Temperatur unbekannt"}, ${skyLabel}${special ? `, ${special.label}` : ""}, ${precipitation.ariaLabel}`);
      slotEl.style.setProperty("--forecast-bg-top", palette.top);
      slotEl.style.setProperty("--forecast-bg-bottom", palette.bottom);
      slotEl.style.setProperty("--forecast-cloud-opacity", skyVisual.cloudOpacity);
      slotEl.style.setProperty("--forecast-cloud-density", skyVisual.cloudDensity);
      slotEl.style.setProperty("--forecast-haze-opacity", skyVisual.hazeOpacity);
      slotEl.style.setProperty("--forecast-glow-opacity", skyVisual.glowOpacity);
      slotEl.innerHTML = `
        <div class="forecast-sky forecast-sky-${getForecastSkyPattern(cloudCover)}" aria-hidden="true"></div>
        <div class="forecast-caption">
          <p class="forecast-day">${day}${isCurrent ? " · jetzt" : ""}</p>
          <p class="forecast-time">${interval}</p>
        </div>
        <p class="forecast-temp">${roundTemperature(entry.temperature)}&thinsp;&deg;</p>
        <div class="forecast-condition">${renderSpecialWeather(special) || (cloudCover === null ? 'Wolken ?' : '')}</div>
        <div class="forecast-rain-panel">
          <div class="forecast-precipitation" aria-hidden="true">${renderPrecipitationDrops(precipitation.dropCount)}</div>
          <p class="forecast-amount">${precipitation.amountLabel}</p>
          <p class="forecast-probability">${precipitation.probabilityLabel}</p>
        </div>`;
      forecastSlots.appendChild(slotEl);
    });
    forecastSlots.scrollLeft = scrollLeft || 0;
  }

  async function loadForecast(forceReload) {
    const now = new Date();
    const previewEntries = buildPreviewForecastEntries(now);
    if (previewEntries) {
      renderForecast(previewEntries);
      setForecastStatus("Vorschau mit Beispieldaten", false);
      return;
    }
    if (forecastCache) renderForecast(selectForecastEntries(forecastCache.entries, now));
    const requiredEnd = FORECAST.hourStart(now).getTime() + FORECAST_SLOT_COUNT * FORECAST.HOUR_MS;
    if (!forceReload && forecastCache && now.getTime() - forecastCache.loadedAt < FORECAST_TTL_MS && forecastCache.requestedEnd >= requiredEnd) {
      setForecastStatus("", true);
      return;
    }
    currentForecastRunId += 1;
    const runId = currentForecastRunId;
    if (forecastController) forecastController.abort();
    const controller = new AbortController();
    forecastController = controller;
    lastForecastAttemptAt = now.getTime();
    setForecastStatus(forecastCache ? "Aktualisiere Prognose …" : "Lade Prognose …", false);
    try {
      const records = normalizeForecastEntries(await fetchForecastDay(now, controller));
      if (runId !== currentForecastRunId) return;
      const selected = selectForecastEntries(records, new Date());
      if (!selected.length) throw new Error("Keine Prognose verfügbar.");
      forecastCache = { entries: records, loadedAt: Date.now(), requestedEnd: requiredEnd };
      renderForecast(selected);
      setForecastStatus("", true);
    } catch (_error) {
      if (runId !== currentForecastRunId) return;
      const retained = forecastCache ? selectForecastEntries(forecastCache.entries, new Date()) : [];
      if (retained.length) {
        renderForecast(retained);
        setForecastStatus("Aktualisierung fehlgeschlagen – Prognose möglicherweise veraltet.", false);
      } else {
        clearForecastSlots();
        setForecastStatus("Prognose gerade nicht verfügbar. Zum Wiederholen nach unten ziehen.", false);
      }
    } finally {
      if (runId === currentForecastRunId) forecastController = null;
    }
  }

  function refreshForecastClock() {
    if (document.hidden) return;
    const now = new Date();
    const changedHour = renderedForecastHour !== FORECAST.hourStart(now).getTime();
    if (forecastCache && changedHour) renderForecast(selectForecastEntries(forecastCache.entries, now));
    if (!forecastController && now.getTime() - lastForecastAttemptAt >= 60000 && (changedHour || isForecastStaleForResume(now))) loadForecast(false);
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

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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

  function preloadImageFrame(key, url, frameTime, signal) {
    if (frameCache.has(key)) {
      return frameCache.get(key);
    }

    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      let settled = false;
      const finish = function (error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
        img.onload = null;
        img.onerror = null;
        if (error) {
          img.removeAttribute("src");
          reject(error);
        } else {
          resolve({ url, frameTime });
        }
      };
      const onAbort = function () {
        finish(new Error("Radar request cancelled."));
      };
      const timeoutId = window.setTimeout(function () {
        finish(new Error("Radar request timed out."));
      }, RADAR_REQUEST_TIMEOUT_MS);
      img.onload = function () {
        finish();
      };
      img.onerror = function () {
        finish(new Error(`Frame failed for ${key}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      img.src = url;
    });

    frameCache.set(key, promise);
    promise.catch(function () {
      if (frameCache.get(key) === promise) frameCache.delete(key);
    });
    return promise;
  }

  function preloadRadarFrame(layer, frameTime, state, signal) {
    const timeIso = formatIsoTime(frameTime);
    const key = cacheKey(layer, timeIso, state);
    const url = buildRadarUrl({
      layer,
      time: timeIso,
      bbox: state.bbox,
      width: state.width,
      height: state.height,
      // Re-request invalidated predictions from the server, not the browser cache.
      cacheBuster: `${Date.now()}-${currentFilmRunId}`
    });

    return preloadImageFrame(key, url, frameTime, signal);
  }

  async function buildRadarFilmFramesParallel(runId, anchorTime, layer, signal, onUpdate) {
    const timeline = createFilmTimeline(anchorTime);
    const order = timeline.map(function (_time, index) { return index; }).sort(function (a, b) {
      return Math.abs(timeline[a] - anchorTime) - Math.abs(timeline[b] - anchorTime);
    });
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
        const index = order[nextIndex];
        nextIndex += 1;

        if (runId !== currentFilmRunId) {
          return;
        }

        try {
          const frame = await preloadRadarFrame(layer, timeline[index], state, signal);
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

    const target = currentAnchorTime.getTime() + (ratio * 2 - 1) * FILM_WINDOW_MINUTES * 60 * 1000;
    const index = currentFrames.reduce(function (best, frame, candidate) {
      return Math.abs(frame.frameTime.getTime() - target) < Math.abs(currentFrames[best].frameTime.getTime() - target)
        ? candidate : best;
    }, 0);
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

  function setRadarStatus(message) {
    radarStatus.textContent = message;
    radarStatus.classList.toggle("hidden", !message);
  }

  async function loadCurrentRadarWithFilm() {
    if (!map || isScrubbing) {
      return;
    }

    currentFilmRunId += 1;
    const runId = currentFilmRunId;
    if (radarRunController) radarRunController.abort();
    radarRunController = new AbortController();
    const signal = radarRunController.signal;
    // Let cancelled cache promises remove themselves before starting the next run.
    await Promise.resolve();
    if (runId !== currentFilmRunId) return;

    const slot = new Date(getFiveMinuteSlot(new Date()).getTime() - STEP_MS);
    requestedRadarSlot = slot;
    const state = getRadarRequestState();
    frameCache.forEach(function (_promise, key) {
      const time = Date.parse(key.split("|")[1]);
      // Forecast frames can change between runs, even for the same valid time.
      if (!lastSuccessfulRadarSlot || time >= lastSuccessfulRadarSlot.getTime() ||
          time < slot.getTime() - FILM_WINDOW_MINUTES * 60 * 1000) frameCache.delete(key);
    });

    setTimelineReadyState(false);
    currentFrames = [];
    setRadarStatus(radarOverlayLayer ? "Aktualisiere Radar – bisheriges Bild bleibt sichtbar." : "");
    loadingState.classList.remove("hidden");

    try {
      let currentFrame;
      // The latest five-minute slot may not have reached the server yet.
      for (let lag = 0; lag <= 2; lag += 1) {
        if (signal.aborted) return;
        try {
          currentFrame = await preloadRadarFrame(FILM_LAYER, new Date(slot.getTime() - lag * STEP_MS), state, signal);
          break;
        } catch (error) {
          if (signal.aborted) return;
          if (lag === 2) throw error;
        }
      }
      if (runId !== currentFilmRunId) return;
      currentAnchorTime = currentFrame.frameTime;
      lastSuccessfulRadarSlot = currentFrame.frameTime;
      updateTimelineLabels(currentAnchorTime);
      showFrame(currentFrame, 0, currentAnchorTime);
      currentFrames = [currentFrame];
      loadingState.classList.add("hidden");
      const delayMessage = currentFrame.frameTime < slot ? `Radar verzögert: Stand ${formatTime(currentFrame.frameTime)}. ` : "";
      setRadarStatus(`${delayMessage}Lade Zeitverlauf …`);
      const frames = await buildRadarFilmFramesParallel(runId, currentAnchorTime, FILM_LAYER, signal, function (update) {
        currentFrames = update.frames;
        setTimelineReadyState(currentFrames.length > 1);
      });
      if (runId !== currentFilmRunId) return;
      currentFrames = frames;
      setTimelineReadyState(frames.length > 1);
      setRadarStatus(delayMessage + (frames.length < createFilmTimeline(currentAnchorTime).length ? "Zeitverlauf unvollständig. Zum Wiederholen nach unten ziehen." : ""));
    } catch (_error) {
      if (runId !== currentFilmRunId) return;
      setRadarStatus(radarOverlayLayer
        ? "Radar konnte nicht aktualisiert werden. Angezeigtes Bild ist möglicherweise veraltet. Zum Wiederholen nach unten ziehen."
        : "Radar gerade nicht verfügbar. Zum Wiederholen nach unten ziehen.");
    } finally {
      if (runId === currentFilmRunId) {
        loadingState.classList.add("hidden");
        radarRunController = null;
      }
    }
  }

  function loadCurrentView(forceForecastReload) {
    loadCurrentRadarWithFilm();
    loadForecast(Boolean(forceForecastReload));
  }

  function isRadarStaleForResume(now) {
    const latestRadarSlot = new Date(getFiveMinuteSlot(now).getTime() - STEP_MS);
    if (radarRunController) {
      return Boolean(requestedRadarSlot && latestRadarSlot.getTime() > requestedRadarSlot.getTime());
    }
    return !lastSuccessfulRadarSlot || latestRadarSlot.getTime() > lastSuccessfulRadarSlot.getTime();
  }

  function isForecastStaleForResume(now) {
    const requiredEnd = FORECAST.hourStart(now).getTime() + FORECAST_SLOT_COUNT * FORECAST.HOUR_MS;
    return !forecastCache || now.getTime() - forecastCache.loadedAt >= FORECAST_TTL_MS || forecastCache.requestedEnd < requiredEnd;
  }

  function refreshOnResumeIfNeeded() {
    if (document.hidden) {
      return;
    }

    const now = new Date();
    const shouldReloadRadar = isRadarStaleForResume(now);
    const shouldReloadForecast = isForecastStaleForResume(now) || renderedForecastHour !== FORECAST.hourStart(now).getTime();

    if (now.getTime() - lastResumeRefreshAt < RESUME_REFRESH_DEBOUNCE_MS) {
      return;
    }

    if (!shouldReloadRadar && !shouldReloadForecast) {
      return;
    }

    lastResumeRefreshAt = now.getTime();

    if (shouldReloadRadar) {
      loadCurrentRadarWithFilm();
    }

    if (shouldReloadForecast) {
      loadForecast(false);
    }
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
  window.setInterval(refreshForecastClock, 30000);

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

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      return;
    }

    refreshOnResumeIfNeeded();
  });

  window.addEventListener("focus", function () {
    refreshOnResumeIfNeeded();
  });

  window.addEventListener("pageshow", function () {
    refreshOnResumeIfNeeded();
  });

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
