'use strict';

/**
 * Turns unclaimed cards from Telegram claim sales into listings on the /leftovers page.
 *
 * Runs on the userbot account (it can read channel history and comment threads, which
 * the Bot API cannot). Each channel post is one card: a photo (or album) with a caption
 * like "Togetic 16 Neo Genesis Holo\n$45". Its comments decide the outcome:
 *   - a buyer comment containing "claim" -> claimed (first one wins)
 *   - a buyer offer that the seller answers with "ok"/"okay"/"deal"... -> claimed
 *   - a seller counter that the buyer accepts ("ok", or "claim") -> claimed
 *   - anything else, including offers nobody agreed to -> leftover
 *
 * autoRun() does this on a timer: once a post is a day old and still unclaimed it is
 * listed, and a card that gets claimed late on Telegram is pulled back off the site.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Api } = require('teleproto');
const { db, getSettings } = require('./db');
const telegramUserbot = require('./telegramUserbot');
const telegram = require('./telegram');
const pokemontcg = require('./pokemontcg');

// Claim sales run on Singapore time; a "sale date" means that calendar day there.
const SALE_TZ_OFFSET_HOURS = 8;
// How long a post stays open for claims before its card is listed.
const CLAIM_WINDOW_HOURS = 24;
// How far back the automatic job looks, both for new posts and for late claims.
const LOOKBACK_DAYS = 7;

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

// One row per card post we've reached a decision on, so each is handled once.
//   outcome: 'claimed' | 'listed' (on /leftovers) | 'pulled' (listed, then claimed late)
db.exec(`
  CREATE TABLE IF NOT EXISTS claim_posts (
    channel      TEXT NOT NULL,
    post_id      INTEGER NOT NULL,
    outcome      TEXT NOT NULL,
    product_id   TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL DEFAULT '',
    reply_count  INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel, post_id)
  )
`);
const postsForChannel = db.prepare('SELECT * FROM claim_posts WHERE channel = ?');
const savePost = db.prepare(
  `INSERT INTO claim_posts (channel, post_id, outcome, product_id, product_name, reply_count)
   VALUES (@channel, @post_id, @outcome, @product_id, @product_name, @reply_count)
   ON CONFLICT(channel, post_id) DO UPDATE SET outcome = excluded.outcome, product_id = excluded.product_id,
     product_name = excluded.product_name, reply_count = excluded.reply_count, updated_at = datetime('now')`
);
const insertLeftover = db.prepare(
  `INSERT INTO products (id, name, set_name, set_symbol, number, condition, variant, price, qty, status, image, notes, artist, channel, claim_sale, claim_link)
   VALUES (@id, @name, @set_name, @set_symbol, @number, @condition, @variant, @price, 1, 'live', @image, '', @artist, 'claim', @claim_sale, @claim_link)`
);
const productById = db.prepare('SELECT * FROM products WHERE id = ?');
const pullProduct = db.prepare(
  "UPDATE products SET status = 'hidden', updated_at = datetime('now') WHERE id = ? AND status = 'live'"
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

/** "2026-10-22" for a unix time, in sale (Singapore) time. */
function saleDate(unixSeconds) {
  return new Date((unixSeconds + SALE_TZ_OFFSET_HOURS * 3600) * 1000).toISOString().slice(0, 10);
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

async function openChannel(channelSetting) {
  if (!telegramUserbot.isConfigured()) {
    throw Object.assign(new Error('The Telegram userbot is not set up on this server.'), { status: 400 });
  }
  const ref = channelRef(channelSetting);
  if (!ref) throw Object.assign(new Error('Set the Claim Sale Channel in Settings first.'), { status: 400 });
  const client = await telegramUserbot.getClient();
  const channel = await telegramUserbot.resolveChat(client, ref);
  return { client, channel, ref };
}

/**
 * Every card post between two unix times, oldest first. Comments are not fetched
 * here (one request per post adds up), only each post's current comment count.
 */
async function listCardPosts({ client, channel, ref }, start, end) {
  const raw = [];
  for await (const msg of client.iterMessages(channel, { offsetDate: end, limit: 2000 })) {
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

  const posts = [];
  for (const msgs of groups.values()) {
    const captionMsg = msgs.find((m) => m.message && m.message.trim()) || msgs[0];
    const parsed = parseCaption(captionMsg.message);
    if (parsed.price == null) continue; // not a card listing (announcements, rules...)
    const threadMsg = msgs.find((m) => m.replies && m.replies.replies > 0) || captionMsg;
    posts.push({
      postId: captionMsg.id,
      threadId: threadMsg.id,
      photoPostId: (msgs.find((m) => m.media) || captionMsg).id,
      date: captionMsg.date,
      replyCount: (threadMsg.replies && threadMsg.replies.replies) || 0,
      link: ref.startsWith('@') ? `https://t.me/${ref.slice(1)}/${captionMsg.id}` : '',
      caption: parsed.title,
      parsed,
    });
  }
  return posts;
}

async function readOutcome({ client, channel }, post, sellers) {
  const comments = [];
  if (post.replyCount > 0) {
    for await (const c of client.iterMessages(channel, { replyTo: post.threadId, reverse: true, limit: 300 })) {
      const from = c.fromId;
      const userId = from && from.userId != null ? String(from.userId) : null;
      comments.push({
        id: c.id,
        text: c.message || '',
        // Posting as the channel or anonymously as the group shows up as a channel peer.
        isSeller: !userId || sellers.has(userId),
        buyerId: userId,
        buyerName: displayName(c.sender),
        replyToId: c.replyTo && c.replyTo.replyToMsgId,
      });
    }
  }
  return decideOutcome(comments, post.parsed.price);
}

/** Saves the post's own photo to the uploads folder, for cards with no official match. */
async function savePostPhoto({ client, channel }, postId) {
  try {
    const [msg] = await client.getMessages(channel, { ids: [Number(postId)] });
    if (!msg || !msg.media) return '';
    const buffer = await client.downloadMedia(msg, {});
    if (!buffer || !buffer.length) return '';
    const processed = await sharp(Buffer.from(buffer))
      .rotate()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const filename = crypto.randomBytes(12).toString('hex') + '.jpg';
    await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), processed);
    return '/uploads/' + filename;
  } catch (err) {
    console.error('[claim-sale] photo download failed:', err.message);
    return '';
  }
}

/** Puts one unclaimed card on /leftovers. Returns the new product id. */
async function listLeftover(conn, post, condition) {
  const card = await matchCard(post.parsed);
  // WOTC pictures may show a 1st Edition stamp; the store labels those cards Unlimited.
  const image = card.image || (await savePostPhoto(conn, post.photoPostId));
  const id = 'p' + crypto.randomBytes(8).toString('hex');
  insertLeftover.run({
    id,
    name: String(card.name || post.parsed.name).slice(0, 160),
    set_name: String(card.set || post.parsed.set).slice(0, 160),
    set_symbol: String(card.setSymbol || '').slice(0, 500),
    number: String(card.number || post.parsed.number).slice(0, 40),
    condition: ['NM', 'LP', 'MP', 'HP'].includes(condition) ? condition : 'NM',
    variant: post.parsed.variant,
    price: Math.round(Number(post.parsed.price) * 100) / 100,
    image,
    artist: String(card.artist || '').slice(0, 120),
    claim_sale: saleDate(post.date),
    claim_link: post.link,
  });
  return { id, name: card.name || post.parsed.name };
}

/* ------------------------------------------------------------ manual scan --- */

/** One sale day, every card and its outcome, for the admin Claim Leftovers tab. */
async function scanSale({ date }) {
  const settings = getSettings();
  const conn = await openChannel(settings.claimTelegram);
  const { start, end } = dayBounds(date);
  const sellers = await sellerUserIds(conn.client, conn.channel);
  const known = new Map(postsForChannel.all(conn.ref).map((r) => [r.post_id, r]));

  const posts = await listCardPosts(conn, start, end);
  const listings = [];
  for (const post of posts) {
    const outcome = await readOutcome(conn, post, sellers);
    const rec = known.get(post.postId);
    listings.push({
      ...post,
      ...outcome,
      onSite: rec ? rec.outcome : '',
    });
  }
  return { channel: conn.ref, date, listings };
}

/** Lists chosen posts now, from the admin tab, without waiting for the timer. */
async function listNow({ postIds }) {
  const settings = getSettings();
  const conn = await openChannel(settings.claimTelegram);
  const wanted = new Set(postIds.map(Number));
  const known = new Map(postsForChannel.all(conn.ref).map((r) => [r.post_id, r]));
  const now = Math.floor(Date.now() / 1000);
  const posts = await listCardPosts(conn, now - 60 * 86400, now);

  let listed = 0;
  for (const post of posts) {
    if (!wanted.has(post.postId) || known.has(post.postId)) continue;
    const product = await listLeftover(conn, post, settings.leftoverCondition);
    savePost.run({
      channel: conn.ref,
      post_id: post.postId,
      outcome: 'listed',
      product_id: product.id,
      product_name: product.name,
      reply_count: post.replyCount,
    });
    listed++;
  }
  return { listed };
}

/* ---------------------------------------------------------- automatic job --- */

let running = false;

/**
 * Lists every card post that is over a day old and still unclaimed, and pulls any
 * listed card that has since been claimed on Telegram. Safe to call repeatedly.
 */
async function autoRun() {
  const settings = getSettings();
  if (running || settings.autoLeftovers === 'off' || !telegramUserbot.isConfigured()) return null;
  if (!channelRef(settings.claimTelegram)) return null;
  running = true;
  const summary = { listed: [], pulled: [], claimed: 0 };
  try {
    const conn = await openChannel(settings.claimTelegram);
    const now = Math.floor(Date.now() / 1000);
    const posts = await listCardPosts(conn, now - LOOKBACK_DAYS * 86400, now);
    const known = new Map(postsForChannel.all(conn.ref).map((r) => [r.post_id, r]));
    let sellers = null;

    for (const post of posts) {
      const rec = known.get(post.postId);
      const old = now - post.date >= CLAIM_WINDOW_HOURS * 3600;

      if (!rec) {
        if (!old) continue; // still open for claims
        sellers = sellers || (await sellerUserIds(conn.client, conn.channel));
        const outcome = await readOutcome(conn, post, sellers);
        if (outcome.status === 'claimed') {
          savePost.run({ channel: conn.ref, post_id: post.postId, outcome: 'claimed', product_id: '', product_name: post.parsed.name, reply_count: post.replyCount });
          summary.claimed++;
        } else {
          const product = await listLeftover(conn, post, settings.leftoverCondition);
          savePost.run({ channel: conn.ref, post_id: post.postId, outcome: 'listed', product_id: product.id, product_name: product.name, reply_count: post.replyCount });
          summary.listed.push(product.name);
        }
        continue;
      }

      // Already listed: only re-read the comments when new ones have appeared.
      if (rec.outcome === 'listed' && post.replyCount > rec.reply_count) {
        sellers = sellers || (await sellerUserIds(conn.client, conn.channel));
        const outcome = await readOutcome(conn, post, sellers);
        if (outcome.status === 'claimed') {
          const product = productById.get(rec.product_id);
          const stillOnSale = product && product.status === 'live' && product.qty > 0;
          if (stillOnSale) pullProduct.run(rec.product_id);
          savePost.run({ ...rec, outcome: 'pulled', reply_count: post.replyCount });
          summary.pulled.push({ name: rec.product_name, buyer: outcome.buyer, wasOnSale: stillOnSale, link: post.link });
        } else {
          savePost.run({ ...rec, reply_count: post.replyCount });
        }
      }
    }
  } catch (err) {
    console.error('[claim-sale] automatic run failed:', err.message);
  } finally {
    running = false;
  }

  if (summary.listed.length || summary.pulled.length) {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const lines = [];
    if (summary.listed.length) {
      lines.push(`<b>${summary.listed.length} claim sale leftover${summary.listed.length === 1 ? '' : 's'} listed on /leftovers</b>`);
      lines.push(summary.listed.map(esc).join(', '));
    }
    for (const p of summary.pulled) {
      lines.push(
        p.wasOnSale
          ? `<b>Pulled from the site:</b> ${esc(p.name)} was claimed late on Telegram by ${esc(p.buyer)}.`
          : `<b>Check this:</b> ${esc(p.name)} was claimed late on Telegram by ${esc(p.buyer)}, but it had already sold or been reserved on the site.`
      );
    }
    telegram.notifyAdmin(lines.join('\n')).catch(() => {});
  }
  return summary;
}

let timer = null;
function startAutoRun({ everyHours = 3, firstDelayMinutes = 2 } = {}) {
  if (timer) return;
  setTimeout(() => autoRun().catch(() => {}), firstDelayMinutes * 60 * 1000);
  timer = setInterval(() => autoRun().catch(() => {}), everyHours * 3600 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  scanSale,
  listNow,
  autoRun,
  startAutoRun,
  parseCaption,
  decideOutcome,
  matchCard,
  channelRef,
  saleDate,
};
