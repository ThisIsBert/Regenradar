const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const model = require('../forecast-model.js');
const date = value => new Date(value);
const record = (timestamp, values = {}) => ({ timestamp: date(timestamp), temperature: 20, cloudCover: 50, precipitation: 0, precipitationProbability: 0, ...values });

test('16–17 uses rain from 17 but temperature and clouds from 16', () => {
  const cards = model.selectIntervals([
    record('2026-09-13T16:00:00+02:00', { temperature: 25, cloudCover: 80, precipitation: 9 }),
    record('2026-09-13T17:00:00+02:00', { temperature: 19, cloudCover: 40, precipitation: 0.7, precipitationProbability: 60 })
  ], date('2026-09-13T16:43:00+02:00'));
  assert.equal(cards[0].temperature, 25);
  assert.equal(cards[0].cloudCover, 80);
  assert.equal(cards[0].precipitation, 0.7);
  assert.equal(cards[0].precipitationProbability, 60);
  assert.equal(model.intervalLabel(cards[0].timestamp, cards[0].endTime), '16:00–17:00');
});

test('missing records keep their hourly position and distinguish unknown values', () => {
  const cards = model.selectIntervals([record('2026-09-13T18:00:00+02:00', { precipitation: 2 })], date('2026-09-13T16:43:00+02:00'));
  assert.equal(cards[0].temperature, null);
  assert.equal(cards[0].precipitation, null);
  assert.equal(cards[1].precipitation, 2);
  assert.equal(cards[2].temperature, 20);
});

test('drop count depends only on amount; probability and missing values stay explicit', () => {
  for (const probability of [0, 10, 80, null]) {
    assert.equal(model.precipitation({ precipitation: 0, precipitationProbability: probability }).dropCount, 0);
    assert.equal(model.precipitation({ precipitation: 0.2, precipitationProbability: probability }).dropCount, 1);
    assert.equal(model.precipitation({ precipitation: 3, precipitationProbability: probability }).dropCount, 3);
  }
  const unknown = model.precipitation({ precipitation: null, precipitationProbability: null });
  assert.equal(unknown.dropCount, null);
  assert.match(unknown.ariaLabel, /unbekannt/);
  assert.equal(model.precipitation({ precipitation: 0.04 }).amountLabel, '<0,1 mm');
});

test('night follows the sun in Heidelberg in summer and winter', () => {
  assert.equal(model.isNight(date('2026-06-21T20:30:00+02:00')), false);
  assert.equal(model.isNight(date('2026-12-21T17:30:00+01:00')), true);
  assert.equal(model.isNight(date('2026-06-21T05:30:00+02:00')), false);
  assert.equal(model.isNight(date('2026-12-21T07:30:00+01:00')), true);
  assert.equal(model.isNight(date('2026-12-21T12:00:00+01:00')), false);
});

test('hour intervals and day labels survive both DST transitions and midnight', () => {
  const spring = model.selectIntervals([record('2026-03-29T01:00:00+01:00')], date('2026-03-29T01:30:00+01:00'), 3);
  assert.equal(model.time(spring[1].timestamp), '03:00');
  const autumn = model.selectIntervals([record('2026-10-25T02:00:00+02:00')], date('2026-10-25T02:30:00+02:00'), 3);
  assert.match(model.intervalLabel(autumn[0].timestamp, autumn[0].endTime), /MESZ.*MEZ/);
  assert.equal(model.time(autumn[1].timestamp), '02:00');
  assert.equal(model.dayLabel(date('2026-03-29T23:30:00+02:00'), date('2026-03-28T23:30:00+01:00')), 'Morgen');
  assert.equal(model.dayLabel(date('2026-09-14T01:00:00+02:00'), date('2026-09-13T23:50:00+02:00')), 'Morgen');
});

test('special weather preserves snow, sleet, hail, fog and thunderstorms', () => {
  for (const [condition, label] of [['snow', 'Schnee'], ['sleet', 'Schneeregen'], ['hail', 'Hagel'], ['fog', 'Nebel'], ['thunderstorm', 'Gewitter']]) {
    assert.equal(model.specialWeather({ condition }).label, label);
  }
  assert.equal(model.specialWeather({ condition: 'dry', icon: 'clear-day' }), null);
  assert.equal(model.specialWeather({ condition: '__proto__', icon: 'unknown' }), null);
});

function appHarness() {
  let clock = Date.parse('2026-09-13T16:58:00+02:00');
  const elements = new Map();
  const pending = [];
  const timers = new Map();
  let timerId = 0;
  const makeElement = () => ({
    children: [], attributes: {}, style: { setProperty() {} }, scrollLeft: 0,
    classList: { toggle() {} }, textContent: '',
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html || ''; },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(element) { this.children.push(element); }
  });
  const getElement = id => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const context = {
    Date: Clock, URLSearchParams, AbortController,
    document: { hidden: false, getElementById: getElement, createElement: makeElement },
    window: { ForecastModel: model, location: { search: '' },
      setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } },
    fetch(url, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        pending.push({ url, resolve: weather => resolve({ ok: true, json: async () => ({ weather }) }), reject });
      });
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  vm.runInNewContext(source.slice(0, source.indexOf('  document.addEventListener(\n    "touchstart"')) + 'globalThis.api = {loadForecast,refreshForecastClock,buildForecastUrl,renderForecast};})();', context);
  const payload = () => Array.from({ length: 15 }, (_, index) => ({ timestamp: new Date(Date.parse('2026-09-13T14:00:00Z') + index * model.HOUR_MS).toISOString(), temperature: 20 + index, cloud_cover: 90, precipitation: index / 10, precipitation_probability: 60, condition: 'snow' }));
  return { api: context.api, pending, getElement, timers, payload, advance(ms) { clock += ms; }, async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); } };
}

test('request uses explicit ISO interval including final rain record; cache rerenders at hour change', async () => {
  const h = appHarness();
  const run = h.api.loadForecast();
  const url = new URL(h.pending[0].url);
  assert.equal(url.searchParams.get('date'), '2026-09-13T14:00:00.000Z');
  assert.equal(url.searchParams.get('last_date'), '2026-09-14T04:00:00.000Z');
  h.pending[0].resolve(h.payload());
  await run;
  assert.match(h.getElement('forecastSlots').children[0].innerHTML, /16:00–17:00/);
  assert.match(h.getElement('forecastSlots').children[0].innerHTML, /Schnee/);
  assert.match(h.getElement('forecastSlots').children[0].innerHTML, /<svg class="forecast-drop"/);
  h.advance(3 * 60000);
  h.api.refreshForecastClock();
  assert.match(h.getElement('forecastSlots').children[0].innerHTML, /17:00–18:00/);
  assert.equal(h.pending.length, 2);
  h.pending[1].reject(new Error('offline'));
  await h.flush();
  assert.match(h.getElement('forecastStatus').textContent, /möglicherweise veraltet/);
  assert.equal(h.getElement('forecastSlots').children.length, 14);
});

test('superseded responses cannot replace newer forecasts and timeouts report failure', async () => {
  const h = appHarness();
  const first = h.api.loadForecast();
  const second = h.api.loadForecast(true);
  h.pending[1].resolve(h.payload());
  await second;
  h.pending[0].resolve([]);
  await first;
  assert.equal(h.getElement('forecastSlots').children.length, 14);
  const third = h.api.loadForecast(true);
  for (const callback of [...h.timers.values()]) callback();
  await third;
  assert.match(h.getElement('forecastStatus').textContent, /möglicherweise veraltet/);
  assert.equal(h.timers.size, 0);
});

test('hour-change refresh resumes after the request debounce has elapsed', async () => {
  const h = appHarness();
  h.advance(110000); // Start the request at 16:59:50.
  const first = h.api.loadForecast();
  h.pending[0].resolve(h.payload());
  await first;
  h.advance(20000);
  h.api.refreshForecastClock();
  assert.match(h.getElement('forecastSlots').children[0].innerHTML, /17:00–18:00/);
  assert.equal(h.pending.length, 1);
  h.advance(40000);
  h.api.refreshForecastClock();
  assert.equal(h.pending.length, 2, 'the new horizon still needs a fetch after the label advanced');
  h.pending[1].resolve(h.payload());
  await h.flush();
});
