'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const orders = require('../orders');
const telegram = require('../telegram');

const router = express.Router();

const LOGIN_MAX_AGE_SECONDS = 24 * 60 * 60;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again shortly.' },
});

/**
 * Checks the payload from Telegram's Login Widget. The hash is an HMAC over the other
 * fields, keyed by SHA-256 of the bot token, so only Telegram can produce a valid one.
 * https://core.telegram.org/widgets/login#checking-authorization
 */
function verifyLoginPayload(data) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !data || typeof data.hash !== 'string' || !/^[0-9a-f]{64}$/.test(data.hash)) return null;

  const checkString = Object.keys(data)
    .filter((k) => k !== 'hash' && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');
  const secret = crypto.createHash('sha256').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(data.hash, 'hex'))) return null;

  const id = Number(data.id);
  const authDate = Number(data.auth_date);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!Number.isFinite(authDate) || now - authDate > LOGIN_MAX_AGE_SECONDS) return null;

  return {
    id,
    username: String(data.username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32),
    firstName: String(data.first_name || '').slice(0, 64),
  };
}

function publicCustomer(c) {
  return { id: c.id, username: c.username, firstName: c.firstName };
}

router.get('/me', (req, res) => {
  res.json({
    botId: telegram.getBotId(),
    botUsername: telegram.getBotUsername(),
    customer: req.session && req.session.customer ? publicCustomer(req.session.customer) : null,
  });
});

router.post('/login', loginLimiter, (req, res, next) => {
  const customer = verifyLoginPayload(req.body);
  if (!customer) return res.status(401).json({ error: 'Telegram login could not be verified. Please try again.' });

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.customer = customer;
    res.json({ customer: publicCustomer(customer) });
  });
});

router.post('/logout', (req, res, next) => {
  req.session.regenerate((err) => {
    if (err) return next(err);
    res.json({ ok: true });
  });
});

router.get('/orders', (req, res) => {
  if (!req.session || !req.session.customer) {
    return res.status(401).json({ error: 'Log in with Telegram to see your orders.' });
  }
  const rows = orders.listOrdersForCustomer(req.session.customer.id);
  res.json(
    rows.map((order) => ({
      id: order.id,
      status: order.status,
      delivery: order.delivery,
      subtotal: order.subtotal,
      discount: order.discount,
      promoCode: order.promo_code,
      fee: order.fee,
      total: order.total,
      createdAt: order.created_at,
      items: orders.getOrderItems(order.id).map((i) => ({
        name: i.name,
        set: i.set_name,
        number: i.number,
        condition: i.condition,
        variant: i.variant,
        price: i.price,
        image: i.image,
      })),
    }))
  );
});

module.exports = { router, verifyLoginPayload };
