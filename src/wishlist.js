'use strict';

const { db } = require('./db');

const MAX_ITEMS = 20;

const countFor = db.prepare('SELECT COUNT(*) AS n FROM wishlists WHERE user_id = ?');
const insertWish = db.prepare(
  'INSERT OR IGNORE INTO wishlists (user_id, query, set_name) VALUES (?, ?, ?)'
);
const listFor = db.prepare('SELECT id, query, set_name FROM wishlists WHERE user_id = ? ORDER BY id');
const deleteWish = db.prepare('DELETE FROM wishlists WHERE id = ? AND user_id = ?');
const allWishes = db.prepare('SELECT user_id AS userId, query, set_name FROM wishlists');

function addWish(userId, query, setName) {
  if (countFor.get(userId).n >= MAX_ITEMS) return { status: 'full' };
  const result = insertWish.run(userId, query, setName);
  return result.changes ? { status: 'added', id: Number(result.lastInsertRowid) } : { status: 'exists' };
}

/** Rows of { id, query, set_name }, oldest first. */
function listWish(userId) {
  return listFor.all(userId);
}

function removeWishById(userId, id) {
  return deleteWish.run(id, userId).changes === 1;
}

function allSubscriptions() {
  return allWishes.all();
}

/**
 * A wish with a set matches that card in that set only. Older wishes without a set fall
 * back to matching the text anywhere in the card's name, set or artist.
 */
function matchesWish(product, wish) {
  const q = wish.query.toLowerCase();
  if (wish.set_name) {
    return (
      String(product.name || '').toLowerCase().includes(q) &&
      String(product.set_name || '').toLowerCase() === wish.set_name.toLowerCase()
    );
  }
  return [product.name, product.set_name, product.artist].some((f) =>
    String(f || '').toLowerCase().includes(q)
  );
}

module.exports = {
  MAX_ITEMS,
  addWish,
  listWish,
  removeWishById,
  allSubscriptions,
  matchesWish,
};
