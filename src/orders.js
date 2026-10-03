'use strict';

const { db } = require('./db');
const events = require('./events');
const referrals = require('./referrals');

const ORDER_FLOW = ['awaiting payment', 'paid', 'packed', 'mailed', 'completed'];
const ORDER_STATUSES = new Set([...ORDER_FLOW, 'cancelled']);

const allOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
const ordersForCustomer = db.prepare(
  'SELECT * FROM orders WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT 50'
);
const openOrders = db.prepare(
  `SELECT * FROM orders WHERE status NOT IN ('completed', 'cancelled')
   ORDER BY created_at ASC LIMIT ?`
);
const oneOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const itemsForOrder = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');
const setOrderStatus = db.prepare(
  "UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?"
);

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

const selectProduct = db.prepare('SELECT * FROM products WHERE id = ?');
const restockOne = db.prepare(
  "UPDATE products SET qty = qty + 1, status = 'live', updated_at = datetime('now') WHERE id = ?"
);

/** Cancelling returns each card to the shelf. Returns the cards that were not live before. */
const restock = db.transaction((orderId) => {
  const revived = [];
  for (const item of itemsForOrder.all(orderId)) {
    if (!item.product_id) continue;
    const before = selectProduct.get(item.product_id);
    restockOne.run(item.product_id);
    if (before && before.status !== 'live') revived.push(selectProduct.get(item.product_id));
  }
  return revived;
});

function findOrder(id) {
  return oneOrder.get(id);
}

function getOrderItems(id) {
  return itemsForOrder.all(id);
}

function listAllOrders() {
  return allOrders.all();
}

function listOpenOrders(limit = 25) {
  return openOrders.all(limit);
}

function listOrdersForCustomer(telegramId) {
  return ordersForCustomer.all(telegramId);
}

/**
 * The single canonical status-transition function — both the web admin route and the
 * Telegram order buttons call this, since it touches real inventory (restock/sell-out)
 * and must have exactly one source of truth. explicitStatus is the raw string from a
 * request body or Telegram action, possibly '' / undefined for "advance one step."
 * Returns a discriminated result instead of throwing or writing to a response object.
 */
function advanceOrderStatus(id, explicitStatus) {
  const row = oneOrder.get(id);
  if (!row) return { ok: false, httpStatus: 404, error: 'Order not found.' };

  let next = String(explicitStatus || '').trim();
  if (!next) {
    const i = ORDER_FLOW.indexOf(row.status);
    if (i === -1 || i === ORDER_FLOW.length - 1) {
      return { ok: false, httpStatus: 400, error: 'This order is already at its final status.' };
    }
    next = ORDER_FLOW[i + 1];
  }

  if (!ORDER_STATUSES.has(next)) {
    return { ok: false, httpStatus: 400, error: 'Unknown order status.' };
  }
  if (row.status === 'cancelled' && next !== 'cancelled') {
    return { ok: false, httpStatus: 409, error: 'A cancelled order cannot be reopened.' };
  }

  let revived = [];
  let reward = null;
  if (next === 'cancelled' && row.status !== 'cancelled') {
    revived = restock(row.id);
    referrals.revokeRewardForOrder(row.id);
  }
  if (next === 'paid' && row.status !== 'paid') {
    markSoldOut(row.id);
    reward = referrals.rewardForPaidOrder(row);
  }

  setOrderStatus.run(next, row.id);

  if (revived.length) events.emit('productsLive', revived);
  if (reward) events.emit('referralRewarded', reward);

  return { ok: true, order: oneOrder.get(row.id), items: itemsForOrder.all(row.id) };
}

module.exports = {
  ORDER_FLOW,
  ORDER_STATUSES,
  findOrder,
  getOrderItems,
  listAllOrders,
  listOpenOrders,
  listOrdersForCustomer,
  advanceOrderStatus,
};
