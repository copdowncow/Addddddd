'use strict';

const TG = require('node-telegram-bot-api');
const { createSupabaseClient } = require('../db/supabase');

let userBot  = null;
let adminBot = null;
let shopBot  = null;
/** Исходящие сообщения Shop Bot (polling: false — не конфликтует с shopBot) */
let shopOutboundBot = null;
/** Резерв таймеров, если колонки в БД ещё не добавлены */
const shopResponseTimers = new Map();
/** Заказы, которым shop-бот уже отправил «новый заказ» */
const shopNotifiedOrders = new Set();
/** Уведомления один раз за жизнь заказа (без спама каждые 30 сек) */
const notificationOnceKeys = new Set();
const adminChatIds = new Set();
// In-memory pending-inquiry cache (referenced by inquiries.js)
const _pendingInquiries = new Map();
function savePendingInquiry(key, payload) {
  _pendingInquiries.set(key, { ...payload, _at: Date.now() });
  // GC older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of _pendingInquiries) if (v._at < cutoff) _pendingInquiries.delete(k);
}
function getPendingInquiry(key) { return _pendingInquiries.get(key) || null; }

// Заказы, ожидающие фото-отчёта от магазина перед статусом 'ready': shopChatId -> orderId
const shopPendingPhoto = new Map();
// Клиенты, вводящие причину возврата: customerChatId -> orderId
const customerPendingRefundReason = new Map();

const KHUJAND_CITIES = ['худжанд', 'бустон', 'исфара'];

// In-memory map for username -> chat_id (fallback, primary is database)
const usernameToChatId = new Map();

// Normalize username: remove @, trim, lowercase
function normalizeUsername(username) {
  if (!username) return null;
  return username.toString().replace('@', '').trim().toLowerCase();
}

// ─────────────────────────────────────────────
// 💾 Сохранение username → chat_id в БД
// ─────────────────────────────────────────────
async function saveUsernameMapping(username, chatId) {
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    const normalizedUsername = normalizeUsername(username);

    const { error } = await db
      .from('telegram_users')
      .upsert({ username: normalizedUsername, chat_id: chatId }, { onConflict: 'username' });

    if (error) {
      console.error('[saveUsernameMapping] DB error:', error.message);
      return false;
    }
    console.log('[saveUsernameMapping] Saved:', normalizedUsername, '->', chatId);
    return true;
  } catch (e) {
    console.error('[saveUsernameMapping] Exception:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// 🔍 Получить chat_id по username из БД
// ─────────────────────────────────────────────
async function getChatIdByUsername(username) {
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    const normalizedUsername = normalizeUsername(username);

    const { data, error } = await db
      .from('telegram_users')
      .select('chat_id')
      .eq('username', normalizedUsername)
      .single();

    if (error || !data) {
      console.log('[getChatIdByUsername] Not found:', normalizedUsername);
      return null;
    }
    console.log('[getChatIdByUsername] Found:', normalizedUsername, '->', data.chat_id);
    return data.chat_id;
  } catch (e) {
    console.error('[getChatIdByUsername] Exception:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 🔑 ГЛАВНАЯ ФУНКЦИЯ: Получить chat_id по телефону или username
// Используется при создании/подтверждении заказа
// ─────────────────────────────────────────────
async function resolveChatId({ phone, username, chatId }) {
  // 1. Прямой chat_id
  if (chatId) return chatId;

  const { createSupabaseClient } = require('../db/supabase');
  const db = createSupabaseClient();

  // 2. По username — из таблицы telegram_users
  if (username) {
    const normalized = normalizeUsername(username);
    const fromDb = await getChatIdByUsername(normalized);
    if (fromDb) return fromDb;
    const fromMap = usernameToChatId.get(normalized);
    if (fromMap) return fromMap;
  }

  // 3. По телефону — из таблицы telegram_users
  if (phone) {
    const variants = phoneVariants(phone);
    const { data } = await db
      .from('telegram_users')
      .select('chat_id, phone')
      .in('phone', variants)
      .limit(1)
      .maybeSingle();
    if (data?.chat_id) return data.chat_id;

    const targetDigits = phoneDigits(phone);
    if (targetDigits) {
      const { data: allUsers } = await db
        .from('telegram_users')
        .select('chat_id, phone')
        .not('chat_id', 'is', null)
        .not('phone', 'is', null)
        .limit(500);
      const hit = (allUsers || []).find(u => phoneDigits(u.phone) === targetDigits);
      if (hit?.chat_id) return hit.chat_id;
    }

    // 4. По телефону — из прошлых заказов с тем же номером
    const { data: prevOrder } = await db
      .from('orders')
      .select('customer_chat_id')
      .in('customer_phone', variants)
      .not('customer_chat_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevOrder?.customer_chat_id) return prevOrder.customer_chat_id;

    // 5. По телефону — из shops (если клиент сам магазин)
    const { data: shopData } = await db
      .from('shops')
      .select('telegram_chat_id')
      .in('phone', variants)
      .maybeSingle();
    if (shopData?.telegram_chat_id) return shopData.telegram_chat_id;
  }

  return null;
}

// ─────────────────────────────────────────────
// 📝 Сохранить phone → chat_id в таблице telegram_users
// Вызывается когда пользователь делится номером через бот
// ─────────────────────────────────────────────
async function savePhoneMapping(phone, chatId, username) {
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    const normalizedPhone = phone.replace(/[^\d+]/g, '');
    const normalizedUsername = username ? normalizeUsername(username) : null;

    // Save with + prefix for consistency
    const phoneWithPlus = normalizedPhone.startsWith('+') ? normalizedPhone : '+' + normalizedPhone;

    const { error } = await db
      .from('telegram_users')
      .upsert(
        { phone: phoneWithPlus, chat_id: chatId, username: normalizedUsername },
        { onConflict: 'phone' }
      );

    if (error) console.error('[savePhoneMapping] DB error:', error.message);
    else console.log('[savePhoneMapping] Saved:', phoneWithPlus, '->', chatId);
  } catch (e) {
    console.error('[savePhoneMapping] Exception:', e.message);
  }
}

// ─────────────────────────────────────────────
// 🔗 Привязать chat_id к существующему заказу (если ещё не привязан)
// ─────────────────────────────────────────────
async function patchOrderChatId(orderId, chatId, { force = false } = {}) {
  if (!orderId || !chatId) return;
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    const cid = Number(chatId);
    let q = db.from('orders').update({ customer_chat_id: cid }).eq('id', orderId);
    if (!force) q = q.is('customer_chat_id', null);
    await q;
    console.log('[patchOrderChatId] Patched order', orderId, '->', cid, force ? '(force)' : '');
  } catch (e) {
    console.error('[patchOrderChatId] Error:', e.message);
  }
}

function customerChatKey(chatId) {
  return String(chatId);
}

// Надёжное обновление заказа: повтор без опциональных колонок при ошибках схемы
async function patchOrder(db, orderId, fields) {
  const payload = { ...fields };
  const dropOrder = ['confirmed_at', 'refund_reason', 'delivered_at', 'notes'];

  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db
      .from('orders')
      .update(payload)
      .eq('id', orderId)
      .select('*')
      .maybeSingle();

    if (!error && data) return { ok: true, order: data };

    const msg = (error?.message || '').toLowerCase();
    const details = (error?.details || '').toLowerCase();
    console.error('[patchOrder]', orderId, 'attempt', attempt, error?.message, error?.details, error?.hint);

    if (msg.includes('check constraint') && payload.status) {
      return { ok: false, error, constraint: true };
    }

    const missingCol = msg.match(/could not find the ['"]?(\w+)['"]? column/i)
      || details.match(/column ['"]?(\w+)['"]?/i);
    if (missingCol && payload[missingCol[1]] !== undefined) {
      delete payload[missingCol[1]];
      continue;
    }

    if (/confirmed_at|refund_reason|notes|delivered_at/.test(msg + details)) {
      let stripped = false;
      for (const col of dropOrder) {
        if (payload[col] !== undefined) { delete payload[col]; stripped = true; }
      }
      if (stripped) continue;
    }

    if (!error && !data) {
      const { data: row } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
      if (row) return { ok: true, order: row };
    }

    return { ok: false, error };
  }
  return { ok: false, error: new Error('patchOrder max attempts') };
}

async function confirmOrderReceived(db, orderId) {
  const attempts = [
    { status: 'confirmed_received', confirmed_at: new Date().toISOString() },
    { status: 'confirmed_received' },
    { status: 'confirmed' },
  ];
  for (const fields of attempts) {
    const r = await patchOrder(db, orderId, fields);
    if (r.ok) return r;
    if (r.constraint) break;
  }
  return { ok: false };
}

async function submitRefundRequest(db, orderId, reason) {
  const attempts = [
    { status: 'refund_requested', refund_reason: reason },
    { status: 'refund_requested' },
    { status: 'cancelled', notes: `⚠️ ЗАПРОС ВОЗВРАТА: ${reason}` },
  ];
  for (const fields of attempts) {
    const r = await patchOrder(db, orderId, fields);
    if (r.ok) return { ...r, usedStatus: fields.status };
    if (r.constraint) continue;
  }
  return { ok: false };
}

function getMiniAppUrl() {
  const url = (process.env.MINI_APP_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  if (!url) return 'https://addddddd-production.up.railway.app';
  return url;
}

function getBotUsername() {
  return (process.env.BOT_USERNAME || 'ReBuketTj_Bot').replace(/^@/, '').trim();
}

function formatTelegramHandle(username) {
  if (!username) return null;
  const u = username.toString().trim();
  if (!u) return null;
  return u.startsWith('@') ? u : '@' + u;
}

// Сохранить chat_id клиента (Mini App /start / контакт) и привязать к заказу
async function registerCustomerFromTelegram({ chatId, username, phone, orderId }) {
  if (!chatId) return null;
  const cid = Number(chatId);
  const normUser = username ? normalizeUsername(username) : null;
  if (normUser) {
    usernameToChatId.set(normUser, cid);
    await saveUsernameMapping(normUser, cid);
  }
  if (phone) await savePhoneMapping(phone, cid, normUser);
  if (orderId) await patchOrderChatId(orderId, cid, { force: true });
  return cid;
}

async function trySendToCustomer(chatId, text, options = {}) {
  if (!chatId) return { ok: false, reason: 'no_chat_id' };
  if (!userBot && !ensureUserBot() && !getUserBotToken()) {
    return { ok: false, reason: 'no_bot', error: 'userBot unavailable' };
  }
  const cid = Number(chatId);
  try {
    await telegramSendMessageHttp(cid, text, { parse_mode: 'HTML', ...options });
    return { ok: true, chatId: cid };
  } catch (httpErr) {
    if (!userBot) {
      const err = httpErr.message || String(httpErr);
      const needsStart = httpErr.code === 403 || /403|blocked|initiate|chat not found|deactivated|PEER_ID_INVALID/i.test(err);
      console.error('[trySendToCustomer] HTTP failed:', chatId, err);
      return { ok: false, reason: needsStart ? 'needs_start' : 'send_failed', error: err, needsStart };
    }
    try {
      await userBot.sendMessage(cid, text, { parse_mode: 'HTML', ...options });
      return { ok: true, chatId: cid };
    } catch (e) {
      const err = e.message || String(e);
      const needsStart = /403|blocked|initiate|chat not found|user is deactivated|PEER_ID_INVALID/i.test(err);
      console.error('[trySendToCustomer] Failed:', chatId, err);
      return { ok: false, reason: needsStart ? 'needs_start' : 'send_failed', error: err, needsStart };
    }
  }
}

function downloadUrlBuffer(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const lib = (url || '').startsWith('https') ? https : http;
    lib.get(url, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return downloadUrlBuffer(resp.headers.location).then(resolve).catch(reject);
      }
      if (resp.statusCode && resp.statusCode >= 400) {
        return reject(new Error('HTTP ' + resp.statusCode));
      }
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    }).on('error', reject);
  });
}

const PHOTO_FILE_OPTS = { filename: 'bouquet.jpg', contentType: 'image/jpeg' };

function getUserBotToken() {
  return process.env.BOT_TOKEN_USER || '';
}

async function telegramUserApi(method, init) {
  const token = getUserBotToken();
  if (!token) throw new Error('BOT_TOKEN_USER not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.description || 'Telegram API error');
    err.code = json.error_code;
    throw err;
  }
  return json.result;
}

async function telegramSendPhotoHttp(chatId, buffer, options = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'bouquet.jpg');
  if (options.caption) form.append('caption', String(options.caption).slice(0, 1024));
  if (options.parse_mode) form.append('parse_mode', options.parse_mode);
  return telegramUserApi('sendPhoto', { method: 'POST', body: form });
}

async function telegramSendMessageHttp(chatId, text, options = {}) {
  return telegramUserApi('sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 4096),
      parse_mode: options.parse_mode || 'HTML',
      disable_web_page_preview: options.disable_web_page_preview !== false,
      reply_markup: options.reply_markup,
    }),
  });
}

async function downloadBotFile(bot, fileId) {
  const fileLink = await bot.getFileLink(fileId);
  return downloadUrlBuffer(fileLink);
}

async function sendPhotoToCustomer(chatId, photoSource, options = {}) {
  if (!chatId || !photoSource) return { ok: false, error: 'no_chat_or_photo' };
  if (!userBot && !ensureUserBot() && !getUserBotToken()) {
    return { ok: false, error: 'user_bot_unavailable' };
  }
  const cid = Number(chatId);

  async function sendBuffer(buf) {
    if (!buf || !buf.length) throw new Error('empty buffer');
    try {
      await telegramSendPhotoHttp(cid, buf, options);
      return;
    } catch (httpErr) {
      console.log('[sendPhotoToCustomer] HTTP sendPhoto failed:', httpErr.message);
      if (!userBot) throw httpErr;
      try {
        await userBot.sendPhoto(cid, buf, options, PHOTO_FILE_OPTS);
        return;
      } catch (e1) {
        console.log('[sendPhotoToCustomer] lib sendPhoto failed:', e1.message);
        await userBot.sendDocument(cid, buf, options, PHOTO_FILE_OPTS);
      }
    }
  }

  try {
    if (Buffer.isBuffer(photoSource)) {
      await sendBuffer(photoSource);
      return { ok: true };
    }
    const url = String(photoSource).trim();
    if (!url) return { ok: false, error: 'empty_url' };
    try {
      if (userBot) await userBot.sendPhoto(cid, url, options);
      else throw new Error('no lib bot');
      return { ok: true };
    } catch (urlErr) {
      console.log('[sendPhotoToCustomer] URL failed, download buffer:', urlErr.message);
      const buf = await downloadUrlBuffer(url);
      await sendBuffer(buf);
      return { ok: true };
    }
  } catch (e) {
    console.error('[sendPhotoToCustomer] Failed:', cid, e.message);
    return { ok: false, error: e.message, code: e.code };
  }
}

async function ensureCustomerOwnsOrder(db, orderId, chatId) {
  const { data: order, error } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (error || !order) return null;
  const cid = Number(chatId);
  const stored = order.customer_chat_id != null && order.customer_chat_id !== ''
    ? Number(order.customer_chat_id)
    : null;
  if (stored == null || Number.isNaN(stored) || stored !== cid) {
    await db.from('orders').update({ customer_chat_id: cid }).eq('id', orderId);
    order.customer_chat_id = cid;
  }
  return order;
}

function buildAdminUnreachableWarning(order, result) {
  const botUser = getBotUsername();
  const tg = formatTelegramHandle(order.customer_telegram) || 'не указан';
  const deepLink = `https://t.me/${botUser}?start=order_${order.id}`;
  let why = 'Клиент не привязан к боту.';
  if (result?.reason === 'needs_start') {
    why = 'У клиента есть chat_id, но он не нажал «Start» в боте — Telegram не даёт писать первым.';
  } else if (result?.reason === 'no_chat_id') {
    why = 'Клиент не открыл заказ через Telegram Mini App и не писал /start боту.';
  } else if (result?.error) {
    why = `Ошибка отправки: ${result.error}`;
  }

  return (
    `⚠️ <b>КЛИЕНТ НЕ ПОЛУЧИТ УВЕДОМЛЕНИЕ</b>\n\n` +
    `📦 Заказ #${order.id}\n` +
    `📞 Телефон: ${escHtml(phoneDisplay(order.customer_phone))}\n\n` +
    `📱 Telegram: ${escHtml(tg)}\n` +
    `💰 Сумма: ${(Number(order.total) || 0).toLocaleString('ru')} сом\n\n` +
    `❌ <b>Проблема:</b> ${escHtml(why)}\n\n` +
    `📋 <b>Что делать:</b>\n` +
    `1. Позвоните клиенту: ${escHtml(phoneDisplay(order.customer_phone))}\n` +
    `2. Отправьте ссылку (клиент должен нажать Start):\n` +
    `<a href="${deepLink}">${deepLink}</a>\n` +
    `3. Сообщите: «Оплата подтверждена, магазин начинает сборку»\n\n` +
    `💡 Заказы оформляйте через Mini App бота @${botUser} — тогда уведомления приходят автоматически.`
  );
}

async function notifyAdminCustomerUnreachable(order, result) {
  if (!adminBot || !adminChatIds.size) return;
  if (!shouldSendNotification(order.id, 'admin_customer_unreachable')) return;
  const text = buildAdminUnreachableWarning(order, result);
  for (const chatId of adminChatIds) {
    try {
      await adminBot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      console.error('[notifyAdminCustomerUnreachable]', chatId, e.message);
    }
  }
}

async function sendCustomerPaymentNotification(order) {
  if (!order?.id) return { ok: false, reason: 'no_order' };
  if (!canSendNotification(order.id, 'customer_payment_confirmed')) {
    return { ok: true, skipped: true };
  }

  const chatId = await resolveCustomerChatId(order);
  if (!chatId) return { ok: false, reason: 'no_chat_id' };

  const text =
    `✅ <b>Чек подтверждён!</b>\n\n` +
    `Ваш заказ <b>#${order.id}</b> принят администратором.\n` +
    `Магазин получил уведомление и начинает сборку.\n\n` +
    `💰 Сумма: ${(Number(order.total) || 0).toLocaleString('ru')} сом\n\n` +
    `<i>Мы сообщим о каждом изменении статуса заказа в Telegram.</i>`;

  const result = await trySendToCustomer(chatId, text);
  if (result.ok) {
    markNotificationSent(order.id, 'customer_payment_confirmed');
    console.log('[sendCustomerPaymentNotification] Sent to:', chatId);
  }
  return result;
}

// Уведомление клиента после подтверждения оплаты (без чата с магазином)
async function notifyCustomerOnPaymentConfirmed(order) {
  const notifyResult = await sendCustomerPaymentNotification(order);
  if (!notifyResult.ok && !notifyResult.skipped) {
    await notifyAdminCustomerUnreachable(order, notifyResult);
  }
  return notifyResult;
}

// Lazily start full user bot (polling + handlers), not a send-only stub
function ensureUserBot() {
  if (userBot) return true;
  initUserBot();
  return !!userBot;
}

function ensureShopBot() {
  if (shopBot) return true;
  initShopBot();
  return !!shopBot;
}

function getShopBotToken() {
  return (process.env.BOT_TOKEN_SHOP || process.env.SHOP_BOT_TOKEN || '').trim();
}

/** Только отправка — всегда отдельный инстанс, не shopBot с polling */
function ensureShopOutboundBot() {
  const token = getShopBotToken();
  if (!token) return null;
  if (!shopOutboundBot) {
    try {
      shopOutboundBot = new TG(token, { polling: false });
      console.log('[shop] outbound bot ready (send-only)');
    } catch (e) {
      console.error('[ensureShopOutboundBot]', e.message);
      return null;
    }
  }
  return shopOutboundBot;
}

async function getShopByTelegramChat(chatId) {
  const cid = shopChatId(chatId);
  const db = createSupabaseClient();
  for (const val of [cid, String(cid)]) {
    const { data, error } = await db
      .from('shops')
      .select('id, phone, shop_name, telegram_chat_id, status')
      .eq('telegram_chat_id', val)
      .maybeSingle();
    if (!error && data) return data;
  }
  return null;
}

function shopChatId(chatId) {
  const n = Number(chatId);
  return Number.isFinite(n) && n > 0 ? n : chatId;
}

function parseOrderItems(order) {
  if (!order) return [];
  if (Array.isArray(order.items)) return order.items;
  if (typeof order.items === 'string' && order.items.trim()) {
    try { return JSON.parse(order.items); } catch (_) { return []; }
  }
  return [];
}

async function loadActiveShops() {
  const db = createSupabaseClient();
  const res = await db
    .from('shops')
    .select('id, phone, shop_name, telegram_chat_id, status')
    .eq('status', 'active');

  if (!res.error) return res.data || [];

  if (/telegram_chat_id|column/i.test(res.error.message || '')) {
    console.error('[loadActiveShops] Нет колонки shops.telegram_chat_id — выполните SQL из migrations/011_shops_telegram_chat_id.sql');
    const slim = await db.from('shops').select('id, phone, shop_name, status').eq('status', 'active');
    return (slim.data || []).map(s => ({ ...s, telegram_chat_id: null }));
  }

  console.error('[loadActiveShops]', res.error.message);
  return [];
}

function collectSellerPhoneKeys(items, extraPhones = []) {
  const wanted = new Set();
  const sellerPhones = [];
  const add = (raw) => {
    const p = (raw || '').toString().trim();
    if (!p) return;
    sellerPhones.push(p);
    const d = phoneDigits(p);
    if (d) wanted.add(d);
    for (const v of phoneVariants(p)) {
      const dv = phoneDigits(v);
      if (dv) wanted.add(dv);
    }
  };
  for (const it of items) add(it.seller_phone);
  for (const p of extraPhones) add(p);
  return { wanted, sellerPhones: [...new Set(sellerPhones)] };
}

function shopMatchesOrderPhones(shop, wanted) {
  if (!shop || !wanted.size) return false;
  const d = phoneDigits(shop.phone);
  if (d && wanted.has(d)) return true;
  for (const v of phoneVariants(shop.phone)) {
    const dv = phoneDigits(v);
    if (dv && wanted.has(dv)) return true;
  }
  return false;
}

async function resolveShopsForOrder(order) {
  const items = parseOrderItems(order);
  let { wanted, sellerPhones } = collectSellerPhoneKeys(items);

  if (!wanted.size) {
    const db = createSupabaseClient();
    const ids = items.map(it => it.id || it.pub_id).filter(Boolean);
    if (ids.length) {
      const { data: prods } = await db.from('products').select('seller_phone').in('id', ids);
      const extra = (prods || []).map(p => p.seller_phone);
      ({ wanted, sellerPhones } = collectSellerPhoneKeys(items, extra));
    }
  }

  const active = await loadActiveShops();
  const matched = active.filter(s => shopMatchesOrderPhones(s, wanted));

  const linked = matched.filter(s => {
    const cid = s.telegram_chat_id;
    return cid != null && String(cid).trim() !== '' && String(cid) !== '0';
  });
  const unlinked = matched.filter(s => !linked.includes(s));

  if (sellerPhones.length && !matched.length) {
    console.log('[resolveShopsForOrder] no shop match. wanted:', [...wanted].join(','),
      'shops:', active.map(s => phoneDigits(s.phone)).join(','));
  }

  return { items, sellerPhones, wanted, matched, linked, unlinked };
}

function shopOrderKeyboard(orderId) {
  const id = String(orderId);
  return {
    inline_keyboard: [[
      { text: '✅ Принять заказ', callback_data: `shop_accept:${id}` },
      { text: '❌ Отклонить', callback_data: `shop_reject:${id}` },
    ]],
  };
}

function markShopOrderNotified(orderId) {
  shopNotifiedOrders.add(String(orderId));
}

function wasShopOrderNotified(orderOrId) {
  const order = orderOrId && typeof orderOrId === 'object' ? orderOrId : null;
  const id = order ? order.id : orderOrId;
  const sid = String(id);
  if (shopNotifiedOrders.has(sid)) return true;
  if (order?.shop_notify_at) return true;
  return false;
}

/** Таймер/напоминания/автоотклонение — только заказы с реальной отправкой в Shop Bot */
function isShopTimerEligible(order) {
  return !!(order && order.shop_notify_at);
}

function canSendOnce(orderId, type) {
  const key = `${orderId}:${type}`;
  if (notificationOnceKeys.has(key)) return false;
  return true;
}

function markSentOnce(orderId, type) {
  notificationOnceKeys.add(`${orderId}:${type}`);
}

async function sendToShopChat(chatId, text, opts = {}) {
  const bot = ensureShopOutboundBot();
  if (!bot) throw new Error('BOT_TOKEN_SHOP не задан на сервере (Railway)');

  const cid = shopChatId(chatId);
  const sendOpts = { disable_web_page_preview: true, ...opts };
  const plain = String(text).replace(/<[^>]+>/g, '');

  const attempts = [
    () => bot.sendMessage(cid, text, sendOpts),
    () => bot.sendMessage(cid, plain, { ...sendOpts, parse_mode: undefined }),
  ];
  if (sendOpts.reply_markup) {
    attempts.push(() => bot.sendMessage(cid, plain, {
      disable_web_page_preview: true,
      reply_markup: sendOpts.reply_markup,
    }));
  }

  let lastErr;
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log('[sendToShopChat]', cid, e.message);
    }
  }
  throw lastErr || new Error('sendToShopChat failed');
}

/** Телефон для показа в сообщениях (без «+» в начале) */
function phoneDisplay(phone) {
  const s = String(phone || '').trim();
  if (!s) return '—';
  return s.replace(/^\+/, '');
}

function phoneDigits(phone) {
  let d = (phone || '').toString().replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  // Сравниваем по последним 9 цифрам (TJ +992 / KG +996 — один локальный номер)
  if (d.length > 9) d = d.slice(-9);
  return d;
}

function phoneVariants(phone) {
  const raw = (phone || '').toString().trim();
  const d = (phone || '').toString().replace(/\D/g, '');
  const set = new Set([raw, d, phoneDigits(phone)].filter(Boolean));
  if (d) {
    set.add('+' + d);
    const local9 = d.length > 9 ? d.slice(-9) : d;
    set.add('+992' + local9);
    set.add('992' + local9);
    set.add('+996' + local9);
    set.add('996' + local9);
  }
  return [...set];
}

function getShopBotUsername() {
  return (process.env.SHOP_BOT_USERNAME || process.env.BOT_USERNAME_SHOP || 'ReBuket_Shop_bot').replace(/^@/, '').trim();
}

const SHOP_REMINDER_MS =
  (Number(process.env.SHOP_ORDER_REMINDER_MINUTES) || 5) * 60 * 1000;
const SHOP_REJECT_MS =
  (Number(process.env.SHOP_ORDER_TIMEOUT_MINUTES) || 10) * 60 * 1000;
const SHOP_RESPONSE_TIMEOUT_MS = SHOP_REJECT_MS;
const SHOP_TIMEOUT_POLL_MS = 30 * 1000;
const SHOP_TIMEOUT_WAIT_STATUSES = ['payment_confirmed', 'confirmed'];

function shopWaitStartedAt(order) {
  if (!isShopTimerEligible(order)) return 0;
  if (order.shop_response_deadline_at) {
    const end = new Date(order.shop_response_deadline_at).getTime();
    if (Number.isFinite(end)) return end - SHOP_REJECT_MS;
  }
  const t = order.shop_notify_at || order.payment_confirmed_at;
  const ms = t ? new Date(t).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function orderRejectDeadlineMs(order) {
  if (!isShopTimerEligible(order)) return null;
  const cached = shopResponseTimers.get(String(order.id));
  if (cached?.deadlineMs) return cached.deadlineMs;
  if (order.shop_response_deadline_at) {
    const ms = new Date(order.shop_response_deadline_at).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const start = shopWaitStartedAt(order);
  return start ? start + SHOP_REJECT_MS : null;
}

function orderReminderAlreadySent(orderId) {
  const c = shopResponseTimers.get(String(orderId));
  return c?.reminderSent === true;
}

function markOrderReminderSent(orderId) {
  const c = shopResponseTimers.get(String(orderId));
  if (c) c.reminderSent = true;
  else shopResponseTimers.set(String(orderId), { startMs: Date.now(), deadlineMs: Date.now() + SHOP_REJECT_MS, reminderSent: true });
}

function cacheShopTimer(orderId, startMs, deadlineMs) {
  shopResponseTimers.set(String(orderId), {
    startMs,
    deadlineMs,
    reminderSent: false,
  });
}

function clearShopTimer(orderId) {
  shopResponseTimers.delete(String(orderId));
}

/** Старт таймера ответа магазина (5 мин напоминание, 10 мин автоотклонение) */
async function setShopResponseTimer(orderId, existingStartIso) {
  const db = createSupabaseClient();
  const startMs = existingStartIso ? Date.parse(existingStartIso) : Date.now();
  const start = new Date(startMs).toISOString();
  const deadlineMs = startMs + SHOP_REJECT_MS;
  const deadline = new Date(deadlineMs).toISOString();
  cacheShopTimer(orderId, startMs, deadlineMs);

  const payloads = [
    { shop_notify_at: start, payment_confirmed_at: start, shop_response_deadline_at: deadline },
    { shop_notify_at: start, shop_response_deadline_at: deadline },
    { payment_confirmed_at: start, shop_response_deadline_at: deadline },
    { payment_confirmed_at: start },
  ];
  for (const payload of payloads) {
    const { error } = await db.from('orders').update(payload).eq('id', orderId);
    if (!error) {
      console.log('[setShopResponseTimer] order', orderId, 'deadline', deadline, 'shop_notify_at', start);
      return { start, deadline, deadlineMs };
    }
    if (!/column/i.test(error.message || '')) {
      console.log('[setShopResponseTimer]', orderId, error.message);
      break;
    }
  }
  console.log('[setShopResponseTimer] order', orderId, 'memory-only deadline', deadline);
  return { start, deadline, deadlineMs };
}

async function findShopsBySellerPhones(sellerPhones) {
  const wanted = new Set();
  for (const p of sellerPhones || []) {
    const d = phoneDigits(p);
    if (d) wanted.add(d);
  }
  if (!wanted.size) return [];
  const active = await loadActiveShops();
  const matched = active.filter(s => {
    const d = phoneDigits(s.phone);
    return d && wanted.has(d);
  });
  if (!matched.length) {
    console.log('[findShopsBySellerPhones] no match:', sellerPhones.join(', '),
      'active:', active.map(s => phoneDigits(s.phone)).join(', '));
  }
  return matched;
}

async function notifyAdminShopsNotLinked(order, { noBot = [], noChatId = [] }) {
  if (!adminBot || !adminChatIds.size) return;
  if (!noBot.length && !noChatId.length) return;
  if (!shouldSendNotification(order.id, 'admin_shops_not_linked')) return;

  const shopBotUser = getShopBotUsername();
  let text =
    `⚠️ <b>МАГАЗИН(Ы) НЕ ПОЛУЧИЛИ ЗАКАЗ В SHOP BOT</b>\n\n` +
    `📦 Заказ #${order.id}\n` +
    `💰 ${(Number(order.total) || 0).toLocaleString('ru')} сом\n\n`;

  if (noBot.length) {
    text += `<b>Shop Bot не запущен</b> — проверьте BOT_TOKEN_SHOP на сервере.\n\n`;
  }
  if (noChatId.length) {
    text += `<b>Не подключены к боту</b> (нужен /start в @${shopBotUser}):\n`;
    for (const s of noChatId) {
      text += `• ${escHtml(s.shop_name || phoneDisplay(s.phone))} — 📞 ${escHtml(phoneDisplay(s.phone))}\n`;
    }
    text += `\n👉 Магазин: открыть @${shopBotUser} → /start → телефон → пароль\n`;
  }

  for (const chatId of adminChatIds) {
    try {
      await adminBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[notifyAdminShopsNotLinked]', chatId, e.message);
    }
  }
}

// ─────────────────────────────────────────────
// 📢 Уведомление администраторам о новом заказе
// ─────────────────────────────────────────────
async function notifyAdminAboutOrder(order) {
  console.log('[notifyAdminAboutOrder] order:', order.id, 'receipt_url:', order.receipt_url);

  if (!adminBot) { console.error('[notifyAdminAboutOrder] adminBot not initialized'); return; }
  if (adminChatIds.size === 0) { console.error('[notifyAdminAboutOrder] No admin chat IDs'); return; }

  if (!canSendNotification(order.id, 'admin_new_order')) return;

  let items = [];
  if (Array.isArray(order.items)) items = order.items;
  else if (typeof order.items === 'string' && order.items.trim()) {
    try { items = JSON.parse(order.items); } catch (e) { items = []; }
  }
  const lineAmount = (i) => {
    const q = Math.max(1, Number(i.qty) || 1);
    const lt = Number(i.line_total);
    if (lt > 0) return lt;
    return (Number(i.price) || 0) * q;
  };
  const itemsList = (items || [])
    .map(i => {
      const q = Math.max(1, Number(i.qty) || 1);
      return `• ${i.title || i.name || 'Товар'} ×${q} — ${lineAmount(i).toLocaleString('ru')} сом.`;
    })
    .join('\n');
  const deliveryLabel = order.delivery_type === 'pickup' ? '🏪 Самовывоз' : '🚕 Такси';
  const payerNote = order.delivery_payer === 'fixed'
    ? ' (включена в сумму)'
    : order.delivery_payer === 'buyer'
      ? ' (оплатит получатель)'
      : '';
  const adminUrl = `${getMiniAppUrl()}/#admin`;

  let message = `🛒 <b>НОВЫЙ ЗАКАЗ #${order.id}</b>\n\n`;
  if (order.customer_name) message += `👤 Имя: ${order.customer_name}\n`;
  message += `📞 Телефон: ${escHtml(phoneDisplay(order.customer_phone))}\n`;
  message += `📍 Адрес: ${order.customer_address}\n`;
  message += `🚚 ${deliveryLabel}${payerNote}\n`;
  if (order.subtotal != null) {
    message += `🛍 Подытог: ${Number(order.subtotal).toLocaleString('ru')} сом.\n`;
    if (Number(order.delivery_fee) > 0) {
      message += `🚕 Доставка: ${Number(order.delivery_fee).toLocaleString('ru')} сом.\n`;
    }
  }
  message += `💰 <b>К оплате: ${(order.total||0).toLocaleString('ru')} сом.</b>\n\n`;
  if (order.fast_order) message += `⚡ <b>СРОЧНЫЙ ЗАКАЗ</b>\n`;
  if (order.delivery_time) message += `⏰ Желаемое время: ${order.delivery_time}\n`;
  if (order.fast_order || order.delivery_time) message += `\n`;
  message += `<b>Товары:</b>\n${itemsList}\n`;
  if (order.receiver_name) {
    message += `\n👤 <b>Получит другой человек:</b>\n`;
    message += `Имя: ${order.receiver_name}\n`;
    message += `Телефон: ${escHtml(phoneDisplay(order.receiver_phone))}\n`;
    message += `Адрес: ${order.receiver_address}\n`;
  }
  message += `\n🔗 <a href="${adminUrl}">Открыть в админ-панели</a>`;

  const actionsKeyboard = {
    inline_keyboard: [
      [
        { text: '✅ Одобрить заказ', callback_data: `order_confirm:${order.id}` },
        { text: '❌ Отклонить заказ', callback_data: `order_reject:${order.id}` }
      ],
      [{ text: '📋 Открыть админ-панель', url: adminUrl }]
    ]
  };

  const options = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: actionsKeyboard };

  let adminSent = 0;
  for (const chatId of adminChatIds) {
    try {
      if (order.receipt_url) {
        await adminBot.sendPhoto(chatId, order.receipt_url, { caption: message, ...options });
      } else {
        await adminBot.sendMessage(chatId, message, options);
      }
      adminSent++;
      console.log('[notifyAdminAboutOrder] Sent to admin:', chatId);
    } catch (err) {
      console.error('[notifyAdminAboutOrder] Failed to send to:', chatId, err.message);
    }
  }
  if (adminSent > 0) markNotificationSent(order.id, 'admin_new_order');
}

// ─────────────────────────────────────────────
// ⚙️ Обработка callback от администратора (одобрить/отклонить заказ)
// ─────────────────────────────────────────────
async function handleOrderCallback(callbackQuery) {
  if (!adminBot) return;
  const data = callbackQuery.data || '';
  const match = data.match(/^(order_confirm|order_reject):(.+)$/);
  if (!match) return;

  const action = match[1];
  const orderId = match[2];
  const status = action === 'order_confirm' ? 'payment_confirmed' : 'rejected';
  const label  = status === 'payment_confirmed' ? '✅ Оплата подтверждена — продавец уведомлён' : '❌ Заказ отклонён';

  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();

    // Обновляем только из pending — защита от повторных нажатий и дублей
    const { data: updatedOrder, error } = await db
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .eq('status', 'pending')
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!updatedOrder) {
      await adminBot.answerCallbackQuery(callbackQuery.id, {
        text: 'Заказ уже обработан ранее',
        show_alert: true,
      });
      return;
    }

    // ── Попытаться восстановить customer_chat_id если отсутствует ──
    if (!updatedOrder.customer_chat_id) {
      const resolved = await resolveChatId({
        phone:    updatedOrder.customer_phone,
        username: updatedOrder.customer_telegram,
      });
      if (resolved) {
        await db.from('orders').update({ customer_chat_id: resolved }).eq('id', orderId);
        updatedOrder.customer_chat_id = resolved;
        console.log('[handleOrderCallback] Restored customer_chat_id:', resolved);
      }
    }

    await adminBot.answerCallbackQuery(callbackQuery.id, { text: label, show_alert: false });

    let customerNotify = null;
    if (status === 'payment_confirmed') {
      try { await notifySellerAboutOrder(updatedOrder); } catch (e) { console.error('[handleOrderCallback] notifySellerAboutOrder:', e.message); }
      try { customerNotify = await notifyCustomerOnPaymentConfirmed(updatedOrder); } catch (e) { console.error('[handleOrderCallback] notifyCustomer:', e.message); }
    } else if (status === 'rejected') {
      try { await notifyCustomerPaymentRejected(updatedOrder); } catch (e) { console.error('[handleOrderCallback] notifyCustomerPaymentRejected:', e.message); }
    }

    if (shouldSendNotification(orderId, 'admin_confirm_followup:' + callbackQuery.from.id)) {
      let followUp =
        `Заказ #${orderId} ${status === 'payment_confirmed' ? 'подтверждён (оплата)' : 'отклонён'}.\n\n` +
        `📞 ${escHtml(phoneDisplay(updatedOrder.customer_phone))}\n` +
        `💰 ${(Number(updatedOrder.total) || 0).toLocaleString('ru')} сом.`;
      if (status === 'payment_confirmed') {
        if (customerNotify?.ok) {
          followUp += '\n\n✅ <b>Клиенту отправлено уведомление в бот.</b>';
        } else if (!customerNotify?.skipped) {
          followUp += '\n\n' + buildAdminUnreachableWarning(updatedOrder, customerNotify || { reason: 'no_chat_id' });
        }
      }
      try {
        await adminBot.sendMessage(callbackQuery.from.id, followUp, { parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (e) {
        console.error('[handleOrderCallback] admin followUp:', e.message);
      }
    }

    if (callbackQuery.message) {
      const { chat, message_id } = callbackQuery.message;
      const original = callbackQuery.message.caption || callbackQuery.message.text || '';
      const newText = `<b>${label}</b>\n\n${original}`;
      try {
        if (callbackQuery.message.caption) {
          await adminBot.editMessageCaption(newText, { chat_id: chat.id, message_id, parse_mode: 'HTML' });
        } else {
          await adminBot.editMessageText(newText, { chat_id: chat.id, message_id, parse_mode: 'HTML' });
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error('[handleOrderCallback] Error:', err.message);
    await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка при обновлении заказа', show_alert: true });
  }
}

// ─────────────────────────────────────────────
// 🏪 Уведомление продавцу когда админ подтвердил оплату
// ─────────────────────────────────────────────
function buildShopNewOrderMessage(order, items) {
  const orderRef = String(order.id).slice(0, 8);
  const itemsList = items.map(it => `• ${escHtml(it.title || 'Товар')} ×${it.qty || 1}`).join('\n');
  const total = (Number(order.total) || 0).toLocaleString('ru');
  const rejectMins = Math.round(SHOP_REJECT_MS / 60000);
  const remindMins = Math.round(SHOP_REMINDER_MS / 60000);
  let message =
    `🛒 <b>Новый заказ #${orderRef}</b>\n\n` +
    `📦 <b>Товары:</b>\n${itemsList}\n\n` +
    `💰 <b>Сумма:</b> ${total} сом\n` +
    `🚚 <b>Доставка:</b> ${escHtml(order.delivery_type || '—')}\n`;
  if (order.fast_order) message += `⚡ <b>СРОЧНЫЙ ЗАКАЗ</b>\n`;
  if (order.delivery_time) message += `⏰ Время: ${escHtml(order.delivery_time)}\n`;
  message += `\n⏳ Контакты клиента — после «Принять».\n`;
  message += `⏱ Ответьте за <b>${rejectMins} мин.</b> (напоминание через ${remindMins} мин.)`;
  return message;
}

/** Единая точка: отправить заказ в Shop Bot всем привязанным магазинам */
async function notifySellerAboutOrder(order) {
  if (!order?.id) return 0;

  const token = getShopBotToken();
  if (!token) {
    console.error('[shop-order] BOT_TOKEN_SHOP не задан');
    await notifyAdminShopsNotLinked(order, { noBot: [true] });
    return 0;
  }
  if (!ensureShopOutboundBot()) {
    await notifyAdminShopsNotLinked(order, { noBot: [true] });
    return 0;
  }
  initShopBot();

  const { items, sellerPhones, matched, linked, unlinked } = await resolveShopsForOrder(order);

  if (!sellerPhones.length) {
    await notifyAdminShopsNotLinked(order, { noChatId: [{ phone: '—', shop_name: 'нет seller_phone в заказе' }] });
    return 0;
  }
  if (!matched.length) {
    await notifyAdminShopsNotLinked(order, {
      noChatId: sellerPhones.map(p => ({ phone: p, shop_name: 'нет в таблице shops (active)' })),
    });
    return 0;
  }
  if (!linked.length) {
    await notifyAdminShopsNotLinked(order, { noChatId: unlinked.length ? unlinked : matched });
    return 0;
  }

  const message = buildShopNewOrderMessage(order, items);
  const keyboard = shopOrderKeyboard(order.id);
  const failed = [];
  let sent = 0;

  for (const shop of linked) {
    const chatId = shopChatId(shop.telegram_chat_id);
    try {
      await sendToShopChat(chatId, message, { parse_mode: 'HTML', reply_markup: keyboard });
      console.log('[shop-order] delivered', order.id, shop.shop_name || shop.phone, 'chat', chatId);
      sent++;
    } catch (e) {
      console.error('[shop-order] send fail', shop.phone, chatId, e.message);
      failed.push(shop);
    }
  }

  if (failed.length) await notifyAdminShopsNotLinked(order, { noChatId: failed });
  if (!sent) return 0;

  markShopOrderNotified(order.id);
  const timer = await setShopResponseTimer(order.id);
  if (!timer?.start) {
    console.error('[shop-order] timer not saved — выполните migrations/SUPABASE_RUN_THIS.sql');
  }
  return sent;
}

async function notifyAdminAboutShopOrder(order, shop) {
  if (!adminBot) return;
  const action = ['seller_accepted', 'confirmed'].includes(order.status)
    ? '✅ ПРИНЯЛ ЗАКАЗ'
    : (order.status === 'rejected' ? '❌ ОТКАЗАЛ В ЗАКАЗЕ' : `🔄 ${order.status.toUpperCase()}`);
  const shopName = shop.shop_name || shop.phone;

  let message = `🏪 <b>РЕШЕНИЕ МАГАЗИНА</b>\n\n`;
  message += `<b>Имя магазина:</b> ${shopName}\n`;
  message += `<b>Номер:</b> ${escHtml(phoneDisplay(shop.phone))}\n`;
  message += `<b>Действие:</b> ${action}\n\n`;
  message += `<b>Заказчик:</b> ${escHtml(phoneDisplay(order.customer_phone))}\n`;
  if (order.receiver_name) message += `<b>Получатель:</b> ${order.receiver_name} (${escHtml(phoneDisplay(order.receiver_phone))})\n`;
  message += `\n💰 Сумма: ${(order.total||0).toLocaleString('ru')} сом.`;

  for (const chatId of adminChatIds) {
    await adminBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  }
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getProductCode(num, prefix) {
  if (!num) return null;
  return prefix + '-' + String(Number(num)).padStart(4, '0');
}

// ─────────────────────────────────────────────
// 🚀 Инициализация всех ботов
// ─────────────────────────────────────────────
function initBots() {
  if (process.env.ADMIN_CHAT_ID_1) adminChatIds.add(process.env.ADMIN_CHAT_ID_1);
  if (process.env.ADMIN_CHAT_ID_2) adminChatIds.add(process.env.ADMIN_CHAT_ID_2);
  if (process.env.ADMIN_CHAT_ID)   adminChatIds.add(process.env.ADMIN_CHAT_ID);
  initUserBot();
  initAdminBot();
  ensureShopOutboundBot();
  initShopBot();
  startAutoConfirmInterval();
  startShopOrderTimeoutInterval();
  startAutoApprovePhotoInterval();
}

// ─────────────────────────────────────────────
// 👤 USER BOT — для покупателей
// ─────────────────────────────────────────────
let customerOrderHandlersRegistered = false;

function initUserBot() {
  if (userBot) return;
  const token = process.env.BOT_TOKEN_USER;
  if (!token) { console.log('BOT_TOKEN_USER не задан'); return; }
  userBot = new TG(token, { polling: true });

  userBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const name     = msg.from?.first_name || 'друг';
    const appUrl   = getMiniAppUrl();
    const param    = (match && match[1] || '').trim();
    const username = msg.from?.username;
    const chatId   = msg.chat.id;

    console.log('[/start] username:', username, 'chat_id:', chatId, 'param:', param.substring(0, 30));

    // ── АВТОМАТИЧЕСКИ РЕГИСТРИРУЕМ username → chat_id ──
    if (username) {
      const cleanUsername = normalizeUsername(username);
      usernameToChatId.set(cleanUsername, chatId);
      await saveUsernameMapping(cleanUsername, chatId);
      console.log('[/start] Registered username:', cleanUsername, '→', chatId);
    }

    // ── Запрашиваем номер телефона для связи с заказами ──
    // Это позволяет найти заказы клиента даже без username
    // Запрос делается в фоне — не блокирует UX

    if (param.startsWith('order_')) {
      const orderId = param.slice(6).trim();
      await registerCustomerFromTelegram({ chatId, username, orderId });
      try {
        const { createSupabaseClient } = require('../db/supabase');
        const db = createSupabaseClient();
        const { data: order } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
        if (!order) {
          await userBot.sendMessage(chatId, `❌ Заказ <b>#${orderId}</b> не найден.`, { parse_mode: 'HTML' });
          return;
        }
        await db.from('orders').update({ customer_chat_id: chatId }).eq('id', orderId);
        const fresh = { ...order, customer_chat_id: chatId };
        if (order.delivery_photo_url && ['ready', 'delivered'].includes(order.status)) {
          const photoRes = await notifyCustomerOrderReady(fresh, null, null, order.delivery_photo_url);
          await userBot.sendMessage(chatId,
            photoRes.ok
              ? `✅ <b>Аккаунт привязан!</b> Фото букета отправлено выше.\n\n📦 Заказ #${orderId}`
              : `✅ <b>Аккаунт привязан к заказу #${orderId}</b>.\n\nУведомления о статусе будут приходить сюда.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', url: appUrl }]] } }
          );
        } else if (['payment_confirmed', 'seller_accepted', 'preparing', 'ready', 'delivered'].includes(order.status)) {
          const sent = await sendCustomerPaymentNotification(fresh);
          if (sent.ok) {
            await userBot.sendMessage(chatId,
              `✅ <b>Уведомления подключены!</b>\n\nЗаказ <b>#${orderId}</b> — статусы заказа будут приходить в Telegram.`,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', url: appUrl }]] } }
            );
          } else {
            await userBot.sendMessage(chatId,
              `✅ Аккаунт привязан к заказу <b>#${orderId}</b>.\n\nМы сообщим о статусе, когда оплата будет подтверждена.`,
              { parse_mode: 'HTML' }
            );
          }
        } else {
          await userBot.sendMessage(chatId,
            `✅ <b>Аккаунт привязан к заказу #${orderId}</b>\n\nОжидайте подтверждения оплаты администратором.`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', url: appUrl }]] } }
          );
        }
      } catch (e) {
        console.error('[/start order_]', e.message);
        await userBot.sendMessage(chatId, '❌ Ошибка привязки заказа. Напишите @rebuket_admin.');
      }
      return;
    }

    if (param === 'inquiry' || param.startsWith('inq_')) {
      const adminHandle = (process.env.ADMIN_TELEGRAM || 'https://t.me/Rebuket_admin')
        .replace('https://t.me/', '').replace('@', '').trim();
      let readyText = '🌸 Здравствуйте! Хочу сделать заказ через ReBuket.';
      if (param.startsWith('inq_')) {
        try {
          const b64 = param.slice(4).replace(/-/g, '+').replace(/_/g, '/');
          const decoded = decodeURIComponent(escape(Buffer.from(b64, 'base64').toString('binary')));
          if (decoded && decoded.length > 5) readyText = decoded;
        } catch(e) { console.log('decode err:', e.message); }
      }
      const adminUrl = 'https://t.me/' + adminHandle + '?text=' + encodeURIComponent(readyText);
      await userBot.sendMessage(chatId,
        '✅ <b>Заявка принята!</b>\n\nДля полного оформления заказа — нажмите кнопку ниже:',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✈️ Отправить заказ администратору', url: adminUrl }]] } }
      );
      return;
    }

    const registrationStatus = username
      ? `✅ Ваш Telegram username <b>@${username}</b> зарегистрирован для уведомлений.\n\n`
      : `⚠️ У вас не установлен username в Telegram.\n\nДля получения уведомлений о заказах установите username в настройках и напишите /start снова.\n\n`;

    await userBot.sendMessage(chatId,
      `🌸 <b>Привет, ${escHtml(name)}!</b>\n\n${registrationStatus}Добро пожаловать в <b>ReBuket</b> — маркетплейс букетов и сладостей в Таджикистане.\n\n💐 <b>Купить</b> — просматривать букеты, корзины, игрушки и сладости\n🛍 <b>Продать</b> — разместить своё объявление\n\n👇 Нажмите кнопку ниже чтобы открыть каталог:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🌸 Открыть ReBuket', url: appUrl }]],
          // Кнопка для получения номера телефона — поможет привязать к заказам
          keyboard: username ? undefined : [[{ text: '📞 Поделиться номером для уведомлений', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      }
    );
  });

  // ── Обработчик контакта — сохраняем телефон → chat_id ──
  userBot.on('contact', async (msg) => {
    if (!msg.contact) return;
    const phone  = (msg.contact.phone_number || '').replace(/[^\d+]/g, '');
    const chatId = msg.chat.id;
    const username = msg.from?.username;

    if (!phone) return;

    await savePhoneMapping(phone, chatId, username);
    console.log('[contact] Phone registered:', phone, '→', chatId);

    // Пытаемся привязать существующие заказы по этому телефону
    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const phoneWithPlus = phone.startsWith('+') ? phone : '+' + phone;
      const variants = [phoneWithPlus, phoneWithPlus.replace(/^\+/, ''), phone];
      const { data: orders } = await db
        .from('orders')
        .select('id')
        .in('customer_phone', variants)
        .is('customer_chat_id', null)
        .limit(20);
      if (orders?.length) {
        for (const o of orders) {
          await db.from('orders').update({ customer_chat_id: chatId }).eq('id', o.id);
        }
        console.log('[contact] Patched', orders.length, 'existing orders with chat_id:', chatId);
      }
    } catch (e) {
      console.error('[contact] Error patching orders:', e.message);
    }

    await userBot.sendMessage(chatId,
      `✅ <b>Номер сохранён!</b>\n\nТеперь вы будете получать уведомления о заказах в Telegram.\n\n📞 ${phone}`,
      { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
    );
  });

  userBot.onText(/\/catalog/, async (msg) => {
    await userBot.sendMessage(msg.chat.id, `💐 <b>Каталог ReBuket</b>\n\nБукеты, корзины, игрушки и сладости:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💐 Смотреть каталог', url: getMiniAppUrl() + '#catalog' }]] } }
    );
  });

  userBot.onText(/\/sell/, async (msg) => {
    await userBot.sendMessage(msg.chat.id, `🛍 <b>Разместить объявление</b>\n\nПродайте букеты или сладости через ReBuket!`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ Разместить объявление', url: getMiniAppUrl() + '#sell' }]] } }
    );
  });

  userBot.onText(/\/help/, async (msg) => {
    await userBot.sendMessage(msg.chat.id,
      `🌸 <b>ReBuket — помощь</b>\n\n/start   — запустить бота\n/catalog — каталог\n/sell    — разместить объявление\n/help    — эта справка\n/register @username — зарегистрировать Telegram username`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', url: getMiniAppUrl() }]] } }
    );
  });

  userBot.onText(/\/register\s+(@?\w+)/, async (msg, match) => {
    const username = normalizeUsername(match[1]);
    const chatId = msg.chat.id;
    usernameToChatId.set(username, chatId);
    await saveUsernameMapping(username, chatId);
    await userBot.sendMessage(chatId,
      `✅ <b>Username зарегистрирован!</b>\n\nВы будете получать уведомления на этот аккаунт.\n\n📱 @${username}`,
      { parse_mode: 'HTML' }
    );
  });

  registerCustomerOrderHandlers();

  userBot.on('polling_error', (err) => {
    if (!err.message?.includes('409')) console.log('USER BOT error:', err.message);
  });

  console.log('🤖 USER BOT запущен | Mini App:', getMiniAppUrl());
}

// ─────────────────────────────────────────────
// 🛠 ADMIN BOT
// ─────────────────────────────────────────────
function initAdminBot() {
  const token = process.env.BOT_TOKEN_ADMIN;
  if (!token) { console.log('BOT_TOKEN_ADMIN не задан'); return; }
  adminBot = new TG(token, { polling: true });

  adminBot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    const isNew  = !adminChatIds.has(chatId);
    adminChatIds.add(chatId);
    await adminBot.sendMessage(msg.chat.id,
      `🔐 <b>ReBuket Admin Bot</b>\n\n` +
      (isNew
        ? `✅ Ваш Chat ID <b>${chatId}</b> добавлен.\nТеперь вы будете получать уведомления.`
        : `Вы уже подключены. Ваш Chat ID: <b>${chatId}</b>`),
      { parse_mode: 'HTML' }
    );
    if (isNew) console.log(`✅ Новый админ: ADMIN_CHAT_ID=${chatId}`);
  });

  adminBot.on('polling_error', (err) => {
    if (!err.message?.includes('409')) console.log('ADMIN BOT error:', err.message);
  });

  console.log('🛠  ADMIN BOT запущен');
}

async function sendToAdmins(text, opts = {}) {
  if (!adminBot) return;
  if (!adminChatIds.size) { console.log('⚠️ Нет админов'); return; }
  for (const chatId of adminChatIds) {
    try {
      await adminBot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
    } catch (e) {
      console.log(`ADMIN BOT send error (${chatId}):`, e.message);
    }
  }
}

// ─────────────────────────────────────────────
//  Публикация в канал при одобрении
// ─────────────────────────────────────────────
async function getNextSerial(channel) {
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    const { data, error } = await db.rpc('increment_counter', { ch: channel });
    if (error) throw new Error(error.message);
    return data;
  } catch(e) {
    console.log('[getNextSerial] Error:', e.message);
    return null;
  }
}

async function publishToChannel(p) {
  const city      = (p.city || '').toLowerCase().trim();
  const isKhujand = KHUJAND_CITIES.includes(city);
  const channelId = isKhujand
    ? (process.env.CHANNEL_ID_KHUJAND || '-1003818624807')
    : process.env.CHANNEL_ID;

  if (!channelId) { console.log('[publishToChannel] CHANNEL_ID не задан'); return; }

  const bot = userBot || adminBot;
  if (!bot) { console.log('[publishToChannel] Нет активного бота'); return; }

  const EMOJIS = { bouquet: '💐', basket: '🧺', bear: '🧸', sweets: '🍰' };
  const em     = EMOJIS[p.category] || '🌸';
  const isShop = p.listing_type === 'shop' || p.pricing_mode === 'inclusive';
  const Commission = require('./commission');
  const listed = Number(p.price) || 0;
  const pct = p.category === 'sweets' ? 10 : (isShop ? 25 : 20);
  const buyerPrice = p.is_admin_price
    ? listed
    : Commission.calculate(listed, pct, isShop ? 'inclusive' : 'exclusive').customer_pays;
  const admin  = process.env.ADMIN_TELEGRAM
    ? process.env.ADMIN_TELEGRAM.replace('https://t.me/', '@')
    : '@rebuket_admin';
  const url    = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const photos = Array.isArray(p.photos) ? p.photos.filter(Boolean).map(ph => ph.split('?')[0]) : [];

  const serialNum = await getNextSerial(isKhujand ? 'khujand' : 'dushanbe');
  const code      = getProductCode(serialNum, isKhujand ? 'AK' : 'AB');

  let caption;
  if (isShop) {
    // Формируем строку о наличии/заказе
    let availabilityLine = '';
    if (p.availability_type === 'on_order') {
      availabilityLine = `⏳ <b>На заказ${p.prepare_hours ? ` · Готовится ${p.prepare_hours} ч` : ''}</b>\n`;
    } else {
      const stockQty = p.stock_quantity;
      if (stockQty && stockQty < 999999) {
        availabilityLine = `✅ <b>В наличии: ${stockQty} шт</b>\n`;
      } else {
        availabilityLine = `✅ <b>В наличии</b>\n`;
      }
    }

    caption =
      `🏪 <b>${escHtml(p.seller_name || 'Магазин')}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${em} <b>${escHtml(p.title)}</b>\n` +
      `📍 ${escHtml(p.city || '—')}\n` +
      (p.size ? `📏 <b>Размер: ${escHtml(p.size)}</b>\n` : '') +
      availabilityLine +
      `\n💰 <b>${buyerPrice.toLocaleString('ru-RU')} сомони</b>\n` +
      (code ? `🆔 ${code}\n` : '') +
      `\n📲 По вопросам: ${admin}\n` +
      `\n<a href="${url}">🛒 Смотреть в магазине ReBuket</a>`;
  } else {
    caption =
      `${em} ${escHtml(p.title)}\n` +
      `📍 ${escHtml(p.city || '—')}\n` +
      (p.size       ? `📏 <b>Размер: ${escHtml(p.size)}</b>\n` : '') +
      (p.gift_when  ? `🎁 <b>Когда получили: ${escHtml(p.gift_when)}</b>\n` : '') +
      (p.market_price ? `🏪 Цена в магазинах: ${(Math.ceil(Number(p.market_price) / 10) * 10).toLocaleString('ru-RU')} сомони\n` : '') +
      `💰 <b>Наша цена: ${buyerPrice.toLocaleString('ru-RU')} сомони</b>\n` +
      `❓ По вопросам: ${admin}\n` +
      (code ? `🆔 ${code}\n` : '') +
      `\n<a href="${url}">Смотреть объявление на ReBuket</a>`;
  }

  try {
    let sent = null;
    if (photos.length === 0) {
      sent = await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
    } else if (photos.length === 1) {
      try {
        sent = await bot.sendPhoto(channelId, photos[0], { caption, parse_mode: 'HTML' });
      } catch(photoErr) {
        sent = await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
      }
    } else {
      try {
        const media = photos.slice(0, 10).map((ph, i) => ({
          type: 'photo', media: ph,
          ...(i === 0 ? { caption, parse_mode: 'HTML' } : {})
        }));
        const results = await bot.sendMediaGroup(channelId, media);
        sent = Array.isArray(results) ? results[0] : results;
      } catch(mediaErr) {
        try { sent = await bot.sendPhoto(channelId, photos[0], { caption, parse_mode: 'HTML' }); }
        catch(e2) { sent = await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' }); }
      }
    }

    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      if (sent?.message_id) {
        await db.from('products').update({
          channel_message_id: sent.message_id,
          channel_name: isKhujand ? 'khujand' : 'dushanbe'
        }).eq('id', p.id);
      }
    } catch(e) { console.log('Не удалось сохранить message_id:', e.message); }

    console.log(`📢 Опубликовано в канал: ${p.title} [${code}]`);
  } catch(e) {
    console.log('[publishToChannel] Ошибка:', e.message);
  }
}

async function markExpiredInChannel(p) {
  const bot = userBot || adminBot;
  if (!bot || !p.channel_message_id || !p.channel_name) return;

  const channelId = p.channel_name === 'khujand'
    ? (process.env.CHANNEL_ID_KHUJAND || '-1003818624807')
    : process.env.CHANNEL_ID;
  if (!channelId) return;

  const EMOJIS = { bouquet: '💐', basket: '🧺', bear: '🧸', sweets: '🍰' };
  const em     = EMOJIS[p.category] || '🌸';
  const price  = (Math.ceil(Number(p.price) * 1.20 / 10) * 10).toLocaleString('ru-RU');
  const admin  = process.env.ADMIN_TELEGRAM
    ? process.env.ADMIN_TELEGRAM.replace('https://t.me/', '@')
    : '@rebuket_admin';

  const newCaption =
    `🔴 <b>СНЯТО С ПРОДАЖИ</b>\n\n` +
    `${em} <b>${escHtml(p.title)}</b>\n` +
    `📍 ${escHtml(p.city)}\n` +
    `💰 Цена была: <b>${price} сомони</b>\n\n` +
    `❓ По вопросам: ${admin}`;

  try {
    await bot.editMessageCaption(newCaption, {
      chat_id: channelId, message_id: p.channel_message_id, parse_mode: 'HTML'
    });
  } catch(e) { console.log('Ошибка редактирования поста:', e.message); }
}

async function notifySellerApproved(p) {
  try { await publishToChannel(p); } catch(e) { console.log('Channel publish error:', e.message); }
  if (!userBot || !p.seller_chat_id) return;
  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  try {
    await userBot.sendMessage(p.seller_chat_id,
      `🎉 <b>Ваше объявление одобрено!</b>\n\n📦 <b>${escHtml(p.title)}</b>\n💰 ${p.price} TJS · 📍 ${escHtml(p.city)}\n\nТеперь его видят все покупатели. Удачных продаж! 🌸`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть моё объявление', url }]] } }
    );
    if (p.channel_message_id && p.channel_name) {
      const channelId = p.channel_name === 'khujand'
        ? (process.env.CHANNEL_ID_KHUJAND || '-1003818624807')
        : process.env.CHANNEL_ID;
      if (channelId) {
        try { await userBot.forwardMessage(p.seller_chat_id, channelId, p.channel_message_id); }
        catch(fe) { console.log('forwardMessage error:', fe.message); }
      }
    }
  } catch(e) { console.log('notifySellerApproved error:', e.message); }
}

async function notifySellerRejected(p) {
  if (!userBot || !p.seller_chat_id) return;
  try {
    await userBot.sendMessage(p.seller_chat_id,
      `❌ <b>Ваше объявление отклонено</b>\n\n📦 <b>${escHtml(p.title)}</b>\n\nОбъявление не прошло модерацию. Вы можете разместить новое:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ Разместить новое', url: getMiniAppUrl() + '#sell' }]] } }
    );
  } catch(e) { console.log('notifySellerRejected error:', e.message); }
}

const CATS = { bouquet: '💐 Букет', basket: '🧺 Корзина', bear: '🧸 Игрушки', sweets: '🍰 Сладости' };

async function notifyProduct(p) {
  console.log('[notifyProduct] Received product data:', JSON.stringify(p, null, 2));

  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const isShop = p.listing_type === 'shop' || p.pricing_mode === 'inclusive';
  const Commission = require('./commission');
  const listed = Number(p.price) || 0;
  const pct = p.category === 'sweets' ? 10 : (isShop ? 25 : 20);
  const mode = isShop ? 'inclusive' : 'exclusive';
  const br = Commission.calculate(listed, pct, mode);
  const buyerPrice = br.customer_pays;
  const sellerPayout = br.seller_payout;
  const fee = br.platform_fee;

  let text;
  if (isShop) {
    let avail;
    if (p.availability_type === 'on_order') {
      avail = `⏳ На заказ${p.prepare_hours ? ` · готовится ${p.prepare_hours} ч` : ''}`;
    } else {
      const sq = Number(p.stock_quantity);
      avail = (sq && sq < 999999) ? `✅ В наличии: ${sq} шт` : '✅ В наличии';
    }
    text =
      `🏪 <b>НОВАЯ ПУБЛИКАЦИЯ ОТ МАГАЗИНА</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n\n` +
      `🏬 <b>Магазин:</b> ${escHtml(p.seller_name || '—')}\n` +
      `📞 <b>Телефон:</b> ${escHtml(p.seller_phone)}\n` +
      (p.seller_telegram ? `✈️ <b>Telegram:</b> ${escHtml(p.seller_telegram)}\n` : '') +
      `📍 <b>Город:</b> ${escHtml(p.city || '—')}\n` +
      (p.size ? `📏 <b>Размер:</b> ${escHtml(p.size)}\n` : '') +
      `📦 <b>Наличие:</b> ${avail}\n\n` +
      `💰 <b>Цена для покупателя:</b> ${buyerPrice.toLocaleString('ru')} TJS\n` +
      `💵 <b>Доля магазина:</b> ${sellerPayout.toLocaleString('ru')} TJS\n` +
      `📊 <b>Комиссия (${pct}%):</b> ${fee.toLocaleString('ru')} TJS\n\n` +
      `🔗 <a href="${url}">Открыть объявление</a>`;
  } else {
    text =
      `📦 <b>Новое объявление на проверке</b>\n─────────────────\n` +
      `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n` +
      `💰 ${buyerPrice.toLocaleString('ru')} TJS · 📍 ${escHtml(p.city || '—')}\n` +
      `👤 ${escHtml(p.seller_name || '—')} · 📞 ${escHtml(p.seller_phone)}\n` +
      (p.seller_telegram ? `✈️ ${escHtml(p.seller_telegram)}\n` : '') +
      `🔗 <a href="${url}">Открыть объявление</a>`;
  }

  console.log('[notifyProduct] Sending notification text:', text);
  await sendToAdmins(text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Одобрить', callback_data: `approve:${p.id}` }, { text: '❌ Отклонить', callback_data: `reject:${p.id}` }],
        [{ text: '🔗 Открыть объявление', url }]
      ]
    }
  });
}

async function notifyInquiry(inq, productTitle, productSlug, productId) {
  const url = (productSlug || productId) ? `${getMiniAppUrl()}/#product-${productSlug || productId}` : null;
  const productLine = url
    ? `🔗 <a href="${url}">${escHtml(url)}</a>`
    : `📦 ${escHtml(productTitle || '—')}`;
  await sendToAdmins(
    `🛒 <b>Новая заявка!</b>\n─────────────────\n` +
    `${productLine}\n` +
    `👤 ${escHtml(inq.customer_name || '—')}\n` +
    `📞 <b>${escHtml(phoneDisplay(inq.customer_phone))}</b>\n` +
    `✈️ ${escHtml(inq.customer_telegram || '—')}\n` +
    `📝 ${escHtml(inq.note || '—')}`,
    url ? { reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть букет', url }]] } } : {}
  );
}

async function notifyShopRegistration(shop) {
  await sendToAdmins(
    `🏪 <b>Новая заявка на регистрацию магазина!</b>\n─────────────────\n` +
    `👤 Название: <b>${escHtml(shop.shop_name || '—')}</b>\n` +
    `📞 Телефон: <b>${escHtml(phoneDisplay(shop.phone))}</b>\n` +
    `🕐 ${new Date().toLocaleString('ru')}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Одобрить магазин', callback_data: `shop_approve:${shop.id}` },
          { text: '❌ Отклонить',        callback_data: `shop_reject:${shop.id}` }
        ]]
      }
    }
  );
}

async function notifyShopApproved(shop) {
  if (!shop.telegram_chat_id || !getShopBotToken()) return;
  try {
    await sendToShopChat(shop.telegram_chat_id,
      `✅ <b>Ваш магазин одобрен!</b>\n\nВойдите в Shop Bot (/start) и отправьте телефон и пароль, чтобы получать заказы.\n\n📞 Телефон: ${escHtml(phoneDisplay(shop.phone))}`,
      { parse_mode: 'HTML' }
    );
  } catch (e) { console.log('notifyShopApproved error:', e.message); }
}

async function notifyShopRejected(shop) {
  if (!shop.telegram_chat_id || !getShopBotToken()) return;
  try {
    await sendToShopChat(shop.telegram_chat_id,
      `❌ <b>Заявка на регистрацию магазина отклонена</b>\n\nСвяжитесь с администратором для уточнения причин.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) { console.log('notifyShopRejected error:', e.message); }
}

function setupCallbacks(onApprove, onReject) {
  if (!adminBot) return;
  adminBot.on('callback_query', async (q) => {
    const data = q.data || '';
    if (/^(order_confirm|order_reject):/.test(data)) {
      try { await handleOrderCallback(q); } catch (err) { console.error('[adminBot order callback]', err.message); }
      return;
    }

    const parts  = data.split(':');
    const action = parts[0];
    const id     = parts[1];

    if (action === 'approve') {
      await onApprove(id);
      await adminBot.answerCallbackQuery(q.id, { text: '✅ Одобрено!' });
      await adminBot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '✅ Одобрено', callback_data: 'done' }]] },
        { chat_id: q.message.chat.id, message_id: q.message.message_id }
      ).catch(() => {});
    }

    if (action === 'reject') {
      await onReject(id);
      await adminBot.answerCallbackQuery(q.id, { text: '❌ Отклонено' });
      await adminBot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '❌ Отклонено', callback_data: 'done' }]] },
        { chat_id: q.message.chat.id, message_id: q.message.message_id }
      ).catch(() => {});
    }

    if (action === 'shop_approve') {
      try {
        const S = require('../controllers/shops');
        const shop = await S.approve(id);
        await notifyShopApproved(shop);
        await adminBot.answerCallbackQuery(q.id, { text: '✅ Магазин одобрен!' });
        await adminBot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: '✅ Магазин одобрен', callback_data: 'done' }]] },
          { chat_id: q.message.chat.id, message_id: q.message.message_id }
        ).catch(() => {});
      } catch(e) {
        await adminBot.answerCallbackQuery(q.id, { text: '❌ Ошибка: ' + e.message });
      }
    }

    if (action === 'shop_reject') {
      try {
        const S = require('../controllers/shops');
        const shop = await S.reject(id);
        await notifyShopRejected(shop);
        await adminBot.answerCallbackQuery(q.id, { text: '❌ Отклонено' });
        await adminBot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: '❌ Отклонено', callback_data: 'done' }]] },
          { chat_id: q.message.chat.id, message_id: q.message.message_id }
        ).catch(() => {});
      } catch(e) {
        await adminBot.answerCallbackQuery(q.id, { text: '❌ Ошибка: ' + e.message });
      }
    }
  });
}

async function notifyBuyerInquirySent(d) {
  if (!userBot || !d.customer_chat_id) return;
  try {
    const COMM = 0.20;
    const price = d.productPrice
      ? (Math.ceil(Number(d.productPrice) * (1 + COMM) / 10) * 10).toLocaleString('ru-RU') + ' сомони'
      : null;
    const url = (d.productSlug || d.productId)
      ? getMiniAppUrl() + '/#product-' + (d.productSlug || d.productId)
      : getMiniAppUrl();
    const adminHandle = (process.env.ADMIN_TELEGRAM || 'https://t.me/Rebuket_admin')
      .replace('https://t.me/', '').replace('@', '').trim();
    const parts = [
      '🌸 Здравствуйте! Хочу купить:',
      '',
      '🔗 ' + url,
      '📞 Мой телефон: ' + d.customer_phone
    ];
    if (d.customer_name)     parts.push('👤 Имя: '          + d.customer_name);
    if (d.customer_telegram) parts.push('✈️ Telegram: '     + d.customer_telegram);
    if (d.note)              parts.push('📝 Комментарий: '  + d.note);
    const readyText = parts.join('\n');
    const tgLink = 'https://t.me/' + adminHandle + '?text=' + encodeURIComponent(readyText);
    const text =
      '✅ <b>Ваша заявка принята!</b>\n\n' +
      `🔗 <a href="${url}">${escHtml(url)}</a>\n` +
      (price ? '💰 ' + price + '\n' : '') +
      '\nНажмите кнопку ниже — сообщение уже готово:';
    await userBot.sendMessage(d.customer_chat_id, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '✈️ Написать администратору', url: tgLink }]] }
    });
  } catch(e) { console.log('notifyBuyerInquirySent error:', e.message); }
}

// ─────────────────────────────────────────────
// 🏪 SHOP BOT
// ─────────────────────────────────────────────
const shopAuthState = new Map();

function initShopBot() {
  if (shopBot) return;
  const token = getShopBotToken();
  if (!token) { console.log('BOT_TOKEN_SHOP не задан — shopBot не запущен'); return; }
  try {
    shopBot = new TG(token, { polling: true });
  } catch (e) {
    console.error('initShopBot: failed to create bot:', e.message);
    return;
  }

  const bcrypt = require('bcryptjs');
  function getDb() {
    const { createSupabaseClient } = require('../db/supabase');
    return createSupabaseClient();
  }

  shopBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    shopAuthState.set(chatId, { step: 'phone' });
    await shopBot.sendMessage(chatId,
      `🏪 <b>ReBuket Shop Bot</b>\n\nЧтобы получать заказы, авторизуйтесь как магазин.\n\n📞 Шаг 1/2: отправьте <b>номер телефона</b> вашего магазина.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [[{ text: '📞 Поделиться номером', request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true
        }
      }
    );
  });

  shopBot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const cid = shopChatId(chatId);
      await getDb().from('shops').update({ telegram_chat_id: null }).eq('telegram_chat_id', cid);
      shopAuthState.delete(chatId);
      await shopBot.sendMessage(chatId, '✅ Вы вышли из аккаунта. Отправьте /start чтобы войти снова.', { reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error('[shopBot /logout]', e.message); }
  });

  shopBot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const phone = (msg.contact && msg.contact.phone_number || '').replace(/[^\d+]/g, '');
    if (!phone) return;
    await handlePhoneInput(chatId, phone);
  });

  shopBot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const state = shopAuthState.get(chatId);
    if (state) {
      if (state.step === 'phone') {
        const phone = msg.text.replace(/[^\d+]/g, '');
        if (!phone || phone.length < 5) {
          await shopBot.sendMessage(chatId, '⚠️ Похоже на неверный номер. Попробуйте ещё раз.');
          return;
        }
        await handlePhoneInput(chatId, phone);
      } else if (state.step === 'password') {
        const password = msg.text.trim();
        try { await shopBot.deleteMessage(chatId, msg.message_id); } catch(_) {}
        await handlePasswordInput(chatId, password, state.phone, state.shopId);
      }
      return;
    }

    await shopBot.sendMessage(chatId, 'Используйте команды: /start /logout /cancel');
  });

  async function handlePhoneInput(chatId, rawPhone) {
    try {
      const want = phoneDigits(rawPhone);
      if (!want) {
        await shopBot.sendMessage(chatId, '❌ Неверный номер. Отправьте телефон магазина как в заявке (например +992901234567).');
        return;
      }
      const active = await loadActiveShops();
      const shop = active.find(s => phoneDigits(s.phone) === want);
      if (!shop) {
        const { data: anyShops } = await getDb().from('shops').select('phone, shop_name, status');
        const pending = (anyShops || []).find(s => phoneDigits(s.phone) === want);
        if (pending && pending.status !== 'active') {
          await shopBot.sendMessage(chatId, `⚠️ Магазин найден, но статус: <b>${pending.status}</b>. Дождитесь одобрения.`, { parse_mode: 'HTML' });
        } else {
          await shopBot.sendMessage(chatId, `❌ Магазин с номером <b>${escHtml(phoneDisplay(rawPhone))}</b> не найден.`, { parse_mode: 'HTML' });
        }
        shopAuthState.delete(chatId);
        return;
      }
      if (shop.status !== 'active') {
        await shopBot.sendMessage(chatId, `⚠️ Магазин найден, но статус: <b>${shop.status}</b>. Дождитесь одобрения.`, { parse_mode: 'HTML' });
        shopAuthState.delete(chatId);
        return;
      }
      shopAuthState.set(chatId, { step: 'password', phone: shop.phone, shopId: shop.id });
      await shopBot.sendMessage(chatId,
        `✅ Магазин найден: <b>${shop.shop_name || shop.phone}</b>\n\n🔒 Шаг 2/2: отправьте <b>пароль</b>.\n\n<i>Сообщение с паролем будет удалено автоматически.</i>`,
        { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
      );
    } catch (e) {
      console.error('[shopBot handlePhoneInput]', e.message);
      await shopBot.sendMessage(chatId, '❌ Ошибка. Попробуйте /start снова.');
    }
  }

  async function handlePasswordInput(chatId, password, phone, shopId) {
    try {
      const db = getDb();
      let q = db.from('shops').select('id, phone, shop_name, password_hash, status');
      q = shopId ? q.eq('id', shopId) : q.eq('phone', phone);
      const { data: shop } = await q.single();
      if (!shop || !shop.password_hash) {
        await shopBot.sendMessage(chatId, '❌ Магазин не найден или пароль не задан.');
        shopAuthState.delete(chatId);
        return;
      }
      const valid = await bcrypt.compare(password, shop.password_hash);
      if (!valid) {
        await shopBot.sendMessage(chatId, '❌ Неверный пароль. Отправьте /start чтобы попробовать снова.');
        shopAuthState.delete(chatId);
        return;
      }
      const chatIdNum = shopChatId(chatId);
      const { error: upErr } = await db.from('shops').update({ telegram_chat_id: chatIdNum }).eq('id', shop.id);
      if (upErr) {
        console.error('[shopBot] telegram_chat_id save:', upErr.message);
        await shopBot.sendMessage(chatId,
          '❌ Не удалось сохранить подключение.\n\nАдмину: выполните migrations/SUPABASE_RUN_THIS.sql в Supabase.',
          { parse_mode: 'HTML' }
        );
        shopAuthState.delete(chatId);
        return;
      }
      shopAuthState.delete(chatId);
      await shopBot.sendMessage(chatId,
        `✅ <b>${shop.shop_name || 'Магазин'}</b> успешно подключён!\n\nВы будете получать только свои заказы.\n\n📞 Телефон: ${escHtml(phoneDisplay(shop.phone))}\n• /logout — выйти`,
        { parse_mode: 'HTML' }
      );
      try {
        await sendToShopChat(chatIdNum, '🔔 <b>Тест:</b> Shop Bot подключён. Новые заказы будут приходить сюда.', { parse_mode: 'HTML' });
      } catch (e) {
        console.error('[shopBot] test message after login:', e.message);
      }
      console.log('[shopBot] Authorized:', shop.phone, '→ chat_id:', chatIdNum);
    } catch (e) {
      console.error('[shopBot handlePasswordInput]', e.message);
      await shopBot.sendMessage(chatId, '❌ Ошибка авторизации. Попробуйте /start снова.');
      shopAuthState.delete(chatId);
    }
  }

  shopBot.onText(/\/cancel/, async (msg) => {
    if (shopPendingPhoto.has(msg.chat.id)) {
      shopPendingPhoto.delete(msg.chat.id);
      await shopBot.sendMessage(msg.chat.id, '↩️ Отмена. Фото не отправлено.');
    }
  });

  shopBot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const orderId = shopPendingPhoto.get(chatId);
    if (!orderId) return;
    shopPendingPhoto.delete(chatId);

    try {
      const db = getDb();
      const { data: orderRow } = await db.from('orders').select('*').eq('id', orderId).single();
      if (!orderRow) {
        await shopBot.sendMessage(chatId, '❌ Заказ не найден.');
        return;
      }

      const photo = msg.photo[msg.photo.length - 1];
      const buffer = await downloadBotFile(shopBot, photo.file_id);
      const { uploadPhoto } = require('../db/supabase');
      const photoUrl = await uploadPhoto(buffer, `delivery-${orderId}-${Date.now()}.jpg`, 'image/jpeg');
      const shop = await getShopByTelegramChat(chatId);

      // Проверяем, это повторное фото (после дизлайка) или первое
      const isRetry = orderRow.photo_approved === false && orderRow.photo_feedback;

      const orderForNotify = { ...orderRow, delivery_photo_url: photoUrl, status: 'ready' };
      let notifyResult = { ok: false, reason: 'no_chat_id' };
      try {
        notifyResult = await notifyCustomerOrderReady(orderForNotify, shop, buffer, photoUrl);
      } catch (e) {
        console.error('[shopBot photo] notify customer:', e.message);
        notifyResult = { ok: false, reason: 'send_failed', error: e.message };
      }

      // Обновляем заказ - сбрасываем фидбек при повторной отправке
      const updates = { status: 'ready', delivery_photo_url: photoUrl, photo_sent_at: new Date().toISOString() };
      if (isRetry) {
        updates.photo_approved = null;
        updates.photo_feedback = null;
      }
      await db.from('orders').update(updates).eq('id', orderId);

      const botUser = getBotUsername();
      const customerLink = buildCustomerBotLink(orderId);
      let shopReply = `✅ <b>Заказ #${orderId}</b> — статус «📦 Готов», фото сохранено.`;
      if (notifyResult.ok && !notifyResult.textOnly) {
        shopReply += '\n\n📲 Фото доставлено клиенту в Telegram.';
      } else if (notifyResult.ok && notifyResult.textOnly) {
        shopReply += '\n\n📲 Клиенту отправлено уведомление с ссылкой на фото.';
      } else {
        shopReply +=
          `\n\n📲 Клиент получит фото после открытия бота @${botUser} (кнопка Start):\n` +
          `<a href="${customerLink}">${customerLink}</a>`;
      }

      await shopBot.sendMessage(chatId, shopReply, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '🚚 Доставлен', callback_data: `shop_delivered:${orderId}` }]] }
      });
    } catch (e) {
      console.error('[shopBot photo]', e.message);
      try { await shopBot.sendMessage(chatId, '❌ Не удалось обработать фото: ' + e.message); } catch(_){}
    }
  });

  shopBot.on('callback_query', async (q) => {
    const data = q.data || '';

    const mref = data.match(/^shop_refund_(approve|dispute):(.+)$/);
    if (mref) {
      const [, refundAction, orderId] = mref;
      const newStatus = refundAction === 'approve' ? 'refunded' : 'refund_disputed';
      try {
        const db = getDb();
        const shop = await getShopByTelegramChat(q.message.chat.id);
        if (!shop) { await shopBot.answerCallbackQuery(q.id, { text: 'Сначала /start', show_alert: true }); return; }
        const { data: updated } = await db.from('orders').update({ status: newStatus }).eq('id', orderId).select().single();
        await shopBot.answerCallbackQuery(q.id, { text: refundAction === 'approve' ? '✅ Возврат одобрен' : '⚠️ Возврат оспорен' });
        await shopBot.sendMessage(q.message.chat.id, refundAction === 'approve'
          ? `✅ Возврат по заказу #${orderId} одобрен.`
          : `⚠️ Возврат по заказу #${orderId} оспорен.`);
        if (updated?.customer_chat_id && userBot) {
          try {
            await userBot.sendMessage(updated.customer_chat_id,
              refundAction === 'approve'
                ? `✅ <b>Возврат одобрен</b>\n\nЗаказ #${orderId} — магазин одобрил возврат. Свяжитесь с @rebuket_admin.`
                : `⚠️ <b>Магазин оспорил возврат</b>\n\nЗаказ #${orderId}. Для рассмотрения напишите @rebuket_admin`,
              { parse_mode: 'HTML' });
          } catch(_) {}
        }
        try { await notifyAdminAboutShopOrder(updated, shop); } catch(_) {}
      } catch (e) {
        console.error('[shopBot refund]', e.message);
        await shopBot.answerCallbackQuery(q.id, { text: 'Ошибка', show_alert: true });
      }
      return;
    }

    const m = data.match(/^shop_(accept|reject|preparing|ready|delivered):(.+)$/);
    if (!m) return;
    const action  = m[1];
    const orderId = m[2];

    if (action === 'ready') {
      try {
        const db = getDb();
        const shop = await getShopByTelegramChat(q.message.chat.id);
        if (!shop) { await shopBot.answerCallbackQuery(q.id, { text: 'Сначала /start', show_alert: true }); return; }
        shopPendingPhoto.set(q.message.chat.id, orderId);
        await shopBot.answerCallbackQuery(q.id, { text: '📸 Отправьте фото готового букета' });
        await shopBot.sendMessage(q.message.chat.id,
          `📸 <b>Фото-отчёт по заказу #${orderId}</b>\n\nОтправьте фотографию готового букета — клиент получит её в Telegram.\n\n<i>Отмена: /cancel</i>`,
          { parse_mode: 'HTML' });
        return;
      } catch (e) { console.error('[shopBot ready prompt]', e.message); }
    }

    const newStatus = action === 'accept' ? 'seller_accepted'
                    : action === 'reject' ? 'rejected'
                    : action;
    const labels = {
      seller_accepted: '✅ Заказ принят — контакты клиента открыты',
      rejected: '❌ Заказ отклонён',
      preparing: '👨‍🍳 Готовим заказ',
      ready: '📦 Заказ готов',
      delivered: '🚚 Заказ доставлен'
    };

    try {
      const db = getDb();
      const shop = await getShopByTelegramChat(q.message.chat.id);
      if (!shop) { await shopBot.answerCallbackQuery(q.id, { text: 'Сначала авторизуйтесь через /start', show_alert: true }); return; }

      const { data: order } = await db.from('orders').select('status, items, customer_phone, customer_address').eq('id', orderId).single();
      if (!order) { await shopBot.answerCallbackQuery(q.id, { text: 'Заказ не найден', show_alert: true }); return; }

      let items = [];
      if (typeof order.items === 'string') { try { items = JSON.parse(order.items); } catch(_){} }
      else if (Array.isArray(order.items)) items = order.items;

      const shopDigits = phoneDigits(shop.phone);
      const orderHasShopItem = items.some(it => phoneDigits(it.seller_phone) === shopDigits);
      if (!orderHasShopItem) { await shopBot.answerCallbackQuery(q.id, { text: 'Этот заказ не для вашего магазина', show_alert: true }); return; }
      if (order.status === 'pending') { await shopBot.answerCallbackQuery(q.id, { text: 'Заказ ещё не подтверждён админом', show_alert: true }); return; }
      if (['accept', 'reject'].includes(action) && !SHOP_TIMEOUT_WAIT_STATUSES.includes(order.status)) {
        await shopBot.answerCallbackQuery(q.id, { text: 'Заказ уже обработан', show_alert: true });
        return;
      }

      const updateFields = { status: newStatus };
      if (newStatus === 'delivered') updateFields.delivered_at = new Date().toISOString();
      const { data: updated, error } = await db
        .from('orders')
        .update(updateFields)
        .eq('id', orderId)
        .eq('status', order.status)
        .select()
        .single();
      if (error) throw error;
      if (!updated) {
        await shopBot.answerCallbackQuery(q.id, { text: 'Статус уже обновлён', show_alert: true });
        return;
      }

      if (['seller_accepted', 'rejected'].includes(newStatus)) {
        clearShopTimer(orderId);
        shopNotifiedOrders.delete(String(orderId));
      }

      if (!updated.customer_chat_id) {
        const resolved = await resolveChatId({
          phone: updated.customer_phone,
          username: updated.customer_telegram,
        });
        if (resolved) {
          await db.from('orders').update({ customer_chat_id: resolved }).eq('id', orderId);
          updated.customer_chat_id = resolved;
          console.log('[shopBot] Restored customer_chat_id:', resolved, 'order:', orderId);
        }
      }

      await shopBot.answerCallbackQuery(q.id, { text: labels[newStatus] || 'OK' });

      let reply = `<b>${labels[newStatus] || newStatus}</b>\nЗаказ #${orderId}\n`;
      if (newStatus === 'seller_accepted') {
        reply += `\n📞 Клиент: <b>${escHtml(phoneDisplay(updated.customer_phone))}</b>\n🏠 Адрес: ${updated.customer_address}`;
      }
      const nextKb = [];
      if (newStatus === 'seller_accepted') nextKb.push([{ text: '👨‍🍳 Готовим', callback_data: `shop_preparing:${orderId}` }]);
      if (newStatus === 'preparing')       nextKb.push([{ text: '📦 Готов (отправить фото)', callback_data: `shop_ready:${orderId}` }]);
      if (newStatus === 'ready')           nextKb.push([{ text: '🚚 Доставлен', callback_data: `shop_delivered:${orderId}` }]);

      await shopBot.sendMessage(q.message.chat.id, reply, {
        parse_mode: 'HTML',
        reply_markup: nextKb.length ? { inline_keyboard: nextKb } : undefined
      });

      try { await notifyCustomerStatusChanged(updated, shop); } catch (e) { console.log('customer notify err:', e.message); }
      try { await notifyAdminAboutShopOrder(updated, shop); }    catch (e) { console.log('admin notify err:', e.message); }
    } catch (e) {
      console.error('[shopBot callback]', e.message);
      try { await shopBot.answerCallbackQuery(q.id, { text: 'Ошибка: ' + e.message, show_alert: true }); } catch(_){}
    }
  });

  shopBot.on('polling_error', (err) => {
    if (!err.message?.includes('409')) console.log('SHOP BOT error:', err.message);
  });

  shopBot.getMe().then(me => {
    console.log('🏪 SHOP BOT запущен | @' + (me.username || '?'));
  }).catch(() => console.log('🏪 SHOP BOT запущен'));
}

// ─────────────────────────────────────────────
// ✅ Уведомление клиенту: оплата подтверждена
// ─────────────────────────────────────────────
async function resolveCustomerChatId(order) {
  if (!order) return null;

  const resolved = await resolveChatId({
    phone: order.customer_phone,
    username: order.customer_telegram,
    chatId: order.customer_chat_id
  });
  if (!resolved) {
    const stored = order.customer_chat_id != null && order.customer_chat_id !== ''
      ? Number(order.customer_chat_id) : null;
    if (stored && !Number.isNaN(stored)) return stored;
    return null;
  }

  const cid = Number(resolved);
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    await db.from('orders').update({ customer_chat_id: cid }).eq('id', order.id);
    console.log('[resolveCustomerChatId] Patched customer_chat_id for order', order.id, '->', cid);
  } catch (e) {
    console.error('[resolveCustomerChatId] DB patch failed:', e.message);
  }

  return cid;
}

function buildCustomerBotLink(orderId) {
  const botUser = getBotUsername();
  return `https://t.me/${botUser}?start=order_${orderId}`;
}

async function notifyCustomerPaymentConfirmed(order) {
  return sendCustomerPaymentNotification(order);
}

async function notifyCustomerPaymentRejected(order) {
  if (!userBot && !ensureUserBot()) return;
  if (!order) return;
  if (!canSendNotification(order.id, 'customer_payment_rejected')) return;

  const chatId = await resolveCustomerChatId(order);
  if (!chatId) {
    console.log('[notifyCustomerPaymentRejected] no chat_id for order', order.id);
    return;
  }

  const text =
    `❌ <b>Оплата отклонена</b>\n\n` +
    `К сожалению, ваш заказ <b>#${order.id}</b> был отклонён.\n` +
    `Для уточнения причин свяжитесь: @rebuket_admin`;

  try {
    await userBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    markNotificationSent(order.id, 'customer_payment_rejected');
    console.log('[notifyCustomerPaymentRejected] Sent to:', chatId);
  } catch (e) {
    console.log('[notifyCustomerPaymentRejected]', e.message);
  }
}

// ─────────────────────────────────────────────
// 📲 Уведомления клиенту о смене статуса заказа
// ─────────────────────────────────────────────
async function notifyCustomerOrderReady(order, shop, photoSource, photoUrlHint) {
  if (!order?.id) return { ok: false, reason: 'no_order' };
  const isFreshPhoto = Buffer.isBuffer(photoSource);
  const dedupKey = isFreshPhoto ? null : (photoSource ? 'customer_ready_photo' : 'customer_status_ready');
  if (dedupKey && !canSendNotification(order.id, dedupKey)) {
    return { ok: false, reason: 'dedup' };
  }

  const chatId = await resolveCustomerChatId(order);
  if (!chatId) {
    console.log('[notifyCustomerOrderReady] no chat_id for order', order.id,
      'phone:', order.customer_phone, 'tg:', order.customer_telegram);
    return { ok: false, reason: 'no_chat_id' };
  }
  order.customer_chat_id = chatId;

  const shopName = escHtml(shop?.shop_name || 'Магазин');
  const text =
    `📸 <b>Ваш букет готов!</b>\n\n` +
    `<b>${shopName}</b> отправил фото готового заказа. Скоро в пути! 🚚\n\n` +
    `📦 Заказ #${order.id}\n\n` +
    `👇 <b>Оцените фото букета:</b>`;

  const keyboard = {
    inline_keyboard: [[
      { text: '👍 Отлично', callback_data: `photo_like:${order.id}` },
      { text: '👎 Не устраивает', callback_data: `photo_dislike:${order.id}` }
    ]]
  };

  const urlFallback = photoUrlHint || order.delivery_photo_url;
  let photoSent = false;
  let lastError = null;

  if (Buffer.isBuffer(photoSource) && photoSource.length > 0) {
    const r = await sendPhotoToCustomer(chatId, photoSource, { caption: text, parse_mode: 'HTML', reply_markup: keyboard });
    photoSent = r.ok;
    lastError = r.error;
  }
  if (!photoSent && urlFallback) {
    const r = await sendPhotoToCustomer(chatId, urlFallback, { caption: text, parse_mode: 'HTML', reply_markup: keyboard });
    photoSent = r.ok;
    lastError = r.error;
  }
  if (!photoSent) {
    const linkLine = urlFallback
      ? `\n\n🔗 <a href="${urlFallback}">Открыть фото букета</a>`
      : '';
    const r = await trySendToCustomer(chatId, text + linkLine + '\n\n<i>Если фото не открылось — @rebuket_admin</i>');
    if (r.ok) {
      if (dedupKey) markNotificationSent(order.id, dedupKey);
      return { ok: true, textOnly: true };
    }
    lastError = r.error || lastError;
    const needsStart = r.reason === 'needs_start' || /403|blocked|initiate|chat not found/i.test(String(lastError || ''));
    return { ok: false, reason: needsStart ? 'needs_start' : 'send_failed', error: lastError };
  }

  if (dedupKey) markNotificationSent(order.id, dedupKey);
  return { ok: true };
}

async function notifyCustomerStatusChanged(order, shop) {
  if (!userBot && !ensureUserBot()) return;
  if (!order) return;

  if (order.status === 'ready') {
    await notifyCustomerOrderReady(order, shop, order.delivery_photo_url);
    return;
  }

  const dedupType = 'customer_status_' + order.status;
  if (!canSendNotification(order.id, dedupType)) return;

  const chatId = await resolveCustomerChatId(order);
  if (!chatId) {
    console.log('[notifyCustomerStatusChanged] no chat_id for order', order.id,
      'phone:', order.customer_phone, 'tg:', order.customer_telegram);
    return;
  }
  order.customer_chat_id = chatId;

  const shopName = shop?.shop_name || 'Магазин';
  const orderId  = order.id;
  let sent = false;

  // Статические статусы
  const statusCards = {
    seller_accepted: {
      emoji: '🎉',
      title: 'Магазин принял ваш заказ!',
      body: `<b>${shopName}</b> начнёт собирать ваш букет.\n\nМы сообщим, когда заказ будет готов.`
    },
    preparing: {
      emoji: '👨‍🍳',
      title: 'Ваш заказ собирают!',
      body: `<b>${shopName}</b> уже работает над вашим букетом. 🌸`
    },
    rejected: {
      emoji: '😔',
      title: 'К сожалению, заказ отклонён',
      body: `<b>${shopName}</b> не смог принять ваш заказ.\nДеньги будут возвращены — свяжитесь с @rebuket_admin.`
    }
  };

  const card = statusCards[order.status];
  if (card) {
    const text = `${card.emoji} <b>${card.title}</b>\n\n${card.body}\n\n📦 Заказ #${orderId}\n💰 ${(Number(order.total)||0).toLocaleString('ru')} сом`;
    try {
      await userBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      sent = true;
    } catch (e) { console.log('[notifyCustomerStatusChanged]', order.status, e.message); }
  } else if (order.status === 'delivered') {
    const text = `🚚 <b>Ваш заказ доставлен!</b>\n\nПожалуйста, подтвердите получение в течение <b>5 часов</b>. Если не подтвердите — заказ будет автоматически завершён.\n\n📦 Заказ #${orderId}\n💐 ${shopName}`;
    try {
      const opts = {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Получил заказ', callback_data: `cust_confirm:${orderId}` },
            { text: '⚠️ Есть проблема', callback_data: `cust_problem:${orderId}` }
          ]]
        }
      };
      if (order.delivery_photo_url) {
        const pr = await sendPhotoToCustomer(chatId, order.delivery_photo_url, { caption: text, ...opts });
        if (!pr.ok) await userBot.sendMessage(chatId, text, opts);
      } else {
        await userBot.sendMessage(chatId, text, opts);
      }
      sent = true;
    } catch (e) { console.log('[notifyCustomerStatusChanged delivered]', e.message); }
  } else if (order.status === 'refunded') {
    try {
      await userBot.sendMessage(chatId,
        `✅ <b>Возврат оформлен</b>\n\nЗаказ #${orderId} — деньги будут возвращены. Свяжитесь с @rebuket_admin.`,
        { parse_mode: 'HTML' });
      sent = true;
    } catch (e) { console.log('[notifyCustomerStatusChanged refunded]', e.message); }
  }

  if (sent) markNotificationSent(order.id, dedupType);
}

// ─────────────────────────────────────────────
// 👤 Обработчики действий покупателя
// ─────────────────────────────────────────────
function registerCustomerOrderHandlers() {
  if (!userBot || customerOrderHandlersRegistered) return;
  customerOrderHandlersRegistered = true;

  userBot.on('callback_query', async (q) => {
    const data = q.data || '';

    // Обработка лайк/дизлайк фото
    const photoMatch = data.match(/^photo_(like|dislike):(.+)$/);
    if (photoMatch) {
      const [, reaction, orderId] = photoMatch;
      const chatId = q.message?.chat?.id;
      if (!chatId) return;

      await userBot.answerCallbackQuery(q.id).catch(() => {});

      try {
        const { createSupabaseClient } = require('../db/supabase');
        const db = createSupabaseClient();
        const order = await ensureCustomerOwnsOrder(db, orderId, chatId);
        if (!order) {
          await userBot.sendMessage(chatId, '❌ Заказ не найден.').catch(() => {});
          return;
        }

        // Убираем кнопки
        if (q.message) {
          try {
            await userBot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: q.message.chat.id,
              message_id: q.message.message_id,
            });
          } catch (_) {}
        }

        if (reaction === 'like') {
          // Клиент доволен фото - продолжаем процесс
          await db.from('orders').update({ photo_approved: true, photo_approved_at: new Date().toISOString() }).eq('id', orderId);
          await userBot.sendMessage(chatId, `👍 <b>Отлично!</b>\n\nМагазин скоро доставит ваш заказ.\n\n📦 Заказ #${orderId}`, { parse_mode: 'HTML' });

          // Уведомляем магазин
          try {
            let items = order.items;
            if (typeof items === 'string') items = JSON.parse(items);
            const sellerPhones = [...new Set((items || []).map(it => it.seller_phone).filter(Boolean))];
            const shops = await findShopsBySellerPhones(sellerPhones);
            for (const s of shops) {
              if (s.telegram_chat_id) {
                await sendToShopChat(s.telegram_chat_id, `👍 Клиент одобрил фото заказа #${orderId}! Можно доставлять.`).catch(() => {});
              }
            }
          } catch (_) {}
        } else if (reaction === 'dislike') {
          // Клиент недоволен - запрашиваем причину
          customerPendingRefundReason.set('photo_feedback:' + chatId, orderId);
          await userBot.sendMessage(chatId,
            `👎 <b>Что не устраивает в фото?</b>\n\nОпишите проблему одним сообщением, и магазин переделает букет.\n\n📦 Заказ #${orderId}\n\n<i>Отмена: /cancel</i>`,
            { parse_mode: 'HTML' });
        }
      } catch (e) {
        console.error('[photo feedback callback]', e.message);
        try { await userBot.sendMessage(chatId, '❌ Ошибка: ' + e.message); } catch (_) {}
      }
      return;
    }

    const m = data.match(/^cust_(confirm|problem):(.+)$/);
    if (!m) return;

    const [, action, orderId] = m;
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    await userBot.answerCallbackQuery(q.id).catch(() => {});

    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const order = await ensureCustomerOwnsOrder(db, orderId, chatId);
      if (!order) {
        await userBot.sendMessage(chatId, '❌ Заказ не найден.').catch(() => {});
        return;
      }

      if (action === 'confirm') {
        const doneStatuses = ['confirmed_received', 'confirmed'];
        if (doneStatuses.includes(order.status)) {
          await userBot.sendMessage(chatId, '✅ Вы уже подтвердили получение этого заказа.').catch(() => {});
          return;
        }
        const canConfirm = ['delivered', 'ready'].includes(order.status);
        if (!canConfirm) {
          await userBot.sendMessage(chatId, 'ℹ️ Подтвердить получение можно после того, как магазин отметит заказ доставленным.').catch(() => {});
          return;
        }

        const result = await confirmOrderReceived(db, orderId);
        if (!result.ok) {
          console.error('[cust_confirm] failed for', orderId, 'from status', order.status);
          await userBot.sendMessage(chatId, '❌ Не удалось подтвердить заказ. Напишите @rebuket_admin.').catch(() => {});
          return;
        }
        const updated = result.order;
        await userBot.sendMessage(chatId, `🌟 <b>Спасибо за заказ!</b>\n\nНадеемся, букет вам понравился! Оставьте отзыв @rebuket_admin.`, { parse_mode: 'HTML' });

        if (q.message) {
          try {
            await userBot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: q.message.chat.id,
              message_id: q.message.message_id,
            });
          } catch (_) {}
        }

        try {
          let items = updated.items;
          if (typeof items === 'string') items = JSON.parse(items);
          const sellerPhones = [...new Set((items || []).map(it => it.seller_phone).filter(Boolean))];
          const shops = await findShopsBySellerPhones(sellerPhones);
          for (const s of shops) {
            if (s.telegram_chat_id) {
              await sendToShopChat(s.telegram_chat_id, `🌟 Клиент подтвердил получение заказа #${orderId}!`).catch(() => {});
            }
          }
        } catch (_) {}
      } else if (action === 'problem') {
        if (!['delivered', 'ready', 'confirmed_received', 'confirmed', 'refund_requested'].includes(order.status)) {
          await userBot.sendMessage(chatId, 'ℹ️ Сообщить о проблеме можно, когда заказ уже у курьера или доставлен.').catch(() => {});
          return;
        }
        customerPendingRefundReason.set(customerChatKey(chatId), orderId);
        await userBot.sendMessage(chatId,
          `⚠️ <b>Опишите проблему с заказом #${orderId}</b>\n\nНапишите одним сообщением — что не так?\n\n<i>Отмена: /cancel</i>`,
          { parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('[userBot order callback]', e.message);
      try { await userBot.sendMessage(chatId, '❌ Ошибка: ' + e.message); } catch (_) {}
    }
  });

  userBot.onText(/\/cancel/, async (msg) => {
    const key = customerChatKey(msg.chat.id);
    const photoKey = 'photo_feedback:' + msg.chat.id;
    if (customerPendingRefundReason.has(key)) {
      customerPendingRefundReason.delete(key);
      await userBot.sendMessage(msg.chat.id, '↩️ Запрос на возврат отменён.');
    } else if (customerPendingRefundReason.has(photoKey)) {
      customerPendingRefundReason.delete(photoKey);
      await userBot.sendMessage(msg.chat.id, '↩️ Отзыв о фото отменён.');
    }
  });

  userBot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const pendingKey = customerChatKey(chatId);
    const photoFeedbackKey = 'photo_feedback:' + chatId;

    // Проверяем, ждем ли мы фидбек по фото
    const photoOrderId = customerPendingRefundReason.get(photoFeedbackKey);
    if (photoOrderId) {
      try {
        const { createSupabaseClient } = require('../db/supabase');
        const db = createSupabaseClient();
        const order = await ensureCustomerOwnsOrder(db, photoOrderId, chatId);
        if (!order) {
          customerPendingRefundReason.delete(photoFeedbackKey);
          await userBot.sendMessage(chatId, '❌ Заказ не найден.');
          return;
        }
        const feedback = msg.text.trim().slice(0, 1000);
        if (!feedback) {
          await userBot.sendMessage(chatId, 'ℹ️ Напишите текстом, что не устраивает в фото.');
          return;
        }

        // Сохраняем фидбек и отмечаем что фото не одобрено
        await db.from('orders').update({
          photo_approved: false,
          photo_feedback: feedback,
          photo_feedback_at: new Date().toISOString()
        }).eq('id', photoOrderId);

        customerPendingRefundReason.delete(photoFeedbackKey);

        await userBot.sendMessage(chatId,
          `✅ <b>Ваш отзыв отправлен магазину</b>\n\nМагазин переделает букет и отправит новое фото.\n\n📦 Заказ #${photoOrderId}\n📝 Ваш комментарий: ${escHtml(feedback)}`,
          { parse_mode: 'HTML' });

        // Уведомляем магазин о проблеме с фото
        try {
          let items = order.items;
          if (typeof items === 'string') items = JSON.parse(items);
          const sellerPhones = [...new Set((items || []).map(it => it.seller_phone).filter(Boolean))];
          const shops = await findShopsBySellerPhones(sellerPhones);
          const shopText =
            `👎 <b>Клиенту не понравилось фото букета</b>\n\n📦 Заказ #${photoOrderId}\n💰 ${(Number(order.total) || Number(order.total_amount) || 0).toLocaleString('ru')} сом\n\n📝 <b>Комментарий клиента:</b>\n${escHtml(feedback)}\n\n<i>Переделайте букет и отправьте новое фото через бот.</i>`;
          for (const s of shops) {
            if (s.telegram_chat_id) {
              await sendToShopChat(s.telegram_chat_id, shopText, { parse_mode: 'HTML' }).catch(() => {});
            }
          }
        } catch (e) {
          console.error('[photo feedback notify shop]', e.message);
        }
      } catch (e) {
        console.error('[photo feedback]', e.message);
        await userBot.sendMessage(chatId, '❌ Ошибка: ' + e.message);
      }
      return;
    }

    const orderId = customerPendingRefundReason.get(pendingKey);
    if (orderId) {
      try {
        const { createSupabaseClient } = require('../db/supabase');
        const db = createSupabaseClient();
        const order = await ensureCustomerOwnsOrder(db, orderId, chatId);
        if (!order) {
          customerPendingRefundReason.delete(pendingKey);
          await userBot.sendMessage(chatId, '❌ Заказ не найден.');
          return;
        }
        const reason = msg.text.trim().slice(0, 1000);
        if (!reason) {
          await userBot.sendMessage(chatId, 'ℹ️ Напишите текстом, что не так с заказом.');
          return;
        }

        const result = await submitRefundRequest(db, orderId, reason);
        if (!result.ok) {
          console.error('[refund] submit failed', orderId, result.error?.message);
          await userBot.sendMessage(chatId, '❌ Не удалось отправить обращение. Попробуйте снова или напишите @rebuket_admin.');
          return;
        }

        customerPendingRefundReason.delete(pendingKey);
        const updated = result.order;

        await userBot.sendMessage(chatId,
          `✅ <b>Запрос на возврат отправлен</b>\n\nМагазин рассмотрит обращение.\n\n📦 Заказ #${orderId}\n📝 Причина: ${escHtml(reason)}`,
          { parse_mode: 'HTML' });

        const shopRefundKb = result.usedStatus === 'refund_requested'
          ? {
              inline_keyboard: [[
                { text: '✅ Одобрить возврат', callback_data: `shop_refund_approve:${orderId}` },
                { text: '⚠️ Оспорить', callback_data: `shop_refund_dispute:${orderId}` }
              ]]
            }
          : undefined;

        try {
          let items = updated.items;
          if (typeof items === 'string') items = JSON.parse(items);
          const sellerPhones = [...new Set((items || []).map(it => it.seller_phone).filter(Boolean))];
          const shops = await findShopsBySellerPhones(sellerPhones);
          const shopText =
            `⚠️ <b>Запрос на возврат от клиента</b>\n\n📦 Заказ #${orderId}\n💰 ${(Number(updated.total) || Number(updated.total_amount) || 0).toLocaleString('ru')} сом\n\n📝 <b>Причина:</b>\n${escHtml(reason)}`;
          for (const s of shops) {
            if (s.telegram_chat_id) {
              await sendToShopChat(s.telegram_chat_id, shopText, {
                parse_mode: 'HTML',
                reply_markup: shopRefundKb,
              }).catch(() => {});
            }
          }
        } catch (e) { console.log('refund notify shop err:', e.message); }
        try {
          for (const adminChat of adminChatIds) {
            if (adminBot) {
              await adminBot.sendMessage(adminChat,
                `⚠️ <b>Возврат запрошен</b>\n\n📦 Заказ #${orderId}\n📝 ${escHtml(reason)}`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          }
        } catch (_) {}
      } catch (e) {
        console.error('[userBot refund reason]', e.message);
        await userBot.sendMessage(chatId, '❌ Ошибка. Напишите @rebuket_admin.').catch(() => {});
      }
      return;
    }

    await userBot.sendMessage(chatId,
      `Нажмите кнопку ниже чтобы открыть ReBuket 🌸`,
      { reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', url: getMiniAppUrl() }]] } }
    );
  });

  console.log('[userBot] Customer order handlers registered');
}

// ─────────────────────────────────────────────
// ⏱ Напоминание магазину (5 мин) и автоотклонение (10 мин)
// ─────────────────────────────────────────────
async function notifyCustomerShopTimeoutRejected(order) {
  if (!isShopTimerEligible(order)) return;
  if (!userBot && !ensureUserBot()) return;
  const dedupType = 'customer_shop_timeout_reject';
  if (!canSendOnce(order.id, dedupType)) return;

  const chatId = await resolveCustomerChatId(order);
  if (!chatId) {
    console.log('[notifyCustomerShopTimeoutRejected] no chat_id for order', order.id);
    return;
  }

  const mins = Math.round(SHOP_RESPONSE_TIMEOUT_MS / 60000);
  const text =
    `😔 <b>Заказ отменён</b>\n\n` +
    `Магазин не принял и не отклонил заказ в течение <b>${mins} мин.</b> после подтверждения оплаты.\n\n` +
    `📦 Заказ #${order.id}\n` +
    `💰 ${(Number(order.total) || 0).toLocaleString('ru')} сом\n\n` +
    `По возврату средств: @rebuket_admin`;

  try {
    await userBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    markSentOnce(order.id, dedupType);
  } catch (e) {
    console.log('[notifyCustomerShopTimeoutRejected]', e.message);
  }
}

async function notifyAdminShopTimeoutRejected(order) {
  if (!adminBot) return;
  if (!isShopTimerEligible(order)) return;
  if (!canSendOnce(order.id, 'admin_shop_timeout_reject')) return;
  const mins = Math.round(SHOP_RESPONSE_TIMEOUT_MS / 60000);
  const text =
    `⏱ <b>АВТООТКЛОНЕНИЕ ЗАКАЗА #${order.id}</b>\n\n` +
    `Магазин не ответил за ${mins} мин. (ожидание принятия/отклонения).\n` +
    `📞 ${escHtml(phoneDisplay(order.customer_phone))}\n` +
    `💰 ${(Number(order.total) || 0).toLocaleString('ru')} сом`;

  for (const chatId of adminChatIds) {
    try {
      await adminBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.log('[notifyAdminShopTimeoutRejected]', chatId, e.message);
    }
  }
  markSentOnce(order.id, 'admin_shop_timeout_reject');
}

async function notifyShopsShopReminder(order) {
  if (!getShopBotToken()) return;
  if (!isShopTimerEligible(order)) return;
  if (!canSendOnce(order.id, 'shop_reminder_all')) return;

  const { linked } = await resolveShopsForOrder(order);
  if (!linked.length) return;

  const leftMins = Math.max(1, Math.round((SHOP_REJECT_MS - SHOP_REMINDER_MS) / 60000));
  const text =
    `⏰ <b>Напоминание: заказ #${order.id}</b>\n\n` +
    `Вы ещё не ответили на заказ.\n` +
    `Через <b>${leftMins} мин.</b> он будет <b>отклонён автоматически</b>, если не нажмёте «Принять» или «Отклонить».`;

  const keyboard = shopOrderKeyboard(order.id);
  let any = false;

  for (const shop of linked) {
    try {
      await sendToShopChat(shop.telegram_chat_id, text, { parse_mode: 'HTML', reply_markup: keyboard });
      any = true;
      console.log('[notifyShopsShopReminder] order', order.id, 'shop', shop.phone);
    } catch (e) {
      console.log('[notifyShopsShopReminder]', shop.phone, e.message);
    }
  }
  if (any) {
    markOrderReminderSent(order.id);
    markSentOnce(order.id, 'shop_reminder_all');
  }
}

async function notifyAdminShopReminder(order) {
  if (!adminBot) return;
  if (!isShopTimerEligible(order)) return;
  if (!canSendOnce(order.id, 'admin_shop_reminder')) return;
  const text =
    `⏰ <b>Напоминание: заказ #${order.id}</b>\n\n` +
    `Магазин не ответил ${Math.round(SHOP_REMINDER_MS / 60000)} мин. после подтверждения оплаты.\n` +
    `📞 ${escHtml(phoneDisplay(order.customer_phone))}`;
  for (const chatId of adminChatIds) {
    try {
      await adminBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.log('[notifyAdminShopReminder]', chatId, e.message);
    }
  }
  markSentOnce(order.id, 'admin_shop_reminder');
}

async function notifyShopsShopTimeoutRejected(order) {
  if (!getShopBotToken()) return;
  if (!isShopTimerEligible(order)) return;
  if (!canSendOnce(order.id, 'shop_timeout_reject_all')) return;

  const { linked } = await resolveShopsForOrder(order);
  const mins = Math.round(SHOP_REJECT_MS / 60000);
  const text =
    `❌ <b>Заказ #${order.id} отклонён автоматически</b>\n\n` +
    `Вы не нажали «Принять» или «Отклонить» в течение <b>${mins} мин.</b>\n` +
    `Заказ снят с обработки.`;

  for (const shop of linked) {
    try {
      await sendToShopChat(shop.telegram_chat_id, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.log('[notifyShopsShopTimeoutRejected]', shop.phone, e.message);
    }
  }
  markSentOnce(order.id, 'shop_timeout_reject_all');
  clearShopTimer(order.id);
}

async function autoRejectShopOrder(db, order) {
  if (!isShopTimerEligible(order)) return null;
  if (!canSendOnce(order.id, 'auto_reject')) return null;
  const mins = Math.round(SHOP_REJECT_MS / 60000);
  const noteLine = `Автоотклонён: магазин не ответил за ${mins} мин.`;
  const { data: updated, error: upErr } = await db
    .from('orders')
    .update({
      status: 'rejected',
      notes: order.notes ? `${order.notes}\n${noteLine}` : noteLine,
    })
    .eq('id', order.id)
    .in('status', SHOP_TIMEOUT_WAIT_STATUSES)
    .select()
    .single();

  if (upErr) {
    console.log('[processShopOrderTimeouts] update error:', order.id, upErr.message);
    return null;
  }
  if (!updated) return null;
  markSentOnce(order.id, 'auto_reject');
  clearShopTimer(order.id);
  shopNotifiedOrders.delete(String(order.id));

  console.log('[processShopOrderTimeouts] Auto-rejected order', updated.id);
  try { await notifyCustomerShopTimeoutRejected(updated); } catch (e) {
    console.log('[processShopOrderTimeouts] customer notify:', e.message);
  }
  try { await notifyAdminShopTimeoutRejected(updated); } catch (e) {
    console.log('[processShopOrderTimeouts] admin notify:', e.message);
  }
  try { await notifyShopsShopTimeoutRejected(updated); } catch (e) {
    console.log('[processShopOrderTimeouts] shop notify:', e.message);
  }
  return updated;
}

async function processShopOrderTimeouts() {
  const db = createSupabaseClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let expiredByDeadline = [];
  const expiredRes = await db
    .from('orders')
    .select('*')
    .in('status', SHOP_TIMEOUT_WAIT_STATUSES)
    .not('shop_notify_at', 'is', null)
    .not('shop_response_deadline_at', 'is', null)
    .lte('shop_response_deadline_at', nowIso)
    .limit(40);

  if (expiredRes.error && /shop_notify_at|column/i.test(expiredRes.error.message || '')) {
    const legacy = await db
      .from('orders')
      .select('*')
      .in('status', SHOP_TIMEOUT_WAIT_STATUSES)
      .not('shop_response_deadline_at', 'is', null)
      .lte('shop_response_deadline_at', nowIso)
      .limit(40);
    expiredByDeadline = (legacy.data || []).filter(isShopTimerEligible);
    if (legacy.error && !/column/i.test(legacy.error.message || '')) {
      console.log('[processShopOrderTimeouts] deadline query:', legacy.error.message);
    }
  } else {
    if (expiredRes.error && !/column/i.test(expiredRes.error.message || '')) {
      console.log('[processShopOrderTimeouts] deadline query:', expiredRes.error.message);
    }
    expiredByDeadline = expiredRes.data || [];
  }

  const rejectedIds = new Set();
  for (const order of expiredByDeadline || []) {
    if (!isShopTimerEligible(order)) continue;
    const updated = await autoRejectShopOrder(db, order);
    if (updated) rejectedIds.add(order.id);
  }

  let orders = [];
  const ordersRes = await db
    .from('orders')
    .select('*')
    .in('status', SHOP_TIMEOUT_WAIT_STATUSES)
    .not('shop_notify_at', 'is', null)
    .limit(80);

  if (ordersRes.error && /shop_notify_at|column/i.test(ordersRes.error.message || '')) {
    console.log('[processShopOrderTimeouts] shop_notify_at column missing — run migrations/012_shop_notify_at.sql');
    return;
  }
  if (ordersRes.error) {
    console.log('[processShopOrderTimeouts] query error:', ordersRes.error.message);
    return;
  }
  orders = ordersRes.data || [];

  for (const order of orders || []) {
    if (rejectedIds.has(order.id)) continue;
    if (!isShopTimerEligible(order)) continue;

    let deadline = orderRejectDeadlineMs(order);
    if (!deadline) continue;

    if (now >= deadline) {
      await autoRejectShopOrder(db, order);
      continue;
    }

    const started = shopWaitStartedAt(order) || (deadline - SHOP_REJECT_MS);
    const needReminder = started && now - started >= SHOP_REMINDER_MS && !orderReminderAlreadySent(order.id);
    if (needReminder) {
      try { await notifyShopsShopReminder(order); } catch (e) {
        console.log('[processShopOrderTimeouts] shop reminder:', e.message);
      }
      if (isShopTimerEligible(order) && canSendOnce(order.id, 'admin_shop_reminder')) {
        try { await notifyAdminShopReminder(order); } catch (e) {
          console.log('[processShopOrderTimeouts] admin reminder:', e.message);
        }
      }
    }
  }
}

function startShopOrderTimeoutInterval() {
  const rejectMins = Math.round(SHOP_REJECT_MS / 60000);
  const remindMins = Math.round(SHOP_REMINDER_MS / 60000);
  processShopOrderTimeouts().catch(e => console.log('[shop-timeout] initial run:', e.message));
  setInterval(() => {
    processShopOrderTimeouts().catch(e => console.log('[shop-timeout]', e.message));
  }, SHOP_TIMEOUT_POLL_MS);
  console.log(`⏱ Shop order timer: reminder ${remindMins} min, auto-reject ${rejectMins} min (poll ${SHOP_TIMEOUT_POLL_MS / 1000}s)`);
}

// ─────────────────────────────────────────────
// ⏱ Авто-подтверждение получения через 5 часов
// ─────────────────────────────────────────────
function startAutoConfirmInterval() {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const cutoff = new Date(Date.now() - FIVE_HOURS_MS).toISOString();
      const { data: orders } = await db.from('orders')
        .select('id, customer_chat_id').eq('status', 'delivered').lt('delivered_at', cutoff).limit(50);
      for (const o of orders || []) {
        await db.from('orders').update({ status: 'confirmed_received', confirmed_at: new Date().toISOString() }).eq('id', o.id);
        if (o.customer_chat_id && userBot) {
          await userBot.sendMessage(o.customer_chat_id, `✅ Заказ #${o.id} автоматически подтверждён (прошло 5 часов). Спасибо за покупку!`).catch(_=>{});
        }
      }
    } catch (e) { console.log('[auto-confirm interval]', e.message); }
  }, 10 * 60 * 1000);
  console.log('⏱ Auto-confirm interval запущен (каждые 10 мин)');
}

// ─────────────────────────────────────────────
// ⏱ Авто-одобрение фото если клиент не реагирует
// ─────────────────────────────────────────────
function startAutoApprovePhotoInterval() {
  const AUTO_APPROVE_MS = 10 * 60 * 1000; // 10 минут
  setInterval(async () => {
    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const cutoff = new Date(Date.now() - AUTO_APPROVE_MS).toISOString();

      // Находим заказы где фото отправлено, но клиент не отреагировал (photo_approved = null)
      const { data: orders } = await db.from('orders')
        .select('id, customer_chat_id, delivery_photo_url')
        .eq('status', 'ready')
        .not('delivery_photo_url', 'is', null)
        .is('photo_approved', null)
        .or(`photo_sent_at.lt.${cutoff},and(photo_sent_at.is.null,updated_at.lt.${cutoff})`)
        .limit(50);

      for (const o of orders || []) {
        await db.from('orders').update({
          photo_approved: true,
          photo_approved_at: new Date().toISOString()
        }).eq('id', o.id);

        if (o.customer_chat_id && userBot) {
          await userBot.sendMessage(o.customer_chat_id,
            `✅ Фото букета автоматически одобрено (прошло 10 минут).\n\n📦 Заказ #${o.id}`,
            { parse_mode: 'HTML' }
          ).catch(_=>{});
        }

        console.log(`[auto-approve-photo] Order #${o.id} photo auto-approved`);
      }
    } catch (e) {
      console.log('[auto-approve-photo interval]', e.message);
    }
  }, 1 * 60 * 1000); // Проверяем каждую 1 минуту
  console.log('⏱ Auto-approve photo interval запущен (каждые 1 мин, таймаут 10 мин)');
}

// ─────────────────────────────────────────────
// 🔔 Дедупликация уведомлений
// ─────────────────────────────────────────────
// In-memory deduplication cache for notifications (orderId -> timestamp)
const notificationCache = new Map();
const NOTIFICATION_DEDUP_WINDOW = 5 * 60 * 1000; // 5 minutes

function canSendNotification(orderId, type) {
  const key = `${orderId}:${type}`;
  const lastSent = notificationCache.get(key);
  const now = Date.now();
  if (lastSent && (now - lastSent) < NOTIFICATION_DEDUP_WINDOW) {
    console.log(`[canSendNotification] Skipping duplicate ${type} for order ${orderId}`);
    return false;
  }
  return true;
}

function markNotificationSent(orderId, type) {
  const now = Date.now();
  notificationCache.set(`${orderId}:${type}`, now);
  for (const [k, v] of notificationCache) {
    if (now - v > NOTIFICATION_DEDUP_WINDOW) notificationCache.delete(k);
  }
}

/** @deprecated use canSendNotification + markNotificationSent */
function shouldSendNotification(orderId, type) {
  if (!canSendNotification(orderId, type)) return false;
  markNotificationSent(orderId, type);
  return true;
}

async function notifyCustomerRaw(chatId, html) {
  if (!userBot || !chatId || !html) return;
  try { await userBot.sendMessage(chatId, html, { parse_mode: 'HTML' }); }
  catch (e) { console.log('[notifyCustomerRaw]', e.message); }
}

async function notifyShopRaw(chatId, html) {
  if (!chatId || !html || !getShopBotToken()) return;
  try { await sendToShopChat(chatId, html, { parse_mode: 'HTML' }); }
  catch (e) { console.log('[notifyShopRaw]', e.message); }
}

async function notifyProductEdited(p, shopPhone) {
  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const Commission = require('./commission');
  const listed = Number(p.price) || 0;
  const pct = p.category === 'sweets' ? 10 : 25;
  const br = Commission.calculate(listed, pct, 'inclusive');

  const text =
    `✏️ <b>МАГАЗИН ИЗМЕНИЛ ПУБЛИКАЦИЮ</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n\n` +
    `🏬 <b>Магазин:</b> ${escHtml(p.seller_name || shopPhone || '—')}\n` +
    `📞 <b>Телефон:</b> ${escHtml(p.seller_phone || shopPhone)}\n` +
    `📍 <b>Город:</b> ${escHtml(p.city || '—')}\n\n` +
    `💰 <b>Цена для покупателя:</b> ${br.customer_pays.toLocaleString('ru')} TJS\n` +
    `💵 <b>Доля магазина:</b> ${br.seller_payout.toLocaleString('ru')} TJS\n\n` +
    (p.description ? `📝 ${escHtml(p.description.substring(0, 120))}${p.description.length > 120 ? '…' : ''}\n\n` : '') +
    `🔗 <a href="${url}">Открыть объявление</a>`;

  await sendToAdmins(text, { reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть объявление', url }]] } });
}

// ─────────────────────────────────────────────
// 📤 ЭКСПОРТ (включая новые утилиты)
// ─────────────────────────────────────────────
module.exports = {
  initBots,
  setupCallbacks,
  notifyProduct,
  notifyProductEdited,
  notifyInquiry,
  notifySellerApproved,
  notifySellerRejected,
  notifyBuyerInquirySent,
  notifyShopRegistration,
  notifyShopApproved,
  notifyShopRejected,
  markExpiredInChannel,
  notifyAdminAboutOrder,
  notifyAdminAboutShopOrder,
  notifySellerAboutOrder,
  setShopResponseTimer,
  notifyCustomerPaymentConfirmed,
  notifyCustomerPaymentRejected,
  notifyCustomerStatusChanged,
  notifyCustomerOnPaymentConfirmed,
  notifyCustomerRaw,
  notifyShopRaw,
  savePendingInquiry,
  getPendingInquiry,
  resolveChatId,
  findShopsBySellerPhones,
  registerCustomerFromTelegram,
  sendCustomerPaymentNotification,
  trySendToCustomer,
  savePhoneMapping,
  saveUsernameMapping,
  getChatIdByUsername,
  patchOrderChatId,
  phoneDigits,
}; 