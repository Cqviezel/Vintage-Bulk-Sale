'use strict';

const { db } = require('./db');
const orders = require('./orders');

const API_ROOT = 'https://api.telegram.org';

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID);
}

/**
 * Forum-topic thread ID for a notification kind, if the group has topics and this one
 * is mapped in .env. Omitting message_thread_id entirely (undefined survives
 * JSON.stringify by being dropped) posts to the group's General topic instead.
 */
function threadId(envVar) {
  const raw = process.env[envVar];
  return raw ? Number(raw) : undefined;
}

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

/** We send parse_mode HTML, so only these three characters need escaping. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Displayed on the order card and its live status updates — the same card is sent once
// on creation and then edited in place as its status changes, so the wording can't say
// "new" forever.
const STATUS_LABEL = {
  'awaiting payment': 'Awaiting Payment',
  paid: 'Paid',
  packed: 'Packed',
  mailed: 'Mailed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function buildMessage(order, items) {
  const lines = [
    '<b>Crazed TCG order</b>',
    '',
    `<b>Order:</b> ${escapeHtml(order.id)}`,
    `<b>Status:</b> ${escapeHtml(STATUS_LABEL[order.status] || order.status)}`,
    `<b>Customer:</b> ${escapeHtml(order.buyer)}`,
  ];

  if (order.telegram) lines.push(`<b>Telegram:</b> ${escapeHtml(order.telegram)}`);
  if (order.email) lines.push(`<b>Email:</b> ${escapeHtml(order.email)}`);
  if (order.phone) lines.push(`<b>Phone:</b> ${escapeHtml(order.phone)}`);

  lines.push('', '<b>Items</b>');
  for (const item of items) {
    const detail = [item.set_name, item.number].filter(Boolean).join(' ');
    // "Normal" is the overwhelming default — only call it out when it's not.
    const tag = item.variant && item.variant !== 'Normal' ? `${item.condition}, ${item.variant}` : item.condition;
    lines.push(
      `• ${escapeHtml(item.name)}${detail ? ' — ' + escapeHtml(detail) : ''} ` +
        `[${escapeHtml(tag)}] ${money(item.price)}`
    );
  }

  lines.push(`• ${escapeHtml(order.delivery)} ${money(order.fee)}`);
  if (order.discount) {
    lines.push(`• Promo <b>${escapeHtml(order.promo_code)}</b> −${money(order.discount)}`);
  }
  lines.push(
    '',
    `<b>Total: ${money(order.total)}</b>`,
    '',
    '<b>Address / note</b>',
    escapeHtml(order.address || '-')
  );

  return lines.join('\n');
}

const markNotified = db.prepare(
  "UPDATE orders SET notify_state = ?, notify_error = ?, updated_at = datetime('now') WHERE id = ?"
);

async function post(path, body, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_ROOT}/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) {
      return { ok: false, reason: payload.description || `HTTP ${res.status}` };
    }
    return { ok: true, result: payload.result };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timed out after 10s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const ADVANCE_LABEL = {
  paid: '✅ Mark Paid',
  packed: '📦 Mark Packed',
  mailed: '📮 Mark Mailed',
  completed: '🏁 Mark Completed',
};

/**
 * The buttons under an order card. 'confirm_cancel' swaps in a Yes/Back pair instead of
 * mutating on the first tap — Cancel & Restock touches real inventory, and the web admin
 * gates the same action behind a JS confirm() dialog Telegram has no native equivalent of.
 */
function buildOrderKeyboard(order, mode = 'default') {
  if (mode === 'confirm_cancel') {
    return {
      inline_keyboard: [
        [{ text: '⚠️ Yes, cancel & restock', callback_data: `order:${order.id}:cancel_confirm` }],
        [{ text: '← Back', callback_data: `order:${order.id}:cancel_back` }],
      ],
    };
  }
  if (order.status === 'completed' || order.status === 'cancelled') {
    return { inline_keyboard: [] };
  }
  const i = orders.ORDER_FLOW.indexOf(order.status);
  const next = i >= 0 && i < orders.ORDER_FLOW.length - 1 ? orders.ORDER_FLOW[i + 1] : null;
  const rows = [];
  if (next) rows.push([{ text: ADVANCE_LABEL[next], callback_data: `order:${order.id}:advance` }]);
  rows.push([{ text: '❌ Cancel & Restock', callback_data: `order:${order.id}:cancel_ask` }]);
  return { inline_keyboard: rows };
}

/**
 * Edits an order card in place after a status change, so it reads as one evolving
 * status tracker instead of a new message per step. Telegram errors with "message is
 * not modified" when nothing actually changed (e.g. a racing duplicate tap lands after
 * the state is already reflected) — that's a harmless no-op here, not a failure.
 */
async function editOrderCard(chatId, messageId, order, items, mode = 'default') {
  const result = await post('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: buildMessage(order, items),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildOrderKeyboard(order, mode),
  });
  if (!result.ok && /message is not modified/i.test(result.reason || '')) return { ok: true };
  return result;
}

/**
 * Never throws into the request path — a Telegram outage must not stop a customer
 * from checking out. Failures are recorded on the order so admin can see and retry.
 */
async function notifyNewOrder(order, items) {
  if (!isConfigured()) {
    markNotified.run('not configured', '', order.id);
    return { ok: false, reason: 'not configured' };
  }

  const result = await post('sendMessage', {
    chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
    message_thread_id: threadId('TELEGRAM_TOPIC_SALES'),
    text: buildMessage(order, items),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildOrderKeyboard(order),
  });

  if (result.ok) {
    markNotified.run('sent', '', order.id);
  } else {
    markNotified.run('failed', String(result.reason).slice(0, 400), order.id);
    console.error(`[telegram] order ${order.id} notification failed: ${result.reason}`);
  }
  return result;
}

function stockLine(product) {
  const detail = product.set ? ` — ${escapeHtml(product.set)}` : '';
  return `• ${escapeHtml(product.name)}${detail} is sold out.`;
}

// A card leaves this query the moment it's restocked (qty rises and status is set back
// to 'live') or finalized (paid orders flip a sold-out card from 'reserved' to 'sold') —
// so the report always reflects what's still actionable right now, not a fixed log.
const stockReportRows = db.prepare(
  `SELECT name, set_name AS setName, qty FROM products
   WHERE qty <= 0 AND status IN ('live', 'reserved')
   ORDER BY name COLLATE NOCASE`
);

function currentOutOfStock() {
  return stockReportRows.all().map((r) => ({ name: r.name, set: r.setName, qty: r.qty }));
}

const STOCK_REPORT_BUTTON = {
  inline_keyboard: [[{ text: '📋 Full stock report', callback_data: 'stock_report' }]],
};

// Telegram rejects any message text over 4096 characters. Stay well clear of that so
// a long heading ("Out of stock (200) — part 12/12") never tips a chunk over the edge.
const TELEGRAM_MAX_LEN = 3800;

/** Groups `lines` into chunks that each join (with '\n') to at most `maxLen` characters. */
function chunkLines(lines, maxLen) {
  const chunks = [];
  let current = [];
  let len = 0;
  for (const line of lines) {
    if (current.length && len + line.length + 1 > maxLen) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Sends `products` as one roll-up message, split across multiple "part N/M" messages
 * if the list is long enough to hit Telegram's 4096-char cap. Assumes a non-empty list —
 * callers decide what "nothing to report" should look like for their situation.
 */
async function sendOutOfStockList(products) {
  const chunks = chunkLines(products.map(stockLine), TELEGRAM_MAX_LEN);
  const multiPart = chunks.length > 1;

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const heading = `<b>Out of stock</b> (${products.length})${multiPart ? ` — part ${i + 1}/${chunks.length}` : ''}`;
    const result = await post('sendMessage', {
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      message_thread_id: threadId('TELEGRAM_TOPIC_OUT_OF_STOCK'),
      text: [heading, ...chunks[i]].join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      // Only the last part carries the refresh button, so it isn't repeated per chunk.
      ...(i === chunks.length - 1 ? { reply_markup: STOCK_REPORT_BUTTON } : {}),
    });
    if (!result.ok) {
      console.error(`[telegram] out-of-stock message failed: ${result.reason}`);
    }
    results.push(result);
  }
  return results;
}

/**
 * One order can sell out several different cards at once (e.g. a big cart of singles
 * that each happened to be the last copy) — sending a Telegram message per card floods
 * the topic, so this sends one roll-up instead. Silent when nothing sold out, since that's
 * the common case and there's nothing worth pinging about.
 */
function notifyOutOfStock(products) {
  if (!isConfigured() || !products.length) return Promise.resolve({ ok: true });
  return sendOutOfStockList(products);
}

function isRestockChannelConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_RESTOCK_CHANNEL);
}

/**
 * Public restock announcement — a separate, customer-facing destination from the private
 * admin chat everything else in this file posts to, so it's gated on its own env var and
 * silently does nothing if that's unset (opt-in). TELEGRAM_RESTOCK_TOPIC routes it to a
 * specific topic the same way the admin group's topics work, falling back to General if
 * unset. Only fires for cards that actually went live, since a set imported as drafts
 * (to price/review first) isn't purchasable yet and isn't news.
 */
function notifyRestock(setName, liveCount) {
  if (!isRestockChannelConfigured() || liveCount <= 0) return Promise.resolve({ ok: true });
  const label = liveCount === 1 ? 'card' : 'cards';
  return post('sendMessage', {
    chat_id: process.env.TELEGRAM_RESTOCK_CHANNEL,
    message_thread_id: threadId('TELEGRAM_RESTOCK_TOPIC'),
    text: `🎉 <b>Restocked: ${escapeHtml(setName)}</b>\n${liveCount} ${label} from this set just went live — check the shop!`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * The on-demand report (button tap / `/stock`), unlike notifyOutOfStock above: it always
 * replies, even with nothing to report, since it was explicitly asked for.
 */
function sendFullStockReport() {
  const products = currentOutOfStock();
  if (!products.length) {
    return post('sendMessage', {
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      text: '<b>Stock report</b>\nNothing out of stock right now.',
      parse_mode: 'HTML',
      reply_markup: STOCK_REPORT_BUTTON,
    });
  }
  return sendOutOfStockList(products);
}

/** `text` shows as a small toast on the tapping device; showAlert makes it a blocking popup. */
function answerCallbackQuery(id, text, showAlert = false) {
  return post('answerCallbackQuery', { callback_query_id: id, ...(text ? { text, show_alert: showAlert } : {}) });
}

// Only the configured shop chat gets a reply — otherwise anyone who can message this
// bot (a stray DM, or it sitting in an unrelated group) could pull the full inventory.
function isFromAdminChat(chatId) {
  return String(chatId) === String(process.env.TELEGRAM_ADMIN_CHAT_ID);
}

function orderSummaryLine(o) {
  return `• <code>${escapeHtml(o.id)}</code> — ${escapeHtml(STATUS_LABEL[o.status] || o.status)} — ${money(o.total)}`;
}

/** `/orders` — currently-open orders only, capped and oldest-first, mirroring the stock
    report's "live snapshot, not a full log" approach. Full history stays on the web admin. */
function sendOpenOrdersList(chatId, replyThreadId) {
  const rows = orders.listOpenOrders();
  if (!rows.length) {
    return post('sendMessage', {
      chat_id: chatId,
      message_thread_id: replyThreadId,
      text: '<b>Orders</b>\nNothing open right now.',
      parse_mode: 'HTML',
    });
  }
  const text = [`<b>Open orders</b> (${rows.length})`, ...rows.map(orderSummaryLine)].join('\n');
  return post('sendMessage', {
    chat_id: chatId,
    message_thread_id: replyThreadId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows.map((o) => [{ text: `Open ${o.id}`, callback_data: `order:${o.id}:view` }]) },
  });
}

/** Same CTCG-#### normalization the storefront's own order lookup uses. */
function normalizeOrderId(raw) {
  const digits = String(raw || '').trim().toUpperCase().replace(/^CTCG-?/, '');
  return digits ? `CTCG-${digits}` : '';
}

/** `/order <id>` — any status, read-only card once terminal, for pulling up a specific
    order (e.g. answering a customer) without browsing the open-orders list. */
function sendOrderLookup(chatId, replyThreadId, rawId) {
  if (!String(rawId || '').trim()) {
    return post('sendMessage', {
      chat_id: chatId,
      message_thread_id: replyThreadId,
      text: '<b>Orders</b>\nUsage: /order CTCG-1234',
      parse_mode: 'HTML',
    });
  }
  const id = normalizeOrderId(rawId);
  const order = id ? orders.findOrder(id) : null;
  if (!order) {
    return post('sendMessage', {
      chat_id: chatId,
      message_thread_id: replyThreadId,
      text: `<b>Orders</b>\nNo order found for "${escapeHtml(rawId)}".`,
      parse_mode: 'HTML',
    });
  }
  return post('sendMessage', {
    chat_id: chatId,
    message_thread_id: replyThreadId,
    text: buildMessage(order, orders.getOrderItems(id)),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildOrderKeyboard(order),
  });
}

// Guards against a rapid double-tap firing two concurrent mutations for the same order.
// handleUpdate's caller runs each update fire-and-forget (see startPolling below), so two
// callback_query updates arriving in the same getUpdates batch really can race each other.
const orderLocks = new Set();

/** Routes an `order:<id>:<action>` callback_data. Returns false if `cq` wasn't one of ours. */
async function handleOrderCallback(cq) {
  const m = /^order:([A-Za-z0-9-]+):(advance|cancel_ask|cancel_confirm|cancel_back|view)$/.exec(cq.data || '');
  if (!m) return false;
  const [, id, action] = m;

  if (!isFromAdminChat(cq.message.chat.id)) {
    await answerCallbackQuery(cq.id);
    return true;
  }

  if (action === 'view' || action === 'cancel_ask' || action === 'cancel_back') {
    const order = orders.findOrder(id);
    if (!order) {
      await answerCallbackQuery(cq.id, 'Order not found.', true);
      return true;
    }
    await answerCallbackQuery(cq.id);

    if (action === 'view') {
      await post('sendMessage', {
        chat_id: cq.message.chat.id,
        message_thread_id: cq.message.message_thread_id,
        text: buildMessage(order, orders.getOrderItems(id)),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildOrderKeyboard(order),
      });
    } else {
      await post('editMessageReplyMarkup', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: buildOrderKeyboard(order, action === 'cancel_ask' ? 'confirm_cancel' : 'default'),
      });
    }
    return true;
  }

  // Mutating actions from here: advance, cancel_confirm.
  if (orderLocks.has(id)) {
    await answerCallbackQuery(cq.id, 'Still processing, try again.', true);
    return true;
  }
  orderLocks.add(id);
  try {
    const result = orders.advanceOrderStatus(id, action === 'cancel_confirm' ? 'cancelled' : undefined);
    await answerCallbackQuery(cq.id, result.ok ? undefined : result.error, !result.ok);

    // Refresh the card either way — on failure this self-heals a stale keyboard back to
    // the true current state (e.g. someone already advanced it via the web admin).
    const current = result.ok ? result.order : orders.findOrder(id);
    if (current) {
      const items = result.ok ? result.items : orders.getOrderItems(id);
      await editOrderCard(cq.message.chat.id, cq.message.message_id, current, items);
    }
  } finally {
    orderLocks.delete(id);
  }
  return true;
}

async function handleUpdate(update) {
  const cq = update.callback_query;
  if (cq) {
    if (await handleOrderCallback(cq)) return;
    if (cq.data === 'stock_report') {
      await answerCallbackQuery(cq.id);
      if (isFromAdminChat(cq.message.chat.id)) await sendFullStockReport();
      return;
    }
    return;
  }

  const msg = update.message;
  const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text || !isFromAdminChat(msg.chat.id)) return;

  // Replies land wherever the command was typed, falling back to Sales — unlike /stock's
  // reply, which always targets its own topic regardless of where it was invoked.
  const replyThreadId = msg.message_thread_id || threadId('TELEGRAM_TOPIC_SALES');

  if (text === '/stock' || text.startsWith('/stock@')) {
    await sendFullStockReport();
  } else if (text === '/orders' || text.startsWith('/orders@')) {
    await sendOpenOrdersList(msg.chat.id, replyThreadId);
  } else if (/^\/order(@\w+)?(\s|$)/.test(text)) {
    const arg = text.replace(/^\/order(@\w+)?\s*/, '');
    await sendOrderLookup(msg.chat.id, replyThreadId, arg);
  }
}

let polling = false;
let pollAbortController = null;

/** Own fetch rather than post() — needs its own AbortController so stopPolling() can
    cut the in-flight long-poll short instead of leaving the process waiting on it. */
async function getUpdates(offset) {
  const controller = new AbortController();
  pollAbortController = controller;
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(`${API_ROOT}/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) {
      return { ok: false, reason: payload.description || `HTTP ${res.status}` };
    }
    return { ok: true, result: payload.result };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'aborted' : err.message };
  } finally {
    clearTimeout(timer);
    pollAbortController = null;
  }
}

/**
 * Long-polls for the "Full stock report" button tap and the /stock command. There's no
 * webhook (this app has no fixed public HTTPS URL when run locally), so this is what
 * lets the bot respond to anything instead of only ever sending. Running two instances
 * against the same bot token at once (e.g. a local dev server left open alongside
 * production) makes them race for the same updates — only run one at a time.
 */
async function startPolling() {
  if (!isConfigured() || polling) return;
  polling = true;

  // Defensive: getUpdates 409s if a webhook is set. This app has never called
  // setWebhook, but clearing it is cheap insurance against a stale one from elsewhere.
  await post('deleteWebhook', {}).catch(() => {});
  await post('setMyCommands', {
    commands: [
      { command: 'stock', description: 'Current out-of-stock report' },
      { command: 'orders', description: 'List open orders' },
      { command: 'order', description: 'Look up one order by ID' },
    ],
  }).catch(() => {});

  let offset = 0;
  while (polling) {
    const result = await getUpdates(offset);
    if (!polling) break;
    if (!result.ok) {
      console.error('[telegram] getUpdates failed:', result.reason);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const update of result.result || []) {
      offset = update.update_id + 1;
      handleUpdate(update).catch((err) => console.error('[telegram] update handling failed:', err.message));
    }
  }
}

function stopPolling() {
  polling = false;
  if (pollAbortController) pollAbortController.abort();
}

async function sendTest() {
  if (!isConfigured()) {
    return {
      ok: false,
      reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID are not set in .env',
    };
  }
  return post('sendMessage', {
    chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
    text: '<b>Crazed TCG</b>\nTest notification - your bot is wired up correctly.',
    parse_mode: 'HTML',
  });
}

module.exports = {
  notifyNewOrder,
  notifyOutOfStock,
  notifyRestock,
  sendTest,
  isConfigured,
  buildMessage,
  startPolling,
  stopPolling,
};
