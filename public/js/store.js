'use strict';

/* Crazed TCG storefront. All inventory, pricing and orders come from the server;
   the only thing kept in this browser is the shopper's own cart. */

const LOGO = '/img/logo-460.jpg';
const CART_KEY = 'ctcg_cart_v3';
const CART_KEY_LEGACY = 'ctcg_cart_v2'; // pre-quantity cart shape: a plain array of ids

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// /leftovers serves this same page with <body data-store="leftovers">.
const STORE_MODE = document.body.dataset.store === 'leftovers' ? 'leftovers' : 'main';

// Every live card (the cart needs all of them, whichever page they were added on)...
let products = [];
// ...and just the ones this page shows: main-shop cards, or claim sale leftovers.
let catalog = [];
let settings = { mailing: 0, minimum: 0, telegram: '', paynow: '' };
let tradeShows = [];
let cart = new Map(loadCart()); // id -> quantity
let appliedPromo = null; // { code, discount } — cleared whenever the cart contents change

const CONDITION_NAMES = { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played' };

const PRICE_RANGES = [
  { value: 'u5', label: 'Under $5', min: 0, max: 5 },
  { value: '5-20', label: '$5 to $20', min: 5, max: 20 },
  { value: '20-50', label: '$20 to $50', min: 20, max: 50 },
  { value: '50+', label: '$50 and up', min: 50, max: Infinity },
];
const inPriceRange = (price, value) => {
  const r = PRICE_RANGES.find((x) => x.value === value);
  return !r || (price >= r.min && price < r.max);
};

const PAGE_SIZE = 24;
let currentPage = 1;

/**
 * English-set eras, oldest first, sets within each era in release order.
 * Matches the official set names used by the Pokémon TCG API (what "Add by Set"
 * writes into each product's `set` field). Anything not found here — a typo, a
 * hand-entered set, a promo — just falls into a trailing "Other Sets" group
 * instead of being dropped, so browsing never silently loses a card.
 */
const SET_ERAS = [
  { label: 'Base Era', sets: ['Base', 'Jungle', 'Fossil', 'Base Set 2', 'Team Rocket'] },
  { label: 'Gym Series', sets: ['Gym Heroes', 'Gym Challenge'] },
  { label: 'Neo Series', sets: ['Neo Genesis', 'Neo Discovery', 'Neo Revelation', 'Neo Destiny'] },
  { label: 'Legendary Collection', sets: ['Legendary Collection'] },
  { label: 'e-Card Series', sets: ['Expedition Base Set', 'Aquapolis', 'Skyridge'] },
  {
    label: 'EX Series',
    sets: [
      'EX Ruby & Sapphire', 'EX Sandstorm', 'EX Dragon', 'EX Team Magma vs Team Aqua',
      'EX Hidden Legends', 'EX FireRed & LeafGreen', 'EX Team Rocket Returns', 'EX Deoxys',
      'EX Emerald', 'EX Unseen Forces', 'EX Delta Species', 'EX Legend Maker',
      'EX Holon Phantoms', 'EX Crystal Guardians', 'EX Dragon Frontiers', 'EX Power Keepers',
    ],
  },
  {
    label: 'Diamond & Pearl Series',
    sets: [
      'Diamond & Pearl', 'Mysterious Treasures', 'Secret Wonders', 'Great Encounters',
      'Majestic Dawn', 'Legends Awakened', 'Stormfront',
    ],
  },
  { label: 'Platinum Series', sets: ['Platinum', 'Rising Rivals', 'Supreme Victors', 'Arceus'] },
  {
    label: 'HeartGold & SoulSilver Series',
    sets: ['HeartGold & SoulSilver', 'HS—Unleashed', 'HS—Undaunted', 'HS—Triumphant', 'Call of Legends'],
  },
  {
    label: 'Black & White Series',
    sets: [
      'Black & White', 'Emerging Powers', 'Noble Victories', 'Next Destinies', 'Dark Explorers',
      'Dragons Exalted', 'Boundaries Crossed', 'Plasma Storm', 'Plasma Freeze', 'Plasma Blast',
      'Legendary Treasures',
    ],
  },
  {
    label: 'XY Series',
    sets: [
      'XY', 'Flashfire', 'Furious Fists', 'Phantom Forces', 'Primal Clash', 'Roaring Skies',
      'Ancient Origins', 'BREAKthrough', 'BREAKpoint', 'Generations', 'Fates Collide',
      'Steam Siege', 'Evolutions',
    ],
  },
  {
    label: 'Sun & Moon Series',
    sets: [
      'Sun & Moon', 'Guardians Rising', 'Burning Shadows', 'Shining Legends', 'Crimson Invasion',
      'Ultra Prism', 'Forbidden Light', 'Celestial Storm', 'Dragon Majesty', 'Lost Thunder',
      'Team Up', 'Detective Pikachu', 'Unbroken Bonds', 'Unified Minds', 'Hidden Fates',
      'Cosmic Eclipse',
    ],
  },
  {
    label: 'Sword & Shield Series',
    sets: [
      'Sword & Shield', 'Rebel Clash', 'Darkness Ablaze', "Champion's Path", 'Vivid Voltage',
      'Shining Fates', 'Battle Styles', 'Chilling Reign', 'Evolving Skies', 'Celebrations',
      'Fusion Strike', 'Brilliant Stars', 'Astral Radiance', 'Pokémon GO', 'Lost Origin',
      'Silver Tempest', 'Crown Zenith',
    ],
  },
  {
    label: 'Scarlet & Violet Series',
    sets: [
      'Scarlet & Violet', 'Paldea Evolved', 'Obsidian Flames', '151', 'Paradox Rift',
      'Paldean Fates', 'Temporal Forces', 'Twilight Masquerade', 'Shrouded Fable',
      'Stellar Crown', 'Surging Sparks', 'Prismatic Evolutions', 'Journey Together',
    ],
  },
];

// Wizards of the Coast era sets. Their reference pictures are often 1st Edition scans,
// so any copy not listed as 1st Edition is labelled Unlimited for buyers.
const WOTC_SETS = new Set([
  ...SET_ERAS.slice(0, 5).flatMap((era) => era.sets),
  'Southern Islands',
  'Wizards Black Star Promos',
]);
const isUnlimitedWotc = (p) => WOTC_SETS.has(p.set) && p.variant !== '1st Edition';

const SET_ERA_LOOKUP = new Map();
SET_ERAS.forEach((era) => era.sets.forEach((name, i) => SET_ERA_LOOKUP.set(name, { era, order: i })));

/** Groups the sets actually in stock by era, in release order; unknown sets land in "Other Sets". */
function groupSetsByEra(sets) {
  const present = new Set(sets);
  const groups = SET_ERAS.map((era) => ({
    label: era.label,
    sets: era.sets.filter((s) => present.has(s)),
  })).filter((g) => g.sets.length);

  const other = sets.filter((s) => !SET_ERA_LOOKUP.has(s)).sort();
  if (other.length) groups.push({ label: 'Other Sets', sets: other });

  return groups;
}

/* ------------------------------------------------------------- helpers --- */

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

/** Everything rendered into innerHTML goes through this first. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', Boolean(isError));
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), isError ? 4200 : 2000);
}

/** Returns [[id, qty], ...] pairs. Falls back to the pre-quantity cart (a plain array
    of ids) and migrates each to qty 1, so upgrading this file doesn't wipe carts that
    were saved before quantities existed. */
function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || 'null');
    if (Array.isArray(raw)) {
      return raw
        .filter((e) => e && typeof e.id === 'string' && Number.isInteger(e.qty) && e.qty > 0)
        .map((e) => [e.id, e.qty]);
    }
    const old = JSON.parse(localStorage.getItem(CART_KEY_LEGACY) || '[]');
    return Array.isArray(old) ? old.filter((id) => typeof id === 'string').map((id) => [id, 1]) : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...cart].map(([id, qty]) => ({ id, qty }))));
  } catch { /* private browsing, ignore */ }
}

async function api(url, options) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* -------------------------------------------------------------- loading --- */

async function load() {
  try {
    const [productData, settingData] = await Promise.all([
      api('/api/products'),
      api('/api/settings'),
    ]);
    products = productData;
    catalog = products.filter((p) => (p.channel === 'claim') === (STORE_MODE === 'leftovers'));
    settings = settingData;

    // Drop anything that sold out, and lower any line that now exceeds current stock,
    // while this tab was idle.
    const live = new Map(products.map((p) => [p.id, p.qty]));
    let dropped = 0;
    let reduced = 0;
    for (const [id, qty] of [...cart]) {
      const stock = live.get(id);
      if (stock === undefined) {
        cart.delete(id);
        dropped++;
      } else if (qty > stock) {
        cart.set(id, stock);
        reduced++;
      }
    }
    if (dropped || reduced) {
      saveCart();
      const parts = [];
      if (dropped) parts.push(`${dropped} card${dropped === 1 ? ' was' : 's were'} sold and removed from your cart`);
      if (reduced) parts.push(`${reduced} card${reduced === 1 ? "'s quantity was" : "s' quantities were"} lowered to match stock`);
      toast(parts.join('; ') + '.', true);
    }

    renderSetOptions();
    renderProducts();
    renderCart();
    renderHero();
    renderLeftoversPromo();
    wireTelegramLinks();
    if (STORE_MODE === 'main' && location.hash === '#latest') {
      history.replaceState(null, '', location.pathname + location.search);
      goToLatestDrop({ preventDefault() {} });
    }
  } catch (err) {
    $('#productGrid').innerHTML =
      `<div class="empty">Could not load the catalogue.<br><span class="small">${esc(err.message)}</span></div>`;
  }

  // Non-critical: a failed fetch here shouldn't block the catalogue from loading.
  try {
    tradeShows = await api('/api/trade-shows');
  } catch {
    tradeShows = [];
  }
  renderTradeShows();
}

/* ------------------------------------------------------------ rendering --- */

/** Live stock count in the hero, plus the "Just added" rail (main shop only). */
function renderHero() {
  const count = catalog.reduce((n, p) => n + (Number(p.qty) || 0), 0);
  const chip = $('#heroStock');
  if (chip && count) {
    chip.textContent = STORE_MODE === 'leftovers'
      ? `${count.toLocaleString()} leftover card${count === 1 ? '' : 's'} available`
      : `${count.toLocaleString()} cards in stock now`;
    chip.hidden = false;
  }


  const fresh = catalog
    .filter((p) => p.image)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 12);
  $('#newSection').classList.toggle('hidden', fresh.length < 4 || STORE_MODE === 'leftovers');
  $('#newRail').innerHTML = fresh
    .map(
      (p) => `<button type="button" class="new-card" data-rail-view="${esc(p.id)}">
        <span class="new-card-img"><img src="${esc(p.image)}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='${LOGO}'"></span>
        <span class="new-card-name">${esc(p.name)}</span>
        <span class="new-card-meta">${esc(p.set)}${p.condition ? ' · ' + esc(p.condition) : ''}</span>
        <span class="new-card-price">${money(p.price)}</span>
      </button>`
    )
    .join('');
  $$('#newRail [data-rail-view]').forEach((b) => (b.onclick = () => openQuickView(b.dataset.railView)));
  updateRailArrows();
}

// Cached so the search box below can re-filter without recomputing groups from
// `products` on every keystroke — refreshed each time renderSetOptions() runs.
let browseSetGroups = [];
// One symbol URL per set name, for the Browse Sets dropdown — first product carrying
// a given set wins, so a handful of older listings without one don't blank it out.
let setSymbolByName = new Map();

function renderSetOptions() {
  const sets = [...new Set(catalog.map((p) => p.set).filter(Boolean))];
  browseSetGroups = groupSetsByEra(sets);
  setSymbolByName = new Map();
  for (const p of catalog) {
    if (p.set && p.setSymbol && !setSymbolByName.has(p.set)) setSymbolByName.set(p.set, p.setSymbol);
  }
  const current = $('#storeSet').value;

  $('#storeSet').innerHTML =
    '<option value="">All sets</option>' +
    browseSetGroups
      .map(
        (g) =>
          `<optgroup label="${esc(g.label)}">${g.sets
            .map((s) => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`)
            .join('')}</optgroup>`
      )
      .join('');

  $('#browseSetsSearch').value = '';
  renderBrowseSetsList(browseSetGroups);
}

/** Renders (and rebinds) just the button list inside the Browse Sets dropdown, so the
    search box above it can filter without touching the rest of the panel. Browsing
    (no query) collapses each era behind a tap so a buyer isn't handed the full flat
    list at once; a search result is already narrow, so it stays a flat list. */
function renderBrowseSetsList(groups) {
  const current = $('#storeSet').value;
  const hasQuery = $('#browseSetsSearch').value.trim() !== '';

  const setButton = (s) => {
    const symbol = setSymbolByName.get(s);
    const icon = symbol ? `<img class="set-icon" src="${esc(symbol)}" alt="" loading="lazy">` : '';
    return `<button role="menuitem" data-set="${esc(s)}"${s === current ? ' class="active"' : ''}>${icon}${esc(s)}</button>`;
  };

  let body;
  if (hasQuery) {
    body =
      groups.map((g) => `<div class="menu-era" role="presentation">${esc(g.label)}</div>` + g.sets.map(setButton).join('')).join('') ||
      '<div class="menu-empty">No sets match.</div>';
  } else {
    const singleGroup = groups.length === 1;
    body =
      groups
        .map(
          (g) =>
            `<details class="menu-era-group" name="browseSetsEra"${singleGroup ? ' open' : ''}>` +
            `<summary>${esc(g.label)}</summary>` +
            `<div class="menu-era-sets">${g.sets.map(setButton).join('')}</div>` +
            `</details>`
        )
        .join('') || '<div class="menu-empty">No sets match.</div>';
  }

  $('#browseSetsList').innerHTML =
    (hasQuery ? '' : `<button role="menuitem" data-set=""${current === '' ? ' class="active"' : ''}>All Sets</button>`) + body;

  $$('#browseSetsList button[data-set]').forEach((btn) => {
    btn.onclick = () => {
      $('#storeSet').value = btn.dataset.set;
      currentPage = 1;
      renderProducts();
      renderSetOptions();
      closeBrowseSetsMenu();
      $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
}

$('#browseSetsSearch').addEventListener('input', () => {
  const q = $('#browseSetsSearch').value.trim().toLowerCase();
  if (!q) {
    renderBrowseSetsList(browseSetGroups);
    return;
  }
  const filtered = browseSetGroups
    .map((g) => ({ label: g.label, sets: g.sets.filter((s) => `${g.label} ${s}`.toLowerCase().includes(q)) }))
    .filter((g) => g.sets.length);
  renderBrowseSetsList(filtered);
});

const SHOW_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-16" -> { y, m, d } for compact date-badge formatting. */
function parseIsoDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function formatShowDate(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const mon = SHOW_MONTHS[start.m - 1] || '';
  if (!endDate || endDate === startDate) return { mon, day: String(start.d) };

  const end = parseIsoDate(endDate);
  if (end.y === start.y && end.m === start.m) return { mon, day: `${start.d}–${end.d}` };
  return { mon, day: `${start.d}–${SHOW_MONTHS[end.m - 1] || ''} ${end.d}` };
}

const SHOW_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sat 14 – Sun 15 Nov 2026" (or a single day). Dates are calendar dates, no time zone. */
function showDayRange(startDate, endDate) {
  const dayOf = (iso) => {
    const { y, m, d } = parseIsoDate(iso);
    return { y, m, d, wd: SHOW_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
  };
  const a = dayOf(startDate);
  if (!endDate || endDate === startDate) return `${a.wd} ${a.d} ${SHOW_MONTHS[a.m - 1]} ${a.y}`;
  const b = dayOf(endDate);
  const sameMonth = a.y === b.y && a.m === b.m;
  return `${a.wd} ${a.d}${sameMonth ? '' : ' ' + SHOW_MONTHS[a.m - 1]} – ${b.wd} ${b.d} ${SHOW_MONTHS[b.m - 1]} ${b.y}`;
}

function renderTradeShows() {
  const section = $('#showsSection');
  if (!tradeShows.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  // Today in Singapore, as YYYY-MM-DD, to flag the show that's on now.
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const pin = '<svg class="i i-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const cal = '<svg class="i i-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
  const table = '<svg class="i i-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h18M5 9v11M19 9v11M3 5h18v4H3z"/></svg>';

  $('#showsRow').innerHTML = tradeShows
    .map((s, i) => {
      const { mon, day } = formatShowDate(s.startDate, s.endDate);
      const live = s.startDate <= today && (s.endDate || s.startDate) >= today;
      const badge = live ? '<span class="show-badge live">Happening Now</span>' : i === 0 ? '<span class="show-badge">Next Up</span>' : '';
      const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.location, 'Singapore'].filter(Boolean).join(', '))}`;
      return `
      <article class="show-card${live ? ' is-live' : ''}">
        <div class="show-date" aria-hidden="true"><span class="mon">${esc(mon)}</span><span class="day">${esc(day)}</span></div>
        <div class="show-body">
          ${badge}
          <h3>${esc(s.venue)}</h3>
          <ul class="show-facts">
            <li>${cal}${esc(showDayRange(s.startDate, s.endDate))}</li>
            ${s.location ? `<li>${pin}${esc(s.location)}</li>` : ''}
            ${s.tableNo ? `<li>${table}Find us at <b>${esc(s.tableNo)}</b></li>` : ''}
          </ul>
          ${s.location ? `<a class="show-link" href="${esc(maps)}" target="_blank" rel="noopener">Get Directions &rarr;</a>` : ''}
        </div>
      </article>`;
    })
    .join('');
}

/** Shared +/- control used on grid cards, quick view, and the cart drawer — one markup
    source so the three don't drift out of sync. Only used when there's actually a
    range to adjust (stock >= 2) — see inCartHtml() for the single-copy case, where a
    stepper with a permanently-maxed "+" would just be confusing. */
function stepperHtml(id, cartQty, stock) {
  return `<div class="qty-stepper" data-stepper="${esc(id)}">
      <button type="button" class="qty-btn" data-step="-1" aria-label="Decrease quantity">&minus;</button>
      <span class="qty-value">${cartQty}</span>
      <button type="button" class="qty-btn" data-step="1" aria-label="Increase quantity"${cartQty >= stock ? ' disabled' : ''}>+</button>
    </div>`;
}

/** A listing with only 1 in stock can never go above qty 1, so there's nothing to
    step — this is the pre-quantity "✓ Added" toggle instead, tapping it removes. */
function inCartHtml(id) {
  return `<button class="add added" data-remove="${esc(id)}">&check; Added</button>`;
}

/** Picks between the two above based on whether stepping actually means anything. */
function cartControlHtml(id, cartQty, stock) {
  return stock <= 1 ? inCartHtml(id) : stepperHtml(id, cartQty, stock);
}

/** Binds every stepper's +/- buttons within `root` (a freshly-rendered container). */
function wireQtySteppers(root) {
  root.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.closest('[data-stepper]').dataset.stepper;
      (b.dataset.step === '1' ? incrementQty : decrementQty)(id);
    };
  });
}

function renderProducts() {
  const q = $('#storeSearch').value.trim().toLowerCase();
  const set = $('#storeSet').value;
  const sort = $('#storePrice').value;
  const condition = $('#storeCondition').value;
  const variant = $('#storeVariant').value;
  const priceRange = $('#storePriceRange').value;
  const sale = $('#storeSale').value;

  const list = catalog.filter(
    (p) =>
      (!q || `${p.name} ${p.set} ${p.number} ${p.artist || ''}`.toLowerCase().includes(q)) &&
      (!set || p.set === set) &&
      (!condition || p.condition === condition) &&
      (!variant || p.variant === variant) &&
      inPriceRange(Number(p.price), priceRange) &&
      (!sale || p.claimSale === sale)
  );

  if (sort === 'asc') list.sort((a, b) => a.price - b.price);
  if (sort === 'desc') list.sort((a, b) => b.price - a.price);
  if (sort === 'new') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $('#resultCount').textContent = `${list.length.toLocaleString()} card${list.length === 1 ? '' : 's'}`;

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageItems = list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  $('#productGrid').removeAttribute('aria-busy');
  $('#productGrid').innerHTML = pageItems.length
    ? pageItems
        .map((p) => {
          const cartQty = cart.get(p.id) || 0;
          return `
      <article class="product" data-view="${esc(p.id)}">
        <div class="product-image${p.variant && p.variant !== 'Normal' ? ' variant' : ''}" role="button" tabindex="0" aria-label="View details for ${esc(p.name)}">
          <img src="${esc(p.image || LOGO)}" alt="${esc(p.name)}" loading="lazy"
               onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='${LOGO}'">
        </div>
        <div class="product-body">
          <div class="meta">${p.setSymbol ? `<img class="set-icon" src="${esc(p.setSymbol)}" alt="" loading="lazy">` : ''}${esc(p.set)}${p.number ? ' &middot; ' + esc(p.number) : ''}</div>
          <h3>${esc(p.name)}</h3>
          <div class="tags">
            ${p.channel === 'claim'
              ? `<span class="tag claim-tag">${esc(claimSaleLabel(p.claimSale))}</span>`
              : `<span class="tag">${esc(p.condition)}</span>`}
            ${p.variant && p.variant !== 'Normal' ? `<span class="tag variant">${esc(p.variant)}</span>` : ''}
            ${isUnlimitedWotc(p) ? '<span class="tag unlimited-tag">Unlimited</span>' : ''}
            ${p.qty > 1 ? `<span class="stock-note">${p.qty} in stock</span>` : ''}
          </div>
          <div class="product-buy">
            <span class="price">${money(p.price)}</span>
            ${
              cartQty > 0
                ? cartControlHtml(p.id, cartQty, p.qty)
                : `<button class="add" data-add="${esc(p.id)}" aria-label="Add ${esc(p.name)} to cart">
                     <svg class="i i-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add
                   </button>`
            }
          </div>
        </div>
      </article>`;
        })
        .join('')
    : STORE_MODE === 'leftovers' && !catalog.length
      ? `<div class="empty-state"><span class="es-ico"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg></span><h3>No Leftovers Right Now</h3><p>Every card from our recent claim sales has found a home. Cards nobody claims show up here about 2 hours after they're posted.</p><div class="es-actions"><a class="btn-solid" href="#" data-claim-link>Join The Claim Channel</a><a class="btn-outline" href="/">Browse All Cards</a></div></div>`
      : '<div class="empty">No cards match these filters.<br><button class="btn" id="emptyClearFilters" type="button" style="margin-top:14px">Clear Filters</button></div>';

  // Nothing at all on /leftovers: drop the filters and show a proper empty state.
  $('#catalogue').classList.toggle('is-empty', STORE_MODE === 'leftovers' && !catalog.length);
  if (STORE_MODE === 'leftovers' && !catalog.length) wireTelegramLinks();
  const emptyClearBtn = $('#emptyClearFilters');
  if (emptyClearBtn) {
    emptyClearBtn.onclick = () => {
      resetFilters();
      currentPage = 1;
      renderProducts();
    };
  }

  $$('[data-add]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      addToCart(b.dataset.add);
    };
  });
  $$('#productGrid [data-remove]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      removeFromCart(b.dataset.remove);
    };
  });
  wireQtySteppers($('#productGrid'));

  $$('[data-view]').forEach((el) => {
    el.onclick = () => openQuickView(el.dataset.view);
  });
  $$('.product-image[role="button"]').forEach((el) => {
    el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openQuickView(el.closest('[data-view]').dataset.view);
      }
    };
  });

  renderPagination(totalPages);
  renderFacets();
}

/* --------------------------------------------------------------- facets --- */

// The sidebar is only a nicer face on the hidden #storeSet/#storeCondition/#storeVariant
// selects: a click sets the select and fires the same 'input' event the old dropdowns
// did, so filtering itself stays in renderProducts().
const FACET_OPTIONS = {
  storeCondition: ['NM', 'LP', 'MP', 'HP'],
  storeVariant: ['Normal', 'Holo', 'Reverse Holo', '1st Edition'],
};
const SETS_COLLAPSED = 10;
let showAllSets = false;

function setFilter(id, value) {
  const el = $('#' + id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

function countBy(key) {
  const m = new Map();
  for (const p of catalog) m.set(p[key], (m.get(p[key]) || 0) + 1);
  return m;
}

function renderFacets() {
  if (!$('#facets')) return;

  const chipGroup = (id, counts) => {
    const current = $('#' + id).value;
    return FACET_OPTIONS[id]
      .map((v) => {
        const n = counts.get(v) || 0;
        const on = current === v;
        return `<button type="button" class="chip${on ? ' on' : ''}" data-facet="${id}" data-value="${esc(v)}"
          aria-pressed="${on}"${n || on ? '' : ' hidden'}>${esc(v)}<span>${n}</span></button>`;
      })
      .join('');
  };
  const currentRange = $('#storePriceRange').value;
  $('#facetPrice').innerHTML = PRICE_RANGES.map((r) => {
    const n = catalog.filter((p) => inPriceRange(Number(p.price), r.value)).length;
    const on = currentRange === r.value;
    return `<button type="button" class="chip${on ? ' on' : ''}" data-facet="storePriceRange" data-value="${r.value}"
      aria-pressed="${on}"${n || on ? '' : ' hidden'}>${esc(r.label)}<span>${n}</span></button>`;
  }).join('');
  $('#facetCondition').innerHTML = chipGroup('storeCondition', countBy('condition'));

  // Leftovers page: filter by which claim sale, newest first; no condition filter.
  if (STORE_MODE === 'leftovers') {
    const currentSale = $('#storeSale').value;
    const saleCounts = countBy('claimSale');
    const sales = [...saleCounts.keys()].filter(Boolean).sort().reverse();
    $('#storeSale').innerHTML = '<option value="">All sales</option>' + sales.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    $('#storeSale').value = currentSale;
    const saleRow = (value, label, n) => `<button type="button" class="facet-row${currentSale === value ? ' on' : ''}" data-facet="storeSale" data-value="${esc(value)}">
      <span class="fr-name">${esc(label)}</span><span class="fr-n">${n}</span></button>`;
    $('#facetSale').innerHTML =
      saleRow('', 'All sales', catalog.length) + sales.map((d) => saleRow(d, claimSaleLabel(d), saleCounts.get(d))).join('');
    $('#facetSaleWrap').classList.remove('hidden');
    $('#facetConditionWrap').classList.add('hidden');
  }
  $('#facetVariant').innerHTML = chipGroup('storeVariant', countBy('variant'));

  const setCounts = countBy('set');
  const currentSet = $('#storeSet').value;
  const sets = browseSetGroups.flatMap((g) => g.sets);
  let shown = showAllSets ? sets : sets.slice(0, SETS_COLLAPSED);
  if (currentSet && !shown.includes(currentSet)) shown = [...shown, currentSet];
  const setRow = (value, label, n) => {
    const symbol = value && setSymbolByName.get(value);
    return `<button type="button" class="facet-row${currentSet === value ? ' on' : ''}" data-facet="storeSet" data-value="${esc(value)}">
      ${symbol ? `<img class="set-icon" src="${esc(symbol)}" alt="" loading="lazy">` : ''}<span class="fr-name">${esc(label)}</span><span class="fr-n">${n}</span>
    </button>`;
  };
  $('#facetSets').innerHTML =
    setRow('', 'All sets', catalog.length) +
    shown.map((s) => setRow(s, s, setCounts.get(s) || 0)).join('') +
    (sets.length > SETS_COLLAPSED
      ? `<button type="button" class="facet-more" id="facetMore">${showAllSets ? 'Show fewer' : `Show all ${sets.length} sets`}</button>`
      : '');

  $$('#facets [data-facet]').forEach((b) => {
    b.onclick = () => {
      const { facet, value } = b.dataset;
      // Tapping the active chip again turns it off; set rows always select.
      setFilter(facet, facet !== 'storeSet' && facet !== 'storeSale' && $('#' + facet).value === value ? '' : value);
    };
  });
  const more = $('#facetMore');
  if (more) {
    more.onclick = () => {
      showAllSets = !showAllSets;
      renderFacets();
    };
  }

  // Removable pills for whatever is narrowing the grid right now.
  const active = [
    ['storeSearch', $('#storeSearch').value.trim() && `“${$('#storeSearch').value.trim()}”`],
    ['storeSet', currentSet],
    ['storeCondition', $('#storeCondition').value],
    ['storeVariant', $('#storeVariant').value],
    ['storePriceRange', (PRICE_RANGES.find((r) => r.value === currentRange) || {}).label],
    ['storeSale', $('#storeSale').value && claimSaleLabel($('#storeSale').value)],
  ].filter(([, label]) => label);
  const bar = $('#activeFilters');
  bar.hidden = !active.length;
  bar.innerHTML =
    active
      .map(([id, label]) => `<button type="button" class="pill" data-clear="${id}">${esc(label)}<span aria-hidden="true">&times;</span></button>`)
      .join('') + (active.length > 1 ? '<button type="button" class="pill-clear" data-clear="all">Clear All</button>' : '');
  $$('#activeFilters [data-clear]').forEach((b) => {
    b.onclick = () => (b.dataset.clear === 'all' ? clearAllFilters() : setFilter(b.dataset.clear, ''));
  });

  const filterCount = active.filter(([id]) => id !== 'storeSearch').length;
  $('#facetsCount').textContent = filterCount;
  $('#facetsCount').hidden = !filterCount;
  $('#facetsDone').textContent = 'Show ' + $('#resultCount').textContent.replace('card', 'Card');
}

function clearAllFilters() {
  const sort = $('#storePrice').value;
  resetFilters();
  $('#storePrice').value = sort; // clearing filters shouldn't throw away the chosen sort
  currentPage = 1;
  renderProducts();
}

// On phones the sidebar becomes a slide-up panel.
function setFacetsOpen(open) {
  $('#facets').classList.toggle('open', open);
  $('#facetsScrim').classList.toggle('show', open);
  document.body.classList.toggle('no-scroll', open);
}

function renderPagination(totalPages) {
  const el = $('#pagination');
  if (totalPages <= 1) {
    el.innerHTML = '';
    return;
  }

  // First, last, and two either side of the current page, with gaps shown as "…".
  const pages = [];
  for (let n = 1; n <= totalPages; n++) {
    if (n === 1 || n === totalPages || Math.abs(n - currentPage) <= 2) pages.push(n);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  el.innerHTML = `
    <button id="pagePrev" aria-label="Previous page" ${currentPage === 1 ? 'disabled' : ''}>&larr;</button>
    ${pages
      .map((n) =>
        n === '…'
          ? '<span class="page-gap">…</span>'
          : `<button class="page-num${n === currentPage ? ' on' : ''}" data-page="${n}"${n === currentPage ? ' aria-current="page"' : ''}>${n}</button>`
      )
      .join('')}
    <button id="pageNext" aria-label="Next page" ${currentPage === totalPages ? 'disabled' : ''}>&rarr;</button>`;

  const goTo = (page) => {
    currentPage = page;
    renderProducts();
    $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (currentPage > 1) $('#pagePrev').onclick = () => goTo(currentPage - 1);
  if (currentPage < totalPages) $('#pageNext').onclick = () => goTo(currentPage + 1);
  el.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => goTo(Number(b.dataset.page))));
}

/** Bigger photo + full condition notes, plus a few other cards from the same set. */
function openQuickView(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;

  $('#quickViewTitle').textContent = p.name;

  const cartQty = cart.get(p.id) || 0;
  const related = catalog.filter((x) => x.set === p.set && x.id !== p.id).slice(0, 6);

  $('#quickViewBody').innerHTML = `
    <div class="quick-view">
      <div class="product-image quick-view-image${p.variant && p.variant !== 'Normal' ? ' variant' : ''}">
        <img src="${esc(p.image || LOGO)}" alt="${esc(p.name)}" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='${LOGO}'">
      </div>
      <div class="quick-view-info">
        <div class="meta">${p.setSymbol ? `<img class="set-icon" src="${esc(p.setSymbol)}" alt="" loading="lazy">` : ''}${esc(p.set)}${p.number ? ' &middot; ' + esc(p.number) : ''}</div>
        <div class="qv-price">${money(p.price)}</div>
        <div class="tags">
          ${p.channel === 'claim'
            ? `<span class="tag claim-tag">${esc(claimSaleLabel(p.claimSale))}</span>`
            : `<span class="tag">${esc(p.condition)}</span>`}
          ${p.variant && p.variant !== 'Normal' ? `<span class="tag variant">${esc(p.variant)}</span>` : ''}
          ${isUnlimitedWotc(p) ? '<span class="tag unlimited-tag">Unlimited</span>' : ''}
          <span class="tag stock">${p.qty} available</span>
        </div>
        <dl class="qv-details">
          <div><dt>Set</dt><dd>${esc(p.set || '—')}</dd></div>
          ${p.number ? `<div><dt>Number</dt><dd>${esc(p.number)}</dd></div>` : ''}
          ${p.channel === 'claim'
            ? `<div><dt>Condition</dt><dd>${p.claimLink ? `<a href="${esc(p.claimLink)}" target="_blank" rel="noopener">Refer to Telegram post &nearr;</a>` : 'Refer to Telegram post'}</dd></div>`
            : `<div><dt>Condition</dt><dd>${esc(CONDITION_NAMES[p.condition] || p.condition)}</dd></div>`}
          ${p.variant ? `<div><dt>Variant</dt><dd>${esc(p.variant)}</dd></div>` : ''}
          ${WOTC_SETS.has(p.set) ? `<div><dt>Edition</dt><dd>${isUnlimitedWotc(p) ? 'Unlimited' : '1st Edition'}</dd></div>` : ''}
          ${p.artist ? `<div><dt>Artist</dt><dd>${esc(p.artist)}</dd></div>` : ''}
        </dl>
        ${isUnlimitedWotc(p) ? '<div class="notice warn" style="margin-top:14px">This is an <b>Unlimited</b> print, not 1st Edition. The reference picture may show a 1st Edition stamp.</div>' : ''}
        ${p.notes ? `<div class="notice" style="margin-top:14px">${esc(p.notes)}</div>` : ''}
        <div id="quickViewAddWrap" style="margin-top:16px">
          ${cartQty > 0 ? cartControlHtml(p.id, cartQty, p.qty) : `<button class="add" id="quickViewAdd">Add To Cart</button>`}
        </div>
        <div class="qv-assure">
          <span><svg class="i i-xs" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>PayNow checkout</span>
          <span><svg class="i i-xs" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 4h14v12H1z"/><path d="M15 8h4l4 4v4h-8z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>Tracked Mailing ${money(settings.mailing)}</span>
        </div>
      </div>
    </div>
    ${
      related.length
        ? `<div class="quick-view-related">
             <h3>More From ${esc(p.set)}</h3>
             <div class="related-wrap">
               <button class="related-scroll prev" type="button" aria-label="Scroll left">&#8249;</button>
               <div class="related-row" id="relatedRow">
                 ${related
                   .map(
                     (r) => `
                   <button class="related-card" data-view="${esc(r.id)}">
                     <img src="${esc(r.image || LOGO)}" alt="" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='${LOGO}'">
                     <span class="related-name">${esc(r.name)}</span>
                     <span class="related-price">${money(r.price)}</span>
                   </button>`
                   )
                   .join('')}
               </div>
               <button class="related-scroll next" type="button" aria-label="Scroll right">&#8250;</button>
             </div>
           </div>`
        : ''
    }`;

  const addBtn = $('#quickViewAdd');
  if (addBtn) {
    addBtn.onclick = () => {
      addToCart(p.id);
      openQuickView(id);
    };
  }
  // Re-opens quick view after each tap (rather than just wireQtySteppers) so the
  // stepper's own count and the +/- disabled state stay in sync with the new qty.
  $$('#quickViewAddWrap [data-step]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const stepId = b.closest('[data-stepper]').dataset.stepper;
      (b.dataset.step === '1' ? incrementQty : decrementQty)(stepId);
      openQuickView(id);
    };
  });
  const removeBtn = $('#quickViewAddWrap [data-remove]');
  if (removeBtn) {
    removeBtn.onclick = () => {
      removeFromCart(removeBtn.dataset.remove);
      openQuickView(id);
    };
  }

  $$('#quickViewBody [data-view]').forEach((btn) => {
    btn.onclick = () => openQuickView(btn.dataset.view);
  });

  openModal('#quickViewModal');
  wireRelatedScroll();
}

/** Arrow buttons for the "More from this set" row — the hidden native scrollbar gave no clue it scrolled. */
function wireRelatedScroll() {
  const row = $('#relatedRow');
  if (!row) return;
  const prevBtn = $('.related-scroll.prev');
  const nextBtn = $('.related-scroll.next');
  const wrap = row.closest('.related-wrap');

  const hasOverflow = row.scrollWidth > row.clientWidth + 1;
  wrap.classList.toggle('hidden-scroll-btns', !hasOverflow);
  if (!hasOverflow) return;

  const update = () => {
    prevBtn.disabled = row.scrollLeft <= 0;
    nextBtn.disabled = row.scrollLeft >= row.scrollWidth - row.clientWidth - 1;
  };
  update();
  row.addEventListener('scroll', update);
  prevBtn.onclick = () => row.scrollBy({ left: -240, behavior: 'smooth' });
  nextBtn.onclick = () => row.scrollBy({ left: 240, behavior: 'smooth' });
}

// `cartQty` names the line quantity — `p.qty` on a product already means its live
// stock, so merging the two under one name would silently shadow the stock number.
function cartItems() {
  return products.filter((p) => cart.has(p.id)).map((p) => ({ ...p, cartQty: cart.get(p.id) }));
}

/** A changed cart can invalidate an applied code's minimum spend, so make them re-apply it. */
function clearPromo() {
  appliedPromo = null;
  $('#promoInput').value = '';
  $('#promoMessage').textContent = '';
  $('#promoMessage').className = 'small';
}

/** Every cart mutator below ends here: saves, drops a now-stale promo (with a toast,
    but only if one was actually applied — a silent clearPromo() no-ops for shoppers who
    never applied a code), and re-renders. */
function commitCartChange() {
  const hadPromo = Boolean(appliedPromo);
  saveCart();
  clearPromo();
  if (hadPromo) toast('Your cart changed, so the promo code was removed. Please re-apply it.', true);
  renderProducts();
  renderCart();
}

function addToCart(id) {
  if (!cart.has(id)) cart.set(id, 1);
  commitCartChange();
  pulseCartCount();
  showAddedNotice(id);
}

/** A small confirmation with the card and a way straight to the cart or checkout. */
function showAddedNotice(id) {
  const p = products.find((x) => x.id === id);
  const box = $('#addedNotice');
  if (!p || !box) return;
  const n = cartItems().reduce((sum, x) => sum + x.cartQty, 0);
  box.innerHTML = `
    <img src="${esc(p.image || LOGO)}" alt="" onerror="this.onerror=null;this.src='${LOGO}'">
    <div class="added-info">
      <span class="added-title"><svg class="i i-xs" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>Added To Cart</span>
      <b>${esc(p.name)}</b>
      <span>${money(p.price)} · ${n} card${n === 1 ? '' : 's'} in cart</span>
    </div>
    <div class="added-actions">
      <button type="button" class="btn" data-added="cart">View Cart</button>
      <button type="button" class="checkout" data-added="checkout">Checkout</button>
    </div>
    <button type="button" class="added-close" data-added="close" aria-label="Dismiss">&times;</button>`;
  box.hidden = false;
  box.classList.remove('show');
  void box.offsetWidth;
  box.classList.add('show');
  clearTimeout(showAddedNotice.timer);
  showAddedNotice.timer = setTimeout(hideAddedNotice, 4500);
  box.querySelectorAll('[data-added]').forEach((b) => {
    b.onclick = () => {
      hideAddedNotice();
      if (b.dataset.added === 'cart') $('#cartOpen').click();
      if (b.dataset.added === 'checkout') {
        $('#cartOpen').click();
        if (!$('#checkoutOpen').disabled) $('#checkoutOpen').click();
      }
    };
  });
}

function hideAddedNotice() {
  const box = $('#addedNotice');
  box.classList.remove('show');
  clearTimeout(showAddedNotice.timer);
  setTimeout(() => {
    if (!box.classList.contains('show')) box.hidden = true;
  }, 200);
}

/** Restarts the cart-count pulse animation (removing then re-adding the class so it
    replays even on back-to-back adds, which wouldn't retrigger a CSS animation otherwise). */
function pulseCartCount() {
  const el = $('#cartCount');
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}

function setCartQty(id, nextQty) {
  const product = products.find((p) => p.id === id);
  const stock = product ? product.qty : 0;
  const clamped = Math.max(0, Math.min(nextQty, stock));
  if (clamped <= 0) cart.delete(id);
  else cart.set(id, clamped);
  commitCartChange();
}

function incrementQty(id) {
  setCartQty(id, (cart.get(id) || 0) + 1);
}

function decrementQty(id) {
  setCartQty(id, (cart.get(id) || 0) - 1);
}

function removeFromCart(id) {
  cart.delete(id);
  commitCartChange();
}

function renderCart() {
  const items = cartItems();
  const cardCount = items.reduce((n, p) => n + p.cartQty, 0);
  $('#cartCount').textContent = cardCount;

  // Phone-only bar so the cart is always one tap away while browsing.
  $('#cartBar').hidden = !cardCount;
  document.body.classList.toggle('has-cartbar', cardCount > 0);
  $('#cartBarCount').textContent = `${cardCount} card${cardCount === 1 ? '' : 's'}`;
  $('#cartBarTotal').textContent = money(items.reduce((sum, p) => sum + Number(p.price) * p.cartQty, 0));
  $('#cartClearAll').classList.toggle('hidden', !items.length);

  $('#cartItems').innerHTML = items.length
    ? items
        .map(
          (p) => `
    <div class="cart-item">
      <img src="${esc(p.image || LOGO)}" alt="" onerror="this.onerror=null;this.src='${LOGO}'">
      <div>
        <h4>${esc(p.name)}</h4>
        <div class="small muted">${esc(p.set)} &middot; ${esc(
              [p.channel === 'claim' ? claimSaleLabel(p.claimSale) : p.condition, p.variant !== 'Normal' && p.variant, isUnlimitedWotc(p) && 'Unlimited']
                .filter(Boolean)
                .join(', ')
            )}</div>
        ${
          p.qty > 1
            ? `<div class="small muted">${money(p.price)} each</div>${stepperHtml(p.id, p.cartQty, p.qty)}`
            : ''
        }
      </div>
      <div style="text-align:right">
        <b>${money(p.price * p.cartQty)}</b><br>
        <button class="remove" data-remove="${esc(p.id)}">Remove</button>
      </div>
    </div>`
        )
        .join('')
    : '<div class="empty">Your cart is empty.</div>';

  $$('[data-remove]').forEach((b) => {
    b.onclick = () => removeFromCart(b.dataset.remove);
  });
  wireQtySteppers($('#cartItems'));

  const subtotal = items.reduce((sum, p) => sum + Number(p.price) * p.cartQty, 0);
  const posting = $('#buyerDelivery').value !== 'Self-Pickup';
  const fee = items.length && posting ? Number(settings.mailing) : 0;

  $('#cartSubtotal').textContent = money(subtotal);
  $('#cartMailing').textContent = money(fee);
  $('#cartTotal').textContent = money(subtotal + fee);

  const belowMinimum = items.length > 0 && subtotal < Number(settings.minimum);
  $('#cartHint').textContent = belowMinimum
    ? `Minimum card subtotal is ${money(settings.minimum)}.`
    : '';
  $('#checkoutOpen').disabled = !items.length || belowMinimum;

  // Self-pickup is meant for larger orders or trade-show meetups — remind, don't block.
  const selfPickupUnder50 = !posting && items.length > 0 && subtotal < 50;
  $('#selfPickupHint').classList.toggle('hidden', !selfPickupUnder50);
  $('#selfPickupHint').textContent = selfPickupUnder50
    ? 'Heads up: self-pickup is normally for orders of $50 or more, or arranged at a listed trade show. You can still place this order.'
    : '';

  return { subtotal, fee, total: subtotal + fee };
}

/* --------------------------------------------------------------- modals --- */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let modalReturnFocus = null;

/** Keeps Tab from leaving the open modal, so keyboard users can't land on the page behind it. */
function trapFocus(modal) {
  const focusable = modal.querySelectorAll(FOCUSABLE);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  modal.onkeydown = (e) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

function openModal(sel) {
  const modal = $(sel);
  modalReturnFocus = document.activeElement;
  modal.classList.add('show');
  trapFocus(modal);
  const target = modal.querySelector(FOCUSABLE);
  if (target) target.focus();
}
function closeModals() {
  $$('.modal-bg').forEach((m) => {
    m.classList.remove('show');
    m.onkeydown = null;
  });
  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') modalReturnFocus.focus();
  modalReturnFocus = null;
}

function openInfo(title, body) {
  $('#infoTitle').textContent = title;
  $('#infoBody').innerHTML = body;
  openModal('#infoModal');
}

/* ----------------------------------------------------------- checkout --- */

/** Re-renders the cart totals plus whatever discount is currently applied. */
function updateCheckoutTotals() {
  const totals = renderCart();
  const discount = appliedPromo ? Math.min(appliedPromo.discount, totals.subtotal) : 0;

  $('#promoDiscountRow').style.display = discount ? '' : 'none';
  $('#checkoutDiscount').textContent = `−${money(discount)}`;
  $('#checkoutTotal').textContent = money(totals.total - discount);

  return { ...totals, discount, total: totals.total - discount };
}

async function applyPromo() {
  const input = $('#promoInput');
  const msg = $('#promoMessage');
  const code = input.value.trim().toUpperCase();

  if (!code) {
    clearPromo();
    updateCheckoutTotals();
    return;
  }

  try {
    const result = await api('/api/promo/validate', {
      method: 'POST',
      body: JSON.stringify({ code, items: cartItems().map((p) => ({ id: p.id, qty: p.cartQty })) }),
    });
    appliedPromo = { code: result.code, discount: result.discount };
    msg.className = 'small promo-ok';
    msg.textContent = `"${result.code}" applied — ${money(result.discount)} off.`;
  } catch (err) {
    appliedPromo = null;
    msg.className = 'small promo-error';
    msg.textContent = err.message;
  }

  updateCheckoutTotals();
}

/** Every problem with the checkout form at once, not just the first one hit — the
    server re-validates all of this independently, this is purely a friendlier UX pass. */
function validateCheckout(payload) {
  const errors = [];
  if (!payload.buyer) errors.push('Please enter your name.');
  if (!payload.telegram && !payload.email) {
    errors.push('Add a Telegram handle or an email so we can reach you.');
  }
  if (payload.telegram && !/^@[A-Za-z0-9_]{4,32}$/.test(payload.telegram)) {
    errors.push('Telegram handle should look like @yourname.');
  }
  if (payload.delivery === 'Tracked Mailing' && !payload.address) {
    errors.push('Please enter your mailing address.');
  }
  if (payload.delivery === 'Tracked Mailing' && !payload.phone) {
    errors.push('Please enter a contact number for the courier.');
  }
  if (payload.phone && !/^[+\d][\d\s-]{6,29}$/.test(payload.phone)) {
    errors.push('That phone number does not look valid.');
  }
  return errors;
}

async function submitOrder() {
  const button = $('#submitOrder');
  const errorBox = $('#checkoutError');
  const items = cartItems();

  errorBox.classList.add('hidden');

  if (!items.length) {
    return showCheckoutError('Your cart is empty.');
  }

  const payload = {
    buyer: $('#buyerName').value.trim(),
    telegram: $('#buyerTelegram').value.trim(),
    email: $('#buyerEmail').value.trim(),
    phone: $('#buyerPhone').value.trim(),
    address: $('#buyerAddress').value.trim(),
    delivery: $('#buyerDelivery').value,
    promoCode: appliedPromo ? appliedPromo.code : '',
    items: items.map((p) => ({ id: p.id, qty: p.cartQty })),
  };

  // Friendly client-side checks; the server re-validates all of these. Collected up
  // front rather than returning on the first failure, so a shopper with two mistakes
  // doesn't have to resubmit twice to find the second one.
  const errors = validateCheckout(payload);
  if (errors.length) return showCheckoutError(errors);

  button.disabled = true;
  button.textContent = 'Placing order…';

  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    cart.clear();
    saveCart();
    clearPromo();
    closeModals();
    showConfirmation(order);
    await load();
  } catch (err) {
    showCheckoutError(err.message);
    // A 409 means stock moved under us — refresh so the shopper sees reality.
    if (/sold|no longer listed/i.test(err.message)) load();
    // The code stopped working between "Apply" and "Place Order" — don't keep charging it.
    if (/code/i.test(err.message)) {
      clearPromo();
      updateCheckoutTotals();
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Place Order';
  }
}

/** Accepts a single message (every existing call site) or an array of them (the
    validateCheckout case) — more than one renders as a list instead of one line. */
function showCheckoutError(message) {
  const box = $('#checkoutError');
  const list = Array.isArray(message) ? message : [message];
  box.innerHTML =
    list.length > 1
      ? `<ul style="margin:0;padding-left:18px">${list.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`
      : esc(list[0]);
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * The pay-now instructions. Reference is repeated as text below the QR because a
 * shopper on a phone often cannot scan a QR displayed on that same phone — they
 * need to type it into their banking app. order.paynow is free text the seller
 * controls in Admin -> Settings, so it may carry real payment details and must
 * stay visible even though the default copy just repeats the steps below.
 */
function paymentBlock(order) {
  const handle = String(order.contactTelegram || '').replace(/^@/, '');

  const qr = order.paynowQr
    ? `<div style="text-align:center;margin:14px 0">
         <img src="${esc(order.paynowQr)}" alt="PayNow QR code"
              style="display:block;margin:0 auto;width:min(220px,65%);border:1px solid var(--line);border-radius:12px;background:#fff;padding:8px">
         ${order.paynowPayee ? `<div class="small muted" style="margin-top:6px">Paying: <b>${esc(order.paynowPayee)}</b></div>` : ''}
       </div>`
    : '';

  return `
    <div class="notice" style="text-align:center">
      <strong style="font-size:16px">Step 1 &middot; Scan &amp; pay ${money(order.total)}</strong>
    </div>

    ${qr}

    <div class="order-items" style="text-align:center">
      <div class="small muted">Reference</div>
      <div style="font-size:17px;font-weight:800;letter-spacing:.02em">${esc(order.id)}</div>
    </div>

    ${order.paynow ? `<p class="small muted" style="text-align:center;margin-top:8px">${esc(order.paynow)}</p>` : ''}

    <div class="notice" style="margin-top:12px">
      <strong>Step 2 &middot; Send your screenshot</strong><br>
      ${
        handle
          ? `Message <a href="https://t.me/${encodeURIComponent(handle)}" target="_blank" rel="noopener"
               style="font-weight:800;text-decoration:underline">@${esc(handle)}</a> with the payment
             screenshot and this order ID.`
          : 'Send the payment screenshot to the seller with this order ID.'
      }
    </div>

    <p class="small muted" style="text-align:center;margin-top:12px">
      Cards stay reserved until then &mdash; screenshot this page, it&rsquo;s your only copy of the order ID.
    </p>`;
}

function showConfirmation(order) {
  $('#confirmationContent').innerHTML = `
    <div style="text-align:center">
      <div style="width:58px;height:58px;margin:0 auto 14px;display:grid;place-items:center;
                  border-radius:50%;background:#e8f1e9;color:#3d6647;font-size:26px;font-weight:850">&check;</div>
      <h3 style="margin:0 0 6px;font-size:25px">${esc(order.id)}</h3>
      <p class="muted" style="margin:0 0 18px">Your cards are reserved and the seller has been notified.</p>
    </div>

    <div class="order-items">
      ${order.items
        .map((i) => {
          const tag = i.variant && i.variant !== 'Normal' ? `${i.condition}, ${i.variant}` : i.condition;
          const detail = [i.set, i.number].filter(Boolean).map(esc).join(' &middot; ');
          return `<div class="order-line">
            <img src="${esc(i.image || LOGO)}" alt="" onerror="this.onerror=null;this.src='${LOGO}'">
            <div class="order-line-info">
              <div class="order-line-name">${esc(i.name)}</div>
              <div class="small muted">${detail ? detail + ' &middot; ' : ''}${esc(tag)}</div>
            </div>
            <b>${money(i.price)}</b>
          </div>`;
        })
        .join('')}
      ${
        order.discount
          ? `<div class="summary"><span>Discount (${esc(order.promoCode)})</span><span>−${money(order.discount)}</span></div>`
          : ''
      }
      <div class="summary"><span>${esc(order.delivery)}</span><span>${money(order.fee)}</span></div>
      <div class="summary total"><span>Total</span><span>${money(order.total)}</span></div>
    </div>

    ${paymentBlock(order)}

    <button class="checkout" id="confirmationDone">Continue Shopping</button>`;

  openModal('#confirmationModal');
  $('#confirmationDone').onclick = () => {
    closeModals();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

/* ---------------------------------------------------------------- wiring --- */

const backToTopBtn = $('#backToTop');
if (backToTopBtn) {
  window.addEventListener(
    'scroll',
    () => backToTopBtn.classList.toggle('show', window.scrollY > 600),
    { passive: true }
  );
  backToTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
}

['storeSearch', 'storeSet', 'storePrice', 'storeCondition', 'storeVariant', 'storePriceRange', 'storeSale'].forEach((id) => {
  $('#' + id).addEventListener('input', () => {
    currentPage = 1;
    renderProducts();
  });
});

/** Clears every catalogue filter back to its default — used whenever a nav link means
    "start over," so a set filter picked earlier doesn't silently keep narrowing results
    the shopper thinks they've left behind. */
function resetFilters() {
  $('#storeSearch').value = '';
  $('#storeSet').value = '';
  $('#storePrice').value = '';
  $('#storeCondition').value = '';
  $('#storeVariant').value = '';
  $('#storePriceRange').value = '';
  $('#storeSale').value = '';
}

function goToAllCards(e) {
  if (STORE_MODE === 'leftovers') return; // plain link to the main store
  e.preventDefault();
  resetFilters();
  currentPage = 1;
  renderProducts();
  $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function goToLatestDrop(e) {
  if (STORE_MODE === 'leftovers') return; // plain link to /#latest
  e.preventDefault();
  resetFilters();
  $('#storePrice').value = 'new';
  currentPage = 1;
  renderProducts();
  $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$$('[data-nav="all-cards"]').forEach((a) => (a.onclick = goToAllCards));
$('#latestDrop').onclick = goToLatestDrop;
$('#heroLatest').onclick = goToLatestDrop;
$('#newSeeAll').onclick = goToLatestDrop;
$$('[data-latest]').forEach((a) => (a.onclick = goToLatestDrop));

$('#heroSearchForm').onsubmit = (e) => {
  e.preventDefault();
  resetFilters();
  $('#storeSearch').value = $('#heroSearch').value.trim();
  $('#storeSearch').dispatchEvent(new Event('input'));
  $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('#cartBarOpen').onclick = () => $('#cartOpen').click();

/** Greys out the arrow at either end, and hides both when everything already fits. */
function updateRailArrows() {
  const rail = $('#newRail');
  const arrows = $('#newSection .rail-arrows');
  if (!rail || !arrows) return;
  const max = rail.scrollWidth - rail.clientWidth;
  arrows.classList.toggle('hidden', max <= 4);
  $('#newSection [data-rail-scroll="-1"]').disabled = rail.scrollLeft <= 4;
  $('#newSection [data-rail-scroll="1"]').disabled = rail.scrollLeft >= max - 4;
}
$$('#newSection [data-rail-scroll]').forEach((b) => {
  b.onclick = () => {
    const rail = $('#newRail');
    rail.scrollBy({ left: Number(b.dataset.railScroll) * Math.max(240, rail.clientWidth * 0.8), behavior: 'smooth' });
    // Some browsers skip scroll events during smooth scrolling; refresh once it settles.
    setTimeout(updateRailArrows, 500);
  };
});
$('#newRail').addEventListener('scroll', updateRailArrows, { passive: true });
window.addEventListener('resize', updateRailArrows);

function closeMobileNavMenu() {
  $('#mobileNavMenu').classList.add('hidden');
  $('#mobileNav').setAttribute('aria-expanded', 'false');
}

$('#mobileNav').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#mobileNavMenu');
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  $('#mobileNav').setAttribute('aria-expanded', String(willOpen));
};

$('#mobileAllCards').onclick = (e) => {
  closeMobileNavMenu();
  goToAllCards(e);
};
$('#mobileLatestDrop').onclick = (e) => {
  closeMobileNavMenu();
  goToLatestDrop(e);
};

function closeBrowseSetsMenu() {
  $('#browseSetsMenu').classList.add('hidden');
  $('#browseSets').setAttribute('aria-expanded', 'false');
}

$('#browseSets').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#browseSetsMenu');
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  $('#browseSets').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    // Fresh state each time it opens, so a search left over from last time doesn't
    // silently hide sets the next visit.
    $('#browseSetsSearch').value = '';
    renderBrowseSetsList(browseSetGroups);
    $('#browseSetsSearch').focus();
  }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-dropdown')) {
    closeBrowseSetsMenu();
    closeMobileNavMenu();
  }
});

$('#cartOpen').onclick = () => {
  const drawer = $('#cartDrawer');
  cartReturnFocus = document.activeElement;
  drawer.classList.add('show');
  $('#overlay').classList.add('show');
  trapFocus(drawer);
  const target = drawer.querySelector(FOCUSABLE);
  if (target) target.focus();
};

let cartReturnFocus = null;

function closeCart() {
  const drawer = $('#cartDrawer');
  drawer.classList.remove('show');
  drawer.onkeydown = null;
  $('#overlay').classList.remove('show');
  if (cartReturnFocus && typeof cartReturnFocus.focus === 'function') cartReturnFocus.focus();
  cartReturnFocus = null;
}
$('#cartClose').onclick = closeCart;
$('#overlay').onclick = closeCart;

$('#cartClearAll').onclick = () => {
  cart.clear();
  commitCartChange();
};

$('#buyerDelivery').addEventListener('change', updateCheckoutTotals);

$('#checkoutOpen').onclick = () => {
  closeCart();
  if (customer && customer.username && !$('#buyerTelegram').value.trim()) {
    $('#buyerTelegram').value = '@' + customer.username;
  }
  updateCheckoutTotals();
  $('#checkoutError').classList.add('hidden');
  openModal('#checkoutModal');
};

$('#promoApply').onclick = applyPromo;
$('#promoInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyPromo();
  }
});

$('#submitOrder').onclick = submitOrder;

$$('.modal-close').forEach((b) => (b.onclick = closeModals));
$$('.modal-bg').forEach((m) => {
  m.onclick = (e) => {
    if (e.target === m) closeModals();
  };
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModals();
    closeCart();
    closeBrowseSetsMenu();
    closeMobileNavMenu();
    setFacetsOpen(false);
  }
});

/** Settings hold either "@handle" or a full link; both become a t.me URL. */
function telegramUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://t.me/${encodeURIComponent(v.replace(/^@/, ''))}`;
}

/** Points every Telegram link at the right channel once settings arrive: the main
    channel for "Join our Telegram" and the claim sale channel for anything about
    claims. Missing ones toast instead of 404ing. */
function wireTelegramLinks() {
  const bind = (el, url, missing) => {
    if (url) {
      el.href = url;
      el.target = '_blank';
      el.rel = 'noopener';
      el.onclick = null;
    } else {
      el.onclick = (e) => {
        e.preventDefault();
        toast(missing, true);
      };
    }
  };
  const main = telegramUrl(settings.telegram);
  const claim = telegramUrl(settings.claimTelegram) || main;
  bind($('#joinTelegram'), STORE_MODE === 'leftovers' ? claim : main, 'No Telegram channel is configured yet.');
  $$('[data-main-link]').forEach((a) => bind(a, main, 'No Telegram channel is configured yet.'));
  $$('[data-claim-link]').forEach((a) => bind(a, claim, 'No claim sale channel is configured yet.'));
}
/** "2026-10-22" -> "22 Oct Sale". */
function claimSaleLabel(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return 'Claim Sale';
  return `${d} ${SHOW_MONTHS[m - 1] || ''} Sale`;
}

function applyStoreMode() {
  const leftovers = STORE_MODE === 'leftovers';
  $$('[data-store-link]').forEach((a) => a.classList.toggle('current', a.dataset.storeLink === STORE_MODE));
  if (!leftovers) return;

  $$('[data-nav="all-cards"], #mobileAllCards').forEach((a) => (a.href = '/'));
  $$('#latestDrop, #mobileLatestDrop, [data-latest]').forEach((a) => (a.href = '/#latest'));

  document.body.classList.add('store-leftovers');
  $('.hero h1').innerHTML = 'Claim Sale Leftovers<br><em>Last Chance Cards</em>';
  $('.hero p').innerHTML = 'Cards nobody claimed in our Telegram claim sales.<br>Each is a single copy at its claim sale price.';
  $('#heroLatest').closest('.hero-links').innerHTML =
    '<a href="/">Browse All Cards</a><span aria-hidden="true">&middot;</span><a href="#" id="joinTelegram">Join The Claim Channel</a>';
  $('#catalogue .section-head h2').textContent = 'Leftover Claim Sale Cards';
  $('#catalogue .section-head p').textContent = 'Each card links to its Telegram post, where you can check its condition.';
  $('#leftoversPromo').classList.add('hidden');
  $('.features').classList.add('hidden');
  $('#newSection').classList.add('hidden');
}

/** On the main shop, a strip pointing to /leftovers whenever there are any. */
function renderLeftoversPromo() {
  const box = $('#leftoversPromo');
  if (!box || STORE_MODE === 'leftovers') return;
  const n = products.filter((p) => p.channel === 'claim').length;
  box.classList.toggle('hidden', !n);
  $('#leftoversCount').textContent = `${n} card${n === 1 ? '' : 's'} nobody claimed in our Telegram claim sales, at claim sale prices.`;
}

applyStoreMode();
wireTelegramLinks();
$('#year').textContent = new Date().getFullYear();

$('#facetsOpen').onclick = () => setFacetsOpen(true);
$('#facetsClose').onclick = () => setFacetsOpen(false);
$('#facetsDone').onclick = () => setFacetsOpen(false);
$('#facetsScrim').onclick = () => setFacetsOpen(false);
$('#facetsClear').onclick = clearAllFilters;

$('#conditionGuide').onclick = (e) => {
  e.preventDefault();
  openInfo(
    'Condition Guide',
    `<div class="order-items">
       <div class="summary"><span><b>NM</b> &mdash; Near Mint</span><span>Pack fresh, no visible wear</span></div>
       <div class="summary"><span><b>LP</b> &mdash; Lightly Played</span><span>Minor edge or surface wear</span></div>
       <div class="summary"><span><b>MP</b> &mdash; Moderately Played</span><span>Noticeable whitening or scuffs</span></div>
       <div class="summary"><span><b>HP</b> &mdash; Heavily Played</span><span>Heavy wear, creasing possible</span></div>
     </div>
     <div class="notice" style="margin-top:12px">Every listing states its condition. Ask before ordering if you need extra photos.</div>`
  );
};

$('#shippingInfo').onclick = (e) => {
  e.preventDefault();
  openInfo(
    'Shipping &amp; Pickup',
    `<div class="order-items">
       <div class="summary"><span><b>Tracked Mailing</b></span><span>${money(settings.mailing)} per order</span></div>
       <div class="summary"><span><b>Self-Pickup</b></span><span>Free</span></div>
     </div>
     <div class="notice" style="margin-top:12px">
       Tracked mailing applies regardless of how many cards you order.
       Self-pickup is available at a listed trade show, or for orders of $50 or more &mdash;
       leave your preferred time/location in the order note and we'll confirm with you.
       ${settings.minimum > 0 ? `<br><br>Minimum card subtotal to check out: ${money(settings.minimum)}.` : ''}
     </div>`
  );
};

/* ------------------------------------------------------------- tracking --- */

$('#trackOrder').onclick = (e) => {
  e.preventDefault();
  $('#trackId').value = '';
  $('#trackContact').value = '';
  $('#trackError').classList.add('hidden');
  $('#trackResult').innerHTML = '';
  openModal('#trackModal');
};

async function lookupOrder() {
  const button = $('#trackSubmit');
  const errorBox = $('#trackError');
  errorBox.classList.add('hidden');
  $('#trackResult').innerHTML = '';

  const id = $('#trackId').value.trim();
  const contact = $('#trackContact').value.trim();
  if (!id || !contact) {
    errorBox.textContent = 'Enter your order ID and the Telegram handle or email you checked out with.';
    errorBox.classList.remove('hidden');
    return;
  }

  button.disabled = true;
  button.textContent = 'Looking up…';
  try {
    const o = await api(
      `/api/orders/lookup?id=${encodeURIComponent(id)}&contact=${encodeURIComponent(contact)}`,
      { method: 'GET' }
    );
    $('#trackResult').innerHTML = orderCardHtml(o);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Look Up Order';
  }
}

$('#trackSubmit').onclick = lookupOrder;

function orderCardHtml(o) {
  return `
    <div class="order-items">
      <div class="summary"><span><b>${esc(o.id)}</b></span><span class="status order-${slug(o.status)}">${esc(o.status)}</span></div>
      ${o.items
        .map(
          (i) =>
            `<div class="summary"><span>${esc(i.name)} &middot; ${esc(i.condition)}</span><span>${money(i.price)}</span></div>`
        )
        .join('')}
      ${
        o.discount
          ? `<div class="summary"><span>Discount (${esc(o.promoCode)})</span><span>−${money(o.discount)}</span></div>`
          : ''
      }
      <div class="summary"><span>${esc(o.delivery)}</span><span>${money(o.fee)}</span></div>
      <div class="summary total"><span>Total</span><span>${money(o.total)}</span></div>
    </div>`;
}

/* ------------------------------------------------------------- account --- */

let customer = null;
let telegramBotId = 0;
let telegramBotUsername = '';

// Global on purpose: the Telegram Login Widget calls it by name via data-onauth.
window.onTelegramAuth = async (user) => {
  try {
    const res = await api('/api/customer/login', { method: 'POST', body: JSON.stringify(user) });
    customer = res.customer;
    renderAccountButton();
    renderAccountBody();
    toast(`Logged in as ${customerLabel()}.`);
  } catch (err) {
    toast(err.message, true);
  }
};

function customerLabel() {
  return customer.username ? '@' + customer.username : customer.firstName || 'Telegram user';
}

function renderAccountButton() {
  const button = $('#accountOpen');
  button.classList.toggle('hidden', !telegramBotUsername && !customer);
  button.textContent = customer ? customerLabel() : 'Log In';
}

function renderAccountBody() {
  const body = $('#accountBody');
  if (customer) {
    body.innerHTML = `
      <div class="summary"><span>Logged in as <b>${esc(customerLabel())}</b></span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
        <a class="checkout" href="/account" style="flex:1 1 180px;text-align:center;text-decoration:none">My account &amp; claims</a>
        <button class="checkout" id="myOrdersBtn" style="flex:1 1 180px">My orders</button>
        <button class="checkout" id="logoutBtn" style="flex:1 1 140px">Log out</button>
      </div>
      <div id="myOrdersList" style="margin-top:16px"></div>`;
    $('#myOrdersBtn').onclick = loadMyOrders;
    $('#logoutBtn').onclick = logout;
    return;
  }

  const authUrl =
    'https://oauth.telegram.org/auth' +
    `?bot_id=${encodeURIComponent(telegramBotId)}` +
    `&origin=${encodeURIComponent(location.origin)}` +
    '&request_access=write' +
    `&return_to=${encodeURIComponent(location.origin + '/')}`;
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:16px 0;text-align:center">
      <a href="${esc(authUrl)}" style="display:inline-flex;align-items:center;gap:10px;padding:12px 24px;border-radius:10px;background:var(--forest);color:#fff;font-weight:600;text-decoration:none">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21.94 4.11c.29-1.2-.44-1.72-1.24-1.42L2.6 9.86c-1.17.46-1.16 1.12-.2 1.42l4.72 1.47 1.83 5.6c.22.6.38.84.78.84.35 0 .52-.16.73-.36l1.9-1.85 4.02 2.97c.74.41 1.27.2 1.46-.68l2.9-13.66zM8.4 13.1l9.4-5.94c.47-.28.9-.13.55.18l-8.02 7.24-.32 3.4-1.6-4.88z"/></svg>
        Log in with Telegram
      </a>
      <p class="small muted" style="margin:0;max-width:360px">Used only to link your referral code and orders to your Telegram account.</p>
    </div>`;
}

/** Telegram sends the buyer back with the signed login data in the URL fragment. */
async function completeTelegramRedirect() {
  const match = /tgAuthResult=([A-Za-z0-9+/=_-]+)/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    await window.onTelegramAuth(data);
  } catch {
    toast('Telegram login could not be completed. Please try again.', true);
  }
}

async function loadMyOrders() {
  const list = $('#myOrdersList');
  list.innerHTML = '<div class="small muted">Loading your orders…</div>';
  try {
    const rows = await api('/api/customer/orders', { method: 'GET' });
    list.innerHTML = rows.length
      ? rows.map((o) => `<div style="margin-bottom:14px">${orderCardHtml(o)}</div>`).join('')
      : '<div class="notice">No orders yet. Orders placed while logged in show up here.</div>';
  } catch (err) {
    list.innerHTML = '';
    toast(err.message, true);
  }
}

async function logout() {
  await api('/api/customer/logout', { method: 'POST', body: '{}' }).catch(() => {});
  customer = null;
  renderAccountButton();
  renderAccountBody();
}

async function loadCustomer() {
  try {
    const me = await api('/api/customer/me', { method: 'GET' });
    telegramBotId = me.botId || 0;
    telegramBotUsername = me.botUsername || '';
    customer = me.customer;
  } catch {
    // Account state is optional — guest shopping keeps working without it.
  }
  renderAccountButton();
  await completeTelegramRedirect();
}

$('#accountOpen').onclick = () => {
  renderAccountBody();
  openModal('#accountModal');
};

load();
loadCustomer();
