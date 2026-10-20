'use strict';

/* Customer account: claimed cards and orders for the logged-in Telegram user.
   Everything renders client-side from /api/customer/me, /api/settings and
   /api/customer/orders. Views are hash-routed (#overview, #claims, #orders, #profile). */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------------------------------------------------------------- icons --- */

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  receipt: '<path d="M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M16 15h2"/>',
  truck: '<path d="M1 4h14v12H1z"/><path d="M15 8h4l4 4v4h-8z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 7.5v5M12 16.5h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  package: '<path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* --------------------------------------------------------------- status --- */

const FLOW = ['awaiting payment', 'paid', 'packed', 'mailed', 'completed'];
const STATUS = {
  'awaiting payment': { label: 'Awaiting payment', step: 'Invoiced', cls: 'b-awaiting', group: 'topay' },
  paid: { label: 'Paid', step: 'Paid', cls: 'b-paid', group: 'progress' },
  packed: { label: 'Packed', step: 'Packed', cls: 'b-packed', group: 'progress' },
  mailed: { label: 'Mailed', step: 'Mailed', cls: 'b-mailed', group: 'progress' },
  completed: { label: 'Completed', step: 'Delivered', cls: 'b-completed', group: 'done' },
  cancelled: { label: 'Cancelled', step: 'Cancelled', cls: 'b-cancelled', group: 'cancelled' },
};
const statusOf = (s) => STATUS[s] || { label: s, step: s, cls: '', group: 'progress' };
const badge = (s) => `<span class="badge ${statusOf(s).cls}">${esc(statusOf(s).label)}</span>`;

const fmtDate = (s, long) => {
  const d = new Date(String(s || '').replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, long ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
};

/* ---------------------------------------------------------------- state --- */

const state = {
  customer: null,
  settings: {},
  orders: [],
  claimFilter: 'all',
  claimQuery: '',
  openOrders: new Set(),
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

const handle = (c) => (c.username ? '@' + c.username : 'No username');
const displayName = (c) => c.firstName || (c.username ? '@' + c.username : 'Telegram user');
const initials = (c) => (c.firstName || c.username || '?').trim().charAt(0);
const telegramUrl = () => (/^https?:\/\//.test(String(state.settings.telegram || '')) ? state.settings.telegram : '');

/* ---------------------------------------------------------- derived data --- */

const liveOrders = () => state.orders.filter((o) => o.status !== 'cancelled');

function claimedItems() {
  const items = [];
  for (const o of state.orders) {
    if (o.status === 'cancelled') continue;
    for (const i of o.items) items.push({ ...i, order: o });
  }
  return items;
}

function stats() {
  const live = liveOrders();
  const owing = live.filter((o) => o.status === 'awaiting payment');
  return {
    owingCount: owing.length,
    owed: owing.reduce((s, o) => s + o.total, 0),
    inTransit: live.filter((o) => statusOf(o.status).group === 'progress').length,
    cards: claimedItems().length,
    spent: live.filter((o) => o.status !== 'awaiting payment').reduce((s, o) => s + o.total, 0),
    completed: live.filter((o) => o.status === 'completed').length,
  };
}

/* -------------------------------------------------------------- pieces --- */

function imgOrPlaceholder(src, alt = '') {
  return src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">` : icon('image');
}

function cardTile(i) {
  const set = [i.set, i.number && '#' + i.number].filter(Boolean).join(' · ');
  return `
    <article class="tcg">
      <div class="tcg-img">${imgOrPlaceholder(i.image, i.name)}${badge(i.order.status)}</div>
      <div class="tcg-body">
        <div class="tcg-name">${esc(i.name)}</div>
        <div class="tcg-set">${esc(set || '—')}</div>
        <div class="tcg-foot">
          <span class="tcg-price num">${money(i.price)}</span>
          ${i.condition ? `<span class="chip">${esc(i.condition)}</span>` : `<span class="tcg-order">${esc(i.order.id)}</span>`}
        </div>
      </div>
    </article>`;
}

function emptyState(ico, title, text, withActions = true) {
  const tg = telegramUrl();
  return `
    <div class="empty">
      <div class="e-ico">${icon(ico)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${
        withActions
          ? `<div class="actions">
              <a class="btn btn-primary" href="/">${icon('bag', 'i-sm')}Shop the store</a>
              ${tg ? `<a class="btn btn-secondary" href="${esc(tg)}" target="_blank" rel="noopener">${icon('send', 'i-sm')}Telegram channel</a>` : ''}
            </div>`
          : ''
      }
    </div>`;
}

function tracker(status) {
  if (status === 'cancelled') {
    return '<div class="cancel-note">This order was cancelled, and its cards have gone back into the store.</div>';
  }
  const at = FLOW.indexOf(status);
  return `<div class="tracker">${FLOW.map((s, i) => {
    const done = i <= at;
    return `<div class="t-step ${done ? 'done' : ''} ${i === at ? 'now' : ''}">
        <div class="t-dot">${done ? icon('check') : i + 1}</div>
        <div class="t-label">${esc(statusOf(s).step)}</div>
      </div>`;
  }).join('')}</div>`;
}

function orderDetail(o) {
  const lines = o.items
    .map((i) => {
      const set = [i.set, i.number && '#' + i.number].filter(Boolean).join(' · ');
      const chips = [i.condition, i.variant].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
      return `<div class="line">
          <div class="th">${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ''}</div>
          <div class="info"><b>${esc(i.name)}</b><span>${esc(set)}</span>${chips ? `<div class="chips">${chips}</div>` : ''}</div>
          <div class="amt num">${money(i.price)}</div>
        </div>`;
    })
    .join('');
  const contact = state.settings.contactTelegram;
  const pay =
    o.status === 'awaiting payment'
      ? `<div class="pay"><b>Payment due.</b> We've sent your invoice on Telegram${contact ? ` from ${esc(contact)}` : ''}. Pay by PayNow, and we'll mark it as paid here.</div>`
      : '';
  return `
    <div class="detail">
      <div>
        ${tracker(o.status)}
        <div class="lines">${lines}</div>
      </div>
      <aside class="summary">
        <h4>Summary</h4>
        <div class="s-row"><span>Placed</span><span>${esc(fmtDate(o.createdAt, true))}</span></div>
        <div class="s-row"><span>Delivery</span><span>${esc(o.delivery || '—')}</span></div>
        <div class="s-row"><span>Subtotal</span><span class="num">${money(o.subtotal)}</span></div>
        ${o.discount ? `<div class="s-row"><span>Discount${o.promoCode ? ` (${esc(o.promoCode)})` : ''}</span><span class="num">−${money(o.discount)}</span></div>` : ''}
        ${o.fee ? `<div class="s-row"><span>Mailing</span><span class="num">${money(o.fee)}</span></div>` : ''}
        <div class="s-row total"><span>Total</span><span class="num">${money(o.total)}</span></div>
        ${pay}
      </aside>
    </div>`;
}

function thumbs(items) {
  const shown = items.slice(0, 3).map((i) => `<span>${i.image ? `<img src="${esc(i.image)}" alt="">` : ''}</span>`).join('');
  return `<div class="thumbs">${shown}<em>${plural(items.length, 'card')}</em></div>`;
}

/* ---------------------------------------------------------------- views --- */

function viewOverview() {
  const s = stats();
  const c = state.customer;
  const items = claimedItems();
  const recent = state.orders.slice(0, 5);
  const tg = telegramUrl();
  const contact = state.settings.contactTelegram;

  return `
    <div class="page-head">
      <div>
        <h1>Welcome back, ${esc(c.firstName || handle(c))}</h1>
        <p>Track your Telegram claims and store orders, or shop new cards any time.</p>
      </div>
      <div class="actions">
        ${tg ? `<a class="btn btn-secondary" href="${esc(tg)}" target="_blank" rel="noopener">${icon('send', 'i-sm')}Telegram channel</a>` : ''}
        <a class="btn btn-primary" href="/">${icon('bag', 'i-sm')}Shop the store</a>
      </div>
    </div>

    ${
      s.owingCount
        ? `<div class="alert">
            <div class="ico">${icon('wallet')}</div>
            <div class="txt"><b>${money(s.owed)} due across ${plural(s.owingCount, 'order')}.</b>
              Your invoice is on Telegram${contact ? ` from ${esc(contact)}` : ''}. Pay by PayNow to secure your cards.</div>
            <a class="btn btn-secondary" href="#orders">View orders</a>
          </div>`
        : ''
    }

    <section class="kpis">
      <div class="kpi ${s.owingCount ? 'warn' : ''}">
        <div class="kpi-top">Amount due<span class="kpi-ico">${icon('wallet')}</span></div>
        <div class="kpi-val num">${money(s.owed)}</div>
        <div class="kpi-foot">${s.owingCount ? plural(s.owingCount, 'unpaid order') : 'Nothing to pay'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-top">In progress<span class="kpi-ico">${icon('truck')}</span></div>
        <div class="kpi-val num">${s.inTransit}</div>
        <div class="kpi-foot">Paid and on the way</div>
      </div>
      <div class="kpi">
        <div class="kpi-top">Cards claimed<span class="kpi-ico">${icon('layers')}</span></div>
        <div class="kpi-val num">${s.cards}</div>
        <div class="kpi-foot">Across ${plural(liveOrders().length, 'order')}</div>
      </div>
      <div class="kpi">
        <div class="kpi-top">Total spent<span class="kpi-ico">${icon('checkCircle')}</span></div>
        <div class="kpi-val num">${money(s.spent)}</div>
        <div class="kpi-foot">${plural(s.completed, 'order')} delivered</div>
      </div>
    </section>

    <div class="cols">
      <section class="panel">
        <div class="panel-head">
          <div><h3>Recent claims</h3><p>Your latest cards from Telegram and the store</p></div>
          ${items.length ? `<a class="link" href="#claims">View all ${icon('arrow', 'i-sm')}</a>` : ''}
        </div>
        ${
          items.length
            ? `<div class="panel-body"><div class="grid compact">${items.slice(0, 4).map(cardTile).join('')}</div></div>`
            : emptyState('layers', 'No cards yet', 'Claim a card in our Telegram channel or buy one from the store, and it will show up here.')
        }
      </section>

      <div class="stack">
        <section class="panel">
          <div class="panel-head"><div><h3>Order activity</h3></div>${recent.length ? `<a class="link" href="#orders">All orders</a>` : ''}</div>
          ${
            recent.length
              ? `<ul class="activity">${recent
                  .map(
                    (o) => `<li><a href="#orders" data-open-order="${esc(o.id)}">
                      <span class="a-ico">${icon('package')}</span>
                      <span class="a-main"><b>${esc(o.id)}</b><span>${esc(fmtDate(o.createdAt))} · ${plural(o.items.length, 'card')}</span></span>
                      <span class="a-side"><b class="num">${money(o.total)}</b>${badge(o.status)}</span>
                    </a></li>`
                  )
                  .join('')}</ul>`
              : `<div class="panel-body muted" style="font-size:13px">No orders yet.</div>`
          }
        </section>

        <section class="promo">
          <div class="eyebrow">Online store · Open 24/7</div>
          <h3>Shop between claim sales</h3>
          <p>Browse our full range of vintage singles any time. Same PayNow payment and Tracked Mailing as our Telegram sales.</p>
          <a class="btn" href="/">Browse the store ${icon('arrow', 'i-sm')}</a>
          <img src="${esc(window.CTCG_LOGO)}" alt="">
        </section>
      </div>
    </div>`;
}

const CLAIM_FILTERS = [
  ['all', 'All'],
  ['topay', 'To pay'],
  ['progress', 'In progress'],
  ['done', 'Completed'],
];

function filteredClaims() {
  const q = state.claimQuery.trim().toLowerCase();
  return claimedItems().filter((i) => {
    if (state.claimFilter !== 'all' && statusOf(i.order.status).group !== state.claimFilter) return false;
    if (!q) return true;
    return [i.name, i.set, i.number, i.order.id].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function claimsGridHtml() {
  const list = filteredClaims();
  if (list.length) return `<div class="grid">${list.map(cardTile).join('')}</div>`;
  if (!claimedItems().length) {
    return `<div class="panel">${emptyState('layers', 'No claims yet', 'Cards you win in a Telegram claim sale, or buy from the store, will show up here.')}</div>`;
  }
  return `<div class="panel">${emptyState('search', 'No matching cards', 'Try a different filter or search term.', false)}</div>`;
}

function viewClaims() {
  const all = claimedItems();
  const count = (g) => (g === 'all' ? all.length : all.filter((i) => statusOf(i.order.status).group === g).length);
  return `
    <div class="page-head">
      <div><h1>My claims</h1><p>Every card you've claimed or bought, and its current status.</p></div>
    </div>
    <div class="toolbar">
      <div class="seg" role="tablist">
        ${CLAIM_FILTERS.map(
          ([k, l]) => `<button role="tab" aria-selected="${state.claimFilter === k}" class="${state.claimFilter === k ? 'on' : ''}" data-filter="${k}">${l}<span class="n">${count(k)}</span></button>`
        ).join('')}
      </div>
      <label class="search">${icon('search')}<input id="claimSearch" type="search" placeholder="Search cards, sets or order IDs" value="${esc(state.claimQuery)}" aria-label="Search claims"></label>
    </div>
    <div id="claimGrid">${claimsGridHtml()}</div>`;
}

function viewOrders() {
  const rows = state.orders
    .map((o) => {
      const open = state.openOrders.has(o.id);
      return `
        <tr class="order-row ${open ? 'open' : ''}" data-toggle-order="${esc(o.id)}" aria-expanded="${open}">
          <td><span class="oid">${esc(o.id)}</span></td>
          <td class="hide-xs muted">${esc(fmtDate(o.createdAt))}</td>
          <td class="hide-sm">${thumbs(o.items)}</td>
          <td class="hide-sm muted">${esc(o.delivery || '—')}</td>
          <td>${badge(o.status)}</td>
          <td class="r num"><b>${money(o.total)}</b></td>
          <td class="r" style="width:44px"><span class="row-btn" aria-hidden="true">${icon('chevron', 'i-sm')}</span></td>
        </tr>
        ${open ? `<tr class="detail-row"><td colspan="7">${orderDetail(o)}</td></tr>` : ''}`;
    })
    .join('');

  return `
    <div class="page-head">
      <div><h1>Orders</h1><p>Check payment, packing and delivery for each order. Tap an order to see its details.</p></div>
      <div class="actions"><a class="btn btn-secondary" href="/">${icon('bag', 'i-sm')}Shop the store</a></div>
    </div>
    <section class="panel">
      ${
        state.orders.length
          ? `<table class="table">
              <thead><tr>
                <th>Order</th><th class="hide-xs">Placed</th><th class="hide-sm">Items</th><th class="hide-sm">Delivery</th>
                <th>Status</th><th class="r">Total</th><th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : emptyState('receipt', 'No orders yet', 'When you claim or buy cards, your orders and their progress will show up here.')
      }
    </section>`;
}

function viewProfile() {
  const c = state.customer;
  const s = stats();
  return `
    <div class="page-head">
      <div><h1>Profile</h1><p>Your account details and how claims work.</p></div>
    </div>
    <div class="cols">
      <div class="stack">
        <section class="panel">
          <div class="profile-card">
            <span class="avatar avatar-lg">${esc(initials(c))}</span>
            <div>
              <h2>${esc(displayName(c))}</h2>
              <p>${esc(handle(c))}</p>
              <span class="connected">${icon('send', 'i-sm')}Connected with Telegram</span>
            </div>
          </div>
          <dl class="dl">
            <div><dt>Orders</dt><dd class="num">${state.orders.length}</dd></div>
            <div><dt>Cards claimed</dt><dd class="num">${s.cards}</dd></div>
            <div><dt>Total spent</dt><dd class="num">${money(s.spent)}</dd></div>
          </dl>
        </section>
        <section class="panel">
          <div class="panel-head"><div><h3>How claims work</h3></div></div>
          <ol class="steps">
            <li><div><b>Claim a card</b><span>Reply "claim" on any card during a Telegram claim sale.</span></div></li>
            <li><div><b>Get your invoice</b><span>We send your total on Telegram, and the card appears under My claims.</span></div></li>
            <li><div><b>Pay by PayNow</b><span>Once we confirm your payment, your order is marked as Paid.</span></div></li>
            <li><div><b>Packed and mailed</b><span>Track each step on the Orders page until your cards arrive.</span></div></li>
          </ol>
          ${c.username ? '' : '<div class="tip">Tip: Set a Telegram username so we can link claims under your handle to this account.</div>'}
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><h3>Logged in</h3><p>You're logged in with Telegram on this device.</p></div></div>
        <div class="panel-body"><button class="btn btn-secondary btn-block" id="logoutBtn">${icon('logout', 'i-sm')}Log out</button></div>
      </section>
    </div>`;
}

const VIEWS = {
  overview: { title: 'Overview', render: viewOverview },
  claims: { title: 'My claims', render: viewClaims },
  orders: { title: 'Orders', render: viewOrders },
  profile: { title: 'Profile', render: viewProfile },
};

/* ---------------------------------------------------------------- shell --- */

function shellHtml() {
  const c = state.customer;
  const tg = telegramUrl();
  const nav = (key, ico, label, extra = '') =>
    `<a href="#${key}" data-view="${key}">${icon(ico)}${label}${extra}</a>`;
  return `
    <div class="shell">
      <aside class="side" id="side">
        <a class="side-head" href="/">
          <img src="${esc(window.CTCG_LOGO)}" alt="">
          <span><b>Crazed TCG</b><small>Store &amp; claims</small></span>
        </a>
        <nav class="nav" aria-label="Account">
          <div class="nav-group">
            <div class="nav-label">Account</div>
            ${nav('overview', 'dashboard', 'Overview')}
            ${nav('claims', 'layers', 'My claims', `<span class="count" id="claimCount">${claimedItems().length}</span>`)}
            ${nav('orders', 'receipt', 'Orders', `<span class="count">${state.orders.length}</span>`)}
            ${nav('profile', 'user', 'Profile')}
          </div>
          <div class="nav-group">
            <div class="nav-label">Shop</div>
            <a href="/">${icon('bag')}Online store<span class="live-dot">Open</span></a>
            ${tg ? `<a href="${esc(tg)}" target="_blank" rel="noopener">${icon('send')}Telegram channel<span class="ext">${icon('external', 'i-sm')}</span></a>` : ''}
          </div>
        </nav>
        <div class="side-foot">
          <a class="user" href="#profile">
            <span class="avatar">${esc(initials(c))}</span>
            <span class="user-meta"><b>${esc(displayName(c))}</b><span>${esc(handle(c))}</span></span>
          </a>
        </div>
      </aside>
      <div class="scrim" id="scrim"></div>
      <div class="main">
        <header class="topbar">
          <button class="menu-btn" id="menuBtn" aria-label="Open menu">${icon('menu')}</button>
          <div class="crumbs"><span>My account</span><span>/</span><b id="crumb">Overview</b></div>
          <a class="btn btn-ghost hide-xs" href="/">${icon('bag', 'i-sm')}Store</a>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;
}

function gateHtml(botId) {
  const ticks = [
    'Shop vintage Pokémon singles any day of the week',
    "See every card you've claimed in our Telegram channel",
    'Check what you owe and track your orders',
  ];
  return `
    <div class="gate">
      <section class="gate-brand">
        <div class="logo-row"><img src="${esc(window.CTCG_LOGO)}" alt="">Crazed TCG</div>
        <div>
          <h2>Shop the store.<br>Track your claims.</h2>
          <p class="lede">Your Crazed TCG account is home to our online store and every card you claim on Telegram.</p>
          <ul class="ticks">${ticks.map((t) => `<li>${icon('checkCircle')}${t}</li>`).join('')}</ul>
        </div>
        <div class="gate-foot">Vintage Pokémon singles · PayNow · Tracked Mailing</div>
      </section>
      <section class="gate-form">
        <div class="gate-card">
          <img class="mobile-logo" src="${esc(window.CTCG_LOGO)}" alt="Crazed TCG">
          <h1>Welcome to Crazed TCG</h1>
          <p class="sub">Log in with the Telegram account you use for claims, and we'll show all your cards and orders here.</p>
          <a class="btn btn-lg btn-block btn-tg" id="gateLogin" href="${botId ? esc(loginUrl(botId)) : '#'}">${icon('send')}Log in with Telegram</a>
          <div class="divider">Or</div>
          <a class="btn btn-lg btn-block btn-secondary" href="/">${icon('bag', 'i-sm')}Just browsing? Shop the store</a>
          <p class="fine">We never share your Telegram details.</p>
        </div>
      </section>
    </div>`;
}

function render() {
  const key = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  const view = VIEWS[key];
  $('#crumb').textContent = view.title;
  $('#content').innerHTML = view.render();
  document.title = `${view.title} — Crazed TCG`;
  document.querySelectorAll('.nav a[data-view]').forEach((a) => {
    const on = a.dataset.view === key;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  setMenu(false);
}

function setMenu(open) {
  $('#side').classList.toggle('open', open);
  $('#scrim').classList.toggle('open', open);
}

function bindShell() {
  const app = $('#app');
  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });
  $('#menuBtn').onclick = () => setMenu(true);
  $('#scrim').onclick = () => setMenu(false);

  app.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) {
      state.claimFilter = f.dataset.filter;
      render();
      return;
    }
    const row = e.target.closest('[data-toggle-order]');
    if (row) {
      const id = row.dataset.toggleOrder;
      state.openOrders.has(id) ? state.openOrders.delete(id) : state.openOrders.add(id);
      render();
      return;
    }
    const jump = e.target.closest('[data-open-order]');
    if (jump) state.openOrders.add(jump.dataset.openOrder);
    if (e.target.closest('#logoutBtn')) {
      await api('/api/customer/logout', { method: 'POST', body: '{}' }).catch(() => {});
      location.href = '/account';
    }
  });

  // Search re-renders only the grid so the input keeps focus while typing.
  app.addEventListener('input', (e) => {
    if (e.target.id !== 'claimSearch') return;
    state.claimQuery = e.target.value;
    $('#claimGrid').innerHTML = claimsGridHtml();
  });
}

/* ---------------------------------------------------------------- login --- */

function loginUrl(botId) {
  return (
    'https://oauth.telegram.org/auth' +
    `?bot_id=${encodeURIComponent(botId)}` +
    `&origin=${encodeURIComponent(location.origin)}` +
    '&request_access=write' +
    `&return_to=${encodeURIComponent(location.origin + '/account')}`
  );
}

/** Telegram sends the buyer back with the signed login data in the URL fragment. */
async function completeTelegramRedirect() {
  const match = /tgAuthResult=([A-Za-z0-9+/=_-]+)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const res = await api('/api/customer/login', { method: 'POST', body: JSON.stringify(data) });
    return res.customer;
  } catch {
    toast("Telegram login couldn't be completed. Please try again.");
    return null;
  }
}

/* ----------------------------------------------------------------- boot --- */

async function boot() {
  const fromRedirect = await completeTelegramRedirect();
  const me = await api('/api/customer/me').catch(() => ({}));
  state.customer = fromRedirect || me.customer || null;

  if (!state.customer) {
    $('#app').innerHTML = gateHtml(me.botId);
    if (!me.botId) {
      $('#gateLogin').addEventListener('click', (e) => {
        e.preventDefault();
        toast("Telegram login isn't set up yet.");
      });
    }
    return;
  }

  const [settings, orders] = await Promise.all([
    api('/api/settings').catch(() => ({})),
    api('/api/customer/orders').catch((err) => {
      toast(err.message);
      return [];
    }),
  ]);
  state.settings = settings;
  state.orders = orders;

  $('#app').innerHTML = shellHtml();
  bindShell();
  render();
}

boot();
