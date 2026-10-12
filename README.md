# MTG Deck Tracker

**Want your own copy? See the [set-up and user guide](GUIDE.md).**

Static web app (GitHub Pages) for tracking Commander decks alongside ManaBox. No card or collection data lives in this repo — the app loads it from a private data repo using a read-only GitHub token you paste into the **Data** tab (stored in your browser only).

- **Decks** — lists, pencilled swaps highlighted, per-deck wishlist, full oracle text and art (by your owned Scryfall printing) on tap, export for ManaBox.
- **Check deck** (per deck) — tick off the physical cards, optional camera scan of name and set/number.
- **Check** — deck size, singleton, colour identity, DB matches, collection vs deck claims, pencilled swaps.
- **Trades** — spare copies in free binders, exported as a ManaBox CSV for a trade binder.
- **Wishlist** — per-deck wishlist and pencilled-in cards you don't have free.

Card text, cost, type and colour identity come from the card DB in `muzzaw43/mw-data`. Art comes from Scryfall's image CDN.

Enable hosting: repo Settings → Pages → Deploy from branch → `main` / root.

To update your own fork later: **Sync fork** on GitHub, then refresh the app. Settings live in `site-config.js`.
