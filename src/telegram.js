'use strict';

const { db } = require('./db');

const API_ROOT = 'https://api.telegram.org';

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID);
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

/** "Normal" is the overwhelming default — only call it out when it's not. */
function conditionTag(item) {
  return item.variant && item.variant !== 'Normal' ? `${item.condition}, ${item.variant}` : item.condition;
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
    const tag = conditionTag(item);
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
    return { ok: true };
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

  const body = {
    chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
    text: buildMessage(order, items),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (process.env.TELEGRAM_ORDERS_THREAD_ID) {
    body.message_thread_id = Number(process.env.TELEGRAM_ORDERS_THREAD_ID);
  }

  const result = await post('sendMessage', body);

  if (result.ok) {
    markNotified.run('sent', '', order.id);
  } else {
    markNotified.run('failed', String(result.reason).slice(0, 400), order.id);
    console.error(`[telegram] order ${order.id} notification failed: ${result.reason}`);
  }
  return result;
}

async function sendStockBatch(products, title, threadId) {
  if (!products.length) return { ok: true };

  const lines = [`<b>${title}</b>`, ''];
  for (const product of products) {
    const left = product.qty <= 0 ? 'sold out' : `${product.qty} left`;
    const detail = product.set ? ` — ${escapeHtml(product.set)}` : '';
    const tag = conditionTag(product);
    lines.push(`• ${escapeHtml(product.name)}${detail} [${escapeHtml(tag)}] is ${left}.`);
  }

  const body = {
    chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (threadId) body.message_thread_id = Number(threadId);

  const result = await post('sendMessage', body);

  if (!result.ok) {
    const count = `${products.length} item${products.length === 1 ? '' : 's'}`;
    console.error(`[telegram] ${title.toLowerCase()} alert (${count}) failed: ${result.reason}`);
  }
  return result;
}

/**
 * Fired right after an order pushes one or more cards to 0 or 1 left, so they can be
 * pulled/relisted. Products still in stock ("N left") and products at zero ("sold out")
 * are sent as separate batched messages, so each can be routed to its own Telegram topic.
 */
async function notifyLowStock(products) {
  if (!products || !products.length) return { ok: true };
  if (!isConfigured()) return { ok: false, reason: 'not configured' };

  const low = products.filter((p) => p.qty > 0);
  const out = products.filter((p) => p.qty <= 0);

  const [lowResult, outResult] = await Promise.all([
    sendStockBatch(low, 'Low stock', process.env.TELEGRAM_LOWSTOCK_THREAD_ID),
    sendStockBatch(out, 'Out of stock', process.env.TELEGRAM_OUTOFSTOCK_THREAD_ID),
  ]);

  if (!lowResult.ok) return lowResult;
  if (!outResult.ok) return outResult;
  return { ok: true };
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

module.exports = { notifyNewOrder, notifyLowStock, sendTest, isConfigured, buildMessage };
