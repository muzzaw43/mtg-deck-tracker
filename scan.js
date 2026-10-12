/* Camera + text recognition for checking a physical deck. Loads the OCR library only when the scanner is opened. */
(function () {
  "use strict";
  const V = "5.1.1", CDN = "https://cdn.jsdelivr.net/npm/";
  const CVURL = CDN + "@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
  const CFG = { script: CDN + "tesseract.js@" + V + "/dist/tesseract.min.js", worker: CDN + "tesseract.js@" + V + "/dist/worker.min.js", core: CDN + "tesseract.js-core@" + V + "/", lang: CDN + "@tesseract.js-data/eng@1.0.0/4.0.0_best_int" };
  const RATIO = 488 / 680;
  let cvOK = false, cvTry = null, flip = false, misses = 0, workers = null, stream = null, running = false, busy = false;

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
    onStatus && onStatus("Loading card detection (first time only, a few MB)…");
    await loadCV();
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

  // Card outline finder (OpenCV): finds the card's four corners in the frame and flattens it, so the card doesn't have to sit exactly in the guide.
  function loadCV() {
    if (cvTry) return cvTry;
    cvTry = new Promise((res) => {
      const fin = (ok) => { cvOK = ok && !!(window.cv && window.cv.Mat); res(cvOK); };
      if (window.cv && window.cv.Mat) return fin(true);
      const t = setTimeout(() => fin(false), 45000);
      const s = document.createElement("script"); s.src = CVURL;
      s.onerror = () => { clearTimeout(t); fin(false); };
      s.onload = () => {
        const chk = () => { if (window.cv && window.cv.Mat) { clearTimeout(t); fin(true); return true; } return false; };
        if (chk()) return;
        if (window.cv && typeof window.cv === "object") window.cv.onRuntimeInitialized = () => chk();
        const iv = setInterval(() => { if (chk()) clearInterval(iv); }, 200);
      };
      document.head.appendChild(s);
    });
    return cvTry;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function order(p) { // -> tl, tr, br, bl
    const bySum = p.slice().sort((a, b) => a.x + a.y - (b.x + b.y)), byDiff = p.slice().sort((a, b) => a.y - a.x - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }
  function findQuad(src, sw, sh) {
    const cv = window.cv, W = 360, k = W / sw, H = Math.round(sh * k), c = document.createElement("canvas"); c.width = W; c.height = H;
    c.getContext("2d").drawImage(src, 0, 0, W, H);
    const m = cv.imread(c), g = new cv.Mat(), ker = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    let best = null, bestA = 0;
    const tryEdges = (e) => {
      const hi = new cv.Mat(), cs = new cv.MatVector();
      try {
        cv.findContours(e, cs, hi, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < cs.size(); i++) {
          const cn = cs.get(i), a = cv.contourArea(cn);
          if (a > W * H * 0.08 && a < W * H * 0.97 && a > bestA) {
            const hull = new cv.Mat(); cv.convexHull(cn, hull, false, true);
            const per = cv.arcLength(hull, true), ha = cv.contourArea(hull);
            for (const eps of [0.015, 0.025, 0.04, 0.06]) {
              const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * per, true);
              if (ap.rows === 4) {
                const raw = [0, 1, 2, 3].map((j) => ({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] })), pts = order(raw.map((p) => ({ x: p.x / k, y: p.y / k })));
                const w1 = dist(pts[0], pts[1]), w2 = dist(pts[3], pts[2]), h1 = dist(pts[0], pts[3]), h2 = dist(pts[1], pts[2]);
                const w = (w1 + w2) / 2, h = (h1 + h2) / 2, r = Math.min(w, h) / Math.max(w, h);
                const sane = Math.max(w1, w2) / Math.min(w1, w2) < 1.7 && Math.max(h1, h2) / Math.min(h1, h2) < 1.7;
                const edge = raw.some((p) => p.x <= 2 || p.y <= 2 || p.x >= W - 3 || p.y >= H - 3);
                if (r > 0.45 && r < 0.95 && sane && !edge && a / ha > 0.8) { best = { pts, landscape: w > h }; bestA = a; ap.delete(); break; }
              }
              ap.delete();
            }
            hull.delete();
          }
          cn.delete();
        }
      } finally { hi.delete(); cs.delete(); }
    };
    try {
      cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(g, g, new cv.Size(5, 5), 0);
      for (const [lo, hiT] of [[30, 90], [60, 160], [15, 50]]) {
        const e = new cv.Mat(); cv.Canny(g, e, lo, hiT); cv.dilate(e, e, ker, new cv.Point(-1, -1), 2); cv.erode(e, e, ker, new cv.Point(-1, -1), 1);
        tryEdges(e); e.delete();
        if (best) break;
      }
      // Dark sleeves / dark cards: no clear edge, so try the whole card as a light-or-dark blob against its surroundings.
      if (!best) {
        const big = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        for (const inv of [false, true]) {
          const t = new cv.Mat(); cv.threshold(g, t, 0, 255, (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) | cv.THRESH_OTSU);
          cv.morphologyEx(t, t, cv.MORPH_CLOSE, big, new cv.Point(-1, -1), 2); cv.morphologyEx(t, t, cv.MORPH_OPEN, big, new cv.Point(-1, -1), 2);
          tryEdges(t); t.delete();
          if (best) break;
        }
        big.delete();
      }
    } finally { m.delete(); g.delete(); ker.delete(); }
    return best;
  }
  const OW = 720, OH = 1004;
  function warp(src, q) {
    const cv = window.cv; let p = q.pts;
    if (q.landscape) p = [p[1], p[2], p[3], p[0]]; // turn a sideways card upright
    if (flip) p = [p[2], p[3], p[0], p[1]];       // and the other way up when text isn't being read
    const inC = document.createElement("canvas"); inC.width = src.videoWidth || src.width; inC.height = src.videoHeight || src.height; inC.getContext("2d").drawImage(src, 0, 0);
    const m = cv.imread(inC), out = new cv.Mat();
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, [p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y]);
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, OW, 0, OW, OH, 0, OH]);
    const M = cv.getPerspectiveTransform(a, b);
    cv.warpPerspective(m, out, M, new cv.Size(OW, OH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const oc = document.createElement("canvas"); oc.width = OW; oc.height = OH; cv.imshow(oc, out);
    m.delete(); out.delete(); a.delete(); b.delete(); M.delete();
    return oc;
  }

  /* ---- Image matching (like ManaBox): compare the straightened card with the deck's own card pictures ---- */
  const DW = 48, DH = 67, refs = new Map(); // id -> Float32Array (normalised greyscale of the card face)
  let refState = { total: 0, done: 0, failed: 0, busy: false, blocked: false };
  function desc(src, flipped) {
    const w = src.width || src.videoWidth, h = src.height || src.videoHeight;
    const mid = document.createElement("canvas"); mid.width = DW * 2; mid.height = DH * 2;
    const g1 = mid.getContext("2d"); g1.imageSmoothingQuality = "high";
    g1.drawImage(src, w * 0.05, h * 0.035, w * 0.90, h * 0.93, 0, 0, mid.width, mid.height); // drop the rounded corners and border edge
    const c = document.createElement("canvas"); c.width = DW; c.height = DH;
    const g = c.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high"; g.drawImage(mid, 0, 0, DW, DH);
    const d = g.getImageData(0, 0, DW, DH).data, n = DW * DH, o = new Float32Array(n);
    let m = 0; for (let i = 0; i < n; i++) { o[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; m += o[i]; }
    m /= n; let v = 0; for (let i = 0; i < n; i++) { o[i] -= m; v += o[i] * o[i]; }
    v = Math.sqrt(v) || 1; for (let i = 0; i < n; i++) o[i] /= v;
    if (flipped) o.reverse();
    return o;
  }
  const ncc = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i] * b[i]; return t; };
  function loadImg(url) {
    return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error("img")); im.src = url; });
  }
  // items: [{id, url}]. Loads in the background; matching works with whatever has loaded so far.
  async function setRefs(items, onProg) {
    const todo = items.filter((x) => x.url && !refs.has(x.id));
    refState = { total: items.length, done: items.length - todo.length, failed: 0, busy: true, blocked: false };
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const it = todo[i++];
        try { const im = await loadImg(it.url); refs.set(it.id, desc(im, false)); }
        catch (e) { refState.failed++; if (e && e.name === "SecurityError") refState.blocked = true; }
        refState.done++; onProg && onProg(refState);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    refState.busy = false; onProg && onProg(refState);
  }
  // Recognise the card (by name), not the printing: printings of one card often look alike, so score each card by its best printing.
  function visualMatch(canvas, cands) {
    if (!refs.size) return null;
    const a = desc(canvas, false), b = desc(canvas, true), byKey = new Map();
    for (const c of cands) {
      const r = refs.get(c.id); if (!r) continue;
      const s1 = ncc(a, r), s2 = ncc(b, r), sc = Math.max(s1, s2), g = byKey.get(c.key) || { key: c.key, score: -1, id: "", flipped: false, scores: {} };
      g.scores[c.id] = sc; if (sc > g.score) { g.score = sc; g.id = c.id; g.flipped = s2 > s1; } byKey.set(c.key, g);
    }
    const all = [...byKey.values()].sort((x, y) => y.score - x.score), best = all[0];
    if (!best) return null;
    best.margin = best.score - (all[1] ? Math.max(all[1].score, 0) : 0);
    best.ok = best.score >= 0.5 && best.margin >= 0.08;
    return best;
  }
  // Where the card sits in the frame: centred, ~72% of the frame height (or 92% of its width), card-shaped.
  function cardRect(w, h) {
    let ch = h * 0.72, cw = ch * RATIO;
    if (cw > w * 0.92) { cw = w * 0.92; ch = cw / RATIO; }
    return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch, fx: (w - cw) / 2 / w, fy: (h - ch) / 2 / h, fw: cw / w, fh: ch / h };
  }
  // Bottom-left small print first (it identifies the exact printing); the title is only read when that wasn't enough.
  let lastCanvas = null, candIds = null, skipText = null; // candidates worth matching (the deck's list); skipText(visual) says when no text needs reading
  async function readFrame(src, w, h, enough) {
    const ws = await init();
    let card = cardRect(w, h), img = src, found = false, quad = null;
    if (cvOK) { try { const q = findQuad(src, w, h); if (q) { img = warp(src, q); card = { x: 0, y: 0, w: OW, h: OH }; found = true; quad = q.pts; } } catch (e) { /* use the guide frame */ } }
    const out = { title: "", bottom: "", found, quad, visual: null };
    if (candIds && refs.size) {
      try {
        if (found) { // the outline may be the sleeve rather than the card: try the whole thing and a version trimmed inwards
          for (const mg of [0, 0.045]) {
            const c2 = document.createElement("canvas"); c2.width = 240; c2.height = Math.round(240 / RATIO);
            c2.getContext("2d").drawImage(img, OW * mg, OH * mg, OW * (1 - 2 * mg), OH * (1 - 2 * mg), 0, 0, c2.width, c2.height);
            const v = visualMatch(c2, candIds);
            if (v && (!out.visual || v.score > out.visual.score)) { out.visual = v; lastCanvas = c2; if (mg) card = { x: OW * mg, y: OH * mg, w: OW * (1 - 2 * mg), h: OH * (1 - 2 * mg) }; else card = { x: 0, y: 0, w: OW, h: OH }; }
          }
        }
        if (!out.visual || !out.visual.ok) { // no outline, or it didn't look like a deck card: try the guide frame a little bigger, smaller and shifted
          const g0 = cardRect(w, h), vc = document.createElement("canvas"), g2 = vc.getContext("2d"); vc.width = 160; vc.height = Math.round(160 / RATIO);
          let bestG = null;
          for (const sc of [0.88, 1, 1.12]) for (const dy of [-0.05, 0, 0.05]) for (const dx of [-0.05, 0, 0.05]) {
            const cw = g0.w * sc, ch = g0.h * sc, cx = g0.x + g0.w / 2 + dx * g0.w - cw / 2, cy = g0.y + g0.h / 2 + dy * g0.h - ch / 2;
            g2.drawImage(src, cx, cy, cw, ch, 0, 0, vc.width, vc.height);
            const v = visualMatch(vc, candIds);
            if (v && (!bestG || v.score > bestG.v.score)) bestG = { v, rect: { x: cx, y: cy, w: cw, h: ch }, canvas: sc === 1 && dx === 0 && dy === 0 ? (() => { const k = document.createElement("canvas"); k.width = vc.width; k.height = vc.height; k.getContext("2d").drawImage(vc, 0, 0); return k; })() : null };
          }
          if (bestG && (!out.visual || bestG.v.score > out.visual.score)) { out.visual = bestG.v; img = src; card = bestG.rect; if (bestG.canvas) lastCanvas = bestG.canvas; }
        }
      } catch (e) { /* ignore */ }
      if (!found && (!lastCanvas || !(out.visual && out.visual.ok))) { const k = document.createElement("canvas"), g0 = cardRect(w, h); k.width = 160; k.height = Math.round(160 / RATIO); k.getContext("2d").drawImage(src, g0.x, g0.y, g0.w, g0.h, 0, 0, k.width, k.height); lastCanvas = k; }
      if (out.visual && out.visual.ok && skipText && skipText(out.visual)) return out; // recognised by its picture: no text needed
    }
    out.bottom = (await ws.bottom.recognize(strip(img, card, 0.03, 0.915, 0.60, 0.985, 900))).data.text;
    // Older / retro frames have no set code at bottom-left: the number sits at the end of the copyright line, toward the right.
    try { const pc = window.MTG && window.MTG.parseCollector(out.bottom); if (!pc || !pc.set) out.bottom += "\n" + (await ws.bottom.recognize(strip(img, card, 0.30, 0.915, 0.97, 0.985, 1000))).data.text; } catch (e) { /* ignore */ }
    // A middling picture match can be a look-alike: read the name too so it can be overruled.
    if (out.visual && out.visual.ok && out.visual.score < 0.8) { out.title = (await ws.title.recognize(strip(img, card, 0.05, 0.035, 0.80, 0.105, 700))).data.text; return out; }
    if (out.visual && out.visual.ok) return out;
    if (!enough || !enough(out.bottom)) out.title = (await ws.title.recognize(strip(img, card, 0.05, 0.035, 0.80, 0.105, 700))).data.text;
    return out;
  }
  async function start(video, onStatus) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser can't open the camera here.");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
    video.srcObject = stream; video.setAttribute("playsinline", ""); video.muted = true; await video.play();
    await init(onStatus);
  }
  // Calls onRead({title,bottom}) about every 600ms while running (one read at a time).
  function loop(video, onRead, enough) {
    running = true;
    const tick = async () => {
      if (!running) return;
      if (!busy && video.videoWidth) { busy = true; try { const rr = await readFrame(video, video.videoWidth, video.videoHeight, enough); window.__lastRead = { rr, w: video.videoWidth, h: video.videoHeight }; const ok = onRead(rr); if (rr.found) { if (ok) misses = 0; else if (++misses >= 4) { flip = !flip; misses = 0; } } else misses = 0; } catch (e) { /* skip frame */ } busy = false; }
      if (running) setTimeout(tick, 250);
    };
    tick();
  }
  function stop() { running = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
  function learn(id, key) {
    if (!lastCanvas) return false;
    refs.set(id, desc(lastCanvas, false));
    if (candIds) candIds.push({ id, key });
    return true;
  }
  window.MTGScan = { learn, setRefs, setCandidates: (c, sk) => { candIds = c; skipText = sk || null; }, refState: () => refState, start, loop, stop, readFrame, cardRect, init, RATIO };
})();
