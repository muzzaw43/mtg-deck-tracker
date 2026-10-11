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
      setName: col("Set name"), rarity: col("Rarity"), mbid: col("ManaBox ID"), cond: col("Condition"), lang: col("Language"),
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

  /* ---------- Deck stats: roles (Command Zone template), mana curve, colour pips, sources ---------- */
  const ROLE_KEYS = ["ramp", "draw", "targeted", "mass"];
  // Best-guess roles from the card's DB text. Override per card with deck.roles[key] = [..].
  function classifyRoles(info) {
    if (!info || /\bLand\b/.test(info.frontType)) return [];
    const t = info.text || "", spell = /Instant|Sorcery/.test(info.frontType), r = [];
    const ramp = (!spell && /:\s*Add\s+(\{|one |two |three |an amount)/i.test(t)) ||
      (/search your library/i.test(t) && /(basic land|land|Plains|Island|Swamp|Mountain|Forest) cards?/i.test(t) && /battlefield/i.test(t)) ||
      /put (a|an|up to \w+|any number of) (basic )?land cards? (from your hand )?onto the battlefield/i.test(t) ||
      /create (a|an|\w+) Treasure tokens?/i.test(t);
    if (ramp) r.push("ramp");
    if (/\bdraws? (a|an|two|three|four|five|X|that many|\d+|cards? equal|\w+ additional) ?cards?/i.test(t) || /\bdraw (a|two|three) cards?/i.test(t) || /\binvestigate\b|create a Clue/i.test(t) ||
      /look at the top (\w+ )?cards? of your library[^.]*(put|into your hand)/i.test(t) || /exile the top[^.]*you may (play|cast)/i.test(t) || /you may (play|cast)[^.]*from the top of your library/i.test(t)) r.push("draw");
    if (/(destroy|exile) (up to \w+ |another |any number of )?target/i.test(t) || /counter target/i.test(t) || /return target [^.]*? to (its|their) owner'?s? hands?/i.test(t) ||
      /deals? (\d+|X) damage to (any target|target)/i.test(t) || /target [^.]*? gets? -(\d|X)\/-/i.test(t) || /gain control of target/i.test(t) || /target (player|opponent) sacrifices/i.test(t)) r.push("targeted");
    if (/(destroy|exile) all /i.test(t) || /each (other )?creature gets -\d/i.test(t) || /creatures (your opponents control|you don't control) get -/i.test(t) ||
      /deals? \d+ damage to each (other )?(non\w+ )?creature/i.test(t) || /return all [^.]*? to (their|its) owners?'? hands?/i.test(t) || /each player sacrifices/i.test(t)) r.push("mass");
    return r;
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
      tappedAlways: 0, tappedCond: 0, roles: { land: [], ramp: [], draw: [], targeted: [], mass: [], plan: [] }, multiRole: 0, targets: tpl,
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
      const auto = classifyRoles(info), roles = overrides[e.key] ? overrides[e.key].filter((x) => ROLE_KEYS.includes(x)) : auto;
      if (roles.length > 1) st.multiRole += q;
      roles.forEach((r) => tally(st.roles[r], e.key, q));
      if (!roles.length) tally(st.roles.plan, e.key, q);
    }
    st.avgMv = st.nonLand ? st.mvSum / st.nonLand : 0;
    const n = (k) => st.roles[k].reduce((s2, x) => s2 + x.qty, 0);
    st.counts = { lands: st.lands, ramp: n("ramp"), draw: n("draw"), targeted: n("targeted"), mass: n("mass"), plan: n("plan") };
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
    pencilStatus, isReflected, syncDeckLists, swapShown, evalWishlist,
    activePencils, commandersOf, deckMap, deckTotal, applySwaps, deckText,
    eligibleRows, printings, printKeyOf, deckStats, classifyRoles, ROLE_KEYS, allocateDeck, pickConflicts, rebuildCSV, rebuildText, buildClaims, sumQty, runChecks, buildTrades, tradesCSV, tradesText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MTG = api;
})(typeof window !== "undefined" ? window : globalThis);
