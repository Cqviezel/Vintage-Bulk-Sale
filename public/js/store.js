'use strict';

/* Crazed TCG storefront. All inventory, pricing and orders come from the server;
   the only thing kept in this browser is the shopper's own cart. */

const LOGO = '/img/logo-460.jpg';
const CART_KEY = 'ctcg_cart_v2';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let products = [];
let settings = { mailing: 0, minimum: 0, telegram: '', paynow: '' };
let tradeShows = [];
let cart = new Set(loadCart());

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

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...cart]));
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
    settings = settingData;

    // Drop anything that sold while this tab was idle.
    const live = new Set(products.map((p) => p.id));
    let dropped = 0;
    for (const id of [...cart]) {
      if (!live.has(id)) {
        cart.delete(id);
        dropped++;
      }
    }
    if (dropped) {
      saveCart();
      toast(`${dropped} card${dropped === 1 ? ' was' : 's were'} sold and removed from your cart.`, true);
    }

    renderSetOptions();
    renderProducts();
    renderCart();
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

function renderSetOptions() {
  const sets = [...new Set(products.map((p) => p.set).filter(Boolean))];
  const groups = groupSetsByEra(sets);
  const current = $('#storeSet').value;

  $('#storeSet').innerHTML =
    '<option value="">All sets</option>' +
    groups
      .map(
        (g) =>
          `<optgroup label="${esc(g.label)}">${g.sets
            .map((s) => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`)
            .join('')}</optgroup>`
      )
      .join('');

  $('#browseSetsMenu').innerHTML =
    `<button role="menuitem" data-set=""${current === '' ? ' class="active"' : ''}>All Sets</button>` +
    groups
      .map(
        (g) =>
          `<div class="menu-era" role="presentation">${esc(g.label)}</div>` +
          g.sets
            .map(
              (s) =>
                `<button role="menuitem" data-set="${esc(s)}"${s === current ? ' class="active"' : ''}>${esc(s)}</button>`
            )
            .join('')
      )
      .join('');

  $$('#browseSetsMenu button').forEach((btn) => {
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

function renderTradeShows() {
  const section = $('#showsSection');
  if (!tradeShows.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  $('#showsRow').innerHTML = tradeShows
    .map((s) => {
      const { mon, day } = formatShowDate(s.startDate, s.endDate);
      return `
      <div class="show-card">
        <div class="show-date"><span class="mon">${esc(mon)}</span><span class="day">${esc(day)}</span></div>
        <div class="show-body">
          <div class="venue">${esc(s.venue)}</div>
          <div class="place">${esc(s.location)}</div>
        </div>
        ${s.tableNo ? `<div class="show-table">${esc(s.tableNo)}</div>` : ''}
      </div>`;
    })
    .join('');
}

function renderProducts() {
  const q = $('#storeSearch').value.trim().toLowerCase();
  const set = $('#storeSet').value;
  const sort = $('#storePrice').value;
  const condition = $('#storeCondition').value;
  const variant = $('#storeVariant').value;

  const list = products.filter(
    (p) =>
      (!q || `${p.name} ${p.set} ${p.number}`.toLowerCase().includes(q)) &&
      (!set || p.set === set) &&
      (!condition || p.condition === condition) &&
      (!variant || p.variant === variant)
  );

  if (sort === 'asc') list.sort((a, b) => a.price - b.price);
  if (sort === 'desc') list.sort((a, b) => b.price - a.price);
  if (sort === 'new') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $('#resultCount').textContent = `${list.length} card${list.length === 1 ? '' : 's'}`;

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const pageItems = list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  $('#productGrid').innerHTML = pageItems.length
    ? pageItems
        .map((p) => {
          const inCart = cart.has(p.id);
          return `
      <article class="product" data-view="${esc(p.id)}">
        <div class="product-image" role="button" tabindex="0" aria-label="View details for ${esc(p.name)}">
          <img src="${esc(p.image || LOGO)}" alt="${esc(p.name)}" loading="lazy"
               onerror="this.onerror=null;this.src='${LOGO}'">
          <span class="price">${money(p.price)}</span>
        </div>
        <h3>${esc(p.name)}</h3>
        <div class="meta">${esc(p.set)}${p.number ? ' &middot; ' + esc(p.number) : ''}</div>
        <div class="tags">
          <span class="tag">${esc(p.condition)}</span>
          ${p.variant && p.variant !== 'Normal' ? `<span class="tag">${esc(p.variant)}</span>` : ''}
          <span class="tag stock${p.qty <= 1 ? ' low' : ''}">${p.qty} left</span>
        </div>
        <button class="add${inCart ? ' added' : ''}" data-add="${esc(p.id)}">
          ${inCart ? '&check; Added' : 'Add to Cart'}
        </button>
      </article>`;
        })
        .join('')
    : '<div class="empty">No cards match these filters.</div>';

  $$('[data-add]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      toggleCart(b.dataset.add);
    };
  });

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
}

function renderPagination(totalPages) {
  const el = $('#pagination');
  if (totalPages <= 1) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <button id="pagePrev" ${currentPage === 1 ? 'disabled' : ''}>&larr; Prev</button>
    <span class="small muted">Page ${currentPage} of ${totalPages}</span>
    <button id="pageNext" ${currentPage === totalPages ? 'disabled' : ''}>Next &rarr;</button>`;

  const goTo = (page) => {
    currentPage = page;
    renderProducts();
    $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (currentPage > 1) $('#pagePrev').onclick = () => goTo(currentPage - 1);
  if (currentPage < totalPages) $('#pageNext').onclick = () => goTo(currentPage + 1);
}

/** Bigger photo + full condition notes, plus a few other cards from the same set. */
function openQuickView(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;

  $('#quickViewTitle').textContent = p.name;

  const inCart = cart.has(p.id);
  const related = products.filter((x) => x.set === p.set && x.id !== p.id).slice(0, 6);

  $('#quickViewBody').innerHTML = `
    <div class="quick-view">
      <div class="product-image quick-view-image">
        <img src="${esc(p.image || LOGO)}" alt="${esc(p.name)}" onerror="this.onerror=null;this.src='${LOGO}'">
        <span class="price">${money(p.price)}</span>
      </div>
      <div class="quick-view-info">
        <div class="meta">${esc(p.set)}${p.number ? ' &middot; ' + esc(p.number) : ''}</div>
        <div class="tags">
          <span class="tag">${esc(p.condition)}</span>
          ${p.variant && p.variant !== 'Normal' ? `<span class="tag">${esc(p.variant)}</span>` : ''}
          <span class="tag stock${p.qty <= 1 ? ' low' : ''}">${p.qty} left</span>
        </div>
        ${p.notes ? `<div class="notice" style="margin-top:12px">${esc(p.notes)}</div>` : ''}
        <button class="add${inCart ? ' added' : ''}" id="quickViewAdd" style="margin-top:16px">
          ${inCart ? '&check; Added' : 'Add to Cart'}
        </button>
      </div>
    </div>
    ${
      related.length
        ? `<div class="quick-view-related">
             <h3>More from ${esc(p.set)}</h3>
             <div class="related-wrap">
               <button class="related-scroll prev" type="button" aria-label="Scroll left">&#8249;</button>
               <div class="related-row" id="relatedRow">
                 ${related
                   .map(
                     (r) => `
                   <button class="related-card" data-view="${esc(r.id)}">
                     <img src="${esc(r.image || LOGO)}" alt="" onerror="this.onerror=null;this.src='${LOGO}'">
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

  $('#quickViewAdd').onclick = () => {
    toggleCart(p.id);
    openQuickView(id);
  };

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

function cartItems() {
  return products.filter((p) => cart.has(p.id));
}

function toggleCart(id) {
  if (cart.has(id)) cart.delete(id);
  else cart.add(id);
  saveCart();
  renderProducts();
  renderCart();
}

function renderCart() {
  const items = cartItems();
  $('#cartCount').textContent = items.length;

  $('#cartItems').innerHTML = items.length
    ? items
        .map(
          (p) => `
    <div class="cart-item">
      <img src="${esc(p.image || LOGO)}" alt="" onerror="this.onerror=null;this.src='${LOGO}'">
      <div>
        <h4>${esc(p.name)}</h4>
        <div class="small muted">${esc(p.set)} &middot; ${esc(
              p.variant && p.variant !== 'Normal' ? `${p.condition}, ${p.variant}` : p.condition
            )}</div>
      </div>
      <div style="text-align:right">
        <b>${money(p.price)}</b><br>
        <button class="remove" data-remove="${esc(p.id)}">Remove</button>
      </div>
    </div>`
        )
        .join('')
    : '<div class="empty">Your cart is empty.</div>';

  $$('[data-remove]').forEach((b) => {
    b.onclick = () => toggleCart(b.dataset.remove);
  });

  const subtotal = items.reduce((sum, p) => sum + Number(p.price), 0);
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
    items: items.map((p) => ({ id: p.id })),
  };

  // Friendly client-side checks; the server re-validates all of these.
  if (!payload.buyer) return showCheckoutError('Please enter your name.');
  if (!payload.telegram && !payload.email) {
    return showCheckoutError('Add a Telegram handle or an email so we can reach you.');
  }
  if (payload.telegram && !/^@[A-Za-z0-9_]{4,32}$/.test(payload.telegram)) {
    return showCheckoutError('Telegram handle should look like @yourname.');
  }
  if (payload.delivery === 'Tracked Mailing' && !payload.address) {
    return showCheckoutError('Please enter your mailing address.');
  }
  if (payload.delivery === 'Tracked Mailing' && !payload.phone) {
    return showCheckoutError('Please enter a contact number for the courier.');
  }
  if (payload.phone && !/^[+\d][\d\s-]{6,29}$/.test(payload.phone)) {
    return showCheckoutError('That phone number does not look valid.');
  }

  button.disabled = true;
  button.textContent = 'Placing order…';

  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    cart.clear();
    saveCart();
    closeModals();
    showConfirmation(order);
    await load();
  } catch (err) {
    showCheckoutError(err.message);
    // A 409 means stock moved under us — refresh so the shopper sees reality.
    if (/sold|no longer listed/i.test(err.message)) load();
  } finally {
    button.disabled = false;
    button.textContent = 'Place Order';
  }
}

function showCheckoutError(message) {
  const box = $('#checkoutError');
  box.textContent = message;
  box.classList.remove('hidden');
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

['storeSearch', 'storeSet', 'storePrice', 'storeCondition', 'storeVariant'].forEach((id) => {
  $('#' + id).addEventListener('input', () => {
    currentPage = 1;
    renderProducts();
  });
});

$('#latestDrop').onclick = (e) => {
  e.preventDefault();
  $('#storePrice').value = 'new';
  currentPage = 1;
  renderProducts();
  $('#catalogue').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const first = menu.querySelector('button');
    if (first) first.focus();
  }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-dropdown')) closeBrowseSetsMenu();
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

$('#buyerDelivery').addEventListener('change', () => {
  const totals = renderCart();
  $('#checkoutTotal').textContent = money(totals.total);
});

$('#checkoutOpen').onclick = () => {
  closeCart();
  const totals = renderCart();
  $('#checkoutTotal').textContent = money(totals.total);
  $('#checkoutError').classList.add('hidden');
  openModal('#checkoutModal');
};

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
  }
});

$('#joinTelegram').onclick = (e) => {
  e.preventDefault();
  const handle = String(settings.telegram || '').replace(/^@/, '');
  if (!handle) return toast('No Telegram channel is configured yet.', true);
  window.open(`https://t.me/${encodeURIComponent(handle)}`, '_blank', 'noopener');
};

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
    $('#trackResult').innerHTML = `
      <div class="order-items">
        <div class="summary"><span><b>${esc(o.id)}</b></span><span class="status order-${slug(o.status)}">${esc(o.status)}</span></div>
        ${o.items
          .map(
            (i) =>
              `<div class="summary"><span>${esc(i.name)} &middot; ${esc(i.condition)}</span><span>${money(i.price)}</span></div>`
          )
          .join('')}
        <div class="summary"><span>${esc(o.delivery)}</span><span>${money(o.fee)}</span></div>
        <div class="summary total"><span>Total</span><span>${money(o.total)}</span></div>
      </div>`;
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Look Up Order';
  }
}

$('#trackSubmit').onclick = lookupOrder;

load();
