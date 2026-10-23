'use strict';

const crypto = require('crypto');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { db } = require('./db');

// Access hashes are per Telegram account, so each cached row records which account
// resolved it. After logging in as a different account the old rows are ignored
// (they'd fail with CHANNEL_INVALID) and the chat is resolved again once.
if (!db.prepare('PRAGMA table_info(telegram_entity_cache)').all().some((c) => c.name === 'owner_id')) {
  db.exec("ALTER TABLE telegram_entity_cache ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
}
const getCachedEntity = db.prepare(
  "SELECT class_name, entity_id, access_hash FROM telegram_entity_cache WHERE chat_ref = ? AND owner_id = ? AND owner_id <> ''"
);
const upsertCachedEntity = db.prepare(
  `INSERT INTO telegram_entity_cache (chat_ref, class_name, entity_id, access_hash, owner_id) VALUES (@chat_ref, @class_name, @entity_id, @access_hash, @owner_id)
   ON CONFLICT(chat_ref) DO UPDATE SET class_name = excluded.class_name, entity_id = excluded.entity_id, access_hash = excluded.access_hash,
     owner_id = excluded.owner_id, cached_at = datetime('now')`
);
const deleteCachedEntity = db.prepare('DELETE FROM telegram_entity_cache WHERE chat_ref = ?');

// The logged-in account's user ID, set once connect() succeeds.
let ownerId = '';

/** Errors meaning the peer we sent is no good for this account (stale access hash). */
const isStalePeerError = (err) =>
  /CHANNEL_INVALID|PEER_ID_INVALID|CHANNEL_PRIVATE|channel is invalid|Could not find the input entity/i.test(
    String((err && (err.errorMessage || err.message)) || err)
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
 */
async function resolveChat(client, chatRef, { fresh = false } = {}) {
  if (fresh) deleteCachedEntity.run(chatRef);
  const cached = getCachedEntity.get(chatRef, ownerId);
  const cachedPeer = cached && inputPeerFromCache(cached);
  if (cachedPeer) return cachedPeer;

  const entity = await client.getEntity(chatRef);
  upsertCachedEntity.run({
    chat_ref: chatRef,
    class_name: entity.className,
    entity_id: String(entity.id),
    access_hash: entity.accessHash != null ? String(entity.accessHash) : null,
    owner_id: ownerId,
  });
  return entity;
}

// Separate from the bot (TELEGRAM_BOT_TOKEN): this logs in as a real Telegram account
// (via scripts/telegram-userbot-login.js) so it can post into channels the shop's own
// bot was never made an admin of, as long as the account is already a member there.
function isConfigured() {
  return Boolean(
    process.env.TELEGRAM_USERBOT_API_ID &&
      process.env.TELEGRAM_USERBOT_API_HASH &&
      process.env.TELEGRAM_USERBOT_SESSION
  );
}

// One connection, reused for the life of the process — MTProto handshakes are too slow
// to redo per forward. Resolves to the same client on every call once connected.
let clientPromise = null;

function connect() {
  if (!isConfigured()) return Promise.reject(new Error('userbot not configured'));
  if (!clientPromise) {
    const client = new TelegramClient(
      new StringSession(process.env.TELEGRAM_USERBOT_SESSION),
      Number(process.env.TELEGRAM_USERBOT_API_ID),
      process.env.TELEGRAM_USERBOT_API_HASH,
      { connectionRetries: 5 }
    );
    clientPromise = client
      .connect()
      // Warms the account's entity cache for every chat it's already a member of, so
      // forwardMessage below can resolve a private channel by its numeric ID even
      // though it has no public @username to resolve through instead.
      .then(() => client.getDialogs())
      .then(() => client.getMe())
      .then((me) => {
        ownerId = me && me.id != null ? String(me.id) : '';
        return client;
      })
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
 * Forwards one message the userbot account can already see (it must already be a
 * member of fromChat) into toChat, optionally landing it in one forum topic via
 * threadId. Uses the raw API rather than the client's forwardMessages() helper because
 * topic targeting (topMsgId) isn't exposed there.
 */
async function forwardMessage({ fromChat, messageId, toChat, threadId }) {
  if (!fromChat || !messageId) {
    return { ok: false, reason: 'original source not available (not a direct channel forward)' };
  }
  try {
    const client = await connect();
    const send = async (fresh) => {
      const [fromEntity, toEntity] = await Promise.all([
        resolveChat(client, fromChat, { fresh }),
        resolveChat(client, toChat, { fresh }),
      ]);
      await client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer: fromEntity,
          id: [messageId],
          randomId: [randomLong()],
          toPeer: toEntity,
          topMsgId: threadId || undefined,
        })
      );
    };
    try {
      await send(false);
    } catch (err) {
      if (!isStalePeerError(err)) throw err;
      await send(true);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { isConfigured, start, stop, forwardMessage, getClient: connect, resolveChat, isStalePeerError };
