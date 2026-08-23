'use strict';

const { db } = require('./db');

const insertClaimItem = db.prepare(
  'INSERT INTO claim_items (name, price, photo_file_id) VALUES (?, ?, ?)'
);
const oneClaimItem = db.prepare('SELECT * FROM claim_items WHERE id = ?');
const setChannelMessageStmt = db.prepare(
  'UPDATE claim_items SET channel_message_id = ? WHERE id = ?'
);

/** Same conditional-UPDATE pattern as advanceOrderStatus — the WHERE clause is the
    only thing standing between two simultaneous taps and a double-sold card, so the
    claim and the "did I win" check have to happen in the same statement. */
const claimStmt = db.prepare(
  "UPDATE claim_items SET status = 'claimed', claimed_by_id = ?, claimed_by_name = ?, " +
    "claimed_at = datetime('now') WHERE id = ? AND status = 'live'"
);

function createClaimItem({ name, price, photoFileId }) {
  const result = insertClaimItem.run(name, price, photoFileId);
  return oneClaimItem.get(result.lastInsertRowid);
}

function setChannelMessage(id, messageId) {
  setChannelMessageStmt.run(messageId, id);
}

function findClaimItem(id) {
  return oneClaimItem.get(id);
}

function claim(id, claimerId, claimerName) {
  const result = claimStmt.run(claimerId, claimerName, id);
  if (result.changes !== 1) return { ok: false };
  return { ok: true, item: oneClaimItem.get(id) };
}

module.exports = {
  createClaimItem,
  setChannelMessage,
  findClaimItem,
  claim,
};
