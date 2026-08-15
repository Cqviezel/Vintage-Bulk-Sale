'use strict';

const crypto = require('crypto');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

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
    const [fromEntity, toEntity] = await Promise.all([client.getEntity(fromChat), client.getEntity(toChat)]);
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
