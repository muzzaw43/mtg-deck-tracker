/* MTG Deck Tracker – UI. Reads a private GitHub data repo with a read-only token; swap buttons save with an optional write token. */
(function () {
  "use strict";
  const M = window.MTG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = {
    tab: "decks", deck: null, token: "", cfg: { ...M.DEFAULT_CONFIG },
    idx: null, rows: [], csvName: "", own: new Map(), decks: [], claims: { hard: new Map(), soft: new Map() },
    wtoken: "", who: "", saving: "", log: [], wl: [], wlEval: [], checks: [], level: "all", reserve: 0, picked: null, out: null, error: "", busy: "", dbCount: 0,
  };
  try { S.token = localStorage.getItem("mtg_token") || ""; S.wtoken = localStorage.getItem("mtg_wtoken") || ""; S.who = localStorage.getItem("mtg_who") || ""; } catch (e) { /* storage blocked */ }

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
      if (csvs.length) { name = csvs[csvs.length - 1].name; text = await gh("collection/" + name, true); }
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
    const body = { ...d }; delete body.slug; delete body._sha; delete body._orig;
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
  async function swapAction(slug, i, act) {
    const d = deckBySlug(slug), p = d && (d.pencilled || [])[i];
    if (!p) return;
    const before = JSON.stringify(p), at = new Date().toISOString().slice(0, 10), by = S.who || "me";
    const label = (p.in || "?") + (p.out ? " for " + p.out : "");
    let msg = "";
    if (act === "approve") { p.status = "approved"; msg = "Approved"; }
    else if (act === "made") { p.status = "made"; msg = "Made by hand"; }
    else if (act === "done") { p.status = "done"; msg = "Done in ManaBox"; }
    else if (act === "revert") { p.status = "pencilled"; msg = "Back to pencilled"; }
    else if (act === "cancel") { if (!confirm("Cancel this swap?\n" + label)) return; p.status = "dropped"; msg = "Cancelled"; }
    else if (act === "change") {
      const nm = (prompt("Which card went IN instead? (exact name; blank to keep " + (p.in || "none") + ")", "") || "").trim();
      if (!nm) return;
      const k = M.resolve(S.idx, nm);
      if (!k) { S.error = `"${nm}" is not in the card DB — check the spelling (nothing saved).`; render(); return; }
      p.log = (p.log || []).concat({ at, by, act: "changed IN", from: p.in || "" });
      p.note = ((p.note ? p.note + " · " : "") + "was " + (p.in || "—")).trim();
      p.in = k; msg = "Changed IN to " + k;
    }
    p.log = (p.log || []).concat({ at, by, act: msg });
    S.error = ""; S.saving = "Saving…"; render();
    try { await saveDeck(d, `Swap (${d.name || d.slug}): ${msg} — ${label}${S.who ? " [" + S.who + "]" : ""}`); S.saving = ""; recompute(); }
    catch (e) { d.pencilled[i] = JSON.parse(before); S.error = e.message; S.saving = ""; }
    status(); render();
  }

  function recompute() {
    if (!S.idx) { S.own = new Map(); S.checks = []; S.wlEval = []; return; }
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
    return S.decks.map((d) => {
      const m = M.deckMap(d, S.idx), tot = M.deckTotal(m), is = issuesFor(d.slug);
      const er = is.filter((i) => i.level === "error").length, wa = is.filter((i) => i.level === "warn").length;
      const act = M.activePencils(d), mm = new Map();
      const todo = act.filter((p) => M.pencilStatus(p) === "made" && !M.isReflected(d, p, S.idx)).length;
      const pc = act.filter((p) => M.pencilStatus(p) !== "made").length;
      const wn = S.wlEval.filter((w) => (w.decks || []).includes(d.slug) && ["missing", "partial"].includes(w.status)).length;
      return `<div class="card click" data-act="open" data-slug="${esc(d.slug)}"><div class="row"><b>${esc(d.name || d.slug)}</b><span class="pill">${esc(d.status || "planned")}</span></div>
        <div class="muted">${esc(M.commandersOf(d).join(" + "))} · ${tot} cards</div>
        <div>${todo ? `<span class="pill todo">${todo} to do in ManaBox</span> ` : ""}${pc ? `<span class="pill pencil">${pc} pencilled</span> ` : ""}${er ? `<span class="pill err">${er} errors</span> ` : ""}${wa ? `<span class="pill warn">${wa} warnings</span> ` : ""}${wn ? `<span class="pill">${wn} on wishlist</span>` : ""}</div></div>`;
    }).join("");
  }

  function vDeck(d) {
    if (!d) { S.deck = null; return vDecks(); }
    const m = M.deckMap(d, S.idx), pens = M.activePencils(d);
    const outKeys = new Set(pens.filter((p) => p.out).map((p) => M.keyOf(S.idx, p.out)));
    let h = `<button class="back" data-act="back">← All decks</button><h2>${esc(d.name || d.slug)}</h2>
      <div class="muted">${esc(M.commandersOf(d).join(" + "))} · ${esc(d.status || "planned")} · ${M.deckTotal(m)} cards${d.updated ? " · updated " + esc(d.updated) : ""}</div>
      <div><button class="btn" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="current">Export list</button>
      ${pens.some((p) => M.pencilStatus(p) === "made") ? `<button class="btn alt" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="physical">Export list as it is physically</button>` : ""}
      ${pens.length ? `<button class="btn alt" data-act="exportdeck" data-slug="${esc(d.slug)}" data-mode="swaps">Export with all swaps applied</button>` : ""}</div>`;
    const is = issuesFor(d.slug);
    if (is.length) h += `<h3>Checks</h3>` + is.map(issueHtml).join("");
    const btn = (i, act, txt, alt) => `<button class="btn${alt ? " alt" : ""}" data-act="swap" data-slug="${esc(d.slug)}" data-i="${i}" data-sw="${act}">${txt}</button>`;
    const swapBlock = (list, cls) => list.map((p) => {
      const i = (d.pencilled || []).indexOf(p), st = M.pencilStatus(p);
      const btns = !S.wtoken ? "" : st === "made" ? btn(i, "done", "Mark done") + btn(i, "revert", "Undo", 1) + btn(i, "change", "Different card", 1)
        : (st === "approved" ? "" : btn(i, "approve", "Approve")) + btn(i, "made", "I made it") + btn(i, "change", "Different card", 1) + btn(i, "cancel", "Cancel", 1);
      let x = `<div class="card"><span class="pill ${cls}">${esc(p.status || "pencilled")}</span> ${p.note ? `<span class="muted">${esc(p.note)}</span>` : ""}`;
      if (p.out) x += `<div class="muted">OUT</div>` + cardRow(M.keyOf(S.idx, p.out), p.out, 1, "out", true, "", d);
      if (p.in) { const k = M.keyOf(S.idx, p.in); x += `<div class="muted">IN</div>` + cardRow(k, p.in, 1, "in", true, ownPill(k, true), d); }
      return x + (btns ? `<div>${btns}</div>` : "") + `</div>`;
    }).join("");
    const mades = pens.filter((p) => M.pencilStatus(p) === "made"), pencils = pens.filter((p) => M.pencilStatus(p) !== "made");
    if (!S.wtoken && (mades.length || pencils.length)) h += `<div class="muted">Read-only. Add a write token in Data to confirm, change or cancel swaps here.</div>`;
    if (mades.length) h += `<h3>Made by hand — update ManaBox (${mades.length})</h3>` + swapBlock(mades, "todo");
    if (pencils.length) h += `<h3>Pencilled swaps (${pencils.length})</h3>` + swapBlock(pencils, "pencil");
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
    for (const g of TYPE_ORDER) {
      if (!groups[g]) continue;
      const list = groups[g].sort((a, b) => a.e.name.localeCompare(b.e.name));
      h += `<h3>${g} (${list.reduce((s, x) => s + x.e.qty, 0)})</h3>` + list.map((x) => cardRow(x.k, x.e.name, x.e.qty, outKeys.has(x.k) ? "out" : "", false, (outKeys.has(x.k) ? `<span class="pill pencil">out</span> ` : "") + (S.rows.length && !M.isBasic(x.e.name) && !S.own.get(x.k) && norm(d.status) === "built" ? `<span class="pill err">not in CSV</span>` : ""), d)).join("");
    }
    return h;
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

  function vTrades() {
    if (!S.rows.length) return emptyMsg("Load a collection CSV first.");
    const t = M.buildTrades({ own: S.own, claims: S.claims, cfg: S.cfg, idx: S.idx }, S.reserve);
    if (!S.picked) S.picked = new Set(t.map((x) => x.key));
    let h = `<h2>Trade candidates</h2><div class="muted">Spare copies in your free binders that no deck (built, planned or pencilled in) needs. Basics are skipped.</div>
      <div class="row" style="margin-top:8px"><span>Keep this many spares of each</span><input type="number" min="0" value="${S.reserve}" id="reserve" style="width:70px"></div>`;
    if (!t.length) return h + `<div class="card">Nothing spare right now.</div>`;
    h += `<div><button class="btn" data-act="tradecsv">Export ManaBox CSV</button><button class="btn alt" data-act="tradetext">Export text list</button><button class="btn alt" data-act="tradeall">${S.picked.size === t.length ? "Untick all" : "Tick all"}</button></div>
      <table><tr><th></th><th>Card</th><th>Spare</th><th>Own</th></tr>` +
      t.map((x) => `<tr><td><input type="checkbox" data-act="pick" data-key="${esc(x.key)}" ${S.picked.has(x.key) ? "checked" : ""}></td><td>${x.alloc[0] && x.alloc[0].sid ? `<img class="thumb" loading="lazy" alt="" src="${esc(M.artUrl(x.alloc[0].sid))}">` : ""}${esc(x.name)}</td><td>${x.tradeable}</td><td class="muted">${x.total}</td></tr>`).join("") + `</table>`;
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
    $("#view").innerHTML = h;
  }

  /* ---------- events ---------- */
  document.addEventListener("error", (ev) => {
    const i = ev.target;
    if (!i || i.tagName !== "IMG") return;
    if (i.dataset.fb) { i.src = i.dataset.fb; delete i.dataset.fb; } else i.style.visibility = "hidden";
  }, true);
  document.addEventListener("click", async (ev) => {
    const tabBtn = ev.target.closest("#tabs button");
    if (tabBtn) { S.tab = tabBtn.dataset.tab; S.out = null; if (S.tab !== "decks") S.deck = null; render(); window.scrollTo(0, 0); return; }
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
      const list = mode === "swaps" ? M.applySwaps(d, S.idx) : mode === "physical" ? M.applySwaps(d, S.idx, { only: ["made"] }) : [...M.deckMap(d, S.idx).values()];
      const label = { swaps: " — with all swaps applied", physical: " — as it is physically", current: " — list in ManaBox" }[mode];
      showOut((d.name || d.slug) + label, M.deckText(list), d.slug + (mode === "current" ? "" : "_" + mode) + ".txt");
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
    else if (a === "swap") swapAction(el.dataset.slug, +el.dataset.i, el.dataset.sw);
    else if (a === "savewtok") { S.wtoken = $("#wtok").value.trim(); S.who = $("#who").value.trim(); try { localStorage.setItem("mtg_wtoken", S.wtoken); localStorage.setItem("mtg_who", S.who); } catch (e) { /* ignore */ } render(); }
    else if (a === "forgetw") { S.wtoken = ""; try { localStorage.removeItem("mtg_wtoken"); } catch (e) { /* ignore */ } render(); }
    else if (a === "forget") { S.token = ""; try { localStorage.removeItem("mtg_token"); } catch (e) { /* ignore */ } S.decks = []; S.rows = []; S.csvName = ""; recompute(); status(); render(); }
  });
  document.addEventListener("change", async (ev) => {
    if (ev.target.id === "reserve") { S.reserve = Math.max(0, parseInt(ev.target.value, 10) || 0); S.picked = null; render(); }
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
