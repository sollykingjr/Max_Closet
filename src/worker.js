// Max's Closet — Cloudflare Worker + D1.
// Static UI lives in /public (served by the assets binding). This file handles /api/*.
import SEED from "./seed.json";

const USES = ["Work", "Casual", "Lounge", "Dressy", "Workout", "Travel", "Undershirt only", "Also undershirt", "Can wear open"];
const STATUSES = ["closet", "approved", "try", "passed", "retired"];
const CATS = ["T-Shirts", "Button Downs", "Polos", "Long Sleeves", "Sweaters", "Activewear", "Pants", "Shorts", "Outerwear", "Blazer", "Shoes", "Accessories", "Bathing Suit", "Socks"];

// Older data used one "Shirt" category. Split it by the style types on the piece.
function migrateCat(cat, subs) {
  if (cat !== "Shirt") return cat;
  const s = new Set((subs || []).map((x) => String(x)));
  const has = (...k) => k.some((x) => s.has(x));
  if (has("Button Down", "Oxford", "Dress Shirt")) return "Button Downs";
  if (has("Polo")) return "Polos";
  if (has("Quarter Zip", "Sweater", "Sweatshirt")) return "Sweaters";
  if (has("Long Sleeve")) return "Long Sleeves";
  if (has("T-Shirt")) return "T-Shirts";
  if (has("Workout", "Performance", "Tech")) return "Activewear";
  return "T-Shirts";
}

const DEFAULT_RULES =
  "Runs hot. Wants year-round work button-downs that are comfortable in the 70s to 80s.\n" +
  "Likes thicker, structured shirts that do not run hot (oxford cotton, Marine Layer, Faherty). Plain thin cotton or poplin button-downs feel too thin.\n" +
  "Prefers natural fibers over synthetic.\n" +
  "Budget about $50-100 per shirt on sale, up to about $150 from brands that run sales.\n" +
  "Does not pay full price. Buys secondhand on eBay and Poshmark, so only buys styles already tried on (weak return policies).";

/* ------------------------------ helpers ------------------------------ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

const str = (v, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v) =>
  Array.isArray(v) ? v.map((x) => str(x, 80)).filter(Boolean).slice(0, 20) : [];
const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

function toItem(r) {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand || "",
    cat: r.cat || "",
    subs: JSON.parse(r.subs || "[]"),
    colors: JSON.parse(r.colors || "[]"),
    size: r.size || "",
    status: r.status,
    paid: r.paid,
    maxPrice: r.max_price,
    fabric: r.fabric || "",
    note: r.note || "",
    url: r.url || "",
    rating: r.rating == null ? null : r.rating,
    look: r.look || "",
    qty: r.qty || 1,
    uses: JSON.parse(r.uses || "[]"),
    photoV: r.photo_v || null,
  };
}

function cleanItem(id, b) {
  if (!b || typeof b !== "object") return null;
  const name = str(b.name, 200);
  if (!name) return null;
  const status = STATUSES.includes(b.status) ? b.status : "try";
  const cat0 = migrateCat(b.cat, b.subs);
  const cat = CATS.includes(cat0) ? cat0 : "";
  return {
    id,
    name,
    brand: str(b.brand, 100),
    cat,
    subs: strList(b.subs),
    colors: strList(b.colors),
    size: str(b.size, 40),
    status,
    paid: numOrNull(b.paid),
    max_price: numOrNull(b.maxPrice),
    fabric: str(b.fabric, 200),
    note: str(b.note, 1000),
    url: str(b.url, 500),
    rating: ratingOrNull(b.rating),
    look: str(b.look, 600),
    qty: Math.min(99, Math.max(1, parseInt(b.qty, 10) || 1)),
    uses: (Array.isArray(b.uses) ? b.uses : []).map((x) => (x === "Layer only" ? "Undershirt only" : x)).filter((x) => USES.includes(x)),
  };
}
const ratingOrNull = (v) => {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 5 ? n : null;
};

const COLS = ["id","name","brand","cat","subs","colors","size","status","paid","max_price","fabric","note","url","rating","look","qty","uses","updated_at"];
const UPSERT =
  "INSERT INTO items (" + COLS.join(",") + ") VALUES (" + COLS.map(() => "?").join(",") + ") " +
  "ON CONFLICT(id) DO UPDATE SET " + COLS.slice(1).map((c) => c + "=excluded." + c).join(",");

const itemBinds = (c) => [
  c.id, c.name, c.brand, c.cat, JSON.stringify(c.subs), JSON.stringify(c.colors), c.size, c.status,
  c.paid, c.max_price, c.fabric, c.note, c.url, c.rating, c.look, c.qty, JSON.stringify(c.uses), Date.now(),
];
const upsertStmt = (env, c) => env.DB.prepare(UPSERT).bind(...itemBinds(c));

/* ------------------------------ database ------------------------------ */

let ready = null;
function ensureReady(env) {
  if (!ready) ready = init(env).catch((e) => { ready = null; throw e; });
  return ready;
}

async function init(env) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, cat TEXT, " +
      "subs TEXT, colors TEXT, size TEXT, status TEXT NOT NULL, paid REAL, max_price REAL, fabric TEXT, " +
      "note TEXT, url TEXT, updated_at INTEGER)"
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wears (id TEXT PRIMARY KEY, date TEXT NOT NULL, count INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT, created_at INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wear_items (wear_id TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (wear_id, item_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS photos (item_id TEXT PRIMARY KEY, thumb TEXT NOT NULL, full TEXT NOT NULL, updated_at INTEGER)"),
  ]);
  // Migrate older databases: add columns introduced later.
  const { results: cols } = await env.DB.prepare("SELECT name FROM pragma_table_info('items')").all();
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("rating")) await env.DB.prepare("ALTER TABLE items ADD COLUMN rating INTEGER").run();
  if (!have.has("qty")) await env.DB.prepare("ALTER TABLE items ADD COLUMN qty INTEGER").run();
  if (!have.has("uses")) await env.DB.prepare("ALTER TABLE items ADD COLUMN uses TEXT").run();
  if (!have.has("look")) await env.DB.prepare("ALTER TABLE items ADD COLUMN look TEXT").run();

  const seeded = await env.DB.prepare("SELECT value FROM settings WHERE key='seeded'").first();
  if (seeded) {
    const done = await env.DB.prepare("SELECT value FROM settings WHERE key='cats_v2'").first();
    if (!done) {
      const { results } = await env.DB.prepare("SELECT id, subs FROM items WHERE cat='Shirt'").all();
      const ups = results.map((r) =>
        env.DB.prepare("UPDATE items SET cat=? WHERE id=?").bind(migrateCat("Shirt", JSON.parse(r.subs || "[]")), r.id));
      for (let i = 0; i < ups.length; i += 40) await env.DB.batch(ups.slice(i, i + 40));
      await env.DB.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('cats_v2','1')").run();
    }
    return;
  }
  // First run: load the closet imported from Notion. INSERT OR IGNORE keeps a retry safe.
  const ins = UPSERT.replace("INSERT INTO", "INSERT OR IGNORE INTO").replace(/ ON CONFLICT.*$/, "");
  const stmts = SEED.map((raw) => env.DB.prepare(ins).bind(...itemBinds(cleanItem(raw.id, raw))));
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('rules',?)").bind(DEFAULT_RULES),
    env.DB.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('seeded','1')"),
    env.DB.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('cats_v2','1')"),
  ]);
}

async function loadAll(env) {
  const { results } = await env.DB.prepare(
    "SELECT items.*, (SELECT updated_at FROM photos WHERE item_id = items.id) AS photo_v FROM items"
  ).all();
  const items = results.map(toItem);
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key='rules'").first();
  const { results: wr } = await env.DB.prepare("SELECT * FROM wears ORDER BY date DESC, created_at DESC LIMIT 5000").all();
  const { results: wi } = await env.DB.prepare("SELECT * FROM wear_items").all();
  const by = {};
  for (const x of wi) (by[x.wear_id] ||= []).push(x.item_id);
  const wears = wr.map((w) => ({ id: w.id, date: w.date, count: w.count, kind: w.kind, note: w.note || "", itemIds: by[w.id] || [] }));
  return { items, rules: r ? r.value : DEFAULT_RULES, wears };
}

function wearStats(wears) {
  const m = {};
  for (const w of wears) for (const id of w.itemIds) {
    const s = (m[id] ||= { n: 0, last: "" });
    s.n += w.count;
    if (w.kind !== "bulk" && w.date > s.last) s.last = w.date;
  }
  return m;
}

/* ------------------------------ AI adapter ------------------------------ */
// PROVIDER = openai (default) | gemini | anthropic. Keys are Worker secrets:
// OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY. Models can be overridden with
// OPENAI_MODEL, GEMINI_MODEL, ANTHROPIC_MODEL.

function parseDataUrl(u) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(u || "");
  return m ? { mime: m[1], data: m[2] } : null;
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (_) { /* fall through */ }
  const a = text.indexOf("{"), z = text.lastIndexOf("}");
  if (a > -1 && z > a) { try { return JSON.parse(text.slice(a, z + 1)); } catch (_) { /* fall through */ } }
  throw new Error("The AI reply could not be read. Try again.");
}

async function callLLM(env, { system, prompt, image, lowDetail = false }) {
  const provider = (env.PROVIDER || "openai").toLowerCase();
  const img = image ? parseDataUrl(image) : null;
  let res, body, text;

  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set on the Worker.");
    const content = [{ type: "text", text: prompt }];
    if (img) content.push({ type: "image_url", image_url: lowDetail ? { url: image, detail: "low" } : { url: image } });
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content }],
      }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("OpenAI: " + ((body.error && body.error.message) || res.status));
    text = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  } else if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set on the Worker.");
    const parts = [{ text: prompt }];
    if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    const model = env.GEMINI_MODEL || "gemini-flash-latest";
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Gemini: " + ((body.error && body.error.message) || res.status));
    const p = body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
    text = p && p.map((x) => x.text || "").join("");
  } else if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the Worker.");
    const content = [];
    if (img) content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
    content.push({ type: "text", text: prompt + "\n\nReturn only the JSON object, no other text." });
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-haiku-5-5",
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content }],
      }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Anthropic: " + ((body.error && body.error.message) || res.status));
    text = body.content && body.content.map((x) => x.text || "").join("");
  } else {
    throw new Error("Unknown PROVIDER: " + provider);
  }

  if (!text) throw new Error("The AI returned nothing. Try again.");
  return extractJson(text);
}

/* ------------------------------ product pages ------------------------------ */

const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function meta(html, key) {
  const re = new RegExp("<meta[^>]+(?:property|name)=[\"']" + key + "[\"'][^>]*>", "i");
  const tag = (re.exec(html) || [""])[0];
  const m = /content=["']([^"']*)["']/i.exec(tag);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'") : "";
}

async function readPage(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error("That does not look like a link."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https links work.");
  let res;
  try {
    res = await fetch(u.toString(), { headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }, redirect: "follow" });
  } catch (_) { throw new Error("Could not reach that page. Paste the listing text or a screenshot instead."); }
  if (!res.ok) throw new Error("That site blocked the request (" + res.status + "). Paste the listing text or a screenshot instead.");
  const html = (await res.text()).slice(0, 700000);
  const parts = [];
  const title = meta(html, "og:title") || (/<title[^>]*>([^<]*)/i.exec(html) || [])[1] || "";
  if (title) parts.push("Title: " + title.trim());
  const desc = meta(html, "og:description") || meta(html, "description");
  if (desc) parts.push("Description: " + desc.trim());
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (/"Product"/.test(m[1])) parts.push("Structured data: " + m[1].replace(/\s+/g, " ").slice(0, 2500));
  }
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  parts.push("Page text: " + body.slice(0, 3000));
  if (parts.length < 2 || body.length < 80) throw new Error("That page had no readable product details. Paste the listing text or a screenshot instead.");

  let photo = null;
  const img = meta(html, "og:image") || meta(html, "twitter:image");
  if (img) {
    try {
      const ir = await fetch(new URL(img, u).toString(), { headers: { "user-agent": BROWSER_UA } });
      const buf = ir.ok ? await ir.arrayBuffer() : null;
      const type = ir.headers.get("content-type") || "";
      if (buf && buf.byteLength < 3_000_000 && /^image\/(jpeg|png|webp)/.test(type)) {
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        photo = "data:" + type.split(";")[0] + ";base64," + btoa(bin);
      }
    } catch (_) { /* photo is optional */ }
  }
  return { text: parts.join("\n"), photo };
}

/* ------------------------------ prompts ------------------------------ */

const label = (i) => (i.brand ? i.brand + " " : "") + i.name;
const byLabel = (a, b) => label(a).localeCompare(label(b));
const known = (i) => i.status === "closet" || i.status === "approved";

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const closetLines = (items, ws = {}, today = "") =>
  items.filter((i) => i.status === "closet").sort(byLabel).map((i) => {
    const st = ws[i.id] || { n: 0, last: "" };
    const last = st.last && today ? daysBetween(st.last, today) + " days ago" : "no recent record";
    return [i.id, label(i), i.cat, i.subs.join("/"), i.colors.join("/"), i.fabric || "", i.look || "", i.uses.length ? i.uses.join("/") : "any",
      i.rating ? i.rating + "/5" : "unrated", (i.qty > 1 ? "own " + i.qty + " " : "") + st.n + " wears", "last worn " + last].join(" | ");
  }).join("\n");

const knownLines = (items) =>
  items.filter(known).sort(byLabel).map((i) =>
    label(i) + " | size " + (i.size || "?") + (i.maxPrice != null ? " | max $" + i.maxPrice : "") + (i.note ? " | " + i.note : "")
  ).join("\n");

const passedLines = (items) =>
  items.filter((i) => i.status === "passed").sort(byLabel).map((i) =>
    label(i) + (i.size ? " | tried " + i.size : "") + (i.note ? " | " + i.note : "")
  ).join("\n");

const SYSTEM = "You are a careful personal stylist and secondhand-shopping assistant. Always reply with a single JSON object and nothing else.";

async function runAI(env, b) {
  const task = b.task;
  if (task === "fill") {
    let text = str(b.text, 6000);
    const url = str(b.url, 600);
    let photo = null;
    const image = typeof b.image === "string" && b.image.length < 8_000_000 ? b.image : "";
    if (url) {
      const page = await readPage(url);
      text = (page.text + "\n" + text).trim();
      photo = page.photo;
    }
    if (!text && !image) throw new Error("Paste a link, listing text or a screenshot first.");
    const prompt =
      'Extract clothing details from this listing or product page. Return only JSON: {"name":string,"brand":string,"category":one of ' +
      CATS.join("/") + ',"colors":[string],"subs":[string],"fabric":string,"size":string,"price":number|null,' +
      '"look":string}. Use empty strings when unknown. "name" excludes the brand. "subs" are style types like Oxford, Polo, Chino. ' +
      '"look" is at most 30 words for a stylist: main colors, pattern, fabric look and weight, silhouette, how dressy. "price" is the listed price.\n\n' + text.slice(0, 7000);
    const r = await callLLM(env, { system: SYSTEM, prompt, image });
    return {
      name: str(r.name, 200), brand: str(r.brand, 100), category: CATS.includes(r.category) ? r.category : "",
      colors: strList(r.colors), subs: strList(r.subs), fabric: str(r.fabric, 200), size: str(r.size, 40),
      price: numOrNull(r.price), look: str(r.look, 600), photo,
    };
  }

  const { items, rules, wears } = await loadAll(env);
  const ws = wearStats(wears);

  if (task === "outfits") {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today || "") ? b.today : new Date().toISOString().slice(0, 10);
    const closet = closetLines(items, ws, today);
    if (!closet) throw new Error("Your closet is empty. Add pieces first.");
    const occ = str(b.occasion, 300) || "a normal day";
    const anchor = str(b.anchor, 60);
    const mode = ["favorites", "while"].includes(b.mode) ? b.mode : "mix";
    const owned = items.filter((i) => i.status === "closet");
    const favs = [...owned].sort((x, y) => (y.rating || 0) - (x.rating || 0) || ((ws[y.id] || {}).n || 0) - ((ws[x.id] || {}).n || 0)).slice(0, 25).map((i) => i.id);
    const stale = [...owned].sort((x, y) => ((ws[x.id] || {}).last || "") < ((ws[y.id] || {}).last || "") ? -1 : 1).slice(0, 25).map((i) => i.id);
    const plan = {
      mix: "Return exactly 3 outfits in this order. 1) label \"Favorites\": built from my FAVORITES list. 2) label \"Been a while\": built mainly from my BEEN A WHILE list. 3) label \"Something different\": a fresh combination that reuses none of the pieces from outfits 1 and 2.",
      favorites: "Return exactly 3 different outfits, each with label \"Favorites\", built mainly from my FAVORITES list.",
      while: "Return exactly 3 different outfits, each with label \"Been a while\", built mainly from my BEEN A WHILE list.",
    }[mode];
    const prompt =
      "Build outfits only from the closet below. Use item ids exactly.\n\nMY RULES:\n" + (rules || "none") +
      "\n\nCLOSET (id | name | category | type | colors | fabric | look | where I wear it | my rating | times worn | last worn):\n" + closet +
      "\n\nFAVORITES (highest rated, then most worn): " + favs.join(", ") +
      "\nBEEN A WHILE (longest since last worn): " + stale.join(", ") +
      "\n\nUse the look descriptions so colors and patterns work together. \"Where I wear it\" tells you which settings a piece suits (Work, Casual, Lounge, Dressy, Workout, Travel); \"any\" means unspecified, and only pieces whose setting fits the request should be used. How a piece is worn: by default every shirt is worn buttoned or as-is and never open. \"Can wear open\" pieces may be worn open as an overshirt over a tee or undershirt (then add that tee to the outfit and say it is worn open). \"Undershirt only\" pieces are never a visible top. \"Also undershirt\" pieces can be a visible top or an undershirt. Within each outfit only combine pieces that suit the request.\n\nREQUEST: " + occ + (anchor ? "\nBuild every outfit around item id " + anchor + "." : "") +
      "\n\n" + plan +
      '\nReturn only JSON: {"outfits":[{"label":string,"title":string,"pieceIds":[ids],"why":string}]}. ' +
      "Each outfit has a top, bottom and shoes, plus outerwear or accessories when the request needs them. " +
      'Pieces must be real ids from the closet. Keep "why" to one short sentence.';
    const out = await callLLM(env, { system: SYSTEM, prompt });
    const ids = new Set(items.map((i) => i.id));
    const outfits = (Array.isArray(out.outfits) ? out.outfits : []).slice(0, 3).map((o) => ({
      label: str(o.label, 40), title: str(o.title, 120), why: str(o.why, 400),
      pieceIds: (Array.isArray(o.pieceIds) ? o.pieceIds : []).filter((x) => ids.has(x)),
    }));
    return { outfits };
  }

  if (task === "describe") {
    const id = str(b.itemId, 60);
    const it = items.find((i) => i.id === id);
    const ph = await env.DB.prepare("SELECT full FROM photos WHERE item_id=?").bind(id).first();
    if (!it || !ph) throw new Error("Add a photo first.");
    const prompt =
      "This is a photo of a clothing item: " + label(it) + ". Describe it for a stylist in at most 30 words: main colors, pattern, fabric look and weight, silhouette, and how dressy it is. " +
      'Return only JSON: {"look":string}.';
    const r = await callLLM(env, { system: SYSTEM, prompt, image: "data:image/jpeg;base64," + ph.full, lowDetail: true });
    const look = str(r.look, 600);
    await env.DB.prepare("UPDATE items SET look=?, updated_at=? WHERE id=?").bind(look, Date.now(), id).run();
    return { look };
  }

  if (task === "deal") {
    let text = str(b.listing, 8000);
    let image = typeof b.image === "string" && b.image.length < 8_000_000 ? b.image : "";
    const link = /https?:\/\/\S+/.exec(text);
    if (link) {
      const rest = text.replace(link[0], "").trim();
      try {
        const page = await readPage(link[0]);
        text = (rest + "\n" + page.text).trim();
        if (!image && page.photo) image = page.photo;
      } catch (e) {
        if (!rest && !image) throw e;
        text = rest;
      }
    }
    if (!text && !image) throw new Error("Paste a listing or add a screenshot first.");
    const prompt =
      "I buy clothes secondhand (eBay, Poshmark) without full-price returns, so I only buy styles I have already tried on.\n\nMY RULES:\n" +
      (rules || "none") +
      "\n\nSTYLES I HAVE TRIED AND THAT FIT (name | size | max price | notes):\n" + (knownLines(items) || "none") +
      "\n\nSTYLES THAT DID NOT WORK FOR ME (name | notes):\n" + (passedLines(items) || "none") +
      "\n\nMY CLOSET (id | name | category | type | colors | fabric | look | where I wear it | my rating | times worn | last worn):\n" + (closetLines(items, ws, b.today) || "none") +
      "\n\nLISTING:\n" + (text || "(see the attached screenshot)") +
      '\n\nJudge the listing. Match it to a tried style only when brand and style genuinely match; a different line from a brand I like is NOT a match. ' +
      'Return only JSON: {"verdict":"buy"|"try-first"|"skip","headline":string,"reasons":[string],"size":string,"price":string,' +
      '"matchedStyle":string|null,"outfitCount":number,"outfits":[{"title":string,"pieceIds":[closet ids]}],"suggestName":string,"brand":string,"category":string}. ' +
      '"buy" = matches a tried style, my size, and the price is at or under my max or reasonable for the rules. "try-first" = not tried yet. ' +
      '"skip" = a style that did not work, wrong size, fabric against my rules, or price too high. "size" says which size to buy or that it is wrong. ' +
      '"price" is one sentence on the price. outfitCount is how many distinct outfits this piece makes with my closet (respect the \"where I wear it\" tags; never count \"Undershirt only\" pieces as tops, and only treat a shirt as worn open if it is tagged \"Can wear open\"); list at most 3. ' +
      "category must be one of: " + CATS.join(", ") + ". Keep reasons to 2 to 4 short sentences.";
    const r = await callLLM(env, { system: SYSTEM, prompt, image });
    const ids = new Set(items.map((i) => i.id));
    return {
      verdict: ["buy", "try-first", "skip"].includes(r.verdict) ? r.verdict : "try-first",
      headline: str(r.headline, 200),
      reasons: strList(r.reasons).slice(0, 6),
      size: str(r.size, 300), price: str(r.price, 300),
      matchedStyle: r.matchedStyle ? str(r.matchedStyle, 200) : null,
      outfitCount: numOrNull(r.outfitCount),
      outfits: (Array.isArray(r.outfits) ? r.outfits : []).slice(0, 3).map((o) => ({
        title: str(o.title, 120),
        pieceIds: (Array.isArray(o.pieceIds) ? o.pieceIds : []).filter((x) => ids.has(x)),
      })),
      suggestName: str(r.suggestName, 200), brand: str(r.brand, 100),
      category: CATS.includes(r.category) ? r.category : "",
    };
  }

  throw new Error("Unknown task.");
}

/* ------------------------------ routing ------------------------------ */

async function handleApi(request, env, url) {
  // Defense in depth: Cloudflare Access sets this header after the visitor signs in.
  if (env.ALLOWED_EMAIL) {
    const who = (request.headers.get("cf-access-authenticated-user-email") || "").toLowerCase();
    if (who !== env.ALLOWED_EMAIL.toLowerCase()) {
      return fail(403, "Not signed in. Turn on Cloudflare Access for this Worker (see README).");
    }
  }

  await ensureReady(env);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/state" && method === "GET") return json(await loadAll(env));

  if (path === "/api/export" && method === "GET") {
    const data = await loadAll(env);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="maxs-closet-backup.json"',
      },
    });
  }

  const m = /^\/api\/items\/([^/]+)$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]).slice(0, 60);
    if (method === "PUT") {
      const body = await request.json().catch(() => null);
      const c = cleanItem(id, body);
      if (!c) return fail(400, "Give it a name.");
      await upsertStmt(env, c).run();
      const row = await env.DB.prepare(
        "SELECT items.*, (SELECT updated_at FROM photos WHERE item_id = items.id) AS photo_v FROM items WHERE id=?"
      ).bind(id).first();
      return json(toItem(row));
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM items WHERE id=?").bind(id),
        env.DB.prepare("DELETE FROM photos WHERE item_id=?").bind(id),
        env.DB.prepare("DELETE FROM wear_items WHERE item_id=?").bind(id),
        env.DB.prepare("DELETE FROM wears WHERE id NOT IN (SELECT wear_id FROM wear_items)"),
      ]);
      return json({ ok: true });
    }
  }

  const ph = /^\/api\/photo\/([^/]+)$/.exec(path);
  if (ph) {
    const id = decodeURIComponent(ph[1]).slice(0, 60);
    if (method === "GET") {
      const row = await env.DB.prepare("SELECT thumb, full FROM photos WHERE item_id=?").bind(id).first();
      if (!row) return fail(404, "No photo.");
      const bin = Uint8Array.from(atob(url.searchParams.get("size") === "full" ? row.full : row.thumb), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
    }
    if (method === "PUT") {
      const body = await request.json().catch(() => null);
      const pre = "data:image/jpeg;base64,";
      const ok = (v, max) => typeof v === "string" && v.startsWith(pre) && v.length < max;
      if (!body || !ok(body.thumb, 300000) || !ok(body.full, 1800000)) return fail(400, "Photo is missing or too large.");
      const exists = await env.DB.prepare("SELECT id FROM items WHERE id=?").bind(id).first();
      if (!exists) return fail(404, "Save the piece first.");
      const v = Date.now();
      await env.DB.prepare(
        "INSERT INTO photos (item_id,thumb,full,updated_at) VALUES (?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET thumb=excluded.thumb, full=excluded.full, updated_at=excluded.updated_at"
      ).bind(id, body.thumb.slice(pre.length), body.full.slice(pre.length), v).run();
      return json({ photoV: v });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM photos WHERE item_id=?").bind(id).run();
      return json({ ok: true });
    }
  }

  if (path === "/api/wears" && method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b) return fail(400, "Bad request.");
    const ids = [...new Set((Array.isArray(b.itemIds) ? b.itemIds : []).map((x) => str(x, 60)).filter(Boolean))].slice(0, 60);
    if (!ids.length) return fail(400, "Pick at least one piece.");
    const known = await env.DB.prepare("SELECT id FROM items WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all();
    const valid = known.results.map((r) => r.id);
    if (!valid.length) return fail(400, "Those pieces no longer exist.");
    const kind = b.kind === "bulk" ? "bulk" : "outfit";
    const count = Math.min(1000, Math.max(1, parseInt(b.count, 10) || 1));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : new Date().toISOString().slice(0, 10);
    const id = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO wears (id,date,count,kind,note,created_at) VALUES (?,?,?,?,?,?)").bind(id, date, count, kind, str(b.note, 300), Date.now()),
      ...valid.map((iid) => env.DB.prepare("INSERT INTO wear_items (wear_id,item_id) VALUES (?,?)").bind(id, iid)),
    ]);
    return json({ id, date, count, kind, note: str(b.note, 300), itemIds: valid });
  }

  const wm = /^\/api\/wears\/([^/]+)$/.exec(path);
  if (wm && method === "DELETE") {
    const id = decodeURIComponent(wm[1]).slice(0, 60);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM wear_items WHERE wear_id=?").bind(id),
      env.DB.prepare("DELETE FROM wears WHERE id=?").bind(id),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/rules" && method === "PUT") {
    const body = await request.json().catch(() => null);
    const rules = str(body && body.rules, 4000);
    await env.DB.prepare(
      "INSERT INTO settings (key,value) VALUES ('rules',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(rules).run();
    return json({ ok: true });
  }

  if (path === "/api/ai" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body) return fail(400, "Bad request.");
    try {
      return json(await runAI(env, body));
    } catch (e) {
      return fail(502, e && e.message ? e.message : "Something went wrong.");
    }
  }

  return fail(404, "Not found.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return fail(500, "Server error: " + (e && e.message ? e.message : e));
      }
    }
    return env.ASSETS.fetch(request);
  },
};
