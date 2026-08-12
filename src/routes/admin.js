'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');

const { db, getSettings, saveSettings } = require('../db');
const auth = require('../auth');
const telegram = require('../telegram');
const csv = require('../csv');
const ptcg = require('../pokemontcg');
const orders = require('../orders');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CONDITIONS = new Set(['NM', 'LP', 'MP', 'HP']);
const VARIANTS = new Set(['Normal', 'Holo', 'Reverse Holo', '1st Edition']);
const STATUSES = new Set(['live', 'draft', 'reserved', 'sold', 'hidden']);
const { ORDER_FLOW } = orders;

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
    artist: row.artist,
  };
}

const allProducts = db.prepare('SELECT * FROM products ORDER BY updated_at DESC');
const oneProduct = db.prepare('SELECT * FROM products WHERE id = ?');
const insertProduct = db.prepare(
  `INSERT INTO products (id, name, set_name, number, condition, variant, price, qty, status, image, notes, artist)
   VALUES (@id, @name, @set_name, @number, @condition, @variant, @price, @qty, @status, @image, @notes, @artist)`
);
const updateProduct = db.prepare(
  `UPDATE products SET name = @name, set_name = @set_name, number = @number,
     condition = @condition, variant = @variant, price = @price, qty = @qty, status = @status,
     image = @image, notes = @notes, artist = @artist, updated_at = datetime('now')
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
      artist: String(body.artist || '').trim().slice(0, 120),
    },
  };
}

router.get('/products', (req, res) => {
  res.json(allProducts.all().map(toAdminProduct));
});

router.post('/products', (req, res) => {
  const { errors, values } = readProductBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  // Same card, set, number, condition and variant already on the shelf? Merge the
  // incoming stock into that row instead of creating a fragmented duplicate listing.
  const existing = findDuplicate.get(
    values.name,
    values.set_name,
    values.number,
    values.condition,
    values.variant
  );

  if (existing) {
    const current = oneProduct.get(existing.id);
    updateProduct.run({
      ...current,
      qty: current.qty + values.qty,
      price: values.price,
      status: values.status,
      image: values.image || current.image,
      notes: values.notes || current.notes,
      artist: values.artist || current.artist,
    });
    return res.status(200).json(toAdminProduct(oneProduct.get(existing.id)));
  }

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

const CONFIDENT_MATCH = new Set(['exact', 'number', 'set']);

/**
 * One-off maintenance: fills in `artist` for any product that's missing it, by
 * re-looking each one up against the Pokémon TCG API — same matcher the CSV import
 * uses. Existing rows never got this field written (it was added after they were
 * created), and there's no "edit 78 cards by hand" option, so this runs it for you.
 * Only accepts matches corroborated by set and/or number — a bare name-only hit
 * could easily be the wrong printing's artist.
 */
router.post('/products/backfill-artist', async (req, res) => {
  const rows = db.prepare("SELECT id, name, set_name, number FROM products WHERE artist = ''").all();
  if (!rows.length) return res.json({ checked: 0, updated: 0, rateLimited: false });

  const { results, rateLimited } = await ptcg.lookupMany(
    rows.map((r) => ({ name: r.name, set: r.set_name, number: r.number }))
  );

  const updateArtist = db.prepare("UPDATE products SET artist = ?, updated_at = datetime('now') WHERE id = ?");
  let updated = 0;
  rows.forEach((row, i) => {
    const match = results[i];
    if (match && match.artist && CONFIDENT_MATCH.has(match.confidence)) {
      updateArtist.run(match.artist, row.id);
      updated++;
    }
  });

  res.json({ checked: rows.length, updated, rateLimited });
});

/* ----------------------------------------------------------- bulk import --- */

const TEMPLATE_HEADERS = ['name', 'set', 'number', 'condition', 'variant', 'price', 'qty', 'status', 'image', 'notes', 'artist'];
const MAX_IMPORT_ROWS = 500;

router.get('/products/template.csv', (req, res) => {
  const sample = [
    { name: 'Pikachu', set: 'Base', number: '58/102', condition: 'LP', variant: 'Normal', price: '5.00', qty: '1', status: 'live', image: '', notes: 'light edge wear', artist: 'Mitsuhiro Arita' },
    { name: 'Charizard', set: 'Base', number: '4/102', condition: 'MP', variant: 'Reverse Holo', price: '250.00', qty: '1', status: 'draft', image: '', notes: '', artist: '' },
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
    artist: p.artist,
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
      artist: String(record.artist || '').trim().slice(0, 120),
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

// Already retried several times with backoff inside pokemontcg.js by the time this fires —
// a failure here means the upstream API is genuinely down or degraded right now, not a
// one-off blip, so say so rather than implying something's wrong with this app.
const CATALOG_DOWN_HINT = 'It usually clears up within a few minutes — try again shortly.';

router.get('/sets', async (req, res) => {
  try {
    res.json(await ptcg.listSets());
  } catch (err) {
    console.error('[sets]', err);
    res.status(502).json({ error: `The Pokémon TCG API isn't responding right now. ${CATALOG_DOWN_HINT}` });
  }
});

router.get('/sets/:id/cards', async (req, res) => {
  try {
    res.json(await ptcg.listSetCards(req.params.id));
  } catch (err) {
    console.error('[set cards]', err);
    res.status(502).json({ error: `The Pokémon TCG API isn't responding right now. ${CATALOG_DOWN_HINT}` });
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
      artist: String(c.artist || '').trim().slice(0, 120),
    });
  }

  if (!rows.length) {
    return res.status(400).json({
      error: 'Nothing to import — set a quantity of at least 1 on the cards you want to add.',
    });
  }

  // Same merge-or-insert rule as the single-card endpoint — a set often overlaps
  // with cards already on the shelf (added by hand, by CSV, or from another set
  // import), so each row gets checked rather than inserted unconditionally.
  const insertMany = db.transaction((list) => {
    let merged = 0;
    for (const row of list) {
      const existing = findDuplicate.get(row.name, row.set_name, row.number, row.condition, row.variant);
      if (existing) {
        const current = oneProduct.get(existing.id);
        updateProduct.run({
          ...current,
          qty: current.qty + row.qty,
          price: row.price,
          status: row.status,
          image: row.image || current.image,
          notes: row.notes || current.notes,
          artist: row.artist || current.artist,
        });
        merged++;
      } else {
        insertProduct.run(row);
      }
    }
    return merged;
  });
  const merged = insertMany(rows);

  res.status(201).json({ imported: rows.length, merged });

  const liveCount = rows.filter((r) => r.status === 'live').length;
  telegram.notifyRestock(setName, liveCount).catch(() => {});
});

/* --------------------------------------------------------------- uploads --- */

const ALLOWED_IMAGE = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

// Buffered in memory (not written to disk) so sharp can downscale/re-encode it first —
// a phone photo straight off the camera is often 10-20x the size it needs to be for the web.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE.has(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'));
    }
    cb(null, true);
  },
});

const MAX_IMAGE_DIMENSION = 1400;

/** Downscales to a sane max size and re-encodes; never upscales a smaller source. */
async function processImage(buffer, mimetype) {
  let img = sharp(buffer, { animated: mimetype === 'image/gif' })
    .rotate() // respects EXIF orientation, which phone cameras rely on
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });

  switch (mimetype) {
    case 'image/jpeg':
      return img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    case 'image/png':
      return img.png({ compressionLevel: 8 }).toBuffer();
    case 'image/webp':
      return img.webp({ quality: 82 }).toBuffer();
    case 'image/gif':
      return img.gif().toBuffer();
    default:
      return buffer;
  }
}

router.post('/upload', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 6 MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No image received.' });

    try {
      const processed = await processImage(req.file.buffer, req.file.mimetype);
      const ext = ALLOWED_IMAGE.get(req.file.mimetype) || '.bin';
      const filename = crypto.randomBytes(12).toString('hex') + ext;
      await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), processed);
      res.status(201).json({ url: '/uploads/' + filename });
    } catch (procErr) {
      console.error('[upload] image processing failed:', procErr);
      res.status(500).json({ error: 'Could not process that image.' });
    }
  });
});

/* ---------------------------------------------------------------- orders --- */

function toAdminOrder(row, items) {
  return {
    id: row.id,
    buyer: row.buyer,
    telegram: row.telegram,
    email: row.email,
    phone: row.phone,
    address: row.address,
    delivery: row.delivery,
    subtotal: row.subtotal,
    discount: row.discount,
    promoCode: row.promo_code,
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
  const rows = orders.listAllOrders();
  res.json(rows.map((row) => toAdminOrder(row, orders.getOrderItems(row.id))));
});

// Must come before /orders/:id or that route would swallow this path as an id lookup.
const ORDER_EXPORT_HEADERS = [
  'order_id', 'date', 'buyer', 'telegram', 'email', 'phone', 'delivery',
  'card', 'set', 'number', 'condition', 'variant', 'price', 'status',
];

router.get('/orders/export.csv', (req, res) => {
  const rows = [];
  for (const o of orders.listAllOrders()) {
    const base = {
      order_id: o.id,
      date: o.created_at,
      buyer: o.buyer,
      telegram: o.telegram,
      email: o.email,
      phone: o.phone,
      delivery: o.delivery,
      status: o.status,
    };
    const items = orders.getOrderItems(o.id);
    if (!items.length) {
      rows.push({ ...base, card: '', set: '', number: '', condition: '', variant: '', price: '' });
      continue;
    }
    for (const item of items) {
      rows.push({
        ...base,
        card: item.name,
        set: item.set_name,
        number: item.number,
        condition: item.condition,
        variant: item.variant,
        price: item.price.toFixed(2),
      });
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="crazed-tcg-orders-${stamp}.csv"`);
  res.send(csv.stringify(ORDER_EXPORT_HEADERS, rows));
});

router.get('/orders/:id', (req, res) => {
  const row = orders.findOrder(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  res.json(toAdminOrder(row, orders.getOrderItems(row.id)));
});

router.post('/orders/:id/status', (req, res) => {
  const result = orders.advanceOrderStatus(req.params.id, req.body && req.body.status);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
  res.json(toAdminOrder(result.order, result.items));
});

/**
 * Only cancelled or completed orders can be deleted — both are terminal states where
 * stock has already been settled (restocked on cancel, sold on completion), so removing
 * the record can't silently strand reserved inventory.
 */
router.delete('/orders/:id', (req, res) => {
  const row = orders.findOrder(req.params.id);
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
  const row = orders.findOrder(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found.' });

  const result = await telegram.notifyNewOrder(row, orders.getOrderItems(row.id));
  if (!result.ok) return res.status(502).json({ error: result.reason });
  res.json({ ok: true });
});

/* ----------------------------------------------------------- trade shows --- */

function toAdminTradeShow(row) {
  return {
    id: row.id,
    venue: row.venue,
    location: row.location,
    startDate: row.start_date,
    endDate: row.end_date || '',
    tableNo: row.table_no,
  };
}

const allTradeShows = db.prepare('SELECT * FROM trade_shows ORDER BY start_date ASC');
const oneTradeShow = db.prepare('SELECT * FROM trade_shows WHERE id = ?');
const insertTradeShow = db.prepare(
  `INSERT INTO trade_shows (id, venue, location, start_date, end_date, table_no)
   VALUES (@id, @venue, @location, @start_date, @end_date, @table_no)`
);
const updateTradeShow = db.prepare(
  `UPDATE trade_shows SET venue = @venue, location = @location, start_date = @start_date,
     end_date = @end_date, table_no = @table_no
   WHERE id = @id`
);
const deleteTradeShow = db.prepare('DELETE FROM trade_shows WHERE id = ?');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readTradeShowBody(body) {
  const errors = [];

  const venue = String(body.venue || '').trim().slice(0, 120);
  if (!venue) errors.push('Venue is required.');

  const startDate = String(body.startDate || '').trim();
  if (!DATE_RE.test(startDate)) errors.push('Start date must be a valid date.');

  let endDate = String(body.endDate || '').trim();
  if (endDate && !DATE_RE.test(endDate)) errors.push('End date must be a valid date.');
  if (endDate && DATE_RE.test(startDate) && DATE_RE.test(endDate) && endDate < startDate) {
    errors.push('End date must be on or after the start date.');
  }
  if (!endDate) endDate = null;

  return {
    errors,
    values: {
      venue,
      location: String(body.location || '').trim().slice(0, 120),
      start_date: startDate,
      end_date: endDate,
      table_no: String(body.tableNo || '').trim().slice(0, 40),
    },
  };
}

router.get('/trade-shows', (req, res) => {
  res.json(allTradeShows.all().map(toAdminTradeShow));
});

router.post('/trade-shows', (req, res) => {
  const { errors, values } = readTradeShowBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const id = 'ts' + crypto.randomBytes(8).toString('hex');
  insertTradeShow.run({ id, ...values });
  res.status(201).json(toAdminTradeShow(oneTradeShow.get(id)));
});

router.put('/trade-shows/:id', (req, res) => {
  const existing = oneTradeShow.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Trade show not found.' });

  const { errors, values } = readTradeShowBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  updateTradeShow.run({ id: existing.id, ...values });
  res.json(toAdminTradeShow(oneTradeShow.get(existing.id)));
});

router.delete('/trade-shows/:id', (req, res) => {
  const existing = oneTradeShow.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Trade show not found.' });

  deleteTradeShow.run(existing.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------ promo codes --- */

const PROMO_TYPES = new Set(['percent', 'fixed']);

function toAdminPromo(row) {
  return {
    code: row.code,
    type: row.type,
    value: row.value,
    active: !!row.active,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at || '',
    minSubtotal: row.min_subtotal,
    createdAt: row.created_at,
  };
}

const allPromoCodes = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC');
const onePromoCode = db.prepare('SELECT * FROM promo_codes WHERE code = ?');
const insertPromoCode = db.prepare(
  `INSERT INTO promo_codes (code, type, value, active, max_uses, expires_at, min_subtotal)
   VALUES (@code, @type, @value, @active, @max_uses, @expires_at, @min_subtotal)`
);
const updatePromoCode = db.prepare(
  `UPDATE promo_codes SET type = @type, value = @value, active = @active,
     max_uses = @max_uses, expires_at = @expires_at, min_subtotal = @min_subtotal
   WHERE code = @code`
);
const deletePromoCode = db.prepare('DELETE FROM promo_codes WHERE code = ?');

function readPromoBody(body) {
  const errors = [];

  const code = String(body.code || '').trim().toUpperCase().slice(0, 24);
  if (!code) errors.push('Code is required.');
  else if (!/^[A-Z0-9-]+$/.test(code)) errors.push('Code may only contain letters, numbers and dashes.');

  const type = PROMO_TYPES.has(body.type) ? body.type : 'percent';

  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0) errors.push('Discount value must be greater than 0.');
  else if (type === 'percent' && value > 100) errors.push('Percent discount cannot exceed 100.');

  let maxUses = null;
  if (body.maxUses !== undefined && body.maxUses !== null && String(body.maxUses).trim() !== '') {
    maxUses = Math.round(Number(body.maxUses));
    if (!Number.isFinite(maxUses) || maxUses <= 0) errors.push('Max uses must be a positive whole number.');
  }

  let expiresAt = String(body.expiresAt || '').trim();
  if (expiresAt && !DATE_RE.test(expiresAt)) errors.push('Expiry must be a valid date.');
  if (!expiresAt) expiresAt = null;

  const minSubtotal = body.minSubtotal === undefined || body.minSubtotal === '' ? 0 : Number(body.minSubtotal);
  if (!Number.isFinite(minSubtotal) || minSubtotal < 0) {
    errors.push('Minimum subtotal must be zero or more.');
  }

  return {
    errors,
    code,
    values: {
      type,
      value: Math.round(value * 100) / 100,
      active: body.active === false ? 0 : 1,
      max_uses: maxUses,
      expires_at: expiresAt,
      min_subtotal: Math.round(minSubtotal * 100) / 100,
    },
  };
}

router.get('/promo-codes', (req, res) => {
  res.json(allPromoCodes.all().map(toAdminPromo));
});

router.post('/promo-codes', (req, res) => {
  const { errors, code, values } = readPromoBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  if (onePromoCode.get(code)) return res.status(409).json({ error: `Code "${code}" already exists.` });

  insertPromoCode.run({ code, ...values });
  res.status(201).json(toAdminPromo(onePromoCode.get(code)));
});

router.put('/promo-codes/:code', (req, res) => {
  const existingCode = String(req.params.code || '').trim().toUpperCase();
  const existing = onePromoCode.get(existingCode);
  if (!existing) return res.status(404).json({ error: 'Promo code not found.' });

  const { errors, values } = readPromoBody({ ...req.body, code: existingCode });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  updatePromoCode.run({ code: existingCode, ...values });
  res.json(toAdminPromo(onePromoCode.get(existingCode)));
});

router.delete('/promo-codes/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const existing = onePromoCode.get(code);
  if (!existing) return res.status(404).json({ error: 'Promo code not found.' });

  deletePromoCode.run(code);
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

/* ------------------------------------------------------------ analytics --- */

// Same "counts as a real sale" definition already used by /stats above.
const SALE_STATUSES = ORDER_FLOW.slice(1); // paid, packed, mailed, completed

router.get('/analytics', (req, res) => {
  const rawDays = String(req.query.days || '30');
  const days = rawDays === 'all' ? null : Number(rawDays) || 30;

  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  let from = null;
  if (days) {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1)); // inclusive of today
    from = d.toISOString().slice(0, 10);
  }

  const statusPlaceholders = SALE_STATUSES.map(() => '?').join(',');
  const dateSql = from ? 'AND date(o.created_at) >= ?' : '';
  const dateParams = from ? [from] : [];

  const summary = db
    .prepare(
      `SELECT COUNT(*) orders, COALESCE(SUM(total), 0) revenue
       FROM orders o WHERE status IN (${statusPlaceholders}) ${dateSql}`
    )
    .get(...SALE_STATUSES, ...dateParams);

  const units = db
    .prepare(
      `SELECT COUNT(*) n FROM order_items oi JOIN orders o ON oi.order_id = o.id
       WHERE o.status IN (${statusPlaceholders}) ${dateSql}`
    )
    .get(...SALE_STATUSES, ...dateParams).n;

  const dailyRows = db
    .prepare(
      `SELECT date(o.created_at) day, SUM(o.total) revenue, COUNT(*) orders
       FROM orders o WHERE status IN (${statusPlaceholders}) ${dateSql}
       GROUP BY day ORDER BY day`
    )
    .all(...SALE_STATUSES, ...dateParams);

  const pvDateSql = from ? 'AND date(created_at) >= ?' : '';

  const visitSummary = db
    .prepare(`SELECT COUNT(*) views, COUNT(DISTINCT visitor) uniques FROM page_views WHERE 1=1 ${pvDateSql}`)
    .get(...dateParams);

  const visitDailyRows = db
    .prepare(
      `SELECT date(created_at) day, COUNT(*) views, COUNT(DISTINCT visitor) uniques
       FROM page_views WHERE 1=1 ${pvDateSql}
       GROUP BY day ORDER BY day`
    )
    .all(...dateParams);

  const topCards = db
    .prepare(
      `SELECT oi.name AS name, oi.set_name AS setName, oi.number AS number,
              COUNT(*) unitsSold, SUM(oi.price) revenue
       FROM order_items oi JOIN orders o ON oi.order_id = o.id
       WHERE o.status IN (${statusPlaceholders}) ${dateSql}
       GROUP BY oi.name, oi.set_name, oi.number
       ORDER BY revenue DESC LIMIT 10`
    )
    .all(...SALE_STATUSES, ...dateParams);

  const topSets = db
    .prepare(
      `SELECT oi.set_name AS setName, COUNT(*) unitsSold, SUM(oi.price) revenue
       FROM order_items oi JOIN orders o ON oi.order_id = o.id
       WHERE o.status IN (${statusPlaceholders}) ${dateSql} AND oi.set_name != ''
       GROUP BY oi.set_name
       ORDER BY revenue DESC LIMIT 10`
    )
    .all(...SALE_STATUSES, ...dateParams);

  // Every status, not just "real sales" — the point here is seeing the whole pipeline.
  const statusRows = db
    .prepare(`SELECT status, COUNT(*) n FROM orders o WHERE 1=1 ${dateSql} GROUP BY status`)
    .all(...dateParams);

  // Zero-fill so the chart has a continuous X-axis; skipped for "all time" since that
  // range has no fixed start to fill from.
  const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
  const visitMap = new Map(visitDailyRows.map((r) => [r.day, r]));
  const dayRow = (key) => {
    const sales = dailyMap.get(key);
    const visits = visitMap.get(key);
    return {
      date: key,
      revenue: sales ? sales.revenue : 0,
      orders: sales ? sales.orders : 0,
      visitors: visits ? visits.uniques : 0,
      pageViews: visits ? visits.views : 0,
    };
  };

  const daily = [];
  if (from) {
    const cursor = new Date(from);
    const end = new Date(to);
    while (cursor <= end) {
      daily.push(dayRow(cursor.toISOString().slice(0, 10)));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    const allDays = new Set([...dailyMap.keys(), ...visitMap.keys()]);
    [...allDays].sort().forEach((day) => daily.push(dayRow(day)));
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  res.json({
    range: { days, from, to },
    summary: {
      revenue: round2(summary.revenue),
      orders: summary.orders,
      avgOrderValue: summary.orders ? round2(summary.revenue / summary.orders) : 0,
      unitsSold: units,
      visitors: visitSummary.uniques,
      pageViews: visitSummary.views,
    },
    daily,
    topCards: topCards.map((r) => ({
      name: r.name,
      set: r.setName,
      number: r.number,
      unitsSold: r.unitsSold,
      revenue: round2(r.revenue),
    })),
    topSets: topSets.map((r) => ({
      set: r.setName,
      unitsSold: r.unitsSold,
      revenue: round2(r.revenue),
    })),
    statusBreakdown: statusRows,
  });
});

module.exports = router;
