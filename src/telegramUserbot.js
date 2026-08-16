'use strict';

const crypto = require('crypto');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { db } = require('./db');

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

// Initialize the username cache table once at startup
function initChatIdCache() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS userbot_chat_id_cache (
      username TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Look up a username in the cache. Returns the chat_id string if found, null otherwise.
function getCachedChatId(username) {
  const row = db.prepare('SELECT chat_id FROM userbot_chat_id_cache WHERE username = ?').get(username);
  return row ? row.chat_id : null;
}

// Store a resolved username → chat_id mapping in the cache
function cacheChatId(username, chatId) {
  db.prepare(
    'INSERT OR REPLACE INTO userbot_chat_id_cache (username, chat_id) VALUES (?, ?)'
  ).run(username, String(chatId));
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
  initChatIdCache();
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
 * Resolve a chat identifier (username or numeric ID) to a numeric chat ID,
 * using the cache to avoid hitting the Telegram API's rate limit on ResolveUsername.
 * If the input is already numeric, returns it as-is. If it's a username (@-prefixed),
 * checks the cache first; if not cached, resolves via the API and caches it.
 */
async function resolveChatId(chatIdentifier, client) {
  // Already numeric? Return as-is.
  if (/^-?\d+$/.test(String(chatIdentifier))) {
    return String(chatIdentifier);
  }

  // Strip @ if present
  const username = String(chatIdentifier).replace(/^@/, '');

  // Check cache first
  const cached = getCachedChatId(username);
  if (cached) {
    return cached;
  }

  // Not cached, resolve via API
  try {
    const entity = await client.getEntity('@' + username);
    const chatId = entity.id ? String(entity.id) : String(entity);
    cacheChatId(username, chatId);
    return chatId;
  } catch (err) {
    // If resolution fails, re-throw so the caller sees the error
    throw err;
  }
}

/**
 * Forwards one message the userbot account can already see (it must already be a
 * member of fromChat) into toChat, optionally landing it in one forum topic via
 * threadId. Uses the raw API rather than the client's forwardMessages() helper because
 * topic targeting (topMsgId) isn't exposed there.
 *
 * Caches resolved usernames to numeric chat IDs to avoid hitting the contacts.ResolveUsername
 * rate limit.
 */
async function forwardMessage({ fromChat, messageId, toChat, threadId }) {
  if (!fromChat || !messageId) {
    return { ok: false, reason: 'original source not available (not a direct channel forward)' };
  }
  try {
    const client = await connect();
    const fromId = await resolveChatId(fromChat, client);
    const toId = await resolveChatId(toChat, client);
    const [fromEntity, toEntity] = await Promise.all([client.getEntity(fromId), client.getEntity(toId)]);
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
