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

  const DEFAULT_CONFIG = {
    owner: "muzzaw43",
    dataRepo: "mtg-deck-data",
    branch: "main",
    dbUrl: "https://raw.githubusercontent.com/muzzaw43/mw-data/refs/heads/main/mtg_cards_slim.json",
    // Cards in these binders are free to use / trade.
    freeBinders: ["Not in use", "edge of eternities"],
    // Free only for cards held 2+ times in that binder (one copy stays put, rest are free).
    multiCopyBinders: ["The Hobbit", "Avatar"],
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
      price: get(r, c.price),
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
    for (const c of deck.cards || []) {
      const key = keyOf(idx, c.name);
      const e = m.get(key) || { key, name: resolve(idx, c.name) || c.name, qty: 0 };
      e.qty += c.qty == null ? 1 : c.qty;
      m.set(key, e);
    }
    return m;
  }
  const deckTotal = (m) => [...m.values()].reduce((s, e) => s + e.qty, 0);

  function applySwaps(deck, idx) {
    const m = deckMap(deck, idx);
    for (const p of activePencils(deck)) {
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
      const m = deckMap(d, idx);
      for (const [k, e] of m) add(st === "built" ? hard : soft, k, d, e.qty);
      for (const p of activePencils(d)) {
        if (!p.in) continue;
        const k = keyOf(idx, p.in);
        if (!m.has(k)) add(soft, k, d, 1);
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
        if (cmdCI && info.ci.some((c) => !cmdCI.includes(c)))
          add("error", d, info.name, `Colour identity ${info.ci.join("") || "C"} is outside the commander's (${[...new Set(cmdCI)].join("") || "C"})`);
        if (e.qty > 1 && !isBasic(info.name) && !info.anyNumber)
          add("error", d, info.name, `${e.qty} copies in a singleton deck`);
        if (haveCollection && built && !isBasic(info.name) && !(own.get(key) || { total: 0 }).total)
          add("warn", d, info.name, "Not in the collection CSV (CSV out of date, or list wrong?)");
      }

      for (const p of activePencils(d)) {
        const label = `${p.out || "—"} → ${p.in || "—"}`;
        if (p.out && !m.has(keyOf(idx, p.out))) add("warn", d, p.out, `Pencilled OUT isn't in the list (already swapped?) [${label}]`);
        if (p.in) {
          const k = keyOf(idx, p.in), info = cardInfo(idx, k);
          if (!info) add("error", d, p.in, `Pencilled IN not found in the card DB [${label}]`);
          else {
            if (m.has(k) && !isBasic(info.name)) add("warn", d, info.name, `Pencilled IN is already in the list [${label}]`);
            if (cmdCI && info.ci.some((c) => !cmdCI.includes(c)))
              add("error", d, info.name, `Pencilled IN is outside the commander's colour identity [${label}]`);
            if (haveCollection && !isBasic(info.name)) {
              const o = own.get(k);
              if (!o) add("info", d, info.name, `Pencilled IN isn't owned — on the wishlist? [${label}]`);
              else if (o.free - sumQty(claims.soft.get(k)) < 0 || o.free === 0)
                add("warn", d, info.name, `Owned but no free copy right now [${label}]`);
            }
          }
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
    const order = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => order[a.level] - order[b.level] || a.deckName.localeCompare(b.deckName));
    return out;
  }

  /* ---------- Trades ---------- */
  function buildTrades(ctx, reserve) {
    const { own, claims, cfg, idx } = ctx;
    const free = new Set(cfg.freeBinders.map(norm)), multi = new Set(cfg.multiCopyBinders.map(norm));
    const res = [];
    for (const o of own.values()) {
      if (isBasic(o.name)) continue;
      const hard = sumQty(claims.hard.get(o.key)), soft = sumQty(claims.soft.get(o.key));
      const t = Math.max(0, Math.min(o.free, o.total - hard - soft) - (reserve || 0));
      if (t <= 0) continue;
      // allocate across the rows that sit in free binders
      let left = t;
      const alloc = [];
      const perBinderUsed = new Map();
      for (const r of o.rows) {
        if (left <= 0) break;
        const nb = norm(r.binder);
        let avail = 0;
        if (free.has(nb)) avail = r.qty;
        else if (multi.has(nb)) {
          const binderQty = o.binders.get(r.binder), used = perBinderUsed.get(nb) || 0;
          avail = Math.max(0, Math.min(r.qty, binderQty - 1 - used));
          perBinderUsed.set(nb, used + avail);
        }
        const take = Math.min(avail, left);
        if (take > 0) { alloc.push({ ...r, qty: take }); left -= take; }
      }
      res.push({ key: o.key, name: o.name, total: o.total, free: o.free, hard, soft, tradeable: t, alloc, info: cardInfo(idx, o.key) });
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
    activePencils, commandersOf, deckMap, deckTotal, applySwaps, deckText,
    buildClaims, sumQty, runChecks, buildTrades, tradesCSV, tradesText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MTG = api;
})(typeof window !== "undefined" ? window : globalThis);
