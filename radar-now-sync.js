(() => {
  const STEP_MS = 5 * 60 * 1000;
  const FILM_LAYER = "dwd:Radar_rv_product_1x1km_ger";

  function slotNow() {
    const slotStart = Math.floor(Date.now() / STEP_MS) * STEP_MS;
    return new Date(slotStart - STEP_MS);
  }

  function iso(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function syncNowFrame() {
    const track = document.getElementById("timelineTrack");
    const image = document.querySelector(".leaflet-image-layer");
    if (!track || !track.classList.contains("ready") || !image || !image.src) return;

    const slot = slotNow();
    const url = new URL(image.src);
    url.searchParams.set("LAYERS", FILM_LAYER);
    url.searchParams.set("TIME", iso(slot));
    url.searchParams.set("_", String(slot.getTime()));

    const nextSrc = url.toString();
    if (image.src === nextSrc) return;

    const preloader = new Image();
    preloader.onload = () => {
      image.src = nextSrc;
    };
    preloader.src = nextSrc;
  }

  const track = document.getElementById("timelineTrack");
  if (track && window.MutationObserver) {
    new MutationObserver(syncNowFrame).observe(track, { attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("pageshow", syncNowFrame);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncNowFrame();
  });
})();
