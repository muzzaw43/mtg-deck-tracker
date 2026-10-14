/* MTG Deck Tracker – pure logic (no DOM). Works in the browser (window.MTG) and in Node (require). */
(function (root) {
  "use strict";

  const BASICS = new Set([
    "plains", "island", "swamp", "mountain", "forest", "wastes",
    "snow-covered plains", "snow-covered island", "snow-covered swamp",
    "snow-covered mountain", "snow-covered forest", "snow-covered wastes",
  ]);
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const isBasic = (n) => BASICS.has(norm(n));

  // site-config.js (loaded first) lets a fork point at its own data repo without touching this file.
  const SITE = (typeof window !== "undefined" && window.MTG_SITE) || {};
  const DEFAULT_CONFIG = {
    owner: SITE.owner || "muzzaw43",
    dataRepo: SITE.dataRepo || "mtg-deck-data",
    branch: SITE.branch || "main",
    dbUrl: SITE.dbUrl || "https://raw.githubusercontent.com/muzzaw43/mw-data/refs/heads/main/mtg_cards_slim.json",
    // Cards in these binders are free to use / trade.
    freeBinders: ["Not in use", "edge of eternities", "The Hobbit", "Avatar"],
    // Free only for cards held 2+ times in that binder (one copy stays put, rest are free).
    multiCopyBinders: [],
    // Command Zone category template (baseline count check for a 99 + commander deck).
    template: { lands: 38, ramp: 10, draw: 12, targeted: 12, mass: 6, plan: 30 },
  };

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = [];
    let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
      else if (c === "\r") { /* skip */ }
      else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function parseCollection(text) {
    text = text.replace(/^﻿/, "");
    const rows = parseCSV(text).filter((r) => r.length > 1 || (r[0] || "").trim());
    if (!rows.length) return [];
    const h = rows[0].map(norm);
    const col = (n) => h.indexOf(norm(n));
    const c = {
      binder: col("Binder Name"), btype: col("Binder Type"), name: col("Name"),
      set: col("Set code"), cn: col("Collector number"), foil: col("Foil"),
      qty: col("Quantity"), sid: col("Scryfall ID"), price: col("Purchase price"),
      setName: col("Set name"), cur: col("Purchase price currency"), rarity: col("Rarity"), mbid: col("ManaBox ID"), cond: col("Condition"), lang: col("Language"),
    };
    if (c.name < 0 || c.qty < 0)
      throw new Error("This doesn't look like a ManaBox export (needs Name and Quantity columns).");
    const get = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");
    return rows.slice(1).map((r) => ({
      binder: get(r, c.binder) || "(no binder)",
      btype: get(r, c.btype),
      name: get(r, c.name),
      set: get(r, c.set),
      cn: get(r, c.cn),
      foil: get(r, c.foil),
      qty: parseInt(get(r, c.qty), 10) || 0,
      sid: get(r, c.sid),
      price: get(r, c.price), cur: get(r, c.cur),
      setName: get(r, c.setName), rarity: get(r, c.rarity), mbid: get(r, c.mbid), cond: get(r, c.cond), lang: get(r, c.lang),
    })).filter((x) => x.name && x.qty > 0);
  }

  /* ---------- Card DB ---------- */
  function buildIndex(db) {
    const byKey = new Map(), front = new Map();
    for (const k of Object.keys(db)) {
      byKey.set(norm(k), k);
      if (k.includes(" // ")) {
        const nf = norm(k.split(" // ")[0]);
        if (!front.has(nf)) front.set(nf, k);
      }
    }
    return { db, byKey, front };
  }
  function resolve(idx, name) {
    if (!idx) return null;
    const n = norm(name);
    return idx.byKey.get(n) || idx.front.get(n) || idx.byKey.get(norm(String(name).split(" // ")[0])) || null;
  }
  const keyOf = (idx, name) => resolve(idx, name) || "?" + norm(name);

  function cardInfo(idx, key) {
    const faces = idx && idx.db[key];
    if (!faces || !faces.length) return null;
    const ci = (faces[0].colorIdentity || "").split(",").map((s) => s.trim()).filter(Boolean);
    return {
      key,
      name: key,
      type: faces.map((f) => f.type || "").join(" // "),
      frontType: faces[0].type || "",
      cost: faces.map((f) => f.manaCost || "").join(" // "),
      mv: faces[0].manaValue,
      ci,
      text: faces.map((f) => (faces.length > 1 && f.faceName ? f.faceName + ": " : "") + (f.text || "")).join("\n——\n"),
      legal: faces.every((f) => f.commanderLegal !== false),
      colors: (faces[0].colors || "").split(",").map((s) => s.trim()).filter(Boolean),
      pt: faces[0].power != null && faces[0].power !== "" ? faces[0].power + "/" + faces[0].toughness : "",
      keywords: faces.map((f) => f.keywords || "").filter(Boolean).join(", "),
      anyNumber: faces.some((f) => /any number of cards named/i.test(f.text || "")),
    };
  }

  /* ---------- Collection ownership ---------- */
  function buildOwnership(rows, idx, cfg) {
    const free = new Set(cfg.freeBinders.map(norm));
    const multi = new Set(cfg.multiCopyBinders.map(norm));
    const own = new Map();
    for (const r of rows) {
      const key = keyOf(idx, r.name);
      let o = own.get(key);
      if (!o) { o = { key, name: resolve(idx, r.name) || r.name, total: 0, free: 0, binders: new Map(), rows: [] }; own.set(key, o); }
      o.total += r.qty;
      o.binders.set(r.binder, (o.binders.get(r.binder) || 0) + r.qty);
      o.rows.push(r);
    }
    for (const o of own.values()) {
      for (const [b, q] of o.binders) {
        const nb = norm(b);
        if (free.has(nb)) o.free += q;
        else if (multi.has(nb) && q >= 2) o.free += q - 1;
      }
    }
    return own;
  }

  /* ---------- Decks ---------- */
  const activePencils = (deck) => (deck.pencilled || []).filter((p) => !["done", "dropped"].includes(norm(p.status)));
  const commandersOf = (deck) => (Array.isArray(deck.commander) ? deck.commander : deck.commander ? [deck.commander] : []);

  function deckMap(deck, idx) {
    const m = new Map();
    for (const c of deck._mb || deck.cards || []) {
      const key = keyOf(idx, c.name);
      const e = m.get(key) || { key, name: resolve(idx, c.name) || c.name, qty: 0 };
      e.qty += c.qty == null ? 1 : c.qty;
      m.set(key, e);
    }
    return m;
  }
  // The live ManaBox list for a deck = the CSV rows in the deck binder with the same name (falls back to the saved snapshot).
  function syncDeckLists(decks, rows) {
    const by = new Map();
    for (const r of rows || []) {
      if (norm(r.btype) !== "deck") continue;
      const k = norm(r.binder);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ name: r.name, qty: r.qty });
    }
    for (const d of decks) {
      const l = by.get(norm(d.name || ""));
      if (!l) { delete d._mb; continue; }
      // display copies listed in deck.extras sit in the binder but are not part of the 100
      const ex = new Map();
      for (const x of d.extras || []) ex.set(norm(x.name), (ex.get(norm(x.name)) || 0) + 1);
      d._mb = l.map((c) => { const n = ex.get(norm(c.name)) || 0; const take = Math.min(n, c.qty); if (take) ex.set(norm(c.name), n - take); return { name: c.name, qty: c.qty - take }; }).filter((c) => c.qty > 0);
    }
  }
  // Does the ManaBox list already show this swap (OUT gone and IN present)? Works for any status.
  function swapShown(deck, p, idx, m) {
    m = m || deckMap(deck, idx);
    return (!p.out || !m.has(keyOf(idx, p.out))) && (!p.in || m.has(keyOf(idx, p.in))) && !!(p.out || p.in);
  }
  const deckTotal = (m) => [...m.values()].reduce((s, e) => s + e.qty, 0);

  const pencilStatus = (p) => norm(p.status || "pencilled");
  // "made" = physically swapped but ManaBox not updated yet. If the CSV deck list already shows it, it is "reflected".
  function isReflected(deck, p, idx, m) {
    m = m || deckMap(deck, idx);
    const outGone = !p.out || !m.has(keyOf(idx, p.out));
    const inThere = !p.in || m.has(keyOf(idx, p.in));
    return pencilStatus(p) === "made" && outGone && inThere;
  }
  // opts.only: array of statuses to apply (default: every active swap)
  function applySwaps(deck, idx, opts) {
    const only = opts && opts.only;
    const base = deckMap(deck, idx);
    const m = deckMap(deck, idx);
    for (const p of activePencils(deck)) {
      if (only && !only.includes(pencilStatus(p))) continue;
      if (isReflected(deck, p, idx, base)) continue;
      if (p.out) {
        const k = keyOf(idx, p.out), e = m.get(k);
        if (e) { e.qty -= 1; if (e.qty <= 0) m.delete(k); }
      }
      if (p.in) {
        const k = keyOf(idx, p.in), e = m.get(k);
        if (e) e.qty += 1; else m.set(k, { key: k, name: resolve(idx, p.in) || p.in, qty: 1 });
      }
    }
    return [...m.values()];
  }
  const deckText = (list) => list.map((c) => `${c.qty} ${c.name}`).join("\n");

  /* ---------- Claims ---------- */
  // hard = copies the built decks use; soft = planned decks + pencilled-in cards that would need a free copy.
  function buildClaims(decks, idx) {
    const hard = new Map(), soft = new Map();
    const add = (map, key, deck, qty) => {
      const l = map.get(key) || []; l.push({ deck: deck.slug, deckName: deck.name, qty }); map.set(key, l);
    };
    for (const d of decks) {
      const st = norm(d.status || "planned");
      if (st === "retired") continue;
      if (st === "built") {
        // what is physically in the deck: CSV list plus swaps already made by hand
        for (const e of applySwaps(d, idx, { only: ["made"] })) add(hard, e.key, d, e.qty);
        for (const p of activePencils(d)) {
          if (pencilStatus(p) === "made" || !p.in) continue;
          const k = keyOf(idx, p.in);
          add(soft, k, d, 1);
        }
      } else {
        for (const e of applySwaps(d, idx)) add(soft, e.key, d, e.qty);
      }
    }
    return { hard, soft };
  }
  const sumQty = (l) => (l || []).reduce((s, x) => s + x.qty, 0);

  /* ---------- Checks ---------- */
  function runChecks(ctx) {
    const { decks, idx, own, claims } = ctx;
    const out = [];
    const add = (level, deck, card, msg) =>
      out.push({ level, deck: deck ? deck.slug : null, deckName: deck ? deck.name : "", card: card || "", msg });
    const haveCollection = own && own.size > 0;

    for (const d of decks) {
      const st = norm(d.status || "planned");
      const built = st === "built";
      if (st === "retired") continue;
      const m = deckMap(d, idx);
      const total = deckTotal(m);
      if (total !== 100) add(built ? "error" : "info", d, "", `${total} cards in the list (Commander needs 100)`);

      const cmdKeys = commandersOf(d).map((n) => keyOf(idx, n));
      if (!cmdKeys.length) add("warn", d, "", "No commander set on this deck");
      let cmdCI = null;
      for (const ck of cmdKeys) {
        const info = cardInfo(idx, ck);
        if (!info) { add("error", d, ck.replace(/^\?/, ""), "Commander not found in the card DB"); continue; }
        cmdCI = (cmdCI || []).concat(info.ci);
        if (!m.has(ck)) add("error", d, info.name, "Commander is not in the card list");
      }

      for (const [key, e] of m) {
        const info = cardInfo(idx, key);
        if (!info) { add("error", d, e.name, "Not found in the card DB"); continue; }
        if (info.legal === false) add("info", d, info.name, "The card DB flags this as not Commander-legal. That flag looks unreliable for some cards (it also marks plain legal cards), so double-check it before acting on it.");
        if (cmdCI && info.ci.some((c) => !cmdCI.includes(c)))
          add("error", d, info.name, `Colour identity ${info.ci.join("") || "C"} is outside the commander's (${[...new Set(cmdCI)].join("") || "C"})`);
        if (e.qty > 1 && !isBasic(info.name) && !info.anyNumber)
          add("error", d, info.name, `${e.qty} copies in a singleton deck`);
        if (haveCollection && built && !isBasic(info.name) && !(own.get(key) || { total: 0 }).total)
          add("warn", d, info.name, "Not in the collection CSV (CSV out of date, or list wrong?)");
      }

      for (const p of activePencils(d)) {
        const pst = pencilStatus(p);
        const label = `${p.out || "—"} → ${p.in || "—"}`;
        const ko = p.out ? keyOf(idx, p.out) : null, ki = p.in ? keyOf(idx, p.in) : null;
        const inInfo = ki ? cardInfo(idx, ki) : null;
        if (p.in && !inInfo) { add("error", d, p.in, `IN card not found in the card DB [${label}]`); continue; }
        if (inInfo && cmdCI && inInfo.ci.some((c) => !cmdCI.includes(c)))
          add("error", d, inInfo.name, `IN card is outside the commander's colour identity [${label}]`);
        if (pst === "made") {
          if (isReflected(d, p, idx, m)) {
            add("info", d, p.in || p.out, `ManaBox already shows this swap — mark it done [${label}]`);
          } else {
            add("todo", d, p.in || p.out, "Made by hand — update ManaBox: " + [p.out ? "remove " + p.out : "", p.in ? "add " + p.in : ""].filter(Boolean).join(", "));
            if (haveCollection && inInfo && !isBasic(inInfo.name) && !own.get(ki))
              add("todo", d, inInfo.name, "Not in the collection CSV — scan it into ManaBox");
          }
          continue;
        }
        if (p.out && !m.has(ko)) add("warn", d, p.out, `Pencilled OUT isn't in the list (already swapped?) [${label}]`);
        if (inInfo) {
          if (m.has(ki) && !isBasic(inInfo.name)) add("warn", d, inInfo.name, `Pencilled IN is already in the list [${label}]`);
          if (haveCollection && !isBasic(inInfo.name)) {
            const o = own.get(ki);
            if (!o) add("info", d, inInfo.name, `Pencilled IN isn't owned yet [${label}]`);
            else if (o.free - sumQty(claims.soft.get(ki)) < 0 || o.free === 0)
              add("warn", d, inInfo.name, `Owned but no free copy right now [${label}]`);
          }
        }
      }

      if (built && haveCollection) {
        for (const p of d.pencilled || []) {
          const pst = pencilStatus(p);
          const label = `${p.out || "—"} → ${p.in || "—"}`;
          if (pst === "done" && !swapShown(d, p, idx, m))
            add("warn", d, p.in || p.out, `Marked done, but the collection CSV doesn't show it in the deck yet [${label}] — update ManaBox, or undo the "done" in the app`);
          else if ((pst === "pencilled" || pst === "approved") && p.out && p.in && swapShown(d, p, idx, m))
            add("info", d, p.in, `ManaBox already shows this swap — was it made? Mark it done, or cancel it [${label}]`);
        }
      }

      for (const w of d.wishlist || []) {
        const k = keyOf(idx, w.name), info = cardInfo(idx, k);
        if (!info) { add("warn", d, w.name, "Wishlist card not found in the card DB"); continue; }
        const o = own && own.get(k);
        if (haveCollection && o && o.free - sumQty(claims.soft.get(k)) > 0)
          add("info", d, info.name, "Wishlist card — you already have a free copy");
      }
    }

    if (haveCollection) {
      for (const [key, list] of claims.hard) {
        if (isBasic(key)) continue;
        const info = cardInfo(idx, key);
        if (info && info.anyNumber) continue;
        const need = sumQty(list), have = (own.get(key) || { total: 0 }).total;
        if (need > have && have > 0)
          for (const x of list)
            add("error", decks.find((d) => d.slug === x.deck), (info && info.name) || key,
              `Built decks use ${need} copies (${list.map((y) => y.deckName || y.deck).join(", ")}) but the CSV has ${have}`);
      }
    }
    const order = { error: 0, todo: 1, warn: 2, info: 3 };
    out.sort((a, b) => order[a.level] - order[b.level] || a.deckName.localeCompare(b.deckName));
    return out;
  }

  /* ---------- Wishlist ---------- */
  // wishlist entry: { name, decks: [slug…], note, kind: "want" | "maybe" | "future" }
  // status: missing | partial | have (owned, swap pending) | placed (owned and in every wanting deck) | unused (owned, no pending use)
  function evalWishlist(wl, decks, idx, own, claims) {
    return (wl || []).map((w) => {
      const key = keyOf(idx, w.name), info = cardInfo(idx, key), o = own && own.get(key);
      const owned = o ? o.total : 0, free = o ? o.free : 0;
      const wanting = w.decks || [];
      const dk = wanting.map((sl) => decks.find((d) => d.slug === sl)).filter(Boolean);
      const need = Math.max(1, wanting.length);
      const placedCount = dk.filter((d) => applySwaps(d, idx, { only: ["made"] }).some((e) => e.key === key)).length;
      const madeIn = decks.some((d) => activePencils(d).some((p) => pencilStatus(p) === "made" && p.in && keyOf(idx, p.in) === key));
      const pending = decks.some((d) => activePencils(d).some((p) => pencilStatus(p) !== "made" && p.in && keyOf(idx, p.in) === key));
      let status;
      if (!owned) status = "missing";
      else if (owned < need) status = "partial";
      else if (wanting.length && placedCount === wanting.length && dk.length === wanting.length) status = "placed";
      else if (pending || madeIn) status = "have";
      else status = "unused";
      return { ...w, key, info, owned, free, need, placedCount, madeIn, pending, status };
    });
  }

  /* ---------- Trades ---------- */
  const RARS = ["common", "uncommon", "rare", "mythic"];
  let LIVE = null; // { rate, p: { scryfallId: [usd, usd_foil, usd_etched] } }
  const setLive = (l) => { LIVE = l; };
  const liveAUD = (r) => {
    if (!LIVE || !r.sid || !LIVE.p[r.sid]) return null;
    const [n, f, e] = LIVE.p[r.sid], foil = String(r.foil || "").toLowerCase(), want = foil === "etched" ? e : foil === "foil" ? f : n;
    const v = want != null ? want : (n != null ? n : f != null ? f : e);
    return v == null ? null : v * LIVE.rate;
  };
  const rowAUD = (r) => { const lv = liveAUD(r); if (lv != null) return lv; const v = parseFloat(r.price); return isFinite(v) && v >= 0 && (!r.cur || /^AUD$/i.test(r.cur)) && String(r.price).trim() !== "" ? v : null; };

  /* ---------- Foils and sleeves ---------- */
  // Cards physically in a deck binder worth double-sleeving (price of that copy >= limit, AUD).
  function sleeveList(rows, deck, limit) {
    const out = [];
    for (const r of rows || []) {
      if (norm(r.btype) !== "deck" || norm(r.binder) !== norm(deck.name || "") || isBasic(r.name)) continue;
      const v = rowAUD(r); if (v == null || v < limit) continue;
      out.push({ name: r.name, set: (r.set || "").toUpperCase(), cn: r.cn || "", foil: isFoilRow(r), qty: r.qty, each: v });
    }
    return out.sort((a, b) => b.each - a.each);
  }
  // For each deck in priority order: normal copies in the deck for which you own a foil copy that is free (in a free binder),
  // or sits in a lower-priority deck (then the two decks swap copies). Each foil copy is used once.
  function foilSuggestions(rows, decks, order, cfg) {
    const free = new Set((cfg.freeBinders || []).map(norm)), rank = new Map();
    const names = decks.map((d) => d.name || d.slug);
    const ord = (order || []).filter((n) => names.includes(n)).concat(names.filter((n) => !(order || []).includes(n)));
    ord.forEach((n, i) => rank.set(norm(n), i));
    const used = new Map(), out = [], keyOfRow = (r) => norm(r.name);
    const take = (r, n) => used.set(r, (used.get(r) || 0) + n), left = (r) => r.qty - (used.get(r) || 0);
    const foils = rows.filter((r) => isFoilRow(r) && !isBasic(r.name));
    for (const dn of ord) {
      const mine = rows.filter((r) => norm(r.btype) === "deck" && norm(r.binder) === norm(dn) && !isFoilRow(r) && !isBasic(r.name));
      for (const r of mine) {
        for (let c = 0; c < r.qty; c++) {
          const cands = foils.filter((f) => keyOfRow(f) === keyOfRow(r) && left(f) > 0 && norm(f.binder) !== norm(dn));
          let src = cands.find((f) => free.has(norm(f.binder)));
          let kind = "free";
          if (!src) {
            src = cands.filter((f) => norm(f.btype) === "deck" && rank.has(norm(f.binder)) && rank.get(norm(f.binder)) > rank.get(norm(dn))).sort((a, b) => rank.get(norm(b.binder)) - rank.get(norm(a.binder)))[0];
            kind = "deck";
          }
          if (!src) continue;
          take(src, 1);
          out.push({ deck: dn, name: r.name, have: { set: (r.set || "").toUpperCase(), cn: r.cn || "", each: rowAUD(r) }, foil: { binder: src.binder, set: (src.set || "").toUpperCase(), cn: src.cn || "", each: rowAUD(src), etched: /etched/i.test(src.foil || "") }, kind, samePrint: (r.set || "").toUpperCase() === (src.set || "").toUpperCase() && String(r.cn) === String(src.cn) });
        }
      }
    }
    return { order: ord, list: out };
  }
  function buildTrades(ctx, reserve) {
    const { own, claims, cfg, idx } = ctx;
    const free = new Set(cfg.freeBinders.map(norm));
    const res = [];
    for (const o of own.values()) {
      if (isBasic(o.name)) continue;
      const hard = sumQty(claims.hard.get(o.key)), soft = sumQty(claims.soft.get(o.key));
      const rar = o.rows.reduce((b, r) => (RARS.indexOf((r.rarity || "").toLowerCase()) > RARS.indexOf(b) ? (r.rarity || "").toLowerCase() : b), "common");
      const keep = typeof reserve === "object" && reserve ? (reserve[rar] || 0) : (reserve || 0);
      const freeQty = o.rows.reduce((s, r) => s + (free.has(norm(r.binder)) ? r.qty : 0), 0);
      const t = Math.max(0, Math.min(freeQty, o.total - hard - soft) - keep);
      if (t <= 0) continue;
      // allocate across the rows that sit in free binders
      let left = t;
      const alloc = [];
      for (const r of o.rows) {
        if (left <= 0) break;
        if (!free.has(norm(r.binder))) continue;
        const take = Math.min(r.qty, left);
        if (take > 0) { alloc.push({ ...r, qty: take }); left -= take; }
      }
      let val = 0, priced = 0;
      for (const r of alloc) { const p = rowAUD(r); if (p != null) { val += p * r.qty; priced += r.qty; } }
      const committed = Math.min(o.total, hard + soft);
      res.push({ key: o.key, name: o.name, total: o.total, free: freeQty, hard, soft, tradeable: t, alloc, info: cardInfo(idx, o.key), rarity: rar, keep,
        committed, uncommitted: Math.max(0, o.total - committed), unit: priced ? val / priced : null, value: priced ? val : null });
    }
    res.sort((a, b) => a.name.localeCompare(b.name));
    return res;
  }
  function tradesCSV(selected) {
    const head = ["Name", "Set code", "Collector number", "Foil", "Quantity", "Scryfall ID"];
    const lines = [head.join(",")];
    for (const t of selected)
      for (const r of t.alloc)
        lines.push([t.name, r.set, r.cn, r.foil, r.qty, r.sid].map(csvEscape).join(","));
    return lines.join("\n");
  }

  /* ---------- Where is a card / upgrade finder ---------- */
  function whereIs(key, decks, idx, own, claims, cfg) {
    const out = { decks: [], pencilIn: [], pencilOut: [], binders: [], total: 0, free: 0, hard: sumQty(claims && claims.hard.get(key)), soft: sumQty(claims && claims.soft.get(key)) };
    for (const d of decks) {
      const m = deckMap(d, idx), e = m.get(key);
      if (e) out.decks.push({ slug: d.slug, name: d.name || d.slug, qty: e.qty, status: d.status || "planned" });
      for (const p of activePencils(d)) {
        if (p.in && keyOf(idx, p.in) === key) out.pencilIn.push({ slug: d.slug, name: d.name || d.slug, status: pencilStatus(p) });
        if (p.out && keyOf(idx, p.out) === key) out.pencilOut.push({ slug: d.slug, name: d.name || d.slug, status: pencilStatus(p) });
      }
    }
    const o = own && own.get(key), fr = new Set(((cfg && cfg.freeBinders) || []).map(norm));
    if (o) { out.total = o.total; for (const [b, q] of o.binders) { out.binders.push({ binder: b, qty: q, free: fr.has(norm(b)) }); if (fr.has(norm(b))) out.free += q; } }
    return out;
  }
  const GAP_ROLES = ["ramp", "draw", "targeted", "mass"];
  function upgradeCandidates(deck, idx, own, claims, cfg, st) {
    const m = deckMap(deck, idx), ci = new Set();
    for (const c of commandersOf(deck)) { const i = cardInfo(idx, keyOf(idx, c)); if (i) i.ci.forEach((x) => ci.add(x)); }
    const pencIn = new Set(activePencils(deck).filter((p) => p.in).map((p) => keyOf(idx, p.in)));
    const fr = new Set(cfg.freeBinders.map(norm));
    const gaps = {}; for (const r of GAP_ROLES) gaps[r] = Math.max(0, (st.targets[r] || 0) - (st.counts[r] || 0));
    const lists = { ramp: [], draw: [], targeted: [], mass: [] };
    for (const o of own.values()) {
      if (isBasic(o.name) || m.has(o.key) || pencIn.has(o.key)) continue;
      const info = cardInfo(idx, o.key);
      if (!info || /\bLand\b/.test(info.frontType)) continue;
      if (!info.ci.every((c) => ci.has(c))) continue;
      const hard = sumQty(claims.hard.get(o.key)), soft = sumQty(claims.soft.get(o.key)), avail = o.total - hard;
      if (avail <= 0) continue;
      const freeQty = o.rows.reduce((s, r) => s + (fr.has(norm(r.binder)) ? r.qty : 0), 0);
      const ex = classifyRolesEx(info), roles = GAP_ROLES.filter((r) => ex[r] === "strong");
      if (!roles.length) continue;
      const filled = roles.filter((r) => gaps[r] > 0).length;
      const rec = { key: o.key, name: info.name, info, roles, illegal: info.legal === false, free: freeQty, avail, soft, binders: [...o.binders].map(([b, q]) => ({ binder: b, qty: q })), score: filled * 10 + (freeQty > 0 ? 5 : 0) - Math.min(7, info.mv || 0) * 0.5 };
      for (const r of roles) lists[r].push(rec);
    }
    for (const r of GAP_ROLES) lists[r].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { gaps, lists };
  }
  const deckValue = (rows, deck) => rows.reduce((s, r) => (norm(r.binder) === norm(deck.name || "") ? s + (rowAUD(r) || 0) * r.qty : s), 0);


  /* ---------- Check a physical deck: expected list + scan matching ---------- */
  // list = [{key,name,qty}]. One entry per expected printing: {id,key,name,qty,set,cn,foil,sid}. Printings come from the deck binder first, then picks/free copies.
  function tickEntries(deck, list, own, cfg) {
    const al = allocateDeck(deck, list, own, cfg), out = [], got = new Map();
    for (const l of al.lines) {
      got.set(l.key, (got.get(l.key) || 0) + l.qty);
      const r = l.row, foil = /foil|etched/i.test(r.foil || "") && !/^normal$/i.test(r.foil || "");
      const id = [l.key, r.set, r.cn, foil ? "f" : "n"].join("|"), ex = out.find((e) => e.id === id);
      if (ex) ex.qty += l.qty; else out.push({ id, key: l.key, name: l.name, qty: l.qty, set: (r.set || "").toUpperCase(), cn: r.cn || "", foil, sid: r.sid || "", unknown: false });
    }
    for (const e of list) {
      const rest = e.qty - (got.get(e.key) || 0);
      if (rest > 0) out.push({ id: e.key + "|?", key: e.key, name: e.name, qty: rest, set: "", cn: "", foil: false, sid: "", unknown: true });
    }
    return out;
  }
  const lev = (a, b) => {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
  };
  const nameForm = (t) => String(t || "").toLowerCase().replace(/[^a-z' ,\-]/g, " ").replace(/\s+/g, " ").trim();
  // Best fuzzy match of OCR'd title text against the deck's card names. Returns {key,score} or null.
  function matchTitle(entries, text) {
    const lines = String(text || "").split(/\n/).map(nameForm).filter((l) => l.length >= 3);
    if (!lines.length) return null;
    const names = new Map();
    for (const e of entries) names.set(e.key, e.name);
    let best = null, second = 0;
    for (const [key, nm] of names) {
      const faces = String(nm).split(" // ").map(nameForm).concat([nameForm(nm)]);
      let sc = 0;
      for (const f of faces) for (const l of lines.slice(0, 3)) { const x = 1 - lev(f, l) / Math.max(f.length, l.length); if (x > sc) sc = x; }
      if (!best || sc > best.score) { if (best) second = best.score; best = { key, score: sc }; } else if (sc > second) second = sc;
    }
    return best && best.score >= 0.78 && best.score - second >= 0.04 ? best : null;
  }

  // Look a title up in the whole card DB (used by the scanner to say what a card is when it isn't on the deck's list).
  function matchAnyTitle(idx, text) {
    if (!idx) return null;
    const lines = String(text || "").split(/\n/).map(nameForm).filter((l) => l.length >= 3).slice(0, 3);
    if (!lines.length) return null;
    let best = null;
    for (const k of Object.keys(idx.db)) {
      const f = nameForm(k.split(" // ")[0]);
      for (const l of lines) { if (Math.abs(f.length - l.length) > 4) continue; const x = 1 - lev(f, l) / Math.max(f.length, l.length); if (!best || x > best.score) best = { key: k, score: x }; }
    }
    return best && best.score >= 0.8 ? best : null;
  }
  // Find the collection row for a set code + collector number (to name a card from its small print alone).
  function indexBySetCn(rows) {
    const m = new Map();
    for (const r of rows || []) { if (!r.set || !r.cn) continue; const k = fixDigits(r.set) + "|" + cnNum(r.cn); if (!m.has(k)) m.set(k, r); }
    return m;
  }
  const fixDigits = (t) => String(t).toUpperCase().replace(/O/g, "0").replace(/[IL|]/g, "1");
  // Read set code, collector number and foil star from the OCR'd bottom-left text of a card.
  function parseCollector(text) {
    const up = String(text || "").toUpperCase();
    const star = false; // foil is never read from the card (the star is too small for OCR); it is flagged by hand
    const flat = up.replace(/[^A-Z0-9★☆✦*\/•·.\- \n]/g, " ");
    let set = "", cn = "";
    const sm = flat.match(/\b([A-Z0-9]{3,5})\s*[•·.\-*★☆✦]+\s*(EN|JA|DE|FR|ES|IT|PT|RU|KO|ZH[ST]?|PH)\b/) || flat.match(/\b([A-Z0-9]{3,5})\s+(EN|JA|DE|FR|ES|IT|PT|RU|KO|ZH[ST]?|PH)\b/) || flat.match(/\b([A-Z0-9]{3,5})\s+\S{1,2}\s+(EN|JA|DE|FR|ES|IT|PT|RU|KO|ZH[ST]?|PH)\b/);
    if (sm) set = sm[1];
    const co = flat.match(/COAST\s*[^A-Z0-9\n]*\s*0*(\d{1,4})\b/);
    if (co && !sm) return { set: "", cn: co[1], star };
    if (!sm) { const yr = flat.match(/\b(?:19[89]\d|20[0-3]\d)\b[^\d\n]*?\b0*(\d{1,4})\s*$/m); if (yr) return { set: "", cn: yr[1], star }; }
    const nm = flat.match(/(?:^|[^A-Z0-9])0*(\d{1,4})(?:\s*\/\s*\d{1,4})?\s*[CURMLTS★☆*]?(?:[^A-Z0-9]|$)/m);
    if (nm) cn = nm[1];
    if (!set && /^(19[89]\d|20[0-3]\d)$/.test(cn)) cn = ""; // a copyright year, not a collector number
    return { set, cn, star };
  }
  // OCR often swaps one character (3/5, 1/7...). Among a card's listed printings, find one whose set and number are one character off the read.
  function fuzzyEntry(cands, cl) {
    if (!cl || !cl.set || !cl.cn) return null;
    const hits = cands.filter((e) => {
      if (!e.set || !e.cn) return false;
      const ds = lev(fixDigits(e.set), fixDigits(cl.set)), dn = lev(cnNum(e.cn), cnNum(cl.cn));
      return (ds === 0 && dn === 1) || (ds === 1 && dn === 0);
    });
    return hits.length === 1 ? hits[0] : null;
  }
  // Check a read set + number against every real printing of the card (prints = [[set, cn], ...] from Scryfall).
  // valid: it is a real printing. snap: exactly one real printing is a single character away (a misread). cands: several are; none: nothing close.
  function snapPrint(prints, cl) {
    if (!prints || !prints.length || !cl || !cl.cn) return { kind: "none" };
    if (!cl.set) { // old frames print only the number: the real printings with that number say which set
      const hit = prints.filter((p) => cnNum(p[1]) === cnNum(cl.cn));
      return hit.length === 1 ? { kind: "snap", set: String(hit[0][0]).toUpperCase(), cn: hit[0][1], setless: true } : { kind: "none" };
    }
    const rs = fixDigits(cl.set), rn = cnNum(cl.cn);
    const real = prints.find((p) => fixDigits(String(p[0]).toUpperCase()) === rs && cnNum(p[1]) === rn);
    if (real) return { kind: "valid", set: String(real[0]).toUpperCase(), cn: real[1] };
    const near = [];
    for (const p of prints) {
      const ds = lev(fixDigits(String(p[0]).toUpperCase()), rs), dn = lev(cnNum(p[1]), rn);
      if (ds + dn === 1) near.push({ set: String(p[0]).toUpperCase(), cn: p[1], ds, dn });
    }
    if (near.length === 1) return { kind: "snap", set: near[0].set, cn: near[0].cn };
    if (near.length > 1) {
      const sameSet = near.filter((n) => n.ds === 0); // the set code is the easier thing to read; trust it
      if (sameSet.length === 1) return { kind: "snap", set: sameSet[0].set, cn: sameSet[0].cn };
      return { kind: "cands", cands: near.slice(0, 6) };
    }
    return { kind: "none" };
  }
  const cnNum = (c) => String(c || "").replace(/^0+/, "").replace(/[^0-9].*$/, "");
  // Decide what a scanned card is. state = { got: {entryId: n} }. Returns {kind, entry?, seen?, why}.
  //  kind: exact (set+number match an expected printing) | name (title matched, printing not readable) | diff (title matched, printing read but not expected) | none
  function matchScan(entries, state, title, bottom) {
    const got = (state && state.got) || {}, left = (e) => e.qty - (got[e.id] || 0);
    const cl = parseCollector(bottom), tm = matchTitle(entries, title);
    const full = (e) => e.set && e.cn;
    let hits = [];
    if (cl.set && cl.cn) hits = entries.filter((e) => full(e) && fixDigits(e.set) === fixDigits(cl.set) && cnNum(e.cn) === cnNum(cl.cn));
    // the bottom line alone is strong, but if the title clearly names a different deck card, don't trust it
    if (hits.length && tm) { const same = hits.filter((e) => e.key === tm.key); if (same.length) hits = same; else if (tm.score >= 0.9) hits = []; }
    if (hits.length) {
      // Foil is not read from the card: the printing (set + number) is what's matched; foil is flagged by hand in the app.
      const pick = hits.find((e) => left(e) > 0) || hits[0];
      return { kind: "exact", entry: pick, seen: cl, full: left(pick) <= 0 };
    }
    if (tm) {
      const cands = entries.filter((e) => e.key === tm.key);
      const fz = fuzzyEntry(cands, cl);
      if (fz) return { kind: "exact", entry: fz, seen: cl, full: left(fz) <= 0, fuzzy: true };
      if (cl.set && cl.cn) return { kind: "diff", entry: cands.find((e) => left(e) > 0) || cands[0], seen: cl, why: "different printing from the list" };
      const pick = cands.find((e) => left(e) > 0) || cands[0];
      return { kind: "name", entry: pick, seen: cl, full: left(pick) <= 0 };
    }
    return { kind: "none", seen: cl };
  }
  /* ---------- Rebuild a deck from the collection (choose printings) ---------- */
  // Rows of this card that could go in this deck: its own deck binder, free binders, and spare copies in multi-copy binders.
  function eligibleRows(own, key, deck, cfg) {
    const o = own && own.get(key);
    if (!o) return [];
    const free = new Set(cfg.freeBinders.map(norm)), multi = new Set(cfg.multiCopyBinders.map(norm)), mine = norm((deck && deck.name) || "");
    const spare = new Map();
    for (const [b, q] of o.binders) if (multi.has(norm(b))) spare.set(norm(b), Math.max(0, q - 1));
    const out = [];
    for (const r of o.rows) {
      const nb = norm(r.binder);
      let kind = "", avail = 0;
      if (nb === mine) { kind = "this deck"; avail = r.qty; }
      else if (free.has(nb)) { kind = "free"; avail = r.qty; }
      else if (multi.has(nb)) { kind = "spare"; avail = Math.min(r.qty, spare.get(nb) || 0); spare.set(nb, (spare.get(nb) || 0) - avail); }
      if (avail > 0) out.push({ ...r, avail, kind });
    }
    return out;
  }
  const printKey = (r) => (r.sid || "") + "|" + norm(r.foil);
  const printKeyOf = (pk) => printKey({ sid: pk.sid, foil: pk.foil });
  function printings(own, key, deck, cfg) {
    const g = new Map();
    for (const r of eligibleRows(own, key, deck, cfg)) {
      const k = printKey(r), p = g.get(k) || { k, sid: r.sid, foil: r.foil, set: r.set, cn: r.cn, setName: r.setName, avail: 0, where: new Set() };
      p.avail += r.avail; p.where.add(r.kind === "this deck" ? "in this deck" : r.binder); g.set(k, p);
    }
    return [...g.values()];
  }
  // list = [{key,name,qty}]. deck.picks[key] = {sid, foil} chooses a printing; otherwise prefer copies already in the deck, then free ones.
  function allocateDeck(deck, list, own, cfg) {
    const picks = deck.picks || {}, lines = [], short = [], used = new Map(), rank = { "this deck": 0, free: 1, spare: 2 };
    for (const e of list) {
      let need = e.qty;
      const pk = picks[e.key];
      const rows = eligibleRows(own, e.key, deck, cfg).sort((a, b) => {
        const pa = pk && printKey(a) === printKey({ sid: pk.sid, foil: pk.foil }) ? 0 : 1, pb = pk && printKey(b) === printKey({ sid: pk.sid, foil: pk.foil }) ? 0 : 1;
        return pa - pb || rank[a.kind] - rank[b.kind];
      });
      for (const r of rows) {
        if (need <= 0) break;
        const take = Math.min(need, r.avail - (used.get(r) || 0));
        if (take > 0) { used.set(r, (used.get(r) || 0) + take); lines.push({ name: e.name, key: e.key, row: r, qty: take, picked: !!pk && printKey(r) === printKey({ sid: pk.sid, foil: pk.foil }) }); need -= take; }
      }
      if (need > 0) {
        const o = own && own.get(e.key);
        short.push({ name: e.name, need, why: !o ? "not in the collection" : "owned, but the rest are in other decks' binders" });
      }
    }
    return { lines, short };
  }
  // Another deck picked the same printing and there aren't enough copies for both?
  function pickConflicts(decks, deck, alloc, own, cfg) {
    const out = [];
    for (const l of alloc.lines) {
      if (!l.picked) continue;
      const k = printKey(l.row);
      const others = decks.filter((d) => d !== deck && d.picks && d.picks[l.key] && printKey({ sid: d.picks[l.key].sid, foil: d.picks[l.key].foil }) === k);
      if (!others.length) continue;
      const supply = eligibleRows(own, l.key, deck, cfg).filter((r) => printKey(r) === k).reduce((s, r) => s + r.avail, 0);
      if (supply < 1 + others.length) out.push(`${l.name}: this printing is also picked for ${others.map((d) => d.name).join(", ")} — only ${supply} available`);
    }
    return out;
  }
  const REBUILD_HEAD = ["Binder Name", "Binder Type", "Name", "Set code", "Set name", "Collector number", "Foil", "Rarity", "Quantity", "ManaBox ID", "Scryfall ID", "Purchase price", "Misprint", "Altered", "Signed", "Condition", "Language", "Proxy", "Purchase price currency"];
  function rebuildCSV(deck, lines) {
    const out = [REBUILD_HEAD.join(",")];
    for (const l of lines) {
      const r = l.row;
      out.push([deck.name, "deck", r.name, r.set, r.setName, r.cn, r.foil, r.rarity, l.qty, r.mbid, r.sid, r.price, "", "", "", r.cond, r.lang, "", ""].map(csvEscape).join(","));
    }
    return out.join("\n");
  }
  const rebuildText = (lines) => lines.map((l) => `${l.qty} ${l.name} (${String(l.row.set).toUpperCase()}) ${l.row.cn}${/foil/i.test(l.row.foil) && !/normal/i.test(l.row.foil) ? " *F*" : ""}`).join("\n");



  /* ---------- Basic land tidy: which printings of a basic each deck uses, and how to make a deck uniform ---------- */
  const isFoilRow = (r) => /foil|etched/i.test(r.foil || "") && !/^normal$/i.test((r.foil || "").trim());
  function basicNames(rows) { return [...new Set(rows.filter((r) => isBasic(r.name)).map((r) => r.name))].sort(); }
  // -> [{ binder, isDeck, prints: [{pk,set,cn,setName,foil,sid,qty}], total }]; decks first
  function basicHolders(rows, name) {
    const by = new Map();
    for (const r of rows) {
      if (norm(r.name) !== norm(name)) continue;
      const h = by.get(r.binder) || { binder: r.binder, isDeck: /deck/i.test(r.btype || ""), prints: new Map(), total: 0 };
      const pk = printKey(r), p = h.prints.get(pk) || { pk, set: String(r.set || "").toUpperCase(), cn: r.cn, setName: r.setName, foil: isFoilRow(r), sid: r.sid, qty: 0 };
      p.qty += r.qty; h.total += r.qty; h.prints.set(pk, p); by.set(r.binder, h);
    }
    return [...by.values()].map((h) => ({ ...h, prints: [...h.prints.values()].sort((a, b) => b.qty - a.qty) })).sort((a, b) => (b.isDeck - a.isDeck) || a.binder.localeCompare(b.binder));
  }
  // Make `deck` use only the printing `target` (a printKey) for this basic, swapping copies with non-deck binders.
  function tidyPlan(holders, deckBinder, target) {
    const dk = holders.find((h) => h.binder === deckBinder);
    if (!dk) return { moves: [], have: 0, need: 0, short: 0 };
    const mine = dk.prints.find((p) => p.pk === target), have = mine ? mine.qty : 0, need = dk.total - have;
    const wrong = dk.prints.filter((p) => p.pk !== target).map((p) => ({ ...p, left: p.qty }));
    const supply = [];
    for (const h of holders) if (!h.isDeck) { const p = h.prints.find((x) => x.pk === target); if (p) supply.push({ binder: h.binder, p, left: p.qty }); }
    supply.sort((a, b) => b.left - a.left);
    const moves = []; let remaining = need;
    for (const s of supply) {
      for (const w of wrong) {
        const n = Math.min(s.left, w.left, remaining);
        if (n > 0) { moves.push({ qty: n, binder: s.binder, give: w, get: s.p }); s.left -= n; w.left -= n; remaining -= n; }
      }
    }
    // other decks that hold the target printing (for the shortfall)
    const elsewhere = remaining > 0 ? holders.filter((h) => h.isDeck && h.binder !== deckBinder && h.prints.some((p) => p.pk === target)).map((h) => ({ binder: h.binder, qty: h.prints.find((p) => p.pk === target).qty })) : [];
    return { moves, have, need, short: remaining, elsewhere };
  }

  /* ---------- Collection browser: one entry per owned printing, plus filter + sort ---------- */
  const WUBRG = ["W", "U", "B", "R", "G"], RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };
  function collectionEntries(rows, idx) {
    const m = new Map();
    for (const r of rows) {
      const key = keyOf(idx, r.name), id = [key, (r.set || "").toLowerCase(), r.cn, /foil|etched/i.test(r.foil || "") ? "f" : "n"].join("|");
      let e = m.get(id);
      if (!e) {
        const info = cardInfo(idx, key);
        e = { id, key, name: info ? plainName(info.name) : r.name, set: (r.set || "").toUpperCase(), setName: r.setName || (r.set || "").toUpperCase(), cn: r.cn, foil: /foil|etched/i.test(r.foil || "") ? (r.foil || "foil").toLowerCase() : "",
          rarity: (r.rarity || "").toLowerCase(), qty: 0, sid: r.sid, binders: new Map(), cond: r.cond, lang: r.lang, info, known: !!info,
          type: info ? info.type : "", frontType: info ? info.frontType : "", mv: info ? Math.floor(info.mv || 0) : -1, ci: info ? info.ci : [], colors: info ? info.colors : [],
          cost: info ? info.cost : "", text: info ? info.text : "", pt: info ? info.pt : "", keywords: info ? info.keywords : "" };
        m.set(id, e);
      }
      { const p = rowAUD(r); if (p != null) { e._pv = (e._pv || 0) + p * r.qty; e._pq = (e._pq || 0) + r.qty; } }
      e.qty += r.qty; e.binders.set(r.binder, (e.binders.get(r.binder) || 0) + r.qty);
      if (!/deck/i.test(r.btype || "")) e.freeQty = (e.freeQty || 0) + r.qty; else e.deckQty = (e.deckQty || 0) + r.qty;
      if (!e.sid && r.sid) e.sid = r.sid;
    }
    const arr = [...m.values()]; for (const e of arr) { e.price = e._pq ? e._pv / e._pq : null; e.value = e._pq ? e._pv : null; } return arr;
  }
  const plainName = (n) => (n || "").split(" // ").length === 2 && n.split(" // ")[0] === n.split(" // ")[1] ? n.split(" // ")[0] : n;
  const TYPE_CHIPS = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land", "Battle"];
  function filterCollection(entries, f) {
    const toks = (f.q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const sel = (s) => (s && s.size ? s : null);
    const cols = sel(f.colors), ci = f.ciActive ? (f.ci || new Set()) : sel(f.ci), mvs = sel(f.mv), types = sel(f.types), rars = sel(f.rarity);
    return entries.filter((e) => {
      if (f.binder && !e.binders.has(f.binder)) return false;
      if (f.set && e.set !== f.set) return false;
      if (f.foil === "foil" && !e.foil) return false;
      if (f.foil === "nonfoil" && e.foil) return false;
      if (f.foil === "spare" && !(e.foil && e.freeQty > 0)) return false;
      if (rars && !rars.has(e.rarity)) return false;
      if (types && ![...types].some((t) => e.frontType.includes(t))) return false;
      if (mvs && !(mvs.has(Math.min(7, Math.max(0, e.mv))) && e.mv >= 0)) return false;
      if (cols) {
        const c = e.colors, hasC = !c.length, want = [...cols].filter((x) => x !== "C"), wantC = cols.has("C");
        const mode = f.cmode || "any";
        if (mode === "any") { if (!(want.some((x) => c.includes(x)) || (wantC && hasC))) return false; }
        else if (mode === "all") { if (!want.every((x) => c.includes(x)) || (wantC && !hasC)) return false; }
        else if (mode === "exact") { if (wantC ? !(hasC && !want.length) : !(c.length === want.length && want.every((x) => c.includes(x)))) return false; }
      }
      if (ci && !e.ci.every((x) => ci.has(x))) return false;
      if (toks.length) {
        const hay = (e.name + "\n" + e.type + "\n" + e.text + "\n" + e.keywords).toLowerCase();
        if (!toks.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }
  function sortCollection(list, by, dir) {
    const colRank = (e) => (e.colors.length ? (e.colors.length > 1 ? 10 : 0) + Math.min(...e.colors.map((c) => WUBRG.indexOf(c))) : 20);
    const cnNum = (e) => parseInt(e.cn, 10) || 0;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      mv: (a, b) => a.mv - b.mv || a.name.localeCompare(b.name),
      color: (a, b) => colRank(a) - colRank(b) || a.name.localeCompare(b.name),
      set: (a, b) => a.setName.localeCompare(b.setName) || cnNum(a) - cnNum(b),
      rarity: (a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9) || a.name.localeCompare(b.name),
      type: (a, b) => a.frontType.localeCompare(b.frontType) || a.name.localeCompare(b.name),
      qty: (a, b) => a.qty - b.qty || a.name.localeCompare(b.name),
      price: (a, b) => (a.price ?? -1) - (b.price ?? -1) || a.name.localeCompare(b.name),
    }[by] || ((a, b) => a.name.localeCompare(b.name));
    return list.slice().sort((a, b) => cmp(a, b) * (dir < 0 ? -1 : 1));
  }
  function binderSummary(rows) {
    const m = new Map();
    for (const r of rows) {
      let b = m.get(r.binder);
      if (!b) { b = { name: r.binder, btype: r.btype, qty: 0, value: 0, names: new Set(), sid: "", rname: "" }; m.set(r.binder, b); }
      b.qty += r.qty; { const p = rowAUD(r); if (p != null) b.value += p * r.qty; } b.names.add(r.name);
      if (!b.sid && r.sid) { b.sid = r.sid; b.rname = r.name; }
    }
    return [...m.values()].map((b) => ({ ...b, unique: b.names.size })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ---------- Deck stats: roles (Command Zone template), mana curve, colour pips, sources ---------- */
  const ROLE_KEYS = ["ramp", "draw", "targeted", "mass"];
  // Best-guess roles from the card's DB text. Override per card with deck.roles[key] = [..].
  // Returns { role: "strong" | "soft" }. Strong = a dependable, unconditional effect. Soft = real but conditional, one-shot,
  // narrow, or card-neutral (cantrips, loots, sacrifice fodder needed, artifact/enchantment-only removal, etc).
  function classifyRolesEx(info) {
    if (!info || /\bLand\b/.test(info.frontType)) return {};
    const full = (info.text || "").replace(/\([^)]*\)/g, " ").replace(/[ \t]+/g, " "), spell = /Instant|Sorcery/.test(info.frontType), out = {};
    const COND = /(?:^|\n)\s*(?:•\s*)?(?:Metalcraft|Morbid|Revolt|Delirium|Ferocious|Spell mastery|Threshold|Hellbent|Formidable|Raid|Addendum|Kicker|Corrupted)\b[^\n]*(?:—|\.)[^\n]*/gi;
    const t = full.replace(COND, " ");                       // text without ability-word conditional sentences
    const put = (r, lvl) => { if (out[r] !== "strong") out[r] = lvl; };
    const trig = (s) => /\b(Whenever|When)\b/i.test(s);
    const sents = t.split(/\n|(?<=[.])\s/).filter(Boolean);
    // ---- ramp
    if ((!spell && /:\s*(?:[^.:\n]{0,50}\.\s*)?Add\s+(\{|one |two |three |an amount|X\b|that much)/i.test(t)) || /Untap target (Forest|Island|Swamp|Mountain|Plains|land)/i.test(t)) put("ramp", "strong");
    else if (spell && /^\s*Add\s+\{/im.test(t)) put("ramp", "soft");                                   // rituals
    const fetchBf = /search your library for[^.]*(?:land|Plains|Island|Swamp|Mountain|Forest)[^.]*cards?[^.]*?(?:onto|on) the battlefield/i.test(t) || /put (a|an|up to \w+|any number of) (basic )?land cards? (from your hand )?onto the battlefield/i.test(t) ||
      /search your library for[^.]*(?:land|Plains|Island|Swamp|Mountain|Forest)[^.]*cards?[^.]*put (?:one|it|that card|them)[^.]*onto the battlefield/i.test(t);
    if (fetchBf) put("ramp", "strong");
    if (/search your library for[^.]*(?:basic land|land|Plains|Island|Swamp|Mountain|Forest)[^.]*cards?[^.]*into your hand/i.test(t) || /\b(?:basic )?(?:land|plains|island|swamp|mountain|forest)cycling\b/i.test(info.text || "")) put("ramp", "soft");
    if (/create (?:a|an|\w+) Treasure tokens?/i.test(t)) put("ramp", sents.some((s) => /create (?:a|an|\w+) Treasure/i.test(s) && /\bWhenever\b|At the beginning/i.test(s)) ? "strong" : "soft");
    // ---- card advantage
    let dr = null;
    for (const s of sents) {
      const m = /\bdraws? (a|an|one|two|three|four|five|X|that many|\d+|cards? equal|\w+ additional|cards equal)\b/i.exec(s) || /\bdraw cards equal\b|\bdraws? (?:a card|cards?) for each\b/i.exec(s);
      if (!m) continue;
      const many = /\b(two|three|four|five|X|that many|\d+|equal)\b/i.test(m[0]) || /for each/i.test(s);
      const loot = /discard/i.test(t) && /then discard|discard (a|two|three|up to)/i.test(t);
      const gated = trig(s) && /(deals? combat damage|attacks?|blocks?|dies|gain(?:ed)? life|cast|enters? .*under your control|put into a graveyard|second card)/i.test(s) && !/When (?:this|Mind|\S+) (?:creature|artifact|enchantment) enters/i.test(s);
      const sacCost = /Sacrifice (?!this\b|\w+ (?:creature|artifact|enchantment|permanent) :)/i.test(s) && /:/.test(s) || /As an additional cost[^.]*sacrifice/i.test(t) || /Sacrifice (?!this)[^.:]*:[^.]*draw/i.test(s);
      let lvl = "strong";
      if (loot || gated || sacCost) lvl = "soft";
      else if (!many && spell) lvl = "soft";                                        // plain cantrip: replaces itself
      if (!many && !spell && /\bunless|\bif\b/i.test(s) && !/enters/i.test(s)) lvl = "soft";
      dr = dr === "strong" ? dr : lvl; if (lvl === "strong") break;
    }
    if (dr) put("draw", dr);
    if (/look at the top (\w+ )?cards? of your library[^.]*(put|into your hand)/i.test(t)) put("draw", "strong");
    if (/\binvestigate\b|create (?:a|an|\w+) Clue/i.test(t)) put("draw", "soft");
    if (/exile the top[^.]*(?:\n|\.)[^\n]*you may (play|cast)|you may (play|cast)[^.]*from the top of your library|exile the top[^.]*you may (play|cast)|you may play (?:those|that) cards?/i.test(t)) put("draw", /cast|upkeep|each|Whenever/i.test(t) && !/until the end of (?:your next )?turn/i.test(t) ? "strong" : "soft");
    // ---- targeted disruption
    const remB = (tx) => {
      const hits = [];
      if (/(destroy|exile) (up to \w+ |another |any number of |X )?target (?!player's graveyard|opponent's graveyard|cards? from)/i.test(tx)) hits.push("rm");
      if (/(destroy|exile) (those|that|each of those) (creatures?|permanents?)/i.test(tx)) hits.push("rm");
      if (/counter target (spell|activated|triggered)/i.test(tx) || /counter target [^.]*spell/i.test(tx)) hits.push("ctr");
      if (/return target [^.]*? to (its|their) owner'?s? hands?/i.test(tx)) hits.push("bounce");
      if (/deals? (\d+|X) damage to (any target|target|each of up to)/i.test(tx) || /deals? damage equal to [^.]*to target (creature|player|planeswalker|opponent)/i.test(tx)) hits.push("dmg");
      if (/target [^.]*? gets? -(\d|X)\/-(\d|X)/i.test(tx)) hits.push("shrink");
      if (/gain control of target/i.test(tx) && !/until end of turn/i.test(tx)) hits.push("steal");
      if (/target (player|opponent) sacrifices/i.test(tx)) hits.push("edict");
      return hits;
    };
    const inTrig = (tx) => { const hs = tx.split(/\n|(?<=[.])\s/).filter((s) => remB([s][0]).length); return hs.length && hs.every((s) => /\bWhenever\b|\bat the beginning\b/i.test(s) && !/enters|leaves/i.test(s)); };
    let hits = remB(t);
    if (hits.length) {
      let lvl = "strong";
      const nar = /(destroy|exile) (up to \w+ |another )?target (artifact|enchantment|noncreature|nonland permanent you|attacking|blocking|tapped|black|white|green|red|blue|colorless)/i.test(t) && !/target (creature|permanent|nonland permanent|planeswalker)/i.test(t.replace(/Destroy target (artifact|enchantment)[^.]*\./gi, ""));
      if (hits.every((h) => h === "bounce") || nar && !/target (creature|permanent|planeswalker)/i.test(t)) lvl = "soft";
      if (/destroy target (attacking|blocking|tapped|black|white|green|red|blue)/i.test(t) || /target [^.]*power (\d|X) or (greater|less)/i.test(t)) lvl = "soft";
      if (hits.every((h) => h === "ctr") && /counter target (noncreature spell|enchantment|instant|sorcery|creature spell|artifact)/i.test(t) && !/counter target spell/i.test(t)) lvl = "soft";
      if (hits.every((h) => h === "ctr") && /unless/i.test(t)) lvl = "soft";
      if (hits.every((h) => h === "shrink") && !/-([3-9]|X)\/-([3-9]|X)/.test(t)) lvl = "soft";
      if (hits.every((h) => h === "dmg") && !/deals? (?:[3-9]|\d\d|X) damage/i.test(t) && !/damage equal/i.test(t)) lvl = "soft";
      if (inTrig(t)) lvl = "soft";                                                   // repeatable pings, attack/combat triggers
      if (/(?:Whenever|When) [^.]*attacks?[^.]*(?:exile|destroy|target)/i.test(t) && hits.length === 1 && !/enters/i.test(t)) lvl = "soft";
      if (/Choose (?:one or both|one|two|three)/i.test(t) && lvl === "strong" && !hits.includes("rm") && !hits.includes("ctr")) lvl = "soft";
      put("targeted", lvl);
    } else if (remB(full).length) put("targeted", "soft");                          // only via an ability-word clause (metalcraft, morbid…)
    // ---- mass disruption
    const m1 = /(destroy|exile) all (?![^.]*\bcards?\b)/i.test(t) || /(all|each) (other )?creatures? gets? -(\d|X)\/-(\d|X)/i.test(t) || /All creatures get -(\d|X)\/-/i.test(t) || /deals? (\d+|X) damage to each (other )?(non\w+ )?creature/i.test(t) ||
      /return all (?![^.]*\bcards?\b)[^.]*? to (their|its) owners?'? hands?/i.test(t) || /each player sacrifices/i.test(t) || /(exile|destroy) each nonland permanent/i.test(t);
    if (m1) {
      let lvl = "strong";
      if (/(destroy|exile) all [^.]*\b(with|that|without|of the chosen|artifacts? (and|or) enchantments?)\b/i.test(t) && !/Destroy all creatures\b/i.test(t) && !/all creatures\./i.test(t)) lvl = "soft";
      if (/(opponents? control|you don't control)/i.test(t) && /\b[1-2] damage|\b-[1-2]\//.test(t)) lvl = "soft";
      if (/each player sacrifices/i.test(t) && !/destroy all/i.test(t)) lvl = "soft";
      if (/(destroy|exile) all artifacts?(?! and)/i.test(t) && !/creatures?/i.test(t)) lvl = "soft";
      if (/Destroy each nonland permanent with mana value X/i.test(t) || /\{X\}:[^.]*destroy each/i.test(t)) lvl = "soft";
      put("mass", lvl);
    } else if (/(destroy|exile) all (?![^.]*\bcards?\b)|each (other )?creature gets -\d|damage to each (other )?creature/i.test(full)) put("mass", "soft");
    return out;
  }
  function classifyRoles(info) {
    const x = classifyRolesEx(info);
    return ROLE_KEYS.filter((k) => x[k] === "strong");
  }
  const COLS = ["W", "U", "B", "R", "G"], BASIC_COL = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };
  function producedColours(info) {
    const out = new Set(), t = info.text || "", land = /\bLand\b/.test(info.frontType);
    if (land) for (const [n, c] of Object.entries(BASIC_COL)) if (new RegExp("\\b" + n + "\\b").test(info.type.split(" // ")[0])) out.add(c);
    for (const m of t.matchAll(/Add ((?:\{[^}]+\})+)/gi)) for (const tok of m[1].matchAll(/\{([^}]+)\}/g)) {
      const x = tok[1].toUpperCase();
      if (COLS.includes(x)) out.add(x); else if (x === "C") out.add("C");
    }
    if (/Add (one|an additional one|X|that much|two|three)[^.]*mana of any (one )?(color|type)|mana of any color/i.test(t)) COLS.forEach((c) => out.add(c));
    if (land) {
      const f = /search your library for an? ([^.]*?) cards?/i.exec(t);
      if (f) { if (/basic land/i.test(f[1])) COLS.forEach((c) => out.add(c)); else for (const [n, c] of Object.entries(BASIC_COL)) if (new RegExp("\\b" + n + "\\b").test(f[1])) out.add(c); }
    }
    return out;
  }
  function deckStats(deck, idx, list, cfg) {
    const tpl = Object.assign({}, (cfg && cfg.template) || DEFAULT_CONFIG.template, deck.targets || {}), overrides = deck.roles || {};
    const cmd = new Set(commandersOf(deck).map((n) => keyOf(idx, n)));
    const st = {
      total: 0, nonLand: 0, lands: 0, unknown: [], commander: [], curve: Array(8).fill(0), mvSum: 0, types: {},
      pips: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, srcLand: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, srcOther: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
      tappedAlways: 0, tappedCond: 0, roles: { land: [], ramp: [], draw: [], targeted: [], mass: [], plan: [] }, soft: { ramp: [], draw: [], targeted: [], mass: [] }, multiRole: 0, targets: tpl,
    };
    const tally = (arr, key, n) => { if (!arr.find((x) => x.key === key)) arr.push({ key, qty: n }); };
    for (const e of list) {
      const info = cardInfo(idx, e.key), q = e.qty;
      if (!info) { st.unknown.push(e.name); continue; }
      if (cmd.has(e.key)) { st.commander.push({ name: info.name, mv: info.mv }); continue; }
      st.total += q;
      const front = info.frontType, isLand = /\bLand\b/.test(front);
      let g = "Other";
      if (isLand) g = "Land"; else for (const k of ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment"]) if (front.includes(k)) { g = k; break; }
      st.types[g] = (st.types[g] || 0) + q;
      const prod = producedColours(info);
      if (isLand) {
        st.lands += q; tally(st.roles.land, e.key, q);
        for (const c of prod) st.srcLand[c] += q;
        const sent = (info.text || "").split(/(?<=[.])\s/).find((x) => /enters (the battlefield )?tapped/i.test(x));
        if (sent) { if (/unless|\bif\b|you may pay|reveal/i.test(sent)) st.tappedCond += q; else st.tappedAlways += q; }
        continue;
      }
      st.nonLand += q;
      const mv = Math.max(0, Math.floor(info.mv || 0));
      st.curve[Math.min(7, mv)] += q; st.mvSum += mv * q;
      for (const m of (info.cost.split(" // ")[0] || "").matchAll(/\{([^}]+)\}/g)) {
        const cs = [...new Set(m[1].toUpperCase().match(/[WUBRG]/g) || [])];
        if (cs.length) cs.forEach((c) => { st.pips[c] += q; }); else if (m[1].toUpperCase() === "C") st.pips.C += q;
      }
      if (prod.size) for (const c of prod) st.srcOther[c] += q;
      const ex = classifyRolesEx(info), auto = ROLE_KEYS.filter((k) => ex[k] === "strong"), roles = overrides[e.key] ? overrides[e.key].filter((x) => ROLE_KEYS.includes(x)) : auto;
      if (!overrides[e.key]) for (const k of ROLE_KEYS) if (ex[k] === "soft") tally(st.soft[k], e.key, q);
      if (roles.length > 1) st.multiRole += q;
      roles.forEach((r) => tally(st.roles[r], e.key, q));
      if (!roles.length) tally(st.roles.plan, e.key, q);
    }
    st.avgMv = st.nonLand ? st.mvSum / st.nonLand : 0;
    const n = (k) => st.roles[k].reduce((s2, x) => s2 + x.qty, 0);
    st.counts = { lands: st.lands, ramp: n("ramp"), draw: n("draw"), targeted: n("targeted"), mass: n("mass"), plan: n("plan") };
    st.softCounts = {}; for (const k of ROLE_KEYS) st.softCounts[k] = st.soft[k].reduce((s2, x) => s2 + x.qty, 0);
    return st;
  }

  const tradesText = (selected) =>
    selected.map((t) => `${t.alloc.reduce((s, r) => s + r.qty, 0)} ${t.name}`).join("\n");

  /* ---------- Card art (Scryfall image CDN, addressed by Scryfall ID = the exact printing you own) ---------- */
  const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function artUrl(sid, version) {
    if (!SID.test(sid || "")) return "";
    return `https://cards.scryfall.io/${version || "art_crop"}/front/${sid[0]}/${sid[1]}/${sid}.jpg`;
  }
  function artByName(name, version) {
    return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(String(name).split(" // ")[0])}&format=image&version=${version || "art_crop"}`;
  }
  // Which printing to show: an explicit sid on the deck card, else an owned row (prefer one in a binder named like the deck), else none.
  function pickSid(own, idx, key, deck) {
    if (deck) {
      const pk = deck.picks && deck.picks[key];
      if (pk && SID.test(pk.sid || "")) return pk.sid;
      const c = (deck.cards || []).find((x) => x.sid && keyOf(idx, x.name) === key);
      if (c && SID.test(c.sid)) return c.sid;
    }
    const o = own && own.get(key);
    if (!o) return "";
    const rows = o.rows.filter((r) => SID.test(r.sid));
    if (deck) {
      const hint = [deck.name, deck.slug, ...commandersOf(deck)].filter(Boolean).map(norm);
      const hit = rows.find((r) => hint.some((h) => h && (norm(r.binder).includes(h) || h.includes(norm(r.binder)))));
      if (hit) return hit.sid;
    }
    return rows.length ? rows[0].sid : "";
  }

  const api = {
    artUrl, artByName, pickSid,
    DEFAULT_CONFIG, norm, isBasic, parseCSV, parseCollection, csvEscape,
    buildIndex, resolve, keyOf, cardInfo, buildOwnership,
    sleeveList, foilSuggestions, pencilStatus, isReflected, syncDeckLists, swapShown, evalWishlist,
    activePencils, commandersOf, deckMap, deckTotal, applySwaps, deckText,
    eligibleRows, printings, printKeyOf, collectionEntries, filterCollection, sortCollection, binderSummary, TYPE_CHIPS, deckStats, classifyRoles, classifyRolesEx, ROLE_KEYS, allocateDeck, pickConflicts, rebuildCSV, rebuildText, buildClaims, sumQty, runChecks, buildTrades, RARS, rowAUD, setLive, basicNames, basicHolders, tidyPlan, printKey, tickEntries, snapPrint, matchTitle, matchAnyTitle, fuzzyEntry, lev, indexBySetCn, fixDigits, cnNum, parseCollector, matchScan, whereIs, upgradeCandidates, deckValue, GAP_ROLES, tradesCSV, tradesText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MTG = api;
})(typeof window !== "undefined" ? window : globalThis);
