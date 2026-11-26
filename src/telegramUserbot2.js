'use strict';

const crypto = require('crypto');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { db } = require('./db');

const getCachedEntity = db.prepare(
  'SELECT class_name, entity_id, access_hash FROM telegram_entity_cache2 WHERE chat_ref = ?'
);
const upsertCachedEntity = db.prepare(
  `INSERT INTO telegram_entity_cache2 (chat_ref, class_name, entity_id, access_hash) VALUES (@chat_ref, @class_name, @entity_id, @access_hash)
   ON CONFLICT(chat_ref) DO UPDATE SET class_name = excluded.class_name, entity_id = excluded.entity_id, access_hash = excluded.access_hash, cached_at = datetime('now')`
);

// Rebuilds just enough of the Input peer variant to forward with — no live resolve.
function inputPeerFromCache(row) {
  const id = bigInt(row.entity_id);
  const accessHash = row.access_hash != null ? bigInt(row.access_hash) : undefined;
  if (row.class_name === 'Channel') return new Api.InputPeerChannel({ channelId: id, accessHash });
  if (row.class_name === 'User') return new Api.InputPeerUser({ userId: id, accessHash });
  if (row.class_name === 'Chat') return new Api.InputPeerChat({ chatId: id });
  return null;
}

/**
 * Resolves a chat reference (an @username or a numeric chat ID, as a string) to a peer
 * the raw API will accept — served from a persistent cache whenever possible. Telegram
 * flood-limits contacts.ResolveUsername hard (multi-hour bans on repeat offenses), and
 * the client's own entity cache is in-memory only, so every process restart used to force
 * a fresh resolve for every configured forward target. Once a chat_ref has been resolved
 * successfully, this never resolves it again.
 *
 * Own cache table (telegram_entity_cache2) rather than sharing telegramUserbot.js's —
 * a peer's access_hash is only valid for the account that resolved it, so the two
 * accounts must never read each other's cached entries.
 */
async function resolveChat(client, chatRef) {
  const cached = getCachedEntity.get(chatRef);
  const cachedPeer = cached && inputPeerFromCache(cached);
  if (cachedPeer) return cachedPeer;

  const entity = await client.getEntity(chatRef);
  upsertCachedEntity.run({
    chat_ref: chatRef,
    class_name: entity.className,
    entity_id: String(entity.id),
    access_hash: entity.accessHash != null ? String(entity.accessHash) : null,
  });
  return entity;
}

// Second, entirely separate account from telegramUserbot.js — logs in via
// scripts/telegram-userbot2-login(-qr).js so forwarding can continue into channels the
// first account has since been banned from, or so channels can be split across two
// accounts to stay under per-account limits.
function isConfigured() {
  return Boolean(
    process.env.TELEGRAM_USERBOT2_API_ID &&
      process.env.TELEGRAM_USERBOT2_API_HASH &&
      process.env.TELEGRAM_USERBOT2_SESSION
  );
}

// One connection, reused for the life of the process — MTProto handshakes are too slow
// to redo per forward. Resolves to the same client on every call once connected.
let clientPromise = null;

function connect() {
  if (!isConfigured()) return Promise.reject(new Error('userbot2 not configured'));
  if (!clientPromise) {
    const client = new TelegramClient(
      new StringSession(process.env.TELEGRAM_USERBOT2_SESSION),
      Number(process.env.TELEGRAM_USERBOT2_API_ID),
      process.env.TELEGRAM_USERBOT2_API_HASH,
      { connectionRetries: 5 }
    );
    clientPromise = client
      .connect()
      // Warms the account's entity cache for every chat it's already a member of, so
      // forwardMessage below can resolve a private channel by its numeric ID even
      // though it has no public @username to resolve through instead.
      .then(() => client.getDialogs())
      .then(() => client)
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

async function start() {
  if (!isConfigured()) return;
  await connect();
}

async function stop() {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  if (client) await client.disconnect();
}

// Telegram requires a fresh random 64-bit ID per forwarded message purely for
// de-duplication on their end — its value is otherwise meaningless.
function randomLong() {
  return bigInt(crypto.randomBytes(8).toString('hex'), 16);
}

/**
 * Forwards one message this second userbot account can already see (it must already be
 * a member of fromChat) into toChat, optionally landing it in one forum topic via
 * threadId. Uses the raw API rather than the client's forwardMessages() helper because
 * topic targeting (topMsgId) isn't exposed there.
 */
async function forwardMessage({ fromChat, messageId, toChat, threadId }) {
  if (!fromChat || !messageId) {
    return { ok: false, reason: 'original source not available (not a direct channel forward)' };
  }
  try {
    const client = await connect();
    const [fromEntity, toEntity] = await Promise.all([resolveChat(client, fromChat), resolveChat(client, toChat)]);
    await client.invoke(
      new Api.messages.ForwardMessages({
        fromPeer: fromEntity,
        id: [messageId],
        randomId: [randomLong()],
        toPeer: toEntity,
        topMsgId: threadId || undefined,
      })
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { isConfigured, start, stop, forwardMessage };
