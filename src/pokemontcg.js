'use strict';

/**
 * Server-side lookups against api.pokemontcg.io.
 *
 * Doing this on the server rather than the browser buys three things: the API key
 * stays secret, results are cached across imports, and we can throttle so a 300-row
 * CSV does not burn the daily quota in one burst.
 *
 * Quota: ~1,000 requests/day anonymous, ~20,000/day with a free key from
 * https://dev.pokemontcg.io. Set POKEMON_TCG_API_KEY in .env to raise it.
 */

const API = 'https://api.pokemontcg.io/v2/cards';

const cache = new Map();
const CACHE_MAX = 5000;

function cacheKey(name, set, number) {
  return `${name}|${set}|${number}`.toLowerCase();
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

/** "58/102" and "058" both mean card 58 to the API. */
function normaliseNumber(number) {
  const raw = String(number || '').trim();
  if (!raw) return '';
  const beforeSlash = raw.split('/')[0].trim();
  return beforeSlash.replace(/^0+(?=\d)/, '');
}

/** The "/102" half of "4/102" — the set's card count, which pins down the set. */
function setTotalFrom(number) {
  const parts = String(number || '').split('/');
  if (parts.length < 2) return null;
  const total = parseInt(parts[1].trim(), 10);
  return Number.isInteger(total) && total > 0 ? total : null;
}

/**
 * The API's set.name filter matches loosely: set.name:"Base" returns "Base Set 2"
 * ahead of "Base". Taking data[0] therefore puts the wrong art on a listing, so
 * candidates are scored and the best one wins.
 */
function scoreCandidate(card, { set, number }) {
  let score = 0;

  const cardSet = ((card.set && card.set.name) || '').toLowerCase();
  const wantSet = String(set || '').toLowerCase().trim();

  if (wantSet && cardSet === wantSet) score += 100;
  else if (wantSet && cardSet.startsWith(wantSet)) score += 20;

  // "4/102" says the set has 102 cards — a strong, unambiguous signal.
  const wantTotal = setTotalFrom(number);
  if (wantTotal && card.set && card.set.total === wantTotal) score += 80;
  else if (wantTotal && card.set && card.set.printedTotal === wantTotal) score += 80;

  const wantNumber = normaliseNumber(number);
  if (wantNumber && String(card.number || '').replace(/^0+(?=\d)/, '') === wantNumber) score += 40;

  return score;
}

function pickBest(cards, criteria) {
  let best = cards[0];
  let bestScore = scoreCandidate(cards[0], criteria);

  for (let i = 1; i < cards.length; i++) {
    const score = scoreCandidate(cards[i], criteria);
    if (score > bestScore) {
      best = cards[i];
      bestScore = score;
    }
  }
  return { card: best, score: bestScore, ambiguous: cards.length > 1 && bestScore === 0 };
}

function quote(value) {
  // The API's query language uses double quotes; strip any the user typed.
  return String(value || '').replace(/"/g, '').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * api.pokemontcg.io returns intermittent 502s under load. Without a retry those
 * show up as "no match" and silently cost the seller an image, so 5xx and network
 * errors get two more goes with backoff. 429 is never retried — that would make a
 * quota problem worse.
 */
async function request(query, signal, attempt = 0) {
  const headers = { Accept: 'application/json' };
  if (process.env.POKEMON_TCG_API_KEY) {
    headers['X-Api-Key'] = process.env.POKEMON_TCG_API_KEY;
  }

  const url = `${API}?pageSize=8&q=${encodeURIComponent(query)}`;

  let res;
  try {
    res = await fetch(url, { headers, signal });
  } catch (err) {
    if (attempt < 2) {
      await sleep(400 * (attempt + 1));
      return request(query, signal, attempt + 1);
    }
    throw err;
  }

  if (res.status === 429) throw Object.assign(new Error('rate limited'), { rateLimited: true });

  if (res.status >= 500) {
    if (attempt < 2) {
      await sleep(400 * (attempt + 1));
      return request(query, signal, attempt + 1);
    }
    throw new Error(`API ${res.status}`);
  }

  if (!res.ok) throw new Error(`API ${res.status}`);

  // A 200 with a non-JSON body happens when their CDN serves an error page.
  let json;
  try {
    json = await res.json();
  } catch {
    if (attempt < 2) {
      await sleep(400 * (attempt + 1));
      return request(query, signal, attempt + 1);
    }
    return [];
  }

  return Array.isArray(json.data) ? json.data : [];
}

function shape(card, confidence) {
  const prices = (card.tcgplayer && card.tcgplayer.prices) || {};
  const firstPrice = Object.values(prices)[0] || {};

  return {
    confidence,
    name: card.name,
    set: (card.set && card.set.name) || '',
    setId: (card.set && card.set.id) || '',
    number: card.number || '',
    printedTotal: (card.set && (card.set.printedTotal || card.set.total)) || null,
    image: (card.images && (card.images.large || card.images.small)) || '',
    marketPrice: typeof firstPrice.market === 'number' ? firstPrice.market : null,
  };
}

/**
 * Look a card up, widening the search until something matches.
 * Set names are the usual mismatch — a CSV says "Base Set", the API says "Base" —
 * so an exact miss falls back to name + number, then name alone.
 */
async function lookup({ name, set, number }, signal) {
  const cleanName = quote(name);
  if (!cleanName) return null;

  const cleanSet = quote(set);
  const cleanNumber = normaliseNumber(number);
  const key = cacheKey(cleanName, cleanSet, cleanNumber);

  if (cache.has(key)) return cache.get(key);

  const attempts = [];
  if (cleanSet && cleanNumber) {
    attempts.push({ q: `name:"${cleanName}" set.name:"${cleanSet}" number:"${cleanNumber}"`, confidence: 'exact' });
  }
  if (cleanNumber) {
    attempts.push({ q: `name:"${cleanName}" number:"${cleanNumber}"`, confidence: 'number' });
  }
  if (cleanSet) {
    attempts.push({ q: `name:"${cleanName}" set.name:"${cleanSet}"`, confidence: 'set' });
  }
  attempts.push({ q: `name:"${cleanName}"`, confidence: 'name-only' });

  const criteria = { set: cleanSet, number: String(number || '') };

  for (const attempt of attempts) {
    let cards;
    try {
      cards = await request(attempt.q, signal);
    } catch (err) {
      if (err.rateLimited) throw err;
      continue; // try the next, broader query
    }
    if (!cards.length) continue;

    const { card, score, ambiguous } = pickBest(cards, criteria);

    // Nothing corroborated the set, and there was more than one candidate:
    // say so rather than quietly guessing.
    const confidence = ambiguous ? 'ambiguous' : attempt.confidence;
    const result = shape(card, confidence);
    result.score = score;
    result.alternatives = cards.length - 1;
    return remember(key, result);
  }

  return remember(key, null);
}

/**
 * Resolve many rows with bounded concurrency. Stops early and reports if the API
 * starts rate limiting, so a big import degrades to "no images" instead of failing.
 */
async function lookupMany(rows, { concurrency = 4, onProgress } = {}) {
  const results = new Array(rows.length).fill(null);
  let cursor = 0;
  let rateLimited = false;
  let done = 0;

  async function worker() {
    while (cursor < rows.length && !rateLimited) {
      const index = cursor++;
      try {
        results[index] = await lookup(rows[index]);
      } catch (err) {
        if (err.rateLimited) rateLimited = true;
        results[index] = null;
      }
      done++;
      if (onProgress) onProgress(done, rows.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, () => worker())
  );

  return { results, rateLimited };
}

module.exports = { lookup, lookupMany, normaliseNumber, hasApiKey: () => Boolean(process.env.POKEMON_TCG_API_KEY) };
