'use strict';

/* Crazed TCG seller admin. Every action is a call to /api/admin/*, which is
   session-guarded on the server — nothing here is trusted. */

const LOGO = '/img/logo-460.jpg';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let productCache = [];
let orderCache = [];
let apiResultCache = [];

const INVENTORY_PAGE_SIZE = 30;
let inventoryPage = 1;
const ORDERS_PAGE_SIZE = 30;
let ordersPage = 1;

/** Renders a shared Prev/Next pager into `el`, calling `onPage(n)` when a page is picked. */
function renderPager(el, page, totalPages, onPage) {
  if (totalPages <= 1) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <button data-pager-prev ${page === 1 ? 'disabled' : ''}>&larr; Prev</button>
    <span class="small muted">Page ${page} of ${totalPages}</span>
    <button data-pager-next ${page === totalPages ? 'disabled' : ''}>Next &rarr;</button>`;
  if (page > 1) el.querySelector('[data-pager-prev]').onclick = () => onPage(page - 1);
  if (page < totalPages) el.querySelector('[data-pager-next]').onclick = () => onPage(page + 1);
}

/* ------------------------------------------------------------- helpers --- */

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

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
  toast._timer = setTimeout(() => t.classList.remove('show'), isError ? 4500 : 2000);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });

  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('Session expired');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

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

/* ------------------------------------------------------------ dashboard --- */

async function loadStats() {
  try {
    const s = await api('/api/admin/stats');
    $('#statLive').textContent = s.live;
    $('#statReserved').textContent = s.reserved;
    $('#statOrders').textContent = s.pending;
    $('#statSales').textContent = money(s.sales);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderRecentOrders() {
  $('#recentOrders').innerHTML = orderCache.length
    ? orderCache
        .slice(0, 5)
        .map(
          (o) => `<tr>
            <td>${esc(o.id)}</td>
            <td>${esc(o.buyer)}</td>
            <td>${money(o.total)}</td>
            <td><span class="status order-${slug(o.status)}">${esc(o.status)}</span></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No orders yet.</td></tr>';
}

/* ------------------------------------------------------------ analytics --- */

let analyticsDays = '7';

function formatShortDate(iso) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [, m, d] = iso.split('-').map(Number);
  return `${months[m - 1]} ${d}`;
}

/** Hand-rolled inline SVG bar chart — no charting library, matches how the rest of this
    dependency-free app builds its UI. A native <title> per bar gives a free hover tooltip.
    `valueFn` picks the bar height per day, `tooltipFn` formats its <title>. */
function svgBarChart(daily, valueFn, tooltipFn) {
  if (!daily.length) return '<div class="empty">No data for this range.</div>';

  const max = Math.max(1, ...daily.map(valueFn));
  const barW = 14;
  const gap = 4;
  const height = 160;
  const plotH = height - 24;
  const width = daily.length * (barW + gap);
  const labelEvery = Math.max(1, Math.ceil(daily.length / 10));

  const bars = daily
    .map((d, i) => {
      const v = valueFn(d);
      const h = v > 0 ? Math.max(2, Math.round((v / max) * plotH)) : 0;
      const x = i * (barW + gap);
      const y = plotH - h;
      const label = i % labelEvery === 0 || i === daily.length - 1 ? formatShortDate(d.date) : '';
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2">
        <title>${tooltipFn(d)}</title>
      </rect>
      ${label ? `<text x="${x + barW / 2}" y="${height - 6}" font-size="9" text-anchor="middle">${esc(label)}</text>` : ''}`;
    })
    .join('');

  return `<div class="an-chart"><svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px;height:${height}px">${bars}</svg></div>`;
}

function renderAnalytics(data) {
  $('#anRevenue').textContent = money(data.summary.revenue);
  $('#anOrders').textContent = data.summary.orders;
  $('#anAvgOrder').textContent = money(data.summary.avgOrderValue);
  $('#anUnits').textContent = data.summary.unitsSold;
  $('#anVisitors').textContent = data.summary.visitors;
  $('#anPageViews').textContent = data.summary.pageViews;

  $('#anChartRange').textContent = data.range.from
    ? `${data.range.from} to ${data.range.to}`
    : `Through ${data.range.to}`;
  $('#anChart').innerHTML = svgBarChart(
    data.daily,
    (d) => d.revenue,
    (d) => `${esc(d.date)}: ${money(d.revenue)} (${d.orders} order${d.orders === 1 ? '' : 's'})`
  );
  $('#anVisitorsChart').innerHTML = svgBarChart(
    data.daily,
    (d) => d.visitors,
    (d) => `${esc(d.date)}: ${d.visitors} visitor${d.visitors === 1 ? '' : 's'} (${d.pageViews} view${d.pageViews === 1 ? '' : 's'})`
  );

  $('#anTopCards').innerHTML = data.topCards.length
    ? data.topCards
        .map(
          (c) => `<tr>
      <td>${esc(c.name)}<div class="small muted">${esc(c.number)}</div></td>
      <td>${esc(c.set)}</td>
      <td>${c.unitsSold}</td>
      <td>${money(c.revenue)}</td>
    </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No sales in this range yet.</td></tr>';

  $('#anTopSets').innerHTML = data.topSets.length
    ? data.topSets
        .map(
          (s) => `<tr>
      <td>${esc(s.set)}</td>
      <td>${s.unitsSold}</td>
      <td>${money(s.revenue)}</td>
    </tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="muted">No sales in this range yet.</td></tr>';

  const statusTotal = data.statusBreakdown.reduce((sum, r) => sum + r.n, 0) || 1;
  $('#anStatusBreakdown').innerHTML = data.statusBreakdown.length
    ? [...data.statusBreakdown]
        .sort((a, b) => b.n - a.n)
        .map(
          (r) => `<div class="an-status-row">
      <span class="status order-${slug(r.status)}">${esc(r.status)}</span>
      <div class="an-status-bar"><span style="width:${Math.round((r.n / statusTotal) * 100)}%"></span></div>
      <span class="small muted">${r.n}</span>
    </div>`
        )
        .join('')
    : '<div class="empty">No orders in this range.</div>';
}

async function loadAnalytics() {
  try {
    const data = await api(`/api/admin/analytics?days=${analyticsDays}`);
    renderAnalytics(data);
  } catch (err) {
    toast(err.message, true);
  }
}

$$('#analyticsRange button').forEach((b) => {
  b.onclick = () => {
    analyticsDays = b.dataset.days;
    $$('#analyticsRange button').forEach((x) => x.classList.toggle('active', x === b));
    loadAnalytics();
  };
});

/* -------------------------------------------------------------- products --- */

async function loadProducts() {
  try {
    productCache = await api('/api/admin/products');
    renderSetFilterOptions();
    renderInventory();
  } catch (err) {
    toast(err.message, true);
  }
}

let inventoryView = localStorage.getItem('ctcg_inventory_view') === 'grid' ? 'grid' : 'list';

/** Rebuilds the set dropdown from whatever sets exist right now, keeping the current pick if it still exists. */
function renderSetFilterOptions() {
  const current = $('#adminSetFilter').value;
  const sets = [...new Set(productCache.map((p) => p.set).filter(Boolean))].sort();

  $('#adminSetFilter').innerHTML =
    '<option value="">All sets</option>' +
    sets.map((s) => `<option${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
}

function rowActionsHtml(p) {
  return `<div class="row-actions">
    <button data-edit="${esc(p.id)}">Edit</button>
    <button data-toggle="${esc(p.id)}">${p.status === 'live' ? 'Hide' : 'Set Live'}</button>
    <button data-delete="${esc(p.id)}">Delete</button>
  </div>`;
}

function wireRowActions() {
  $$('[data-edit]').forEach((b) => (b.onclick = () => openProductModal(b.dataset.edit)));
  $$('[data-toggle]').forEach((b) => (b.onclick = () => toggleVisibility(b.dataset.toggle)));
  $$('[data-delete]').forEach((b) => (b.onclick = () => removeProduct(b.dataset.delete)));
}

function renderInventoryList(list, q) {
  const totalPages = Math.max(1, Math.ceil(list.length / INVENTORY_PAGE_SIZE));
  if (inventoryPage > totalPages) inventoryPage = totalPages;
  const pageItems = list.slice(
    (inventoryPage - 1) * INVENTORY_PAGE_SIZE,
    inventoryPage * INVENTORY_PAGE_SIZE
  );

  $('#inventoryBody').innerHTML = pageItems.length
    ? pageItems
        .map(
          (p) => `<tr>
      <td><img src="${esc(p.image || LOGO)}" alt="" style="width:30px;height:40px;object-fit:contain" onerror="this.onerror=null;this.src='${LOGO}'"></td>
      <td>${esc(p.name)}<div class="small muted">${esc(p.number)}</div></td>
      <td>${esc(p.set)}</td>
      <td>${esc(p.condition)}</td>
      <td>${p.variant && p.variant !== 'Normal' ? esc(p.variant) : '<span class="muted">Normal</span>'}</td>
      <td>${money(p.price)}</td>
      <td>${p.qty}</td>
      <td><span class="status status-${esc(p.status)}">${esc(p.status)}</span></td>
      <td>${rowActionsHtml(p)}</td>
    </tr>`
        )
        .join('')
    : `<tr><td colspan="9" class="muted">${
        q ? 'No products match that search.' : 'No products yet — add your first card.'
      }</td></tr>`;

  renderPager($('#inventoryPagination'), inventoryPage, totalPages, (page) => {
    inventoryPage = page;
    renderInventory();
  });
}

function invCardHtml(p) {
  return `<article class="product inv-card">
    <div class="product-image">
      <img src="${esc(p.image || LOGO)}" alt="" onerror="this.onerror=null;this.src='${LOGO}'">
      <span class="price">${money(p.price)}</span>
    </div>
    <h3>${esc(p.name)}</h3>
    <div class="meta">${esc(p.number)}</div>
    <div class="tags">
      <span class="tag">${esc(p.condition)}</span>
      ${p.variant && p.variant !== 'Normal' ? `<span class="tag">${esc(p.variant)}</span>` : ''}
      <span class="status status-${esc(p.status)}">${esc(p.status)}</span>
      <span class="tag">qty ${p.qty}</span>
    </div>
    ${rowActionsHtml(p)}
  </article>`;
}

/** Which sets start collapsed, remembered across visits by set name. */
function collapsedSets() {
  try {
    return JSON.parse(localStorage.getItem('ctcg_inventory_collapsed') || '{}');
  } catch {
    return {};
  }
}

function renderInventoryGrid(list, q) {
  if (!list.length) {
    $('#inventoryGridView').innerHTML = `<div class="empty">${
      q ? 'No products match that search.' : 'No products yet — add your first card.'
    }</div>`;
    return;
  }

  const groups = new Map();
  list.forEach((p) => {
    const key = p.set || '(No set)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  const collapsed = collapsedSets();

  // A set the seller has never touched starts collapsed — otherwise a big catalogue
  // renders every card in every group by default, same "page too long" problem as
  // the old flat list had.
  $('#inventoryGridView').innerHTML = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([set, items]) => `
      <div class="set-group${collapsed[set] !== false ? ' collapsed' : ''}" data-set-group="${esc(set)}">
        <div class="set-group-head">
          <h3>${esc(set)} <span class="muted small">(${items.length})</span></h3>
          <span class="chev">&#9660;</span>
        </div>
        <div class="set-group-grid grid">${items.map(invCardHtml).join('')}</div>
      </div>`
    )
    .join('');

  $$('.set-group-head').forEach((head) => {
    head.onclick = () => {
      const group = head.closest('.set-group');
      group.classList.toggle('collapsed');
      const state = collapsedSets();
      state[group.dataset.setGroup] = group.classList.contains('collapsed');
      localStorage.setItem('ctcg_inventory_collapsed', JSON.stringify(state));
    };
  });
}

function applyInventoryView() {
  $$('.view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === inventoryView));
  $('#inventoryListView').classList.toggle('hidden', inventoryView !== 'list');
  $('#inventoryGridView').classList.toggle('hidden', inventoryView !== 'grid');
}

function renderInventory() {
  const q = ($('#adminProductSearch').value || '').trim().toLowerCase();
  const set = $('#adminSetFilter').value;
  const list = productCache.filter(
    (p) =>
      (!q || `${p.name} ${p.set} ${p.number} ${p.variant}`.toLowerCase().includes(q)) &&
      (!set || p.set === set)
  );

  if (inventoryView === 'grid') {
    $('#inventoryPagination').innerHTML = '';
    renderInventoryGrid(list, q);
  } else {
    renderInventoryList(list, q);
  }

  wireRowActions();
}

$$('.view-toggle button').forEach((b) => {
  b.onclick = () => {
    inventoryView = b.dataset.view;
    localStorage.setItem('ctcg_inventory_view', inventoryView);
    applyInventoryView();
    renderInventory();
  };
});
applyInventoryView();

async function toggleVisibility(id) {
  const p = productCache.find((x) => x.id === id);
  if (!p) return;
  try {
    await api(`/api/admin/products/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...p, status: p.status === 'live' ? 'hidden' : 'live' }),
    });
    await Promise.all([loadProducts(), loadStats()]);
    toast('Storefront updated');
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeProduct(id) {
  const p = productCache.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Delete "${p.name}"? Past orders keep their own copy of the details.`)) return;
  try {
    await api(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadProducts(), loadStats()]);
    toast('Product deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------- product form --- */

let pendingUpload = null;

function resetProductForm() {
  [
    'productId', 'productName', 'productSet', 'productNumber', 'productPrice',
    'productImageUrl', 'productNotes', 'productArtist', 'apiName', 'apiSet', 'apiNumber',
  ].forEach((id) => ($('#' + id).value = ''));

  $('#productCondition').value = 'NM';
  $('#productVariant').value = 'Normal';
  $('#productQty').value = 1;
  $('#productStatus').value = 'live';
  $('#productImageFile').value = '';
  $('#productPreview').src = LOGO;
  $('#apiResults').innerHTML = '';
  $('#productError').classList.add('hidden');
  $('#productModalTitle').textContent = 'Add Product';
  pendingUpload = null;
  apiResultCache = [];
}

function openProductModal(id) {
  resetProductForm();

  if (id) {
    const p = productCache.find((x) => x.id === id);
    if (!p) return;
    $('#productModalTitle').textContent = 'Edit Product';
    $('#productId').value = p.id;
    $('#productName').value = p.name;
    $('#productSet').value = p.set;
    $('#productNumber').value = p.number;
    $('#productCondition').value = p.condition;
    $('#productVariant').value = p.variant || 'Normal';
    $('#productPrice').value = p.price;
    $('#productQty').value = p.qty;
    $('#productStatus').value = p.status;
    $('#productImageUrl').value = p.image;
    $('#productNotes').value = p.notes || '';
    $('#productArtist').value = p.artist || '';
    $('#productPreview').src = p.image || LOGO;
  }
  openModal('#productModal');
}

async function saveProduct() {
  const button = $('#saveProduct');
  const errorBox = $('#productError');
  errorBox.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    // Upload the chosen photo first so we can store a real URL on the product.
    let image = $('#productImageUrl').value.trim();
    if (pendingUpload) {
      const form = new FormData();
      form.append('image', pendingUpload);
      const uploaded = await api('/api/admin/upload', { method: 'POST', body: form });
      image = uploaded.url;
    }

    const id = $('#productId').value;
    const payload = {
      name: $('#productName').value.trim(),
      set: $('#productSet').value.trim(),
      number: $('#productNumber').value.trim(),
      condition: $('#productCondition').value,
      variant: $('#productVariant').value,
      price: $('#productPrice').value,
      qty: $('#productQty').value,
      status: $('#productStatus').value,
      image,
      notes: $('#productNotes').value.trim(),
      artist: $('#productArtist').value.trim(),
    };

    if (id) {
      await api(`/api/admin/products/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) });
    }

    closeModals();
    await Promise.all([loadProducts(), loadStats()]);
    toast('Product saved — storefront updated');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Save Product';
  }
}

$('#productImageFile').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    toast('Image must be under 6 MB.', true);
    e.target.value = '';
    return;
  }
  pendingUpload = file;
  const reader = new FileReader();
  reader.onload = () => ($('#productPreview').src = reader.result);
  reader.readAsDataURL(file);
};

$('#clearUploadedImage').onclick = () => {
  pendingUpload = null;
  $('#productImageFile').value = '';
  $('#productImageUrl').value = '';
  $('#productPreview').src = LOGO;
};

$('#productImageUrl').oninput = (e) => {
  if (!pendingUpload) $('#productPreview').src = e.target.value.trim() || LOGO;
};

/* ----------------------------------------------------------- bulk import --- */

const MATCH_LABEL = {
  exact: ['status-live', 'exact match'],
  number: ['status-live', 'matched by number'],
  set: ['status-reserved', 'matched by set'],
  'name-only': ['status-reserved', 'name only — check it'],
  ambiguous: ['status-reserved', 'ambiguous — check the art'],
  none: ['status-sold', 'no match'],
};

function bulkFormData(commit) {
  const file = $('#bulkFile').files[0];
  if (!file) throw new Error('Choose a CSV file first.');

  const form = new FormData();
  form.append('file', file);
  form.append('commit', commit ? 'true' : 'false');
  form.append('fetchImages', $('#bulkFetchImages').checked ? 'true' : 'false');
  form.append('skipDuplicates', $('#bulkSkipDuplicates').checked ? 'true' : 'false');
  return form;
}

function renderBulkPreview(data) {
  const c = data.counts;

  const warnings = [];
  if (data.rateLimited) {
    warnings.push(
      'The Pok&eacute;mon TCG API rate-limited us part way through, so some images are missing. ' +
        'Import anyway and fill them in later, or add a free POKEMON_TCG_API_KEY to .env.'
    );
  }
  if (!data.apiKey && $('#bulkFetchImages').checked) {
    warnings.push(
      'Running without a POKEMON_TCG_API_KEY: about 1,000 lookups a day. ' +
        'A free key at dev.pokemontcg.io raises that to 20,000.'
    );
  }

  $('#bulkResult').innerHTML = `
    <div class="stats" style="margin-bottom:14px">
      <div class="stat"><span>Rows read</span><strong>${c.total}</strong></div>
      <div class="stat"><span>Will import</span><strong>${c.importable}</strong></div>
      <div class="stat"><span>Images found</span><strong>${c.imagesFound}</strong></div>
      <div class="stat"><span>Skipped</span><strong>${c.invalid + c.duplicates}</strong></div>
    </div>

    ${warnings.map((w) => `<div class="notice warn" style="margin-bottom:10px">${w}</div>`).join('')}

    ${
      c.invalid
        ? `<div class="notice error" style="margin-bottom:10px"><b>${c.invalid}</b> row${
            c.invalid === 1 ? '' : 's'
          } cannot be imported — see the red rows below. Fix them in your spreadsheet and re-upload.</div>`
        : ''
    }
    ${
      c.duplicates
        ? `<div class="notice" style="margin-bottom:10px"><b>${c.duplicates}</b> row${
            c.duplicates === 1 ? ' looks' : 's look'
          } like cards you already have. ${
            $('#bulkSkipDuplicates').checked
              ? 'They will be skipped.'
              : 'They WILL be imported again — untick "skip duplicates" only if you mean it.'
          }</div>`
        : ''
    }

    <div class="panel"><div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Img</th><th>Card</th><th>Set</th><th>Cond.</th><th>Variant</th><th>Price</th><th>Qty</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>${data.rows.map(bulkRow).join('')}</tbody>
      </table>
    </div></div>

    <div class="actions" style="justify-content:flex-end;margin-top:16px">
      <button class="btn modal-close" type="button">Cancel</button>
      <button class="btn primary" id="bulkCommit" type="button" ${c.importable ? '' : 'disabled'}>
        Import ${c.importable} Card${c.importable === 1 ? '' : 's'}
      </button>
    </div>`;

  const commitButton = $('#bulkCommit');
  if (commitButton) commitButton.onclick = commitBulkImport;
  $$('#bulkResult .modal-close').forEach((b) => (b.onclick = closeModals));
}

function bulkRow(r) {
  let result;
  if (r.errors.length) {
    result = `<span class="status status-sold">${esc(r.errors.join('; '))}</span>`;
  } else if (r.duplicate && $('#bulkSkipDuplicates').checked) {
    result = '<span class="status status-hidden">duplicate, skipping</span>';
  } else if (r.duplicate) {
    result = '<span class="status status-reserved">duplicate, importing anyway</span>';
  } else if (r.setMismatch) {
    result = `<span class="status status-sold">set differs &mdash; API says "${esc(r.matchedSet)}"</span>`;
  } else if (r.imageMatch) {
    const [cls, label] = MATCH_LABEL[r.imageMatch] || ['status-draft', r.imageMatch];
    result = `<span class="status ${cls}">${esc(label)}</span>`;
  } else {
    result = '<span class="status status-live">ready</span>';
  }

  const price =
    r.marketPrice != null && r.price === 0
      ? `<span class="muted">${money(r.price)}</span><div class="small muted">mkt ${money(r.marketPrice)}</div>`
      : money(r.price);

  return `<tr${r.errors.length ? ' style="background:#fdf5f4"' : ''}>
    <td class="muted">${r.line}</td>
    <td>${
      r.image
        ? `<img src="${esc(r.image)}" alt="" style="width:30px;height:40px;object-fit:contain">`
        : '<span class="muted small">—</span>'
    }</td>
    <td>${esc(r.name) || '<span class="muted">(no name)</span>'}<div class="small muted">${esc(r.number)}</div></td>
    <td>${esc(r.set)}</td>
    <td>${esc(r.condition)}</td>
    <td>${esc(r.variant)}</td>
    <td>${price}</td>
    <td>${r.qty}</td>
    <td><span class="status status-${esc(r.status)}">${esc(r.status)}</span></td>
    <td>${result}</td>
  </tr>`;
}

$('#bulkPreview').onclick = async () => {
  const button = $('#bulkPreview');
  button.disabled = true;
  button.textContent = $('#bulkFetchImages').checked ? 'Reading CSV and looking up images…' : 'Reading CSV…';
  $('#bulkResult').innerHTML = '';

  try {
    const data = await api('/api/admin/products/bulk', { method: 'POST', body: bulkFormData(false) });
    renderBulkPreview(data);
  } catch (err) {
    $('#bulkResult').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Preview Import';
  }
};

async function commitBulkImport() {
  const button = $('#bulkCommit');
  button.disabled = true;
  button.textContent = 'Importing…';

  try {
    // Re-send the file so the server re-validates; the preview is not trusted.
    const data = await api('/api/admin/products/bulk', { method: 'POST', body: bulkFormData(true) });
    closeModals();
    $('#bulkFile').value = '';
    $('#bulkResult').innerHTML = '';
    await Promise.all([loadProducts(), loadStats()]);
    toast(
      `Imported ${data.imported} card${data.imported === 1 ? '' : 's'}` +
        (data.skipped ? ` — ${data.skipped} skipped` : '')
    );
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
    button.textContent = 'Import';
  }
}

$('#openBulkImport').onclick = () => {
  $('#bulkResult').innerHTML = '';
  $('#bulkFile').value = '';
  openModal('#bulkModal');
};

async function backfillArtist() {
  const button = $('#backfillArtist');
  if (!confirm('Look up the artist for every product missing one? This can take a minute for a large catalogue.')) {
    return;
  }

  button.disabled = true;
  button.textContent = 'Backfilling…';
  try {
    const data = await api('/api/admin/products/backfill-artist', { method: 'POST' });
    await loadProducts();
    toast(
      data.checked
        ? `Checked ${data.checked} card${data.checked === 1 ? '' : 's'}, filled in ${data.updated}` +
            (data.rateLimited ? ' — the API rate-limited us partway through, run it again later for the rest.' : '.')
        : 'Nothing to backfill — every card already has an artist.'
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Backfill Artists';
  }
}
$('#backfillArtist').onclick = backfillArtist;

/* -------------------------------------------------------------- add by set --- */

let setsCache = null; // lazy-loaded, kept for the life of the page
let setRowsCache = null; // the currently open set, flattened one row per priced variant
let setEdits = null; // parallel array: {qty, condition, price, status, variant} per row — the
                      // actual source of truth, since pagination means most rows aren't in the DOM
const SET_PAGE_SIZE = 40;
let setPage = 1;
let summaryDebounce = null;

function renderSetPicker() {
  const q = ($('#setSearch').value || '').trim().toLowerCase();
  const list = !q
    ? setsCache
    : setsCache.filter((s) => `${s.name} ${s.series}`.toLowerCase().includes(q));

  $('#setPickerResult').innerHTML = list.length
    ? `<div class="set-grid">${list
        .map(
          (s, i) => `<button class="set-card" type="button" data-set-index="${i}">
            <img src="${esc(s.logo || s.symbol || LOGO)}" alt="">
            <b>${esc(s.name)}</b>
            <div class="small muted">${esc(s.series)}${s.total ? ` &middot; ${s.total} cards` : ''}</div>
          </button>`
        )
        .join('')}</div>`
    : '<div class="muted small">No sets match that search.</div>';

  $$('[data-set-index]').forEach((b) => {
    b.onclick = () => openSetCards(list[Number(b.dataset.setIndex)]);
  });
}

async function openSetImport() {
  $('#setPickerView').classList.remove('hidden');
  $('#setCardsView').classList.add('hidden');
  $('#setSearch').value = '';
  openModal('#setModal');

  if (setsCache) {
    renderSetPicker();
    return;
  }

  $('#setPickerResult').innerHTML = '<div class="muted small">Loading sets…</div>';
  try {
    setsCache = await api('/api/admin/sets');
    renderSetPicker();
  } catch (err) {
    $('#setPickerResult').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

const VARIANT_OPTIONS = ['Normal', 'Holo', 'Reverse Holo', '1st Edition'];

/** One card becomes one row per priced print style — that's where Reverse Holo shows up. */
function flattenSetCards(cards) {
  const rows = [];
  cards.forEach((card, ci) => {
    card.variants.forEach((v, vi) => {
      rows.push({
        key: `${ci}-${vi}`,
        name: card.name,
        number: card.number,
        image: card.image,
        artist: card.artist,
        variant: v.variant,
        marketPrice: v.marketPrice,
      });
    });
  });
  return rows;
}

function setCardRow(row, i, edit) {
  return `<tr data-row-index="${i}">
    <td>${row.image ? `<img src="${esc(row.image)}" alt="">` : ''}</td>
    <td>${esc(row.name)}</td>
    <td class="small muted">${esc(row.number)}</td>
    <td><select data-field="variant">
      ${VARIANT_OPTIONS.map((v) => `<option${v === edit.variant ? ' selected' : ''}>${v}</option>`).join('')}
    </select></td>
    <td class="small muted">${row.marketPrice != null ? money(row.marketPrice) : '—'}</td>
    <td><input type="number" min="0" value="${edit.qty}" data-field="qty"></td>
    <td><select data-field="condition">
      <option${edit.condition === 'NM' ? ' selected' : ''}>NM</option>
      <option${edit.condition === 'LP' ? ' selected' : ''}>LP</option>
      <option${edit.condition === 'MP' ? ' selected' : ''}>MP</option>
      <option${edit.condition === 'HP' ? ' selected' : ''}>HP</option>
    </select></td>
    <td><input type="number" min="0" step="0.01" placeholder="0.00" value="${esc(edit.price)}" data-field="price"></td>
    <td><select data-field="status">
      <option value="live"${edit.status === 'live' ? ' selected' : ''}>Live</option>
      <option value="draft"${edit.status === 'draft' ? ' selected' : ''}>Draft</option>
      <option value="reserved"${edit.status === 'reserved' ? ' selected' : ''}>Reserved</option>
      <option value="hidden"${edit.status === 'hidden' ? ' selected' : ''}>Hidden</option>
    </select></td>
  </tr>`;
}

async function openSetCards(set) {
  $('#setPickerView').classList.add('hidden');
  $('#setCardsView').classList.remove('hidden');
  $('#setCardsTitle').textContent = set.name;
  $('#setCardsError').classList.add('hidden');
  $('#cardFilter').value = '';
  $('#setCardsBody').innerHTML = '<tr><td colspan="9" class="muted">Loading cards…</td></tr>';
  $('#setImportSummary').innerHTML = '';
  $('#setPagination').innerHTML = '';
  $('#setCommit').disabled = true;
  $('#setCommit').dataset.setName = set.name;

  try {
    const cards = await api(`/api/admin/sets/${encodeURIComponent(set.id)}/cards`);
    setRowsCache = flattenSetCards(cards);
    setEdits = setRowsCache.map((row) => ({
      qty: 0,
      condition: $('#setDefaultCondition').value,
      price: '',
      status: $('#setDefaultStatus').value,
      variant: row.variant,
    }));
    setPage = 1;
    $('#setCommit').disabled = !setRowsCache.length;
    renderSetCardsPage();
  } catch (err) {
    $('#setCardsBody').innerHTML = '';
    $('#setCardsError').textContent = err.message;
    $('#setCardsError').classList.remove('hidden');
  }
}

/** Which row indexes match the current search box, in setRowsCache order. */
function visibleSetRowIndexes() {
  const q = ($('#cardFilter').value || '').trim().toLowerCase();
  const indexes = [];
  setRowsCache.forEach((row, i) => {
    if (!q || `${row.name} ${row.number}`.toLowerCase().includes(q)) indexes.push(i);
  });
  return indexes;
}

/** Renders one page of the (filtered) card list, reading/writing setEdits so nothing is lost off-page. */
function renderSetCardsPage() {
  if (!setRowsCache) return;

  const visible = visibleSetRowIndexes();
  if (!visible.length) {
    $('#setCardsBody').innerHTML = `<tr><td colspan="9" class="muted">${
      setRowsCache.length ? 'No cards match that filter.' : 'No cards found for this set.'
    }</td></tr>`;
    $('#setPagination').innerHTML = '';
    updateSetImportSummary();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(visible.length / SET_PAGE_SIZE));
  if (setPage > totalPages) setPage = totalPages;
  const pageIndexes = visible.slice((setPage - 1) * SET_PAGE_SIZE, setPage * SET_PAGE_SIZE);

  $('#setCardsBody').innerHTML = pageIndexes
    .map((i) => setCardRow(setRowsCache[i], i, setEdits[i]))
    .join('');

  renderPager($('#setPagination'), setPage, totalPages, (page) => {
    setPage = page;
    renderSetCardsPage();
  });

  updateSetImportSummary();
}

/** Live recap of what "Add Selected Cards" would actually do, so it's never a surprise. */
function updateSetImportSummary() {
  let cardCount = 0;
  let totalQty = 0;
  let totalPrice = 0;
  const items = [];

  (setRowsCache || []).forEach((row, i) => {
    const edit = setEdits[i];
    if (!Number.isInteger(edit.qty) || edit.qty <= 0) return;
    cardCount++;
    totalQty += edit.qty;
    const lineTotal = edit.qty * (Number(edit.price) || 0);
    totalPrice += lineTotal;
    items.push({ row, edit, lineTotal });
  });

  const summaryLine = cardCount
    ? `<b>${cardCount}</b> card${cardCount === 1 ? '' : 's'} selected &middot; <b>${totalQty}</b> total qty &middot; est. <b>${money(totalPrice)}</b>`
    : '<span class="muted">No cards selected yet — set a quantity on the ones you want to add.</span>';

  const list = items.length
    ? `<div class="set-import-list">${items
        .map(
          ({ row, edit, lineTotal }) => `<div class="set-import-item">
            <span>${edit.qty}&times; ${esc(row.name)}${
              row.number ? ` <span class="muted">#${esc(row.number)}</span>` : ''
            } <span class="muted">(${esc(edit.variant)}, ${esc(edit.condition)})</span></span>
            <b>${money(lineTotal)}</b>
          </div>`
        )
        .join('')}</div>`
    : '';

  $('#setImportSummary').innerHTML = `<div>${summaryLine}</div>${list}`;

  $('#setCommit').textContent = cardCount
    ? `Add ${cardCount} Card${cardCount === 1 ? '' : 's'}`
    : 'Add Selected Cards';
}

async function commitSetImport() {
  const button = $('#setCommit');
  const errorBox = $('#setCardsError');
  errorBox.classList.add('hidden');

  const cards = [];
  setRowsCache.forEach((row, i) => {
    const edit = setEdits[i];
    if (!Number.isInteger(edit.qty) || edit.qty <= 0) return;
    cards.push({
      name: row.name,
      number: row.number,
      image: row.image,
      artist: row.artist,
      qty: edit.qty,
      variant: edit.variant,
      condition: edit.condition,
      price: edit.price,
      status: edit.status,
    });
  });

  if (!cards.length) {
    errorBox.textContent = 'Set a quantity of at least 1 on the cards you want to add.';
    errorBox.classList.remove('hidden');
    return;
  }

  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const data = await api('/api/admin/products/bulk-set', {
      method: 'POST',
      body: JSON.stringify({ setName: button.dataset.setName || '', cards }),
    });
    closeModals();
    await Promise.all([loadProducts(), loadStats()]);
    toast(
      `Added ${data.imported} card${data.imported === 1 ? '' : 's'}` +
        (data.merged ? ` (${data.merged} merged into existing listing${data.merged === 1 ? '' : 's'})` : '')
    );
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    updateSetImportSummary();
  }
}

$('#openSetImport').onclick = openSetImport;
$('#setSearch').oninput = renderSetPicker;
$('#backToSetPicker').onclick = () => {
  $('#setCardsView').classList.add('hidden');
  $('#setPickerView').classList.remove('hidden');
};
$('#cardFilter').oninput = () => {
  setPage = 1;
  renderSetCardsPage();
};
$('#setCommit').onclick = commitSetImport;

// Source of truth lives in setEdits, not the DOM, so a row keeps its values even after
// paging away from it. The summary recompute is debounced since it's cheap now (a plain
// array scan) but still no reason to run it on every single keystroke.
$('#setCardsBody').addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  const row = e.target.closest('tr[data-row-index]');
  if (!field || !row) return;
  const i = Number(row.dataset.rowIndex);

  if (field === 'qty') setEdits[i].qty = Number.parseInt(e.target.value, 10);
  else if (field === 'price') setEdits[i].price = e.target.value;
  else if (field === 'condition') setEdits[i].condition = e.target.value;
  else if (field === 'status') setEdits[i].status = e.target.value;
  else if (field === 'variant') setEdits[i].variant = e.target.value;

  clearTimeout(summaryDebounce);
  summaryDebounce = setTimeout(updateSetImportSummary, 150);
});

$('#setDefaultCondition').onchange = (e) => {
  (setEdits || []).forEach((edit) => (edit.condition = e.target.value));
  renderSetCardsPage();
};
$('#setDefaultStatus').onchange = (e) => {
  (setEdits || []).forEach((edit) => (edit.status = e.target.value));
  renderSetCardsPage();
};

/* ------------------------------------------------------- Pokémon TCG API --- */

$('#apiSearch').onclick = async () => {
  const name = $('#apiName').value.trim();
  const set = $('#apiSet').value.trim();
  const number = $('#apiNumber').value.trim();

  if (!name && !number) return toast('Enter a card name or number.', true);

  $('#apiResults').innerHTML = '<div class="muted small">Searching…</div>';

  const parts = [];
  if (name) parts.push(`name:"${name}"`);
  if (set) parts.push(`set.name:"${set}"`);
  if (number) parts.push(`number:"${number}"`);

  try {
    const res = await fetch(
      'https://api.pokemontcg.io/v2/cards?pageSize=12&q=' + encodeURIComponent(parts.join(' '))
    );
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const json = await res.json();
    apiResultCache = json.data || [];

    $('#apiResults').innerHTML = apiResultCache.length
      ? apiResultCache
          .map(
            (c, i) => `<div class="api-card">
        <img src="${esc((c.images && (c.images.small || c.images.large)) || LOGO)}" alt="${esc(c.name)}">
        <div class="small" style="margin-top:6px"><b>${esc(c.name)}</b><br>${esc(
              (c.set && c.set.name) || ''
            )} &middot; ${esc(c.number || '')}</div>
        <button class="btn" data-api-index="${i}" type="button">Use Card</button>
      </div>`
          )
          .join('')
      : '<div class="muted small">No matches. Try fewer fields.</div>';

    $$('[data-api-index]').forEach((b) => {
      b.onclick = () => {
        const c = apiResultCache[Number(b.dataset.apiIndex)];
        if (!c) return;
        $('#productName').value = c.name || '';
        $('#productSet').value = (c.set && c.set.name) || '';
        $('#productNumber').value = c.number || '';
        $('#productImageUrl').value = (c.images && (c.images.large || c.images.small)) || '';
        $('#productArtist').value = c.artist || '';
        pendingUpload = null;
        $('#productImageFile').value = '';
        $('#productPreview').src = $('#productImageUrl').value || LOGO;
        toast('Card details filled in');
      };
    });
  } catch (err) {
    $('#apiResults').innerHTML = `<div class="muted small">Could not reach the Pok&eacute;mon TCG API (${esc(
      err.message
    )}). Paste an image URL or upload a photo instead.</div>`;
  }
};

/* ---------------------------------------------------------------- orders --- */

async function loadOrders() {
  try {
    orderCache = await api('/api/admin/orders');
    renderOrders();
    renderRecentOrders();
  } catch (err) {
    toast(err.message, true);
  }
}

function filteredOrders() {
  const status = $('#orderStatusFilter').value;
  const q = ($('#orderSearch').value || '').trim().toLowerCase();
  const from = $('#orderFrom').value;
  const to = $('#orderTo').value;

  return orderCache.filter((o) => {
    if (status && o.status !== status) return false;
    if (
      q &&
      !`${o.id} ${o.buyer} ${o.telegram} ${o.email}`.toLowerCase().includes(q)
    ) {
      return false;
    }
    const day = (o.createdAt || '').slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

function renderOrders() {
  const list = filteredOrders();

  const totalPages = Math.max(1, Math.ceil(list.length / ORDERS_PAGE_SIZE));
  if (ordersPage > totalPages) ordersPage = totalPages;
  const pageItems = list.slice((ordersPage - 1) * ORDERS_PAGE_SIZE, ordersPage * ORDERS_PAGE_SIZE);

  $('#ordersBody').innerHTML = pageItems.length
    ? pageItems
        .map(
          (o) => `<tr>
      <td>${esc(o.id)}<div class="small muted">${esc((o.createdAt || '').replace('T', ' '))}</div></td>
      <td>${esc(o.buyer)}<div class="small muted">${esc(o.telegram || o.email || '')}</div></td>
      <td>${o.items.length}</td>
      <td>${money(o.total)}</td>
      <td>${esc(o.delivery)}</td>
      <td><span class="status order-${slug(o.status)}">${esc(o.status)}</span></td>
      <td><span class="status notify-${slug(o.notifyState)}">${esc(o.notifyState)}</span></td>
      <td><div class="row-actions">
        <button data-order="${esc(o.id)}">View</button>
        <button data-advance="${esc(o.id)}">Advance</button>
        <button data-resend="${esc(o.id)}">Resend</button>
        <button data-delete-order="${esc(o.id)}" ${isDeletableOrder(o) ? '' : 'disabled'}>Delete</button>
      </div></td>
    </tr>`
        )
        .join('')
    : `<tr><td colspan="8" class="muted">${
        orderCache.length ? 'No orders match these filters.' : 'No orders yet.'
      }</td></tr>`;

  $$('[data-order]').forEach((b) => (b.onclick = () => openOrder(b.dataset.order)));
  $$('[data-advance]').forEach((b) => (b.onclick = () => advanceOrder(b.dataset.advance)));
  $$('[data-resend]').forEach((b) => (b.onclick = () => resendNotification(b.dataset.resend)));
  $$('[data-delete-order]').forEach((b) => (b.onclick = () => removeOrder(b.dataset.deleteOrder)));

  renderPager($('#ordersPagination'), ordersPage, totalPages, (page) => {
    ordersPage = page;
    renderOrders();
  });
}

/** Only cancelled/completed orders are safe to delete — stock is already settled either way. */
function isDeletableOrder(o) {
  return o.status === 'cancelled' || o.status === 'completed';
}

async function removeOrder(id) {
  const o = orderCache.find((x) => x.id === id);
  if (!o) return;
  if (!confirm(`Delete order ${o.id}? This cannot be undone.`)) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeModals();
    await Promise.all([loadOrders(), loadStats()]);
    toast('Order deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

async function advanceOrder(id, explicitStatus) {
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify(explicitStatus ? { status: explicitStatus } : {}),
    });
    await Promise.all([loadOrders(), loadProducts(), loadStats()]);
    closeModals();
    toast('Order updated');
  } catch (err) {
    toast(err.message, true);
  }
}

async function cancelOrder(id) {
  if (!confirm('Cancel this order and return its cards to the storefront?')) return;
  await advanceOrder(id, 'cancelled');
}

async function resendNotification(id) {
  try {
    await api(`/api/admin/orders/${encodeURIComponent(id)}/notify`, { method: 'POST' });
    await loadOrders();
    toast('Telegram notification sent');
  } catch (err) {
    toast('Telegram: ' + err.message, true);
  }
}

function openOrder(id) {
  const o = orderCache.find((x) => x.id === id);
  if (!o) return;

  $('#orderModalId').textContent = `${o.id} · ${(o.createdAt || '').replace('T', ' ')}`;
  $('#orderDetail').innerHTML = `
    <div class="order-detail-grid">
      <div><label>Buyer</label><div>${esc(o.buyer)}</div></div>
      <div><label>Telegram</label><div>${esc(o.telegram || '—')}</div></div>
      <div><label>Email</label><div>${esc(o.email || '—')}</div></div>
      <div><label>Phone</label><div>${esc(o.phone || '—')}</div></div>
      <div><label>Delivery</label><div>${esc(o.delivery)}</div></div>
      <div><label>Status</label><div><span class="status order-${slug(o.status)}">${esc(o.status)}</span></div></div>
      <div><label>Telegram Notification</label><div>
        <span class="status notify-${slug(o.notifyState)}">${esc(o.notifyState)}</span>
        ${o.notifyError ? `<div class="small muted" style="margin-top:6px">${esc(o.notifyError)}</div>` : ''}
      </div></div>
      <div class="full"><label>Address / Note</label><div style="white-space:pre-wrap">${esc(o.address || '—')}</div></div>
      <div class="full order-items">
        ${o.items
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
          o.discount
            ? `<div class="summary"><span>Discount (${esc(o.promoCode)})</span><span>&minus;${money(o.discount)}</span></div>`
            : ''
        }
        <div class="summary"><span>${esc(o.delivery)}</span><span>${money(o.fee)}</span></div>
        <div class="summary total"><span>Total</span><span>${money(o.total)}</span></div>
      </div>
    </div>
    <div class="actions" style="margin-top:16px;flex-wrap:wrap">
      <button class="btn" id="orderResend" type="button">Resend Telegram</button>
      <button class="btn danger" id="orderCancel" type="button">Cancel &amp; Restock</button>
      <button class="btn primary" id="orderAdvance" type="button">Advance Status</button>
      <button class="btn danger" id="orderDelete" type="button">Delete Order</button>
    </div>`;

  $('#orderResend').onclick = () => resendNotification(o.id);
  $('#orderCancel').onclick = () => cancelOrder(o.id);
  $('#orderAdvance').onclick = () => advanceOrder(o.id);
  $('#orderDelete').onclick = () => removeOrder(o.id);
  $('#orderAdvance').disabled = o.status === 'completed' || o.status === 'cancelled';
  $('#orderCancel').disabled = o.status === 'cancelled';
  $('#orderDelete').disabled = !isDeletableOrder(o);
  $('#orderDelete').title = isDeletableOrder(o) ? '' : 'Cancel the order first to release its stock, then delete.';

  openModal('#orderModal');
}

/* ----------------------------------------------------------- trade shows --- */

let tradeShowCache = [];

async function loadTradeShows() {
  try {
    tradeShowCache = await api('/api/admin/trade-shows');
    renderTradeShowRows();
  } catch (err) {
    toast(err.message, true);
  }
}

function formatShowRange(startDate, endDate) {
  return endDate && endDate !== startDate ? `${startDate} &ndash; ${endDate}` : startDate;
}

function renderTradeShowRows() {
  $('#tradeShowsBody').innerHTML = tradeShowCache.length
    ? tradeShowCache
        .map(
          (s) => `<tr>
            <td>${formatShowRange(esc(s.startDate), esc(s.endDate))}</td>
            <td>${esc(s.venue)}</td>
            <td>${esc(s.location)}</td>
            <td>${esc(s.tableNo)}</td>
            <td><div class="row-actions">
              <button data-edit-show="${esc(s.id)}">Edit</button>
              <button data-delete-show="${esc(s.id)}">Delete</button>
            </div></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No trade shows added yet.</td></tr>';

  $$('[data-edit-show]').forEach((b) => (b.onclick = () => openTradeShowModal(b.dataset.editShow)));
  $$('[data-delete-show]').forEach((b) => (b.onclick = () => removeTradeShow(b.dataset.deleteShow)));
}

function openTradeShowModal(id) {
  $('#tradeShowError').classList.add('hidden');
  $('#tradeShowId').value = '';
  $('#tradeShowVenue').value = '';
  $('#tradeShowLocation').value = '';
  $('#tradeShowStart').value = '';
  $('#tradeShowEnd').value = '';
  $('#tradeShowTable').value = '';
  $('#tradeShowModalTitle').textContent = 'Add Show';

  if (id) {
    const s = tradeShowCache.find((x) => x.id === id);
    if (!s) return;
    $('#tradeShowModalTitle').textContent = 'Edit Show';
    $('#tradeShowId').value = s.id;
    $('#tradeShowVenue').value = s.venue;
    $('#tradeShowLocation').value = s.location;
    $('#tradeShowStart').value = s.startDate;
    $('#tradeShowEnd').value = s.endDate || '';
    $('#tradeShowTable').value = s.tableNo;
  }
  openModal('#tradeShowModal');
}

async function saveTradeShow() {
  const button = $('#saveTradeShow');
  const errorBox = $('#tradeShowError');
  errorBox.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    const id = $('#tradeShowId').value;
    const payload = {
      venue: $('#tradeShowVenue').value.trim(),
      location: $('#tradeShowLocation').value.trim(),
      startDate: $('#tradeShowStart').value,
      endDate: $('#tradeShowEnd').value,
      tableNo: $('#tradeShowTable').value.trim(),
    };

    if (id) {
      await api(`/api/admin/trade-shows/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/api/admin/trade-shows', { method: 'POST', body: JSON.stringify(payload) });
    }

    closeModals();
    await loadTradeShows();
    toast('Trade show saved — storefront updated');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Save Show';
  }
}

async function removeTradeShow(id) {
  const s = tradeShowCache.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`Delete "${s.venue}"?`)) return;
  try {
    await api(`/api/admin/trade-shows/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadTradeShows();
    toast('Trade show deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ----------------------------------------------------------- promo codes --- */

let promoCodeCache = [];

async function loadPromoCodes() {
  try {
    promoCodeCache = await api('/api/admin/promo-codes');
    renderPromoCodeRows();
  } catch (err) {
    toast(err.message, true);
  }
}

function formatDiscount(p) {
  return p.type === 'percent' ? `${p.value}% off` : `${money(p.value)} off`;
}

function renderPromoCodeRows() {
  $('#promoCodesBody').innerHTML = promoCodeCache.length
    ? promoCodeCache
        .map(
          (p) => `<tr>
            <td><b>${esc(p.code)}</b></td>
            <td>${esc(formatDiscount(p))}</td>
            <td>${p.usedCount}${p.maxUses ? ` / ${p.maxUses}` : ''}</td>
            <td>${esc(p.expiresAt) || '—'}</td>
            <td>${p.minSubtotal ? money(p.minSubtotal) : '—'}</td>
            <td><span class="status status-${p.active ? 'live' : 'hidden'}">${p.active ? 'active' : 'inactive'}</span></td>
            <td><div class="row-actions">
              <button data-edit-promo="${esc(p.code)}">Edit</button>
              <button data-delete-promo="${esc(p.code)}">Delete</button>
            </div></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No promo codes yet.</td></tr>';

  $$('[data-edit-promo]').forEach((b) => (b.onclick = () => openPromoModal(b.dataset.editPromo)));
  $$('[data-delete-promo]').forEach((b) => (b.onclick = () => removePromoCode(b.dataset.deletePromo)));
}

function openPromoModal(code) {
  $('#promoError').classList.add('hidden');
  $('#promoOriginalCode').value = '';
  $('#promoCodeInput').value = '';
  $('#promoCodeInput').disabled = false;
  $('#promoType').value = 'percent';
  $('#promoValue').value = '';
  $('#promoMaxUses').value = '';
  $('#promoExpiresAt').value = '';
  $('#promoMinSubtotal').value = '0';
  $('#promoActive').checked = true;
  $('#promoModalTitle').textContent = 'Add Code';

  if (code) {
    const p = promoCodeCache.find((x) => x.code === code);
    if (!p) return;
    $('#promoModalTitle').textContent = 'Edit Code';
    $('#promoOriginalCode').value = p.code;
    $('#promoCodeInput').value = p.code;
    $('#promoCodeInput').disabled = true; // the code is the primary key — edit in place, don't rename
    $('#promoType').value = p.type;
    $('#promoValue').value = p.value;
    $('#promoMaxUses').value = p.maxUses || '';
    $('#promoExpiresAt').value = p.expiresAt || '';
    $('#promoMinSubtotal').value = p.minSubtotal;
    $('#promoActive').checked = p.active;
  }
  openModal('#promoModal');
}

async function savePromo() {
  const button = $('#savePromo');
  const errorBox = $('#promoError');
  errorBox.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    const originalCode = $('#promoOriginalCode').value;
    const payload = {
      code: $('#promoCodeInput').value.trim().toUpperCase(),
      type: $('#promoType').value,
      value: $('#promoValue').value,
      maxUses: $('#promoMaxUses').value,
      expiresAt: $('#promoExpiresAt').value,
      minSubtotal: $('#promoMinSubtotal').value,
      active: $('#promoActive').checked,
    };

    if (originalCode) {
      await api(`/api/admin/promo-codes/${encodeURIComponent(originalCode)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/api/admin/promo-codes', { method: 'POST', body: JSON.stringify(payload) });
    }

    closeModals();
    await loadPromoCodes();
    toast('Promo code saved');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Save Code';
  }
}

async function removePromoCode(code) {
  if (!confirm(`Delete promo code "${code}"?`)) return;
  try {
    await api(`/api/admin/promo-codes/${encodeURIComponent(code)}`, { method: 'DELETE' });
    await loadPromoCodes();
    toast('Promo code deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

/* -------------------------------------------------------------- settings --- */

let currentPaynowQr = '';

async function loadSettings() {
  try {
    const s = await api('/api/admin/settings');
    $('#settingStoreName').value = s.storeName;
    $('#settingTelegram').value = s.telegram;
    $('#settingMailing').value = s.mailing;
    $('#settingMinimum').value = s.minimum;
    $('#settingReservation').value = s.reservation;
    $('#settingPaynow').value = s.paynow;
    $('#settingPaynowPayee').value = s.paynowPayee || '';
    $('#settingContactTelegram').value = s.contactTelegram || '';

    currentPaynowQr = s.paynowQr || '';
    $('#paynowQrPreview').src = currentPaynowQr || LOGO;

    $('#telegramStatus').innerHTML = s.telegramConfigured
      ? `<div class="notice">
           <strong>Telegram is connected.</strong> New orders are pushed to your admin chat automatically.
           <div style="margin-top:10px"><button class="btn" id="testTelegram" type="button">Send test message</button></div>
         </div>`
      : `<div class="notice warn">
           <strong>Telegram is not configured.</strong> Orders will still be saved, but you will not be pinged.
           Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_ADMIN_CHAT_ID</code> in your <code>.env</code>
           and restart the server. These live on the server only — never in the browser.
         </div>`;

    const testButton = $('#testTelegram');
    if (testButton) {
      testButton.onclick = async () => {
        testButton.disabled = true;
        try {
          await api('/api/admin/telegram/test', { method: 'POST' });
          toast('Test message sent — check Telegram');
        } catch (err) {
          toast('Telegram: ' + err.message, true);
        } finally {
          testButton.disabled = false;
        }
      };
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$('#saveSettings').onclick = async () => {
  const button = $('#saveSettings');
  button.disabled = true;
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        storeName: $('#settingStoreName').value,
        telegram: $('#settingTelegram').value,
        mailing: $('#settingMailing').value,
        minimum: $('#settingMinimum').value,
        reservation: $('#settingReservation').value,
        paynow: $('#settingPaynow').value,
        paynowPayee: $('#settingPaynowPayee').value,
        contactTelegram: $('#settingContactTelegram').value,
        paynowQr: currentPaynowQr,
      }),
    });
    toast('Settings saved');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
};

$('#paynowQrFile').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => ($('#paynowQrPreview').src = reader.result);
  reader.readAsDataURL(file);
};

$('#uploadPaynowQr').onclick = async () => {
  const file = $('#paynowQrFile').files[0];
  if (!file) return toast('Choose a QR image first.', true);

  const button = $('#uploadPaynowQr');
  button.disabled = true;
  try {
    const form = new FormData();
    form.append('image', file);
    const uploaded = await api('/api/admin/upload', { method: 'POST', body: form });
    currentPaynowQr = uploaded.url;
    $('#paynowQrPreview').src = currentPaynowQr;
    $('#paynowQrFile').value = '';

    // Persist straight away so a forgotten "Save Changes" cannot lose the QR.
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ paynowQr: currentPaynowQr }),
    });
    toast('PayNow QR updated — scan it yourself to confirm it is correct');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
};

$('#removePaynowQr').onclick = async () => {
  if (!confirm('Remove the PayNow QR? Buyers will only see the text instructions.')) return;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ paynowQr: '' }) });
    currentPaynowQr = '';
    $('#paynowQrPreview').src = LOGO;
    $('#paynowQrFile').value = '';
    toast('PayNow QR removed');
  } catch (err) {
    toast(err.message, true);
  }
};

/* ---------------------------------------------------------------- wiring --- */

$$('[data-admin-tab]').forEach((b) => {
  b.onclick = () => {
    $$('.admin-tab').forEach((t) => t.classList.toggle('active', t.id === b.dataset.adminTab));
    $$('[data-admin-tab]').forEach((x) => x.classList.toggle('active', x === b));
    if (b.dataset.adminTab === 'products') loadProducts();
    if (b.dataset.adminTab === 'orders') loadOrders();
    if (b.dataset.adminTab === 'analytics') loadAnalytics();
    if (b.dataset.adminTab === 'tradeShows') loadTradeShows();
    if (b.dataset.adminTab === 'promoCodes') loadPromoCodes();
    if (b.dataset.adminTab === 'settings') loadSettings();
    if (b.dataset.adminTab === 'dashboard') loadStats();
  };
});

$$('.open-product-modal').forEach((b) => (b.onclick = () => openProductModal()));
$('#saveProduct').onclick = saveProduct;
$('#openTradeShowModal').onclick = () => openTradeShowModal();
$('#saveTradeShow').onclick = saveTradeShow;
$('#openPromoModal').onclick = () => openPromoModal();
$('#savePromo').onclick = savePromo;
$('#adminProductSearch').oninput = () => {
  inventoryPage = 1;
  renderInventory();
};
$('#adminSetFilter').onchange = () => {
  inventoryPage = 1;
  renderInventory();
};
$('#refreshOrders').onclick = loadOrders;
const resetOrdersPage = () => {
  ordersPage = 1;
  renderOrders();
};
$('#orderStatusFilter').onchange = resetOrdersPage;
$('#orderSearch').oninput = resetOrdersPage;
$('#orderFrom').onchange = resetOrdersPage;
$('#orderTo').onchange = resetOrdersPage;

$('#logout').onclick = async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch { /* leaving anyway */ }
  window.location.href = '/';
};

$$('.modal-close').forEach((b) => (b.onclick = closeModals));
$$('.modal-bg').forEach((m) => {
  m.onclick = (e) => {
    if (e.target === m) closeModals();
  };
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModals();
});

loadStats();
loadProducts();
loadOrders();
loadAnalytics();
loadTradeShows();
loadPromoCodes();
loadSettings();
