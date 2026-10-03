'use strict';

const { db } = require('./db');

const MAX_ITEMS = 20;

const countFor = db.prepare('SELECT COUNT(*) AS n FROM wishlists WHERE user_id = ?');
const insertWish = db.prepare('INSERT OR IGNORE INTO wishlists (user_id, query) VALUES (?, ?)');
const listFor = db.prepare('SELECT id, query FROM wishlists WHERE user_id = ? ORDER BY id');
const deleteWish = db.prepare('DELETE FROM wishlists WHERE id = ? AND user_id = ?');
const allWishes = db.prepare('SELECT user_id AS userId, query FROM wishlists');

function addWish(userId, query) {
  if (countFor.get(userId).n >= MAX_ITEMS) return 'full';
  return insertWish.run(userId, query).changes ? 'added' : 'exists';
}

function listWish(userId) {
  return listFor.all(userId).map((r) => r.query);
}

/** `position` is 1-based, matching the numbering `/wishlist list` shows. */
function removeWish(userId, position) {
  const row = listFor.all(userId)[position - 1];
  if (!row) return false;
  return deleteWish.run(row.id, userId).changes === 1;
}

function allSubscriptions() {
  return allWishes.all();
}

function matchesWish(product, query) {
  const q = query.toLowerCase();
  return [product.name, product.set_name, product.artist].some((f) =>
    String(f || '').toLowerCase().includes(q)
  );
}

module.exports = { MAX_ITEMS, addWish, listWish, removeWish, allSubscriptions, matchesWish };
