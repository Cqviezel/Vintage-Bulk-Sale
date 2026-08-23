'use strict';

const { db } = require('./db');

// Initialize the claim_items table
function initTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claim_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      photo_file_id TEXT NOT NULL,
      claimed_by_id TEXT,
      claimed_by_name TEXT,
      channel_message_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME
    )
  `);
}

function createClaimItem({ name, price, photoFileId }) {
  initTable();
  const stmt = db.prepare(
    'INSERT INTO claim_items (name, price, photo_file_id) VALUES (?, ?, ?)'
  );
  const result = stmt.run(name, price, photoFileId);
  return {
    id: result.lastInsertRowid,
    name,
    price,
    photo_file_id: photoFileId,
    claimed_by_id: null,
    claimed_by_name: null,
    channel_message_id: null,
  };
}

function setChannelMessage(id, messageId) {
  initTable();
  db.prepare('UPDATE claim_items SET channel_message_id = ? WHERE id = ?').run(messageId, id);
}

function claim(id, userId, userName) {
  initTable();
  const item = db.prepare('SELECT * FROM claim_items WHERE id = ?').get(id);
  
  if (!item) {
    return { ok: false, error: 'Item not found' };
  }
  
  if (item.claimed_by_id) {
    return { ok: false, error: 'Already claimed' };
  }

  db.prepare(
    'UPDATE claim_items SET claimed_by_id = ?, claimed_by_name = ?, claimed_at = datetime("now") WHERE id = ?'
  ).run(userId, userName, id);

  const updated = db.prepare('SELECT * FROM claim_items WHERE id = ?').get(id);
  return {
    ok: true,
    item: {
      id: updated.id,
      name: updated.name,
      price: updated.price,
      channel_message_id: updated.channel_message_id,
      claimed_by_name: updated.claimed_by_name,
    },
  };
}

module.exports = { createClaimItem, setChannelMessage, claim };
