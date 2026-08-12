'use strict';

const { db } = require('./db');

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

function buildMessage(order, items) {
  const lines = [
    '<b>New Crazed TCG order</b>',
    '',
    `<b>Order:</b> ${escapeHtml(order.id)}`,
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
  const left = product.qty <= 0 ? 'sold out' : `${product.qty} left`;
  return `• ${escapeHtml(product.name)}${detail} is ${left}.`;
}

// Same "1 or fewer" line public.js uses to decide a card needs an alert.
const REPORT_THRESHOLD = 1;

// A card leaves this query the moment it's restocked (qty rises and status is set back
// to 'live') or finalized (paid orders flip a sold-out card from 'reserved' to 'sold') —
// so the report always reflects what's still actionable right now, not a fixed log.
const stockReportRows = db.prepare(
  `SELECT name, set_name AS setName, qty FROM products
   WHERE (status = 'live' AND qty <= ?) OR (status = 'reserved' AND qty <= 0)
   ORDER BY qty ASC, name COLLATE NOCASE`
);

function currentStockAlerts() {
  return stockReportRows.all(REPORT_THRESHOLD).map((r) => ({ name: r.name, set: r.setName, qty: r.qty }));
}

const STOCK_REPORT_BUTTON = {
  inline_keyboard: [[{ text: '📋 Full stock report', callback_data: 'stock_report' }]],
};

/**
 * Out-of-stock and low-stock always go to their own topics — same rule whether this is
 * one order's worth of alerts or the full current report, so tapping the report button
 * from Low Stock doesn't dump out-of-stock cards into that topic too.
 */
async function sendStockGroups(products) {
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  if (!products.length) {
    return post('sendMessage', {
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      text: '<b>Stock report</b>\nNothing low or out of stock right now.',
      parse_mode: 'HTML',
      reply_markup: STOCK_REPORT_BUTTON,
    });
  }

  const outOfStock = products.filter((p) => p.qty <= 0);
  const lowStock = products.filter((p) => p.qty > 0);

  const groups = [
    outOfStock.length && ['Out of stock', outOfStock, 'TELEGRAM_TOPIC_OUT_OF_STOCK'],
    lowStock.length && ['Low stock', lowStock, 'TELEGRAM_TOPIC_LOW_STOCK'],
  ].filter(Boolean);

  const results = [];
  for (const [label, group, topicEnvVar] of groups) {
    const text = [`<b>${label}</b> (${group.length})`, ...group.map(stockLine)].join('\n');
    const result = await post('sendMessage', {
      chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
      message_thread_id: threadId(topicEnvVar),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: STOCK_REPORT_BUTTON,
    });
    if (!result.ok) {
      console.error(`[telegram] ${label.toLowerCase()} message failed: ${result.reason}`);
    }
    results.push(result);
  }
  return results;
}

/**
 * One order can push several different cards to 0 or 1 left at once (e.g. a big cart
 * of singles that each happened to be the last copy) — sending a Telegram message per
 * card floods the topic. This sends at most two: one roll-up for everything now sold
 * out, one for everything now down to its last copy. Each carries a button that pulls
 * the full current picture, since restocked cards drop off this snapshot as time passes.
 */
function notifyStockAlerts(products) {
  if (!products.length) return Promise.resolve({ ok: true });
  return sendStockGroups(products);
}

function answerCallbackQuery(id) {
  return post('answerCallbackQuery', { callback_query_id: id });
}

// Only the configured shop chat gets a reply — otherwise anyone who can message this
// bot (a stray DM, or it sitting in an unrelated group) could pull the full inventory.
function isFromAdminChat(chatId) {
  return String(chatId) === String(process.env.TELEGRAM_ADMIN_CHAT_ID);
}

async function handleUpdate(update) {
  const cq = update.callback_query;
  if (cq && cq.data === 'stock_report') {
    await answerCallbackQuery(cq.id);
    if (isFromAdminChat(cq.message.chat.id)) await sendStockGroups(currentStockAlerts());
    return;
  }

  const msg = update.message;
  const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
  if ((text === '/stock' || text.startsWith('/stock@')) && isFromAdminChat(msg.chat.id)) {
    await sendStockGroups(currentStockAlerts());
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
  await post('setMyCommands', { commands: [{ command: 'stock', description: 'Current low/out-of-stock report' }] }).catch(() => {});

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
  notifyStockAlerts,
  sendTest,
  isConfigured,
  buildMessage,
  startPolling,
  stopPolling,
};
