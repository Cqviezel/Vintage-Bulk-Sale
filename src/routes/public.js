'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { db, getSettings } = require('../db');
const telegram = require('../telegram');

const router = express.Router();

const DELIVERY = new Set(['Tracked Mailing', 'Self-Pickup']);

/** Shape a DB row for the storefront. Never leaks notes/qty beyond what's needed. */
function toPublicProduct(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    number: row.number,
    condition: row.condition,
    variant: row.variant,
    price: row.price,
    qty: row.qty,
    image: row.image,
  };
}

const listLive = db.prepare(
  "SELECT * FROM products WHERE status = 'live' AND qty > 0 ORDER BY name COLLATE NOCASE"
);

router.get('/products', (req, res) => {
  res.json(listLive.all().map(toPublicProduct));
});

/** Only shows that haven't finished yet, soonest first. */
const listUpcomingShows = db.prepare(
  "SELECT * FROM trade_shows WHERE COALESCE(end_date, start_date) >= @today ORDER BY start_date ASC"
);

router.get('/trade-shows', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json(
    listUpcomingShows.all({ today }).map((row) => ({
      id: row.id,
      venue: row.venue,
      location: row.location,
      startDate: row.start_date,
      endDate: row.end_date || '',
      tableNo: row.table_no,
    }))
  );
});

router.get('/settings', (req, res) => {
  const s = getSettings();
  // Only the fields the storefront legitimately needs.
  res.json({
    storeName: s.storeName,
    telegram: s.telegram,
    mailing: s.mailing,
    minimum: s.minimum,
    paynow: s.paynow,
    contactTelegram: s.contactTelegram,
  });
});

const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders from this address. Please try again shortly.' },
});

// Order IDs are only 4 digits (CTCG-1000..9999) — keep this tight so it can't be
// used to brute-force which IDs exist, even though a matching contact is also required.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookups. Please try again shortly.' },
});

const findOrderById = db.prepare('SELECT * FROM orders WHERE id = ?');
const orderItemsFor = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');

router.get('/orders/lookup', lookupLimiter, (req, res) => {
  let id = String(req.query.id || '').trim().toUpperCase().replace(/^CTCG-?/, '');
  id = id ? `CTCG-${id}` : '';
  const contact = String(req.query.contact || '').trim().toLowerCase();

  if (!id || !contact) {
    return res
      .status(400)
      .json({ error: 'Enter your order ID and the Telegram handle or email you checked out with.' });
  }

  const order = findOrderById.get(id);
  const matches =
    order && [order.telegram, order.email].filter(Boolean).some((v) => v.toLowerCase() === contact);

  if (!matches) {
    return res.status(404).json({ error: 'No order found with that ID and contact info.' });
  }

  const items = orderItemsFor.all(order.id);
  res.json({
    id: order.id,
    status: order.status,
    delivery: order.delivery,
    subtotal: order.subtotal,
    fee: order.fee,
    total: order.total,
    createdAt: order.created_at,
    items: items.map((i) => ({
      name: i.name,
      set: i.set_name,
      number: i.number,
      condition: i.condition,
      variant: i.variant,
      price: i.price,
      image: i.image,
    })),
  });
});

function newOrderId() {
  // 4 random digits, like the original demo, but collision-checked below.
  return 'CTCG-' + String(crypto.randomInt(1000, 10000));
}

const orderExists = db.prepare('SELECT 1 FROM orders WHERE id = ?');

function uniqueOrderId() {
  for (let i = 0; i < 25; i++) {
    const id = newOrderId();
    if (!orderExists.get(id)) return id;
  }
  // Fall back to something that cannot collide.
  return 'CTCG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

const selectProductForUpdate = db.prepare('SELECT * FROM products WHERE id = ?');
const decrementProduct = db.prepare(
  "UPDATE products SET qty = qty - 1, status = CASE WHEN qty - 1 <= 0 THEN 'reserved' ELSE status END, " +
    "updated_at = datetime('now') WHERE id = ? AND qty > 0 AND status = 'live'"
);
const insertOrder = db.prepare(
  `INSERT INTO orders (id, buyer, telegram, email, phone, address, delivery, subtotal, fee, total, status, notify_state)
   VALUES (@id, @buyer, @telegram, @email, @phone, @address, @delivery, @subtotal, @fee, @total, 'awaiting payment', 'pending')`
);
const insertOrderItem = db.prepare(
  `INSERT INTO order_items (order_id, product_id, name, set_name, number, condition, variant, price, image)
   VALUES (@order_id, @product_id, @name, @set_name, @number, @condition, @variant, @price, @image)`
);

/**
 * The whole point of the backend: reserving stock and writing the order happen in
 * one SQLite transaction, so two customers cannot both buy the same single card.
 */
// "Running low" — worth pinging the seller so they can pull/relist before it oversells.
const LOW_STOCK_THRESHOLD = 1;

const placeOrder = db.transaction((input) => {
  const settings = getSettings();
  const reserved = [];
  const lowStock = [];

  for (const productId of input.productIds) {
    const product = selectProductForUpdate.get(productId);
    if (!product) {
      throw Object.assign(new Error('One of the cards is no longer listed.'), { status: 409 });
    }
    const changed = decrementProduct.run(productId).changes;
    if (changed !== 1) {
      throw Object.assign(
        new Error(`"${product.name}" was just sold to someone else. Please remove it and try again.`),
        { status: 409 }
      );
    }
    reserved.push(product);

    const remaining = product.qty - 1;
    if (remaining <= LOW_STOCK_THRESHOLD) {
      lowStock.push({ name: product.name, set: product.set_name, qty: remaining });
    }
  }

  const subtotal = reserved.reduce((sum, p) => sum + Number(p.price), 0);

  if (subtotal < settings.minimum) {
    throw Object.assign(
      new Error(`Minimum card subtotal is $${settings.minimum.toFixed(2)}.`),
      { status: 400 }
    );
  }

  const fee = input.delivery === 'Tracked Mailing' ? settings.mailing : 0;
  const id = uniqueOrderId();

  const order = {
    id,
    buyer: input.buyer,
    telegram: input.telegram,
    email: input.email,
    phone: input.phone,
    address: input.address,
    delivery: input.delivery,
    subtotal: Number(subtotal.toFixed(2)),
    fee: Number(fee.toFixed(2)),
    total: Number((subtotal + fee).toFixed(2)),
  };

  insertOrder.run(order);

  const items = reserved.map((p) => ({
    order_id: id,
    product_id: p.id,
    name: p.name,
    set_name: p.set_name,
    number: p.number,
    condition: p.condition,
    variant: p.variant,
    price: p.price,
    image: p.image,
  }));
  for (const item of items) insertOrderItem.run(item);

  return { order, items, settings, lowStock };
});

router.post('/orders', orderLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};

    const buyer = String(body.buyer || '').trim().slice(0, 120);
    const telegramHandle = String(body.telegram || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().slice(0, 160);
    const phone = String(body.phone || '').trim().slice(0, 30);
    const address = String(body.address || '').trim().slice(0, 1000);
    const delivery = String(body.delivery || '').trim();
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!buyer) return res.status(400).json({ error: 'Please enter your name.' });
    if (!DELIVERY.has(delivery)) {
      return res.status(400).json({ error: 'Please choose a delivery method.' });
    }
    if (!telegramHandle && !email) {
      return res
        .status(400)
        .json({ error: 'Please give us a Telegram handle or an email so we can reach you.' });
    }
    if (telegramHandle && !/^@[A-Za-z0-9_]{4,32}$/.test(telegramHandle)) {
      return res.status(400).json({ error: 'Telegram handle should look like @yourname.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'That email address does not look valid.' });
    }
    if (delivery === 'Tracked Mailing' && !address) {
      return res.status(400).json({ error: 'Please enter your mailing address.' });
    }
    if (delivery === 'Tracked Mailing' && !phone) {
      return res.status(400).json({ error: 'Please enter a contact number for the courier.' });
    }
    if (phone && !/^[+\d][\d\s-]{6,29}$/.test(phone)) {
      return res.status(400).json({ error: 'That phone number does not look valid.' });
    }
    if (!rawItems.length) return res.status(400).json({ error: 'Your cart is empty.' });
    if (rawItems.length > 60) {
      return res.status(400).json({ error: 'That is too many cards for one order.' });
    }

    const productIds = [...new Set(rawItems.map((i) => String(i && i.id ? i.id : i)))];
    if (productIds.some((id) => !id || id.length > 64)) {
      return res.status(400).json({ error: 'Your cart contains an invalid item.' });
    }

    // Prices come from the database, never from the browser.
    const { order, items, settings, lowStock } = placeOrder({
      productIds,
      buyer,
      telegram: telegramHandle,
      email,
      phone,
      address,
      delivery,
    });

    // Respond immediately; the customer should not wait on Telegram's API.
    res.status(201).json({
      id: order.id,
      buyer: order.buyer,
      telegram: order.telegram,
      email: order.email,
      phone: order.phone,
      delivery: order.delivery,
      subtotal: order.subtotal,
      fee: order.fee,
      total: order.total,
      status: 'awaiting payment',
      paynow: settings.paynow,
      paynowQr: settings.paynowQr,
      paynowPayee: settings.paynowPayee,
      contactTelegram: settings.contactTelegram,
      items: items.map((i) => ({
        name: i.name,
        set: i.set_name,
        number: i.number,
        condition: i.condition,
        variant: i.variant,
        price: i.price,
        image: i.image,
      })),
    });

    telegram.notifyNewOrder(order, items).catch(() => {});
    for (const product of lowStock) {
      telegram.notifyLowStock(product).catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
