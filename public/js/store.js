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
  const sets = [...new Set(products.map((p) => p.set).filter(Boolean))].sort();
  const current = $('#storeSet').value;

  $('#storeSet').innerHTML =
    '<option value="">All sets</option>' +
    sets.map((s) => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');

  $('#setRow').innerHTML = ['', ...sets]
    .map(
      (s) =>
        `<button class="set-chip${s === current ? ' active' : ''}" data-set="${esc(s)}">${
          esc(s || 'All Sets')
        }</button>`
    )
    .join('');

  $$('#setRow .set-chip').forEach((btn) => {
    btn.onclick = () => {
      $$('#setRow .set-chip').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      $('#storeSet').value = btn.dataset.set;
      renderProducts();
    };
  });

  $('#browseSetsMenu').innerHTML = ['', ...sets]
    .map(
      (s) =>
        `<button data-set="${esc(s)}"${s === current ? ' class="active"' : ''}>${
          esc(s || 'All Sets')
        }</button>`
    )
    .join('');

  $$('#browseSetsMenu button').forEach((btn) => {
    btn.onclick = () => {
      $('#storeSet').value = btn.dataset.set;
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
  const limit = Number($('#storePrice').value || 0);
  const condition = $('#storeCondition').value;
  const variant = $('#storeVariant').value;

  const list = products.filter(
    (p) =>
      (!q || `${p.name} ${p.set} ${p.number}`.toLowerCase().includes(q)) &&
      (!set || p.set === set) &&
      (!limit || p.price <= limit) &&
      (!condition || p.condition === condition) &&
      (!variant || p.variant === variant)
  );

  $('#resultCount').textContent = `${list.length} card${list.length === 1 ? '' : 's'}`;

  $('#productGrid').innerHTML = list.length
    ? list
        .map((p) => {
          const inCart = cart.has(p.id);
          return `
      <article class="product">
        <div class="product-image">
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
    b.onclick = () => toggleCart(b.dataset.add);
  });
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

  return { subtotal, fee, total: subtotal + fee };
}

/* --------------------------------------------------------------- modals --- */

function openModal(sel) {
  $(sel).classList.add('show');
}
function closeModals() {
  $$('.modal-bg').forEach((m) => m.classList.remove('show'));
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
  $('#' + id).addEventListener('input', renderProducts);
});

function closeBrowseSetsMenu() {
  $('#browseSetsMenu').classList.add('hidden');
}

$('#browseSets').onclick = (e) => {
  e.stopPropagation();
  $('#browseSetsMenu').classList.toggle('hidden');
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.nav-dropdown')) closeBrowseSetsMenu();
});

$('#cartOpen').onclick = () => {
  $('#cartDrawer').classList.add('show');
  $('#overlay').classList.add('show');
};

function closeCart() {
  $('#cartDrawer').classList.remove('show');
  $('#overlay').classList.remove('show');
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

load();
