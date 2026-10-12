# MTG Deck Tracker: set-up and user guide

A free web app that sits alongside **ManaBox**. ManaBox stays your collection; this app helps you keep your physical Commander decks, your swaps and your ManaBox list in step. It runs on GitHub Pages, installs on a phone like an app, and keeps all your data in **your own private GitHub repo**. Nothing is stored on anyone else's server.

> This guide is kept up to date with the app. The **What's new** list at the bottom shows what changed and when. If a step here doesn't match what you see, check that you are on the latest version (see "Getting updates").

---

## Part 1: What you need

- A free **GitHub** account (github.com).
- The **ManaBox** app with your collection in it, and a way to export a CSV from it.
- About 20 minutes the first time.

## Part 2: Set up your own copy

### Step 1. Fork the app
1. Open the app's repository page (the person who sent you this guide has the link: `github.com/muzzaw43/mtg-deck-tracker`).
2. Click **Fork** (top right) and accept the defaults. You now have your own copy under your account.

### Step 2. Turn on GitHub Pages (this gives you a website)
1. In *your* fork go to **Settings → Pages**.
2. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute or two the page shows your site address, which looks like `https://YOUR-NAME.github.io/mtg-deck-tracker/`.

### Step 3. Point the app at your account
1. In your fork open the file **`site-config.js`** and click the pencil (edit) icon.
2. Change `owner: "muzzaw43"` to your own GitHub username. Leave the rest unless you name your data repo differently in Step 4 (then change `dataRepo` too).
3. **Commit changes**. This is the only file you ever need to edit.

### Step 4. Create your private data repo
This is where your decks and your collection export live. Keep it **private**.
1. Click **+ → New repository**. Name it **`mtg-deck-data`**, choose **Private**, tick **Add a README**, then **Create**.
2. In the new repo choose **Add file → Create new file** and make these files (the `/` in a name creates the folder):

   **`config.json`**
   ```json
   {
     "freeBinders": ["Not in use"],
     "multiCopyBinders": []
   }
   ```
   `freeBinders` lists the ManaBox binders whose cards are free to move into decks or trade. Use the exact binder names from ManaBox.

   **`wishlist.json`**
   ```json
   []
   ```

   **`decks/_example.json`** (files starting with `_` are ignored)
   ```json
   {
     "name": "Example (ignored by the app)",
     "commander": "Commander Name",
     "status": "planned",
     "updated": "2026-01-01",
     "cards": [{ "name": "Sol Ring", "qty": 1 }],
     "pencilled": [],
     "wishlist": []
   }
   ```

### Step 5. Add your collection
1. In ManaBox, export your collection as a CSV (look for the export option in the collection or settings menu; the wording changes between versions).
2. In your data repo open the `collection` folder (create it by adding a file called `collection/ManaBox_Collection.csv`) and upload the CSV there. Later you can upload new exports from inside the app (Step 8).

### Step 6. Add your decks
Each deck is one small file in `decks/`, for example `decks/my-first-deck.json`:
```json
{
  "name": "My First Deck",
  "commander": "Commander Name",
  "status": "built",
  "updated": "2026-01-01",
  "cards": [{ "name": "Commander Name", "qty": 1 }],
  "pencilled": [],
  "wishlist": []
}
```
- **`name` must match the ManaBox deck binder name exactly.** If it does, the app reads the real card list from your CSV and you don't have to type the 100 cards.
- If you have no matching ManaBox deck binder, put the full list in `cards`.
- `status` can be `built`, `planned` or `retired`.

### Step 7. Make an access token
The app reads (and optionally writes) your private repo using a token that you paste into the app. It stays in your browser only.
1. GitHub → your profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** *Only select repositories* → pick **`mtg-deck-data`**.
3. **Permissions → Repository permissions → Contents:** choose **Read and write** if you want to save swaps, wishlist items and CSV uploads from the app. Choose **Read-only** for someone who only needs to look.
4. Pick an expiry, generate it, and **copy the token now** (GitHub shows it once).
5. **Never post the token anywhere or send it in a message.** Anyone with it can read (and with write access, change) your data repo.

### Step 8. Open the app
1. Visit your site address from Step 2.
2. Open the **Data** tab, paste the token into the token box and save. The decks load.
3. If you made a read-and-write token, paste it in the *write token* box too (the same token works for both).
4. To update the collection later: export a fresh CSV from ManaBox and upload it on the **Data** tab. The app checks it before replacing the old one.

### Step 9. Put it on your phone like an app
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu → **Install app** / **Add to Home screen**.
- If the app looks out of date after an update, tap the **⟳** button at the top right to refresh it.

### Sharing with a partner or friend
Give them the site address and a token for the same data repo (read-only to just look, read and write to make swaps). They are asked for a name the first time they save so changes show who made them, and you can review their swaps afterwards. Make a separate token per person so you can revoke one without affecting others.

---

## Part 3: Using it

| Tab | What it's for |
|---|---|
| **Decks** | All your decks. Open one to see it as stacks, a grid or a list; press and hold (phone) or hover (desktop) a card for a large image. Pencil in swaps, set role targets, see deck stats, find upgrades, and check the physical deck. Search box at the top: "where is this card?". |
| **Collection** | Binders like ManaBox, every card with filters (set, colours, colour identity, mana value, type, price), and a **Sets** view showing what you have against what's missing in a whole set. |
| **Check** | Automatic health checks: deck size, duplicates, colour identity, cards claimed by two decks, swaps that don't match the list. |
| **Trades** | Spare cards in your free binders after reserving what decks need, with price filters and spare counts by rarity. Export as a ManaBox CSV or text. |
| **Wishlist** | Cards you want, per deck. |
| **Data** | Tokens, upload a new CSV, and a log of what loaded. |

### Swaps
A swap is a card going OUT and a card coming IN. It moves through **pencilled → approved → made → done**. Nothing changes on its own: you decide each step, and "made" means you've physically swapped the cards but ManaBox isn't updated yet. After you update ManaBox and re-upload the CSV, the app recognises it and marks it reflected.

### Upgrade finder
On a deck, tap **Upgrade finder**. It shows cards you already own, in the deck's colours, that are not locked in another built deck and that fill a role the deck is short on (ramp, card advantage, targeted removal, sweepers). Each has a "Why" line. It only suggests; "Pencil in…" asks which card to cut and adds a pencilled swap.

### Check deck (tick list and camera scanner)
On a deck, tap **Check deck** to sit down with the physical cards.
- Choose what to check against: *as it is physically*, *the list in ManaBox*, or *with all confirmed swaps*.
- Tap a card to tick it off; tap again to cycle back. Filters show what is left to find.
- **Scan with camera** reads the small print at the bottom-left of the card (set code and collector number) and ticks the exact printing from your list. If that isn't readable (older cards, no set code) it reads the name instead. It warns if the card is the right name but a different printing. The camera finds the card's outline itself (like ManaBox), straightens it, and reads it, so it doesn't need to sit exactly in the guide frame; a tilted or sideways card is fine, and an upside-down one is turned after a moment. Tap the screen to count another copy of the same card; the last result stays up until a different card appears. The top bar shows "card found" when it has the outline. Good light and a plain background help. In Check deck, the scanner also compares the straightened card against the deck's card pictures (it shows "learning the deck" for a few seconds at the start), which is faster and more reliable than reading text; text is the fallback. The first scan downloads the outline-finder (a few MB, cached afterwards); if that fails it falls back to the guide frame.
- **Scan history.** Tap **History** in the scanner bar to see everything scanned in order and remove any scan that shouldn't have counted.
- **Foil is flagged by hand.** The foil star is too small for the camera to read, so the scanner ignores foil. Each card in the list has a **★** button: tap it to say "this one is foil" (tap again for normal). If that differs from the list, it's shown on the row and in the report.
- A card that isn't on the deck's list is named with a "Note as extra" button. A line at the bottom shows the raw text it read, which helps if it can't match.
- Extra cards found in the deck can be added to "not on the list". The result is a *missing and extra* report and a *list of what's physically here*.
- This **never** adds anything to your ManaBox collection. Ticks are kept in your browser only.
- The camera needs permission, and the first scan downloads a text-recognition library, so it needs internet that first time.

### Scan in a deck list from scratch
On the **Decks** tab, tap **Scan in a deck list**. Scan the cards of any physical deck and the app builds the list as you go (the same card twice adds a count; **Undo** removes a misread). Tap ★ on foils and use − and + to fix counts. It names cards from the small print using your collection, or from the title if the card isn't in your collection. It never adds anything to ManaBox or your collection. When you're done you can copy the list as text or CSV, or **Save as a deck** (needs the write token). Give it the same name as the ManaBox deck binder and it will read the real list from your CSV.

### Prices
Values are live Scryfall market prices (USD) converted to AUD. They load quietly in the background; until then (or for cards with no market price) ManaBox's own price from your CSV is used. To show a different currency, change the exchange rate source in `app.js` (`loadLivePrices`) or ask for it to be made a setting.

### Something not right?
- *"Token rejected" or no decks:* the token expired, or it was not given access to `mtg-deck-data`. Make a new one (Step 7).
- *A deck is missing:* its file must be in `decks/`, end in `.json`, and not start with `_`.
- *Deck shows the wrong cards:* the deck `name` has to match the ManaBox deck binder exactly.
- *Changes don't show after an update:* tap **⟳**, or close and reopen the app.
- *Saving fails:* your token is read-only. Make a read and write token (Step 7).

---

## Getting updates
**Automatic (recommended).** Your fork contains a small job, *Sync with upstream*, that checks once a day for improvements to the original app and brings them in. You switch it on once:
1. In your fork open the **Actions** tab and click **I understand my workflows, go ahead and enable them**.
2. Click **Sync with upstream** in the list, then **Run workflow** to try it. Green tick = working.
After that it runs by itself. Updates appear in your app after a refresh (tap **⟳**). Your settings in `site-config.js`, and any edits you make yourself, win if they clash with an update. Your data repo is never touched.

**Manual.** On your fork's front page click **Sync fork → Update branch** whenever you like.

**If you want your own independent version** (no updates from the original), stop the sync: Actions tab → *Sync with upstream* → **⋯ → Disable workflow** (or set a repository variable `AUTO_SYNC` to `off` under Settings → Secrets and variables → Actions → Variables). You can then change anything you like. You can re-enable it later and pull updates again, though your own changes may then need merging by hand.

GitHub pauses scheduled jobs in a repository nothing has happened in for about two months. If updates ever stop, open the Actions tab and re-enable it, or use the manual Sync button.

## Privacy
- Your collection and decks live in your private repo only.
- The token is stored in your browser only.
- The app fetches card text from a public card database file, card images and set lists from Scryfall, and exchange rates from frankfurter.app, all from your own device.

---

## What's new
Newest first. Each time the app gains a feature this list and the sections above are updated.

- **Printing audit:** in Check deck, **Printing audit (fix in ManaBox)** lists every scanned card whose physical printing differs from what ManaBox has ("ManaBox has AER #176 → physical is BRC #158"), marks the ones to check by eye (the app had to correct a misread), and lists cards counted by name or picture only, where the printing was never read. A **To double-check** filter shows those cards, and it opens by itself when you finish scanning if there are any.
- **Retro / old-frame cards:** cards with no set code at the bottom-left (the number sits at the end of the copyright line, e.g. a retro-frame Servo Schematic, BRC 158) are now read too: the scanner also reads the bottom-right, takes the number, and uses Scryfall's list of that card's printings to work out the set. If the picture match is only middling, the name is read as well and overrules a wrong look-alike match.
- **Scan history:** the **History** button in the scanner bar lists every scan in order, newest first, with a **Remove** next to each, so a false scan (a card it registered that you never held up) can be taken out. It works in Check deck and in Scan in a deck list.
- **Printings check against Scryfall:** when the small print doesn't match a printing on your list, the app looks up every real printing of that card on Scryfall (cached on the phone) and corrects a misread set code or number to the real one (e.g. WHO 023 to WHO 239, MKC 257 to MKC 237). If several real printings are close it shows them as buttons to choose from. Only the list of set codes and numbers is fetched; card text still comes from your card database.
- **Alternate art:** the scanner also learns every printing of the deck's cards that you own (so a showcase or borderless copy sitting in another binder is recognised and noted as a different printing). If it still can't recognise a card, tap **Pick the card…**, type the name, and it counts the card and learns how that one looks for the rest of the check.
- **Ding:** each counted card plays a short ding (and a tiny vibration where the phone allows it). The 🔔 in the scanner bar mutes it.
- **Corrections and sleeves:** a misread number one character off a listed printing (e.g. 257 for 237) is taken as the listed one, with a "No, it really is…" button; every result has **Wrong printing?** and every "found as…" note has a **✕**. Sleeved cards are matched with and without the sleeve margin, and if no outline is found it tries the guide frame at a few sizes and offsets. Dark sleeves on a dark surface are hardest: hold them against something light.
- **Scanner keeps the last result on screen** until the next card needs attention, and **tapping the screen scans another copy of the same card** (like ManaBox).
- **Different printings are fine:** the scanner recognises the card by name first, then reads the set/number to match the right printing, or counts it and notes "found as OTC #280" when it isn't the printing in the list.
- **Scanner matches the card's picture** (like ManaBox): it learns the deck's card pictures from Scryfall, finds the card's outline even at an angle, straightens it and compares the picture, so most cards are recognised instantly without reading any text. Text reading is the fallback.
- **Scanner finds the card's outline** (OpenCV) and straightens it before reading, so alignment matters much less.
- **Automatic updates for forks:** a daily *Sync with upstream* job (opt out any time).
- **Foil flag by hand and scan-in a deck list:** the scanner no longer tries to read foil; tap ★ on a card instead. New **Scan in a deck list** builds a deck list from scratch without touching your collection.
- **Scanner reads the bottom-left small print first** (faster and exact), only reading the title when that isn't enough; steadier messages, and moving straight to the next card now counts it.
- **Scanner feedback and close-confirm fix:** the scanner now says what it read, and names cards that aren't on the deck's list so you can tell it's working; the "Close the app?" prompt is armed on your first tap so Chrome can't skip it.
- **Check deck:** tick list for a physical deck plus a camera scanner that reads the name and the set/number line.
- **Live prices** (Scryfall, converted to AUD), loaded in the background; upgrade finder now shows card images with a reason for each suggestion.
- **Upgrade finder, "where is this card?", values in AUD, stale-data warning, add to wishlist from a card, and an illegal-card info check.**
- **Settings in one place:** `site-config.js` replaces editing app code for forks.
- Collection tab with binders, filters, sets checklist and card rulings; swap comments and review queue; install-as-app on phones; trade controls (price filter, spares by rarity); back-button confirm and refresh button.
