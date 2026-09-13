const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const elements = new Map();
  const images = [];
  const timers = new Map();
  let timerId = 0;
  let now = Date.parse('2026-09-13T14:29:00Z');
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        textContent: '', style: {}, addEventListener() {},
        classList: {
          add: (name) => classes.add(name), remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
        }
      });
    }
    return elements.get(id);
  };
  class FakeImage {
    constructor() { images.push(this); }
    set src(value) { this.url = value; }
    removeAttribute() { this.cancelled = true; }
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = {
    Date: Clock, URLSearchParams, AbortController, Image: FakeImage, navigator: {},
    document: { getElementById: element, addEventListener() {}, hidden: false },
    window: {
      location: { search: '' }, addEventListener() {},
      setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
      clearTimeout(id) { timers.delete(id); }
    },
    L: {
      imageOverlay(url) {
        const image = { src: url };
        return { addTo() { return this; }, getElement() { return image; }, setBounds() {}, setUrl(value) { image.src = value; } };
      }
    }
  };
  let source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  source = source.replace('  initMap();\n  initTimelineScrub();\n  loadCurrentView();', '');
  source = source.replace(/\}\)\(\);\s*$/, `
    radarBaseBounds = { getSouthWest: () => ({ x: 1, y: 2 }), getNorthEast: () => ({ x: 3, y: 4 }) };
    map = { options: { crs: { project: x => x } }, getSize: () => ({ x: 400, y: 500 }), hasLayer: () => true };
    globalThis.api = {
      load: loadCurrentRadarWithFilm, stale: () => isRadarStaleForResume(new Date()),
      seek: seekByRatio, cache: frameCache,
      state: () => ({ anchor: currentAnchorTime, frames: currentFrames, overlay: radarOverlayLayer, successful: lastSuccessfulRadarSlot })
    };
  })();`);
  vm.runInNewContext(source, context);
  return {
    api: context.api, images, element, timers,
    advance(ms) { now += ms; },
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    pending() { return images.filter(img => img.onload && !img.cancelled); },
    async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  };
}

test('shows current radar before film finishes; partial timeline seeks by time and cannot reset selected image', async () => {
  const h = harness();
  const run = h.api.load();
  await h.flush();
  assert.equal(h.images.length, 1);
  assert.equal(new URL(h.images[0].url).searchParams.get('TIME'), '2026-09-13T14:20:00Z');
  h.images[0].onload();
  await h.flush();
  assert.ok(h.api.state().overlay);
  assert.ok(h.element('loadingState').classList.contains('hidden'));
  assert.ok(h.pending().length > 0);
  const older = h.pending().find(img => new URL(img.url).searchParams.get('TIME') === '2026-09-13T14:15:00Z');
  older.onload();
  await h.flush();
  h.api.seek(0.5);
  assert.equal(h.api.state().overlay.getElement().src, h.images[0].url);
  h.api.seek(0);
  const selected = h.api.state().overlay.getElement().src;
  for (let batch = 0; batch < 10 && h.pending().length; batch++) {
    h.pending().forEach(img => img.onload());
    await h.flush();
  }
  await run;
  assert.equal(h.api.state().frames.length, 25);
  assert.equal(h.images.length, 25, 'current frame is reused by film');
  assert.equal(h.api.state().overlay.getElement().src, selected);
  assert.equal(h.element('radarStatus').textContent, '');
  assert.equal(h.timers.size, 0);
});

test('stalled requests end with a visible error and can be retried in the same slot', async () => {
  const h = harness();
  const run = h.api.load();
  await h.flush();
  for (let i = 0; i < 3; i++) { h.expire(); await h.flush(); }
  await run;
  assert.equal(h.api.cache.size, 0);
  assert.equal(h.api.state().successful, null);
  assert.equal(h.api.stale(), true);
  assert.match(h.element('radarStatus').textContent, /nicht verfügbar/);
  assert.ok(h.element('loadingState').classList.contains('hidden'));
  const retry = h.api.load();
  await h.flush();
  assert.equal(h.images.length, 4);
  h.pending()[0].onload();
  await h.flush();
  assert.ok(h.api.state().overlay);
  for (let batch = 0; batch < 10 && h.pending().length; batch++) { h.expire(); await h.flush(); }
  await retry;
  assert.match(h.element('radarStatus').textContent, /unvollständig/);
  assert.equal(h.timers.size, 0);
});

test('missing latest slot falls back to an explicitly dated recent image', async () => {
  const h = harness();
  const run = h.api.load();
  await h.flush();
  h.pending()[0].onerror();
  await h.flush();
  assert.equal(new URL(h.pending()[0].url).searchParams.get('TIME'), '2026-09-13T14:15:00Z');
  h.pending()[0].onload();
  await h.flush();
  assert.equal(h.api.state().anchor.toISOString(), '2026-09-13T14:15:00.000Z');
  assert.match(h.element('radarStatus').textContent, /Radar verzögert/);
  for (let batch = 0; batch < 10 && h.pending().length; batch++) { h.expire(); await h.flush(); }
  await run;
  assert.equal(h.api.stale(), true);
});

test('replacement run cancels old requests and prevents late results overwriting current radar', async () => {
  const h = harness();
  const first = h.api.load();
  await h.flush();
  const oldImage = h.images[0];
  const lateLoad = oldImage.onload;
  const second = h.api.load();
  await h.flush();
  assert.ok(oldImage.cancelled);
  assert.equal(h.pending().length, 1);
  lateLoad();
  assert.equal(h.api.state().overlay, undefined);
  h.pending()[0].onload();
  await h.flush();
  for (let batch = 0; batch < 10 && h.pending().length; batch++) { h.expire(); await h.flush(); }
  await Promise.all([first, second]);
  assert.ok(h.api.state().overlay);
  assert.equal(h.timers.size, 0);
});

test('resume keeps historical frames but reloads earlier predictions and bounds cache growth', async () => {
  const h = harness();
  const first = h.api.load();
  await h.flush();
  for (let batch = 0; batch < 10 && h.pending().length; batch++) { h.pending().forEach(img => img.onload()); await h.flush(); }
  await first;
  h.advance(5 * 60000);
  assert.equal(h.api.stale(), true);
  const before = h.images.length;
  const second = h.api.load();
  await h.flush();
  for (let batch = 0; batch < 10 && h.pending().length; batch++) { h.pending().forEach(img => img.onload()); await h.flush(); }
  await second;
  const newTimes = h.images.slice(before).map(img => new URL(img.url).searchParams.get('TIME'));
  assert.ok(newTimes.includes('2026-09-13T14:25:00Z'));
  assert.ok(newTimes.includes('2026-09-13T14:20:00Z'));
  assert.ok(!newTimes.includes('2026-09-13T14:15:00Z'));
  assert.equal(h.api.cache.size, 25);
  const priorPrediction = h.images.slice(0, before).find(img => new URL(img.url).searchParams.get('TIME') === '2026-09-13T14:25:00Z');
  const currentObservation = h.images.slice(before).find(img => new URL(img.url).searchParams.get('TIME') === '2026-09-13T14:25:00Z');
  assert.notEqual(priorPrediction.url, currentObservation.url, 'browser cache must not reuse the old prediction');
});

test('resume detects a new slot even when a previous request is still pending', async () => {
  const h = harness();
  const run = h.api.load();
  await h.flush();
  assert.equal(h.api.stale(), false);
  h.advance(5 * 60000);
  assert.equal(h.api.stale(), true);
  for (let i = 0; i < 3; i++) { h.expire(); await h.flush(); }
  await run;
});
