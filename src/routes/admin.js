'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const { db, getSettings, saveSettings } = require('../db');
const auth = require('../auth');
const telegram = require('../telegram');
const csv = require('../csv');
const ptcg = require('../pokemontcg');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP']);
const VARIANTS = new Set(['Normal', 'Holo', 'Reverse Holo', '1st Edition']);
const STATUSES = new Set(['live', 'draft', 'reserved', 'sold', 'hidden']);
const ORDER_FLOW = ['awaiting payment', 'paid', 'packed', 'mailed', 'completed'];
const ORDER_STATUSES = new Set([...ORDER_FLOW, 'cancelled']);

/* ------------------------------------------------------------------ auth --- */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');

  if (!auth.verify(username, password)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start a session.' });
    req.session.user = username;
    res.json({ ok: true, username });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ctcg.sid');
    res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});

// Everything below this line requires a signed-in admin.
router.use(auth.requireAuth);

/* -------------------------------------------------------------- products --- */

function toAdminProduct(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    number: row.number,
    condition: row.condition,
    variant: row.variant,
    price: row.price,
    qty: row.qty,
    status: row.status,
    image: row.image,
    notes: row.notes,
  };
}

const allProducts = db.prepare('SELECT * FROM products ORDER BY updated_at DESC');
const oneProduct = db.prepare('SELECT * FROM products WHERE id = ?');
const insertProduct = db.prepare(
  `INSERT INTO products (id, name, set_name, number, condition, variant, price, qty, status, image, notes)
   VALUES (@id, @name, @set_name, @number, @condition, @variant, @price, @qty, @status, @image, @notes)`
);
const updateProduct = db.prepare(
  `UPDATE products SET name = @name, set_name = @set_name, number = @number,
     condition = @condition, variant = @variant, price = @price, qty = @qty, status = @status,
     image = @image, notes = @notes, updated_at = datetime('now')
   WHERE id = @id`
);
const deleteProduct = db.prepare('DELETE FROM products WHERE id = ?');

function readProductBody(body) {
  const price = Number(body.price);
  const qty = Number.parseInt(body.qty, 10);

  const errors = [];
  const name = String(body.name || '').trim().slice(0, 160);
  if (!name) errors.push('Card name is required.');
  if (!Number.isFinite(price) || price < 0) errors.push('Price must be zero or more.');
  if (!Number.isInteger(qty) || qty < 0) errors.push('Quantity must be a whole number.');

  const condition = CONDITIONS.has(body.condition) ? body.condition : 'NM';
  const variant = VARIANTS.has(body.variant) ? body.variant : 'Normal';
  const status = STATUSES.has(body.status) ? body.status : 'draft';

  return {
    errors,
    values: {
      name,
      set_name: String(body.set || '').trim().slice(0, 160),
      number: String(body.number || '').trim().slice(0, 40),
      condition,
      variant,
      price: Math.round(price * 100) / 100,
      qty,
      status,
      image: String(body.image || '').trim().slice(0, 500),
      notes: String(body.notes || '').trim().slice(0, 2000),
    },
  };
}

router.get('/products', (req, res) => {
  res.json(allProducts.all().map(toAdminProduct));
});

router.post('/products', (req, res) => {
  const { errors, values } = readProductBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const id = 'p' + crypto.randomBytes(8).toString('hex');
  insertProduct.run({ id, ...values });
  res.status(201).json(toAdminProduct(oneProduct.get(id)));
});

router.put('/products/:id', (req, res) => {
  const existing = oneProduct.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });

  const { errors, values } = readProductBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  updateProduct.run({ id: existing.id, ...values });
  res.json(toAdminProduct(oneProduct.get(existing.id)));
});

router.delete('/products/:id', (req, res) => {
  const existing = oneProduct.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });

  deleteProduct.run(existing.id);

  // Clean up an uploaded image if nothing else references it.
  if (existing.image && existing.image.startsWith('/uploads/')) {
    const stillUsed = db
      .prepare('SELECT 1 FROM products WHERE image = ? LIMIT 1')
      .get(existing.image);
    if (!stillUsed) {
      fs.promises
        .unlink(path.join(UPLOAD_DIR, path.basename(existing.image)))
        .catch(() => {});
    }
  }
  res.json({ ok: true });
});

/* ----------------------------------------------------------- bulk import --- */

const TEMPLATE_HEADERS = ['name', 'set', 'number', 'condition', 'variant', 'price', 'qty', 'status', 'image', 'notes'];
const MAX_IMPORT_ROWS = 500;

router.get('/products/template.csv', (req, res) => {
  const sample = [
    { name: 'Pikachu', set: 'Base', number: '58/102', condition: 'LP', variant: 'Normal', price: '5.00', qty: '1', status: 'live', image: '', notes: 'light edge wear' },
    { name: 'Charizard', set: 'Base', number: '4/102', condition: 'MP', variant: 'Reverse Holo', price: '250.00', qty: '1', status: 'draft', image: '', notes: '' },
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="crazed-tcg-template.csv"');
  res.send(csv.stringify(TEMPLATE_HEADERS, sample));
});

router.get('/products/export.csv', (req, res) => {
  const rows = allProducts.all().map((p) => ({
    name: p.name,
    set: p.set_name,
    number: p.number,
    condition: p.condition,
    variant: p.variant,
    price: p.price.toFixed(2),
    qty: p.qty,
    status: p.status,
    image: p.image,
    notes: p.notes,
  }));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="crazed-tcg-inventory-${stamp}.csv"`);
  res.send(csv.stringify(TEMPLATE_HEADERS, rows));
});

/** Accepts either a multipart file field named "file" or a raw JSON { text }. */
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
}).single('file');

function readImportRow(record) {
  const errors = [];

  const name = String(record.name || '').trim().slice(0, 160);
  if (!name) errors.push('name is required');

  // Price and qty are optional in a CSV; sensible defaults beat rejecting the row.
  const rawPrice = String(record.price || '').replace(/[$,\s]/g, '');
  const price = rawPrice === '' ? 0 : Number(rawPrice);
  if (!Number.isFinite(price) || price < 0) errors.push('price must be zero or more');

  const rawQty = String(record.qty || '').trim();
  const qty = rawQty === '' ? 1 : Number.parseInt(rawQty, 10);
  if (!Number.isInteger(qty) || qty < 0) errors.push('qty must be a whole number');

  const condition = String(record.condition || '').trim().toUpperCase();
  if (condition && !CONDITIONS.has(condition)) {
    errors.push(`condition "${condition}" must be NM, LP, MP or HP`);
  }

  const rawVariant = String(record.variant || '').trim();
  const variant = [...VARIANTS].find((v) => v.toLowerCase() === rawVariant.toLowerCase());
  if (rawVariant && !variant) {
    errors.push(`variant "${rawVariant}" must be Normal, Holo, Reverse Holo or 1st Edition`);
  }

  const status = String(record.status || '').trim().toLowerCase();
  if (status && !STATUSES.has(status)) {
    errors.push(`status "${status}" is not valid`);
  }

  return {
    line: record._line,
    errors,
    values: {
      name,
      set_name: String(record.set || '').trim().slice(0, 160),
      number: String(record.number || '').trim().slice(0, 40),
      condition: condition || 'NM',
      variant: variant || 'Normal',
      price: Math.round(price * 100) / 100,
      qty,
      status: status || 'draft',
      image: String(record.image || '').trim().slice(0, 500),
      notes: String(record.notes || '').trim().slice(0, 2000),
    },
  };
}

const findDuplicate = db.prepare(
  'SELECT id FROM products WHERE lower(name) = lower(?) AND lower(set_name) = lower(?) ' +
    'AND lower(number) = lower(?) AND condition = ? AND variant = ? LIMIT 1'
);

router.post('/products/bulk', (req, res) => {
  uploadCsv(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const message =
          uploadErr.code === 'LIMIT_FILE_SIZE' ? 'CSV must be under 2 MB.' : uploadErr.message;
        return res.status(400).json({ error: message });
      }

      const text = req.file
        ? req.file.buffer.toString('utf8')
        : String((req.body && req.body.text) || '');

      if (!text.trim()) return res.status(400).json({ error: 'No CSV content received.' });

      const { headers, records } = csv.parseObjects(text);

      if (!headers.includes('name')) {
        return res.status(400).json({
          error: `The CSV needs a "name" column. Found: ${headers.join(', ') || '(nothing)'}`,
        });
      }
      if (!records.length) return res.status(400).json({ error: 'The CSV has no data rows.' });
      if (records.length > MAX_IMPORT_ROWS) {
        return res.status(400).json({
          error: `That is ${records.length} rows; the limit is ${MAX_IMPORT_ROWS} per import.`,
        });
      }

      // multipart sends everything as strings, so compare loosely.
      const commit = String((req.body && req.body.commit) || '') === 'true';
      const fetchImages = String((req.body && req.body.fetchImages) || '') === 'true';
      const skipDuplicates = String((req.body && req.body.skipDuplicates) || '') !== 'false';

      const parsed = records.map(readImportRow);

      // Flag rows that already exist so an accidental re-import doesn't double stock.
      for (const row of parsed) {
        row.duplicate = Boolean(
          !row.errors.length &&
            findDuplicate.get(
              row.values.name,
              row.values.set_name,
              row.values.number,
              row.values.condition,
              row.values.variant
            )
        );
      }

      let rateLimited = false;
      if (fetchImages) {
        const needing = parsed.filter((r) => !r.errors.length && !r.values.image);
        if (needing.length) {
          const { results, rateLimited: limited } = await ptcg.lookupMany(
            needing.map((r) => ({
              name: r.values.name,
              set: r.values.set_name,
              number: r.values.number,
            }))
          );
          rateLimited = limited;
          needing.forEach((row, i) => {
            const hit = results[i];
            if (!hit) {
              row.imageMatch = 'none';
              return;
            }
            row.values.image = hit.image;
            row.imageMatch = hit.confidence;
            row.marketPrice = hit.marketPrice;
            row.matchedSet = hit.set;

            // Surface a set mismatch — "Base" silently matching "Base Set 2" would
            // otherwise put the wrong art on the listing.
            row.setMismatch = Boolean(
              row.values.set_name &&
                hit.set &&
                row.values.set_name.toLowerCase() !== hit.set.toLowerCase()
            );

            // Fill blanks from the API, but never overwrite what the seller typed.
            if (!row.values.set_name) row.values.set_name = hit.set;
            if (!row.values.number) row.values.number = hit.number;
          });
        }
      }

      const importable = parsed.filter(
        (r) => !r.errors.length && !(skipDuplicates && r.duplicate)
      );

      if (!commit) {
        return res.json({
          preview: true,
          rateLimited,
          apiKey: ptcg.hasApiKey(),
          counts: {
            total: parsed.length,
            importable: importable.length,
            invalid: parsed.filter((r) => r.errors.length).length,
            duplicates: parsed.filter((r) => r.duplicate).length,
            imagesFound: parsed.filter((r) => r.imageMatch && r.imageMatch !== 'none').length,
          },
          rows: parsed.map((r) => ({
            line: r.line,
            errors: r.errors,
            duplicate: Boolean(r.duplicate),
            imageMatch: r.imageMatch || null,
            matchedSet: r.matchedSet || null,
            setMismatch: Boolean(r.setMismatch),
            marketPrice: r.marketPrice == null ? null : r.marketPrice,
            ...toAdminProduct({ id: '', ...r.values, created_at: '', updated_at: '' }),
          })),
        });
      }

      if (!importable.length) {
        return res.status(400).json({ error: 'Nothing to import — every row was invalid or a duplicate.' });
      }

      // All rows land or none do; a half-finished import is worse than no import.
      const insertMany = db.transaction((rows) => {
        for (const row of rows) {
          insertProduct.run({ id: 'p' + crypto.randomBytes(8).toString('hex'), ...row.values });
        }
      });
      insertMany(importable);

      res.status(201).json({
        imported: importable.length,
        skipped: parsed.length - importable.length,
        rateLimited,
      });
    } catch (err) {
      console.error('[bulk import]', err);
      res.status(500).json({ error: 'Could not process that CSV.' });
    }
  });
});

/* ------------------------------------------------------------ add by set --- */

router.get('/sets', async (req, res) => {
  try {
    res.json(await ptcg.listSets());
  } catch (err) {
    console.error('[sets]', err);
    res.status(502).json({ error: 'Could not reach the Pokémon TCG API for the set list.' });
  }
});

router.get('/sets/:id/cards', async (req, res) => {
  try {
    res.json(await ptcg.listSetCards(req.params.id));
  } catch (err) {
    console.error('[set cards]', err);
    res.status(502).json({ error: 'Could not reach the Pokémon TCG API for this set.' });
  }
});

const MAX_SET_IMPORT_ROWS = 500;

router.post('/products/bulk-set', (req, res) => {
  const body = req.body || {};
  const setName = String(body.setName || '').trim().slice(0, 160);
  const cards = Array.isArray(body.cards) ? body.cards : [];

  if (!cards.length) return res.status(400).json({ error: 'No cards were sent.' });
  if (cards.length > MAX_SET_IMPORT_ROWS) {
    return res.status(400).json({
      error: `That is ${cards.length} cards; the limit is ${MAX_SET_IMPORT_ROWS} per import.`,
    });
  }

  // Only rows the seller actually gave a positive quantity get added — the rest of
  // the set was just there to browse, not to list.
  const rows = [];
  for (const c of cards) {
    const name = String((c && c.name) || '').trim().slice(0, 160);
    const qty = Number.parseInt(c && c.qty, 10);
    if (!name || !Number.isInteger(qty) || qty <= 0) continue;

    const price = Number(c.price);
    if (!Number.isFinite(price) || price < 0) continue;

    rows.push({
      id: 'p' + crypto.randomBytes(8).toString('hex'),
      name,
      set_name: setName,
      number: String(c.number || '').trim().slice(0, 40),
      condition: CONDITIONS.has(c.condition) ? c.condition : 'NM',
      variant: VARIANTS.has(c.variant) ? c.variant : 'Normal',
      price: Math.round(price * 100) / 100,
      qty,
      status: STATUSES.has(c.status) ? c.status : 'draft',
      image: String(c.image || '').trim().slice(0, 500),
      notes: String(c.notes || '').trim().slice(0, 2000),
    });
  }

  if (!rows.length) {
    return res.status(400).json({
      error: 'Nothing to import — set a quantity of at least 1 on the cards you want to add.',
    });
  }

  const insertMany = db.transaction((list) => {
    for (const row of list) insertProduct.run(row);
  });
  insertMany(rows);

  res.status(201).json({ imported: rows.length });
});

/* --------------------------------------------------------------- uploads --- */

const ALLOWED_IMAGE = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMAGE.get(file.mimetype) || '.bin';
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE.has(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'));
    }
    cb(null, true);
  },
});

router.post('/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 6 MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No image received.' });
    res.status(201).json({ url: '/uploads/' + req.file.filename });
  });
});

/* ---------------------------------------------------------------- orders --- */

const allOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
const oneOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const itemsForOrder = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
const setOrderStatus = db.prepare(
  "UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?"
);

function toAdminOrder(row, items) {
  return {
    id: row.id,
    buyer: row.buyer,
    telegram: row.telegram,
    email: row.email,
    address: row.address,
    delivery: row.delivery,
    subtotal: row.subtotal,
    fee: row.fee,
    total: row.total,
    status: row.status,
    notifyState: row.notify_state,
    notifyError: row.notify_error,
    createdAt: row.created_at,
    items: (items || []).map((i) => ({
      id: i.product_id,
      name: i.name,
      set: i.set_name,
      number: i.number,
      condition: i.condition,
      variant: i.variant,
      price: i.price,
      image: i.image,
    })),
  };
}

router.get('/orders', (req, res) => {
  const rows = allOrders.all();
  res.json(rows.map((row) => toAdminOrder(row, itemsForOrder.all(row.id))));
});

router.get('/orders/:id', (req, res) => {
  const row = oneOrder.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  res.json(toAdminOrder(row, itemsForOrder.all(row.id)));
});

/** Marking an order paid retires its zero-stock cards from 'reserved' to 'sold'. */
const markSoldOut = db.transaction((orderId) => {
  const items = itemsForOrder.all(orderId);
  for (const item of items) {
    if (!item.product_id) continue;
    db.prepare(
      "UPDATE products SET status = 'sold', updated_at = datetime('now') " +
        "WHERE id = ? AND qty <= 0 AND status = 'reserved'"
    ).run(item.product_id);
  }
});

/** Cancelling returns each card to the shelf. */
const restock = db.transaction((orderId) => {
  const items = itemsForOrder.all(orderId);
  for (const item of items) {
    if (!item.product_id) continue;
    db.prepare(
      "UPDATE products SET qty = qty + 1, status = 'live', updated_at = datetime('now') WHERE id = ?"
    ).run(item.product_id);
  }
});

router.post('/orders/:id/status', (req, res) => {
  const row = oneOrder.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });

  let next = String((req.body && req.body.status) || '').trim();

  // No explicit status means "advance one step".
  if (!next) {
    const i = ORDER_FLOW.indexOf(row.status);
    if (i === -1 || i === ORDER_FLOW.length - 1) {
      return res.status(400).json({ error: 'This order is already at its final status.' });
    }
    next = ORDER_FLOW[i + 1];
  }

  if (!ORDER_STATUSES.has(next)) {
    return res.status(400).json({ error: 'Unknown order status.' });
  }
  if (row.status === 'cancelled' && next !== 'cancelled') {
    return res.status(409).json({ error: 'A cancelled order cannot be reopened.' });
  }

  if (next === 'cancelled' && row.status !== 'cancelled') restock(row.id);
  if (next === 'paid' && row.status !== 'paid') markSoldOut(row.id);

  setOrderStatus.run(next, row.id);
  res.json(toAdminOrder(oneOrder.get(row.id), itemsForOrder.all(row.id)));
});

/**
 * Only cancelled or completed orders can be deleted — both are terminal states where
 * stock has already been settled (restocked on cancel, sold on completion), so removing
 * the record can't silently strand reserved inventory.
 */
router.delete('/orders/:id', (req, res) => {
  const row = oneOrder.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });

  if (row.status !== 'cancelled' && row.status !== 'completed') {
    return res.status(409).json({
      error: 'Only cancelled or completed orders can be deleted. Cancel it first to release the stock.',
    });
  }

  db.prepare('DELETE FROM orders WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

router.post('/orders/:id/notify', async (req, res) => {
  const row = oneOrder.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });

  const result = await telegram.notifyNewOrder(row, itemsForOrder.all(row.id));
  if (!result.ok) return res.status(502).json({ error: result.reason });
  res.json({ ok: true });
});

/* -------------------------------------------------------------- settings --- */

router.get('/settings', (req, res) => {
  res.json({ ...getSettings(), telegramConfigured: telegram.isConfigured() });
});

router.put('/settings', (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (body.storeName !== undefined) patch.storeName = String(body.storeName).trim().slice(0, 80);
  if (body.telegram !== undefined) patch.telegram = String(body.telegram).trim().slice(0, 80);
  if (body.paynow !== undefined) patch.paynow = String(body.paynow).trim().slice(0, 2000);
  if (body.paynowQr !== undefined) patch.paynowQr = String(body.paynowQr).trim().slice(0, 500);
  if (body.paynowPayee !== undefined) {
    patch.paynowPayee = String(body.paynowPayee).trim().slice(0, 120);
  }
  if (body.contactTelegram !== undefined) {
    const handle = String(body.contactTelegram).trim().slice(0, 80);
    if (handle && !/^@[A-Za-z0-9_]{4,32}$/.test(handle)) {
      return res.status(400).json({ error: 'Contact Telegram should look like @yourname.' });
    }
    patch.contactTelegram = handle;
  }

  for (const key of ['mailing', 'minimum', 'reservation']) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `"${key}" must be a number of zero or more.` });
    }
    patch[key] = key === 'reservation' ? Math.round(n) : Math.round(n * 100) / 100;
  }

  saveSettings(patch);
  res.json({ ...getSettings(), telegramConfigured: telegram.isConfigured() });
});

router.post('/telegram/test', async (req, res) => {
  const result = await telegram.sendTest();
  if (!result.ok) return res.status(502).json({ error: result.reason });
  res.json({ ok: true });
});

/* ------------------------------------------------------------ dashboard --- */

router.get('/stats', (req, res) => {
  const live = db.prepare("SELECT COUNT(*) n FROM products WHERE status = 'live' AND qty > 0").get().n;
  const reserved = db.prepare("SELECT COUNT(*) n FROM products WHERE status = 'reserved'").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting payment'").get().n;
  const sales = db
    .prepare(
      "SELECT COALESCE(SUM(total), 0) s FROM orders WHERE status IN ('paid','packed','mailed','completed')"
    )
    .get().s;
  res.json({ live, reserved, pending, sales });
});

module.exports = router;
