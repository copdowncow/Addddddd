'use strict';
import { api }  from './api.js';
import { esc, fmt, toast, openModal, goPage } from './utils.js';

const _cache = new Map();
const CACHE_TTL = 30000;

function cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(d => { _cache.set(key, { data: d, ts: Date.now() }); return d; });
}

function imgUrl(url, w = 400) {
  if (!url) return url;
  if (url.includes('/storage/v1/object/public/')) {
    return url + (url.includes('?') ? '&' : '?') + 'width=' + w + '&quality=75';
  }
  return url;
}

function getCommission(category) {
  return category === 'sweets' ? 0.10 : 0.25;
}

function priceWithCommission(p) {
  if (p.is_admin_price) return Number(p.price);
  return Math.ceil((Number(p.price) * (1 + getCommission(p.category))).toFixed(2) / 10) * 10;
}

function fmtPrice(p) { return Number(p).toLocaleString('ru-RU') + ' TJS'; }

function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

const EXPIRY_CATS = ['bouquet', 'basket'];
function getTimeLeft(expiresAt) {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt) - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) { const d = Math.floor(h / 24); return d + 'д ' + (h%24) + 'ч'; }
  return h > 0 ? h + 'ч ' + m + 'м' : m + 'м';
}
function getExpiresAt(p) {
  if (p.expires_at) return p.expires_at;
  if (EXPIRY_CATS.includes(p.category) && p.created_at) {
    return new Date(new Date(p.created_at).getTime() + 2 * 24 * 3600000).toISOString();
  }
  return null;
}
function timerBadge(p) {
  if (!EXPIRY_CATS.includes(p.category)) return '';
  const ea = getExpiresAt(p);
  if (!ea) return '';
  const left = getTimeLeft(ea);
  if (!left) return '<span class="timer-badge expired">⏰ Истёк</span>';
  const urgent = (new Date(ea) - Date.now()) < 3 * 3600000;
  return '<span class="timer-badge' + (urgent ? ' urgent' : '') + '">⏰ ' + left + '</span>';
}

const CAT_LABEL = { bouquet:'Букет', basket:'Корзина', bear:'Мишка', sweets:'Сладости' };
const CAT_EM    = { bouquet:'💐', basket:'🧺', bear:'🧸', sweets:'🍰' };
const CAT_CLS   = { bouquet:'pi-bouquet', basket:'pi-basket', bear:'pi-bear', sweets:'pi-sweets' };

let _cfg = { instagram: 'https://instagram.com/rebuket', telegram: 'https://t.me/rebuket_admin' };
let catalogMode = 'eco';

function getShopSession() {
  return {
    phone: localStorage.getItem('shop_phone') || '',
    name: localStorage.getItem('shop_name') || ''
  };
}

async function shopFetch(method, url, body = null) {
  const token = localStorage.getItem('shop_token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Ошибка сервера');
  }
  return data;
}

function getCatalogParams() {
  const params = { ...filters };
  if (filters.mode === 'shop') {
    delete params.mode;
  } else {
    params.listing_type = 'eco';
    delete params.mode;
  }
  return params;
}

export async function loadConfig() {
  try { _cfg = await api.config(); } catch {}
}

// ── CATALOG ───────────────────────────────────────────────
let filters = { category:'', city:'', max_price:'', search:'', page:1 };

export async function loadCatalog(extra = {}) {
  Object.assign(filters, extra, { page:1 });
  filters.mode = filters.mode || catalogMode;
  await renderGrid();
  if (window.refreshShopProfileUI) await refreshShopProfileUI();
}

export async function setCatalogMode(mode) {
  catalogMode = mode === 'shop' ? 'shop' : 'eco';
  filters.mode = catalogMode;
  delete filters.shop_phone;
  await loadCatalog();
}

export async function loadMyShopProducts() {
  const shop = getShopSession();
  if (!shop.phone) return;
  filters.shop_phone = shop.phone;
  filters.mode = 'shop';
  await loadCatalog();
}

export async function viewShopProfile(phone) {
  if (!phone) return;
  goPage('shop-view');
  
  const avatar = document.getElementById('shop-view-avatar');
  const nameEl = document.getElementById('shop-view-name');
  const welcomeEl = document.getElementById('shop-view-welcome');
  const subEl = document.getElementById('shop-view-sub');
  const descEl = document.getElementById('shop-view-description');
  const phoneEl = document.getElementById('shop-view-phone');
  const countEl = document.getElementById('shop-view-count');
  const listEl = document.getElementById('shop-view-pubs');
  
  // Set loading state
  if (avatar) avatar.textContent = '🏪';
  if (nameEl) nameEl.textContent = 'Загрузка...';
  if (welcomeEl) welcomeEl.textContent = 'Добро пожаловать в магазин';
  if (subEl) subEl.textContent = 'Загружаем информацию о магазине...';
  if (descEl) descEl.textContent = '';
  if (phoneEl) phoneEl.textContent = '';
  if (countEl) countEl.textContent = 'Загрузка…';
  if (listEl) listEl.innerHTML = '<div class="loader">🌿 Загружаем публикации…</div>';
  
  try {
    // Fetch shop info using existing shops-pub endpoint
    const resp = await fetch('/api/shops-pub?shop_phone=' + encodeURIComponent(phone) + '&limit=1');
    if (!resp.ok) {
      console.error('Shop fetch failed:', resp.status, resp.statusText);
      throw new Error('Failed to fetch shop info');
    }
    const r = await resp.json();
    const shop = Array.isArray(r.data) && r.data.length ? r.data[0] : null;
    
    if (!shop) {
      throw new Error('Shop not found');
    }
    
    if (nameEl) nameEl.textContent = shop.shop_name || 'Магазин';
    if (welcomeEl) welcomeEl.textContent = 'Добро пожаловать в ' + (shop.shop_name || 'магазин');
    if (subEl) subEl.textContent = 'Показаны все публикации магазина';
    if (descEl) descEl.textContent = shop.description || 'У этого магазина пока нет описания.';
    
    // Display photo if available
    if (avatar) {
      if (shop.photo_url) {
        avatar.innerHTML = '<img src="' + esc(shop.photo_url) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
        avatar.style.background = 'transparent';
      } else {
        avatar.textContent = getShopAvatar(shop.shop_name || 'Магазин');
        avatar.style.background = '#ffffff';
      }
    }
    
    // Fetch shop publications using shops-pub endpoint
    const pubsResp = await fetch('/api/shops-pub?shop_phone=' + encodeURIComponent(phone) + '&limit=50');
    if (!pubsResp.ok) throw new Error('Failed to fetch publications');
    const pubs = await pubsResp.json();
    const total = Number(pubs.total || 0);
    
    if (countEl) countEl.textContent = total + ' публикаций';
    
    if (!Array.isArray(pubs.data) || pubs.data.length === 0) {
      listEl.innerHTML = '<div class="empty"><span>🏬</span><h3>Нет публикаций</h3><p>У этого магазина пока нет публикаций.</p></div>';
      return;
    }
    
    // Render publications using pCard function
    listEl.innerHTML = '<div class="pgrid" id="shop-view-grid">' + pubs.data.map(p => pCard(p)).join('') + '</div>';
    
  } catch (err) {
    console.error('Shop view error:', err);
    if (nameEl) nameEl.textContent = 'Ошибка';
    if (subEl) subEl.textContent = 'Не удалось загрузить информацию о магазине';
    if (listEl) listEl.innerHTML = '<div class="empty"><span>❌</span><h3>Ошибка загрузки</h3><p>' + esc(err.message) + '</p></div>';
  }
}

export async function openShopProfile() {
  goPage('shop-profile');
  await renderShopProfile();
}

export async function loadShopProfilePage() {
  await renderShopProfile();
}

export function logoutShopFromProfile() {
  localStorage.removeItem('shop_token');
  localStorage.removeItem('shop_name');
  localStorage.removeItem('shop_phone');
  if (window.updateShopUI) window.updateShopUI();
  if (window.refreshShopProfileUI) window.refreshShopProfileUI();
  if (window.loadCatalog) window.loadCatalog();
  goPage('home');
  toast('Вы вышли из аккаунта магазина','ok');
}

async function renderShopProfile() {
  const shop = getShopSession();
  const avatar = document.getElementById('shop-profile-page-avatar');
  const nameEl = document.getElementById('shop-profile-page-name');
  const subEl = document.getElementById('shop-profile-page-sub');
  const countEl = document.getElementById('shop-profile-page-count');
  const phoneEl = document.getElementById('shop-profile-page-phone');
  const listEl = document.getElementById('shop-publications-list');

  if (!shop.phone) {
    goPage('catalog');
    toast('Сначала войдите в аккаунт магазина', 'err');
    return;
  }

  // Set basic info from session
  if (avatar) avatar.textContent = getShopAvatar(shop.name || shop.phone);
  if (nameEl) nameEl.textContent = shop.name || shop.phone;
  if (phoneEl) phoneEl.textContent = 'Телефон: ' + shop.phone;
  if (subEl) subEl.textContent = 'Здесь вы видите свои публикации и можете удалить старые объявления.';
  const welcomeEl = document.getElementById('shop-profile-page-welcome');
  if (welcomeEl) welcomeEl.textContent = 'Добро пожаловать в ' + (shop.name || 'магазин');
  if (countEl) countEl.textContent = 'Загрузка…';
  if (listEl) listEl.innerHTML = '<div class="loader">Загружаем публикации…</div>';

  try {
    // Try to get shop info from API
    const resp = await shopFetch('GET', '/shops/me');
    if (nameEl) nameEl.textContent = resp.shop_name || shop.name;
    if (welcomeEl) welcomeEl.textContent = 'Добро пожаловать в ' + (resp.shop_name || shop.name || 'магазин');
    
    // Display photo if available
    if (avatar) {
      if (resp.photo_url) {
        avatar.innerHTML = '<img src="' + esc(resp.photo_url) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
        avatar.style.background = 'transparent';
      } else {
        avatar.textContent = getShopAvatar(resp.shop_name || shop.name);
        avatar.style.background = '#ffffff';
      }
    }
    const descEl = document.getElementById('shop-profile-page-description');
    if (descEl) {
      descEl.textContent = resp.description || 'Добавьте описание магазина в редактировании профиля, чтобы покупатели быстрее находили вас.';
    }
    
    // Update localStorage with latest data
    if (resp.shop_name) localStorage.setItem('shop_name', resp.shop_name);
    if (resp.photo_url) localStorage.setItem('shop_photo', resp.photo_url);
    if (typeof resp.description === 'string') localStorage.setItem('shop_description', resp.description);
    
    const pubs = await shopFetch('GET', '/shops/products?limit=50');
    const total = Number(pubs.total || 0);
    console.log('[renderShopProfile] Publications received:', pubs);
    if (countEl) countEl.textContent = total + ' публикаций';
    
    if (!Array.isArray(pubs.data) || pubs.data.length === 0) {
      console.log('[renderShopProfile] No publications found');
      listEl.innerHTML = '<div class="empty"><span>🏬</span><h3>Пока нет публикаций</h3><p>Создайте новое объявление и оно появится здесь после проверки.</p></div>';
      return;
    }
    console.log('[renderShopProfile] Rendering', pubs.data.length, 'publications');
    listEl.innerHTML = pubs.data.map(shopPubCard).join('');
  } catch (err) {
    console.error('Shop profile error:', err);
    if (countEl) countEl.textContent = 'Ошибка загрузки';
    // Show publications even if shop info fails
    try {
      const pubs = await shopFetch('GET', '/shops/products?limit=50');
      const total = Number(pubs.total || 0);
      if (countEl) countEl.textContent = total + ' публикаций';
      if (!Array.isArray(pubs.data) || pubs.data.length === 0) {
        listEl.innerHTML = '<div class="empty"><span>🏬</span><h3>Пока нет публикаций</h3><p>Создайте новое объявление и оно появится здесь после проверки.</p></div>';
        return;
      }
      listEl.innerHTML = pubs.data.map(shopPubCard).join('');
    } catch (pubErr) {
      if (listEl) listEl.innerHTML = '<div class="empty"><span>❌</span><h3>Ошибка загрузки публикаций</h3><p>' + esc(pubErr.message) + '</p></div>';
    }
  }
}

function shopPubCard(p) {
  const status = esc(p.status || 'active');
  const date = p.created_at ? new Date(p.created_at).toLocaleDateString('ru-RU') : '—';
  const price = fmtPrice(priceWithCommission(p));
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const thumbHtml = photos[0]
    ? '<div class="shop-pub-thumb"><img src="' + esc(imgUrl(photos[0], 400)) + '" alt="' + esc(p.title) + '" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;border-radius:16px"></div>'
    : '<div class="shop-pub-thumb" style="width:100%;height:120px;border-radius:16px;background:#f5f5f5;display:flex;align-items:center;justify-content:center;color:var(--gray);font-size:.95rem">Нет фото</div>';
  const stock = p.stock ? Number(p.stock) : null;
  const stockText = stock !== null ? (stock > 0 ? `${stock} в наличии` : 'нет в наличии') : '';
  const stockClass = stock === 0 ? 'color:var(--red)' : 'color:var(--green)';
  const pAttr = encodeURIComponent(JSON.stringify(p));
  
  return (
    '<div class="shop-pub-card">' +
      thumbHtml +
      '<div class="shop-pub-main">' +
        '<div class="shop-pub-top">' +
          '<div class="shop-pub-name">' + esc(p.title) + '</div>' +
          '<span class="shop-card-status">' + esc(status) + '</span>' +
        '</div>' +
        '<div class="shop-pub-meta">' + esc(p.category) + ' · ' + price + ' · ' + esc(p.city) + ' · ' + esc(date) + '</div>' +
        (stockText ? '<div class="shop-pub-meta" style="' + stockClass + ';font-weight:600">' + esc(stockText) + '</div>' : '') +
        '<div class="shop-pub-meta">' + esc((p.description || '').substring(0, 120)) + '...</div>' +
      '</div>' +
      '<div class="shop-pub-actions">' +
        '<button class="shop-pub-btn cart" onclick="event.stopPropagation();_pCardAddToCart(\'shop-' + esc(p.id) + '\',\'' + pAttr + '\')">🛒 Добавить в корзину</button>' +
        '<button class="shop-pub-btn delete" onclick="deleteShopProduct(\'' + esc(p.id) + '\')">Удалить</button>' +
      '</div>' +
    '</div>'
  );
}

// Shop Admin Panel Functions
window.shopAdminLogin = async () => {
  const phone = document.getElementById('shop-admin-user').value.trim();
  const password = document.getElementById('shop-admin-pass').value.trim();
  const btn = document.getElementById('shop-admin-btn');
  
  if (!phone || !password) {
    toast('Заполните телефон и пароль', 'err');
    return;
  }
  
  btn.disabled = true;
  btn.textContent = 'Входим...';
  
  try {
    const res = await fetch('/api/shops/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error || 'Ошибка входа');
    
    localStorage.setItem('shop_admin_token', data.token);
    localStorage.setItem('shop_admin_name', data.shop_name);
    localStorage.setItem('shop_admin_phone', data.phone);
    
    document.getElementById('shop-admin-login').style.display = 'none';
    document.getElementById('shop-admin-dash').style.display = 'block';
    document.getElementById('shop-admin-title').textContent = data.shop_name + ' — Администратор';
    document.getElementById('shop-admin-welcome').textContent = data.phone;
    
    renderShopAdminOrders();
    toast('✅ Добро пожаловать!', 'success');
  } catch (e) {
    toast(e.message || 'Ошибка входа', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
};

window.shopAdminLogout = () => {
  localStorage.removeItem('shop_admin_token');
  localStorage.removeItem('shop_admin_name');
  localStorage.removeItem('shop_admin_phone');
  document.getElementById('shop-admin-login').style.display = 'block';
  document.getElementById('shop-admin-dash').style.display = 'none';
  document.getElementById('shop-admin-user').value = '';
  document.getElementById('shop-admin-pass').value = '';
  toast('Вы вышли из панели', 'success');
};

window.switchShopAdminTab = (name) => {
  document.querySelectorAll('#shop-admin-dash .atab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('#shop-admin-dash .atab-pane').forEach(p => p.style.display = 'none');
  document.getElementById('tab-' + name).style.display = '';
  if (name === 'shop-orders') renderShopAdminOrders();
};

async function renderShopAdminOrders() {
  const el = document.getElementById('tab-shop-orders');
  el.innerHTML = `<div class="loader">Загружаем…</div>`;
  
  try {
    const token = localStorage.getItem('shop_admin_token');
    const res = await fetch('/api/shops/admin/orders', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const r = await res.json();
    const t = el;
    
    if (!r.data || !r.data.length) {
      t.innerHTML = '<div class="empty"><span>📭</span><h3>Нет заказов</h3></div>';
      return;
    }
    
    const statusMap = { pending:'bd-y', confirmed:'bd-g', rejected:'bd-r' };
    const statusLabel = { pending:'⏳ Ожидает', confirmed:'✅ Подтвержден', rejected:'❌ Отклонен' };
    const deliveryLabel = { pickup:'🏪 Самовывоз', taxi:'🚕 Такси' };
    
    t.innerHTML = r.data.map(o => {
      const st = o.status || 'pending';
      const items = JSON.parse(o.items || '[]');
      const itemsList = items.map(i => `• ${i.title} — ${(i.price||0).toLocaleString('ru')} сом.`).join('<br>');
      
      return `<div class="acard">
        <div class="acard-top">
          <div class="acard-info">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
              <span class="${statusMap[st]||'bd-y'}" style="font-size:.72rem">${statusLabel[st]||st}</span>
              <span style="font-size:.75rem;color:var(--gray)">${fmtD(o.created_at)}</span>
            </div>
            <div class="acard-title">Заказ #${o.id}</div>
            <div style="font-size:.78rem;color:var(--gray);margin-top:3px">📞 ${esc(o.customer_phone)}</div>
            <div style="font-size:.78rem;color:var(--gray)">📍 ${esc(o.customer_address)}</div>
            <div style="font-size:.78rem;color:var(--gray)">🚚 ${deliveryLabel[o.delivery_type]||o.delivery_type}</div>
            <div style="font-size:.9rem;font-weight:700;color:var(--green-d);margin-top:4px">${(o.total||0).toLocaleString('ru')} сом.</div>
          </div>
        </div>
        
        <div style="margin-top:12px;padding:12px;background:var(--warm);border-radius:8px;font-size:.82rem;color:var(--mid)">
          <div style="font-weight:700;margin-bottom:4px">Товары:</div>
          ${itemsList}
        </div>
        
        ${o.receipt_url ? `<div style="margin-top:8px"><a href="${esc(o.receipt_url)}" target="_blank" class="btn btn-outline" style="padding:6px 12px;font-size:.8rem">📸 Чек оплаты</a></div>` : ''}
        
        ${o.receiver_name ? `<div style="margin-top:8px;padding:10px;background:#f0f9ff;border-radius:8px;font-size:.82rem;color:#0c4a6e">
          <div style="font-weight:700;margin-bottom:4px">👤 Получит другой человек:</div>
          <div>Имя: ${esc(o.receiver_name)}</div>
          <div>Телефон: ${esc(o.receiver_phone)}</div>
          <div>Адрес: ${esc(o.receiver_address)}</div>
        </div>` : ''}
        
        ${st === 'pending' ? `<div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary" style="flex:1;padding:8px;font-size:.8rem" onclick="shopConfirmOrder('${o.id}')">✅ Принять</button>
          <button class="btn btn-outline" style="flex:1;padding:8px;font-size:.8rem" onclick="shopRejectOrder('${o.id}')">❌ Отклонить</button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="empty"><span>❌</span><h3>Ошибка загрузки</h3></div>';
  }
}

window.shopConfirmOrder = async (id) => {
  try {
    const token = localStorage.getItem('shop_admin_token');
    const res = await fetch(`/api/shops/admin/orders/${id}/status`, {
      method: 'PATCH',
      headers: { 
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'confirmed' })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    toast('✅ Заказ принят', 'success');
    renderShopAdminOrders();
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
};

window.shopRejectOrder = async (id) => {
  try {
    const token = localStorage.getItem('shop_admin_token');
    const res = await fetch(`/api/shops/admin/orders/${id}/status`, {
      method: 'PATCH',
      headers: { 
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'rejected' })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    toast('❌ Заказ отклонен', 'err');
    renderShopAdminOrders();
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
};

window.deleteShopProduct = async function(id) {
  if (!confirm('Удалить эту публикацию? Это действие нельзя отменить.')) return;
  try {
    await shopFetch('DELETE', '/shops/products/' + encodeURIComponent(id));
    toast('Публикация удалена','ok');
    await renderShopProfile();
  } catch (err) {
    toast(err.message,'err');
  }
};

async function renderGrid() {
  const grid = document.getElementById('pgrid');
  const pgn  = document.getElementById('pgn');
  grid.innerHTML = '<div class="loader">🌸 Загружаем...</div>';
  try {
    const params = getCatalogParams();
    const isShopUser = Boolean(localStorage.getItem('shop_token')) && filters.mode === 'shop';
    const cKey = JSON.stringify(params) + '|' + (filters.mode === 'shop' ? 'shop' : 'eco') + (isShopUser ? '|shopUser' : '');
    const r = await cached(cKey, () => {
      if (filters.mode === 'shop') {
        return isShopUser ? shopFetch('GET', '/shops-pub' + qs(params)) : api.shopsPub(params);
      }
      return api.products(params);
    });
    if (!r.data?.length) {
      grid.innerHTML = '<div class="empty"><span>🔍</span><h3>Ничего не найдено</h3><p>Попробуйте изменить фильтры</p></div>';
      pgn.innerHTML = ''; return;
    }
    grid.innerHTML = r.data.map(pCard).join('');
    renderPgn(r.total_pages, r.page, pgn);
  } catch(e) {
    grid.innerHTML = '<div class="empty"><span>❌</span><h3>' + e.message + '</h3></div>';
  }
}

// ── pCard with photo scroll + add-to-cart button ──────────
let _cardUid = 0;

const IMG_H = '200px'; // высота фото в карточке каталога

function getShopAvatar(name) {
  if (!name) return '🏪';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '🏪';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function isShopListing(p) {
  if (!p) return false;
  // Use listing_type to determine if product is shop
  return p.listing_type === 'shop' || p.is_shop_listing === true;
}

function pCard(p) {
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const price  = priceWithCommission(p);
  const uid    = 'pci' + (++_cardUid);
  const slug   = esc(p.slug || p.id);

  const pAttr = encodeURIComponent(JSON.stringify(p));

  // Only show shop info for actual shop products (listing_type === 'shop')
  const shopCard = isShopListing(p);
  const shopName = shopCard ? (p.shop_name || 'Магазин') : '';
  const shopPhone = shopCard ? (p.seller_phone || '') : '';
  const shopPhoto = shopCard ? (p.photo_url || p.seller_photo || '') : '';
  const telegramLink = 'https://t.me/rebuket_admin?text=' + encodeURIComponent('Здравствуйте, хочу заказать этот эко-букет: ' + (p.title || ''));
  
  // For shop listings, show shop info with photo instead of description
  const shouldShowShopInfo = shopCard;
  // Premium type badge: eco vs shop
  const typeBadgeHtml = shopCard
    ? '<span class="pcard-type-badge shop">🏪 Магазин</span>'
    : '<span class="pcard-type-badge eco">🌿 Эко</span>';

  const shopAvatarHtml = shopPhoto 
    ? '<img src="' + esc(shopPhoto) + '" style="width:38px;height:38px;border-radius:50%;object-fit:cover;border:2px solid #fff;box-shadow:0 2px 8px rgba(34,160,91,.18)">'
    : '<span style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-d));display:flex;align-items:center;justify-content:center;font-size:1.1rem;color:white;font-weight:700;box-shadow:0 2px 8px rgba(34,160,91,.22)">' + esc(getShopAvatar(shopName)) + '</span>';
  const shopMetaHtml = shouldShowShopInfo
    ? '<div class="pc-shop-row premium" onclick="event.stopPropagation();' + (shopPhone ? 'viewShopProfile(\'' + esc(shopPhone) + '\')' : '') + '">' + shopAvatarHtml + '<div style="flex:1;min-width:0"><div class="pc-shop-name">' + esc(shopName || 'Магазин') + '</div><div style="font-size:.74rem;color:var(--gray);font-weight:600;letter-spacing:.02em">ОТКРЫТЬ МАГАЗИН →</div></div></div>'
    : '<p>' + esc((p.description||'').substring(0,65)) + '...</p>';

  // ── photo block ──
  let photoBlock;

  if (photos.length === 0) {
    photoBlock =
      '<div class="pcard-img-wrap">' +
        '<div class="pcard-img" id="' + uid + '" style="height:' + IMG_H + ';display:flex;align-items:center;justify-content:center;overflow:hidden">' +
          '<div class="pcard-ph ' + (CAT_CLS[p.category]||'') + '">' + (CAT_EM[p.category]||'🌸') + '</div>' +
        '</div>' +
        '<span class="pbadge">' + esc(CAT_LABEL[p.category]||p.category) + '</span>' +
        typeBadgeHtml +
        timerBadge(p) +
      '</div>';

  } else if (photos.length === 1) {
    photoBlock =
      '<div class="pcard-img-wrap">' +
        '<div class="pcard-img" id="' + uid + '" style="height:' + IMG_H + ';overflow:hidden">' +
          '<img src="' + esc(imgUrl(photos[0],400)) + '" alt="' + esc(p.title) + '" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;display:block">' +
        '</div>' +
        '<span class="pbadge">' + esc(CAT_LABEL[p.category]||p.category) + '</span>' +
        typeBadgeHtml +
        timerBadge(p) +
      '</div>';

  } else {
    const imgs = photos.map(ph =>
      '<img src="' + esc(imgUrl(ph,400)) + '" alt="' + esc(p.title) + '" loading="lazy" decoding="async" style="flex:0 0 100%;width:100%;height:100%;object-fit:cover;scroll-snap-align:start">'
    ).join('');
    const dots = photos.map((_,i) =>
      '<span class="img-dot' + (i===0?' active':'') + '" onclick="event.stopPropagation();_scrollCard(\'' + uid + '\',' + i + ')"></span>'
    ).join('');
    photoBlock =
      '<div class="pcard-img-wrap" id="' + uid + '-wrap">' +
        '<button class="img-arrow left"  onclick="event.stopPropagation();_scrollCard(\'' + uid + '\',-1,true)">&#8249;</button>' +
        '<button class="img-arrow right" onclick="event.stopPropagation();_scrollCard(\'' + uid + '\', 1,true)">&#8250;</button>' +
        '<div class="pcard-img" id="' + uid + '" onscroll="_syncDots(\'' + uid + '\')" style="display:flex;height:' + IMG_H + ';overflow-x:scroll;scroll-snap-type:x mandatory;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;scrollbar-width:none">' +
          imgs +
        '</div>' +
        '<span class="pbadge">' + esc(CAT_LABEL[p.category]||p.category) + '</span>' +
        typeBadgeHtml +
        timerBadge(p) +
        '<div class="img-dots">' + dots + '</div>' +
      '</div>';
  }

  return (
    '<div class="pcard" onclick="openProduct(\'' + slug + '\')">' +
      photoBlock +
      '<div class="pcard-body">' +
        '<h4>' + esc(p.title) + '</h4>' +
        shopMetaHtml +
        '<div class="pmeta">' +
          '<span class="pprice">' + fmtPrice(price) + '</span>' +
          '<span class="pcity">📍' + esc(p.city) + '</span>' +
        '</div>' +
        (shopCard
          ? '<button class="pcard-cart-btn" id="' + uid + '-cartbtn" onclick="event.stopPropagation();_pCardAddToCart(\'' + uid + '\',\'' + pAttr + '\')">' +
              '<span style="font-size:1rem">🛒</span> Добавить в корзину' +
            '</button>'
          : '<a class="pcard-cart-btn" onclick="event.stopPropagation()" href="' + esc(telegramLink) + '" target="_blank" rel="noopener">' +
              '<span style="font-size:1rem">✈️</span> Купить через Telegram' +
            '</a>'
        ) +
      '</div>' +
    '</div>'
  );
}

// ── scroll helpers (global) ───────────────────────────────
window._scrollCard = (uid, dirOrIdx, isRelative) => {
  const el = document.getElementById(uid);
  if (!el) return;
  if (isRelative) {
    const cur = Math.round(el.scrollLeft / el.clientWidth);
    const imgs = el.querySelectorAll('img');
    const next = Math.max(0, Math.min(imgs.length - 1, cur + dirOrIdx));
    el.scrollTo({ left: el.clientWidth * next, behavior: 'smooth' });
  } else {
    el.scrollTo({ left: el.clientWidth * dirOrIdx, behavior: 'smooth' });
  }
};

window._syncDots = (uid) => {
  const el   = document.getElementById(uid);
  const wrap = document.getElementById(uid + '-wrap');
  if (!el || !wrap) return;
  const idx = Math.round(el.scrollLeft / el.clientWidth);
  wrap.querySelectorAll('.img-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
};

window._pCardAddToCart = (uid, pAttr) => {
  const p = JSON.parse(decodeURIComponent(pAttr));
  // Block eco products
  if (!isShopListing(p)) {
    if (typeof toast === 'function') toast('🌿 Эко-букеты заказываются через Telegram', 'info');
    return;
  }
  const img = Array.isArray(p.photos) && p.photos[0] ? imgUrl(p.photos[0], 200) : null;
  window.addToCart({
    title: p.title,
    price: priceWithCommission(p),
    city: p.city,
    size: p.size,
    img: img,
    emoji: CAT_EM[p.category],
    slug: p.slug || p.id,
    is_shop_listing: isShopListing(p),
    seller_phone: p.seller_phone,
    seller_name: p.seller_name || p.shop_name,
    seller_photo: p.photo_url || p.seller_photo,
  });
  const btn = document.getElementById(uid + '-cartbtn');
  if (btn) {
    btn.textContent = '✅ В корзине';
    btn.classList.add('added');
  }
};

function renderPgn(total, cur, el) {
  if (total <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from({length:total},(_,i)=>i+1)
    .map(n => '<button class="pgn-btn' + (n===cur?' active':'') + '" onclick="changePage(' + n + ')">' + n + '</button>').join('');
}
window.changePage = async n => { filters.page=n; await renderGrid(); window.scrollTo({top:0}); };

// ── PRODUCT DETAIL ────────────────────────────────────────
window.openProduct = async (slugOrId) => {
  history.pushState(null, '', '#product-' + slugOrId);
  goPage('product', false);
  const el = document.getElementById('pd-content');
  el.innerHTML = '<div class="loader" style="padding:60px">🌸 Загружаем...</div>';
  try {
    const p = await api.product(slugOrId);
    renderDetail(p, el);
  } catch(e) {
    el.innerHTML = '<div class="empty"><span>❌</span><h3>' + e.message + '</h3></div>';
  }
};

function expiryChip(p) {
  if (!EXPIRY_CATS.includes(p.category)) return '';
  const ea = getExpiresAt(p);
  if (!ea) return '';
  const l = getTimeLeft(ea);
  return '<span class="pd-chip" style="background:#fff3cd;color:#856404">⏰ Активно ещё: ' + (l || 'истёк') + '</span>';
}

function renderDetail(p, el) {
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const price  = priceWithCommission(p);
  const pUrl   = location.origin + '/#product-' + (p.slug||p.id);
  window._lbPhotos = photos;
  window._lbIdx = 0;

  // ── миниатюры (если фото больше одного) ──
  const thumbsHtml = photos.length > 1
    ? '<div class="pd-thumbs">' + photos.map((ph, i) =>
        '<img src="' + esc(imgUrl(ph, 120)) + '" ' +
          'class="' + (i === 0 ? 'active' : '') + '" ' +
          'onclick="switchThumb(\'' + esc(ph) + '\',this,' + i + ')" ' +
          'loading="lazy" decoding="async" ' +
          'style="width:72px;height:72px;object-fit:cover;border-radius:10px;cursor:pointer;flex-shrink:0">'
      ).join('') + '</div>'
    : '';

  // ── главное фото или плейсхолдер ──
  const mainImg = photos[0]
    ? '<img id="pd-main" class="pd-main" ' +
        'src="' + esc(imgUrl(photos[0], 800)) + '" ' +
        'alt="' + esc(p.title) + '" ' +
        'onclick="openLightbox(0)" ' +
        'loading="eager" decoding="async" ' +
        'style="width:100%;max-height:360px;object-fit:cover;display:block;border-radius:16px;cursor:zoom-in">'
    : '<div class="pd-main-ph ' + (CAT_CLS[p.category]||'') + '">' + (CAT_EM[p.category]||'🌸') + '</div>';

  const infoHtml = (p.address||p.pickup_time) ? '<div class="pd-info">' +
    (p.address     ? '<div><div class="pd-info-lbl">Адрес</div><div>📍 ' + esc(p.address) + '</div></div>' : '') +
    (p.pickup_time ? '<div><div class="pd-info-lbl">Время</div><div>🕐 ' + esc(p.pickup_time) + '</div></div>' : '') +
    '</div>' : '';

  const shopName  = p.shop_name || '';
  const shopPhone = p.seller_phone || '';
  const shopPhoto = p.photo_url || p.seller_photo || '';
  const shopCard = isShopListing(p);
  const telegramLink = 'https://t.me/rebuket_admin?text=' + encodeURIComponent('Здравствуйте, хочу заказать этот эко-букет: ' + (p.title || ''));
  const shopAvatarHtml = shopPhoto
    ? '<img src="' + esc(shopPhoto) + '" style="width:40px;height:40px;border-radius:50%;object-fit:cover">'
    : '<span style="width:40px;height:40px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:1rem">' + esc(getShopAvatar(shopName)) + '</span>';
  const shopProfileHtml = shopCard && shopPhone && shopName
    ? '<div class="pd-shop-box" onclick="viewShopProfile(\'' + esc(shopPhone) + '\')" style="cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;margin-top:14px;border:1px solid rgba(34,160,91,.18);border-radius:16px;background:#f7fff7;">' +
      '<div style="width:40px;height:40px;flex-shrink:0">' + shopAvatarHtml + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:700;color:#134e4a;">' + esc(shopName) + '</div>' +
        '<div style="font-size:.85rem;color:#286f6b;">Нажмите, чтобы открыть профиль магазина</div>' +
      '</div>' +
      '<span style="color:var(--green);font-size:1.05rem;">→</span>' +
    '</div>'
    : '';

  window._detailProduct = p;
  window._detailPrice   = price;

  el.innerHTML =
    '<div class="pd-wrap">' +
      '<div class="pd-gallery">' + mainImg + thumbsHtml + '</div>' +
      '<div class="pd-body">' +
        '<div class="pd-chips">' +
          '<span class="pd-chip rose">' + esc(CAT_LABEL[p.category]||p.category) + '</span>' +
          '<span class="pd-chip">📍 ' + esc(p.city) + '</span>' +
          '<span class="pd-chip">👁 ' + (p.view_count||0) + ' просмотров</span>' +
          expiryChip(p) +
        '</div>' +
        '<h2>' + esc(p.title) + '</h2>' +
        '<div class="pd-price">' + fmtPrice(price) + '</div>' +
        '<p class="pd-desc">' + esc(p.description||'') + '</p>' +
        shopProfileHtml +
        '<div class="share-row">🔗 <input id="share-inp" type="text" value="' + esc(pUrl) + '" readonly><button onclick="copyLink()">Копировать</button></div>' +
        infoHtml +
        (shopCard
          ? '<button class="pd-cart-btn" id="pd-detail-cartbtn" onclick="_pdDetailAddToCart(this)">' +
              '<span style="font-size:1.2rem">🛒</span> Добавить в корзину' +
            '</button>'
          : '<a class="pd-cart-btn btn-tg" onclick="event.stopPropagation()" href="' + esc(telegramLink) + '" target="_blank" rel="noopener">' +
              '<span style="font-size:1.2rem">✈️</span> Купить через Telegram' +
            '</a>'
        ) +
        '<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">' +
          '<a class="btn btn-tg" href="' + esc(_cfg.telegram) + '" target="_blank" style="flex:1;min-width:140px;border-radius:14px;padding:13px 18px">✈️ Telegram</a>' +
          '<a class="btn btn-ig" href="' + esc(_cfg.instagram) + '" target="_blank" style="flex:1;min-width:140px;border-radius:14px;padding:13px 18px">📸 Instagram</a>' +
        '</div>' +
      '</div>' +
    '</div>';
}

window._pdDetailAddToCart = (btn) => {
  const p = window._detailProduct;
  if (!p) return;
  // Block eco products from being added to cart
  if (!isShopListing(p)) {
    if (typeof toast === 'function') toast('🌿 Эко-букеты заказываются через Telegram', 'info');
    return;
  }
  const price  = window._detailPrice || priceWithCommission(p);
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const emoji  = CAT_EM[p.category] || '🌸';
  if (window.addToCart) {
    window.addToCart({ 
      id: p.id || p.pub_id, 
      title: p.title, 
      price, 
      city: p.city, 
      size: p.size, 
      img: photos[0] || null, 
      emoji,
      is_shop_listing: true,
      seller_phone: p.seller_phone,
      seller_name: p.seller_name || p.shop_name,
      seller_photo: p.photo_url || p.seller_photo,
    });
  }
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '<span style="font-size:1.2rem">✓</span> Добавлено в корзину!';
    btn.classList.add('added'); btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('added'); btn.disabled = false; }, 2000);
  }
};

window.switchThumb = (src, el, idx) => {
  window._lbIdx = idx || 0;
  const main = document.getElementById('pd-main');
  if (main) main.src = src;
  document.querySelectorAll('.pd-thumbs img').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
};
window.copyLink = () => {
  const v = document.getElementById('share-inp')?.value;
  if (v) navigator.clipboard.writeText(v).then(() => toast('Ссылка скопирована!','ok')).catch(()=>{});
};

// ── LIGHTBOX ──────────────────────────────────────────────
window.openLightbox = (idx) => {
  const photos = window._lbPhotos || [];
  if (!photos.length) return;
  window._lbIdx = idx || 0;
  document.getElementById('lb-img').src = photos[window._lbIdx];
  document.getElementById('lightbox').style.display = 'flex';
};
window.closeLightbox = () => { document.getElementById('lightbox').style.display = 'none'; };
window.lightboxPrev = (e) => {
  e.stopPropagation();
  const p = window._lbPhotos || [];
  if (!p.length) return;
  window._lbIdx = (window._lbIdx - 1 + p.length) % p.length;
  document.getElementById('lb-img').src = p[window._lbIdx];
};
window.lightboxNext = (e) => {
  e.stopPropagation();
  const p = window._lbPhotos || [];
  if (!p.length) return;
  window._lbIdx = (window._lbIdx + 1) % p.length;
  document.getElementById('lb-img').src = p[window._lbIdx];
};

// ── INQUIRY MODAL (kept for admin workflows) ──────────────
window.openInqModal = (pid, title, slug) => {
  document.getElementById('inq-pid').value   = pid   || '';
  document.getElementById('inq-slug').value  = slug  || pid || '';
  document.getElementById('inq-title').textContent = 'Заявка: ' + title;
  openModal('inq-modal');
};

window.submitInquiry = async () => {
  const phone = document.getElementById('inq-phone').value.trim();
  if (!phone) { toast('Введите телефон!', 'err'); return; }

  const btn   = document.getElementById('inq-btn');
  const name  = document.getElementById('inq-name').value.trim();
  const tg    = document.getElementById('inq-tg').value.trim();
  const note  = document.getElementById('inq-note').value.trim();
  const title = document.getElementById('inq-title').textContent.replace('Заявка: ', '');
  const pid   = document.getElementById('inq-pid').value;
  const slug  = document.getElementById('inq-slug')?.value || pid;
  const pageUrl = slug ? (location.origin + '/#product-' + slug) : location.href;

  btn.disabled = true; btn.textContent = 'Отправляем...';
  try {
    let buyerChatId = null;
    try {
      const tgW = window.Telegram?.WebApp;
      if (tgW?.initDataUnsafe?.user?.id) buyerChatId = String(tgW.initDataUnsafe.user.id);
    } catch(ex) {}

    await api.inquiry({
      product_id:        pid        || undefined,
      customer_name:     name       || undefined,
      customer_phone:    phone,
      customer_telegram: tg         || undefined,
      note:              note       || undefined,
      customer_chat_id:  buyerChatId|| undefined,
    });

    window.closeModal('inq-modal');
    ['inq-name','inq-phone','inq-tg','inq-note'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    const NL = '\n';
    let msg = '🌸 Здравствуйте! Хочу купить:' + NL + NL;
    msg += '📦 ' + title + NL;
    msg += '📞 Мой телефон: ' + phone + NL;
    if (name) msg += '👤 Имя: '        + name + NL;
    if (tg)   msg += '✈️ Telegram: '   + tg   + NL;
    if (note) msg += '📝 Комментарий: '+ note + NL;
    msg += NL + '🔗 ' + pageUrl;

    const adminRaw    = (_cfg.telegram || 'https://t.me/Rebuket_admin');
    const adminHandle = adminRaw.replace('https://t.me/', '').replace('@', '').trim();
    const adminUrl    = 'https://t.me/' + adminHandle + '?text=' + encodeURIComponent(msg);

    const oldP = document.getElementById('inq-popup');
    if (oldP) oldP.remove();

    const ov = document.createElement('div');
    ov.id = 'inq-popup';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:flex-end;justify-content:center;padding:16px';

    const bx = document.createElement('div');
    bx.style.cssText = 'background:#fff;border-radius:24px;padding:32px 24px 28px;width:100%;max-width:440px;text-align:center';

    const ic = document.createElement('div');
    ic.style.cssText = 'font-size:3rem;margin-bottom:10px';
    ic.textContent = '✅';

    const tl = document.createElement('div');
    tl.style.cssText = 'font-size:1.15rem;font-weight:800;margin-bottom:10px;color:#1a1a1a';
    tl.textContent = 'Заявка принята!';

    const ds = document.createElement('div');
    ds.style.cssText = 'color:#555;font-size:.9rem;line-height:1.5;margin-bottom:22px';
    ds.textContent = 'Скопируйте готовое сообщение, откройте чат администратора и вставьте его.';

    const ta = document.createElement('textarea');
    ta.value = msg;
    ta.readOnly = true;
    ta.style.cssText = 'width:100%;height:120px;border:1px solid #eee;border-radius:10px;padding:10px;font-size:.82rem;resize:none;background:#f9f9f9;margin-bottom:10px;box-sizing:border-box;text-align:left';

    const cpBtn = document.createElement('button');
    cpBtn.style.cssText = 'width:100%;padding:13px;background:#8B2A3F;color:#fff;border-radius:14px;font-weight:700;font-size:1rem;border:none;cursor:pointer;margin-bottom:8px';
    cpBtn.textContent = '📋 Скопировать сообщение';
    cpBtn.onclick = () => {
      navigator.clipboard.writeText(msg).then(() => {
        cpBtn.textContent = '✅ Скопировано!';
        setTimeout(() => cpBtn.textContent = '📋 Скопировать сообщение', 2000);
      }).catch(() => { ta.select(); document.execCommand('copy'); });
    };

    const bb = document.createElement('a');
    bb.href = adminUrl;
    bb.style.cssText = 'display:block;padding:13px;background:#229ED9;color:#fff;border-radius:14px;font-weight:700;font-size:1rem;text-decoration:none;margin-bottom:10px';
    bb.textContent = '✈️ Открыть чат администратора';

    const cb = document.createElement('button');
    cb.style.cssText = 'width:100%;padding:12px;background:#f0f0f0;border:none;border-radius:14px;cursor:pointer;font-size:.9rem;color:#666';
    cb.textContent = 'Закрыть';
    cb.onclick = () => ov.remove();

    bx.appendChild(ic); bx.appendChild(tl); bx.appendChild(ds);
    bx.appendChild(ta); bx.appendChild(cpBtn); bx.appendChild(bb); bx.appendChild(cb);
    ov.appendChild(bx);
    document.body.appendChild(ov);

  } catch(e) { toast('Ошибка: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '📩 Отправить заявку'; }
};

// ── FILTERS ───────────────────────────────────────────────
export async function filterAndGo(cat, mode = null) {
  const map = { Букет:'bouquet', Корзина:'basket', Мишка:'bear', Сладости:'sweets' };
  const selectedMode = mode || (document.getElementById('cats-shop')?.style.display === 'grid' ? 'shop' : 'eco');
  filters.category = map[cat] || '';
  filters.mode = selectedMode;
  catalogMode = selectedMode;
  delete filters.shop_phone;

  const ecoBtn = document.getElementById('cat-mode-eco');
  const shopBtn = document.getElementById('cat-mode-shop');
  const banner = document.getElementById('catalog-mode-banner');
  if (ecoBtn) ecoBtn.classList.toggle('active', selectedMode === 'eco');
  if (shopBtn) shopBtn.classList.toggle('active', selectedMode === 'shop');
  if (banner) {
    if (selectedMode === 'eco') {
      banner.className = 'mode-banner eco-banner';
      banner.textContent = '🌿 Показаны Эко-объявления — перепродажа от частных лиц';
    } else {
      banner.className = 'mode-banner shop-banner';
      banner.textContent = '🏪 Показаны объявления от профессиональных магазинов';
    }
  }

  await loadCatalog({ page: 1 });
  goPage('catalog');
}
window.filterAndGo = filterAndGo;

window.setCat = async (cat, el) => {
  document.querySelectorAll('#cat-chips .chip').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const map = { Все:'', Букеты:'bouquet', Корзины:'basket', Мишки:'bear', Сладости:'sweets' };
  filters.category = map[cat] || '';
  await loadCatalog({ page: 1 });
};
window.applyFilters = async () => {
  filters.city      = document.getElementById('f-city')?.value      || '';
  filters.min_price = document.getElementById('f-price-min')?.value || '';
  filters.max_price = document.getElementById('f-price-max')?.value || '';
  filters.search    = document.getElementById('f-search')?.value    || '';
  await loadCatalog({ page: 1 });
};

// ── SELL FORM ─────────────────────────────────────────────
let sellFiles = [];

window.handlePhotos = e => {
  const newFiles = Array.from(e.target.files);
  if (!newFiles.length) return;
  sellFiles = [...sellFiles, ...newFiles];
  renderSellPhotos();
  e.target.value = '';
};

function renderSellPhotos() {
  const grid = document.getElementById('sell-photo-grid');
  const hint = document.getElementById('photo-hint');
  if (!grid) return;
  grid.innerHTML = sellFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return '<div class="photo-thumb"><img src="' + url + '"><button class="photo-del" onclick="removePhoto(' + i + ')">x</button></div>';
  }).join('');
  if (hint) {
    if (sellFiles.length === 0) {
      hint.textContent = 'Минимум 3 фото';
      hint.style.color = 'var(--gray)';
      hint.style.fontWeight = '';
    } else if (sellFiles.length < 3) {
      hint.textContent = 'Загружено ' + sellFiles.length + ' из 3 — нужно ещё ' + (3 - sellFiles.length);
      hint.style.color = '#e67e22';
      hint.style.fontWeight = '700';
    } else {
      hint.textContent = '✅ Загружено ' + sellFiles.length + ' фото — готово!';
      hint.style.color = '#27ae60';
      hint.style.fontWeight = '700';
    }
  }
}
window.removePhoto = i => { sellFiles.splice(i,1); renderSellPhotos(); };

window.selectSize = (val, el) => {
  document.querySelectorAll('#size-chips .chip').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('sell-size').value = val;
  document.getElementById('size-error').style.display = 'none';
};

window.selectGiftWhen = (val, el) => {
  document.querySelectorAll('#gift-when-chips .chip').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('sell-gift-when').value = val;
  document.getElementById('gift-when-error').style.display = 'none';
};

function updateSizeField(catVal) {
  const sizeField = document.getElementById('size-field');
  if (!sizeField) return;

  const needsSize = ['bouquet', 'basket', 'bear'].includes(catVal);
  sizeField.style.display = needsSize ? '' : 'none';

  if (!needsSize) {
    document.getElementById('sell-size').value = '';
    document.querySelectorAll('#size-chips .chip').forEach(b => b.classList.remove('active'));
    return;
  }

  const chipsWrap = document.getElementById('size-chips-wrap');
  const textWrap  = document.getElementById('size-text-wrap');

  if (catVal === 'bear') {
    if (chipsWrap) chipsWrap.style.display = 'none';
    if (textWrap)  textWrap.style.display  = '';
    document.getElementById('sell-size').value = '';
  } else {
    if (chipsWrap) chipsWrap.style.display = '';
    if (textWrap)  textWrap.style.display  = 'none';
    document.getElementById('sell-size').value = '';
    document.querySelectorAll('#size-chips .chip').forEach(b => b.classList.remove('active'));
  }
}

window.selectCat = (el) => {
  document.querySelectorAll('.cat-sel').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  const val = el.dataset.val;
  document.getElementById('sell-cat-val').value = val;
  updateSizeField(val);
};

window.updateBearSizeInput = () => {
  const val = document.getElementById('sell-size-text')?.value.trim();
  const hidden = document.getElementById('sell-size');
  if (hidden) hidden.value = val ? val + ' см' : '';
  const err = document.getElementById('size-error');
  if (err && val) err.style.display = 'none';
};

window.updatePricePreview = () => {
  const val = Number(document.getElementById('sell-price').value);
  const cat = document.getElementById('sell-cat-val')?.value || '';
  const preview = document.getElementById('price-preview');
  if (!val || val <= 0) { if(preview) preview.style.display = 'none'; return; }
  const rate = getCommission(cat);
  const total = Math.ceil((val * (1 + rate)).toFixed(2) / 10) * 10;
  document.getElementById('price-seller').textContent = fmtPrice(val);
  document.getElementById('price-total').textContent  = fmtPrice(total);
  if(preview) preview.style.display = 'block';
};

function getTelegramUserId() {
  try {
    const tg = window.Telegram?.WebApp;
    if (tg?.initDataUnsafe?.user?.id) return String(tg.initDataUnsafe.user.id);
  } catch {}
  return null;
}

function markField(id, valid) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.borderColor = valid ? '' : '#dc3545';
  el.style.boxShadow   = valid ? '' : '0 0 0 3px rgba(220,53,69,.15)';
}

function scrollToFirst(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && (!el.value?.trim() || (el.tagName === 'SELECT' && !el.value))) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      return;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  ['sell-title','sell-price','sell-city','sell-phone','sell-address'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => markField(id, true));
  });

  const catVal = document.getElementById('sell-cat-val')?.value;
  if (catVal) updateSizeField(catVal);

  // Hide market price field if logged in as shop
  const shop = getShopSession();
  if (shop.phone) {
    const marketPriceField = document.getElementById('market-price-field');
    if (marketPriceField) marketPriceField.style.display = 'none';
  }
});

window.submitListing = async () => {
  const title    = document.getElementById('sell-title').value.trim();
  const price    = document.getElementById('sell-price').value;
  const city     = document.getElementById('sell-city').value;
  let phone    = document.getElementById('sell-phone').value.trim();
  const category = document.getElementById('sell-cat-val')?.value;

  // If logged in as shop, use shop phone
  const shop = getShopSession();
  if (shop.phone) {
    phone = shop.phone;
  }

  markField('sell-title', !!title);
  markField('sell-price', !!price);
  markField('sell-city',  !!city);
  markField('sell-phone', !!phone);

  if (category === 'bear') {
    const bearText = document.getElementById('sell-size-text')?.value.trim();
    const hidden = document.getElementById('sell-size');
    if (hidden) hidden.value = bearText ? bearText + ' см' : '';
  }

  const size = document.getElementById('sell-size')?.value;
  const needsSize = ['bouquet','basket','bear'].includes(category);
  if (needsSize && !size) {
    document.getElementById('size-error').style.display = 'block';
    document.getElementById('size-field')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const giftWhen = document.getElementById('sell-gift-when')?.value;
  if (!giftWhen) {
    document.getElementById('gift-when-error').style.display = 'block';
    document.getElementById('gift-when-chips')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const address = document.getElementById('sell-address').value.trim();
  markField('sell-address', !!address);

  if (!title||!price||!city||!phone||!category||!address) {
    toast('Заполните все обязательные поля!','err');
    scrollToFirst(['sell-title','sell-price','sell-city','sell-phone','sell-address']);
    return;
  }
  if (needsSize && !size) {
    toast(category === 'bear' ? 'Введите размер мишки!' : 'Выберите размер!','err');
    return;
  }
  if (!giftWhen) {
    toast('Укажите когда получили!','err');
    return;
  }
  if (sellFiles.length < 3) {
    document.getElementById('photo-hint')?.scrollIntoView({ behavior:'smooth', block:'center' });
    toast('Загрузите минимум 3 фотографии!','err');
    return;
  }

  const fd = new FormData();
  fd.append('title',           title);
  fd.append('description',     document.getElementById('sell-desc').value.trim());
  fd.append('category',        category);
  fd.append('price',           price);
  fd.append('city',            city);
  // If logged in as shop, use shop name for seller_name
  let sellerName = document.getElementById('sell-name').value.trim();
  if (shop.name) {
    sellerName = shop.name;
  }
  fd.append('seller_name',     sellerName);
  fd.append('seller_phone',    phone);
  fd.append('seller_telegram', document.getElementById('sell-tg').value.trim());
  fd.append('address',         document.getElementById('sell-address').value.trim());
  fd.append('pickup_time',     document.getElementById('sell-time').value.trim());
  fd.append('gift_when',        giftWhen);
  if (size) fd.append('size', size);
  const marketPrice = document.getElementById('sell-market-price')?.value;
  if (marketPrice) fd.append('market_price', marketPrice);
  fd.append('stock',          document.getElementById('sell-stock')?.value || '');
  sellFiles.forEach(f => fd.append('photos', f));
  const tgId = getTelegramUserId();
  if (tgId) fd.append('seller_chat_id', tgId);

  const btn = document.getElementById('sell-btn');
  btn.disabled = true; btn.textContent = 'Отправляем...';
  try {
    await api.addProduct(fd);
    _cache.clear();
    toast('Объявление подано! Ждет проверки.','ok');
    ['sell-title','sell-desc','sell-price','sell-phone','sell-name','sell-tg','sell-address','sell-time']
      .forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    document.getElementById('sell-city').value = '';
    document.getElementById('sell-gift-when').value = '';
    document.querySelectorAll('#gift-when-chips .chip').forEach(b => b.classList.remove('active'));
    const mpEl = document.getElementById('sell-market-price'); if (mpEl) mpEl.value = '';
    document.getElementById('sell-size').value = '';
    const sizeText = document.getElementById('sell-size-text'); if (sizeText) sizeText.value = '';
    document.querySelectorAll('#size-chips .chip').forEach(b => b.classList.remove('active'));
    const sf = document.getElementById('size-field'); if (sf) sf.style.display = 'none';
    sellFiles = []; renderSellPhotos();
    setTimeout(() => goPage('catalog'), 1600);
  } catch(e) { toast('Ошибка: '+e.message,'err'); }
  finally { btn.disabled=false; btn.textContent='Разместить объявление'; }
};

// ── HOME COUNTS ───────────────────────────────────────────
export async function loadCounts() {
  try {
    const [ecoBouquet, ecoBasket, ecoBear, ecoSweets, shopBouquet, shopBasket, shopBear, shopSweets] = await Promise.all([
      api.products({ category:'bouquet', limit:1, listing_type:'eco' }),
      api.products({ category:'basket',  limit:1, listing_type:'eco' }),
      api.products({ category:'bear',    limit:1, listing_type:'eco' }),
      api.products({ category:'sweets',  limit:1, listing_type:'eco' }),
      api.shopsPub({ category:'bouquet', limit:1 }),
      api.shopsPub({ category:'basket',  limit:1 }),
      api.shopsPub({ category:'bear',    limit:1 }),
      api.shopsPub({ category:'sweets',  limit:1 }),
    ]);
    const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent = v + ' предложений'; };
    set('cnt-bouquet',     ecoBouquet.total);
    set('cnt-basket',      ecoBasket.total);
    set('cnt-bear',        ecoBear.total);
    set('cnt-sweets',      ecoSweets.total);
    set('cnt-shop-bouquet', shopBouquet.total);
    set('cnt-shop-basket',  shopBasket.total);
    set('cnt-shop-bear',    shopBear.total);
    set('cnt-shop-sweets',  shopSweets.total);
  } catch {}
}

export async function refreshShopProfileUI() {
  const profile = document.getElementById('shop-profile-bar');
  if (!profile) return;

  const shop = getShopSession();
  if (!shop.phone || !shop.name) {
    profile.style.display = 'none';
    return;
  }

  profile.style.display = 'flex';
  const avatar = document.getElementById('shop-profile-avatar');
  const nameEl = document.getElementById('shop-profile-name');
  const countEl = document.getElementById('shop-profile-count');
  
  // Try to get shop photo from localStorage
  const shopPhoto = localStorage.getItem('shop_photo');
  
  if (avatar) {
    if (shopPhoto) {
      avatar.innerHTML = '<img src="' + esc(shopPhoto) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
      avatar.style.background = 'transparent';
    } else {
      avatar.textContent = getShopAvatar(shop.name);
      avatar.style.background = '#ffffff';
    }
  }
  
  if (nameEl) nameEl.textContent = shop.name;

  if (countEl) {
    try {
      const r = await shopFetch('GET', '/shops-pub' + qs({ shop_phone: shop.phone, limit: 1 }));
      countEl.textContent = (r.total || 0) + ' публикаций';
    } catch (e) {
      countEl.textContent = '— публикаций';
    }
  }
}

export async function loadCities(selId) {
  try {
    const cities = await api.cities();
    const base = ['Душанбе','Худжанд','Куляб','Бохтар','Вахдат','Турсунзода','Исфара','Шахринав','Дангара','Регар','Бустон'];
    const all = [...new Set([...base, ...cities])].sort();
    const sel = document.getElementById(selId);
    if (!sel) return;
    sel.innerHTML = '<option value="">Все города</option>' + all.map(c=>'<option>' + esc(c) + '</option>').join('');
  } catch {}
}

// ── HASH ROUTER ───────────────────────────────────────────
export async function handleRoute() {
  const hash = location.hash || '#home';
  if (hash.startsWith('#product-')) {
    window.openProduct(hash.replace('#product-',''));
  } else {
    const page = hash.replace('#','') || 'home';
    const valid = ['home','catalog','sell','admin','product','shop-profile'];
    goPage(valid.includes(page) ? page : 'home', false);
    if (page === 'catalog') await loadCatalog();
    if (page === 'shop-profile') await openShopProfile();
  }
}
