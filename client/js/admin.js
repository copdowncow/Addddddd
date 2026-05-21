'use strict';
import { api, setTok, clrTok, isAuth } from './api.js';
import { esc, fmt, fmtD, toast }        from './utils.js';

function getCommission(category) {
  return category === 'sweets' ? 0.10 : 0.25;
}

export function checkAdminAuth() {
  if (isAuth()) showDash();
}

window.adminLogin = async () => {
  const u = document.getElementById('a-user').value.trim();
  const p = document.getElementById('a-pass').value;
  if (!u||!p) return;
  const btn = document.getElementById('a-btn');
  btn.disabled=true; btn.textContent='Входим…';
  try {
    const r = await api.login(u, p);
    setTok(r.token);
    document.getElementById('a-welcome').textContent = 'Добро пожаловать, ' + r.admin.username + '!';
    showDash();
    toast('Вход выполнен!','ok');
  } catch(e) { toast(e.message,'err'); }
  finally { btn.disabled=false; btn.textContent='Войти'; }
};

window.adminLogout = () => {
  clrTok();
  document.getElementById('a-login').style.display = '';
  document.getElementById('a-dash').style.display  = 'none';
  toast('Вы вышли из системы');
};

function showDash() {
  document.getElementById('a-login').style.display = 'none';
  document.getElementById('a-dash').style.display  = '';
  loadDashStats();
  switchTab('products');
}

async function loadDashStats() {
  try {
    const d  = await api.stats();
    const pS = d.products || {};
    const iS = d.inquiries || {};
    document.getElementById('a-stats').innerHTML = [
      { e:'📦', n:pS.total||0,   l:'Всего товаров' },
      { e:'⏳', n:pS.pending||0, l:'На проверке' },
      { e:'✅', n:pS.active||0,  l:'Активных' },
      { e:'🛒', n:iS.total||0,   l:'Заявок' },
      { e:'🆕', n:iS.new_inq||0, l:'Новых заявок' },
    ].map(s=>`<div class="s-card"><em>${s.e}</em><b>${s.n}</b><small>${s.l}</small></div>`).join('');
  } catch {}
}

let _curTab = 'products';
window.switchTab = async name => {
  _curTab = name;
  document.querySelectorAll('.atab').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.atab-pane').forEach(p => p.style.display='none');
  document.getElementById('tab-'+name).style.display='';
  if (name==='products')  await renderProducts();
  if (name==='inquiries') await renderInquiries();
  if (name==='orders')    await renderOrders();
  if (name==='stats')     await renderStats();
};

let pFilter = '';
let pSearch = '';
let _searchTimer = null;

window.setPSearch = (val) => {
  pSearch = val;
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => renderProducts(), 400);
};

window.setPFilter = (s,el) => {
  pFilter = s;
  document.querySelectorAll('#p-filter-chips .chip').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  renderProducts();
};

function priceOnChannel(p) {
  if (p.is_admin_price) return p.price;
  return Math.ceil(p.price * (1 + getCommission(p.category)) / 10) * 10;
}

function priceToSeller(p) {
  if (p.is_admin_price) return Math.round(p.price / (1 + getCommission(p.category)));
  return p.price;
}

async function renderProducts() {
  const el = document.getElementById('tab-products');
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <input id="p-search" type="text" placeholder="🔍 Поиск по названию..." value="${pSearch}"
        oninput="setPSearch(this.value)"
        style="flex:1;min-width:180px;padding:8px 12px;border:2px solid #eee;border-radius:10px;font-size:.88rem;outline:none;font-family:'Jost',sans-serif">
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px" id="p-filter-chips">
      ${[['','Все'],['pending','⏳ На проверке'],['active','✅ Активные'],['hidden','🙈 Скрытые']]
        .map(([v,l])=>`<button class="chip${pFilter===v?' active':''}" onclick="setPFilter('${v}',this)">${l}</button>`).join('')}
    </div>
    <div id="p-table"><div class="loader">Загружаем…</div></div>`;

  try {
    const r = await api.adminProducts({ status:pFilter, limit:100 });
    _productsCache = r.data || [];
    const t = document.getElementById('p-table');
    let rows = r.data || [];
    if (pSearch.trim()) {
      const q = pSearch.trim().toLowerCase();
      rows = rows.filter(p =>
        (p.title||'').toLowerCase().includes(q) ||
        (p.seller_name||'').toLowerCase().includes(q) ||
        (p.seller_phone||'').toLowerCase().includes(q) ||
        (p.city||'').toLowerCase().includes(q)
      );
    }
    if (!rows.length) { t.innerHTML='<div class="empty"><span>📭</span><h3>Нет объявлений</h3></div>'; return; }
    const CAT = { bouquet:'💐 Букет', basket:'🧺 Корзина', bear:'🧸 Игрушки', sweets:'🍰 Сладости' };
    const BD  = { active:'bd-g', pending:'bd-y', hidden:'bd-r' };
    const BL  = { active:'✅ Активно', pending:'⏳ Проверка', hidden:'🙈 Скрыто' };

    t.innerHTML = rows.map(p => {
      const photos = (p.photos||[]).slice(0,4);
      const statusDot = `<span class="${BD[p.status]||'bd-y'}" style="font-size:.72rem">${BL[p.status]||p.status}</span>`;

      return `<div class="acard">
        <div class="acard-top">
          <div class="acard-info">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
              <span style="font-size:.75rem;color:var(--gray)">${CAT[p.category]||p.category}</span>
              ${statusDot}
            </div>
            <div class="acard-title">${esc(p.title)}</div>
            <div style="font-size:.78rem;color:var(--gray);margin-top:3px">${fmtD(p.created_at)}</div>
          </div>
          <div style="text-align:right;min-width:130px">
            <div style="font-size:.7rem;color:var(--gray);margin-bottom:2px">Цена на канале</div>
            <div class="acard-price">${fmt(priceOnChannel(p))} TJS</div>
            <div style="font-size:.72rem;color:var(--gray);margin-top:4px">Доля продавца</div>
            <div style="font-size:.85rem;font-weight:700;color:#27ae60">${fmt(priceToSeller(p))} TJS</div>
          </div>
        </div>

        ${photos.length ? `<div class="acard-photos">${photos.map(ph =>
          `<img src="${esc(ph)}" onclick="window.open('${esc(ph)}','_blank')">`
        ).join('')}</div>` : ''}

        <div class="acard-meta">
          <span>📍 ${esc(p.city)}</span>
          ${p.seller_name ? `<span>👤 ${esc(p.seller_name)}</span>` : ''}
          <a href="tel:${esc(p.seller_phone)}" style="color:var(--rose-d);font-weight:700">📞 ${esc(p.seller_phone)}</a>
          ${p.seller_telegram ? `<a href="https://t.me/${esc(p.seller_telegram.replace('@',''))}" target="_blank">✈️ ${esc(p.seller_telegram)}</a>` : ''}
          ${p.address ? `<span>🏠 ${esc(p.address)}</span>` : ''}
          ${p.pickup_time ? `<span>🕐 ${esc(p.pickup_time)}</span>` : ''}
          ${p.gift_when ? `<span>🎁 Подарили: ${esc(p.gift_when)}</span>` : ''}
        </div>

        <div class="acard-actions">
          ${p.status==='pending' ? `
            <button class="aact-btn aact-g" onclick="pAct('${p.id}','active')">✅ Одобрить</button>
            <button class="aact-btn aact-r" onclick="pAct('${p.id}','hidden')">❌ Отклонить</button>
          ` : ''}
          ${p.status==='active'  ? `<button class="aact-btn aact-gray" onclick="pAct('${p.id}','hidden')">🙈 Скрыть</button>` : ''}
          ${p.status==='hidden'  ? `<button class="aact-btn aact-g"    onclick="pAct('${p.id}','active')">👁 Показать</button>` : ''}
          <button class="aact-btn aact-b" onclick="openEditModal('${esc(p.id)}')">✏️ Изменить</button>
          <a class="aact-btn aact-b" href="/#product-${esc(p.slug||p.id)}" target="_blank">🔗 Открыть</a>
          <button class="aact-btn aact-r" onclick="pDel('${p.id}')">🗑 Удалить</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { document.getElementById('p-table').innerHTML=`<div class="empty"><h3>${e.message}</h3></div>`; }
}

window.pAct = async (id,status) => {
  try {
    const fd = new FormData(); fd.append('status',status);
    await api.updateProduct(id,fd);
    toast('Обновлено','ok'); renderProducts(); loadDashStats();
  } catch(e) { toast(e.message,'err'); }
};
window.pDel = async id => {
  if (!confirm('Удалить объявление?')) return;
  try { await api.deleteProduct(id); toast('Удалено','ok'); renderProducts(); loadDashStats(); }
  catch(e) { toast(e.message,'err'); }
};

// ── Редактирование объявления ─────────────────────────────

let _productsCache = [];

window.openEditModal = (id) => {
  const p = _productsCache.find(x => x.id === id);
  if (!p) { toast('Объявление не найдено', 'err'); return; }

  let modal = document.getElementById('edit-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'edit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.onclick = e => { if (e.target===modal) modal.remove(); };
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto;position:relative">
      <button onclick="document.getElementById('edit-modal').remove()" style="position:absolute;top:14px;right:16px;background:none;border:none;font-size:1.3rem;cursor:pointer;color:var(--gray)">✕</button>
      <h3 style="margin-bottom:20px">✏️ Редактировать объявление</h3>

      <input type="hidden" id="em-id" value="${esc(p.id)}">
      <input type="hidden" id="em-status" value="${esc(p.status)}">

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Категория</label>
        <select id="em-category" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem">
          <option value="bouquet"  ${p.category==='bouquet' ?'selected':''}>💐 Букет</option>
          <option value="basket"   ${p.category==='basket'  ?'selected':''}>🧺 Корзина</option>
          <option value="bear"     ${p.category==='bear'    ?'selected':''}>🧸 Мишка</option>
          <option value="sweets"   ${p.category==='sweets'  ?'selected':''}>🍰 Сладости</option>
        </select>
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Название</label>
        <input id="em-title" type="text" value="${esc(p.title)}" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Описание</label>
        <textarea id="em-description" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;height:90px;resize:vertical;box-sizing:border-box">${esc(p.description||'')}</textarea>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
        <div>
          <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Цена (TJS)</label>
          <input id="em-price" type="number" value="${p.price}" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
        </div>
        <div>
          <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Город</label>
          <select id="em-city" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem">
            ${['Душанбе','Худжанд','Куляб','Бохтар','Вахдат','Турсунзода','Исфара','Шахринав','Дангара','Регар','Бустон']
              .map(c=>`<option ${p.city===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Адрес</label>
        <input id="em-address" type="text" value="${esc(p.address||'')}" placeholder="Адрес получения" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Время получения</label>
        <input id="em-pickup_time" type="text" value="${esc(p.pickup_time||'')}" placeholder="Например: с 10:00 до 18:00" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Размер</label>
        <input id="em-size" type="text" value="${esc(p.size||'')}" placeholder="Например: Средний или 45 см" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Когда получили</label>
        <input id="em-gift-when" type="text" value="${esc(p.gift_when||'')}" placeholder="Например: Вчера" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Цена в магазинах (TJS)</label>
        <input id="em-market-price" type="number" value="${p.market_price||''}" placeholder="Необязательно" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Продавец: имя</label>
        <input id="em-seller-name" type="text" value="${esc(p.seller_name||'')}" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">Продавец: телефон</label>
        <input id="em-seller-phone" type="text" value="${esc(p.seller_phone||'')}" style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:5px;color:var(--gray)">
          💰 Итоговая цена (от администратора)
        </label>
        <input id="em-admin-price" type="number" value="${p.is_admin_price ? p.price : ''}"
          placeholder="Оставьте пустым — цена будет с комиссией"
          style="width:100%;padding:10px 12px;border:1.5px solid #e8d8d0;border-radius:9px;font-size:.95rem;box-sizing:border-box">
        <div style="font-size:.75rem;color:var(--gray);margin-top:4px">
          Если заполнено — показывается как есть, без комиссии. Если пусто — к цене продавца добавится комиссия автоматически.
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-top:20px">
        <button onclick="saveEdit(false)" style="flex:1;padding:12px;background:#f0f0f0;border:none;border-radius:10px;font-size:.95rem;cursor:pointer;font-weight:600">
          💾 Сохранить
        </button>
        ${p.status==='pending' ? `
        <button onclick="saveEdit(true)" style="flex:1;padding:12px;background:var(--rose);color:#fff;border:none;border-radius:10px;font-size:.95rem;cursor:pointer;font-weight:600">
          ✅ Сохранить и одобрить
        </button>` : ''}
      </div>
    </div>`;
};

window.saveEdit = async (andApprove = false) => {
  const id          = document.getElementById('em-id').value;
  const title       = document.getElementById('em-title').value.trim();
  const description = document.getElementById('em-description').value.trim();
  const category    = document.getElementById('em-category').value;
  const price       = document.getElementById('em-price').value;
  const city        = document.getElementById('em-city').value;
  const adminPrice  = document.getElementById('em-admin-price')?.value.trim();

  if (!title || !price) { toast('Заполните название и цену','err'); return; }

  const fd          = new FormData();
  const address     = document.getElementById('em-address')?.value.trim()     || '';
  const pickup_time = document.getElementById('em-pickup_time')?.value.trim() || '';
  const size        = document.getElementById('em-size')?.value.trim()        || '';
  const gift_when   = document.getElementById('em-gift-when')?.value.trim()   || '';
  const market_price= document.getElementById('em-market-price')?.value       || '';
  const seller_name = document.getElementById('em-seller-name')?.value.trim() || '';
  const seller_phone= document.getElementById('em-seller-phone')?.value.trim()|| '';

  fd.append('title',        title);
  fd.append('description',  description);
  fd.append('category',     category);
  fd.append('city',         city);
  fd.append('address',      address);
  fd.append('pickup_time',  pickup_time);
  fd.append('size',         size);
  fd.append('gift_when',    gift_when);
  if (market_price) fd.append('market_price', market_price);
  if (seller_name)  fd.append('seller_name',  seller_name);
  if (seller_phone) fd.append('seller_phone', seller_phone);
  if (andApprove)   fd.append('status', 'active');

  // Если админ заполнил итоговую цену — используем её и ставим флаг
  if (adminPrice && Number(adminPrice) > 0) {
    fd.append('price', adminPrice);
    fd.append('is_admin_price', 'true');
  } else {
    fd.append('price', price);
    fd.append('is_admin_price', 'false');
  }

  try {
    await api.updateProduct(id, fd);
    document.getElementById('edit-modal').remove();
    toast(andApprove ? '✅ Сохранено и одобрено!' : '💾 Сохранено', 'ok');
    renderProducts();
    loadDashStats();
  } catch(e) { toast(e.message, 'err'); }
};

// ── Заявки ────────────────────────────────────────────────

let iFilter = '';
window.setIFilter = (s,el) => {
  iFilter = s;
  document.querySelectorAll('#i-filter-chips .chip').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  renderInquiries();
};

async function renderInquiries() {
  const el = document.getElementById('tab-inquiries');
  el.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px" id="i-filter-chips">
      ${[['','Все'],['new','🆕 Новые'],['done','✅ Обработанные']]
        .map(([v,l])=>`<button class="chip${iFilter===v?' active':''}" onclick="setIFilter('${v}',this)">${l}</button>`).join('')}
    </div>
    <div id="i-list"><div class="loader">Загружаем…</div></div>`;

  try {
    const r = await api.inquiries({ status:iFilter, limit:100 });
    const l = document.getElementById('i-list');
    if (!r.data?.length) { l.innerHTML='<div class="empty"><span>📭</span><h3>Нет заявок</span></div>'; return; }

    l.innerHTML = r.data.map(inq => {
      const prod = inq.products;
      return `<div class="inq-card">
        <div class="inq-hd">
          <div><b>Заявка #${esc(inq.id.substring(0,8))}</b> <small style="color:var(--gray)">${fmtD(inq.created_at)}</small></div>
          ${inq.status==='new'?`<span class="bd-y">🆕 Новая</span>`:`<span class="bd-g">✅ Готово</span>`}
        </div>
        <div class="inq-body">
          <div>
            <div>👤 <b>${esc(inq.customer_name||'—')}</b></div>
            <div>📞 <a href="tel:${esc(inq.customer_phone)}" style="color:var(--rose-d);font-weight:700">${esc(inq.customer_phone)}</a></div>
            ${inq.customer_telegram?`<div>✈️ <a href="https://t.me/${esc(inq.customer_telegram.replace('@',''))}" target="_blank">${esc(inq.customer_telegram)}</a></div>`:''}
            ${inq.note?`<div>📝 ${esc(inq.note)}</div>`:''}
          </div>
          <div>
            ${prod?`<div>📦 <b>${esc(prod.title)}</b></div><div>💰 ${fmt(prod.price)}</div>`:'<div>Без привязки к товару</div>'}
          </div>
        </div>
        ${inq.status==='new'?`<div style="display:flex;gap:7px;padding-top:10px;border-top:1px solid #f0f0f0">
          <button class="abtn g" onclick="iDone('${inq.id}')">✅ Обработано</button>
        </div>`:''}
      </div>`;
    }).join('');
  } catch(e) { document.getElementById('i-list').innerHTML=`<div class="empty"><h3>${e.message}</h3></div>`; }
}

window.iDone = async id => {
  try { await api.updInquiry(id,'done'); toast('Готово','ok'); renderInquiries(); loadDashStats(); }
  catch(e) { toast(e.message,'err'); }
};

window.saveCounter = async (channel) => {
  const val = Number(document.getElementById('counter-' + channel).value);
  if (!val || val < 0) { toast('Введите корректное значение', 'err'); return; }
  try {
    await api.setCounter(channel, val);
    document.getElementById('counter-msg').textContent = '✅ Счётчик ' + channel + ' обновлён до ' + val;
    toast('Счётчик обновлён', 'ok');
  } catch(e) { toast(e.message, 'err'); }
};

async function renderStats() {
  const el = document.getElementById('tab-stats');
  el.innerHTML = '<div class="loader">Загружаем…</div>';
  try {
    const d = await api.stats();
    const p = d.products||{}, i = d.inquiries||{};
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px">
        <div class="stat-box"><h4>📦 Товары</h4>
          ${[['Всего',p.total],['Активных',p.active],['На проверке',p.pending],['💐 Букеты',p.bouquets],['🧺 Корзины',p.baskets],['🧸 Мишки',p.bears],['🍰 Сладости',p.sweets]]
            .map(([l,v])=>`<div class="srow"><span>${l}</span><b>${v||0}</b></div>`).join('')}
        </div>
        <div class="stat-box"><h4>🛒 Заявки</h4>
          ${[['Всего',i.total],['Новых',i.new_inq],['Обработано',(i.total||0)-(i.new_inq||0)]]
            .map(([l,v])=>`<div class="srow"><span>${l}</span><b>${v||0}</b></div>`).join('')}
        </div>
      </div>
      <div class="stat-box" style="margin-bottom:18px"><h4>🔢 Счётчики ID публикаций</h4>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="min-width:120px;color:var(--gray)">Душанбе (AB-xxxx):</span>
            <input type="number" id="counter-dushanbe" placeholder="текущее значение" style="width:120px;padding:6px 10px;border:1.5px solid #e8d8d0;border-radius:8px;font-size:.9rem">
            <button onclick="saveCounter('dushanbe')" style="padding:7px 14px;background:var(--rose);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Сохранить</button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="min-width:120px;color:var(--gray)">Худжанд (AK-xxxx):</span>
            <input type="number" id="counter-khujand" placeholder="текущее значение" style="width:120px;padding:6px 10px;border:1.5px solid #e8d8d0;border-radius:8px;font-size:.9rem">
            <button onclick="saveCounter('khujand')" style="padding:7px 14px;background:var(--rose);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Сохранить</button>
          </div>
        </div>
        <div id="counter-msg" style="margin-top:8px;font-size:.82rem;color:var(--gray)"></div>
      </div>
      <div class="stat-box"><h4>📅 Заявки за 30 дней</h4>
        ${d.by_day?.length
          ? `<table style="width:100%;border-collapse:collapse">
              <thead><tr>${['Дата','Заявок'].map(h=>`<th style="text-align:left;padding:7px;color:var(--gray);font-size:.75rem;border-bottom:2px solid #eee">${h}</th>`).join('')}</tr></thead>
              <tbody>${d.by_day.map(r=>`<tr><td style="padding:7px">${r.date}</td><td style="padding:7px;font-weight:700">${r.count}</td></tr>`).join('')}</tbody>
            </table>`
          : '<p style="color:var(--gray);padding:10px 0">Нет данных</p>'}
      </div>`;
  } catch(e) { el.innerHTML=`<div class="empty"><h3>${e.message}</h3></div>`; }
}

async function renderOrders() {
  const el = document.getElementById('tab-orders');
  el.innerHTML = `<div id="o-table"><div class="loader">Загружаем…</div></div>`;
  try {
    const r = await fetch('/api/admin/orders', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') }
    }).then(res => res.json());
    const t = document.getElementById('o-table');
    if (!r.data || !r.data.length) { t.innerHTML='<div class="empty"><span>📭</span><h3>Нет заказов</h3></div>'; return; }
    
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
          <button class="btn btn-primary" style="flex:1;padding:8px;font-size:.8rem" onclick="confirmOrder('${o.id}')">✅ Подтвердить</button>
          <button class="btn btn-outline" style="flex:1;padding:8px;font-size:.8rem" onclick="rejectOrder('${o.id}')">❌ Отклонить</button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch(e) { console.error(e); t.innerHTML='<div class="empty"><span>❌</span><h3>Ошибка загрузки</h3></div>'; }
}

window.confirmOrder = async (id) => {
  try {
    const res = await fetch(`/api/admin/orders/${id}/status`, {
      method: 'PATCH',
      headers: { 
        'Authorization': 'Bearer ' + localStorage.getItem('admin_token'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'confirmed' })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    toast('✅ Заказ подтвержден', 'success');
    renderOrders();
  } catch(e) { toast('Ошибка: ' + e.message, 'err'); }
};

window.rejectOrder = async (id) => {
  try {
    const res = await fetch(`/api/admin/orders/${id}/status`, {
      method: 'PATCH',
      headers: { 
        'Authorization': 'Bearer ' + localStorage.getItem('admin_token'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'rejected' })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    toast('❌ Заказ отклонен', 'err');
    renderOrders();
  } catch(e) { toast('Ошибка: ' + e.message, 'err'); }
};
