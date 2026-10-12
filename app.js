/* MTG Deck Tracker – UI. Reads a private GitHub data repo with a read-only token; swap buttons save with an optional write token. */
(function () {
  "use strict";
  const M = window.MTG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = {
    tab: "decks", deck: null, token: "", cfg: { ...M.DEFAULT_CONFIG },
    idx: null, rows: [], csvName: "", own: new Map(), decks: [], claims: { hard: new Map(), soft: new Map() },
    wtoken: "", who: "", statsOpen: false, statsMode: "swaps", statsRole: "", dview: "stacks", zoom: null, rul: {}, col: { view: "binders", layout: "grid", q: "", colors: new Set(), cmode: "any", ci: new Set(), ciDeck: "", mv: new Set(), types: new Set(), rarity: new Set(), set: "", binder: "", foil: "", sort: "name", dir: 1, limit: 120, open: false }, saving: "", log: [], wl: [], wlEval: [], checks: [], level: "all", reserve: 0, reserveBy: { common: 0, uncommon: 0, rare: 0, mythic: 0 }, minPrice: 0, flagPrice: 0, showCommitted: false, picked: null, out: null, error: "", busy: "", dbCount: 0,
  };
  try { S.token = localStorage.getItem("mtg_token") || ""; S.wtoken = localStorage.getItem("mtg_wtoken") || ""; S.who = localStorage.getItem("mtg_who") || ""; S.dview = localStorage.getItem("mtg_dview") || "stacks"; S.reviewer = localStorage.getItem("mtg_reviewer") === "1"; } catch (e) { /* storage blocked */ }

  /* ---------- phone back button: closes pop-ups, then leaves the deck ---------- */
  S.nav = []; S.ignorePop = 0;
  async function forceRefresh() {
    const files = ["./", "index.html", "style.css", "app.js", "scan.js", "logic.js", "site-config.js", "manifest.json"];
    try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); } catch (e) { /* no SW */ }
    try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch (e) { /* no cache API */ }
    try { await Promise.all(files.map((f) => fetch(f, { cache: "reload" }))); } catch (e) { /* offline */ }
    location.reload();
  }
  function pushNav(t) { try { history.pushState({ t }, ""); S.nav.push(t); } catch (e) { /* ignore */ } }
  function popNav(t) {
    if (S.nav[S.nav.length - 1] !== t) return;
    S.nav.pop(); S.ignorePop++;
    try { history.back(); } catch (e) { S.ignorePop--; }
  }
  function resetNav() {
    const n = S.nav.length; if (!n) return;
    S.nav = []; S.ignorePop++;
    try { history.go(-n); } catch (e) { S.ignorePop--; }
  }
  const openModalNav = () => { if (!S.zoom && !S.ch) pushNav("modal"); };
  // Exit guard: history is [root][guard]; Back from the guard lands on root, where we ask before leaving.
  // Chrome skips history entries a page adds before the user has touched it, which made Back leave the app without asking.
  // So the guard entry is added on the first tap or key press instead of at load.
  try {
    const st = history.state || {};
    if (!st.guard) {
      if (!st.root) history.replaceState({ root: 1 }, "");
      const arm = () => {
        window.removeEventListener("pointerdown", arm, true); window.removeEventListener("keydown", arm, true); window.removeEventListener("touchend", arm, true); window.removeEventListener("click", arm, true);
        try { if (!(history.state || {}).guard && !S.nav.length) history.pushState({ guard: 1 }, ""); else if (!(history.state || {}).guard) S.needGuard = true; } catch (e) { /* ignore */ }
      };
      window.addEventListener("pointerdown", arm, true); window.addEventListener("keydown", arm, true); window.addEventListener("touchend", arm, true); window.addEventListener("click", arm, true);
    }
  } catch (e) { /* ignore */ }
  let exitBox = null;
  function exitAsk() {
    exitBox = document.createElement("div"); exitBox.id = "exitbox";
    exitBox.innerHTML = '<div class="exitcard"><b>Close the app?</b><div class="row"><button class="btn" data-x="stay">Stay</button><button class="btn alt" data-x="leave">Close</button></div></div>';
    exitBox.addEventListener("click", (ev) => {
      const x = ev.target.closest("[data-x]"); const b = exitBox; exitBox = null; if (b) b.remove();
      if (x && x.dataset.x === "leave") { S.leaving = true; try { history.go(-2); } catch (e) { /* ignore */ } }
    });
    document.body.appendChild(exitBox);
    setTimeout(() => { if (exitBox) { exitBox.remove(); exitBox = null; } }, 6000);
  }
  window.addEventListener("popstate", () => {
    if (S.ignorePop > 0) { S.ignorePop--; return; }
    const st = history.state || {};
    if (st.root && !S.nav.length) {
      // Some browsers (Firefox on Android) don't show confirm() from here, so ask with our own box. A second Back also leaves.
      if (exitBox) { S.leaving = true; try { history.back(); } catch (e) { /* ignore */ } return; }
      exitAsk();
      try { history.pushState({ guard: 1 }, ""); } catch (e) { /* ignore */ }
      return;
    }
    const t = S.nav.pop();
    if (t === "modal") { S.zoom = null; S.ch = null; }
    else if (t === "deck") S.deck = null;
    else if (t === "tick") { S.tk = null; }
    if (t === "modal" && scanEl) scanStop();
    render();
  });

  /* ---------- GitHub ---------- */
  async function gh(path, raw) {
    const url = `https://api.github.com/repos/${S.cfg.owner}/${S.cfg.dataRepo}/contents/${path}?ref=${encodeURIComponent(S.cfg.branch)}`;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + S.token, Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json" } });
    if (r.status === 401) { const e = new Error("Token rejected — it may have expired or been revoked. Make a new read-only token and paste it in Data."); e.code = 401; throw e; }
    if (r.status === 403) { const e = new Error("GitHub refused the request (403) — token lacks Contents: read, or you're rate limited."); e.code = 403; throw e; }
    if (r.status === 404) { const e = new Error("Not found: " + path + " (or the token can't see the repo)"); e.code = 404; throw e; }
    if (!r.ok) throw new Error("GitHub error " + r.status);
    return raw ? r.text() : r.json();
  }
  async function ghList(path) {
    try { return await gh(path, false); } catch (e) { if (e.code === 404) return []; throw e; }
  }

  async function loadDB() {
    S.busy = "Loading card DB…"; status();
    const r = await fetch(S.cfg.dbUrl);
    if (!r.ok) throw new Error("Card DB failed to load (" + r.status + ")");
    const db = await r.json();
    S.idx = M.buildIndex(db);
    S.dbCount = Object.keys(db).length;
  }

  async function loadAll() {
    S.error = ""; S.busy = "Loading…"; status(); render();
    try {
      if (!S.token) throw new Error("Paste your read-only GitHub token in Data to load your private decks and collection.");
      S.log = [];
      const rr = await fetch(`https://api.github.com/repos/${S.cfg.owner}/${S.cfg.dataRepo}`, { headers: { Authorization: "Bearer " + S.token, Accept: "application/vnd.github+json" } });
      if (rr.status === 401) throw new Error("GitHub rejected the token (401) — it may be mistyped, expired or revoked. Make a new one and paste it in Data.");
      if (rr.status === 404) throw new Error(`This token can't see ${S.cfg.owner}/${S.cfg.dataRepo}. When creating the token, under Repository access choose Only select repositories and tick ${S.cfg.dataRepo}; set Contents to Read-only.`);
      if (!rr.ok) throw new Error("GitHub error " + rr.status + " while checking the repo.");
      S.log.push("Repo reachable: " + S.cfg.owner + "/" + S.cfg.dataRepo);
      try { S.cfg = { ...M.DEFAULT_CONFIG, ...JSON.parse(await gh("config.json", true)) }; }
      catch (e) { if (e.code === 401 || e.code === 403) throw e; }
      const dbP = loadDB();
      const deckFiles = (await ghList("decks")).filter((f) => f.type === "file" && /\.json$/i.test(f.name) && !f.name.startsWith("_"));
      S.decks = await Promise.all(deckFiles.map(async (f) => {
        const d = JSON.parse(await gh("decks/" + f.name, true));
        d.slug = f.name.replace(/\.json$/i, "");
        d._sha = f.sha; d._orig = JSON.parse(JSON.stringify(d.pencilled || []));
        return d;
      }));
      try { S.wl = JSON.parse(await gh("wishlist.json", true)); } catch (e) { if (e.code === 401 || e.code === 403) throw e; S.wl = []; }
      const csvs = (await ghList("collection")).filter((f) => f.type === "file" && /\.csv$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      let text = "", name = "";
      if (csvs.length) { const fixed = csvs.find((f) => f.name === "ManaBox_Collection.csv"); name = (fixed || csvs[csvs.length - 1]).name; text = await gh("collection/" + name, true); }
      await dbP;
      if (text) { S.rows = M.parseCollection(text); S.csvName = name; }
      if (text) { try { const cr = await fetch(`https://api.github.com/repos/${S.cfg.owner}/${S.cfg.dataRepo}/commits?path=${encodeURIComponent("collection/" + name)}&per_page=1&sha=${encodeURIComponent(S.cfg.branch)}`, { headers: { Authorization: "Bearer " + S.token, Accept: "application/vnd.github+json" } }); const cj = cr.ok ? await cr.json() : null; S.csvAt = Array.isArray(cj) && cj[0] ? cj[0].commit.committer.date : ""; } catch (e) { S.csvAt = ""; } }
      S.log.push(`Decks found: ${S.decks.length}` + (deckFiles.length ? "" : " (no .json files in decks/)"));
      S.log.push(text ? `Collection: ${name} (${S.rows.length} rows)` : "Collection: no .csv found in collection/");
      S.log.push(`Card DB: ${S.dbCount} cards`);
      if (S.decks.length && S.tab === "data") S.tab = "decks";
    } catch (e) { S.error = e.message; }
    S.busy = ""; try { recompute(); } catch (e) { S.error = "Loaded, but processing failed: " + e.message; } status(); render();
    if (S.rows.length) setTimeout(loadLivePrices, 800);
  }

  /* ---------- saving (needs a write token) ---------- */
  const b64 = (str) => { const by = new TextEncoder().encode(str); let bin = ""; by.forEach((c) => { bin += String.fromCharCode(c); }); return btoa(bin); };
  // Live market prices (Scryfall, USD) converted to AUD. Loads quietly in the background and is cached for a day; until then ManaBox's own prices show.
  async function loadLivePrices() {
    try {
      const sids = [...new Set(S.rows.map((r) => r.sid).filter(Boolean))];
      if (!sids.length) return;
      let c = null; try { c = JSON.parse(localStorage.getItem("mtg_px") || "null"); } catch (e) {}
      const fresh = c && Date.now() - c.t < 864e5;
      if (c && c.p) { M.setLive({ rate: c.rate, p: c.p }); S.live = { at: c.t, partial: !fresh }; if (S.tab !== "data" && !document.activeElement.matches("input,textarea,select")) render(); }
      if (fresh && sids.every((x) => c.p[x])) return;
      let rate = c && c.rate || 1.5;
      try { const fr = await fetch("https://api.frankfurter.app/latest?from=USD&to=AUD"); if (fr.ok) { const j = await fr.json(); if (j.rates && j.rates.AUD) rate = j.rates.AUD; } } catch (e) {}
      const p = Object.assign({}, c && c.p), need = sids.filter((x) => !(fresh && p[x]));
      for (let i = 0; i < need.length; i += 75) {
        const r = await fetch("https://api.scryfall.com/cards/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifiers: need.slice(i, i + 75).map((id) => ({ id })) }) });
        if (!r.ok) break;
        for (const cd of (await r.json()).data || []) { const q = cd.prices || {}, f = (x) => (x == null ? null : parseFloat(x)); p[cd.id] = [f(q.usd), f(q.usd_foil), f(q.usd_etched)]; }
        await new Promise((res) => setTimeout(res, 120));
      }
      try { localStorage.setItem("mtg_px", JSON.stringify({ t: Date.now(), rate, p })); } catch (e) {}
      M.setLive({ rate, p }); S.live = { at: Date.now(), rate };
      if (!document.querySelector(".modal") && S.tab !== "data" && !document.activeElement.matches("input,textarea,select")) render();
    } catch (e) { /* stay on ManaBox prices */ }
  }
  async function addToWishlist(name, slug, note) {
    if (!S.wtoken) throw new Error("Saving needs a write token — add it in Data.");
    const url = `https://api.github.com/repos/${S.cfg.owner}/${S.cfg.dataRepo}/contents/wishlist.json`, hd = { Authorization: "Bearer " + S.wtoken, Accept: "application/vnd.github+json" };
    const cur = await fetch(url + "?ref=" + encodeURIComponent(S.cfg.branch), { headers: hd });
    let list = [], sha;
    if (cur.ok) { const j = await cur.json(); sha = j.sha; list = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)))); }
    else if (cur.status !== 404) throw new Error("Couldn't read the wishlist (" + cur.status + ").");
    const hit = list.find((w) => norm(w.name) === norm(name));
    if (hit) { hit.decks = hit.decks || []; if (slug && !hit.decks.includes(slug)) hit.decks.push(slug); }
    else list.push({ name, decks: slug ? [slug] : [], kind: "want", note: note || "" });
    const r = await fetch(url, { method: "PUT", headers: hd, body: JSON.stringify({ message: `Wishlist: ${name}${S.who ? " [" + S.who + "]" : ""}`, content: b64(JSON.stringify(list, null, 1) + "\n"), sha, branch: S.cfg.branch }) });
    if (!r.ok) throw new Error("Wishlist save failed: GitHub " + r.status);
    S.wl = list;
  }
  async function saveDeck(d, message) {
    if (!S.wtoken) throw new Error("Saving needs a write token — add it in Data (Contents: read and write, only " + S.cfg.dataRepo + ").");
    const body = { ...d }; delete body.slug; delete body._sha; delete body._orig; delete body._mb;
    body.updated = new Date().toISOString().slice(0, 10);
    const url = `https://api.github.com/repos/${S.cfg.owner}/${S.cfg.dataRepo}/contents/decks/${d.slug}.json`;
    const put = (sha) => fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + S.wtoken, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, content: b64(JSON.stringify(body, null, 2) + "\n"), sha, branch: S.cfg.branch }) });
    let r = await put(d._sha);
    if (r.status === 409 || r.status === 422) {
      const cur = await fetch(url + "?ref=" + encodeURIComponent(S.cfg.branch), { headers: { Authorization: "Bearer " + S.wtoken, Accept: "application/vnd.github+json" } });
      if (!cur.ok) throw new Error("Save conflict and could not re-read the file (" + cur.status + ").");
      const j = await cur.json();
      const theirs = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))));
      if (JSON.stringify(theirs.pencilled || []) !== JSON.stringify(d._orig || [])) throw new Error("This deck was changed elsewhere since you loaded it. Reload (Data → Save & load) and redo the change.");
      r = await put(j.sha);
    }
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("GitHub refused the save (" + r.status + ") — the write token needs Contents: read and write on " + S.cfg.dataRepo + ".");
    if (!r.ok) throw new Error("Save failed: GitHub " + r.status);
    const j = await r.json();
    d._sha = j.content.sha; d.updated = body.updated; d._orig = JSON.parse(JSON.stringify(d.pencilled || []));
  }
  const CSV_PATH = "collection/ManaBox_Collection.csv";
  async function uploadCollection(file) {
    S.error = ""; S.saving = "Reading CSV…"; render();
    try {
      if (!S.wtoken) throw new Error("Uploading needs the write token — add it above.");
      if (!S.idx) await loadDB();
      const text = await file.text();
      const head = text.split(/\r?\n/, 1)[0] || "";
      for (const col of ["Binder Name", "Name", "Scryfall ID", "Quantity"]) if (!head.includes(col)) throw new Error(`That doesn't look like a ManaBox collection export (no "${col}" column). Nothing uploaded.`);
      const rows = M.parseCollection(text);
      if (!rows.length) throw new Error("The CSV has no cards. Nothing uploaded.");
      const oldN = S.rows.length;
      if (oldN && rows.length < oldN * 0.8 && !confirm(`The new file has ${rows.length} rows but the current one has ${oldN}. Upload anyway?`)) { S.saving = ""; render(); return; }
      const base = `https://api.github.com/repos/${S.cfg.owner}/${S.cfg.dataRepo}/contents/`;
      const H = { Authorization: "Bearer " + S.wtoken, Accept: "application/vnd.github+json" };
      S.saving = "Uploading…"; render();
      const lr = await fetch(base + "collection?ref=" + encodeURIComponent(S.cfg.branch), { headers: H });
      if (lr.status === 401 || lr.status === 403 || lr.status === 404) throw new Error("GitHub refused (" + lr.status + ") — the write token needs Contents: read and write on " + S.cfg.dataRepo + ".");
      const files = lr.ok ? await lr.json() : [];
      const ex = files.find((f) => f.name === "ManaBox_Collection.csv");
      const pr = await fetch(base + CSV_PATH, { method: "PUT", headers: H, body: JSON.stringify({
        message: `Collection update: ${file.name} (${rows.length} rows)${S.who ? " [" + S.who + "]" : ""}`, content: b64(text), sha: ex ? ex.sha : undefined, branch: S.cfg.branch }) });
      if (!pr.ok) throw new Error("Upload failed: GitHub " + pr.status);
      S.rows = rows; S.csvName = "ManaBox_Collection.csv"; S.csvAt = new Date().toISOString();
      S.log.push(`Uploaded ${file.name}: ${rows.length} rows (was ${oldN})`);
      S.saving = ""; recompute(); S.tab = "data"; S.deck = null; resetNav();
    } catch (e) { S.error = e.message; S.saving = ""; }
    status(); render();
  }
  const LEGACY = { "Approved": "pencilled", "Made by hand": "pencilled", "Done in ManaBox": "made", "Cancelled": "pencilled", "Back to pencilled": "made" };
  const prevOf = (e) => (e.prev !== undefined ? e.prev : LEGACY[e.act]);
  const lastUndo = (p) => { const l = p.log || []; for (let k = l.length - 1; k >= 0; k--) if (prevOf(l[k]) !== undefined) return k; return -1; };
  const SW_TEXT = {
    approve: "Approve this swap? (Still just an idea — nothing changes in ManaBox.)",
    made: "Mark as MADE BY HAND? You swapped the physical cards. ManaBox is not updated yet, so it'll show as a to-do.",
    done: "Mark as DONE? Only do this once ManaBox itself shows the change. The next collection upload is checked against it.",
    cancel: "Cancel this swap? It moves to the change history, where you can undo it.",
    undo: "Undo the last change to this swap?",
  };
  function reconcile() {
    const r = { confirmed: [], missing: [], ready: [], looks: [], todo: [] };
    if (!S.idx || !S.rows.length) return r;
    for (const d of S.decks) {
      if (M.norm(d.status) !== "built") continue;
      const m = M.deckMap(d, S.idx);
      (d.pencilled || []).forEach((p, i) => {
        const st = M.pencilStatus(p);
        if (st === "dropped" || !(p.out || p.in)) return;
        const shown = M.swapShown(d, p, S.idx, m), it = { d, p, i, text: `${d.name}: ${p.out || "—"} → ${p.in || "—"}` };
        if (st === "done") (shown ? r.confirmed : r.missing).push(it);
        else if (st === "made") (shown ? r.ready : r.todo).push(it);
        else if (shown && p.out && p.in) r.looks.push(it);
      });
    }
    return r;
  }
  async function bulkDone() {
    const rc = reconcile();
    if (!rc.ready.length || !S.wtoken) return;
    if (!confirm(`ManaBox now shows ${rc.ready.length} swaps you made by hand. Mark them all done?\n\n` + rc.ready.map((x) => x.text).join("\n"))) return;
    const at = new Date().toISOString().slice(0, 10), by = S.who || "me";
    S.error = ""; S.saving = "Saving…"; render();
    try {
      for (const d of new Set(rc.ready.map((x) => x.d))) {
        const keep = JSON.stringify(d.pencilled);
        for (const x of rc.ready.filter((y) => y.d === d)) { x.p.log = (x.p.log || []).concat({ at, by, act: "Marked done", prev: "made" }); x.p.status = "done"; }
        try { await saveDeck(d, `Swaps (${d.name}): marked done after collection update${S.who ? " [" + S.who + "]" : ""}`); }
        catch (e) { d.pencilled = JSON.parse(keep); throw e; }
      }
      recompute();
    } catch (e) { S.error = e.message; recompute(); }
    S.saving = ""; status(); render();
  }
  function reconCard() {
    if (!S.decks.length || !S.rows.length) return "";
    const rc = reconcile();
    const list = (a) => `<div class="muted">${a.map((x) => esc(x.text)).join("<br>")}</div>`;
    let h = `<h2>Swaps vs collection CSV</h2><div class="card"><div class="muted">${esc(S.csvName)} checked against every swap in your decks.</div>`;
    h += `<div>${rc.confirmed.length} done and shown in ManaBox ✓</div>`;
    if (rc.ready.length) h += `<div><span class="pill ok">${rc.ready.length} made by hand — ManaBox now shows them</span></div>${list(rc.ready)}${S.wtoken ? `<button class="btn" data-act="bulkdone">Mark these done</button>` : ""}`;
    if (rc.missing.length) h += `<div><span class="pill warn">${rc.missing.length} marked done but NOT in ManaBox</span></div>${list(rc.missing)}`;
    if (rc.todo.length) h += `<div><span class="pill todo">${rc.todo.length} made by hand, still to do in ManaBox</span></div>${list(rc.todo)}`;
    if (rc.looks.length) h += `<div><span class="pill pencil">${rc.looks.length} pencilled but ManaBox already shows them</span></div>${list(rc.looks)}`;
    return h + `</div>`;
  }
  // "Sol Ring // Sol Ring" (same name both sides in the DB) -> "Sol Ring"
  const plain = (k) => { const p = String(k).split(" // "); return p.length === 2 && norm(p[0]) === norm(p[1]) ? p[0] : k; };
  function ensureWho() {
    if (S.who) return true;
    const n = (prompt("Your name? (shown on swaps and comments so we know who did what)", "") || "").trim();
    if (!n) return false;
    S.who = n; try { localStorage.setItem("mtg_who", n); } catch (e) { /* ignore */ }
    return true;
  }
  const swapAuthor = (p) => p.by || ((p.log && p.log[0] && p.log[0].by) || "");
  const needsReview = (p) => { const au = swapAuthor(p); return M.pencilStatus(p) === "pencilled" && au && au !== "me" && norm(au) !== norm(S.who) && !p.reviewed; };
  function reviewQueue() {
    const out = [];
    for (const d of S.decks) for (const p of d.pencilled || []) if (needsReview(p)) out.push({ d, p });
    return out;
  }
  async function addSwap(slug, pre) {
    const d = deckBySlug(slug);
    if (!d || !S.wtoken) return;
    if (!pre) { openModalNav(); S.ch = { mode: "in", slug, i: null, q: "", focus: true }; render(); return; }
    const inn = pre.in;
    const ki = M.resolve(S.idx, inn);
    if (!ki) { S.error = `"${inn}" is not in the card DB — check the spelling (nothing saved).`; render(); return; }
    const out = pre.out || "";
    let ko = "";
    if (out) {
      ko = M.resolve(S.idx, out) || "";
      if (!ko || !M.deckMap(d, S.idx).has(ko)) { S.error = `"${out}" isn't in this deck's list (nothing saved).`; render(); return; }
    }
    if (!confirm(`Add a pencilled swap to ${d.name}?\n\nIN: ${ki}\nOUT: ${ko || "undecided"}`)) return;
    if (!ensureWho()) return;
    const why = (prompt("Why this swap? (optional — leave blank to skip)", "") || "").trim(), today = new Date().toISOString().slice(0, 10);
    d.pencilled = d.pencilled || [];
    d.pencilled.push({ out: plain(ko), in: plain(ki), status: "pencilled", note: "", by: S.who, comments: why ? [{ at: today, by: S.who, text: why }] : [], log: [{ at: today, by: S.who, act: "Added" }] });
    S.error = ""; S.saving = "Saving…"; render();
    try { await saveDeck(d, `Swap (${d.name || d.slug}): Added ${ki}${ko ? " for " + ko : ""}${S.who ? " [" + S.who + "]" : ""}`); S.saving = ""; recompute(); }
    catch (e) { d.pencilled.pop(); S.error = e.message; S.saving = ""; }
    status(); render();
  }
  async function swapAction(slug, i, act, arg) {
    const d = deckBySlug(slug), p = d && (d.pencilled || [])[i];
    if (!p) return;
    const before = JSON.stringify(p), at = new Date().toISOString().slice(0, 10), by = S.who || "me";
    const label = (p.in || "?") + (p.out ? " for " + p.out : "");
    const status0 = p.status || "pencilled";
    let msg = "", entry = null;
    if (act === "comment") {
      if (!ensureWho()) return;
      const tx = (prompt(`Comment on ${label}`, "") || "").trim();
      if (!tx) return;
      p.comments = (p.comments || []).concat({ at, by: S.who, text: tx }); msg = "Comment";
    } else if (act === "undo") {
      const k = lastUndo(p);
      if (k < 0) return;
      const e = p.log[k];
      if (!confirm(`${SW_TEXT.undo}\n\n${label}\nBack to: ${prevOf(e)}${e.fromIn ? " (IN: " + e.fromIn + ")" : ""}`)) return;
      p.status = prevOf(e);
      if (e.fromIn !== undefined) p.in = e.fromIn;
      if (e.fromOut !== undefined) p.out = e.fromOut;
      if (e.noteBefore !== undefined) p.note = e.noteBefore;
      p.log = p.log.filter((_, n) => n !== k);
      if (p.status === "pencilled") delete p.reviewed;
      msg = "Undid: " + e.act;
    } else if (act === "changeout") {
      const nm = (arg || prompt("Which card goes OUT? (exact name from this deck)", "") || "").trim();
      if (!nm) return;
      const k = M.resolve(S.idx, nm);
      if (!k || !M.deckMap(d, S.idx).has(k)) { S.error = `"${nm}" isn't in this deck's list (nothing saved).`; render(); return; }
      if (!confirm(`Set the OUT card?\n\nWas: ${p.out || "undecided"}\nNow: ${k}`)) return;
      entry = { at, by, act: "Set OUT to " + k, prev: status0, fromOut: p.out || "", noteBefore: p.note || "" };
      p.out = plain(k); msg = entry.act;
    } else if (act === "change") {
      const nm = (arg || prompt("Which card went IN instead? (exact name; blank to keep " + (p.in || "none") + ")", "") || "").trim();
      if (!nm) return;
      const k = M.resolve(S.idx, nm);
      if (!k) { S.error = `"${nm}" is not in the card DB — check the spelling (nothing saved).`; render(); return; }
      if (!confirm(`Change the IN card?\n\nWas: ${p.in || "—"}\nNow: ${k}`)) return;
      entry = { at, by, act: "Changed IN to " + k, prev: status0, fromIn: p.in || "", noteBefore: p.note || "" };
      p.note = ((p.note ? p.note + " · " : "") + "was " + (p.in || "—")).trim();
      p.in = plain(k); msg = entry.act;
    } else {
      let q = SW_TEXT[act];
      if (!q) return;
      if (act === "done") {
        const m = M.deckMap(d, S.idx);
        if (!M.swapShown(d, p, S.idx, m)) q += "\n\nNote: the current collection CSV does NOT show this swap in the deck yet.";
      }
      if (!confirm(q + "\n\n" + label)) return;
      p.status = { approve: "approved", made: "made", done: "done", cancel: "dropped" }[act];
      msg = { approve: "Approved", made: "Made by hand", done: "Marked done", cancel: "Cancelled" }[act];
      entry = { at, by, act: msg, prev: status0 };
      if (S.who) p.reviewed = { by: S.who, at };
    }
    if (entry) p.log = (p.log || []).concat(entry);
    S.error = ""; S.saving = "Saving…"; render();
    try { await saveDeck(d, `Swap (${d.name || d.slug}): ${msg} — ${label}${S.who ? " [" + S.who + "]" : ""}`); S.saving = ""; recompute(); }
    catch (e) { d.pencilled[i] = JSON.parse(before); S.error = e.message; S.saving = ""; }
    status(); render();
  }

  function recompute() {
    if (!S.idx) { S.own = new Map(); S.checks = []; S.wlEval = []; return; }
    M.syncDeckLists(S.decks, S.rows);
    S.own = M.buildOwnership(S.rows, S.idx, S.cfg);
    S.claims = M.buildClaims(S.decks, S.idx);
    S.checks = M.runChecks({ decks: S.decks, idx: S.idx, own: S.own, claims: S.claims, cfg: S.cfg });
    S.wlEval = M.evalWishlist(S.wl, S.decks, S.idx, S.own, S.claims);
    S.picked = null;
  }

  function status() {
    const bits = [];
    if (S.busy) bits.push(S.busy);
    else {
      if (S.decks.length) bits.push(S.decks.length + " decks");
      if (S.csvName) bits.push("CSV " + S.csvName);
    }
    $("#status").textContent = bits.join(" · ");
  }

  /* ---------- helpers ---------- */
  const deckBySlug = (s) => S.decks.find((d) => d.slug === s);
  const csvDate = () => { const m = /(\d{8})/.exec(S.csvName); return m ? `${m[1].slice(6)}/${m[1].slice(4, 6)}/${m[1].slice(0, 4)}` : ""; };
  const issuesFor = (slug) => S.checks.filter((c) => c.deck === slug);
  const TYPE_ORDER = ["Commander", "Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Other"];
  // Orders cards the way the deck screen groups them (commander, creatures, … lands), A–Z within each; no headings.
  function sortCards(d, items) {
    const cmd = new Set(M.commandersOf(d).map((n) => M.keyOf(S.idx, n)));
    const rank = (x) => { const k = x.key || M.keyOf(S.idx, x.name); return cmd.has(k) ? 0 : TYPE_ORDER.indexOf(groupOf(M.cardInfo(S.idx, k))); };
    return items.map((x) => ({ x, r: rank(x) })).sort((a, b) => a.r - b.r || a.x.name.localeCompare(b.x.name)).map((o) => o.x);
  }
  function groupOf(info) {
    if (!info) return "Other";
    const t = info.frontType;
    if (/\bLand\b/.test(t)) return "Land";
    for (const g of ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment"]) if (t.includes(g)) return g;
    return "Other";
  }
  function oracleBox(info, key) {
    if (!info) return `<div class="oracle">${esc(key.replace(/^\?/, ""))} — not in the card DB.</div>`;
    return `<div class="oracle"><b>${esc(info.name)}</b>  ${esc(info.cost)}\n${esc(info.type)}\n${esc(info.text)}</div>`;
  }
  function artImg(key, name, deck, version, cls) {
    const sid = M.pickSid(S.own, S.idx, key, deck);
    const src = sid ? M.artUrl(sid, version) : M.artByName(name, version);
    const fb = sid ? M.artByName(name, version) : "";
    return `<img class="${cls}" loading="lazy" alt="" src="${esc(src)}"${fb ? ` data-fb="${esc(fb)}"` : ""}>`;
  }
  function cardRow(key, name, qty, cls, open, extra, deck) {
    const info = M.cardInfo(S.idx, key);
    return `<div class="cardrow ${cls || ""}" data-act="toggle" data-peek="${esc(key)}"><div class="t"><span class="n">${artImg(key, name, deck, "art_crop", "thumb")}${qty > 1 ? qty + "× " : ""}${esc(name)}</span><span>${extra || ""}</span></div><div ${open ? "" : "hidden"} data-o>${artImg(key, name, deck, "art_crop", "bigart")}${oracleBox(info, key)}</div></div>`;
  }
  function ownPill(key, showFree) {
    if (!S.rows.length) return "";
    const o = S.own.get(key);
    if (!o) return `<span class="pill err">not owned</span>`;
    return showFree ? `<span class="pill ${o.free ? "ok" : "warn"}">${o.free} free / ${o.total}</span>` : "";
  }

  /* ---------- output / export ---------- */
  function showOut(title, text, filename) { S.out = { title, text, filename }; render(); window.scrollTo(0, 0); }
  function outBox() {
    if (!S.out) return "";
    return `<div class="card"><div class="row"><b>${esc(S.out.title)}</b><button class="back" data-act="closeout">close</button></div>
      <textarea id="outta" readonly>${esc(S.out.text)}</textarea>
      <button class="btn" data-act="copy">Copy</button><button class="btn alt" data-act="download">Download</button></div>`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try { const ta = $("#outta"); ta.focus(); ta.select(); if (document.execCommand("copy")) return true; } catch (e) { /* fall through */ }
    return false;
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- views ---------- */
  function csvAgeDays() {
    const m = /(\d{4})(\d{2})(\d{2})/.exec(S.csvName || "");
    const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : S.csvAt ? Date.parse(S.csvAt) : NaN;
    return isFinite(t) ? Math.floor((Date.now() - t) / 864e5) : null;
  }
  function findResults(q) {
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length || !S.idx) return "";
    const names = new Map();
    for (const o of S.own.values()) names.set(o.key, o.name);
    for (const d of S.decks) for (const [k, e] of M.deckMap(d, S.idx)) if (!names.has(k)) names.set(k, e.name);
    const hits = [...names].filter(([, n]) => toks.every((t) => n.toLowerCase().includes(t))).sort((a, b) => a[1].localeCompare(b[1])).slice(0, 12);
    if (!hits.length) return `<div class="muted">No card matches.</div>`;
    return hits.map(([k, n]) => {
      const w = M.whereIs(k, S.decks, S.idx, S.own, S.claims, S.cfg), bits = [];
      bits.push(w.decks.length ? "in " + w.decks.map((x) => esc(x.name)).join(", ") : "not in a deck");
      if (w.pencilIn.length) bits.push("pencilled IN: " + w.pencilIn.map((x) => esc(x.name)).join(", "));
      if (w.pencilOut.length) bits.push("pencilled OUT: " + w.pencilOut.map((x) => esc(x.name)).join(", "));
      bits.push(w.total ? `${w.total} owned (${w.free} in free binders)` : "not owned");
      return `<div class="cardrow" data-act="zoom" data-key="${esc(k)}" data-slug="" data-peek="${esc(k)}"><div class="t"><span class="n">${esc(plain(n))}</span></div><div class="muted">${bits.join(" · ")}</div></div>`;
    }).join("");
  }
  function vDecks() {
    if (S.deck) return vDeck(deckBySlug(S.deck));
    if (!S.decks.length) return emptyMsg("No decks loaded yet.");
    const rq = reviewQueue();
    const mm = S.decks.reduce((s, d) => s + M.activePencils(d).filter((p) => M.pencilStatus(p) === "made" && !M.isReflected(d, p, S.idx)).length, 0), age = csvAgeDays();
    const stale = S.rows.length && (mm || (age != null && age >= 7)) ? `<div class="card lvl-warn">${mm ? `<b>${mm} swap${mm > 1 ? "s" : ""} made by hand ${mm > 1 ? "aren't" : "isn't"} in the collection file yet.</b> Update ManaBox, export it and upload the new CSV (Data tab). ` : ""}${age != null && age >= 7 ? `The collection file is ${age} days old.` : ""}</div>` : "";
    const findbox = `<input type="text" id="findq" placeholder="Where is a card? Search your decks and collection…" value="${esc(S.findq || "")}" autocomplete="off" style="width:100%;margin:6px 0"><div id="findres">${findResults(S.findq || "")}</div>`;
    const rbox = rq.length && S.reviewer ? `<div class="card"><b>Swaps to review (${rq.length})</b>${rq.map(({ d, p }) => `<div class="row" data-act="open" data-slug="${esc(d.slug)}" style="cursor:pointer"><span>${esc(d.name || d.slug)}: <b>${esc(p.in || "?")}</b>${p.out ? " for " + esc(p.out) : ""}<div class="muted">${esc(swapAuthor(p))}${(p.comments || []).length ? " — " + esc(p.comments[0].text) : ""}</div></span><span class="muted">open →</span></div>`).join("")}</div>` : "";
    return stale + rbox + findbox + `<div class="tiles">` + S.decks.map((d) => {
      const m = M.deckMap(d, S.idx), tot = M.deckTotal(m), is = issuesFor(d.slug);
      const er = is.filter((i) => i.level === "error").length, wa = is.filter((i) => i.level === "warn").length;
      const act = M.activePencils(d), mm = new Map();
      const todo = act.filter((p) => M.pencilStatus(p) === "made" && !M.isReflected(d, p, S.idx)).length;
      const pc = act.filter((p) => M.pencilStatus(p) !== "made").length;
      const wn = S.wlEval.filter((w) => (w.decks || []).includes(d.slug) && ["missing", "partial"].includes(w.status)).length;
      const cm = M.commandersOf(d);
      return `<div class="tile" data-act="open" data-slug="${esc(d.slug)}">${cm.length ? artImg(M.keyOf(S.idx, cm[0]), cm[0], d, "art_crop", "tileimg") : ""}<div class="tilein"><div class="row"><b>${esc(d.name || d.slug)}</b><span class="pill">${esc(d.status || "planned")}</span></div>
        <div class="muted">${esc(cm.join(" + "))} · ${tot} cards</div>
        <div>${todo ? `<span class="pill todo">${todo} to do in ManaBox</span> ` : ""}${pc ? `<span class="pill pencil">${pc} pencilled</span> ` : ""}${er ? `<span class="pill err">${er} errors</span> ` : ""}${wa ? `<span class="pill warn">${wa} warnings</span> ` : ""}${wn ? `<span class="pill">${wn} on wishlist</span>` : ""}${S.reviewer && (d.pencilled || []).some(needsReview) ? ` <span class="pill todo">swap to review</span>` : ""}</div></div></div>`;
    }).join("") + `</div>`;
  }

  function rebuildList(d) {
    const mode = S.rbmode || "swaps";
    const list = mode === "swaps" ? M.applySwaps(d, S.idx, { only: ["approved", "made"] }) : mode === "physical" ? M.applySwaps(d, S.idx, { only: ["made"] }) : [...M.deckMap(d, S.idx).values()];
    return list.map((c) => ({ key: c.key || M.keyOf(S.idx, c.name), name: c.name, qty: c.qty }));
  }
  function rebuildSection(d) {
    if (!S.rows.length || !S.idx) return "";
    const mode = S.rbmode || "swaps", list = rebuildList(d), al = M.allocateDeck(d, list, S.own, S.cfg);
    const got = al.lines.reduce((s, l) => s + l.qty, 0), want = list.reduce((s, c) => s + c.qty, 0);
    let h = `<h3>Rebuild from collection</h3><div class="card"><div class="muted">Builds a ManaBox import for this deck from copies you own: ones already in this deck, then free binders. Choose a printing where you own more than one.</div>
      <select id="rbmode"><option value="swaps"${mode === "swaps" ? " selected" : ""}>List with confirmed changes</option><option value="physical"${mode === "physical" ? " selected" : ""}>List as it is physically</option><option value="current"${mode === "current" ? " selected" : ""}>List as ManaBox shows it now</option></select>
      <div style="margin-top:6px"><span class="pill ${got === want ? "ok" : "warn"}">${got} of ${want} cards found</span></div>`;
    if (al.short.length) h += al.short.map((x) => `<div class="muted">✗ ${esc(x.name)}${x.need > 1 ? " ×" + x.need : ""} — ${esc(x.why)}</div>`).join("");
    const cf = M.pickConflicts(S.decks, d, al, S.own, S.cfg);
    if (cf.length) h += cf.map((x) => `<div class="card lvl-warn">${esc(x)}</div>`).join("");
    const multi = list.map((c) => ({ c, p: M.isBasic(c.name) ? [] : M.printings(S.own, c.key, d, S.cfg) })).filter((x) => x.p.length > 1);
    if (multi.length) {
      h += `<h3>Choose printings (${multi.length})</h3>`;
      h += multi.map(({ c, p }) => {
        const pk = (d.picks || {})[c.key], cur = pk ? M.printKeyOf(pk) : "";
        const opts = p.map((x) => `<option value="${esc(x.k)}"${x.k === cur ? " selected" : ""}>${esc(String(x.set).toUpperCase())} #${esc(x.cn)}${/foil/i.test(x.foil) && !/normal/i.test(x.foil) ? " ★foil" : ""} · ${x.avail}× · ${esc([...x.where].join(", "))}</option>`).join("");
        const used = al.lines.find((l) => l.key === c.key);
        return `<div class="cardrow"><div class="t"><span class="n">${esc(c.name)}</span></div><select data-pick="${esc(c.key)}" data-slug="${esc(d.slug)}"><option value="">Auto${used && !pk ? " — " + esc(String(used.row.set).toUpperCase()) + " #" + esc(used.row.cn) : ""}</option>${opts}</select></div>`;
      }).join("");
    }
    h += `<div style="margin-top:8px"><button class="btn" data-act="rebuildcsv" data-slug="${esc(d.slug)}">Export ManaBox CSV</button><button class="btn alt" data-act="rebuildtext" data-slug="${esc(d.slug)}">Export text list</button></div>`;
    h += `<div class="muted">Picks are ${S.wtoken ? "saved to the deck" : "kept for this session only (add a write token to save them)"}. Test the import with a small deck first.</div></div>`;
    return h;
  }

  /* ---------- deck stats panel ---------- */
  const ROLE_LABEL = { lands: "Lands", ramp: "Ramp", draw: "Card advantage", targeted: "Targeted disruption", mass: "Mass disruption", plan: "Plan cards" };
  const ROLE_STAT = { lands: "land", ramp: "ramp", draw: "draw", targeted: "targeted", mass: "mass", plan: "plan" };
  const COL_NAME = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colourless" };
  function statsList(d) {
    const mode = S.statsMode || "swaps";
    const list = mode === "swaps" ? M.applySwaps(d, S.idx, { only: ["approved", "made"] }) : [...M.deckMap(d, S.idx).values()];
    return list.map((c) => ({ key: c.key || M.keyOf(S.idx, c.name), name: c.name, qty: c.qty }));
  }
  function effRoles(d, key) {
    const o = d.roles && d.roles[key];
    return o ? o.filter((x) => M.ROLE_KEYS.includes(x)) : M.classifyRoles(M.cardInfo(S.idx, key));
  }
  function softRole(d, key, r) { return !(d.roles && d.roles[key]) && M.classifyRolesEx(M.cardInfo(S.idx, key))[r] === "soft"; }
  function statsPanel(d) {
    const mode = S.statsMode || "swaps", st = M.deckStats(d, S.idx, statsList(d), S.cfg), T = st.targets;
    let h = `<div class="card stats"><div class="row"><b>Deck stats</b><button class="btn alt" data-act="stats">Close</button></div>
      <div class="chips vt"><button data-act="statsmode" data-v="swaps" class="${mode === "swaps" ? "on" : ""}">With confirmed changes</button><button data-act="statsmode" data-v="current" class="${mode === "current" ? "on" : ""}">As ManaBox shows it</button></div>
      <div class="muted">${st.total} cards plus ${st.commander.length ? esc(st.commander.map((c) => c.name).join(" + ")) : "no commander set"}. The commander isn't counted below.${st.unknown.length ? ` Not in the DB: ${esc(st.unknown.join(", "))}.` : ""}</div>`;
    h += `<h3>Command Zone template</h3><div class="muted">Roles are guessed from each card's text and can overlap (a card can count in two rows). Open a row, tap a card, and switch its roles if the guess is wrong.</div>`;
    const base = Object.assign({}, (S.cfg && S.cfg.template) || M.DEFAULT_CONFIG.template), custom = d.targets && Object.keys(d.targets).length;
    if (S.tgtEdit === d.slug) {
      h += `<div class="card"><b>Targets for this deck</b>` + ["lands", "ramp", "draw", "targeted", "mass", "plan"].map((k) => `<div class="row"><span>${ROLE_LABEL[k]}</span><span><button class="btn alt" data-act="tgt" data-r="${k}" data-v="-1">−</button> <b>${T[k]}</b> <button class="btn alt" data-act="tgt" data-r="${k}" data-v="1">+</button></span></div>`).join("") +
        `<div><button class="btn" data-act="tgtsave" data-slug="${esc(d.slug)}">Save targets</button><button class="btn alt" data-act="tgtreset" data-slug="${esc(d.slug)}">Back to standard</button><button class="btn alt" data-act="tgtcancel">Cancel</button></div></div>`;
    } else h += `<div class="muted">${custom ? "Custom targets for this deck (standard: " + ["lands", "ramp", "draw", "targeted", "mass"].map((k) => base[k]).join("/") + ")." : "Standard Command Zone targets."} ${S.wtoken ? `<button class="btn alt" data-act="tgtedit" data-slug="${esc(d.slug)}">Edit targets</button>` : ""}</div>`;
    for (const k of ["lands", "ramp", "draw", "targeted", "mass", "plan"]) {
      const have = st.counts[k], want = T[k], diff = have - want, pct = Math.min(100, Math.round((have / (want || 1)) * 100));
      const cls = k === "plan" ? "" : have >= want ? "ok" : have >= want - 1 ? "warn" : "err";
      const open = S.statsRole === k;
      h += `<div class="trow" data-act="statsrole" data-r="${k}"><div class="row"><span>${ROLE_LABEL[k]}</span><span><b>${have}</b> ${st.softCounts && st.softCounts[ROLE_STAT[k]] ? `<span class="muted">(+${st.softCounts[ROLE_STAT[k]]} maybe)</span> ` : ""}<span class="muted">/ ${k === "plan" ? "~" : ""}${want}</span> ${k === "plan" ? "" : `<span class="pill ${cls}">${diff >= 0 ? "+" + diff : diff}</span>`}</span></div><div class="bar"><i class="${cls}" style="width:${pct}%"></i></div></div>`;
      if (open) {
        const list = st.roles[ROLE_STAT[k]].map((x) => ({ ...x, name: (M.cardInfo(S.idx, x.key) || { name: x.key }).name })).sort((a, b) => a.name.localeCompare(b.name));
        h += `<div class="chips">${list.map((x) => `<button data-act="zoom" data-peek="${esc(x.key)}" data-key="${esc(x.key)}" data-slug="${esc(d.slug)}">${x.qty > 1 ? x.qty + "× " : ""}${esc(plain(x.name))}</button>`).join("") || `<span class="muted">None.</span>`}</div>`;
        const sl = ((st.soft || {})[ROLE_STAT[k]] || []).map((x) => ({ ...x, name: (M.cardInfo(S.idx, x.key) || { name: x.key }).name })).sort((a2, b2) => a2.name.localeCompare(b2.name));
        if (sl.length) h += `<div class="muted" style="margin-top:6px">Maybe (not counted: conditional, one-shot, narrow or card-neutral). Tap one, then switch the role on to count it.</div><div class="chips soft">${sl.map((x) => `<button class="maybe" data-act="zoom" data-peek="${esc(x.key)}" data-key="${esc(x.key)}" data-slug="${esc(d.slug)}">${x.qty > 1 ? x.qty + "× " : ""}${esc(plain(x.name))}</button>`).join("")}</div>`;
      }
    }
    h += `<div class="muted">${st.multiRole} cards fill more than one role.</div>`;
    const mx = Math.max(1, ...st.curve);
    h += `<h3>Mana curve</h3><div class="curve">${st.curve.map((n, i) => `<div class="cv"><span>${n || ""}</span><i style="height:${Math.round((n / mx) * 90)}px"></i><em>${i === 7 ? "7+" : i}</em></div>`).join("")}</div>
      <div class="muted">Average mana value ${st.avgMv.toFixed(2)} (spells only) · total ${st.mvSum} · ${st.nonLand} spells · ${st.lands} lands${st.commander.length ? ` · commander MV ${st.commander.map((c) => c.mv).join(" + ")}` : ""}</div>`;
    const cols = ["W", "U", "B", "R", "G", "C"].filter((c) => st.pips[c] || st.srcLand[c] || st.srcOther[c]);
    const pipT = cols.reduce((a, c) => a + st.pips[c], 0) || 1, srcMax = Math.max(1, ...cols.map((c) => st.srcLand[c] + st.srcOther[c]));
    h += `<h3>Colour pips vs mana sources</h3><div class="muted">Pips = coloured mana symbols in the costs of your spells. Sources = lands plus rocks and creatures that can make that colour.</div>` +
      cols.map((c) => `<div class="prow"><span class="pip pip-${c}">${c}</span><div class="pcol"><div class="bar"><i class="c${c}" style="width:${Math.round((st.pips[c] / pipT) * 100)}%"></i></div><div class="muted">${COL_NAME[c]}: ${st.pips[c]} pips (${Math.round((st.pips[c] / pipT) * 100)}%)</div></div>
        <div class="pcol"><div class="bar"><i class="c${c}" style="width:${Math.round(((st.srcLand[c] + st.srcOther[c]) / srcMax) * 100)}%"></i></div><div class="muted">${st.srcLand[c]} lands + ${st.srcOther[c]} other = ${st.srcLand[c] + st.srcOther[c]} sources</div></div></div>`).join("");
    h += `<h3>Card types</h3><div class="muted">${["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land", "Other"].filter((t) => st.types[t]).map((t) => `${t} ${st.types[t]}`).join(" · ")}</div>`;
    h += `<h3>Lands</h3><div class="muted">${st.lands} lands · ${st.tappedAlways} always enter tapped · ${st.tappedCond} enter tapped under some conditions (best guess from card text).</div></div>`;
    return h;
  }

  function upgradePanel(d) {
    const st = M.deckStats(d, S.idx, statsList(d), S.cfg), u = M.upgradeCandidates(d, S.idx, S.own, S.claims, S.cfg, st);
    const role = S.upgRole || M.GAP_ROLES.slice().sort((x, y) => u.gaps[y] - u.gaps[x])[0];
    const lab = { ramp: "Ramp", draw: "Card advantage", targeted: "Targeted", mass: "Mass" };
    let h = `<div class="card"><div class="row"><b>Upgrade finder</b><button class="btn alt" data-act="upg">Close</button></div>
      <div class="muted">Cards you own, in this deck's colours, not already in it and not locked in another built deck, that fill a role. It only suggests: pick one, then choose the card to cut, and it's added as a pencilled swap. Roles are guessed from card text.</div>
      <div class="chips vt">${M.GAP_ROLES.map((r) => `<button data-act="upgrole" data-r="${r}" class="${role === r ? "on" : ""}">${lab[r]} ${u.gaps[r] ? `<span class="pill err">short ${u.gaps[r]}</span>` : `<span class="muted">at target</span>`} · ${u.lists[r].length}</button>`).join("")}</div>`;
    const list = u.lists[role], lim = S.upgLimit || 24;
    const why = {
      ramp: "Ramp gets you to your big plays sooner, which helps in 1v1 and in a slow pod alike.",
      draw: "Card advantage keeps your hand full in long pod games and wins the grind 1v1.",
      targeted: "Targeted removal answers the one threat that matters 1v1, and in a pod you save it for the biggest problem.",
      mass: "A sweeper is your reset button when you're behind on board, especially against a pod's combined board.",
    };
    const reason = (c) => {
      const bits = [`<b>Why:</b> ${lab[role]} — the deck has ${st.counts[role] || 0} against a target of ${st.targets[role] || 0}${u.gaps[role] ? ` (short ${u.gaps[role]})` : " (already at target, so this would be an upgrade over a weaker one)"}.`];
      const extra = c.roles.filter((r) => r !== role && u.gaps[r] > 0);
      if (extra.length) bits.push(`Also helps with ${extra.map((r) => lab[r].toLowerCase() + " (short " + u.gaps[r] + ")").join(", ")}.`);
      bits.push(why[role]);
      bits.push(c.free ? `You have ${c.free} in free binders, so nothing is taken from another deck.` : `It's not in a free binder (${c.binders.map((b) => b.binder).join(", ")}), but no built deck is using it.`);
      if (c.soft) bits.push("A planned or pencilled deck also wants it.");
      if (c.illegal) bits.push("The card database flags it as not Commander-legal (that flag can be wrong).");
      return bits.join(" ");
    };
    h += `<div class="stacks">` + list.slice(0, lim).map((c) => `<div class="stack upc">
      <div data-hold class="ac full" data-act="zoom" data-key="${esc(c.key)}" data-slug="${esc(d.slug)}">${artImg(c.key, c.name, d, "normal", "acimg")}</div>
      <div class="muted upwhy">${reason(c)}</div>
      ${S.wtoken ? `<button class="btn alt" data-act="upgpick" data-slug="${esc(d.slug)}" data-key="${esc(c.key)}">Pencil in…</button>` : ""}</div>`).join("") + `</div>` || `<div class="muted">Nothing owned fits here.</div>`;
    if (!list.length) h += `<div class="muted">Nothing owned fits here.</div>`;
    if (list.length > lim) h += `<button class="btn" data-act="upgmore">Show more</button>`;
    return h + `</div>`;
  }
  /* ---------- check a physical deck (tick list + camera scanner) ---------- */
  const TK_MODES = { physical: "As it is physically (ManaBox + swaps made)", current: "List in ManaBox", swaps: "With all confirmed swaps" };
  const tkKey = (slug, mode) => "mtg_tick_" + slug + "_" + mode;
  function tkLoad(slug, mode) { try { const j = JSON.parse(localStorage.getItem(tkKey(slug, mode)) || "null"); if (j && j.got) return j; } catch (e) { /* none */ } return { got: {}, diff: {}, extra: [], at: "" }; }
  function tkSave() { const t = S.tk; if (!t) return; t.st.at = new Date().toISOString(); try { localStorage.setItem(tkKey(t.slug, t.mode), JSON.stringify(t.st)); } catch (e) { /* ignore */ } }
  function tkList(d, mode) {
    const l = mode === "swaps" ? M.applySwaps(d, S.idx, { only: ["approved", "made"] }) : mode === "physical" ? M.applySwaps(d, S.idx, { only: ["made"] }) : [...M.deckMap(d, S.idx).values()];
    return l.map((c) => ({ key: c.key || M.keyOf(S.idx, c.name), name: c.name, qty: c.qty }));
  }
  function tkOpen(d, mode) {
    mode = mode || (S.tk && S.tk.mode) || "physical";
    const entries = M.tickEntries(d, tkList(d, mode), S.own, S.cfg);
    const kind = (k) => ((M.cardInfo(S.idx, k) || {}).frontType || "").replace(/^(Legendary |Basic |Snow |Token )+/, "").match(/Land|Creature|Planeswalker|Instant|Sorcery|Artifact|Enchantment|Battle/);
    entries.forEach((e) => { const m = kind(e.key); e.type = m ? m[0] : "Other"; });
    S.tk = { slug: d.slug, mode, entries, st: tkLoad(d.slug, mode), filter: (S.tk && S.tk.filter) || "todo", msg: "" };
  }
  const tkGot = (e) => (S.tk.st.got[e.id] || 0);
  function tkTotals() { const t = S.tk; let have = 0, want = 0; for (const e of t.entries) { have += Math.min(e.qty, tkGot(e)); want += e.qty; } return { have, want }; }
  function vTick(d) {
    const t = S.tk, { have, want } = tkTotals(), pct = want ? Math.round((have / want) * 100) : 0;
    const issues = Object.keys(t.st.diff).filter((id) => t.entries.some((e) => e.id === id)).length;
    let h = `<div class="card"><div class="row"><b>Check ${esc(d.name || d.slug)}</b><button class="btn alt" data-act="tkback">Back to deck</button></div>
      <div class="muted">Go through the physical deck and tick cards off. Nothing here is added to your collection or saved to ManaBox; it only compares what's in your hands with the list.</div>
      <div class="chips vt">${Object.entries(TK_MODES).map(([k, v]) => `<button data-act="tkmode" data-m="${k}" class="${t.mode === k ? "on" : ""}">${esc(v)}</button>`).join("")}</div>
      <div class="row" style="margin-top:8px"><b>${have} of ${want} found</b><span class="muted">${want - have} to find${issues ? " · " + issues + " different printing" + (issues > 1 ? "s" : "") : ""}</span></div>
      <div class="bar"><i class="c0" style="width:${pct}%"></i></div>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="tkscan">Scan with camera</button><button class="btn alt" data-act="tkreset">Start over</button></div></div>`;
    const fl = { todo: "Still to find", all: "All", done: "Found", diff: "Different printing" };
    h += `<div class="chips vt">${Object.entries(fl).map(([k, v]) => `<button data-act="tkfilter" data-f="${k}" class="${t.filter === k ? "on" : ""}">${v}</button>`).join("")}</div>`;
    const show = t.entries.filter((e) => t.filter === "all" || (t.filter === "todo" ? tkGot(e) < e.qty : t.filter === "done" ? tkGot(e) >= e.qty : !!t.st.diff[e.id]));
    const order = ["Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle", "Land", "Other"];
    for (const ty of order) {
      const g = show.filter((e) => e.type === ty).sort((a, b) => a.name.localeCompare(b.name));
      if (!g.length) continue;
      h += `<h3>${ty} <span class="muted">${g.reduce((s2, e) => s2 + e.qty, 0)}</span></h3>`;
      h += g.map((e) => {
        const n = tkGot(e), done = n >= e.qty, df = t.st.diff[e.id];
        const img = e.sid ? M.artUrl(e.sid, "art_crop") : M.artByName(e.name, "art_crop");
        return `<div class="cardrow tkrow ${done ? "done" : ""}" data-act="tkflip" data-id="${esc(e.id)}"><div class="t"><span class="n"><img class="thumb" loading="lazy" alt="" src="${esc(img)}">${esc(plain(e.name))}
          <span class="muted tkp">${e.unknown ? "printing not known" : esc(e.set + " #" + e.cn) + (e.foil ? " · foil" : "")}${df ? ` · <b>found as ${esc(df.join(", "))}</b>` : ""}</span></span>
          <span class="tkc ${done ? "ok" : ""}">${n}/${e.qty}</span></div></div>`;
      }).join("");
    }
    if (!show.length) h += `<div class="card muted">${t.filter === "todo" ? "Everything is ticked off." : "Nothing here."}</div>`;
    h += `<div class="card"><b>Cards that shouldn't be in this deck</b><div class="muted">Found something in the deck that isn't on the list? Add it here. It is only noted in this check.</div>
      <div class="row"><input type="text" id="tkx" placeholder="Card name" autocomplete="off" style="flex:1"><button class="btn" data-act="tkxadd">Add</button></div>
      ${t.st.extra.map((x, i) => `<div class="row"><span>${esc(x.name)}${x.seen ? ` <span class="muted">(${esc(x.seen)})</span>` : ""}</span><button class="btn alt" data-act="tkxdel" data-i="${i}">Remove</button></div>`).join("")}</div>
      <div class="card"><b>Results</b><div class="row"><button class="btn" data-act="tkreport">Missing &amp; extra report</button><button class="btn alt" data-act="tklist">List of what's physically here</button></div></div>`;
    return h;
  }
  function tkReport(kind) {
    const t = S.tk, d = deckBySlug(t.slug), lines = [];
    const sw = (e) => `${e.name}${e.unknown ? "" : " (" + e.set + " #" + e.cn + (e.foil ? " foil" : "") + ")"}`;
    if (kind === "list") {
      for (const e of t.entries) { const n = Math.min(e.qty, tkGot(e)); if (n > 0) lines.push(`${n} ${plain(e.name)}${e.unknown ? "" : " (" + e.set + ") " + e.cn}${e.foil ? " *F*" : ""}${t.st.diff[e.id] ? "  // found as " + t.st.diff[e.id].join(", ") : ""}`); }
      for (const x of t.st.extra) lines.push(`1 ${x.name}  // not on the list${x.seen ? " — " + x.seen : ""}`);
      return lines.join("\n") + "\n";
    }
    const { have, want } = tkTotals();
    lines.push(`${d.name || d.slug} — ${TK_MODES[t.mode]}`, `${have} of ${want} found`, "");
    const miss = t.entries.filter((e) => tkGot(e) < e.qty);
    lines.push(miss.length ? "MISSING:" : "Nothing missing.", ...miss.map((e) => `  ${e.qty - Math.min(e.qty, tkGot(e))}× ${sw(e)}`));
    const dif = t.entries.filter((e) => t.st.diff[e.id]);
    if (dif.length) lines.push("", "DIFFERENT PRINTING FROM THE LIST:", ...dif.map((e) => `  ${plain(e.name)}: list ${e.set} #${e.cn}${e.foil ? " foil" : ""}, found ${t.st.diff[e.id].join(", ")}`));
    if (t.st.extra.length) lines.push("", "IN THE DECK BUT NOT ON THE LIST:", ...t.st.extra.map((x) => `  ${x.name}${x.seen ? " (" + x.seen + ")" : ""}`));
    return lines.join("\n") + "\n";
  }
  // ----- camera scanner (overlay outside #view so re-renders don't kill the video) -----
  let scanReads = 0, scanEl = null, scanLast = { key: "", n: 0 }, scanLock = false, scanLog = [];
  function scanMsg(html) { const m = scanEl && scanEl.querySelector("#scanmsg"); if (m) m.innerHTML = html; }
  function tkCount(e, seenNote) {
    const t = S.tk; t.st.got[e.id] = Math.min(e.qty, tkGot(e) + 1);
    if (seenNote) { const a = t.st.diff[e.id] || []; if (!a.includes(seenNote)) a.push(seenNote); t.st.diff[e.id] = a; }
    tkSave(); render();
  }
  function scanResult(r) {
    const t = S.tk; if (!t || !scanEl) return;
    const m = M.matchScan(t.entries, t.st, r.title, r.bottom);
    const key = m.kind === "none" ? "" : m.kind + "|" + (m.entry ? m.entry.id : "") + "|" + (m.seen.set || "") + (m.seen.cn || "");
    if (!key) {
      scanLast = { key: "", n: 0 }; scanLock = false;
      const tt = (r.title || "").trim().split("\n")[0].trim(), bb = (r.bottom || "").trim().replace(/\s*\n\s*/g, " / "), cl = m.seen;
      const any = tt ? M.matchAnyTitle(S.idx, tt) : null, nm = any ? (M.cardInfo(S.idx, any.key) || {}).name : "";
      scanReads++;
      const raw = `<div class="muted scanraw">Read #${scanReads}: title “${esc(tt) || "—"}” · small print “${esc(bb) || "—"}”</div>`;
      if (nm) scanMsg(`<b>${esc(plain(nm))}</b>${cl.set && cl.cn ? ` (${esc(cl.set)} #${esc(cl.cn)})` : ""} isn't on this deck's list.<div class="row"><button class="btn alt" data-act="scanextra" data-seen="${esc(cl.set && cl.cn ? cl.set + " #" + cl.cn : "")}" data-name="${esc(nm)}">Note as extra</button></div>${raw}`);
      else scanMsg(`<span class="muted">Can't match that yet. Fill the frame with the card, flat and well lit, name at the top and the small print at the bottom both inside it.</span>${raw}`);
      return;
    }
    scanLast = scanLast.key === key ? { key, n: scanLast.n + 1 } : { key, n: 1 };
    if (scanLast.n < 2 || scanLock) { if (!scanLock) scanMsg(`<span class="muted">Reading… ${esc(plain(m.entry.name))}</span>`); return; }
    scanLock = true; // one tick per card: the frame has to go blank or change before the next one counts
    const e = m.entry, seen = m.seen.set && m.seen.cn ? `${m.seen.set} #${m.seen.cn}${m.seen.star ? " ★" : ""}` : "";
    if (m.kind === "exact") {
      if (m.full) { scanMsg(`<b>${esc(plain(e.name))}</b> (${esc(e.set)} #${esc(e.cn)}) — you already ticked all ${e.qty}. An extra copy?<div class="row"><button class="btn alt" data-act="scanextra" data-seen="${esc(seen)}" data-name="${esc(e.name)}">Note as extra</button></div>`); return; }
      tkCount(e); scanMsg(`<span class="scanok">✔ ${esc(plain(e.name))}</span> <span class="muted">${esc(e.set)} #${esc(e.cn)} matched${m.foilNote ? " · " + esc(m.foilNote) : ""}</span>`);
    } else if (m.kind === "name") {
      if (m.full) { scanMsg(`<b>${esc(plain(e.name))}</b> is already fully ticked. An extra copy?<div class="row"><button class="btn alt" data-act="scanextra" data-seen="" data-name="${esc(e.name)}">Note as extra</button></div>`); return; }
      tkCount(e); scanMsg(`<span class="scanok">✔ ${esc(plain(e.name))}</span> <span class="muted">name matched; couldn't read the printing${e.unknown ? "" : " (list has " + esc(e.set) + " #" + esc(e.cn) + ")"}</span>`);
    } else if (m.kind === "diff") {
      S.scanPend = { id: e.id, seen, name: e.name };
      scanMsg(`<b>${esc(plain(e.name))}</b>: this is <b>${esc(seen)}</b>${m.seen.star ? " (foil star)" : ""} but the list has <b>${esc(e.unknown ? "an unknown printing" : e.set + " #" + e.cn + (e.foil ? " foil" : ""))}</b>.<div class="row"><button class="btn" data-act="scanaccept">Count it</button><button class="btn alt" data-act="scanextra" data-seen="${esc(seen)}" data-name="${esc(e.name)}">It's an extra</button></div>`);
    }
  }
  async function tkScan() {
    if (scanEl) return;
    scanEl = document.createElement("div"); scanEl.id = "scanpanel";
    scanEl.innerHTML = `<div class="scantop"><b id="scanprog"></b><button class="btn alt" data-act="scanstop">Done</button></div>
      <div class="scanwrap"><video id="scanv" playsinline muted></video><div class="scanframe"></div></div>
      <div id="scanmsg" class="scanmsg"><span class="muted">Starting the camera…</span></div>`;
    document.body.appendChild(scanEl); pushNav("modal");
    scanEl.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]"); if (!b) return; const a = b.dataset.act, t = S.tk;
      if (a === "scanstop") { scanStop(); popNav("modal"); }
      else if (a === "scanaccept" && S.scanPend) { const e = t.entries.find((x) => x.id === S.scanPend.id); if (e) tkCount(e, S.scanPend.seen); scanMsg(`<span class="scanok">✔ counted ${esc(plain(S.scanPend.name))}</span> <span class="muted">as ${esc(S.scanPend.seen)}</span>`); S.scanPend = null; }
      else if (a === "scanextra") { t.st.extra.push({ name: plain(b.dataset.name), seen: b.dataset.seen }); tkSave(); render(); scanMsg(`<span class="muted">Noted ${esc(plain(b.dataset.name))} as an extra.</span>`); }
    });
    try {
      await window.MTGScan.start($("#scanv"), (m) => scanMsg(`<span class="muted">${esc(m)}</span>`));
      const vid = $("#scanv"), fit = () => { const w = scanEl && scanEl.querySelector(".scanwrap"), fr = scanEl && scanEl.querySelector(".scanframe"); if (!w || !fr || !vid.videoWidth) return; const k = Math.min(w.clientWidth / vid.videoWidth, w.clientHeight / vid.videoHeight), c = window.MTGScan.cardRect(vid.videoWidth, vid.videoHeight); fr.style.height = c.h * k + "px"; fr.style.maxWidth = "none"; fr.style.width = c.w * k + "px"; };
      fit(); window.addEventListener("resize", fit); vid.addEventListener("loadedmetadata", fit);
      scanMsg(`<span class="muted">Hold a card inside the frame.</span>`);
      window.MTGScan.loop($("#scanv"), (r) => { const p = $("#scanprog"); if (p) { const x = tkTotals(); p.textContent = `${x.have} of ${x.want} found`; } scanResult(r); });
    } catch (e) { scanMsg(`<span class="err">${esc(e.name === "NotAllowedError" ? "Camera permission was refused. Allow it in the browser's site settings and try again." : e.message)}</span>`); }
  }
  function scanStop() { try { window.MTGScan.stop(); } catch (e) { /* ignore */ } if (scanEl) { scanEl.remove(); scanEl = null; } scanLast = { key: "", n: 0 }; scanLock = false; S.scanPend = null; render(); }
  function vDeck(d) {
    if (!d) { S.deck = null; return vDecks(); }
    if (S.tk && S.tk.slug === d.slug) return vTick(d);
    const m = M.deckMap(d, S.idx), pens = M.activePencils(d);
    const outKeys = new Set(pens.filter((p) => p.out).map((p) => M.keyOf(S.idx, p.out)));
    const cmds = M.commandersOf(d), ck = cmds.length ? M.keyOf(S.idx, cmds[0]) : "";
    const nMade = pens.filter((p) => M.pencilStatus(p) === "made").length, nPen = pens.length - nMade;
    let h = `<button class="back" data-act="back">← All decks</button>
      <div class="hero">${ck ? artImg(ck, cmds[0], d, "art_crop", "heroimg") : ""}<div class="heroin"><div class="herot">${esc(d.name || d.slug)}</div>
      <div class="herom">${esc(cmds.join(" + "))}</div>
      <div class="herom">${esc(d.status || "planned")} · ${M.deckTotal(m)} cards${S.rows.length && M.deckValue(S.rows, d) ? ` · worth about $${M.deckValue(S.rows, d).toFixed(0)} AUD` : ""}${nMade ? ` · ${nMade} made by hand` : ""}${nPen ? ` · ${nPen} pencilled` : ""}${d.updated ? " · updated " + esc(d.updated) : ""}</div></div></div>
      <div><button class="btn" data-act="stats">${S.statsOpen ? "Hide stats" : "Deck stats"}</button><button class="btn" data-act="upg">${S.upgOpen ? "Hide upgrades" : "Upgrade finder"}</button><button class="btn" data-act="tkopen" data-slug="${esc(d.slug)}">Check deck</button><button class="btn" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="current">Export list</button>
      ${pens.some((p) => M.pencilStatus(p) === "made") ? `<button class="btn alt" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="physical">Export list as it is physically</button>` : ""}
      ${pens.some((p) => ["approved", "made"].includes(M.pencilStatus(p))) ? `<button class="btn alt" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="swaps">Export with confirmed changes</button>` : ""}</div>
      ${pens.some((p) => M.pencilStatus(p) === "pencilled") ? `<div class="muted">Pencilled swaps aren't in any export until you approve them.</div>` : ""}`;
    const pre = h + (S.statsOpen ? statsPanel(d) : "") + (S.upgOpen ? upgradePanel(d) : ""); h = "";
    const is = issuesFor(d.slug);
    if (is.length) h += `<h3>Checks</h3>` + is.map(issueHtml).join("");
    const btn = (i, act, txt, alt) => `<button class="btn${alt ? " alt" : ""}" data-act="swap" data-slug="${esc(d.slug)}" data-i="${i}" data-sw="${act}">${txt}</button>`;
    const swapBlock = (list, cls) => list.map((p) => {
      const i = (d.pencilled || []).indexOf(p), st = M.pencilStatus(p);
      const und = lastUndo(p) >= 0 ? btn(i, "undo", "Undo last change", 1) : "";
      const btns = !S.wtoken ? "" : st === "made" ? btn(i, "done", "Mark done") + btn(i, "change", "Different card", 1) + btn(i, "cancel", "Cancel", 1) + und + btn(i, "comment", "Comment", 1)
        : (st === "approved" ? "" : btn(i, "approve", "Approve")) + btn(i, "made", "I made it") + btn(i, "change", "Different IN card", 1) + btn(i, "changeout", p.out ? "Change cut" : "Choose cut", 1) + btn(i, "cancel", "Cancel", 1) + und + btn(i, "comment", "Comment", 1);
      const au = swapAuthor(p), rv = needsReview(p);
      let x = `<div class="card"><span class="pill ${cls}">${esc(p.status || "pencilled")}</span> ${au && au !== "me" ? `<span class="muted">added by ${esc(au)}</span> ` : ""}${rv ? (S.reviewer ? `<span class="pill todo">needs your review</span> ` : `<span class="pill">awaiting review</span> `) : p.reviewed && p.reviewed.by && norm(p.reviewed.by) !== norm(au) ? `<span class="muted">reviewed by ${esc(p.reviewed.by)}</span> ` : ""}${p.note ? `<span class="muted">${esc(p.note)}</span>` : ""}`;
      const side = (nm, role) => {
        if (!nm) return `<div class="sc empty"><div class="scimg">${role === "out" ? "Cut not chosen yet" : "No card"}</div><div class="scl">${role.toUpperCase()}</div></div>`;
        const k = M.keyOf(S.idx, nm);
        return `<div data-hold class="sc ${role}" data-act="zoom" data-key="${esc(k)}" data-slug="${esc(d.slug)}">${artImg(k, nm, d, "normal", "scimg")}<div class="scl"><span class="tagl ${role}">${role.toUpperCase()}</span> ${esc(nm)}</div>${role === "in" ? `<div>${ownPill(k, true)}</div>` : ""}</div>`;
      };
      x += `<div class="swapcards">${side(p.out, "out")}<div class="arrow">→</div>${side(p.in, "in")}</div>`;
      if ((p.comments || []).length) x += `<div class="cmts">${p.comments.map((c) => `<div class="cmt"><span class="muted">${esc(c.by || "")} · ${esc(c.at || "")}</span> ${esc(c.text)}</div>`).join("")}</div>`;
      return x + (btns ? `<div>${btns}</div>` : "") + `</div>`;
    }).join("");
    const mades = pens.filter((p) => M.pencilStatus(p) === "made"), pencils = pens.filter((p) => M.pencilStatus(p) !== "made");
    if (!S.wtoken && (mades.length || pencils.length)) h += `<div class="muted">Read-only. Add a write token in Data to confirm, change or cancel swaps here.</div>`;
    if (mades.length) h += `<h3>Made by hand — update ManaBox (${mades.length})</h3>` + swapBlock(mades, "todo");
    if (pencils.length) h += `<h3>Pencilled swaps (${pencils.length})</h3>` + swapBlock(pencils, "pencil");
    if (S.wtoken) h += `<button class="btn alt" data-act="addswap" data-slug="${esc(d.slug)}">+ Add a swap</button>`;
    const hist = (d.pencilled || []).map((p, i) => ({ p, i })).filter((x) => ["done", "dropped"].includes(M.pencilStatus(x.p)));
    if (hist.length) {
      const mm = M.deckMap(d, S.idx);
      h += `<h3>Change history (${hist.length})</h3>` + hist.map(({ p, i }) => {
        const dn = M.pencilStatus(p) === "done", shown = M.swapShown(d, p, S.idx, mm);
        const last = (p.log || [])[(p.log || []).length - 1];
        return `<div class="card"><span class="pill ${dn ? (shown ? "ok" : "warn") : ""}">${dn ? (shown ? "done · in ManaBox ✓" : "done · not in ManaBox yet") : "cancelled"}</span>
          <div>${p.out ? `<span class="muted">OUT</span> ${esc(p.out)} ` : ""}${p.in ? `<span class="muted">IN</span> ${esc(p.in)}` : ""}</div>
          ${last ? `<div class="muted">${esc(last.at)} · ${esc(last.by)} · ${esc(last.act)}</div>` : ""}
          ${S.wtoken && lastUndo(p) >= 0 ? `<button class="btn alt" data-act="swap" data-slug="${esc(d.slug)}" data-i="${i}" data-sw="undo">Undo</button>` : ""}</div>`;
      }).join("");
    }
    h += rebuildSection(d);
    const wls = S.wlEval.filter((w) => (w.decks || []).includes(d.slug));
    if (wls.length) h += `<h3>Wishlist</h3>` + wls.map((w) => cardRow(w.key, w.name, 1, "", false, wishPill(w), d) + (w.note ? `<div class="muted">${esc(w.note)}</div>` : "")).join("");
    if ((d.wishlist || []).length) {
      h += `<h3>Wishlist (deck file)</h3>` + d.wishlist.map((w) => { const k = M.keyOf(S.idx, w.name); return cardRow(k, w.name, 1, "", false, ownPill(k, true), d) + (w.note ? `<div class="muted">${esc(w.note)}</div>` : ""); }).join("");
    }
    if ((d.extras || []).length) {
      h += `<h3>Display / extra cards (not in the 100)</h3>` + d.extras.map((x) => { const k = M.keyOf(S.idx, x.name); return cardRow(k, x.name, 1, "", false, `<span class="pill">${esc(x.note || "extra")}</span>`, d); }).join("");
    }
    const groups = {};
    for (const [k, e] of m) { const info = M.cardInfo(S.idx, k); const isCmd = M.commandersOf(d).some((c) => M.keyOf(S.idx, c) === k); (groups[isCmd ? "Commander" : groupOf(info)] = groups[isCmd ? "Commander" : groupOf(info)] || []).push({ k, e, info }); }
    const view = S.dview || "stacks";
    let cards = `<div class="chips vt">${["stacks", "grid", "list"].map((v) => `<button data-act="dview" data-v="${v}" class="${view === v ? "on" : ""}">${{ stacks: "Stacks", grid: "Grid", list: "List" }[v]}</button>`).join("")}</div>`;
    if (view === "list") {
    for (const g of TYPE_ORDER) {
      if (!groups[g]) continue;
      const list = groups[g].sort((a, b) => a.e.name.localeCompare(b.e.name));
      cards += `<h3>${g} (${list.reduce((s, x) => s + x.e.qty, 0)})</h3>` + list.map((x) => cardRow(x.k, x.e.name, x.e.qty, outKeys.has(x.k) ? "out" : "", false, (outKeys.has(x.k) ? `<span class="pill pencil">out</span> ` : "") + (S.rows.length && !M.isBasic(x.e.name) && !S.own.get(x.k) && norm(d.status) === "built" ? `<span class="pill err">not in CSV</span>` : ""), d)).join("");
    }
    } else {
      const tile = (x, last) => {
        const out = outKeys.has(x.k), miss = S.rows.length && !M.isBasic(x.e.name) && !S.own.get(x.k) && norm(d.status) === "built";
        return `<div data-hold class="ac${view === "grid" || last ? " full" : ""}${out ? " out" : ""}" data-act="zoom" data-key="${esc(x.k)}" data-slug="${esc(d.slug)}">${artImg(x.k, x.e.name, d, "normal", "acimg")}${x.e.qty > 1 ? `<span class="qty">${x.e.qty}×</span>` : ""}${out ? `<span class="tag out">OUT</span>` : ""}${miss ? `<span class="tag miss">not in CSV</span>` : ""}</div>`;
      };
      cards += `<div class="${view === "grid" ? "gridv" : "stacks"}">`;
      for (const g of TYPE_ORDER) {
        if (!groups[g]) continue;
        const list = groups[g].sort((a, b) => a.e.name.localeCompare(b.e.name));
        cards += `<div class="stack"><div class="sh">${g}<span>${list.reduce((s2, x) => s2 + x.e.qty, 0)}</span></div>${list.map((x, n) => tile(x, n === list.length - 1)).join("")}</div>`;
      }
      cards += `</div>`;
    }
    return pre + cards + h;
  }
  function chooserResults() {
    const c = S.ch, d = deckBySlug(c.slug), q = norm(c.q || ""), m = M.deckMap(d, S.idx);
    const cmdKeys = new Set(M.commandersOf(d).map((n) => M.keyOf(S.idx, n)));
    if (c.mode === "out") {
      const p = c.i != null ? d.pencilled[c.i] : null;
      let h = "";
      if (p && p.note) {
        const hits = [...m.values()].filter((e) => !cmdKeys.has(e.key) && norm(p.note).includes(norm(e.name)));
        if (hits.length) h += `<div class="muted">Mentioned in the note:</div><div class="chips">${hits.map((e) => `<button class="on" data-act="choose" data-peek="${esc(e.key)}" data-key="${esc(e.key)}">${esc(e.name)}</button>`).join("")}</div>`;
      }
      const items = sortCards(d, [...m.values()].filter((e) => !cmdKeys.has(e.key) && (!q || norm(e.name).includes(q))));
      return h + (items.length ? items.map((e) => { const info = M.cardInfo(S.idx, e.key); return `<div class="cardrow" data-act="choose" data-peek="${esc(e.key)}" data-key="${esc(e.key)}"><div class="t"><span class="n">${artImg(e.key, e.name, d, "art_crop", "thumb")}${esc(e.name)}</span><span class="muted">${esc(groupOf(info))}</span></div></div>`; }).join("") : `<div class="muted">No cards match.</div>`);
    }
    if (q.length < 2) return `<div class="muted">Type at least 2 letters of the card name.</div>`;
    let ci = null;
    for (const n of M.commandersOf(d)) { const inf = M.cardInfo(S.idx, M.keyOf(S.idx, n)); if (inf) ci = (ci || []).concat(inf.ci); }
    const out = [];
    for (const k of Object.keys(S.idx.db)) {
      if (!norm(k).includes(q) || m.has(k)) continue;
      const inf = M.cardInfo(S.idx, k);
      if (!inf || (ci && inf.ci.some((x) => !ci.includes(x)))) continue;
      out.push(inf);
      if (out.length >= 40) break;
    }
    return out.length ? out.map((inf) => `<div class="cardrow" data-act="choose" data-peek="${esc(inf.key)}" data-key="${esc(inf.key)}"><div class="t"><span class="n">${esc(plain(inf.name))}</span><span class="muted">${esc(inf.cost)}</span></div><div class="muted">${esc(inf.type)}${S.own.get(inf.key) ? " · you own it" : ""}</div></div>`).join("") : `<div class="muted">Nothing in this deck's colours matches.</div>`;
  }
  function chooserModal() {
    if (!S.ch) return "";
    const c = S.ch, d = deckBySlug(c.slug);
    if (!d) return "";
    const title = c.mode === "in" ? "Which card comes IN?" : c.pendIn ? `Which card goes OUT for ${plain(c.pendIn)}?` : "Which card goes OUT?";
    return `<div class="modal" data-act="closech"><div class="mbox wide" data-act="noop"><div class="row"><b>${esc(title)}</b><button class="btn alt" data-act="closech">Close</button></div>
      <input type="text" id="chq" placeholder="${c.mode === "in" ? "Search card names…" : "Filter this deck…"}" autocomplete="off" value="${esc(c.q || "")}" style="margin:8px 0">
      <div class="muted">Hover a card to preview it. On a phone, press and hold.</div><div id="chres">${chooserResults()}</div>${c.pendIn ? `<button class="btn alt" data-act="choosenone">Decide the cut later</button>` : ""}</div></div>`;
  }
  function zoomModal() {
    if (!S.zoom) return "";
    const d = deckBySlug(S.zoom.slug), k = S.zoom.key, info = M.cardInfo(S.idx, k), name = info ? info.name : k.replace(/^\?/, "");
    const pr = S.zoom.sid || M.pickSid(S.own, S.idx, k, d), o = S.own.get(k);
    const zi = S.zoom.sid ? `<img class="zimg" alt="" src="${esc(M.artUrl(S.zoom.sid, "normal"))}" data-fb="${esc(M.artByName(name, "normal"))}">` : artImg(k, name, d, "normal", "zimg");
    const copies = o ? `<div class="muted" style="margin-top:6px">Your copies</div>` + o.rows.map((r) => { const pr2 = M.rowAUD(r); return `<div class="muted">${r.qty}× ${esc(r.setName || r.set)} (${esc((r.set || "").toUpperCase())}) #${esc(r.cn)}${/foil|etched/i.test(r.foil || "") ? " · " + esc(r.foil) : ""} · ${esc(r.binder)}${pr2 != null ? " · $" + pr2.toFixed(2) : ""}</div>`; }).join("") : "";
    const wh = S.rows.length ? M.whereIs(k, S.decks, S.idx, S.own, S.claims, S.cfg) : null, nmz = S.zoom.name || name;
    const wl = S.wl.find((w) => norm(w.name) === norm(nmz));
    const where = wh ? `<div class="muted" style="margin-top:6px">${wh.decks.length ? "Played in: " + wh.decks.map((x) => esc(x.name) + (x.status !== "built" ? " (" + esc(x.status) + ")" : "")).join(", ") : "Not in any deck"}${wh.pencilIn.length ? "<br>Pencilled IN for: " + wh.pencilIn.map((x) => esc(x.name)).join(", ") : ""}${wh.pencilOut.length ? "<br>Pencilled OUT of: " + wh.pencilOut.map((x) => esc(x.name)).join(", ") : ""}${wh.total ? `<br>${wh.free} of ${wh.total} in free binders` : ""}</div>` : "";
    const wlbox = S.wtoken ? `<div class="muted" style="margin-top:6px">${wl ? "On the wishlist" + ((wl.decks || []).length ? " for " + esc(wl.decks.map((s2) => (deckBySlug(s2) || { name: s2 }).name || s2).join(", ")) : "") + ". " : ""}Add to wishlist for:</div><div class="row"><select id="wldeck"><option value="">no particular deck</option>${S.decks.map((x) => `<option value="${esc(x.slug)}" ${d && d.slug === x.slug ? "selected" : ""}>${esc(x.name || x.slug)}</option>`).join("")}</select><button class="btn" data-act="wladd" data-name="${esc(nmz)}">Add</button></div>` : "";
    return `<div class="modal" data-act="closezoom"><div class="mbox" data-act="noop">${zi}${oracleBox(info, k)}${copies}
      ${where}${wlbox}<div id="rulings" class="rul" data-sid="${esc(pr || "")}"></div>
      <div>${ownPill(k, true)} ${o ? `<span class="muted">${[...o.binders].map(([b, q]) => esc(b) + " ×" + q).join(", ")}</span>` : ""}</div>
      ${info && d && !/\bLand\b/.test(info.frontType) ? `<div class="muted" style="margin-top:6px">Counts as (for ${esc(d.name || d.slug)}):</div><div class="chips">${M.ROLE_KEYS.map((r) => `<button data-act="role" data-slug="${esc(d.slug)}" data-key="${esc(k)}" data-r="${r}" class="${effRoles(d, k).includes(r) ? "on" : softRole(d, k, r) ? "maybe" : ""}">${{ ramp: "Ramp", draw: "Card advantage", targeted: "Targeted", mass: "Mass" }[r]}</button>`).join("")}${d.roles && d.roles[k] ? `<button data-act="role" data-slug="${esc(d.slug)}" data-key="${esc(k)}" data-r="auto">Reset to auto</button>` : ""}</div>` : ""}
      <button class="btn" data-act="closezoom">Close</button></div></div>`;
  }
  const norm = M.norm;
  function rulHtml(list) {
    if (!list) return `<div class="muted">Couldn't load rulings (needs internet).</div>`;
    if (!list.length) return `<div class="muted">No rulings for this card.</div>`;
    return `<div class="muted" style="margin-top:6px">Rulings (Scryfall)</div>` + list.map((r) => `<div class="rulrow"><span class="muted">${esc(r.published_at)}</span> ${esc(r.comment)}</div>`).join("");
  }
  async function fillRulings() {
    const el = document.getElementById("rulings"); if (!el) return;
    const sid = el.dataset.sid; if (!sid) { el.innerHTML = `<div class="muted">Rulings need a printing ID — this card isn't in the collection.</div>`; return; }
    if (S.rul[sid]) { el.innerHTML = rulHtml(S.rul[sid]); return; }
    el.innerHTML = `<div class="muted">Loading rulings…</div>`;
    let list = null;
    try { const r = await fetch(`https://api.scryfall.com/cards/${sid}/rulings`); if (r.ok) list = (await r.json()).data || []; } catch (e) { /* offline */ }
    if (list) S.rul[sid] = list;
    const now = document.getElementById("rulings"); if (now && now.dataset.sid === sid) now.innerHTML = rulHtml(list);
  }

  /* ---------- Collection tab ---------- */
  const CF = () => S.col;
  const COLS6 = ["W", "U", "B", "R", "G", "C"], COLNAME = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colourless" };
  function colEntries() { if (!S._ce || S._ceRows !== S.rows || S._ceIdx !== S.idx) { S._ce = M.collectionEntries(S.rows, S.idx); S._ceRows = S.rows; S._ceIdx = S.idx; } return S._ce; }
  function colFiltered() {
    const f = CF(), fl = M.filterCollection(colEntries(), { ...f, ciActive: f.ci.size > 0 || !!f.ciDeck });
    return M.sortCollection(fl, f.sort, f.dir);
  }
  function colActiveCount() {
    const f = CF(); return [f.q, f.colors.size, f.ci.size || f.ciDeck, f.mv.size, f.types.size, f.rarity.size, f.set, f.binder, f.foil].filter(Boolean).length;
  }
  function colResults() {
    const f = CF(), all = colEntries(), fl = colFiltered(), shown = fl.slice(0, f.limit);
    const qty = fl.reduce((s, e) => s + e.qty, 0);
    let h = `<div class="muted" style="margin:6px 0">${fl.length} of ${all.length} printings · ${qty} cards${f.binder ? ` · in <b>${esc(f.binder)}</b>` : ""}</div>`;
    if (!fl.length) return h + `<div class="card">Nothing matches those filters.</div>`;
    if (f.layout === "list") {
      h += shown.map((e) => `<div class="cardrow" data-act="zoom" data-key="${esc(e.key)}" data-sid="${esc(e.sid)}" data-peek="${esc(e.key)}"><div class="t"><span class="n"><img class="thumb" loading="lazy" alt="" src="${esc(M.artUrl(e.sid) || M.artByName(e.name))}">${e.qty > 1 ? e.qty + "× " : ""}${esc(e.name)}</span><span class="muted">${esc(e.cost)}</span></div><div class="muted">${esc(e.type)} · ${esc(e.setName)} (${esc(e.set)}) #${esc(e.cn)}${e.rarity ? " · " + esc(e.rarity) : ""}${e.foil ? " · " + esc(e.foil) : ""}${e.price != null ? " · $" + e.price.toFixed(2) : ""}</div></div>`).join("");
    } else {
      h += `<div class="colgrid">` + shown.map((e) => `<div class="ct" data-act="zoom" data-key="${esc(e.key)}" data-sid="${esc(e.sid)}" data-peek="${esc(e.key)}"><img loading="lazy" alt="${esc(e.name)}" src="${esc(M.artUrl(e.sid, "normal") || M.artByName(e.name, "normal"))}"${e.sid ? ` data-fb="${esc(M.artByName(e.name, "normal"))}"` : ""}>${e.qty > 1 ? `<span class="qty">${e.qty}×</span>` : ""}${e.foil ? `<span class="tag foil">${esc(e.foil)}</span>` : ""}</div>`).join("") + `</div>`;
    }
    if (fl.length > shown.length) h += `<button class="btn" data-act="colmore">Show ${Math.min(120, fl.length - shown.length)} more</button>`;
    return h;
  }

  /* ---------- Set checklists: what you have vs what's missing (set contents come from Scryfall) ---------- */
  S.sv = { code: "", mode: "cards", show: "all", rar: new Set(), q: "", layout: "grid", limit: 200, loading: "", err: "", find: "" };
  S.setList = null; S.setCache = {};
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function scry(url) { const r = await fetch(url); if (!r.ok) throw new Error("Scryfall said " + r.status); return r.json(); }
  async function loadSetList() {
    if (S.setList || S._listBusy) return;
    S._listBusy = true;
    const c = lsGet("mtg_setlist");
    if (c && c.at && Date.now() - c.at < 7 * 864e5) { S.setList = c.list; S._listBusy = false; return; }
    S.sv.loading = "Loading the list of sets…"; render();
    try {
      const d = await scry("https://api.scryfall.com/sets");
      S.setList = d.data.map((s) => ({ code: s.code, name: s.name, date: s.released_at || "", type: s.set_type, n: s.printed_size || s.card_count || 0 }));
      lsSet("mtg_setlist", { at: Date.now(), list: S.setList });
    } catch (e) { S.sv.err = "Couldn't load the set list (" + e.message + "). It needs an internet connection."; }
    S.sv.loading = ""; S._listBusy = false; render();
  }
  // Memory first, then the copy remembered on this device (read synchronously so the first render already has it).
  function getSetCards(code, mode) {
    const ck = "mtg_set_" + code + "_" + mode;
    if (S.setCache[ck]) return S.setCache[ck];
    const c = lsGet(ck);
    if (c && c.at && Date.now() - c.at < 3 * 864e5) { S.setCache[ck] = c.cards; return c.cards; }
    return null;
  }
  async function loadSetCards(code, mode) {
    const ck = "mtg_set_" + code + "_" + mode;
    if (getSetCards(code, mode)) return;
    S.sv.loading = "Loading " + code.toUpperCase() + "…"; S.sv.err = ""; render();
    try {
      const q = encodeURIComponent("e:" + code), extra = mode === "prints" ? "&unique=prints&include_extras=true&include_variants=true" : "&unique=cards";
      let url = `https://api.scryfall.com/cards/search?order=set&q=${q}${extra}`, out = [];
      while (url) {
        const d = await scry(url);
        for (const c2 of d.data) out.push({ n: c2.name, cn: String(c2.collector_number), r: c2.rarity, id: c2.id });
        url = d.has_more ? d.next_page : "";
        if (url) { S.sv.loading = `Loading ${code.toUpperCase()}… ${out.length} of ${d.total_cards}`; render(); await sleep(110); }
      }
      S.setCache[ck] = out; lsSet(ck, { at: Date.now(), cards: out });
    } catch (e) { S.sv.err = "Couldn't load that set (" + e.message + "). It needs an internet connection."; }
    S.sv.loading = ""; render();
  }
  function setOwned(code) {
    const mine = colEntries().filter((e) => e.set.toLowerCase() === code), names = new Map(), prints = new Map();
    for (const e of mine) { names.set(e.key, (names.get(e.key) || 0) + e.qty); const k = e.cn.toLowerCase(); prints.set(k, (prints.get(k) || 0) + e.qty); }
    return { names, prints, n: mine.length };
  }
  function setChecklist(code, mode) {
    const cards = getSetCards(code, mode); if (!cards) return null;
    const own = setOwned(code);
    return cards.map((c) => { const key = M.keyOf(S.idx, c.n), qty = mode === "prints" ? (own.prints.get(c.cn.toLowerCase()) || 0) : (own.names.get(key) || 0); return { ...c, key, qty }; });
  }
  function vSets() {
    const v = S.sv;
    let h = "";
    if (v.err) h += `<div class="card lvl-error">${esc(v.err)}</div>`;
    if (v.loading) h += `<div class="card muted">${esc(v.loading)}</div>`;
    if (!v.code) {
      const mine = new Map();
      for (const e of colEntries()) { const c = e.set.toLowerCase(); const m = mine.get(c) || { code: c, name: e.setName, names: new Set(), qty: 0 }; m.names.add(e.key); m.qty += e.qty; mine.set(c, m); }
      const q = v.find.toLowerCase();
      h += `<div class="muted">Pick a set to see every card in it, what you have, and what's missing. The list of cards in a set comes from Scryfall, so it needs an internet connection the first time (then it's remembered).</div>
        <input type="text" id="setfind" placeholder="Find any set by name or code…" value="${esc(v.find)}" autocomplete="off" style="width:100%;margin:8px 0">`;
      let list = [...mine.values()].filter((m) => !q || m.name.toLowerCase().includes(q) || m.code.includes(q)).sort((a, b) => a.name.localeCompare(b.name));
      const rowHtml = (code, name, sub) => `<div class="cardrow" data-act="setopen" data-code="${esc(code)}"><div class="t"><span class="n">${esc(name)} <span class="muted">(${esc(code.toUpperCase())})</span></span><span class="muted">${esc(sub)}</span></div></div>`;
      h += `<h3>Sets you own cards from (${list.length})</h3><div id="setmine">` + (list.map((m) => rowHtml(m.code, m.name, `${m.names.size} different · ${m.qty} cards`)).join("") || `<div class="muted">No match.</div>`) + `</div>`;
      if (q) {
        if (!S.setList) setTimeout(loadSetList, 0);
        const others = (S.setList || []).filter((s) => !mine.has(s.code) && (s.name.toLowerCase().includes(q) || s.code.includes(q))).slice(0, 40);
        h += `<h3>Other sets</h3>` + (S.setList ? (others.map((s) => rowHtml(s.code, s.name, `${s.n} cards · ${s.date.slice(0, 4)}`)).join("") || `<div class="muted">No match.</div>`) : `<div class="muted">Loading the set list…</div>`);
      }
      return h;
    }
    const info = (S.setList || []).find((s) => s.code === v.code), nm = (colEntries().find((e) => e.set.toLowerCase() === v.code) || {}).setName || (info && info.name) || v.code.toUpperCase();
    h += `<button class="back" data-act="setback">← All sets</button><h2>${esc(nm)} <span class="muted">(${esc(v.code.toUpperCase())})</span></h2>
      <div class="chips vt"><button data-act="setmode" data-v="cards" class="${v.mode === "cards" ? "on" : ""}">By card</button><button data-act="setmode" data-v="prints" class="${v.mode === "prints" ? "on" : ""}">Every printing</button></div>
      <div class="muted">${v.mode === "cards" ? "One entry per card. Counts as owned if you have any copy of it from this set." : "Every printing in the set, including variants. Matched on collector number."}</div>`;
    const cl = setChecklist(v.code, v.mode);
    if (!cl) { if (!v.loading && !v.err) setTimeout(() => loadSetCards(v.code, v.mode), 0); return h; }
    const have = cl.filter((c) => c.qty > 0).length, pct = cl.length ? Math.round((have / cl.length) * 100) : 0;
    const byR = (r) => { const t = cl.filter((c) => c.r === r); return t.length ? `${r} ${t.filter((c) => c.qty > 0).length}/${t.length}` : ""; };
    h += `<div class="card"><div class="row"><b>${have} of ${cl.length} cards</b><span class="muted">${pct}%</span></div><div class="bar"><i class="${pct === 100 ? "ok" : ""}" style="width:${pct}%"></i></div>
      <div class="muted">${["common", "uncommon", "rare", "mythic"].map(byR).filter(Boolean).join(" · ")}</div></div>`;
    const chip = (act, val, label, on) => `<button data-act="${act}" data-v="${val}" class="${on ? "on" : ""}">${label}</button>`;
    h += `<div class="chips">${chip("setshow", "all", "All", v.show === "all")}${chip("setshow", "have", "Have " + have, v.show === "have")}${chip("setshow", "missing", "Missing " + (cl.length - have), v.show === "missing")}</div>
      <div class="chips">${["common", "uncommon", "rare", "mythic"].map((r) => chip("setrar", r, r, v.rar.has(r))).join("")}</div>
      <div class="row"><input type="text" id="setq" placeholder="Search this set…" value="${esc(v.q)}" autocomplete="off" style="flex:1"><span class="chips vt" style="margin:0">${chip("setlayout", "grid", "Images", v.layout === "grid")}${chip("setlayout", "list", "List", v.layout === "list")}</span></div>
      <div><button class="btn alt" data-act="setexport">Export missing list</button></div><div id="setres">${setResults(cl)}</div>`;
    return h;
  }
  function setFiltered(cl) {
    const v = S.sv, q = v.q.toLowerCase();
    return cl.filter((c) => (v.show === "all" || (v.show === "have" ? c.qty > 0 : c.qty === 0)) && (!v.rar.size || v.rar.has(c.r)) && (!q || c.n.toLowerCase().includes(q)));
  }
  function setResults(cl) {
    const v = S.sv, fl = setFiltered(cl), shown = fl.slice(0, v.limit);
    let h = `<div class="muted" style="margin:6px 0">${fl.length} shown</div>`;
    if (v.layout === "list") h += shown.map((c) => `<div class="cardrow ${c.qty ? "" : "missing"}" data-act="zoom" data-key="${esc(c.key)}" data-sid="${esc(c.id)}" data-name="${esc(c.n)}"><div class="t"><span class="n">#${esc(c.cn)} ${esc(c.n)}</span><span class="muted">${c.qty ? "have " + c.qty : "missing"} · ${esc(c.r)}</span></div></div>`).join("");
    else h += `<div class="colgrid">` + shown.map((c) => `<div class="ct ${c.qty ? "" : "missing"}" data-act="zoom" data-key="${esc(c.key)}" data-sid="${esc(c.id)}" data-name="${esc(c.n)}" data-peek="${esc(c.key)}"><img loading="lazy" alt="${esc(c.n)}" src="${esc(M.artUrl(c.id, "normal"))}">${c.qty > 1 ? `<span class="qty">${c.qty}×</span>` : ""}<span class="cnum">#${esc(c.cn)}</span></div>`).join("") + `</div>`;
    if (fl.length > shown.length) h += `<button class="btn" data-act="setmore">Show 200 more</button>`;
    return h;
  }

  function vCollection() {
    if (!S.rows.length) return emptyMsg("No collection loaded yet. Add your read token in the Data tab.");
    const f = CF(), all = colEntries();
    const chip = (fld, v, label, on) => `<button data-act="colchip" data-f="${fld}" data-v="${esc(v)}" class="${on ? "on" : ""}">${label}</button>`;
    const pipb = (fld, c, on) => chip(fld, c, `<span class="pip pip-${c}">${c}</span>`, on);
    let h = `<h2>Collection</h2><div class="chips vt"><button data-act="colview" data-v="binders" class="${f.view === "binders" ? "on" : ""}">Binders</button><button data-act="colview" data-v="cards" class="${f.view === "cards" ? "on" : ""}">All cards</button><button data-act="colview" data-v="sets" class="${f.view === "sets" ? "on" : ""}">Sets</button></div>`;
    if (f.view === "sets") return h + vSets();
    if (f.view === "binders") {
      const bs = M.binderSummary(S.rows);
      h += `<div class="muted">${S.rows.reduce((s, r) => s + r.qty, 0)} cards in ${bs.length} binders, worth about $${bs.reduce((s, b) => s + b.value, 0).toFixed(0)} AUD (${S.live ? "live market prices from Scryfall, converted to AUD" : "the prices ManaBox holds, until live prices load"}). Tap a binder to look inside.${S.csvName ? ` Collection updated ${esc(csvDate() || S.csvName)}.` : ""}</div></div>`;
      const tile = (b) => {
        const dk = S.decks.find((d) => norm(d.name) === norm(b.name)), cmd = dk ? M.commandersOf(dk) : [];
        const img = cmd.length ? artImg(M.keyOf(S.idx, cmd[0]), cmd[0], dk, "art_crop", "tileimg") : b.sid ? `<img class="tileimg" loading="lazy" alt="" src="${esc(M.artUrl(b.sid))}">` : "";
        return `<div class="tile" data-act="colbinder" data-b="${esc(b.name)}">${img}<div class="tilein"><b>${esc(b.name)}</b><div class="muted">${b.qty} cards · ${b.unique} different${b.value ? " · $" + b.value.toFixed(0) : ""}</div></div></div>`;
      };
      const isDeck = (b) => /deck/i.test(b.btype), plainB = bs.filter((b) => !isDeck(b)), deckB = bs.filter(isDeck);
      h += `<h3>Collection binders (${plainB.length})</h3><div class="tiles">${plainB.map(tile).join("")}</div>`;
      if (deckB.length) h += `<h3>Decks (${deckB.length})</h3><div class="tiles">${deckB.map(tile).join("")}</div>`;
      return h;
    }
    const sets = [...new Map(all.map((e) => [e.set, e.setName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const binders = [...new Set(S.rows.map((r) => r.binder))].sort((a, b) => a.localeCompare(b));
    const n = colActiveCount();
    h += `<div class="row" style="margin-top:6px"><input type="text" id="colq" placeholder="Search name, type or card text…" value="${esc(f.q)}" autocomplete="off" style="flex:1"><button class="btn alt" data-act="colfilters">Filters${n ? " (" + n + ")" : ""}</button></div>`;
    if (f.open) {
      h += `<div class="card"><div class="muted">Colour</div><div class="chips">${COLS6.map((c) => pipb("colors", c, f.colors.has(c))).join("")}
        <select data-cf="cmode"><option value="any" ${f.cmode === "any" ? "selected" : ""}>any of these</option><option value="all" ${f.cmode === "all" ? "selected" : ""}>all of these</option><option value="exact" ${f.cmode === "exact" ? "selected" : ""}>exactly these</option></select></div>
        <div class="muted">Fits a commander (colour identity within)</div><div class="chips">${["W", "U", "B", "R", "G"].map((c) => pipb("ci", c, f.ci.has(c))).join("")}
        <select data-cf="ciDeck"><option value="">or pick a deck…</option>${S.decks.filter((d) => M.commandersOf(d).length).map((d) => `<option value="${esc(d.slug)}" ${f.ciDeck === d.slug ? "selected" : ""}>${esc(d.name || d.slug)}</option>`).join("")}</select></div>
        <div class="muted">Mana value</div><div class="chips">${[0, 1, 2, 3, 4, 5, 6, 7].map((v) => chip("mv", v, v === 7 ? "7+" : v, f.mv.has(v))).join("")}</div>
        <div class="muted">Type</div><div class="chips">${M.TYPE_CHIPS.map((t) => chip("types", t, t, f.types.has(t))).join("")}</div>
        <div class="muted">Rarity</div><div class="chips">${["common", "uncommon", "rare", "mythic"].map((t) => chip("rarity", t, t, f.rarity.has(t))).join("")}</div>
        <div class="row"><select data-cf="set"><option value="">Any set</option>${sets.map(([c, nm]) => `<option value="${esc(c)}" ${f.set === c ? "selected" : ""}>${esc(nm)} (${esc(c)})</option>`).join("")}</select>
        <select data-cf="binder"><option value="">Any binder</option>${binders.map((b) => `<option value="${esc(b)}" ${f.binder === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>
        <select data-cf="foil"><option value="">Foil or not</option><option value="foil" ${f.foil === "foil" ? "selected" : ""}>Foil only</option><option value="nonfoil" ${f.foil === "nonfoil" ? "selected" : ""}>Non-foil only</option></select></div>
        <div><button class="btn alt" data-act="colclear">Clear all filters</button></div></div>`;
    } else if (f.binder) h += `<div class="chips"><button class="on" data-act="colunbinder">Binder: ${esc(f.binder)} ✕</button></div>`;
    h += `<div class="row"><span><select data-cf="sort">${[["name", "Name"], ["mv", "Mana value"], ["color", "Colour"], ["type", "Type"], ["set", "Set"], ["rarity", "Rarity"], ["qty", "Quantity"], ["price", "Price"]].map(([v, t]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>Sort: ${t}</option>`).join("")}</select> <button class="btn alt" data-act="coldir">${["name", "color", "type", "set"].includes(f.sort) ? (f.dir > 0 ? "A→Z ↑" : "Z→A ↓") : (f.dir > 0 ? "low→high ↑" : "high→low ↓")}</button></span>
      <span class="chips vt" style="margin:0"><button data-act="collayout" data-v="grid" class="${f.layout === "grid" ? "on" : ""}">Images</button><button data-act="collayout" data-v="list" class="${f.layout === "list" ? "on" : ""}">List</button></span></div>`;
    return h + `<div id="colres">${colResults()}</div>`;
  }

  function issueHtml(i) {
    return `<div class="card lvl-${i.level}"><div class="row"><span>${i.card ? `<b>${esc(i.card)}</b> — ` : ""}${esc(i.msg)}</span></div>${i.deckName ? `<div class="muted">${esc(i.deckName)}</div>` : ""}</div>`;
  }
  function vCheck() {
    if (!S.decks.length) return emptyMsg("Load decks first.");
    const counts = { error: 0, todo: 0, warn: 0, info: 0 };
    S.checks.forEach((c) => counts[c.level]++);
    const chip = (l, t) => `<button class="${S.level === l ? "on" : ""}" data-act="level" data-l="${l}">${t}</button>`;
    const list = S.checks.filter((c) => S.level === "all" || c.level === S.level);
    let h = `<h2>Discrepancy check</h2><div class="muted">Re-run on every load. Looks at deck size, singleton, colour identity, DB matches, collection vs deck claims, pencilled swaps and wishlist.${S.csvName ? ` Collection CSV dated ${esc(csvDate() || S.csvName)}.` : " No collection CSV loaded, so ownership checks are skipped."}</div>
      <div class="chips">${chip("all", "All " + S.checks.length)}${chip("error", "Errors " + counts.error)}${chip("todo", "ManaBox to-do " + counts.todo)}${chip("warn", "Warnings " + counts.warn)}${chip("info", "Info " + counts.info)}</div>`;
    h += list.length ? list.map(issueHtml).join("") : `<div class="card">Nothing to report.</div>`;
    return h;
  }

  // Why Own is higher than Spare: copies kept in multi-copy binders, in locked binders/decks, or claimed by planned/pencilled decks.
  function keepReason(x) {
    const o = S.own.get(x.key);
    if (!o || x.total <= x.tradeable) return "";
    const fr = new Set(S.cfg.freeBinders.map(norm)), parts = [];
    for (const [b, q] of o.binders) {
      const nb = norm(b);
      if (fr.has(nb)) continue;
      parts.push(`${q} locked in ${b}`);
    }
    if (x.soft) parts.push(`${x.soft} wanted by a planned or pencilled deck`);
    if (x.keep) parts.push(`${x.keep} kept back (${x.rarity} spares setting)`);
    return parts.join(" · ");
  }
  function vTrades() {
    if (!S.rows.length) return emptyMsg("Load a collection CSV first.");
    const t = M.buildTrades({ own: S.own, claims: S.claims, cfg: S.cfg, idx: S.idx }, S.reserveBy).filter((x) => !(S.minPrice > 0) || (x.unit != null && x.unit >= S.minPrice));
    if (!S.picked) S.picked = new Set(t.map((x) => x.key));
    let h = `<h2>Trade candidates</h2><div class="muted">Spare copies in your free binders that no deck (built, planned or pencilled in) needs. Basics are skipped. Cards you own more of than the Spare number show why underneath.</div>
      <div class="card"><div class="muted">Spares to keep back of each card, by rarity</div><div class="row">${M.RARS.map((r) => `<label class="muted">${r}<br><input type="number" min="0" value="${S.reserveBy[r]}" data-rs="${r}" style="width:64px"></label>`).join("")}</div>
      <div class="row" style="margin-top:8px"><label class="muted">Only show cards worth at least (AUD)<br><input type="number" min="0" step="0.5" value="${S.minPrice || ""}" id="minprice" placeholder="0" style="width:90px"></label>
        <label class="muted">Flag cards worth at least (AUD)<br><input type="number" min="0" step="0.5" value="${S.flagPrice || ""}" id="flagprice" placeholder="off" style="width:90px"></label></div>
      <label class="muted" style="display:block;margin-top:8px"><input type="checkbox" id="showcommitted" ${S.showCommitted ? "checked" : ""}> Show a "In decks" column — and make Own count only the copies not committed to a deck</label>
      <div class="muted">Prices are what ManaBox has on each card in AUD (the price when you added it), not live market prices. Cards with no price are hidden when a minimum is set.</div></div>`;
    if (!t.length) return h + `<div class="card">Nothing spare right now.</div>`;
    h += `<div><button class="btn" data-act="tradecsv">Export ManaBox CSV</button><button class="btn alt" data-act="tradetext">Export text list</button><button class="btn alt" data-act="tradeall">${S.picked.size === t.length ? "Untick all" : "Tick all"}</button></div>
      <div class="muted" style="margin:6px 0">${t.length} cards · ${t.reduce((s, x) => s + x.tradeable, 0)} spare copies · about $${t.reduce((s, x) => s + (x.value || 0), 0).toFixed(2)} AUD in total. Ticked: ${t.filter((x) => S.picked.has(x.key)).length} cards, about $${t.filter((x) => S.picked.has(x.key)).reduce((s, x) => s + (x.value || 0), 0).toFixed(2)} AUD.</div>
      <table><tr><th></th><th>Card</th><th>Spare</th><th>Own</th>${S.showCommitted ? "<th>In decks</th>" : ""}<th>Price</th></tr>` +
      t.map((x) => `<tr class="${S.flagPrice > 0 && x.unit != null && x.unit >= S.flagPrice ? "flag" : ""}"><td><input type="checkbox" data-act="pick" data-key="${esc(x.key)}" ${S.picked.has(x.key) ? "checked" : ""}></td><td>${x.alloc[0] && x.alloc[0].sid ? `<img class="thumb" loading="lazy" alt="" src="${esc(M.artUrl(x.alloc[0].sid))}">` : ""}${esc(x.name)}${keepReason(x) ? `<div class="muted">${esc(keepReason(x))}</div>` : ""}</td><td>${x.tradeable}</td><td class="muted">${S.showCommitted ? x.uncommitted : x.total}</td>${S.showCommitted ? `<td class="muted">${x.committed}</td>` : ""}<td>${x.unit != null ? (S.flagPrice > 0 && x.unit >= S.flagPrice ? "★ " : "") + "$" + x.unit.toFixed(2) : `<span class="muted">—</span>`}</td></tr>`).join("") + `</table>`;
    S._trades = t;
    return h;
  }

  const WSTAT = { missing: ["err", "need to find"], partial: ["warn", "need more copies"], have: ["ok", "have it — swap pending"], placed: ["ok", "in the deck"], unused: ["warn", "in collection, no pending use"] };
  function wishPill(w) {
    const [c, t] = WSTAT[w.status] || ["", w.status];
    let extra = w.status === "partial" ? ` (own ${w.owned} of ${w.need})` : w.status === "missing" && w.need > 1 ? ` (need ${w.need})` : "";
    if (w.status === "missing" && w.madeIn) return `<span class="pill todo">in deck by hand — scan it in</span>`;
    return `<span class="pill ${c}">${esc(t + extra)}</span>`;
  }
  function vWishlist() {
    if (!S.wl.length && !S.decks.some((d) => (d.wishlist || []).length)) return emptyMsg("No wishlist loaded.");
    const sec = (title, list, open) => list.length ? `<h3>${title} (${list.length})</h3>` + list.map((w) => cardRow(w.key, w.name, 1, "", open, wishPill(w) + (w.kind && w.kind !== "want" ? ` <span class="pill">${esc(w.kind)}</span>` : ""), null)
      + `<div class="muted">${esc((w.decks || []).map((sl) => (deckBySlug(sl) || { name: sl }).name || sl).join(", "))}${w.note ? " — " + esc(w.note) : ""}</div>`).join("") : "";
    const ev = S.wlEval;
    const find = ev.filter((w) => ["missing", "partial"].includes(w.status) && !w.madeIn);
    const scan = ev.filter((w) => w.status === "missing" && w.madeIn);
    const have = ev.filter((w) => w.status === "have");
    const unused = ev.filter((w) => w.status === "unused");
    const placed = ev.filter((w) => w.status === "placed");
    let h = `<h2>Wishlist</h2><div class="muted">Cards clear themselves once your collection has enough copies for every deck that wants them. ${S.csvName ? "Based on " + esc(S.csvName) + "." : "Load a collection CSV to clear cards."}</div>`;
    h += sec("Still to find", find) + sec("In a deck by hand, not in ManaBox", scan) + sec("Have it — swap pending", have) + sec("In collection, no pending use — still wanted?", unused);
    if (placed.length) h += `<h3>Cleared: in the deck (${placed.length})</h3><div class="muted">${placed.map((w) => esc(w.name)).join(", ")}</div>`;
    S._need = find.map((w) => w.info ? w.info.name : w.name).sort();
    if (S._need.length) h += `<div style="margin-top:10px"><button class="btn" data-act="wishtext">Export "still to find" as text</button></div>`;
    return h;
  }

  function vData() {
    let h = `<h2>Access</h2><div class="card"><div class="muted">A read-only fine-grained GitHub token (Contents: read, only <b>${esc(S.cfg.dataRepo)}</b>). Stored in this browser only.</div>
      <input type="password" id="tok" placeholder="github_pat_…" autocomplete="off" value="${esc(S.token)}">
      <button class="btn" data-act="savetok">Save &amp; load</button>${S.token ? `<button class="btn alt" data-act="forget">Forget token</button>` : ""}</div>`;
    h += `<h2>Saving changes</h2><div class="card"><div class="muted">Optional. A second fine-grained token with <b>Contents: read and write</b>, only <b>${esc(S.cfg.dataRepo)}</b>. Lets the swap buttons save to the repo. Stored in this browser only.</div>
      <input type="password" id="wtok" placeholder="github_pat_… (write)" autocomplete="off" value="${esc(S.wtoken)}">
      <input type="text" id="who" placeholder="Your name (shown in the swap log)" value="${esc(S.who)}" style="margin-top:6px">
      <label class="muted" style="display:block;margin-top:6px"><input type="checkbox" id="isrev" ${S.reviewer ? "checked" : ""}> I review swaps other people add (shows a "to review" list)</label>
      <button class="btn" data-act="savewtok">Save</button>${S.wtoken ? `<button class="btn alt" data-act="forgetw">Forget write token</button>` : ""}</div>`;
    if (S.wtoken) h += `<h2>Update collection</h2><div class="card"><div class="muted">Pick a fresh ManaBox collection CSV. It replaces <b>collection/ManaBox_Collection.csv</b> in the data repo for everyone using it.</div><input type="file" id="upcsv" accept=".csv"></div>`;
    h += reconCard();
    if (S.log.length) h += `<div class="card muted">${S.log.map(esc).join("<br>")}</div>`;
    h += `<h2>Load local files</h2><div class="card"><div class="muted">Try things without the token: pick a ManaBox CSV and/or deck JSON files. Nothing leaves your device.</div>
      <input type="file" id="local" multiple accept=".csv,.json"></div>`;
    h += `<h2>Collection</h2>`;
    if (!S.rows.length) h += `<div class="card muted">No collection loaded.</div>`;
    else {
      const byB = new Map(); let total = 0;
      for (const r of S.rows) { byB.set(r.binder, (byB.get(r.binder) || 0) + r.qty); total += r.qty; }
      const fr = new Set(S.cfg.freeBinders.map(norm)), mu = new Set(S.cfg.multiCopyBinders.map(norm));
      h += `<div class="card"><b>${total}</b> cards · ${S.own.size} unique · ${esc(S.csvName)}${csvDate() ? " (" + csvDate() + ")" : ""}</div><table><tr><th>Binder</th><th>Cards</th><th></th></tr>` +
        [...byB].sort((a, b) => b[1] - a[1]).map(([b, q]) => `<tr><td>${esc(b)}</td><td>${q}</td><td>${fr.has(norm(b)) ? '<span class="pill ok">free</span>' : mu.has(norm(b)) ? '<span class="pill ok">free (2+ copies)</span>' : '<span class="pill">locked</span>'}</td></tr>`).join("") + `</table>`;
    }
    h += `<h2>Card DB</h2><div class="card muted">${S.idx ? S.dbCount + " cards loaded from " + esc(S.cfg.dbUrl) : "Not loaded yet."}</div>`;
    return h;
  }

  function emptyMsg(t) { return `<div class="card muted">${esc(t)}</div>`; }

  function render() {
    if (typeof peekHide === "function") peekHide();
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    let h = "";
    if (S.error) h += `<div class="card lvl-error">${esc(S.error)}</div>`;
    if (S.busy || S.saving) h += `<div class="card muted">${esc(S.busy || S.saving)}</div>`;
    h += outBox();
    h += { decks: vDecks, collection: vCollection, check: vCheck, trades: vTrades, wishlist: vWishlist, data: vData }[S.tab]();
    h += zoomModal() + chooserModal();
    $("#view").innerHTML = h;
    if (S.zoom) fillRulings();
    if (S.ch && S.ch.focus) { const q = $("#chq"); if (q) q.focus(); S.ch.focus = false; }
  }

  /* ---------- events ---------- */
  /* ---------- card preview: mouse hover, or press-and-hold on touch ---------- */
  const peek = document.createElement("img");
  peek.id = "peek"; peek.alt = "";
  document.body.appendChild(peek);
  let holdTimer = 0, holdShown = false, startXY = null;
  S.noClickUntil = 0;
  function peekShow(key, psid) {
    const d = S.ch ? deckBySlug(S.ch.slug) : S.deck ? deckBySlug(S.deck) : null;
    const nm = (M.cardInfo(S.idx, key) || { name: key.replace(/^\?/, "") }).name;
    const sid = psid || M.pickSid(S.own, S.idx, key, d);
    delete peek.dataset.fb;
    if (sid) peek.dataset.fb = M.artByName(nm, "normal");
    peek.style.visibility = "visible";
    peek.src = sid ? M.artUrl(sid, "normal") : M.artByName(nm, "normal");
    peek.style.display = "block";
  }
  const peekHide = () => { peek.style.display = "none"; };
  const canHover = window.matchMedia && window.matchMedia("(hover:hover)").matches;
  document.addEventListener("mouseover", (ev) => {
    if (!canHover) return;
    const t = ev.target.closest && ev.target.closest("[data-peek]");
    if (t) { peek.className = ""; peekShow(t.dataset.peek, t.dataset.sid); } else peekHide();
  });
  document.addEventListener("mousemove", (ev) => {
    if (peek.style.display !== "block" || peek.className) return;
    const w = 300, h = 420;
    let x = ev.clientX + 22, y = ev.clientY - h / 3;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 22;
    y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    peek.style.left = Math.max(8, x) + "px"; peek.style.top = y + "px";
  });
  document.addEventListener("touchstart", (ev) => {
    S.lastTouch = Date.now();
    const t = ev.target.closest && ev.target.closest("[data-peek],[data-hold]");
    if (!t) return;
    const p = ev.touches[0]; startXY = [p.clientX, p.clientY]; holdShown = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { holdShown = true; peek.className = "touch"; peek.style.left = ""; peek.style.top = ""; peekShow(t.dataset.peek || t.dataset.key, t.dataset.sid); }, 350);
  }, { passive: true });
  document.addEventListener("touchmove", (ev) => {
    if (!startXY || holdShown) return;
    const p = ev.touches[0];
    if (Math.abs(p.clientX - startXY[0]) > 10 || Math.abs(p.clientY - startXY[1]) > 10) clearTimeout(holdTimer);
  }, { passive: true });
  const touchEnd = () => { clearTimeout(holdTimer); if (holdShown) { S.noClickUntil = Date.now() + 600; peekHide(); holdShown = false; } };
  document.addEventListener("touchend", touchEnd);
  document.addEventListener("touchcancel", touchEnd);
  document.addEventListener("contextmenu", (ev) => { if (ev.target.closest && ev.target.closest("[data-peek],.ac,.sc,.mbox,.hero,.tile") && (!canHover || Date.now() - (S.lastTouch || 0) < 1500)) ev.preventDefault(); });
  document.addEventListener("error", (ev) => {
    const i = ev.target;
    if (!i || i.tagName !== "IMG") return;
    if (i.dataset.fb) { i.src = i.dataset.fb; delete i.dataset.fb; } else i.style.visibility = "hidden";
  }, true);
  document.addEventListener("click", async (ev) => {
    if (Date.now() < S.noClickUntil) { ev.preventDefault(); ev.stopPropagation(); return; }
    if (ev.target.closest && ev.target.closest("#refresh")) { forceRefresh(); return; }
    const tabBtn = ev.target.closest("#tabs button");
    if (tabBtn) { S.tab = tabBtn.dataset.tab; S.tk = null; S.out = null; S.zoom = null; S.ch = null; S.deck = null; resetNav(); render(); window.scrollTo(0, 0); return; }
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const a = el.dataset.act;
    if (a === "toggle") { const o = el.querySelector("[data-o]"); if (o) o.hidden = !o.hidden; }
    else if (a === "open") { S.tk = null; S.deck = el.dataset.slug; pushNav("deck"); render(); window.scrollTo(0, 0); }
    else if (a === "back") { S.tk = null; S.deck = null; popNav("deck"); render(); }
    else if (a === "level") { S.level = el.dataset.l; render(); }
    else if (a === "closeout") { S.out = null; render(); }
    else if (a === "copy") { const ok = await copyText(S.out.text); el.textContent = ok ? "Copied ✓" : "Select the text and copy it manually"; }
    else if (a === "download") download(S.out.filename, S.out.text);
    else if (a === "tkopen") { tkOpen(deckBySlug(el.dataset.slug)); pushNav("tick"); render(); window.scrollTo(0, 0); }
    else if (a === "tkback") { scanStop(); S.tk = null; popNav("tick"); render(); }
    else if (a === "tkmode") { tkOpen(deckBySlug(S.tk.slug), el.dataset.m); render(); }
    else if (a === "tkfilter") { S.tk.filter = el.dataset.f; render(); }
    else if (a === "tkflip") { const e = S.tk.entries.find((x) => x.id === el.dataset.id); if (e) { const n = tkGot(e); S.tk.st.got[e.id] = n >= e.qty ? 0 : n + 1; if (!S.tk.st.got[e.id]) delete S.tk.st.diff[e.id]; tkSave(); render(); } }
    else if (a === "tkreset") { if (confirm("Clear every tick for this check?")) { S.tk.st = { got: {}, diff: {}, extra: [], at: "" }; tkSave(); render(); } }
    else if (a === "tkxadd") { const v = ($("#tkx").value || "").trim(); if (v) { const k = M.keyOf(S.idx, v), nm = (M.cardInfo(S.idx, k) || {}).name || v; S.tk.st.extra.push({ name: nm, seen: "" }); tkSave(); render(); } }
    else if (a === "tkxdel") { S.tk.st.extra.splice(+el.dataset.i, 1); tkSave(); render(); }
    else if (a === "tkreport") showOut((deckBySlug(S.tk.slug).name || "") + " — check report", tkReport("report"), S.tk.slug + "_check.txt");
    else if (a === "tklist") showOut((deckBySlug(S.tk.slug).name || "") + " — what's physically here", tkReport("list"), S.tk.slug + "_physical.txt");
    else if (a === "tkscan") tkScan();
    else if (a === "exportdeck") {
      const d = deckBySlug(el.dataset.slug);
      const mode = el.dataset.mode;
      const list = mode === "swaps" ? M.applySwaps(d, S.idx, { only: ["approved", "made"] }) : mode === "physical" ? M.applySwaps(d, S.idx, { only: ["made"] }) : [...M.deckMap(d, S.idx).values()];
      const label = { swaps: " — with confirmed changes", physical: " — as it is physically", current: " — list in ManaBox" }[mode];
      showOut((d.name || d.slug) + label, M.deckText(sortCards(d, list)), d.slug + (mode === "current" ? "" : "_" + mode) + ".txt");
    }
    else if (a === "tradecsv" || a === "tradetext") {
      const sel = (S._trades || []).filter((t) => S.picked.has(t.key));
      if (!sel.length) return;
      if (a === "tradecsv") showOut("Trade binder — ManaBox CSV (" + sel.length + " cards)", M.tradesCSV(sel), "trade_binder.csv");
      else showOut("Trade binder — text list", M.tradesText(sel), "trade_binder.txt");
    }
    else if (a === "tradeall") { const t = S._trades || []; S.picked = S.picked.size === t.length ? new Set() : new Set(t.map((x) => x.key)); render(); }
    else if (a === "pick") { el.checked ? S.picked.add(el.dataset.key) : S.picked.delete(el.dataset.key); render(); }
    else if (a === "wishtext") showOut("Wishlist — still to find", (S._need || []).map((n) => "1 " + n).join("\n"), "wishlist.txt");
    else if (a === "savetok") { S.token = $("#tok").value.trim(); try { localStorage.setItem("mtg_token", S.token); } catch (e) { /* ignore */ } loadAll(); }
    else if (a === "bulkdone") bulkDone();
    else if (a === "stats") { S.statsOpen = !S.statsOpen; render(); }
    else if (a === "statsmode") { S.statsMode = el.dataset.v; render(); }
    else if (a === "statsrole") { S.statsRole = S.statsRole === el.dataset.r ? "" : el.dataset.r; render(); }
    else if (a === "role") {
      const d = deckBySlug(el.dataset.slug), k = el.dataset.key, r = el.dataset.r, cur = effRoles(d, k), was = d.roles ? d.roles[k] : undefined;
      d.roles = d.roles || {};
      if (r === "auto") delete d.roles[k]; else d.roles[k] = cur.includes(r) ? cur.filter((x) => x !== r) : cur.concat(r);
      if (S.wtoken) {
        S.saving = "Saving…"; render();
        try { await saveDeck(d, `Card roles (${d.name || d.slug}): ${k}${S.who ? " [" + S.who + "]" : ""}`); S.saving = ""; }
        catch (e) { if (was) d.roles[k] = was; else delete d.roles[k]; S.error = e.message; S.saving = ""; }
      }
      render();
    }
    else if (a === "tgtedit") { const d = deckBySlug(el.dataset.slug); S.tgtEdit = d.slug; S.tgtPrev = d.targets ? { ...d.targets } : undefined; d.targets = Object.assign({}, (S.cfg && S.cfg.template) || M.DEFAULT_CONFIG.template, d.targets || {}); render(); }
    else if (a === "tgt") { const d = deckBySlug(S.tgtEdit), r = el.dataset.r; d.targets[r] = Math.max(0, d.targets[r] + Number(el.dataset.v)); render(); }
    else if (a === "tgtcancel") { const d = deckBySlug(S.tgtEdit); if (S.tgtPrev) d.targets = S.tgtPrev; else delete d.targets; S.tgtEdit = null; render(); }
    else if (a === "tgtsave" || a === "tgtreset") {
      const d = deckBySlug(el.dataset.slug), prev = S.tgtPrev, base = (S.cfg && S.cfg.template) || M.DEFAULT_CONFIG.template;
      if (a === "tgtreset") delete d.targets; else { const o = {}; for (const k of Object.keys(base)) if (d.targets[k] !== base[k]) o[k] = d.targets[k]; if (Object.keys(o).length) d.targets = o; else delete d.targets; }
      S.tgtEdit = null; S.saving = "Saving…"; render();
      try { await saveDeck(d, `Stat targets (${d.name || d.slug})${S.who ? " [" + S.who + "]" : ""}`); S.saving = ""; }
      catch (e) { if (prev) d.targets = prev; else delete d.targets; S.error = e.message; S.saving = ""; }
      render();
    }
    else if (a === "setopen") { S.sv.code = el.dataset.code; S.sv.show = "all"; S.sv.rar = new Set(); S.sv.q = ""; S.sv.limit = 200; S.sv.err = ""; render(); window.scrollTo(0, 0); }
    else if (a === "setback") { S.sv.code = ""; S.sv.err = ""; render(); }
    else if (a === "setmode") { S.sv.mode = el.dataset.v; S.sv.err = ""; S.sv.limit = 200; render(); }
    else if (a === "setshow") { S.sv.show = el.dataset.v; S.sv.limit = 200; render(); }
    else if (a === "setlayout") { S.sv.layout = el.dataset.v; render(); }
    else if (a === "setrar") { const s = S.sv.rar, r = el.dataset.v; if (s.has(r)) s.delete(r); else s.add(r); S.sv.limit = 200; render(); }
    else if (a === "setmore") { S.sv.limit += 200; const cl = setChecklist(S.sv.code, S.sv.mode); if (cl) $("#setres").innerHTML = setResults(cl); }
    else if (a === "setexport") { const cl = setChecklist(S.sv.code, S.sv.mode) || [], miss = cl.filter((c) => !c.qty); showOut(`Missing from ${S.sv.code.toUpperCase()} (${miss.length})`, miss.map((c) => `1 ${c.n} (${S.sv.code.toUpperCase()}) ${c.cn}`).join("\n"), `missing_${S.sv.code}.txt`); }
    else if (a === "wladd") {
      const sel = $("#wldeck"), slug = sel ? sel.value : "", nm = el.dataset.name;
      S.saving = "Saving…"; render();
      try { await addToWishlist(nm, slug, "Added in the app" + (S.who ? " by " + S.who : "")); S.saving = ""; recompute(); }
      catch (e) { S.error = e.message; S.saving = ""; }
      render();
    }
    else if (a === "upg") { S.upgOpen = !S.upgOpen; S.statsOpen = false; S.upgLimit = 25; render(); }
    else if (a === "upgrole") { S.upgRole = el.dataset.r; S.upgLimit = 25; render(); }
    else if (a === "upgmore") { S.upgLimit = (S.upgLimit || 25) + 25; render(); }
    else if (a === "upgpick") { openModalNav(); S.ch = { mode: "out", slug: el.dataset.slug, i: null, q: "", pendIn: el.dataset.key }; render(); }
    else if (a === "colview") { CF().view = el.dataset.v; render(); }
    else if (a === "collayout") { CF().layout = el.dataset.v; CF().limit = 120; render(); }
    else if (a === "colfilters") { CF().open = !CF().open; render(); }
    else if (a === "colmore") { CF().limit += 120; $("#colres").innerHTML = colResults(); }
    else if (a === "coldir") { CF().dir *= -1; render(); }
    else if (a === "colbinder") { const f = CF(); f.binder = el.dataset.b; f.view = "cards"; f.limit = 120; render(); window.scrollTo(0, 0); }
    else if (a === "colunbinder") { CF().binder = ""; CF().limit = 120; render(); }
    else if (a === "colclear") { const f = CF(); Object.assign(f, { q: "", colors: new Set(), ci: new Set(), ciDeck: "", mv: new Set(), types: new Set(), rarity: new Set(), set: "", binder: "", foil: "", limit: 120 }); render(); }
    else if (a === "colchip") { const f = CF(), s = f[el.dataset.f], v = el.dataset.f === "mv" ? +el.dataset.v : el.dataset.v; if (s.has(v)) s.delete(v); else s.add(v); if (el.dataset.f === "ci") f.ciDeck = ""; f.limit = 120; render(); }
    else if (a === "dview") { S.dview = el.dataset.v; try { localStorage.setItem("mtg_dview", S.dview); } catch (e) { /* ignore */ } render(); }
    else if (a === "zoom") { openModalNav(); S.zoom = { key: el.dataset.key, slug: el.dataset.slug, sid: el.dataset.sid || "", name: el.dataset.name || "" }; render(); }
    else if (a === "closezoom") { S.zoom = null; popNav("modal"); render(); }
    else if (a === "noop") { /* keep modal open */ }
    else if (a === "addswap") addSwap(el.dataset.slug);
    else if (a === "rebuildcsv" || a === "rebuildtext") {
      const d = deckBySlug(el.dataset.slug), al = M.allocateDeck(d, rebuildList(d), S.own, S.cfg);
      if (a === "rebuildcsv") showOut((d.name || d.slug) + " — rebuild from collection (ManaBox CSV)", M.rebuildCSV(d, sortCards(d, al.lines)), d.slug + "_rebuild.csv");
      else showOut((d.name || d.slug) + " — rebuild from collection (text)", M.rebuildText(sortCards(d, al.lines)), d.slug + "_rebuild.txt");
    }
    else if (a === "swap") {
      const sw = el.dataset.sw;
      if (sw === "change" || sw === "changeout") { openModalNav(); S.ch = { mode: sw === "change" ? "in" : "out", slug: el.dataset.slug, i: +el.dataset.i, q: "", focus: sw === "change" }; render(); }
      else swapAction(el.dataset.slug, +el.dataset.i, sw);
    }
    else if (a === "choose") {
      const c = S.ch, key = el.dataset.key; if (!c) return;
      if (c.i == null && c.mode === "in") { S.ch = { mode: "out", slug: c.slug, i: null, q: "", pendIn: key }; render(); return; }
      S.ch = null; popNav("modal"); render();
      if (c.i == null) addSwap(c.slug, { in: c.pendIn, out: key });
      else swapAction(c.slug, c.i, c.mode === "in" ? "change" : "changeout", key);
    }
    else if (a === "choosenone") { const c = S.ch; S.ch = null; popNav("modal"); render(); if (c && c.pendIn) addSwap(c.slug, { in: c.pendIn, out: "" }); }
    else if (a === "closech") { S.ch = null; popNav("modal"); render(); }
    else if (a === "savewtok") { S.wtoken = $("#wtok").value.trim(); S.who = $("#who").value.trim(); try { localStorage.setItem("mtg_wtoken", S.wtoken); localStorage.setItem("mtg_who", S.who); } catch (e) { /* ignore */ } render(); }
    else if (a === "forgetw") { S.wtoken = ""; try { localStorage.removeItem("mtg_wtoken"); } catch (e) { /* ignore */ } render(); }
    else if (a === "forget") { S.token = ""; try { localStorage.removeItem("mtg_token"); } catch (e) { /* ignore */ } S.decks = []; S.rows = []; S.csvName = ""; recompute(); status(); render(); }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "findq") { S.findq = ev.target.value; peekHide(); clearTimeout(S._findT); S._findT = setTimeout(() => { const r = $("#findres"); if (r) r.innerHTML = findResults(S.findq); }, 150); return; }
    if (ev.target.id === "setq") { S.sv.q = ev.target.value; S.sv.limit = 200; peekHide(); clearTimeout(S._setT); S._setT = setTimeout(() => { const cl = setChecklist(S.sv.code, S.sv.mode), r = $("#setres"); if (cl && r) r.innerHTML = setResults(cl); }, 150); return; }
    if (ev.target.id === "setfind") { S.sv.find = ev.target.value; clearTimeout(S._setT); S._setT = setTimeout(() => { render(); const i = $("#setfind"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); return; }
    if (ev.target.id === "colq") { CF().q = ev.target.value; CF().limit = 120; peekHide(); clearTimeout(S._colT); S._colT = setTimeout(() => { const r = $("#colres"); if (r) r.innerHTML = colResults(); }, 150); return; }
    if (ev.target.id === "chq" && S.ch) { S.ch.q = ev.target.value; peekHide(); $("#chres").innerHTML = chooserResults(); }
  });
  document.addEventListener("change", async (ev) => {
    if (ev.target.dataset && ev.target.dataset.cf) {
      const f = CF(), k = ev.target.dataset.cf, v = ev.target.value;
      if (k === "ciDeck") { f.ciDeck = v; f.ci = new Set(); const dk = S.decks.find((d) => d.slug === v); if (dk) { const cmd = M.commandersOf(dk); const set = new Set(); cmd.forEach((c) => { const i = M.cardInfo(S.idx, M.keyOf(S.idx, c)); if (i) i.ci.forEach((x) => set.add(x)); }); f.ci = set; f.ciDeck = v; } }
      else if (k === "sort") f.sort = v; else f[k] = v;
      f.limit = 120; render(); return;
    }
    if (ev.target.id === "rbmode") { S.rbmode = ev.target.value; render(); }
    else if (ev.target.dataset && ev.target.dataset.pick) {
      const d = deckBySlug(ev.target.dataset.slug), key = ev.target.dataset.pick, v = ev.target.value;
      d.picks = d.picks || {};
      const was = d.picks[key];
      if (!v) delete d.picks[key]; else { const [sid, foil] = v.split("|"); d.picks[key] = { sid, foil }; }
      if (S.wtoken) {
        S.saving = "Saving…"; render();
        try { await saveDeck(d, `Printing pick (${d.name || d.slug}): ${key}${S.who ? " [" + S.who + "]" : ""}`); S.saving = ""; recompute(); }
        catch (e) { if (was) d.picks[key] = was; else delete d.picks[key]; S.error = e.message; S.saving = ""; }
      }
      render();
    }
    else if (ev.target.id === "isrev") { S.reviewer = ev.target.checked; try { localStorage.setItem("mtg_reviewer", S.reviewer ? "1" : "0"); } catch (e) { /* ignore */ } }
    else if (ev.target.dataset && ev.target.dataset.rs) { S.reserveBy[ev.target.dataset.rs] = Math.max(0, parseInt(ev.target.value, 10) || 0); S.picked = null; render(); }
    else if (ev.target.id === "minprice") { S.minPrice = Math.max(0, parseFloat(ev.target.value) || 0); S.picked = null; render(); }
    else if (ev.target.id === "flagprice") { S.flagPrice = Math.max(0, parseFloat(ev.target.value) || 0); render(); }
    else if (ev.target.id === "showcommitted") { S.showCommitted = ev.target.checked; render(); }
    else if (ev.target.id === "upcsv") { const f = ev.target.files[0]; if (f) uploadCollection(f); }
    else if (ev.target.id === "local") {
      S.error = "";
      try {
        if (!S.idx) await loadDB();
        for (const f of ev.target.files) {
          const text = await f.text();
          if (/\.csv$/i.test(f.name)) { S.rows = M.parseCollection(text); S.csvName = f.name; }
          else {
            const d = JSON.parse(text); d.slug = f.name.replace(/\.json$/i, "");
            S.decks = S.decks.filter((x) => x.slug !== d.slug).concat(d);
          }
        }
      } catch (e) { S.error = e.message; }
      S.busy = ""; recompute(); status(); render();
    }
  });

  status(); render();
  if (S.token) loadAll();
})();
