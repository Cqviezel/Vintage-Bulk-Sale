'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'store.db'));

// WAL keeps reads fast while a write is in flight, and survives restarts better.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    set_name    TEXT NOT NULL DEFAULT '',
    number      TEXT NOT NULL DEFAULT '',
    condition   TEXT NOT NULL DEFAULT 'NM',
    variant     TEXT NOT NULL DEFAULT 'Normal',
    price       REAL NOT NULL DEFAULT 0,
    qty         INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'draft',
    image       TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    buyer         TEXT NOT NULL,
    telegram      TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    phone         TEXT NOT NULL DEFAULT '',
    address       TEXT NOT NULL DEFAULT '',
    delivery      TEXT NOT NULL DEFAULT 'Tracked Mailing',
    subtotal      REAL NOT NULL DEFAULT 0,
    fee           REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'awaiting payment',
    notify_state  TEXT NOT NULL DEFAULT 'pending',
    notify_error  TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

  CREATE TABLE IF NOT EXISTS order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  TEXT,
    name        TEXT NOT NULL,
    set_name    TEXT NOT NULL DEFAULT '',
    number      TEXT NOT NULL DEFAULT '',
    condition   TEXT NOT NULL DEFAULT '',
    variant     TEXT NOT NULL DEFAULT 'Normal',
    price       REAL NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trade_shows (
    id          TEXT PRIMARY KEY,
    venue       TEXT NOT NULL,
    location    TEXT NOT NULL DEFAULT '',
    start_date  TEXT NOT NULL,
    end_date    TEXT,
    table_no    TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trade_shows_start ON trade_shows(start_date);

  CREATE TABLE IF NOT EXISTS promo_codes (
    code          TEXT PRIMARY KEY,
    type          TEXT NOT NULL DEFAULT 'percent',
    value         REAL NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1,
    max_uses      INTEGER,
    used_count    INTEGER NOT NULL DEFAULT 0,
    expires_at    TEXT,
    min_subtotal  REAL NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per storefront load. "visitor" is a salted hash of the requester's IP,
  -- never the IP itself, so unique-visitor counts don't require storing anything
  -- personally identifying.
  CREATE TABLE IF NOT EXISTS page_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at);
`);

/** Adds a column to a table that already exists on disk from before this field was added. */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('products', 'variant', "TEXT NOT NULL DEFAULT 'Normal'");
ensureColumn('order_items', 'variant', "TEXT NOT NULL DEFAULT 'Normal'");
ensureColumn('orders', 'phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('order_items', 'image', "TEXT NOT NULL DEFAULT ''");
ensureColumn('products', 'artist', "TEXT NOT NULL DEFAULT ''");
ensureColumn('orders', 'promo_code', "TEXT NOT NULL DEFAULT ''");
ensureColumn('orders', 'discount', "REAL NOT NULL DEFAULT 0");

/**
 * "Add by Set" used to save the Pokémon TCG API's low-res thumbnail instead of the
 * full-size image. Upgrades any already-saved URL to the high-res version — the
 * WHERE clause makes this safe to run on every startup, since a row that's already
 * upgraded no longer matches it.
 */
db.prepare(
  `UPDATE products SET image = REPLACE(image, '.png', '_hires.png')
   WHERE image LIKE 'https://images.pokemontcg.io/%' AND image NOT LIKE '%_hires.png'`
).run();

/**
 * One-time cleanup for duplicate listings created before the single-card add endpoint
 * checked for them — same match as the admin routes' findDuplicate query (name/set/
 * number case-insensitive, condition/variant exact). Keeps the oldest row per group,
 * sums the rest's qty into it, and deletes the rest. Self-limiting: once a group is
 * merged down to one row it no longer matches the HAVING COUNT(*) > 1 below, so this
 * is a no-op on every startup after the first.
 */
(function mergeDuplicateProducts() {
  const groups = db
    .prepare(
      `SELECT lower(name) n, lower(set_name) s, lower(number) num, condition, variant
       FROM products
       GROUP BY n, s, num, condition, variant
       HAVING COUNT(*) > 1`
    )
    .all();
  if (!groups.length) return;

  const rowsInGroup = db.prepare(
    `SELECT * FROM products
     WHERE lower(name) = ? AND lower(set_name) = ? AND lower(number) = ? AND condition = ? AND variant = ?
     ORDER BY created_at ASC, id ASC`
  );
  const addQty = db.prepare(`UPDATE products SET qty = qty + ?, updated_at = datetime('now') WHERE id = ?`);
  const deleteRow = db.prepare('DELETE FROM products WHERE id = ?');

  const mergeAll = db.transaction(() => {
    for (const g of groups) {
      const [keep, ...rest] = rowsInGroup.all(g.n, g.s, g.num, g.condition, g.variant);
      const extraQty = rest.reduce((sum, r) => sum + r.qty, 0);
      if (extraQty) addQty.run(extraQty, keep.id);
      for (const r of rest) deleteRow.run(r.id);
    }
  });
  mergeAll();
})();

const DEFAULT_SETTINGS = {
  storeName: 'Crazed TCG',
  telegram: '@crazedtcg',
  mailing: '3.50',
  minimum: '0',
  reservation: '30',
  paynow: '',
  // Payment + contact details shown to the buyer after checkout.
  paynowQr: '/uploads/paynow-qr.jpg',
  paynowPayee: '',
  contactTelegram: '@Cqvie',
  lowStockAlerts: '1',
};

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  insertSetting.run(key, value);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  // Numbers are stored as text; hand callers real numbers.
  out.mailing = Number(out.mailing) || 0;
  out.minimum = Number(out.minimum) || 0;
  out.reservation = Number(out.reservation) || 30;
  out.lowStockAlerts = out.lowStockAlerts !== '0';
  return out;
}

const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (@key, @value) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const saveSettings = db.transaction((patch) => {
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue;
    upsertSetting.run({ key, value: String(value) });
  }
});

module.exports = { db, DATA_DIR, getSettings, saveSettings, DEFAULT_SETTINGS };
