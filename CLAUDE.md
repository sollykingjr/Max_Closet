# Max's Closet: project guide

Personal virtual closet and secondhand-buying tracker for Max. Live at https://maxs-closet.maxcsolomon.workers.dev (behind Cloudflare Access, email login). Repo: sollykingjr/Max_Closet. Deploys automatically on every push to `main` (Cloudflare Workers Builds, about 1-2 minutes).

## What it is for
Max buys secondhand (eBay, Poshmark) with weak return policies, so he only buys styles he has already tried on. The app tracks (1) what he owns, with photos, (2) every style he has evaluated and the size that fits, (3) what he wears and cost per wear, (4) AI outfits from his own closet, (5) a deal check for listings.

## The 3 things that must stay easy
1. **See stuff:** photo grid home page.
2. **Pick outfits:** one screen, one tap.
3. **Log wears:** tap pieces in the closet grid, then tap Log.
Max has abandoned other apps and Notion because they were clunky. Keep the home screen minimal (no stat tiles), keep flows to a few taps, never add clutter to the Closet page. Must work on desktop and phone.

## Stack and files
- Cloudflare Worker + D1 database `fit-ledger` (id fbbd1410-6dc1-4c24-95f7-c9551edd8892). No framework, no build step.
- `wrangler.jsonc`: Worker `maxs-closet`, D1 binding `DB`, assets binding `ASSETS`, vars `PROVIDER` and `ALLOWED_EMAIL`. Secret `OPENAI_API_KEY` is set in the Cloudflare dashboard, never in the repo.
- `src/worker.js`: all API routes, D1 schema and migrations (`init()`), the AI adapter (`callLLM`: openai / gemini / anthropic via `PROVIDER`), all AI prompts, link reading (`readPage`).
- `src/seed.json`: the 159 items imported from Max's Notion, loaded once on an empty database.
- `public/index.html`: the entire UI (HTML, CSS, JS in one file).

## Data model
- `items`: id, name, brand, cat, subs[] (type tags), colors[], size, status, paid (per piece), max_price, fabric, note, url, rating (1-5), look (AI/own description; may hold a "Color: <exact shade>." line that regenerating from a photo keeps), bought (where bought, e.g. "Poshmark, NWT"), qty (owned count), uses[] (tags), seasons[] (Spring/Summer/Fall/Winter), purchases[] (history lines), updated_at.
- Status: `closet` (owned; the only status shown in Closet and used for outfits), `approved` (tried, fits, safe to rebuy; not owned, e.g. socks), `try`, `passed`, `retired`.
- `wears` + `wear_items`: one entry per logged wear (date, count, kind `outfit` or `bulk`, items). Bulk = past-wear estimates; they count toward cost per wear but not "last worn".
- `photos`: thumb (256px) and full (900px) JPEG as base64 in D1, served from `/api/photo/:id` with long caching.
- `settings`: `rules` (Max's buying rules, used by AI), flags `seeded`, `cats_v2`.
- Categories: T-Shirts, Button Downs, Polos, Long Sleeves, Sweaters, Activewear, Pants, Shorts, Outerwear, Blazer, Shoes, Accessories, Bathing Suit, Socks.
- Tags (`uses`): Work, Casual, Lounge, Dressy, Workout, Travel (where), and "how": T-Shirts and Long Sleeves get Undershirt and/or Top layer (neither = top layer); Button Downs get Can wear open (assumed buttoned, never open, unless tagged). Other categories have no "how" tags. Old tags are mapped by `normalizeUses` in worker.js.
- Quantity and prices: identical copies are ONE item. `purchases` is a list of lines `{id, n, price, date, retired}` (n copies bought at `price` on `date`; `retired` of them retired, but never all copies: retire the whole piece with Status instead). `qty` = owned copies (sum of n - retired) and `paid` = average price per copy, both derived by the server from `purchases`. Cost per wear = total spent on all lines (retired copies included) / total wears. Pieces saved before purchase history have no lines and show one virtual line built from `qty` and `paid`. Pieces with status try or passed drop lines that have no price.
- Fill-from-link keeps the color out of the name, drops a trailing size from the name, and adds "Color: <exact shade>." to the description when the listed shade says more than the simple color tags.

## Tabs
Closet (photo grid, category chips, sort, "Log what I wore" select mode, add piece) / Outfits (modes Mix it up, Favorites, Been a while; occasion; optional anchor piece; "I wore this today") / Shop (deal check for link, text or screenshot; rules; Fit log) / Stats (cost per wear, never worn, history, bulk past wears).

## Rules for making changes
- Work on one section at a time; change only what was asked.
- Schema changes: add a guarded `ALTER TABLE ... ADD COLUMN` in `init()` (check `pragma_table_info`), never drop or rename columns, and keep old rows working. One-off fixes to live data go through D1 SQL; ask Max before deleting or merging anything.
- Test locally before pushing: `npm install`, `npx wrangler dev --port 8799 --local`, send header `cf-access-authenticated-user-email: maxcsolomon@gmail.com` (or use Playwright with that header). Without an API key AI routes return a clear error, which is expected.
- Push to `main` to deploy. Commit messages end with the standard Claude attribution lines.
- Keep AI cheap: descriptions are generated once per photo (low-detail image) and stored; outfit/deal prompts send text only. Do not add per-request image sends unless needed (deal-check screenshots are the exception).
- Prompts live in `src/worker.js`; keep outputs as strict JSON and validate ids server-side.
- UI rules: global `[hidden]{display:none!important}` must stay; never put buttons inside a `<label>` (clicks get forwarded); no localStorage for data; every failed save must show a visible message; keep tap targets large and the layout working at 390px and 1440px wide.
- Never commit secrets. Keep the `ALLOWED_EMAIL` guard.

## Known limits and ideas
- Fill-from-link is best-effort: some sites (eBay, Poshmark) block automated fetches; fall back to pasted text or a screenshot.
- Access sign-in expires (24h default); saves then fail with a message to reload.
- Ideas not built: retire-candidate flags for long-unworn pieces, weather-aware outfits, trip packing lists, wishlist price targets, usage counter, closet value summary.
- Sections still to review with Max one by one: Outfits, Shop, Stats (Closet is being polished first).
