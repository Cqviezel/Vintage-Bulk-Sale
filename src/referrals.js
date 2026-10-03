'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const REFERRAL_DISCOUNT = 10;
const REWARD_DISCOUNT = 10;
const REFERRAL_MAX_USES = 100;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const findPromo = db.prepare('SELECT * FROM promo_codes WHERE code = ?');
const codeExists = db.prepare('SELECT 1 FROM promo_codes WHERE code = ?');
const ownedReferral = db.prepare(
  "SELECT code FROM promo_codes WHERE kind = 'referral' AND owner_telegram_id = ?"
);
const insertPromo = db.prepare(
  `INSERT INTO promo_codes (code, type, value, active, max_uses, expires_at, min_subtotal, kind, owner_telegram_id)
   VALUES (@code, 'percent', @value, 1, @max_uses, NULL, 0, @kind, @owner)`
);
const refereeAlreadyRewarded = db.prepare(
  'SELECT 1 FROM referrals WHERE referrer_code = ? AND referee_telegram_id = ?'
);
const referralForOrder = db.prepare('SELECT * FROM referrals WHERE referred_order_id = ?');
const insertReferral = db.prepare(
  'INSERT INTO referrals (referred_order_id, referrer_code, referee_telegram_id, reward_code) VALUES (?, ?, ?, ?)'
);
const deleteReferral = db.prepare('DELETE FROM referrals WHERE referred_order_id = ?');
const deactivatePromo = db.prepare('UPDATE promo_codes SET active = 0 WHERE code = ?');
const usedByCustomer = db.prepare(
  "SELECT 1 FROM orders WHERE promo_code = ? AND telegram_user_id = ? AND status <> 'cancelled'"
);

function uniqueCode(prefix) {
  for (let attempt = 0; attempt < 25; attempt++) {
    let suffix = '';
    for (let i = 0; i < 7; i++) suffix += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const code = prefix + suffix;
    if (!codeExists.get(code)) return code;
  }
  throw new Error('Could not generate a unique promo code.');
}

function getOrCreateReferralCode(ownerId) {
  const existing = ownedReferral.get(ownerId);
  if (existing) return existing.code;
  const code = uniqueCode('R');
  insertPromo.run({ code, value: REFERRAL_DISCOUNT, max_uses: REFERRAL_MAX_USES, kind: 'referral', owner: ownerId });
  return code;
}

/** Null when `promo` may be used by `customerId` (0 = not logged in). */
function promoAccessError(promo, customerId) {
  if (!promo || promo.kind === 'manual') return null;
  if (!customerId) return 'Log in with Telegram to use this code.';
  if (promo.kind === 'reward' && promo.owner_telegram_id !== customerId) {
    return 'This code belongs to another Telegram account.';
  }
  if (promo.kind === 'referral') {
    if (promo.owner_telegram_id === customerId) return "You can't use your own referral code.";
    if (usedByCustomer.get(promo.code, customerId)) return 'You have already used this code.';
  }
  return null;
}

/**
 * Call once an order is marked paid. Returns the reward to announce, or null when the
 * order didn't use a referral code, was self-referred, or this referee was already rewarded.
 */
function rewardForPaidOrder(order) {
  const ref = order.promo_code ? findPromo.get(order.promo_code) : null;
  if (!ref || ref.kind !== 'referral' || !order.telegram_user_id) return null;
  if (ref.owner_telegram_id === order.telegram_user_id) return null;
  if (referralForOrder.get(order.id) || refereeAlreadyRewarded.get(ref.code, order.telegram_user_id)) return null;

  const rewardCode = uniqueCode('W');
  insertPromo.run({ code: rewardCode, value: REWARD_DISCOUNT, max_uses: 1, kind: 'reward', owner: ref.owner_telegram_id });
  insertReferral.run(order.id, ref.code, order.telegram_user_id, rewardCode);
  return { ownerId: ref.owner_telegram_id, code: rewardCode, value: REWARD_DISCOUNT };
}

/** Call when a paid order is cancelled: its reward can no longer be used. */
function revokeRewardForOrder(orderId) {
  const row = referralForOrder.get(orderId);
  if (!row) return;
  deactivatePromo.run(row.reward_code);
  deleteReferral.run(orderId);
}

module.exports = {
  REFERRAL_DISCOUNT,
  REWARD_DISCOUNT,
  getOrCreateReferralCode,
  promoAccessError,
  rewardForPaidOrder,
  revokeRewardForOrder,
};
