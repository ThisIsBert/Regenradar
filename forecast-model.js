(function (root) {
  "use strict";
  const HOUR_MS = 60 * 60 * 1000;
  const TIME_ZONE = "Europe/Berlin";

  function hourStart(date) {
    return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
  }

  function localDate(date) {
    const parts = new Intl.DateTimeFormat("en", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const value = type => parts.find(part => part.type === type).value;
    return `${value("year")}-${value("month")}-${value("day")}`;
  }

  function time(date) {
    return new Intl.DateTimeFormat("de-DE", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function dayLabel(date, now) {
    if (localDate(date) === localDate(now)) return "Heute";
    // Calendar arithmetic rather than a 24-hour jump across a DST transition.
    const tomorrow = new Date(Date.parse(`${localDate(now)}T12:00:00Z`) + 24 * HOUR_MS).toISOString().slice(0, 10);
    if (localDate(date) === tomorrow) return "Morgen";
    return new Intl.DateTimeFormat("de-DE", { timeZone: TIME_ZONE, weekday: "short", day: "2-digit", month: "2-digit" }).format(date);
  }

  function intervalLabel(start, end) {
    let label = `${time(start)}–${time(end)}`;
    const offset = date => new Intl.DateTimeFormat("de-DE", { timeZone: TIME_ZONE, timeZoneName: "short" }).formatToParts(date).find(part => part.type === "timeZoneName").value;
    if (offset(start) !== offset(end)) label = `${time(start)} ${offset(start)}–${time(end)} ${offset(end)}`;
    return label;
  }

  function selectIntervals(records, now, count = 14) {
    const start = hourStart(now).getTime();
    const byTime = new Map(records.map(record => [record.timestamp.getTime(), record]));
    if (!records.some(record => record.timestamp.getTime() >= start && record.timestamp.getTime() <= start + count * HOUR_MS)) return [];
    return Array.from({ length: count }, (_, index) => {
      const timestamp = new Date(start + index * HOUR_MS);
      const endTime = new Date(timestamp.getTime() + HOUR_MS);
      const atStart = byTime.get(timestamp.getTime());
      const atEnd = byTime.get(endTime.getTime());
      // Bright Sky: temperature/clouds at timestamp; rain totals/probabilities
      // refer to the PREVIOUS hour. The ending record belongs to this interval.
      return {
        timestamp, endTime,
        temperature: atStart?.temperature ?? null,
        cloudCover: atStart?.cloudCover ?? null,
        precipitation: atEnd?.precipitation ?? null,
        precipitationProbability: atEnd?.precipitationProbability ?? null,
        condition: atStart?.condition || "",
        icon: atStart?.icon || ""
      };
    });
  }

  function precipitation(entry) {
    const amount = Number.isFinite(entry.precipitation) ? Math.max(0, entry.precipitation) : null;
    const probability = Number.isFinite(entry.precipitationProbability) ? Math.max(0, Math.min(100, entry.precipitationProbability)) : null;
    const dropCount = amount === null ? null : amount < 0.05 ? 0 : amount < 0.4 ? 1 : amount < 1.5 ? 2 : 3;
    const amountLabel = amount === null ? "Menge ?" : amount > 0 && amount < 0.1 ? "<0,1 mm" : `${amount.toLocaleString("de-DE", { maximumFractionDigits: 1 })} mm`;
    const probabilityLabel = probability === null ? "Chance ?" : `${Math.round(probability)} %`;
    return { dropCount, amountLabel, probabilityLabel,
      ariaLabel: `${amount === null ? "Niederschlagsmenge unbekannt" : `Niederschlagsmenge ${amountLabel}`}, ${probability === null ? "Niederschlagswahrscheinlichkeit unbekannt" : `Niederschlagswahrscheinlichkeit ${probabilityLabel}`}` };
  }

  function specialWeather(entry) {
    const kinds = {
      thunderstorm: { symbol: "storm", label: "Gewitter" },
      hail: { symbol: "hail", label: "Hagel" },
      sleet: { symbol: "sleet", label: "Schneeregen" },
      snow: { symbol: "snow", label: "Schnee" },
      fog: { symbol: "fog", label: "Nebel" }
    };
    if (Object.prototype.hasOwnProperty.call(kinds, entry.condition)) return kinds[entry.condition];
    if (Object.prototype.hasOwnProperty.call(kinds, entry.icon)) return kinds[entry.icon];
    return null;
  }

  function isNight(date, latitude = 49.39875, longitude = 8.67243) {
    // NOAA approximate solar position; no clock-time or season assumptions.
    // https://gml.noaa.gov/grad/solcalc/solareqns.PDF
    const year = date.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    const days = (Date.UTC(year + 1, 0, 1) - yearStart) / (24 * HOUR_MS);
    const day = Math.floor((date.getTime() - yearStart) / (24 * HOUR_MS)) + 1;
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const gamma = 2 * Math.PI / days * (day - 1 + (hour - 12) / 24);
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const radians = Math.PI / 180;
    const angle = (hour * 60 + eqtime + 4 * longitude) / 4 - 180;
    const cosZenith = Math.sin(latitude * radians) * Math.sin(decl) + Math.cos(latitude * radians) * Math.cos(decl) * Math.cos(angle * radians);
    return cosZenith < Math.cos(90.833 * radians);
  }

  const api = { HOUR_MS, TIME_ZONE, hourStart, localDate, time, dayLabel, intervalLabel, selectIntervals, precipitation, specialWeather, isNight };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ForecastModel = api;
})(typeof window !== "undefined" ? window : globalThis);
