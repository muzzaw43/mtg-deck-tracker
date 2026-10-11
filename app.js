/* MTG Deck Tracker – UI. Reads a private GitHub data repo with a read-only token; swap buttons save with an optional write token. */
(function () {
  "use strict";
  const M = window.MTG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = {
    tab: "decks", deck: null, token: "", cfg: { ...M.DEFAULT_CONFIG },
    idx: null, rows: [], csvName: "", own: new Map(), decks: [], claims: { hard: new Map(), soft: new Map() },
    wtoken: "", who: "", statsOpen: false, statsMode: "swaps", statsRole: "", dview: "stacks", zoom: null, saving: "", log: [], wl: [], wlEval: [], checks: [], level: "all", reserve: 0, picked: null, out: null, error: "", busy: "", dbCount: 0,
  };
  try { S.token = localStorage.getItem("mtg_token") || ""; S.wtoken = localStorage.getItem("mtg_wtoken") || ""; S.who = localStorage.getItem("mtg_who") || ""; S.dview = localStorage.getItem("mtg_dview") || "stacks"; } catch (e) { /* storage blocked */ }

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
      S.log.push(`Decks found: ${S.decks.length}` + (deckFiles.length ? "" : " (no .json files in decks/)"));
      S.log.push(text ? `Collection: ${name} (${S.rows.length} rows)` : "Collection: no .csv found in collection/");
      S.log.push(`Card DB: ${S.dbCount} cards`);
      if (S.decks.length && S.tab === "data") S.tab = "decks";
    } catch (e) { S.error = e.message; }
    S.busy = ""; try { recompute(); } catch (e) { S.error = "Loaded, but processing failed: " + e.message; } status(); render();
  }

  /* ---------- saving (needs a write token) ---------- */
  const b64 = (str) => { const by = new TextEncoder().encode(str); let bin = ""; by.forEach((c) => { bin += String.fromCharCode(c); }); return btoa(bin); };
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
      S.rows = rows; S.csvName = "ManaBox_Collection.csv";
      S.log.push(`Uploaded ${file.name}: ${rows.length} rows (was ${oldN})`);
      S.saving = ""; recompute(); S.tab = "data"; S.deck = null;
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
  async function addSwap(slug, pre) {
    const d = deckBySlug(slug);
    if (!d || !S.wtoken) return;
    if (!pre) { S.ch = { mode: "in", slug, i: null, q: "", focus: true }; render(); return; }
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
    d.pencilled = d.pencilled || [];
    d.pencilled.push({ out: plain(ko), in: plain(ki), status: "pencilled", note: "", log: [{ at: new Date().toISOString().slice(0, 10), by: S.who || "me", act: "Added" }] });
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
    if (act === "undo") {
      const k = lastUndo(p);
      if (k < 0) return;
      const e = p.log[k];
      if (!confirm(`${SW_TEXT.undo}\n\n${label}\nBack to: ${prevOf(e)}${e.fromIn ? " (IN: " + e.fromIn + ")" : ""}`)) return;
      p.status = prevOf(e);
      if (e.fromIn !== undefined) p.in = e.fromIn;
      if (e.fromOut !== undefined) p.out = e.fromOut;
      if (e.noteBefore !== undefined) p.note = e.noteBefore;
      p.log = p.log.filter((_, n) => n !== k);
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
    return `<div class="cardrow ${cls || ""}" data-act="toggle"><div class="t"><span class="n">${artImg(key, name, deck, "art_crop", "thumb")}${qty > 1 ? qty + "× " : ""}${esc(name)}</span><span>${extra || ""}</span></div><div ${open ? "" : "hidden"} data-o>${artImg(key, name, deck, "art_crop", "bigart")}${oracleBox(info, key)}</div></div>`;
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
  function vDecks() {
    if (S.deck) return vDeck(deckBySlug(S.deck));
    if (!S.decks.length) return emptyMsg("No decks loaded yet.");
    return `<div class="tiles">` + S.decks.map((d) => {
      const m = M.deckMap(d, S.idx), tot = M.deckTotal(m), is = issuesFor(d.slug);
      const er = is.filter((i) => i.level === "error").length, wa = is.filter((i) => i.level === "warn").length;
      const act = M.activePencils(d), mm = new Map();
      const todo = act.filter((p) => M.pencilStatus(p) === "made" && !M.isReflected(d, p, S.idx)).length;
      const pc = act.filter((p) => M.pencilStatus(p) !== "made").length;
      const wn = S.wlEval.filter((w) => (w.decks || []).includes(d.slug) && ["missing", "partial"].includes(w.status)).length;
      const cm = M.commandersOf(d);
      return `<div class="tile" data-act="open" data-slug="${esc(d.slug)}">${cm.length ? artImg(M.keyOf(S.idx, cm[0]), cm[0], d, "art_crop", "tileimg") : ""}<div class="tilein"><div class="row"><b>${esc(d.name || d.slug)}</b><span class="pill">${esc(d.status || "planned")}</span></div>
        <div class="muted">${esc(cm.join(" + "))} · ${tot} cards</div>
        <div>${todo ? `<span class="pill todo">${todo} to do in ManaBox</span> ` : ""}${pc ? `<span class="pill pencil">${pc} pencilled</span> ` : ""}${er ? `<span class="pill err">${er} errors</span> ` : ""}${wa ? `<span class="pill warn">${wa} warnings</span> ` : ""}${wn ? `<span class="pill">${wn} on wishlist</span>` : ""}</div></div></div>`;
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
  function statsPanel(d) {
    const mode = S.statsMode || "swaps", st = M.deckStats(d, S.idx, statsList(d), S.cfg), T = st.targets;
    let h = `<div class="card stats"><div class="row"><b>Deck stats</b><button class="btn alt" data-act="stats">Close</button></div>
      <div class="chips vt"><button data-act="statsmode" data-v="swaps" class="${mode === "swaps" ? "on" : ""}">With confirmed changes</button><button data-act="statsmode" data-v="current" class="${mode === "current" ? "on" : ""}">As ManaBox shows it</button></div>
      <div class="muted">${st.total} cards plus ${st.commander.length ? esc(st.commander.map((c) => c.name).join(" + ")) : "no commander set"}. The commander isn't counted below.${st.unknown.length ? ` Not in the DB: ${esc(st.unknown.join(", "))}.` : ""}</div>`;
    h += `<h3>Command Zone template</h3><div class="muted">Roles are guessed from each card's text and can overlap (a card can count in two rows). Open a row, tap a card, and switch its roles if the guess is wrong.</div>`;
    for (const k of ["lands", "ramp", "draw", "targeted", "mass", "plan"]) {
      const have = st.counts[k], want = T[k], diff = have - want, pct = Math.min(100, Math.round((have / (want || 1)) * 100));
      const cls = k === "plan" ? "" : have >= want ? "ok" : have >= want - 1 ? "warn" : "err";
      const open = S.statsRole === k;
      h += `<div class="trow" data-act="statsrole" data-r="${k}"><div class="row"><span>${ROLE_LABEL[k]}</span><span><b>${have}</b> <span class="muted">/ ${k === "plan" ? "~" : ""}${want}</span> ${k === "plan" ? "" : `<span class="pill ${cls}">${diff >= 0 ? "+" + diff : diff}</span>`}</span></div><div class="bar"><i class="${cls}" style="width:${pct}%"></i></div></div>`;
      if (open) {
        const list = st.roles[ROLE_STAT[k]].map((x) => ({ ...x, name: (M.cardInfo(S.idx, x.key) || { name: x.key }).name })).sort((a, b) => a.name.localeCompare(b.name));
        h += `<div class="chips">${list.map((x) => `<button data-act="zoom" data-key="${esc(x.key)}" data-slug="${esc(d.slug)}">${x.qty > 1 ? x.qty + "× " : ""}${esc(plain(x.name))}</button>`).join("") || `<span class="muted">None.</span>`}</div>`;
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

  function vDeck(d) {
    if (!d) { S.deck = null; return vDecks(); }
    const m = M.deckMap(d, S.idx), pens = M.activePencils(d);
    const outKeys = new Set(pens.filter((p) => p.out).map((p) => M.keyOf(S.idx, p.out)));
    const cmds = M.commandersOf(d), ck = cmds.length ? M.keyOf(S.idx, cmds[0]) : "";
    const nMade = pens.filter((p) => M.pencilStatus(p) === "made").length, nPen = pens.length - nMade;
    let h = `<button class="back" data-act="back">← All decks</button>
      <div class="hero">${ck ? artImg(ck, cmds[0], d, "art_crop", "heroimg") : ""}<div class="heroin"><div class="herot">${esc(d.name || d.slug)}</div>
      <div class="herom">${esc(cmds.join(" + "))}</div>
      <div class="herom">${esc(d.status || "planned")} · ${M.deckTotal(m)} cards${nMade ? ` · ${nMade} made by hand` : ""}${nPen ? ` · ${nPen} pencilled` : ""}${d.updated ? " · updated " + esc(d.updated) : ""}</div></div></div>
      <div><button class="btn" data-act="stats">${S.statsOpen ? "Hide stats" : "Deck stats"}</button><button class="btn" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="current">Export list</button>
      ${pens.some((p) => M.pencilStatus(p) === "made") ? `<button class="btn alt" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="physical">Export list as it is physically</button>` : ""}
      ${pens.some((p) => ["approved", "made"].includes(M.pencilStatus(p))) ? `<button class="btn alt" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="swaps">Export with confirmed changes</button>` : ""}</div>
      ${pens.some((p) => M.pencilStatus(p) === "pencilled") ? `<div class="muted">Pencilled swaps aren't in any export until you approve them.</div>` : ""}`;
    const pre = h + (S.statsOpen ? statsPanel(d) : ""); h = "";
    const is = issuesFor(d.slug);
    if (is.length) h += `<h3>Checks</h3>` + is.map(issueHtml).join("");
    const btn = (i, act, txt, alt) => `<button class="btn${alt ? " alt" : ""}" data-act="swap" data-slug="${esc(d.slug)}" data-i="${i}" data-sw="${act}">${txt}</button>`;
    const swapBlock = (list, cls) => list.map((p) => {
      const i = (d.pencilled || []).indexOf(p), st = M.pencilStatus(p);
      const und = lastUndo(p) >= 0 ? btn(i, "undo", "Undo last change", 1) : "";
      const btns = !S.wtoken ? "" : st === "made" ? btn(i, "done", "Mark done") + btn(i, "change", "Different card", 1) + btn(i, "cancel", "Cancel", 1) + und
        : (st === "approved" ? "" : btn(i, "approve", "Approve")) + btn(i, "made", "I made it") + btn(i, "change", "Different IN card", 1) + btn(i, "changeout", p.out ? "Change cut" : "Choose cut", 1) + btn(i, "cancel", "Cancel", 1) + und;
      let x = `<div class="card"><span class="pill ${cls}">${esc(p.status || "pencilled")}</span> ${p.note ? `<span class="muted">${esc(p.note)}</span>` : ""}`;
      const side = (nm, role) => {
        if (!nm) return `<div class="sc empty"><div class="scimg">${role === "out" ? "Cut not chosen yet" : "No card"}</div><div class="scl">${role.toUpperCase()}</div></div>`;
        const k = M.keyOf(S.idx, nm);
        return `<div class="sc ${role}" data-act="zoom" data-key="${esc(k)}" data-slug="${esc(d.slug)}">${artImg(k, nm, d, "normal", "scimg")}<div class="scl"><span class="tagl ${role}">${role.toUpperCase()}</span> ${esc(nm)}</div>${role === "in" ? `<div>${ownPill(k, true)}</div>` : ""}</div>`;
      };
      x += `<div class="swapcards">${side(p.out, "out")}<div class="arrow">→</div>${side(p.in, "in")}</div>`;
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
        return `<div class="ac${view === "grid" || last ? " full" : ""}${out ? " out" : ""}" data-act="zoom" data-key="${esc(x.k)}" data-slug="${esc(d.slug)}">${artImg(x.k, x.e.name, d, "normal", "acimg")}${x.e.qty > 1 ? `<span class="qty">${x.e.qty}×</span>` : ""}${out ? `<span class="tag out">OUT</span>` : ""}${miss ? `<span class="tag miss">not in CSV</span>` : ""}</div>`;
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
        if (hits.length) h += `<div class="muted">Mentioned in the note:</div><div class="chips">${hits.map((e) => `<button class="on" data-act="choose" data-key="${esc(e.key)}">${esc(e.name)}</button>`).join("")}</div>`;
      }
      const items = sortCards(d, [...m.values()].filter((e) => !cmdKeys.has(e.key) && (!q || norm(e.name).includes(q))));
      return h + (items.length ? items.map((e) => { const info = M.cardInfo(S.idx, e.key); return `<div class="cardrow" data-act="choose" data-key="${esc(e.key)}"><div class="t"><span class="n">${artImg(e.key, e.name, d, "art_crop", "thumb")}${esc(e.name)}</span><span class="muted">${esc(groupOf(info))}</span></div></div>`; }).join("") : `<div class="muted">No cards match.</div>`);
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
    return out.length ? out.map((inf) => `<div class="cardrow" data-act="choose" data-key="${esc(inf.key)}"><div class="t"><span class="n">${esc(plain(inf.name))}</span><span class="muted">${esc(inf.cost)}</span></div><div class="muted">${esc(inf.type)}${S.own.get(inf.key) ? " · you own it" : ""}</div></div>`).join("") : `<div class="muted">Nothing in this deck's colours matches.</div>`;
  }
  function chooserModal() {
    if (!S.ch) return "";
    const c = S.ch, d = deckBySlug(c.slug);
    if (!d) return "";
    const title = c.mode === "in" ? "Which card comes IN?" : c.pendIn ? `Which card goes OUT for ${plain(c.pendIn)}?` : "Which card goes OUT?";
    return `<div class="modal" data-act="closech"><div class="mbox wide" data-act="noop"><div class="row"><b>${esc(title)}</b><button class="btn alt" data-act="closech">Close</button></div>
      <input type="text" id="chq" placeholder="${c.mode === "in" ? "Search card names…" : "Filter this deck…"}" autocomplete="off" value="${esc(c.q || "")}" style="margin:8px 0">
      <div id="chres">${chooserResults()}</div>${c.pendIn ? `<button class="btn alt" data-act="choosenone">Decide the cut later</button>` : ""}</div></div>`;
  }
  function zoomModal() {
    if (!S.zoom) return "";
    const d = deckBySlug(S.zoom.slug), k = S.zoom.key, info = M.cardInfo(S.idx, k), name = info ? info.name : k.replace(/^\?/, "");
    const pr = M.pickSid(S.own, S.idx, k, d), o = S.own.get(k);
    return `<div class="modal" data-act="closezoom"><div class="mbox" data-act="noop">${artImg(k, name, d, "normal", "zimg")}${oracleBox(info, k)}
      <div>${ownPill(k, true)} ${o ? `<span class="muted">${[...o.binders].map(([b, q]) => esc(b) + " ×" + q).join(", ")}</span>` : ""}</div>
      ${info && d && !/\bLand\b/.test(info.frontType) ? `<div class="muted" style="margin-top:6px">Counts as (for ${esc(d.name || d.slug)}):</div><div class="chips">${M.ROLE_KEYS.map((r) => `<button data-act="role" data-slug="${esc(d.slug)}" data-key="${esc(k)}" data-r="${r}" class="${effRoles(d, k).includes(r) ? "on" : ""}">${{ ramp: "Ramp", draw: "Card advantage", targeted: "Targeted", mass: "Mass" }[r]}</button>`).join("")}${d.roles && d.roles[k] ? `<button data-act="role" data-slug="${esc(d.slug)}" data-key="${esc(k)}" data-r="auto">Reset to auto</button>` : ""}</div>` : ""}
      <button class="btn" data-act="closezoom">Close</button></div></div>`;
  }
  const norm = M.norm;

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
    const fr = new Set(S.cfg.freeBinders.map(norm)), mu = new Set(S.cfg.multiCopyBinders.map(norm)), parts = [];
    for (const [b, q] of o.binders) {
      const nb = norm(b);
      if (fr.has(nb)) continue;
      if (mu.has(nb)) parts.push(q >= 2 ? `1 stays in ${b} (only extras are spare)` : `${q} stays in ${b} (single copy)`);
      else parts.push(`${q} locked in ${b}`);
    }
    if (x.soft) parts.push(`${x.soft} wanted by a planned or pencilled deck`);
    if (S.reserve) parts.push(`${S.reserve} kept by your reserve setting`);
    return parts.join(" · ");
  }
  function vTrades() {
    if (!S.rows.length) return emptyMsg("Load a collection CSV first.");
    const t = M.buildTrades({ own: S.own, claims: S.claims, cfg: S.cfg, idx: S.idx }, S.reserve);
    if (!S.picked) S.picked = new Set(t.map((x) => x.key));
    let h = `<h2>Trade candidates</h2><div class="muted">Spare copies in your free binders that no deck (built, planned or pencilled in) needs. Basics are skipped. In "The Hobbit" and "Avatar" the first copy of a card stays put, so only extras count. Cards you own more of than the Spare number show why underneath.</div>
      <div class="row" style="margin-top:8px"><span>Keep this many spares of each</span><input type="number" min="0" value="${S.reserve}" id="reserve" style="width:70px"></div>`;
    if (!t.length) return h + `<div class="card">Nothing spare right now.</div>`;
    h += `<div><button class="btn" data-act="tradecsv">Export ManaBox CSV</button><button class="btn alt" data-act="tradetext">Export text list</button><button class="btn alt" data-act="tradeall">${S.picked.size === t.length ? "Untick all" : "Tick all"}</button></div>
      <table><tr><th></th><th>Card</th><th>Spare</th><th>Own</th></tr>` +
      t.map((x) => `<tr><td><input type="checkbox" data-act="pick" data-key="${esc(x.key)}" ${S.picked.has(x.key) ? "checked" : ""}></td><td>${x.alloc[0] && x.alloc[0].sid ? `<img class="thumb" loading="lazy" alt="" src="${esc(M.artUrl(x.alloc[0].sid))}">` : ""}${esc(x.name)}${keepReason(x) ? `<div class="muted">${esc(keepReason(x))}</div>` : ""}</td><td>${x.tradeable}</td><td class="muted">${x.total}</td></tr>`).join("") + `</table>`;
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
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    let h = "";
    if (S.error) h += `<div class="card lvl-error">${esc(S.error)}</div>`;
    if (S.busy || S.saving) h += `<div class="card muted">${esc(S.busy || S.saving)}</div>`;
    h += outBox();
    h += { decks: vDecks, check: vCheck, trades: vTrades, wishlist: vWishlist, data: vData }[S.tab]();
    h += zoomModal() + chooserModal();
    $("#view").innerHTML = h;
    if (S.ch && S.ch.focus) { const q = $("#chq"); if (q) q.focus(); S.ch.focus = false; }
  }

  /* ---------- events ---------- */
  document.addEventListener("error", (ev) => {
    const i = ev.target;
    if (!i || i.tagName !== "IMG") return;
    if (i.dataset.fb) { i.src = i.dataset.fb; delete i.dataset.fb; } else i.style.visibility = "hidden";
  }, true);
  document.addEventListener("click", async (ev) => {
    const tabBtn = ev.target.closest("#tabs button");
    if (tabBtn) { S.tab = tabBtn.dataset.tab; S.out = null; S.zoom = null; S.ch = null; if (S.tab !== "decks") S.deck = null; render(); window.scrollTo(0, 0); return; }
    const el = ev.target.closest("[data-act]");
    if (!el) return;
    const a = el.dataset.act;
    if (a === "toggle") { const o = el.querySelector("[data-o]"); if (o) o.hidden = !o.hidden; }
    else if (a === "open") { S.deck = el.dataset.slug; render(); window.scrollTo(0, 0); }
    else if (a === "back") { S.deck = null; render(); }
    else if (a === "level") { S.level = el.dataset.l; render(); }
    else if (a === "closeout") { S.out = null; render(); }
    else if (a === "copy") { const ok = await copyText(S.out.text); el.textContent = ok ? "Copied ✓" : "Select the text and copy it manually"; }
    else if (a === "download") download(S.out.filename, S.out.text);
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
    else if (a === "pick") { el.checked ? S.picked.add(el.dataset.key) : S.picked.delete(el.dataset.key); }
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
    else if (a === "dview") { S.dview = el.dataset.v; try { localStorage.setItem("mtg_dview", S.dview); } catch (e) { /* ignore */ } render(); }
    else if (a === "zoom") { S.zoom = { key: el.dataset.key, slug: el.dataset.slug }; render(); }
    else if (a === "closezoom") { S.zoom = null; render(); }
    else if (a === "noop") { /* keep modal open */ }
    else if (a === "addswap") addSwap(el.dataset.slug);
    else if (a === "rebuildcsv" || a === "rebuildtext") {
      const d = deckBySlug(el.dataset.slug), al = M.allocateDeck(d, rebuildList(d), S.own, S.cfg);
      if (a === "rebuildcsv") showOut((d.name || d.slug) + " — rebuild from collection (ManaBox CSV)", M.rebuildCSV(d, sortCards(d, al.lines)), d.slug + "_rebuild.csv");
      else showOut((d.name || d.slug) + " — rebuild from collection (text)", M.rebuildText(sortCards(d, al.lines)), d.slug + "_rebuild.txt");
    }
    else if (a === "swap") {
      const sw = el.dataset.sw;
      if (sw === "change" || sw === "changeout") { S.ch = { mode: sw === "change" ? "in" : "out", slug: el.dataset.slug, i: +el.dataset.i, q: "", focus: sw === "change" }; render(); }
      else swapAction(el.dataset.slug, +el.dataset.i, sw);
    }
    else if (a === "choose") {
      const c = S.ch, key = el.dataset.key; if (!c) return;
      if (c.i == null && c.mode === "in") { S.ch = { mode: "out", slug: c.slug, i: null, q: "", pendIn: key }; render(); return; }
      S.ch = null; render();
      if (c.i == null) addSwap(c.slug, { in: c.pendIn, out: key });
      else swapAction(c.slug, c.i, c.mode === "in" ? "change" : "changeout", key);
    }
    else if (a === "choosenone") { const c = S.ch; S.ch = null; render(); if (c && c.pendIn) addSwap(c.slug, { in: c.pendIn, out: "" }); }
    else if (a === "closech") { S.ch = null; render(); }
    else if (a === "savewtok") { S.wtoken = $("#wtok").value.trim(); S.who = $("#who").value.trim(); try { localStorage.setItem("mtg_wtoken", S.wtoken); localStorage.setItem("mtg_who", S.who); } catch (e) { /* ignore */ } render(); }
    else if (a === "forgetw") { S.wtoken = ""; try { localStorage.removeItem("mtg_wtoken"); } catch (e) { /* ignore */ } render(); }
    else if (a === "forget") { S.token = ""; try { localStorage.removeItem("mtg_token"); } catch (e) { /* ignore */ } S.decks = []; S.rows = []; S.csvName = ""; recompute(); status(); render(); }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "chq" && S.ch) { S.ch.q = ev.target.value; $("#chres").innerHTML = chooserResults(); }
  });
  document.addEventListener("change", async (ev) => {
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
    else if (ev.target.id === "reserve") { S.reserve = Math.max(0, parseInt(ev.target.value, 10) || 0); S.picked = null; render(); }
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
