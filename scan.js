/* Camera + text recognition for checking a physical deck. Loads the OCR library only when the scanner is opened. */
(function () {
  "use strict";
  const V = "5.1.1", CDN = "https://cdn.jsdelivr.net/npm/";
  const CFG = { script: CDN + "tesseract.js@" + V + "/dist/tesseract.min.js", worker: CDN + "tesseract.js@" + V + "/dist/worker.min.js", core: CDN + "tesseract.js-core@" + V + "/", lang: CDN + "@tesseract.js-data/eng@1.0.0/4.0.0_best_int" };
  const RATIO = 488 / 680;
  let workers = null, stream = null, running = false, busy = false;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.Tesseract) return res();
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't download the text-recognition library (needs internet the first time)."));
      document.head.appendChild(s);
    });
  }
  async function init(onStatus) {
    if (workers) return workers;
    onStatus && onStatus("Loading text recognition (first time only)…");
    await loadScript(CFG.script);
    const opts = { workerPath: CFG.worker, corePath: CFG.core, langPath: CFG.lang };
    const mk = async (params) => { const w = await window.Tesseract.createWorker("eng", 1, opts); await w.setParameters(params); return w; };
    workers = {
      title: await mk({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,'- " }),
      bottom: await mk({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•·.-*★ " }),
    };
    return workers;
  }
  // Cut a region (fractions of the card) out of the card rectangle, scale up, grayscale, stretch contrast, make text dark on light.
  function strip(src, card, x0, y0, x1, y1, outW) {
    const sx = card.x + card.w * x0, sy = card.y + card.h * y0, sw = card.w * (x1 - x0), sh = card.h * (y1 - y0);
    const sc = Math.max(1, outW / sw), c = document.createElement("canvas"); c.width = Math.round(sw * sc); c.height = Math.round(sh * sc);
    const g = c.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high"; g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data; let lo = 255, hi = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; d[i] = l; if (l < lo) lo = l; if (l > hi) hi = l; sum += l; }
    const mean = sum / (d.length / 4), inv = mean < 128, span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { let l = ((d[i] - lo) / span) * 255; if (inv) l = 255 - l; d[i] = d[i + 1] = d[i + 2] = l; d[i + 3] = 255; }
    g.putImageData(im, 0, 0); return c;
  }
  // Where the card sits in the frame: centred, ~72% of the frame height (or 92% of its width), card-shaped.
  function cardRect(w, h) {
    let ch = h * 0.72, cw = ch * RATIO;
    if (cw > w * 0.92) { cw = w * 0.92; ch = cw / RATIO; }
    return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch, fx: (w - cw) / 2 / w, fy: (h - ch) / 2 / h, fw: cw / w, fh: ch / h };
  }
  // Bottom-left small print first (it identifies the exact printing); the title is only read when that wasn't enough.
  async function readFrame(src, w, h, enough) {
    const card = cardRect(w, h), ws = await init();
    const out = { title: "", bottom: "" };
    out.bottom = (await ws.bottom.recognize(strip(src, card, 0.03, 0.915, 0.60, 0.985, 900))).data.text;
    if (!enough || !enough(out.bottom)) out.title = (await ws.title.recognize(strip(src, card, 0.05, 0.035, 0.80, 0.105, 700))).data.text;
    return out;
  }
  async function start(video, onStatus) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser can't open the camera here.");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    video.srcObject = stream; video.setAttribute("playsinline", ""); video.muted = true; await video.play();
    await init(onStatus);
  }
  // Calls onRead({title,bottom}) about every 600ms while running (one read at a time).
  function loop(video, onRead, enough) {
    running = true;
    const tick = async () => {
      if (!running) return;
      if (!busy && video.videoWidth) { busy = true; try { const rr = await readFrame(video, video.videoWidth, video.videoHeight, enough); window.__lastRead = { rr, w: video.videoWidth, h: video.videoHeight }; onRead(rr); } catch (e) { /* skip frame */ } busy = false; }
      if (running) setTimeout(tick, 250);
    };
    tick();
  }
  function stop() { running = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
  window.MTGScan = { start, loop, stop, readFrame, cardRect, init, RATIO };
})();
