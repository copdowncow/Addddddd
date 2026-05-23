'use strict';

const TG = require('node-telegram-bot-api');

let userBot  = null;
let adminBot = null;
let shopBot  = null;
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
    const normalizedPhone = phone.replace(/[^\d+]/g, '');
    const variants = [
      normalizedPhone,
      normalizedPhone.startsWith('+') ? normalizedPhone.replace(/^\+/, '') : '+' + normalizedPhone,
      normalizedPhone.startsWith('+') ? normalizedPhone : '+' + normalizedPhone
    ];
    const { data } = await db
      .from('telegram_users')
      .select('chat_id')
      .in('phone', variants)
      .limit(1)
      .maybeSingle();
    if (data?.chat_id) return data.chat_id;

    // 4. По телефону — из таблицы shops (если клиент сам магазин)
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
async function patchOrderChatId(orderId, chatId) {
  if (!orderId || !chatId) return;
  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    await db
      .from('orders')
      .update({ customer_chat_id: chatId })
      .eq('id', orderId)
      .is('customer_chat_id', null); // только если ещё не привязан
    console.log('[patchOrderChatId] Patched order', orderId, 'with chat_id', chatId);
  } catch (e) {
    console.error('[patchOrderChatId] Error:', e.message);
  }
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
  if (orderId) await patchOrderChatId(orderId, cid);
  return cid;
}

async function trySendToCustomer(chatId, text, options = {}) {
  if (!userBot && !ensureUserBot()) return { ok: false, reason: 'no_bot', error: 'userBot unavailable' };
  if (!chatId) return { ok: false, reason: 'no_chat_id' };
  try {
    await userBot.sendMessage(Number(chatId), text, { parse_mode: 'HTML', ...options });
    return { ok: true, chatId: Number(chatId) };
  } catch (e) {
    const err = e.message || String(e);
    const needsStart = /403|blocked|initiate|chat not found|user is deactivated|PEER_ID_INVALID/i.test(err);
    console.error('[trySendToCustomer] Failed:', chatId, err);
    return { ok: false, reason: needsStart ? 'needs_start' : 'send_failed', error: err, needsStart };
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

async function downloadBotFile(bot, fileId) {
  const fileLink = await bot.getFileLink(fileId);
  return downloadUrlBuffer(fileLink);
}

async function sendPhotoToCustomer(chatId, photoSource, options = {}) {
  if (!userBot && !ensureUserBot()) return false;
  if (!chatId || !photoSource) return false;
  const cid = Number(chatId);
  try {
    if (Buffer.isBuffer(photoSource)) {
      try {
        await userBot.sendPhoto(cid, photoSource, options, PHOTO_FILE_OPTS);
        return true;
      } catch (bufErr) {
        console.log('[sendPhotoToCustomer] sendPhoto buffer failed, try document:', bufErr.message);
        await userBot.sendDocument(cid, photoSource, options, PHOTO_FILE_OPTS);
        return true;
      }
    }
    const url = String(photoSource).trim();
    if (!url) return false;
    try {
      await userBot.sendPhoto(cid, url, options);
      return true;
    } catch (urlErr) {
      console.log('[sendPhotoToCustomer] URL send failed, retry buffer:', urlErr.message);
      const buf = await downloadUrlBuffer(url);
      await userBot.sendPhoto(cid, buf, options, PHOTO_FILE_OPTS);
      return true;
    }
  } catch (e) {
    console.error('[sendPhotoToCustomer] Failed:', cid, e.message);
    return false;
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
    `📞 Телефон: ${escHtml(order.customer_phone || '—')}\n\n` +
    `📱 Telegram: ${escHtml(tg)}\n` +
    `💰 Сумма: ${(Number(order.total) || 0).toLocaleString('ru')} сом\n\n` +
    `❌ <b>Проблема:</b> ${escHtml(why)}\n\n` +
    `📋 <b>Что делать:</b>\n` +
    `1. Позвоните клиенту: ${escHtml(order.customer_phone || '—')}\n` +
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

function phoneDigits(phone) {
  let d = (phone || '').toString().replace(/\D/g, '');
  if (!d) return '';
  // KG: 0555123456 / 555123456 → 996555123456
  if (d.length === 9 && !d.startsWith('996')) d = '996' + d;
  if (d.length === 10 && d.startsWith('0')) d = '996' + d.slice(1);
  // Сравниваем по последним 9 цифрам (номер без кода страны)
  if (d.length > 9) d = d.slice(-9);
  return d;
}

function phoneVariants(phone) {
  const raw = (phone || '').toString().trim();
  const d = (phone || '').toString().replace(/\D/g, '');
  const set = new Set([raw, d, phoneDigits(phone)].filter(Boolean));
  if (d) {
    set.add('+' + d);
    if (!d.startsWith('996') && d.length >= 9) set.add('+996' + d.slice(-9));
    if (d.startsWith('996')) set.add('+' + d);
  }
  return [...set];
}

function getShopBotUsername() {
  return (process.env.SHOP_BOT_USERNAME || process.env.BOT_USERNAME_SHOP || 'ReBuket_Shop_bot').replace(/^@/, '').trim();
}

async function findShopsBySellerPhones(sellerPhones) {
  const wanted = new Set();
  for (const p of sellerPhones) {
    for (const v of phoneVariants(p)) wanted.add(phoneDigits(v));
    wanted.delete('');
  }
  if (!wanted.size) return [];

  const { createSupabaseClient } = require('../db/supabase');
  const db = createSupabaseClient();
  const { data: shops } = await db
    .from('shops')
    .select('phone, shop_name, telegram_chat_id, status')
    .eq('status', 'active');

  const matched = (shops || []).filter(s => wanted.has(phoneDigits(s.phone)));
  if (!matched.length) {
    console.log('[findShopsBySellerPhones] no match for:', sellerPhones.join(', '),
      'wanted digits:', [...wanted].join(', '));
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
      text += `• ${escHtml(s.shop_name || s.phone)} — 📞 ${escHtml(s.phone)}\n`;
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
  const itemsList = (items || [])
    .map(i => `• ${i.title || i.name || 'Товар'} — ${(Number(i.price)||0).toLocaleString('ru')} сом.`)
    .join('\n');
  const deliveryLabel = order.delivery_type === 'pickup' ? '🏪 Самовывоз' : '🚕 Такси';
  const adminUrl = `${getMiniAppUrl()}/#admin`;

  let message = `🛒 <b>НОВЫЙ ЗАКАЗ #${order.id}</b>\n\n`;
  if (order.customer_name) message += `👤 Имя: ${order.customer_name}\n`;
  message += `📞 Телефон: ${order.customer_phone}\n`;
  message += `📍 Адрес: ${order.customer_address}\n`;
  message += `🚚 Доставка: ${deliveryLabel}\n`;
  message += `💰 Сумма: ${(order.total||0).toLocaleString('ru')} сом.\n\n`;
  if (order.fast_order) message += `⚡ <b>СРОЧНЫЙ ЗАКАЗ</b>\n`;
  if (order.delivery_time) message += `⏰ Желаемое время: ${order.delivery_time}\n`;
  if (order.fast_order || order.delivery_time) message += `\n`;
  message += `<b>Товары:</b>\n${itemsList}\n`;
  if (order.receiver_name) {
    message += `\n👤 <b>Получит другой человек:</b>\n`;
    message += `Имя: ${order.receiver_name}\n`;
    message += `Телефон: ${order.receiver_phone}\n`;
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
        `📞 ${updatedOrder.customer_phone}\n` +
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
async function notifySellerAboutOrder(order) {
  if (!order) return;

  if (!shopBot && !ensureShopBot()) {
    console.error('[notifySellerAboutOrder] shopBot not available — задайте BOT_TOKEN_SHOP');
    await notifyAdminShopsNotLinked(order, { noBot: [true] });
    return;
  }
  const bot = shopBot;

  let items = [];
  if (typeof order.items === 'string') { try { items = JSON.parse(order.items); } catch (e) { items = []; } }
  else if (Array.isArray(order.items)) items = order.items;

  const sellerPhones = [...new Set(items.map(it => (it.seller_phone || '').toString().trim()).filter(Boolean))];
  if (!sellerPhones.length) {
    console.log('[notifySellerAboutOrder] No seller phones in order items');
    return;
  }

  const shops = await findShopsBySellerPhones(sellerPhones);
  if (!shops.length) {
    console.log('[notifySellerAboutOrder] No active shops for phones:', sellerPhones.join(', '));
    await notifyAdminShopsNotLinked(order, { noChatId: sellerPhones.map(p => ({ phone: p, shop_name: '—' })) });
    return;
  }

  const itemsList = items.map(it => `• ${it.title || 'Товар'} ×${it.qty || 1}`).join('\n');
  const total = (Number(order.total) || 0).toLocaleString('ru');

  let message =
    `🛒 <b>Новый заказ для вашего магазина!</b>\n\n` +
    `📦 <b>Товары:</b>\n${itemsList}\n\n` +
    `💰 <b>Сумма:</b> ${total} сом\n` +
    `🚚 <b>Доставка:</b> ${order.delivery_type || '—'}\n`;
  if (order.fast_order) message += `⚡ <b>СРОЧНЫЙ ЗАКАЗ</b>\n`;
  if (order.delivery_time) message += `⏰ Желаемое время: ${order.delivery_time}\n`;
  message += `\n⏳ Контакты клиента откроются после того, как вы примете заказ.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Принять заказ', callback_data: `shop_accept:${order.id}` },
      { text: '❌ Отклонить',     callback_data: `shop_reject:${order.id}` },
    ]]
  };

  const noChatId = [];
  let sent = 0;

  for (const shop of shops) {
    if (!shop.telegram_chat_id) {
      console.log('[notifySellerAboutOrder] Shop has no telegram_chat_id:', shop.phone);
      noChatId.push(shop);
      continue;
    }
    const shopNotifyKey = `seller_order:${phoneDigits(shop.phone)}`;
    if (!canSendNotification(order.id, shopNotifyKey)) continue;
    try {
      await bot.sendMessage(shop.telegram_chat_id, message, { parse_mode: 'HTML', reply_markup: keyboard });
      console.log('[notifySellerAboutOrder] Notified shop:', shop.phone, 'chat:', shop.telegram_chat_id);
      sent++;
      markNotificationSent(order.id, shopNotifyKey);
    } catch (e) {
      console.error('[notifySellerAboutOrder] Error:', shop.phone, e.message);
      noChatId.push(shop);
    }
  }
  if (noChatId.length) await notifyAdminShopsNotLinked(order, { noChatId });
  if (!sent) console.error('[notifySellerAboutOrder] No shop received order', order.id);
}

async function notifyAdminAboutShopOrder(order, shop) {
  if (!adminBot) return;
  const action = ['seller_accepted', 'confirmed'].includes(order.status)
    ? '✅ ПРИНЯЛ ЗАКАЗ'
    : (order.status === 'rejected' ? '❌ ОТКАЗАЛ В ЗАКАЗЕ' : `🔄 ${order.status.toUpperCase()}`);
  const shopName = shop.shop_name || shop.phone;

  let message = `🏪 <b>РЕШЕНИЕ МАГАЗИНА</b>\n\n`;
  message += `<b>Имя магазина:</b> ${shopName}\n`;
  message += `<b>Номер:</b> ${shop.phone}\n`;
  message += `<b>Действие:</b> ${action}\n\n`;
  message += `<b>Заказчик:</b> ${order.customer_phone}\n`;
  if (order.receiver_name) message += `<b>Получатель:</b> ${order.receiver_name} (${order.receiver_phone})\n`;
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
  initShopBot();
  startAutoConfirmInterval();
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
        if (['payment_confirmed', 'seller_accepted', 'preparing', 'ready', 'delivered'].includes(order.status)) {
          const fresh = { ...order, customer_chat_id: chatId };
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
  const isShop = p.listing_type === 'shop';
  const COMMISSION = p.category === 'sweets' ? 0.10 : 0.20;
  const sellerRaw  = Number(p.price) || 0;
  const buyerPrice = p.is_admin_price
    ? sellerRaw
    : Math.ceil(sellerRaw * (1 + COMMISSION) / 10) * 10;
  const admin  = process.env.ADMIN_TELEGRAM
    ? process.env.ADMIN_TELEGRAM.replace('https://t.me/', '@')
    : '@rebuket_admin';
  const url    = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const photos = Array.isArray(p.photos) ? p.photos.filter(Boolean).map(ph => ph.split('?')[0]) : [];

  const serialNum = await getNextSerial(isKhujand ? 'khujand' : 'dushanbe');
  const code      = getProductCode(serialNum, isKhujand ? 'AK' : 'AB');

  let caption;
  if (isShop) {
    caption =
      `🏪 <b>${escHtml(p.seller_name || 'Магазин')}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${em} <b>${escHtml(p.title)}</b>\n` +
      `📍 ${escHtml(p.city || '—')}\n` +
      (p.size ? `📏 <b>Размер: ${escHtml(p.size)}</b>\n` : '') +
      `\n💰 <b>${buyerPrice.toLocaleString('ru-RU')} сомони</b>\n` +
      (code ? `🆔 ${code}\n` : '') +
      `\n📲 Заказать: ${admin}\n` +
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
  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const isShop = p.listing_type === 'shop';
  const COMMISSION = p.category === 'sweets' ? 0.10 : 0.20;
  const sellerPrice = Number(p.price) || 0;
  const buyerPrice  = Math.ceil((sellerPrice * (1 + COMMISSION)) / 10) * 10;

  let text;
  if (isShop) {
    text =
      `🏪 <b>НОВАЯ ПУБЛИКАЦИЯ ОТ МАГАЗИНА</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n\n` +
      `🏬 <b>Магазин:</b> ${escHtml(p.seller_name || '—')}\n` +
      `📞 <b>Телефон:</b> ${escHtml(p.seller_phone)}\n` +
      (p.seller_telegram ? `✈️ <b>Telegram:</b> ${escHtml(p.seller_telegram)}\n` : '') +
      `📍 <b>Город:</b> ${escHtml(p.city || '—')}\n\n` +
      `💵 <b>Цена продавца:</b> ${sellerPrice.toLocaleString('ru')} TJS\n` +
      `💰 <b>Цена для покупателя:</b> ${buyerPrice.toLocaleString('ru')} TJS\n` +
      `📊 <b>Комиссия (${Math.round(COMMISSION * 100)}%):</b> ${(buyerPrice - sellerPrice).toLocaleString('ru')} TJS\n\n` +
      `🔗 <a href="${url}">Открыть объявление</a>`;
  } else {
    text =
      `📦 <b>Новое объявление на проверке</b>\n─────────────────\n` +
      `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n` +
      `💰 ${sellerPrice.toLocaleString('ru')} TJS · 📍 ${escHtml(p.city || '—')}\n` +
      `👤 ${escHtml(p.seller_name || '—')} · 📞 ${escHtml(p.seller_phone)}\n` +
      (p.seller_telegram ? `✈️ ${escHtml(p.seller_telegram)}\n` : '') +
      `🔗 <a href="${url}">Открыть объявление</a>`;
  }

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
  await sendToAdmins(
    `🛒 <b>Новая заявка!</b>\n─────────────────\n` +
    `📦 ${escHtml(productTitle || '—')}\n` +
    `👤 ${escHtml(inq.customer_name || '—')}\n` +
    `📞 <b>${escHtml(inq.customer_phone)}</b>\n` +
    `✈️ ${escHtml(inq.customer_telegram || '—')}\n` +
    `📝 ${escHtml(inq.note || '—')}` +
    (url ? `\n🔗 <a href="${url}">Открыть объявление</a>` : ''),
    url ? { reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть объявление', url }]] } } : {}
  );
}

async function notifyShopRegistration(shop) {
  await sendToAdmins(
    `🏪 <b>Новая заявка на регистрацию магазина!</b>\n─────────────────\n` +
    `👤 Название: <b>${escHtml(shop.shop_name || '—')}</b>\n` +
    `📞 Телефон: <b>${escHtml(shop.phone)}</b>\n` +
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
  if (!userBot || !shop.telegram_chat_id) return;
  try {
    await userBot.sendMessage(shop.telegram_chat_id,
      `✅ <b>Ваш магазин одобрен!</b>\n\nТеперь вы можете войти как магазин и размещать объявления.\n\n📞 Телефон для входа: ${escHtml(shop.phone)}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏪 Открыть ReBuket', url: getMiniAppUrl() }]] } }
    );
  } catch(e) { console.log('notifyShopApproved error:', e.message); }
}

async function notifyShopRejected(shop) {
  if (!userBot || !shop.telegram_chat_id) return;
  try {
    await userBot.sendMessage(shop.telegram_chat_id,
      `❌ <b>Заявка на регистрацию магазина отклонена</b>\n\nСвяжитесь с администратором для уточнения причин.`,
      { parse_mode: 'HTML' }
    );
  } catch(e) { console.log('notifyShopRejected error:', e.message); }
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
      '📦 ' + (d.productTitle || '—'),
      '📞 Мой телефон: ' + d.customer_phone
    ];
    if (d.customer_name)     parts.push('👤 Имя: '          + d.customer_name);
    if (d.customer_telegram) parts.push('✈️ Telegram: '     + d.customer_telegram);
    if (d.note)              parts.push('📝 Комментарий: '  + d.note);
    parts.push('', '🔗 ' + url);
    const readyText = parts.join('\n');
    const tgLink = 'https://t.me/' + adminHandle + '?text=' + encodeURIComponent(readyText);
    const text =
      '✅ <b>Ваша заявка принята!</b>\n\n' +
      '📦 ' + escHtml(d.productTitle || '—') + '\n' +
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
  const token = process.env.BOT_TOKEN_SHOP;
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
      await getDb().from('shops').update({ telegram_chat_id: null }).eq('telegram_chat_id', chatId);
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
        await handlePasswordInput(chatId, password, state.phone);
      }
      return;
    }

    await shopBot.sendMessage(chatId, 'Используйте команды: /start /logout /cancel');
  });

  async function handlePhoneInput(chatId, rawPhone) {
    try {
      const variants = [rawPhone, rawPhone.replace(/^\+/, ''), '+' + rawPhone.replace(/^\+/, '')];
      const { data: shops } = await getDb().from('shops').select('phone, shop_name, status').in('phone', variants);
      const shop = (shops || [])[0];
      if (!shop) {
        await shopBot.sendMessage(chatId, `❌ Магазин с номером <b>${rawPhone}</b> не найден.`, { parse_mode: 'HTML' });
        return;
      }
      if (shop.status !== 'active') {
        await shopBot.sendMessage(chatId, `⚠️ Магазин найден, но статус: <b>${shop.status}</b>. Дождитесь одобрения.`, { parse_mode: 'HTML' });
        shopAuthState.delete(chatId);
        return;
      }
      shopAuthState.set(chatId, { step: 'password', phone: shop.phone });
      await shopBot.sendMessage(chatId,
        `✅ Магазин найден: <b>${shop.shop_name || shop.phone}</b>\n\n🔒 Шаг 2/2: отправьте <b>пароль</b>.\n\n<i>Сообщение с паролем будет удалено автоматически.</i>`,
        { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
      );
    } catch (e) {
      console.error('[shopBot handlePhoneInput]', e.message);
      await shopBot.sendMessage(chatId, '❌ Ошибка. Попробуйте /start снова.');
    }
  }

  async function handlePasswordInput(chatId, password, phone) {
    try {
      const db = getDb();
      const { data: shop } = await db.from('shops').select('phone, shop_name, password_hash, status').eq('phone', phone).single();
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
      await db.from('shops').update({ telegram_chat_id: chatId }).eq('phone', shop.phone);
      shopAuthState.delete(chatId);
      await shopBot.sendMessage(chatId,
        `✅ <b>${shop.shop_name || 'Магазин'}</b> успешно подключён!\n\nВы будете получать только свои заказы.\n\n📞 Телефон: ${shop.phone}\n• /logout — выйти`,
        { parse_mode: 'HTML' }
      );
      console.log('[shopBot] Authorized:', shop.phone, '→ chat_id:', chatId);
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
      const photo = msg.photo[msg.photo.length - 1];
      const buffer = await downloadBotFile(shopBot, photo.file_id);
      const { uploadPhoto } = require('../db/supabase');
      const photoUrl = await uploadPhoto(buffer, `delivery-${orderId}-${Date.now()}.jpg`, 'image/jpeg');
      const db = getDb();
      const { data: updated } = await db.from('orders')
        .update({ status: 'ready', delivery_photo_url: photoUrl })
        .eq('id', orderId)
        .select()
        .single();
      const { data: shop } = await db.from('shops').select('phone, shop_name').eq('telegram_chat_id', chatId).single();

      let photoDelivered = false;
      if (updated) {
        try {
          photoDelivered = await notifyCustomerOrderReady(updated, shop, buffer);
        } catch (e) {
          console.log('[shopBot photo] notify customer:', e.message);
        }
      }

      await shopBot.sendMessage(chatId,
        photoDelivered
          ? `✅ Фото отправлено клиенту. Заказ #${orderId} помечен как «📦 Готов».`
          : `⚠️ Заказ #${orderId} помечен «Готов», но клиенту фото не доставлено (нет Telegram / ошибка отправки).`,
        {
          reply_markup: { inline_keyboard: [[{ text: '🚚 Доставлен', callback_data: `shop_delivered:${orderId}` }]] }
        }
      );
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
        const { data: shop } = await db.from('shops').select('phone, shop_name').eq('telegram_chat_id', q.message.chat.id).single();
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
                : `⚠️ <b>Магазин оспорил возврат</b>\n\nЗаказ #${orderId}. Администратор рассмотрит ваш случай.`,
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
        const { data: shop } = await db.from('shops').select('phone').eq('telegram_chat_id', q.message.chat.id).single();
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
      const { data: shop } = await db.from('shops').select('phone, shop_name').eq('telegram_chat_id', q.message.chat.id).single();
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
        reply += `\n📞 Клиент: <b>${updated.customer_phone}</b>\n🏠 Адрес: ${updated.customer_address}`;
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
  if (order.customer_chat_id) return order.customer_chat_id;

  const resolved = await resolveChatId({
    phone: order.customer_phone,
    username: order.customer_telegram,
    chatId: order.customer_chat_id
  });
  if (!resolved) return null;

  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    await db.from('orders').update({ customer_chat_id: resolved }).eq('id', order.id);
    console.log('[resolveCustomerChatId] Patched customer_chat_id for order', order.id, '->', resolved);
  } catch (e) {
    console.error('[resolveCustomerChatId] DB patch failed:', e.message);
  }

  return resolved;
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
async function notifyCustomerOrderReady(order, shop, photoSource) {
  if (!order?.id) return false;
  const isFreshPhoto = Buffer.isBuffer(photoSource);
  const dedupKey = isFreshPhoto ? null : (photoSource ? 'customer_ready_photo' : 'customer_status_ready');
  if (dedupKey && !canSendNotification(order.id, dedupKey)) return false;

  const chatId = await resolveCustomerChatId(order);
  if (!chatId) {
    console.log('[notifyCustomerOrderReady] no chat_id for order', order.id, 'phone:', order.customer_phone);
    return false;
  }
  order.customer_chat_id = chatId;

  const shopName = shop?.shop_name || 'Магазин';
  const text =
    `📸 <b>Ваш букет готов!</b>\n\n` +
    `<b>${shopName}</b> отправил фото готового заказа. Скоро в пути! 🚚\n\n` +
    `📦 Заказ #${order.id}`;

  const src = photoSource || order.delivery_photo_url;
  let ok = false;
  if (!src) {
    const r = await trySendToCustomer(chatId, text);
    ok = !!r?.ok;
  } else {
    ok = await sendPhotoToCustomer(chatId, src, { caption: text, parse_mode: 'HTML' });
    if (!ok) {
      const r = await trySendToCustomer(chatId, text + '\n\n<i>Фото временно недоступно — свяжитесь с @rebuket_admin</i>');
      ok = !!r?.ok;
    }
  }
  if (ok && dedupKey) markNotificationSent(order.id, dedupKey);
  return ok;
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
    const text = `🚚 <b>Ваш заказ доставлен!</b>\n\nПожалуйста, подтвердите получение в течение <b>2 часов</b>. Если не подтвердите — заказ будет автоматически завершён.\n\n📦 Заказ #${orderId}\n💐 ${shopName}`;
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
        const ok = await sendPhotoToCustomer(chatId, order.delivery_photo_url, { caption: text, ...opts });
        if (!ok) await userBot.sendMessage(chatId, text, opts);
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
        if (!['delivered', 'confirmed_received'].includes(order.status)) {
          await userBot.sendMessage(chatId, 'ℹ️ Подтвердить получение можно только после доставки заказа.').catch(() => {});
          return;
        }
        if (order.status === 'confirmed_received') {
          await userBot.sendMessage(chatId, '✅ Вы уже подтвердили получение этого заказа.').catch(() => {});
          return;
        }

        const { data: updated, error } = await db.from('orders')
          .update({ status: 'confirmed_received', confirmed_at: new Date().toISOString() })
          .eq('id', orderId)
          .in('status', ['delivered'])
          .select()
          .maybeSingle();

        if (error || !updated) {
          console.error('[cust_confirm] update failed:', error?.message, 'status:', order.status);
          await userBot.sendMessage(chatId, '❌ Не удалось подтвердить заказ. Напишите @rebuket_admin.').catch(() => {});
          return;
        }
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
            if (s.telegram_chat_id && shopBot) {
              await shopBot.sendMessage(s.telegram_chat_id, `🌟 Клиент подтвердил получение заказа #${orderId}!`).catch(() => {});
            }
          }
        } catch (_) {}
      } else if (action === 'problem') {
        if (!['delivered', 'confirmed_received', 'refund_requested'].includes(order.status)) {
          await userBot.sendMessage(chatId, 'ℹ️ Сообщить о проблеме можно после доставки заказа.').catch(() => {});
          return;
        }
        customerPendingRefundReason.set(chatId, orderId);
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
    if (customerPendingRefundReason.has(msg.chat.id)) {
      customerPendingRefundReason.delete(msg.chat.id);
      await userBot.sendMessage(msg.chat.id, '↩️ Запрос на возврат отменён.');
    }
  });

  userBot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const orderId = customerPendingRefundReason.get(chatId);
    if (orderId) {
      customerPendingRefundReason.delete(chatId);
      try {
        const { createSupabaseClient } = require('../db/supabase');
        const db = createSupabaseClient();
        const order = await ensureCustomerOwnsOrder(db, orderId, chatId);
        if (!order) {
          await userBot.sendMessage(chatId, '❌ Заказ не найден.');
          return;
        }
        const reason = msg.text.trim().slice(0, 1000);
        const { data: updated, error } = await db.from('orders')
          .update({ status: 'refund_requested', refund_reason: reason })
          .eq('id', orderId)
          .select()
          .single();
        if (error || !updated) {
          await userBot.sendMessage(chatId, '❌ Не удалось отправить обращение. Попробуйте снова или напишите @rebuket_admin.');
          return;
        }
        await userBot.sendMessage(chatId,
          `✅ <b>Запрос на возврат отправлен</b>\n\nМагазин рассмотрит обращение.\n\n📦 Заказ #${orderId}\n📝 Причина: ${reason}`,
          { parse_mode: 'HTML' });
        try {
          let items = updated.items;
          if (typeof items === 'string') items = JSON.parse(items);
          const sellerPhones = [...new Set((items || []).map(it => it.seller_phone).filter(Boolean))];
          const shops = await findShopsBySellerPhones(sellerPhones);
          const shopText =
            `⚠️ <b>Запрос на возврат от клиента</b>\n\n📦 Заказ #${orderId}\n💰 ${(Number(updated.total) || 0).toLocaleString('ru')} сом\n\n📝 <b>Причина:</b>\n${reason}`;
          for (const s of shops) {
            if (s.telegram_chat_id && shopBot) {
              await shopBot.sendMessage(s.telegram_chat_id, shopText, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '✅ Одобрить возврат', callback_data: `shop_refund_approve:${orderId}` },
                    { text: '⚠️ Оспорить', callback_data: `shop_refund_dispute:${orderId}` }
                  ]]
                }
              }).catch(() => {});
            }
          }
        } catch (e) { console.log('refund notify shop err:', e.message); }
        try {
          for (const adminChat of adminChatIds) {
            if (adminBot) await adminBot.sendMessage(adminChat, `⚠️ Возврат запрошен: заказ #${orderId}\nПричина: ${reason}`).catch(() => {});
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
// ⏱ Авто-подтверждение получения через 2 часа
// ─────────────────────────────────────────────
function startAutoConfirmInterval() {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const cutoff = new Date(Date.now() - TWO_HOURS_MS).toISOString();
      const { data: orders } = await db.from('orders')
        .select('id, customer_chat_id').eq('status', 'delivered').lt('delivered_at', cutoff).limit(50);
      for (const o of orders || []) {
        await db.from('orders').update({ status: 'confirmed_received', confirmed_at: new Date().toISOString() }).eq('id', o.id);
        if (o.customer_chat_id && userBot) {
          await userBot.sendMessage(o.customer_chat_id, `✅ Заказ #${o.id} автоматически подтверждён (прошло 2 часа). Спасибо за покупку!`).catch(_=>{});
        }
      }
    } catch (e) { console.log('[auto-confirm interval]', e.message); }
  }, 10 * 60 * 1000);
  console.log('⏱ Auto-confirm interval запущен (каждые 10 мин)');
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
  if (!shopBot || !chatId || !html) return;
  try { await shopBot.sendMessage(chatId, html, { parse_mode: 'HTML' }); }
  catch (e) { console.log('[notifyShopRaw]', e.message); }
}

async function notifyProductEdited(p, shopPhone) {
  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const COMMISSION = p.category === 'sweets' ? 0.10 : 0.20;
  const sellerPrice = Number(p.price) || 0;
  const buyerPrice  = Math.ceil(sellerPrice * (1 + COMMISSION) / 10) * 10;

  const text =
    `✏️ <b>МАГАЗИН ИЗМЕНИЛ ПУБЛИКАЦИЮ</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n\n` +
    `🏬 <b>Магазин:</b> ${escHtml(p.seller_name || shopPhone || '—')}\n` +
    `📞 <b>Телефон:</b> ${escHtml(p.seller_phone || shopPhone)}\n` +
    `📍 <b>Город:</b> ${escHtml(p.city || '—')}\n\n` +
    `💵 <b>Цена продавца:</b> ${sellerPrice.toLocaleString('ru')} TJS\n` +
    `💰 <b>Цена для покупателя:</b> ${buyerPrice.toLocaleString('ru')} TJS\n\n` +
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
  savePhoneMapping,
  saveUsernameMapping,
  getChatIdByUsername,
  patchOrderChatId,
  phoneDigits,
};