'use strict';

/**
 * CoolStuffInc stock tracker for vintage Pokemon singles.
 *
 * Scans the CoolStuffInc set pages listed in SETS, stores every listing's
 * stock count, and records what changed since the last scan:
 *   restock  - stock went up (or a listing came back in stock)
 *   sold     - stock went down (estimated units sold)
 *   soldout  - stock went down to 0
 *   price    - price changed
 *
 * On the server it runs every hour (startAutoRun) and posts each scan's
 * changes to the admin group's TELEGRAM_TOPIC_CSI_TRACKER topic. It can also
 * be run by hand with scripts/csi-tracker.js.
 *
 * Notes:
 * - CoolStuffInc shows at most "20+" for stock. Sales from a listing above 20
 *   are only counted once it drops below 20, so big-stock numbers are low.
 * - "Sold" means the count dropped. It can also be a cart hold or a store
 *   adjustment, so treat the numbers as estimates.
 * - Pages are sorted "In Stock First", and scanning a set stops at the first
 *   page with nothing in stock. Anything not seen in stock counts as 0.
 *
 * Data lives in its own database, <DATA_DIR>/csi-tracker.db, so it never
 * touches the store's database.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BASE = 'https://www.coolstuffinc.com';
const PER_PAGE = 25;               // the site ignores larger page sizes
const DELAY_MS = 2500;             // pause between requests, to be polite
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const TELEGRAM_API = 'https://api.telegram.org';

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'csi-tracker.db');
const REPORT_PATH = path.join(DATA_DIR, 'csi-report.html');

// Page ids from https://www.coolstuffinc.com/pokemon/
const SETS = [
  // HS Series
  { id: 360, name: 'Call of Legends', series: 'HS' },
  { id: 358, name: 'HS Triumphant', series: 'HS' },
  { id: 357, name: 'HS Undaunted', series: 'HS' },
  { id: 356, name: 'HS Unleashed', series: 'HS' },
  { id: 355, name: 'HeartGold SoulSilver', series: 'HS' },
  // Platinum Series
  { id: 354, name: 'Platinum Arceus', series: 'Platinum' },
  { id: 353, name: 'Platinum Supreme Victors', series: 'Platinum' },
  { id: 352, name: 'Platinum Rising Rivals', series: 'Platinum' },
  { id: 351, name: 'Platinum Base Set', series: 'Platinum' },
  // Diamond and Pearl Series
  { id: 349, name: 'Diamond & Pearl Stormfront', series: 'Diamond & Pearl' },
  { id: 348, name: 'Diamond & Pearl Legends Awakened', series: 'Diamond & Pearl' },
  { id: 347, name: 'Diamond & Pearl Majestic Dawn', series: 'Diamond & Pearl' },
  { id: 346, name: 'Diamond & Pearl Great Encounters', series: 'Diamond & Pearl' },
  { id: 345, name: 'Diamond & Pearl Secret Wonders', series: 'Diamond & Pearl' },
  { id: 344, name: 'Diamond & Pearl Mysterious Treasures', series: 'Diamond & Pearl' },
  { id: 343, name: 'Diamond & Pearl Base Set', series: 'Diamond & Pearl' },
  // EX Series
  { id: 341, name: 'Ex Power Keepers', series: 'EX' },
  { id: 340, name: 'Ex Dragon Frontiers', series: 'EX' },
  { id: 339, name: 'Ex Crystal Guardians', series: 'EX' },
  { id: 338, name: 'Ex Holon Phantoms', series: 'EX' },
  { id: 337, name: 'Ex Legend Maker', series: 'EX' },
  { id: 336, name: 'Ex Delta Species', series: 'EX' },
  { id: 335, name: 'Ex Unseen Forces', series: 'EX' },
  { id: 334, name: 'Ex Emerald', series: 'EX' },
  { id: 333, name: 'Ex Deoxys', series: 'EX' },
  { id: 332, name: 'Ex Team Rocket Returns', series: 'EX' },
  { id: 331, name: 'Ex FireRed & LeafGreen', series: 'EX' },
  { id: 330, name: 'Ex Hidden Legends', series: 'EX' },
  { id: 329, name: 'Ex Team Magma vs. Team Aqua', series: 'EX' },
  { id: 328, name: 'Ex Dragon', series: 'EX' },
  { id: 327, name: 'Ex Sandstorm', series: 'EX' },
  { id: 326, name: 'Ex Ruby & Sapphire', series: 'EX' },
  // Promo Cards (Mega Evolution, Scarlet and Violet, Sword and Shield
  // promos and Oversized Cards are left out on purpose)
  { id: 3651, name: 'SM Promos', series: 'Promos' },
  { id: 1898, name: 'XY Promos', series: 'Promos' },
  { id: 365, name: 'BW Promos', series: 'Promos' },
  { id: 359, name: 'HGSS Promos', series: 'Promos' },
  { id: 9112, name: 'Pokemon Rumble', series: 'Promos' },
  { id: 350, name: 'Diamond & Pearl Promos', series: 'Promos' },
  { id: 9926, name: 'POP Series', series: 'Promos' },
  { id: 342, name: 'Nintendo Black Star Promos', series: 'Promos' },
  { id: 1458, name: 'Southern Islands', series: 'Promos' },
  { id: 325, name: 'WotC Black Star Promos', series: 'Promos' },
];

// ---------------------------------------------------------------- database

let db = null;

function openDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS offers (
      key         TEXT PRIMARY KEY,   -- "<productId>:<condition>"
      set_id      INTEGER NOT NULL,
      pid         INTEGER NOT NULL,
      name        TEXT NOT NULL,
      set_name    TEXT NOT NULL,
      url         TEXT NOT NULL,
      condition   TEXT NOT NULL,
      qty         INTEGER NOT NULL,
      capped      INTEGER NOT NULL DEFAULT 0,  -- 1 when the site showed "20+"
      price       REAL,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS offers_set ON offers(set_id);
    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      set_id       INTEGER NOT NULL,
      key          TEXT NOT NULL,
      type         TEXT NOT NULL,     -- restock | sold | soldout | price
      qty_before   INTEGER,
      qty_after    INTEGER,
      price_before REAL,
      price_after  REAL
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS set_scans (
      set_id   INTEGER PRIMARY KEY,
      last_ok  TEXT NOT NULL,
      pages    INTEGER NOT NULL,
      results  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scans (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      started   TEXT NOT NULL,
      finished  TEXT,
      ok_sets   INTEGER,
      failed    TEXT,
      requests  INTEGER
    );
  `);
  return db;
}

function closeDb() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
}

// ---------------------------------------------------------------- fetching

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;
let lastRequestAt = 0;

async function fetchPage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const wait = lastRequestAt + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    requestCount++;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return await res.text();
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
      console.warn(`[csi] HTTP ${res.status} on ${url}, retrying`);
    } catch (err) {
      if (attempt === 3 || /^HTTP 4/.test(err.message)) throw err;
      console.warn(`[csi] ${err.message} on ${url}, retrying`);
    }
    await sleep(DELAY_MS * 4 * attempt);
  }
  throw new Error(`Gave up on ${url}`);
}

// ---------------------------------------------------------------- parsing

function decode(s) {
  return String(s)
    .replace(/&raquo;/g, '»').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&eacute;/g, 'é').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').trim();
}

/** Turns one listing page into { total, products: [{pid,name,url,setName,offers:[...]}] }. */
function parseListing(html) {
  const totalMatch = html.match(/of ([\d,]+) Results/);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0;
  const products = [];

  for (const chunk of html.split('class="row product-search-row').slice(1)) {
    const pidMatch = chunk.match(/data-pid="(\d+)"/) || chunk.match(/action=add-(\d+)/)
      || chunk.match(/emailme\[(\d+)\]/) || chunk.match(/atc\[(\d+)\]/);
    const nameMatch = chunk.match(/itemprop="name">([^<]+)/);
    const urlMatch = chunk.match(/href="(\/p\/[^"]+)"/);
    if (!pidMatch || !nameMatch || !urlMatch) continue;
    const setMatch = chunk.match(/breadcrumb-trail">([^<]+)/);
    const product = {
      pid: +pidMatch[1],
      name: decode(nameMatch[1]),
      url: BASE + urlMatch[1],
      setName: setMatch ? decode(setMatch[1]).replace(/^Pokemon\s*»\s*/, '') : '',
      offers: [],
    };

    for (const o of chunk.split('itemprop="offers"').slice(1)) {
      const avail = (o.match(/schema\.org\/(InStock|OutOfStock|PreOrder|SoldOut|LimitedAvailability|BackOrder)"/) || [])[1];
      if (!avail) continue;
      const priceMatch = o.match(/itemprop="price" content="([\d.]+)"/);
      const qtyMatch = o.match(/card-qty">\s*(\d+)\s*(\+?)/);
      const desc = decode((o.match(/itemprop="description" content="([^"]*)"/) || [])[1] || '');
      const inStock = avail === 'InStock' || avail === 'LimitedAvailability';
      let qty = 0;
      let capped = false;
      if (inStock) {
        qty = qtyMatch ? +qtyMatch[1] : 1;
        capped = Boolean(qtyMatch && qtyMatch[2]);
      }
      // The description ends with the condition, e.g.
      // "Ampharos - 23/95 Call of Legends Pokemon Near Mint"
      const cut = desc.lastIndexOf(' Pokemon ');
      const condition = cut >= 0 ? desc.slice(cut + 9).trim() : (desc || 'Default');
      product.offers.push({
        condition: condition || 'Default',
        qty, capped, inStock,
        price: priceMatch ? +priceMatch[1] : null,
      });
    }
    products.push(product);
  }
  return { total, products };
}

// ---------------------------------------------------------------- scanning

async function scanSet(set) {
  const seen = new Map();
  let page = 1;
  let total = 0;
  let pages = 0;
  for (;;) {
    const url = `${BASE}/page/${set.id}?&resultsperpage=${PER_PAGE}&sb=stock|1&page=${page}`;
    const html = await fetchPage(url);
    const parsed = parseListing(html);
    pages++;
    if (page === 1) total = parsed.total;
    if (parsed.total > 0 && parsed.products.length === 0) {
      throw new Error('page had results but no products could be read (did the site layout change?)');
    }
    let anyInStock = false;
    for (const p of parsed.products) {
      for (const o of p.offers) {
        if (o.inStock) anyInStock = true;
        const key = `${p.pid}:${o.condition}`;
        const prev = seen.get(key);
        if (!prev || o.qty > prev.qty) {
          seen.set(key, { ...o, key, pid: p.pid, name: p.name, url: p.url, setName: p.setName || set.name });
        }
      }
    }
    const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
    if (!anyInStock || page >= lastPage) break;
    page++;
  }
  return { seen, total, pages };
}

function applySetScan(set, { seen, total, pages }, now) {
  const getOffer = db.prepare('SELECT * FROM offers WHERE key = ?');
  const insertOffer = db.prepare(`INSERT INTO offers
    (key, set_id, pid, name, set_name, url, condition, qty, capped, price, first_seen, last_seen)
    VALUES (@key, @set_id, @pid, @name, @set_name, @url, @condition, @qty, @capped, @price, @now, @now)`);
  const updateOffer = db.prepare(`UPDATE offers SET name=@name, set_name=@set_name, url=@url,
    qty=@qty, capped=@capped, price=@price, last_seen=@now WHERE key=@key`);
  const zeroOffer = db.prepare('UPDATE offers SET qty = 0, capped = 0 WHERE key = ?');
  const addEvent = db.prepare(`INSERT INTO events
    (ts, set_id, key, type, qty_before, qty_after, price_before, price_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const inStockForSet = db.prepare('SELECT key, qty, price FROM offers WHERE set_id = ? AND qty > 0');
  const baselined = !!db.prepare('SELECT 1 FROM set_scans WHERE set_id = ?').get(set.id);

  const counts = { restock: 0, sold: 0, soldout: 0, price: 0, units: 0 };
  const event = (key, type, qb, qa, pb, pa) => {
    addEvent.run(now, set.id, key, type, qb, qa, pb, pa);
    counts[type]++;
    if ((type === 'sold' || type === 'soldout') && qb > qa) counts.units += qb - qa;
  };

  db.transaction(() => {
    for (const o of seen.values()) {
      const row = {
        key: o.key, set_id: set.id, pid: o.pid, name: o.name, set_name: o.setName,
        url: o.url, condition: o.condition, qty: o.qty, capped: o.capped ? 1 : 0,
        price: o.price, now,
      };
      const prev = getOffer.get(o.key);
      if (!prev) {
        insertOffer.run(row);
        // Listings past the in-stock pages are never read, so a listing we
        // have not seen before that shows up in stock usually means a restock.
        if (baselined && o.qty > 0) event(o.key, 'restock', 0, o.qty, null, o.price);
        continue;
      }
      updateOffer.run(row);
      const bothCapped = prev.capped && o.capped;
      if (!bothCapped && o.qty > prev.qty) {
        event(o.key, 'restock', prev.qty, o.qty, prev.price, o.price);
      } else if (!bothCapped && o.qty < prev.qty) {
        event(o.key, o.qty === 0 ? 'soldout' : 'sold', prev.qty, o.qty, prev.price, o.price);
      }
      if (o.qty > 0 && prev.price != null && o.price != null && Math.abs(prev.price - o.price) >= 0.005) {
        event(o.key, 'price', prev.qty, o.qty, prev.price, o.price);
      }
    }
    // Anything that was in stock last time but was not seen this time has sold
    // out. (Listings seen this scan were already updated above.)
    for (const prev of inStockForSet.all(set.id)) {
      if (seen.has(prev.key)) continue;
      zeroOffer.run(prev.key);
      event(prev.key, 'soldout', prev.qty, 0, prev.price, prev.price);
    }
    db.prepare(`INSERT INTO set_scans (set_id, last_ok, pages, results) VALUES (?, ?, ?, ?)
      ON CONFLICT(set_id) DO UPDATE SET last_ok = excluded.last_ok, pages = excluded.pages, results = excluded.results`)
      .run(set.id, now, pages, total);
  })();

  return { counts, baselined };
}

let scanning = false;
let stopping = false;

/**
 * Scans every set (or just `sets`) once. Returns a summary including the new
 * events, which is what gets posted to Telegram.
 */
async function scanAll({ sets = SETS, log = console.log } = {}) {
  if (scanning) throw new Error('A scan is already running');
  scanning = true;
  try {
    openDb();
    const started = new Date().toISOString();
    const scanId = db.prepare('INSERT INTO scans (started) VALUES (?)').run(started).lastInsertRowid;
    const lastEventId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id;
    const startRequests = requestCount;
    const failed = [];
    let ok = 0;
    let baselineSets = 0;
    log(`[csi] Scanning ${sets.length} sets on coolstuffinc.com...`);
    for (const set of sets) {
      if (stopping) { failed.push(`${set.name}: stopped (server shutting down)`); continue; }
      try {
        const result = await scanSet(set);
        const { counts, baselined } = applySetScan(set, result, new Date().toISOString());
        ok++;
        if (!baselined) baselineSets++;
        const inStock = [...result.seen.values()].filter((o) => o.qty > 0).length;
        const changes = baselined
          ? `+${counts.restock} restocked, ${counts.units} sold, ${counts.soldout} sold out, ${counts.price} price changes`
          : 'first scan, baseline saved';
        log(`[csi]   ${set.name}: ${inStock} in stock (${result.pages} pages). ${changes}`);
      } catch (err) {
        failed.push(`${set.name}: ${err.message}`);
        console.error(`[csi]   ${set.name}: FAILED - ${err.message}`);
      }
    }
    const requests = requestCount - startRequests;
    db.prepare('UPDATE scans SET finished = ?, ok_sets = ?, failed = ?, requests = ? WHERE id = ?')
      .run(new Date().toISOString(), ok, failed.join('\n'), requests, scanId);
    log(`[csi] Done: ${ok}/${sets.length} sets, ${requests} requests.`);

    const events = db.prepare(`
      SELECT e.*, o.name, o.set_name, o.condition, o.url, o.capped
      FROM events e JOIN offers o ON o.key = e.key
      WHERE e.id > ? ORDER BY e.id`).all(lastEventId);
    const inStockListings = db.prepare('SELECT COUNT(*) AS n FROM offers WHERE qty > 0').get().n;
    const prevScan = db.prepare('SELECT failed FROM scans WHERE id < ? AND finished IS NOT NULL ORDER BY id DESC LIMIT 1').get(scanId);
    return {
      scanId, ok, failed, requests, events, baselineSets, inStockListings,
      setCount: sets.length,
      previousScanFailed: Boolean(prevScan && prevScan.failed),
    };
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------- telegram

const TG_SECTION_LIMIT = 25;       // lines per section before "...and N more"
const TG_MESSAGE_LIMIT = 3900;     // Telegram's hard limit is 4096 characters

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID
    && process.env.TELEGRAM_TOPIC_CSI_TRACKER);
}

const tgEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);
// CoolStuffInc only uses Near Mint, Played and Unique. "Unique" is a single
// one-off copy (usually a pricey card), so it gets a star to stand out.
const shortCondition = (c) => ({ 'Near Mint': 'NM', Played: 'PL', Unique: '⭐ Unique' }[c] || c);

function tgCardLine(e, detail) {
  return `• <a href="${tgEsc(e.url)}">${tgEsc(e.name)}</a> (${tgEsc(shortCondition(e.condition))}) ${detail}`
    + ` · <i>${tgEsc(e.set_name)}</i>`;
}

/** Builds the Telegram message(s) for one scan. Returns [] when there is nothing to say. */
function buildTelegramMessages(summary) {
  const { events, failed, baselineSets, inStockListings, setCount, ok } = summary;
  const lines = [];

  if (baselineSets > 0 && baselineSets === ok) {
    lines.push('<b>CoolStuffInc tracker started</b>',
      `First scan saved: ${inStockListings} listings in stock across ${ok} sets.`,
      'Restocks, sales, sell-outs and price changes will be posted here after each hourly scan.');
  } else {
    const restocks = events.filter((e) => e.type === 'restock');
    const soldOut = events.filter((e) => e.type === 'soldout');
    const sold = events.filter((e) => e.type === 'sold');
    const prices = events.filter((e) => e.type === 'price');
    const units = [...sold, ...soldOut].reduce((a, e) => a + Math.max(0, e.qty_before - e.qty_after), 0);
    if (!events.length && !(failed.length && !summary.previousScanFailed)) return [];

    const section = (title, list, fmt) => {
      if (!list.length) return;
      lines.push('', `<b>${title}</b>`);
      list.slice(0, TG_SECTION_LIMIT).forEach((e) => lines.push(fmt(e)));
      if (list.length > TG_SECTION_LIMIT) lines.push(`<i>…and ${list.length - TG_SECTION_LIMIT} more</i>`);
    };
    const qtyAfter = (e) => `${e.qty_after}${e.capped && e.qty_after >= 20 ? '+' : ''}`;

    lines.push(`<b>CoolStuffInc update</b> · ${units} sold · ${restocks.length} restocked · ${soldOut.length} sold out`);
    section(`🟢 Restocked (${restocks.length})`, restocks,
      (e) => tgCardLine(e, `${e.qty_before} → ${qtyAfter(e)} · ${usd(e.price_after)}`));
    section(`🔴 Sold out (${soldOut.length})`, soldOut,
      (e) => tgCardLine(e, `had ${e.qty_before} · ${usd(e.price_before)}`));
    section(`📉 Sold (${sold.length})`, sold,
      (e) => tgCardLine(e, `−${e.qty_before - e.qty_after} → ${e.qty_after} left · ${usd(e.price_after)}`));
    section(`💲 Price changes (${prices.length})`, prices,
      (e) => tgCardLine(e, `${usd(e.price_before)} → ${usd(e.price_after)}`));
  }

  if (failed.length && !summary.previousScanFailed) {
    lines.push('', `⚠️ ${failed.length} of ${setCount} sets could not be read this time:`);
    failed.slice(0, 10).forEach((f) => lines.push(`• ${tgEsc(f)}`));
  }

  // Split on line boundaries so no message goes over Telegram's limit.
  const messages = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > TG_MESSAGE_LIMIT) {
      messages.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current.trim()) messages.push(current);
  return messages;
}

async function sendTelegram(text) {
  const res = await fetch(`${TELEGRAM_API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      message_thread_id: Number(process.env.TELEGRAM_TOPIC_CSI_TRACKER),
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram sendMessage failed: ${body.description || res.status}`);
}

async function notifyTelegram(summary) {
  for (const text of buildTelegramMessages(summary)) {
    await sendTelegram(text);
  }
}

// ---------------------------------------------------------------- auto run

let timer = null;

/**
 * Scans every `everyMinutes` and posts the changes to Telegram. The schedule is
 * based on the last finished scan in the database, so a redeploy does not
 * trigger an extra scan.
 */
function startAutoRun({ everyMinutes = Number(process.env.CSI_TRACKER_INTERVAL_MINUTES) || 60, firstDelayMinutes = 3 } = {}) {
  if (timer || !isConfigured()) return false;
  stopping = false;
  const intervalMs = everyMinutes * 60000;

  const schedule = () => {
    if (stopping) return;
    let delay = intervalMs;
    try {
      const last = openDb().prepare('SELECT finished FROM scans WHERE finished IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      const due = last ? Date.parse(last.finished) + intervalMs : 0;
      delay = Math.max(firstDelayMinutes * 60000, due - Date.now());
    } catch (err) {
      console.error('[csi] could not read last scan time:', err.message);
    }
    firstDelayMinutes = 1;
    timer = setTimeout(run, delay);
    if (timer.unref) timer.unref();
  };

  const run = async () => {
    try {
      const summary = await scanAll();
      if (!stopping) await notifyTelegram(summary);
    } catch (err) {
      console.error('[csi] scan failed:', err.message);
    }
    schedule();
  };

  schedule();
  console.log(`  CSI tracker  every ${everyMinutes} min → Telegram topic ${process.env.TELEGRAM_TOPIC_CSI_TRACKER}`);
  return true;
}

function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  if (!scanning) closeDb();
}

// ---------------------------------------------------------------- report

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = usd;
const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Writes a standalone HTML report of the last `days` days to <DATA_DIR>/csi-report.html. */
function writeReport(days = 7) {
  openDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const lastScan = db.prepare('SELECT * FROM scans WHERE finished IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  const seriesOf = Object.fromEntries(SETS.map((s) => [s.id, s.series]));

  const bestSellers = db.prepare(`
    SELECT o.key, o.name, o.set_name, o.condition, o.url, o.qty, o.capped, o.price,
           SUM(e.qty_before - e.qty_after) AS units, COUNT(*) AS drops, MAX(e.ts) AS last_ts
    FROM events e JOIN offers o ON o.key = e.key
    WHERE e.type IN ('sold','soldout') AND e.ts >= ?
    GROUP BY o.key ORDER BY units DESC, last_ts DESC LIMIT 100`).all(since);

  const restocks = db.prepare(`
    SELECT e.ts, e.qty_before, e.qty_after, e.price_after, o.name, o.set_name, o.condition, o.url, o.qty, o.capped
    FROM events e JOIN offers o ON o.key = e.key
    WHERE e.type = 'restock' AND e.ts >= ? ORDER BY e.ts DESC LIMIT 200`).all(since);

  const soldOuts = db.prepare(`
    SELECT e.ts, e.qty_before, e.price_before, o.name, o.set_name, o.condition, o.url, o.qty
    FROM events e JOIN offers o ON o.key = e.key
    WHERE e.type = 'soldout' AND e.ts >= ? ORDER BY e.ts DESC LIMIT 200`).all(since);

  const prices = db.prepare(`
    SELECT e.ts, e.price_before, e.price_after, o.name, o.set_name, o.condition, o.url
    FROM events e JOIN offers o ON o.key = e.key
    WHERE e.type = 'price' AND e.ts >= ? ORDER BY e.ts DESC LIMIT 200`).all(since);

  const perSet = db.prepare(`
    SELECT o.set_id,
           SUM(CASE WHEN o.qty > 0 THEN 1 ELSE 0 END) AS listings,
           SUM(o.qty) AS stock,
           SUM(CASE WHEN o.capped = 1 THEN 1 ELSE 0 END) AS capped,
           (SELECT COALESCE(SUM(e.qty_before - e.qty_after), 0) FROM events e
             WHERE e.set_id = o.set_id AND e.type IN ('sold','soldout') AND e.ts >= ?) AS units,
           (SELECT COALESCE(SUM((e.qty_before - e.qty_after) * COALESCE(e.price_before, 0)), 0) FROM events e
             WHERE e.set_id = o.set_id AND e.type IN ('sold','soldout') AND e.ts >= ?) AS revenue,
           (SELECT COUNT(*) FROM events e WHERE e.set_id = o.set_id AND e.type = 'restock' AND e.ts >= ?) AS restocks
    FROM offers o GROUP BY o.set_id`).all(since, since, since);
  const perSetById = Object.fromEntries(perSet.map((r) => [r.set_id, r]));

  const totalUnits = bestSellers.reduce((a, r) => a + r.units, 0);
  const totalRevenue = perSet.reduce((a, r) => a + r.revenue, 0);
  const inStockListings = perSet.reduce((a, r) => a + r.listings, 0);
  const firstScan = db.prepare('SELECT MIN(started) AS t FROM scans').get().t;

  const card = (r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`
    + `<div class="sub">${esc(r.set_name)} · ${esc(r.condition)}</div>`;
  const stockNow = (r) => (r.qty > 0 ? `${r.qty}${r.capped ? '+' : ''}` : '<span class="muted">0</span>');
  const table = (head, rows, empty) => rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th${/^(#|Qty|Units|Price|Now|Was|Stock|Sold|Restocks|Est\.)/.test(h) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="empty">${empty}</p>`;

  const sellerRows = bestSellers.map((r) => `<tr><td>${card(r)}</td><td class="num">${r.units}</td>
    <td class="num">${money(r.price)}</td><td class="num">${stockNow(r)}</td><td>${when(r.last_ts)}</td></tr>`);
  const restockRows = restocks.map((r) => `<tr><td>${when(r.ts)}</td><td>${card(r)}</td>
    <td class="num">${r.qty_before} → ${r.qty_after}${r.capped && r.qty_after >= 20 ? '+' : ''}</td><td class="num">${money(r.price_after)}</td><td class="num">${stockNow(r)}</td></tr>`);
  const soldOutRows = soldOuts.map((r) => `<tr><td>${when(r.ts)}</td><td>${card(r)}</td>
    <td class="num">${r.qty_before}</td><td class="num">${money(r.price_before)}</td><td class="num">${stockNow(r)}</td></tr>`);
  const priceRows = prices.map((r) => `<tr><td>${when(r.ts)}</td><td>${card(r)}</td>
    <td class="num">${money(r.price_before)}</td><td class="num">${money(r.price_after)}</td></tr>`);
  const setRows = SETS.map((s) => {
    const r = perSetById[s.id];
    if (!r) return `<tr><td>${esc(s.name)}<div class="sub">${esc(s.series)}</div></td><td colspan="5" class="muted">not scanned yet</td></tr>`;
    return `<tr><td><a href="${BASE}/page/${s.id}?&sb=stock|1" target="_blank" rel="noopener">${esc(s.name)}</a><div class="sub">${esc(seriesOf[s.id])}</div></td>
      <td class="num">${r.listings}</td><td class="num">${r.stock}${r.capped ? '+' : ''}</td><td class="num">${r.units}</td>
      <td class="num">${money(r.revenue)}</td><td class="num">${r.restocks}</td></tr>`;
  });

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CSI Stock Tracker</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2457c5;--good:#1d7a46;--bad:#b3261e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecece8;--muted:#9a9a93;--line:#2e2e2b;--accent:#7aa2f7;--good:#5cc28a;--bad:#f2867d;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}
.meta{color:var(--muted);font-size:13px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:12px}nav{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;margin-top:8px}
.scroll{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse}
th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.sub{color:var(--muted);font-size:12px}.muted{color:var(--muted)}
.empty{color:var(--muted);background:var(--panel);border:1px dashed var(--line);border-radius:10px;padding:14px}.note{color:var(--muted);font-size:12px;margin-top:28px}
</style></head><body><main>
<h1>CoolStuffInc stock tracker</h1>
<div class="meta">Vintage Pokemon singles · last ${days} days · last scan ${lastScan ? when(lastScan.finished) : 'never'}${lastScan && lastScan.failed ? ` · <span style="color:var(--bad)">${esc(lastScan.failed.split('\n').length)} set(s) failed</span>` : ''} · tracking since ${firstScan ? when(firstScan) : '—'}</div>
<nav><a href="#sellers">Best sellers</a><a href="#restocks">Restocks</a><a href="#soldout">Sold out</a><a href="#prices">Price changes</a><a href="#sets">By set</a></nav>
<div class="stats">
  <div class="stat"><b>${totalUnits}</b><span>est. units sold</span></div>
  <div class="stat"><b>${money(totalRevenue)}</b><span>est. sales value</span></div>
  <div class="stat"><b>${restocks.length}</b><span>restocks</span></div>
  <div class="stat"><b>${soldOuts.length}</b><span>sold out</span></div>
  <div class="stat"><b>${inStockListings}</b><span>listings in stock now</span></div>
</div>
<h2 id="sellers">Best sellers</h2>
${table(['Card', 'Units', 'Price', 'Stock', 'Last sale'], sellerRows, 'No sales recorded yet. Sales show up after the second scan.')}
<h2 id="restocks">Restocks</h2>
${table(['When', 'Card', 'Qty', 'Price', 'Now'], restockRows, 'No restocks yet.')}
<h2 id="soldout">Sold out</h2>
${table(['When', 'Card', 'Was', 'Price', 'Now'], soldOutRows, 'Nothing sold out yet.')}
<h2 id="prices">Price changes</h2>
${table(['When', 'Card', 'Was', 'Now'], priceRows, 'No price changes yet.')}
<h2 id="sets">By set</h2>
${table(['Set', 'In stock', 'Stock', 'Sold', 'Est. value', 'Restocks'], setRows, '')}
<p class="note">"Sold" means the stock count went down between scans, so it can include cart holds or store adjustments. CoolStuffInc shows at most "20+", so sales from listings above 20 are not counted until they drop below 20.</p>
</main></body></html>`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, html);
  return REPORT_PATH;
}

module.exports = {
  SETS,
  DB_PATH,
  REPORT_PATH,
  parseListing,
  scanAll,
  writeReport,
  buildTelegramMessages,
  notifyTelegram,
  isConfigured,
  startAutoRun,
  stop,
  closeDb,
};
