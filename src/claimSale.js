'use strict';

/**
 * Reads a past Telegram claim sale back and works out which cards went unclaimed, so
 * the leftovers can be listed in the store.
 *
 * Runs on the userbot account (it can read channel history and comment threads, which
 * the Bot API cannot). Each channel post is one card: a photo (or album) with a caption
 * like "Togetic 16 Neo Genesis Holo\n$45". Its comments decide the outcome:
 *   - a buyer comment containing "claim" -> claimed (first one wins)
 *   - a buyer offer that the seller answers with "ok"/"okay"/"deal"... -> claimed
 *   - a seller counter that the buyer accepts ("ok", or "claim") -> claimed
 *   - anything else, including offers nobody agreed to -> leftover
 */

const { Api } = require('teleproto');
const { db } = require('./db');
const telegramUserbot = require('./telegramUserbot');
const pokemontcg = require('./pokemontcg');

// Claim sales run on Singapore time; a "sale date" means that calendar day there.
const SALE_TZ_OFFSET_HOURS = 8;

db.exec(`
  CREATE TABLE IF NOT EXISTS claim_imports (
    channel     TEXT NOT NULL,
    post_id     INTEGER NOT NULL,
    product_name TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel, post_id)
  )
`);
const importedPosts = db.prepare('SELECT post_id FROM claim_imports WHERE channel = ?');
const recordImport = db.prepare(
  'INSERT OR IGNORE INTO claim_imports (channel, post_id, product_name) VALUES (?, ?, ?)'
);

/* ------------------------------------------------------------- captions --- */

const VARIANT_WORDS = [
  [/\b(?:1st\s*ed(?:ition)?|first\s*edition)\b/i, '1st Edition'],
  [/\b(?:rh|rev(?:erse)?\s*holo|reverse)\b/i, 'Reverse Holo'],
  [/\bholo(?:foil)?\b/i, 'Holo'],
  [/\b(?:non[\s-]?holo|normal)\b/i, 'Normal'],
];
// "47", "016", "SV49", "TG05", "H12", "47/68", "#47"
const NUMBER_TOKEN = /^#?([A-Za-z]{0,4}\d{1,4}[a-z]?)(?:\/[A-Za-z]*\d+)?$/;

/** "Swampert 12 Supreme Victors RH\n$20" -> { name, number, set, variant, price }. */
function parseCaption(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const priceMatch = String(text || '').match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  const price = priceMatch ? Number(priceMatch[1]) : null;

  const title = (lines.find((l) => !/\$\s*\d/.test(l)) || lines[0] || '').replace(/\s+/g, ' ');
  let rest = title;
  let variant = '';
  for (const [re, label] of VARIANT_WORDS) {
    if (re.test(rest)) {
      variant = label;
      rest = rest.replace(re, ' ').replace(/\s+/g, ' ').trim();
      break;
    }
  }

  const tokens = rest.split(' ').filter(Boolean);
  // The first number-like token after the name splits "name" from "set".
  const at = tokens.findIndex((t, i) => i > 0 && NUMBER_TOKEN.test(t));
  if (at === -1) return { title, name: rest, number: '', set: '', variant: variant || 'Normal', price };
  return {
    title,
    name: tokens.slice(0, at).join(' '),
    number: tokens[at].match(NUMBER_TOKEN)[1],
    set: tokens.slice(at + 1).join(' '),
    variant: variant || 'Normal',
    price,
  };
}

/* -------------------------------------------------------------- outcome --- */

const CLAIM_WORD = /\bclaim(?:ing)?\b/i;
// Wording that makes a seller message with a number a counter offer rather than chat.
const COUNTER_WORD = /\b(?:can do|can go|lowest|best|final|how about|let go|for you)\b|\$\s*\d/i;
const ACCEPT_WORD = /\b(?:ok|okay|okie|okies|kk|deal|sure|done|yes|yep|yup|can|confirm(?:ed)?|accept(?:ed)?|sold|noted)\b/i;
const OFFER_WORD = /\b(?:offer|counter|nego|lower|less)\b|\$\s*\d|\b\d+(?:\.\d+)?\b/i;
const firstAmount = (text) => {
  const m = String(text).match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
};
const hasDigits = (text) => /\d/.test(text);

/**
 * comments: oldest first, each { id, text, isSeller, buyerId, buyerName, replyToId }.
 * Returns { status: 'claimed' | 'leftover', buyer, price, reason }.
 */
function decideOutcome(comments, listedPrice) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  let lastOffer = null; // most recent buyer offer: { buyerId, buyerName, price }
  let counter = null; // seller's latest counter: { buyerId, price }
  const offers = [];

  for (const c of comments) {
    const text = String(c.text || '').trim();
    if (!text) continue;

    if (c.isSeller) {
      const repliedTo = c.replyToId ? byId.get(c.replyToId) : null;
      const target = repliedTo && !repliedTo.isSeller ? repliedTo : null;
      // A plain "Okay" with no number accepts the offer it answers (or the last one).
      if (ACCEPT_WORD.test(text) && !hasDigits(text)) {
        const offer = target
          ? { buyerName: target.buyerName, price: firstAmount(target.text) }
          : lastOffer;
        if (offer) {
          return {
            status: 'claimed',
            buyer: offer.buyerName,
            price: offer.price ?? listedPrice,
            reason: `You accepted ${offer.buyerName}'s offer${offer.price != null ? ` of $${offer.price}` : ''}`,
          };
        }
        continue;
      }
      // A number only counts as a counter when it answers an offer or reads like one;
      // "There are MP copies sold for 20" is just chat.
      if (hasDigits(text) && (target || COUNTER_WORD.test(text))) {
        counter = {
          buyerId: target ? target.buyerId : lastOffer && lastOffer.buyerId,
          price: firstAmount(text),
        };
      }
      continue;
    }

    // Buyer comments.
    // "Is this claimed?" is a question, not a claim.
    if (CLAIM_WORD.test(text) && !text.includes('?')) {
      const agreed = counter && (counter.buyerId == null || counter.buyerId === c.buyerId) ? counter.price : null;
      return {
        status: 'claimed',
        buyer: c.buyerName,
        price: agreed ?? listedPrice,
        reason: agreed != null ? `${c.buyerName} claimed at your counter of $${agreed}` : `${c.buyerName} claimed`,
      };
    }
    if (counter && counter.buyerId === c.buyerId && ACCEPT_WORD.test(text) && !hasDigits(text)) {
      return {
        status: 'claimed',
        buyer: c.buyerName,
        price: counter.price ?? listedPrice,
        reason: `${c.buyerName} accepted your counter${counter.price != null ? ` of $${counter.price}` : ''}`,
      };
    }
    if (OFFER_WORD.test(text)) {
      lastOffer = { buyerId: c.buyerId, buyerName: c.buyerName, price: firstAmount(text) };
      offers.push(lastOffer);
    }
  }

  if (offers.length) {
    const last = offers[offers.length - 1];
    return {
      status: 'leftover',
      buyer: '',
      price: listedPrice,
      reason: `Offer from ${last.buyerName}${last.price != null ? ` ($${last.price})` : ''}, but no deal was agreed`,
    };
  }
  return {
    status: 'leftover',
    buyer: '',
    price: listedPrice,
    reason: comments.length ? 'Comments, but nobody claimed it' : 'No comments',
  };
}

/* --------------------------------------------------------- card matching --- */

const normSet = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const normNum = (n) => String(n || '').toLowerCase().replace(/^0+(?=\d)/, '');

/**
 * The official card for a caption, found by set + number so a typo in the name
 * ("Kangashan") still lands on the right card. Falls back to a name search.
 */
async function matchCard(parsed) {
  try {
    if (parsed.set && parsed.number) {
      const sets = await pokemontcg.listSets();
      const want = normSet(parsed.set);
      const set =
        sets.find((s) => normSet(s.name) === want) ||
        sets.find((s) => normSet(s.name).startsWith(want) || want.startsWith(normSet(s.name)));
      if (set) {
        const cards = await pokemontcg.listSetCards(set.id);
        const card = cards.find((c) => normNum(c.number) === normNum(parsed.number));
        if (card) {
          return {
            matched: true,
            name: card.name,
            set: set.name,
            setSymbol: set.symbol,
            number: card.number,
            image: card.image,
            artist: card.artist,
          };
        }
      }
    }
    const hit = await pokemontcg.lookup({ name: parsed.name, set: parsed.set, number: parsed.number });
    if (hit && hit.image && hit.confidence !== 'ambiguous' && hit.confidence !== 'name-only') {
      return {
        matched: true,
        name: hit.name,
        set: hit.set,
        setSymbol: '',
        number: hit.number,
        image: hit.image,
        artist: hit.artist,
      };
    }
  } catch (err) {
    console.error('[claim-sale] card lookup failed:', err.message);
  }
  return { matched: false, name: parsed.name, set: parsed.set, setSymbol: '', number: parsed.number, image: '', artist: '' };
}

/* --------------------------------------------------------------- telegram --- */

function dayBounds(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) throw Object.assign(new Error('Pick a sale date.'), { status: 400 });
  const startUtc = Date.UTC(+m[1], +m[2] - 1, +m[3]) - SALE_TZ_OFFSET_HOURS * 3600 * 1000;
  return { start: startUtc / 1000, end: startUtc / 1000 + 24 * 3600 };
}

function channelRef(value) {
  const v = String(value || '').trim();
  const fromUrl = v.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]+)/);
  return fromUrl ? '@' + fromUrl[1] : v.startsWith('@') || /^-?\d+$/.test(v) ? v : v ? '@' + v : '';
}

/** User IDs allowed to speak for the shop in the comments (admins of the chat). */
async function sellerUserIds(client, channel) {
  const ids = new Set();
  try {
    const me = await client.getMe();
    if (me) ids.add(String(me.id));
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
    const linkedId = full.fullChat && full.fullChat.linkedChatId;
    const group = linkedId && full.chats.find((ch) => String(ch.id) === String(linkedId));
    for (const target of [channel, group].filter(Boolean)) {
      try {
        const admins = await client.getParticipants(target, { filter: new Api.ChannelParticipantsAdmins() });
        for (const a of admins) ids.add(String(a.id));
      } catch {
        // Not allowed to list admins here; posts made as the channel still count.
      }
    }
  } catch (err) {
    console.error('[claim-sale] could not load admins:', err.message);
  }
  return ids;
}

const displayName = (entity) =>
  !entity
    ? 'Someone'
    : entity.title ||
      [entity.firstName, entity.lastName].filter(Boolean).join(' ') ||
      (entity.username ? '@' + entity.username : 'Someone');

/**
 * Scans one sale day. Returns every card post with its outcome; leftovers also carry
 * the matched official card so the admin can list them in one click.
 */
async function scanSale({ date, channelSetting }) {
  if (!telegramUserbot.isConfigured()) {
    throw Object.assign(new Error('The Telegram userbot is not set up on this server.'), { status: 400 });
  }
  const ref = channelRef(channelSetting);
  if (!ref) throw Object.assign(new Error('Set the Claim Sale Channel in Settings first.'), { status: 400 });

  const { start, end } = dayBounds(date);
  const client = await telegramUserbot.getClient();
  const channel = await telegramUserbot.resolveChat(client, ref);
  const sellers = await sellerUserIds(client, channel);

  // Newest first from the end of the day, stopping once we pass its start.
  const raw = [];
  for await (const msg of client.iterMessages(channel, { offsetDate: end, limit: 1000 })) {
    if (msg.date < start) break;
    raw.push(msg);
  }

  // Albums arrive as several messages sharing a groupedId; treat each album as one card.
  const groups = new Map();
  for (const msg of raw.reverse()) {
    if (!msg.media && !msg.message) continue;
    const key = msg.groupedId ? 'g' + String(msg.groupedId) : 'm' + msg.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(msg);
  }

  const already = new Set(importedPosts.all(ref).map((r) => r.post_id));
  const listings = [];

  for (const msgs of groups.values()) {
    const captionMsg = msgs.find((m) => m.message && m.message.trim()) || msgs[0];
    const parsed = parseCaption(captionMsg.message);
    if (parsed.price == null) continue; // not a card listing (announcements, rules...)

    const threadMsg = msgs.find((m) => m.replies && m.replies.replies > 0) || captionMsg;
    const comments = [];
    if (threadMsg.replies && threadMsg.replies.replies > 0) {
      for await (const c of client.iterMessages(channel, { replyTo: threadMsg.id, reverse: true, limit: 300 })) {
        const from = c.fromId;
        const userId = from && from.userId != null ? String(from.userId) : null;
        // Posting as the channel or anonymously as the group shows up as a channel peer.
        const isSeller = !userId || sellers.has(userId);
        comments.push({
          id: c.id,
          text: c.message || '',
          isSeller,
          buyerId: userId,
          buyerName: displayName(c.sender),
          replyToId: c.replyTo && c.replyTo.replyToMsgId,
        });
      }
    }

    const outcome = decideOutcome(comments, parsed.price);
    listings.push({
      postId: captionMsg.id,
      photoPostId: (msgs.find((m) => m.media) || captionMsg).id,
      postedAt: new Date(captionMsg.date * 1000).toISOString(),
      link: ref.startsWith('@') ? `https://t.me/${ref.slice(1)}/${captionMsg.id}` : '',
      caption: parsed.title,
      parsed,
      commentCount: comments.length,
      imported: already.has(captionMsg.id),
      ...outcome,
    });
  }

  // Official images only for the cards that might go into the store.
  const leftovers = listings.filter((l) => l.status === 'leftover');
  for (const l of leftovers) l.card = await matchCard(l.parsed);

  return { channel: ref, date, listings };
}

/** Saves the post's own photo to the uploads folder, for cards with no official match. */
async function savePostPhoto({ channelSetting, postId, uploadDir, processImage }) {
  const client = await telegramUserbot.getClient();
  const channel = await telegramUserbot.resolveChat(client, channelRef(channelSetting));
  const [msg] = await client.getMessages(channel, { ids: [Number(postId)] });
  if (!msg || !msg.media) return '';
  const buffer = await client.downloadMedia(msg, {});
  if (!buffer || !buffer.length) return '';
  const processed = await processImage(Buffer.from(buffer), 'image/jpeg');
  const filename = require('crypto').randomBytes(12).toString('hex') + '.jpg';
  await require('fs').promises.writeFile(require('path').join(uploadDir, filename), processed);
  return '/uploads/' + filename;
}

function markImported(channelSetting, postId, name) {
  recordImport.run(channelRef(channelSetting), Number(postId), String(name || ''));
}

module.exports = { scanSale, savePostPhoto, markImported, parseCaption, decideOutcome, matchCard, channelRef };
