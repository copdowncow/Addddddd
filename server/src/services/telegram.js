'use strict';

const TG = require('node-telegram-bot-api');
const Chat = require('./chat');

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

function getMiniAppUrl() {
  return (process.env.MINI_APP_URL || process.env.SITE_URL || '').replace(/\/$/, '');
}

// Lazily create userBot if it was not started (e.g. missing token at startup)
function ensureUserBot() {
  if (userBot) return true;
  const token = process.env.BOT_TOKEN_USER;
  if (!token) {
    console.log('[ensureUserBot] BOT_TOKEN_USER is missing');
    return false;
  }
  try {
    // No polling here to avoid double polling; just for sendMessage fallback
    userBot = new TG(token, { polling: false });
    console.log('[ensureUserBot] userBot lazily initialized for sending');
    return true;
  } catch (e) {
    console.error('[ensureUserBot] failed to init userBot:', e.message);
    return false;
  }
}

async function notifyAdminAboutOrder(order) {
  console.log('[notifyAdminAboutOrder] Called with order:', order.id);
  console.log('[notifyAdminAboutOrder] adminBot exists:', !!adminBot);
  console.log('[notifyAdminAboutOrder] adminChatIds:', Array.from(adminChatIds));
  console.log('[notifyAdminAboutOrder] receipt_url:', order.receipt_url);
  
  if (!adminBot) {
    console.error('[notifyAdminAboutOrder] adminBot is not initialized');
    return;
  }
  
  if (adminChatIds.size === 0) {
    console.error('[notifyAdminAboutOrder] No admin chat IDs configured');
    return;
  }
  
  let items = [];
  if (Array.isArray(order.items)) {
    items = order.items;
  } else if (typeof order.items === 'string' && order.items.trim()) {
    try {
      items = JSON.parse(order.items);
    } catch (e) {
      console.error('[notifyAdminAboutOrder] items parse error:', e.message, order.items);
      items = [];
    }
  } else if (order.items && typeof order.items === 'object') {
    items = order.items;
  }
  const itemsList = (items || []).map(i => `• ${i.title || i.name || 'Товар'} — ${(Number(i.price)||0).toLocaleString('ru')} сом.`).join('\n');
  const deliveryLabel = order.delivery_type === 'pickup' ? '🏪 Самовывоз' : '🚕 Такси';
  const adminUrl = `${getMiniAppUrl()}/#admin`;
  
  let message = `🛒 <b>НОВЫЙ ЗАКАЗ #${order.id}</b>\n\n`;
  if (order.customer_name) {
    message += `👤 Имя: ${order.customer_name}\n`;
  }
  message += `📞 Телефон: ${order.customer_phone}\n`;
  message += `📍 Адрес: ${order.customer_address}\n`;
  message += `🚚 Доставка: ${deliveryLabel}\n`;
  message += `💰 Сумма: ${(order.total||0).toLocaleString('ru')} сом.\n\n`;
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
      [
        { text: '📋 Открыть админ-панель', url: adminUrl }
      ]
    ]
  };

  const options = { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: actionsKeyboard };
  
  // Send to all admin chat IDs
  for (const chatId of adminChatIds) {
    try {
      console.log('[notifyAdminAboutOrder] Sending to chatId:', chatId, 'with photo:', !!order.receipt_url);
      if (order.receipt_url) {
        await adminBot.sendPhoto(chatId, order.receipt_url, { caption: message, ...options });
        console.log('[notifyAdminAboutOrder] Photo sent successfully to:', chatId);
      } else {
        await adminBot.sendMessage(chatId, message, options);
        console.log('[notifyAdminAboutOrder] Message sent successfully to:', chatId);
      }
    } catch (err) {
      console.error('[notifyAdminAboutOrder] Failed to send to chatId:', chatId, err);
    }
  }
}

async function handleOrderCallback(callbackQuery) {
  if (!adminBot) return;
  const data = callbackQuery.data || '';
  const match = data.match(/^(order_confirm|order_reject):(.+)$/);
  if (!match) return;

  const action = match[1];
  const orderId = match[2];
  // Admin "confirm" = payment_confirmed (next step: seller decides)
  const status = action === 'order_confirm' ? 'payment_confirmed' : 'rejected';
  const label = status === 'payment_confirmed' ? '✅ Оплата подтверждена — продавец уведомлён' : '❌ Заказ отклонён';

  try {
    const { createSupabaseClient } = require('../db/supabase');
    const db = createSupabaseClient();
    const { data: updatedOrder, error } = await db.from('orders').update({ status }).eq('id', orderId).select().single();
    if (error) throw new Error(error.message);

    await adminBot.answerCallbackQuery(callbackQuery.id, { text: label, show_alert: false });
    await adminBot.sendMessage(callbackQuery.from.id, `Заказ #${orderId} ${status === 'payment_confirmed' ? 'подтверждён (оплата)' : 'отклонён'}.

📞 ${updatedOrder.customer_phone}
💰 ${(Number(updatedOrder.total)||0).toLocaleString('ru')} сом.`, { parse_mode: 'HTML' });

    // After payment confirmation, notify seller(s) and customer + activate relay chat
    if (status === 'payment_confirmed') {
      try { await activateOrderChatFlow(updatedOrder); }
      catch (e) { console.error('[handleOrderCallback] activateOrderChatFlow:', e.message); }
      try {
        await notifyCustomerPaymentConfirmed(updatedOrder);
      } catch (e) {
        console.error('[handleOrderCallback] Failed to notify customer (payment_confirmed):', e.message);
      }
      try {
        await notifySellerAboutOrder(updatedOrder);
      } catch (e) {
        console.error('[handleOrderCallback] Failed to notify seller:', e.message);
      }
    } else if (status === 'rejected' && updatedOrder.customer_chat_id && userBot) {
      try {
        await userBot.sendMessage(updatedOrder.customer_chat_id,
          `❌ <b>Заказ отклонён</b>\n\n` +
          `К сожалению, ваш заказ #${orderId} был отклонён администратором.\n` +
          `Для уточнения свяжитесь с @rebuket_admin.`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        console.error('[handleOrderCallback] Failed to notify customer (reject):', e.message);
      }
    }

    if (callbackQuery.message) {
      const chatId = callbackQuery.message.chat.id;
      const messageId = callbackQuery.message.message_id;
      const original = callbackQuery.message.caption || callbackQuery.message.text || '';
      const newText = `<b>${label}</b>\n\n${original}`;
      try {
        if (callbackQuery.message.caption) {
          await adminBot.editMessageCaption(newText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
          });
        } else {
          await adminBot.editMessageText(newText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
          });
        }
      } catch (ignore) {}
    }
  } catch (err) {
    console.error('[handleOrderCallback] Error updating order:', err.message);
    await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка при обновлении заказа', show_alert: true });
  }
}


// Notify the seller (shop) when admin confirms payment
async function notifySellerAboutOrder(order) {
  if (!order) return;
  const bot = shopBot || userBot; // fallback to userBot if shopBot not configured
  if (!bot) {
    console.log('[notifySellerAboutOrder] No bot available');
    return;
  }

  // Find seller chat IDs from items
  let items = [];
  if (typeof order.items === 'string') {
    try { items = JSON.parse(order.items); } catch (e) { items = []; }
  } else if (Array.isArray(order.items)) {
    items = order.items;
  }
  const sellerPhones = [...new Set(items.map(it => (it.seller_phone || '').toString().trim()).filter(Boolean))];
  if (sellerPhones.length === 0) {
    console.log('[notifySellerAboutOrder] No seller phones in order', order.id);
    return;
  }

  const { createSupabaseClient } = require('../db/supabase');
  const db = createSupabaseClient();
  const { data: shops } = await db
    .from('shops')
    .select('phone, shop_name, telegram_chat_id')
    .in('phone', sellerPhones);

  const itemsList = items.map(it => `• ${it.title || 'Товар'} ×${it.qty || 1}`).join('\n');
  const total = (Number(order.total) || 0).toLocaleString('ru');

  const message = `🛒 <b>Новый заказ для вашего магазина!</b>\n\n` +
    `📦 <b>Товары:</b>\n${itemsList}\n\n` +
    `💰 <b>Сумма:</b> ${total} сом\n` +
    `🚚 <b>Доставка:</b> ${order.delivery_type || '—'}\n\n` +
    `⏳ Контакты клиента откроются после того, как вы примете заказ.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Принять заказ', callback_data: `shop_accept:${order.id}` },
      { text: '❌ Отклонить',     callback_data: `shop_reject:${order.id}` },
    ]]
  };

  for (const shop of (shops || [])) {
    if (!shop.telegram_chat_id) {
      console.log('[notifySellerAboutOrder] Shop has no chat_id:', shop.phone, '— send /start to shopBot first');
      continue;
    }
    try {
      await bot.sendMessage(shop.telegram_chat_id, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      console.log('[notifySellerAboutOrder] Notified shop', shop.phone);
    } catch (e) {
      console.error('[notifySellerAboutOrder] Error notifying', shop.phone, ':', e.message);
    }
  }
}

async function notifyAdminAboutShopOrder(order, shop) {
  if (!adminBot) return;
  const action = order.status === 'seller_accepted' || order.status === 'confirmed'
    ? '✅ ПРИНЯЛ ЗАКАЗ'
    : (order.status === 'rejected' ? '❌ ОТКАЗАЛ В ЗАКАЗЕ' : `🔄 ${order.status.toUpperCase()}`);
  const shopName = shop.shop_name || shop.phone;

  let message = `🏪 <b>РЕШЕНИЕ МАГАЗИНА</b>\n\n`;
  message += `<b>Имя магазина:</b> ${shopName}\n`;
  message += `<b>Номер:</b> ${shop.phone}\n`;
  message += `<b>Действие:</b> ${action}\n\n`;
  message += `<b>Заказчик:</b> ${order.customer_phone}\n`;
  
  if (order.receiver_name) {
    message += `<b>Получатель:</b> ${order.receiver_name} (${order.receiver_phone})\n`;
  }
  
  message += `\n💰 Сумма: ${(order.total||0).toLocaleString('ru')} сом.`;
  
  const options = { parse_mode: 'HTML', disable_web_page_preview: true };
  
  for (const chatId of adminChatIds) {
    await adminBot.sendMessage(chatId, message, options);
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

function initBots() {
  if (process.env.ADMIN_CHAT_ID_1) adminChatIds.add(process.env.ADMIN_CHAT_ID_1);
  if (process.env.ADMIN_CHAT_ID_2) adminChatIds.add(process.env.ADMIN_CHAT_ID_2);
  if (process.env.ADMIN_CHAT_ID)   adminChatIds.add(process.env.ADMIN_CHAT_ID);
  initUserBot();
  initAdminBot();
  initShopBot();
  setupCustomerOrderHandlers();
  startAutoConfirmInterval();
}

function initUserBot() {
  const token = process.env.BOT_TOKEN_USER;
  if (!token) { console.log('BOT_TOKEN_USER не задан'); return; }
  userBot = new TG(token, { polling: true });

  userBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const name   = msg.from?.first_name || 'друг';
    const appUrl = getMiniAppUrl();
    const param  = (match && match[1] || '').trim();
    console.log('[bot /start] param:', JSON.stringify(param.substring(0, 50)));

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
      await userBot.sendMessage(msg.chat.id,
        '✅ <b>Заявка принята!</b>\n\nДля полного оформления заказа — нажмите кнопку ниже, откроется чат с готовым сообщением — останется нажать Отправить 👇',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✈️ Отправить заказ администратору', url: adminUrl }]] } }
      );
      return;
    }

    if (param === 'inquiry_OLDCODE') {
      const adminUrl = process.env.ADMIN_TELEGRAM || 'https://t.me/Rebuket_admin';
      await userBot.sendMessage(msg.chat.id,
        `🌸 <b>Привет, ${escHtml(name)}!</b>\n\nВаша заявка успешно отправлена администратору.\n\nЧтобы уточнить детали заказа — напишите администратору напрямую:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✈️ Написать администратору', url: adminUrl }]] } }
      );
      return;
    }

    await userBot.sendMessage(msg.chat.id,
      `🌸 <b>Привет, ${escHtml(name)}!</b>\n\nДобро пожаловать в <b>ReBuket</b> — маркетплейс букетов и сладостей в Таджикистане.\n\n💐 <b>Купить</b> — просматривать букеты, корзины, игрушки и сладости\n🛍 <b>Продать</b> — разместить своё объявление\n📩 <b>Связаться</b> — оставить заявку продавцу\n\n👇 Нажмите кнопку ниже чтобы открыть каталог:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', web_app: { url: appUrl } }]] } }
    );
  });

  userBot.onText(/\/catalog/, async (msg) => {
    await userBot.sendMessage(msg.chat.id, `💐 <b>Каталог ReBuket</b>\n\nБукеты, корзины, игрушки и сладости:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💐 Смотреть каталог', web_app: { url: getMiniAppUrl() + '#catalog' } }]] } }
    );
  });

  userBot.onText(/\/sell/, async (msg) => {
    await userBot.sendMessage(msg.chat.id, `🛍 <b>Разместить объявление</b>\n\nПродайте букеты или сладости через ReBuket!`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ Разместить объявление', web_app: { url: getMiniAppUrl() + '#sell' } }]] } }
    );
  });

  userBot.onText(/\/help/, async (msg) => {
    await userBot.sendMessage(msg.chat.id,
      `🌸 <b>ReBuket — помощь</b>\n\n/start   — запустить бота\n/catalog — каталог\n/sell    — разместить объявление\n/help    — эта справка`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', web_app: { url: getMiniAppUrl() } }]] } }
    );
  });

  // /endchat — leave active order chat
  userBot.onText(/\/endchat/, async (msg) => {
    try {
      const sess = await Chat.getActiveChat(msg.chat.id);
      if (sess) {
        await Chat.clearActiveChat(msg.chat.id);
        await userBot.sendMessage(msg.chat.id, '✅ Вы вышли из чата по заказу. Чтобы вернуться — мы вам напишем при новых сообщениях магазина.');
      } else {
        await userBot.sendMessage(msg.chat.id, 'Активного чата нет.');
      }
    } catch (_) {}
  });

  userBot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    // Skip if customer is currently entering refund reason — that handler will pick it up
    if (customerPendingRefundReason.has(msg.chat.id)) return;

    // ── Relay to shop if active chat session exists ─────────
    try {
      const sess = await Chat.getActiveChat(msg.chat.id);
      if (sess && sess.role === 'customer' && sess.order_id) {
        const order = await Chat.getOrderForChat(sess.order_id);
        if (order && order.chat_active) {
          const text = msg.text.trim().slice(0, 2000);
          const saved = await Chat.persistMessage({
            order_id: order.id, sender: 'customer', text, tg_message_id: msg.message_id
          });
          const delivered = await relayCustomerToShop(order, text);
          if (saved) await Chat.markDelivered(saved.id);
          await userBot.sendMessage(msg.chat.id,
            delivered > 0 ? '✅ Сообщение передано магазину' : '⚠️ Магазин пока не подключился к боту. Сообщение сохранено.',
            { reply_to_message_id: msg.message_id }
          ).catch(_=>{});
          return;
        }
      }
    } catch (e) { console.log('[userBot relay]', e.message); }

    // Fallback — open mini-app
    await userBot.sendMessage(msg.chat.id, `Нажмите кнопку ниже чтобы открыть ReBuket 🌸`,
      { reply_markup: { inline_keyboard: [[{ text: '🌸 Открыть ReBuket', web_app: { url: getMiniAppUrl() } }]] } }
    );
  });

  userBot.on('polling_error', (err) => {
    if (!err.message?.includes('409')) console.log('USER BOT error:', err.message);
  });

  console.log('🤖 USER BOT запущен | Mini App:', getMiniAppUrl());
}

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
    if (isNew) console.log(`✅ Новый админ: ADMIN_CHAT_ID_1=${chatId}`);
  });

  adminBot.on('callback_query', async (query) => {
    try {
      await handleOrderCallback(query);
    } catch (err) {
      console.error('[adminBot callback_query] Error:', err.message);
    }
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
    } catch(e) {
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
    console.log('[getNextSerial] channel=' + channel + ' next=' + data);
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

  console.log(`[publishToChannel] city="${city}" isKhujand=${isKhujand} channelId=${channelId}`);

  if (!channelId) {
    console.log('[publishToChannel] CHANNEL_ID не задан в .env');
    return;
  }

  const bot = userBot || adminBot;
  if (!bot) {
    console.log('[publishToChannel] Нет активного бота');
    return;
  }

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
    console.log('[publishToChannel] photos:', photos.length, 'caption length:', caption.length);

    if (photos.length === 0) {
      sent = await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
    } else if (photos.length === 1) {
      try {
        sent = await bot.sendPhoto(channelId, photos[0], { caption, parse_mode: 'HTML' });
      } catch(photoErr) {
        console.log('[publishToChannel] Photo failed, sending text:', photoErr.message);
        sent = await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
      }
    } else {
      try {
        const media = photos.slice(0, 10).map((ph, i) => ({
          type: 'photo',
          media: ph,
          ...(i === 0 ? { caption, parse_mode: 'HTML' } : {})
        }));
        const results = await bot.sendMediaGroup(channelId, media);
        sent = Array.isArray(results) ? results[0] : results;
      } catch(mediaErr) {
        console.log('[publishToChannel] MediaGroup failed, trying single photo:', mediaErr.message);
        try {
          sent = await bot.sendPhoto(channelId, photos[0], { caption, parse_mode: 'HTML' });
        } catch(e2) {
          console.log('[publishToChannel] Single photo failed, sending text:', e2.message);
          sent = await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
        }
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
    } catch(e) {
      console.log('Не удалось сохранить message_id:', e.message);
    }

    console.log(`📢 Опубликовано в канал: ${p.title} [${code}]`);
  } catch(e) {
    console.log('[publishToChannel] Ошибка:', e.message);
  }
}

// ─────────────────────────────────────────────
//  Пометить истёкшие посты в канале
// ─────────────────────────────────────────────
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
      chat_id:    channelId,
      message_id: p.channel_message_id,
      parse_mode: 'HTML'
    });
    console.log(`🔴 Пост помечен как снято: ${p.title}`);
  } catch(e) {
    console.log('Ошибка редактирования поста:', e.message);
  }
}

// ─────────────────────────────────────────────
//  Уведомление продавцу — одобрено
// ─────────────────────────────────────────────
async function notifySellerApproved(p) {
  try {
    await publishToChannel(p);
  } catch(e) {
    console.log('Channel publish error:', e.message);
  }

  if (!userBot || !p.seller_chat_id) return;

  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  try {
    await userBot.sendMessage(p.seller_chat_id,
      `🎉 <b>Ваше объявление одобрено!</b>\n\n📦 <b>${escHtml(p.title)}</b>\n💰 ${p.price} TJS · 📍 ${escHtml(p.city)}\n\nТеперь его видят все покупатели. Удачных продаж! 🌸`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔗 Открыть моё объявление', web_app: { url } }]] } }
    );

    if (p.channel_message_id && p.channel_name && userBot) {
      const channelId = p.channel_name === 'khujand'
        ? (process.env.CHANNEL_ID_KHUJAND || '-1003818624807')
        : process.env.CHANNEL_ID;
      if (channelId) {
        try {
          await userBot.forwardMessage(p.seller_chat_id, channelId, p.channel_message_id);
        } catch(fe) {
          console.log('forwardMessage error:', fe.message);
        }
      }
    }
  } catch(e) {
    console.log('Не удалось уведомить продавца:', e.message);
  }
}

// ─────────────────────────────────────────────
//  Уведомление продавцу — отклонено
// ─────────────────────────────────────────────
async function notifySellerRejected(p) {
  if (!userBot || !p.seller_chat_id) return;
  try {
    await userBot.sendMessage(p.seller_chat_id,
      `❌ <b>Ваше объявление отклонено</b>\n\n📦 <b>${escHtml(p.title)}</b>\n\nК сожалению, объявление не прошло модерацию.\nВы можете разместить новое объявление:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ Разместить новое', web_app: { url: getMiniAppUrl() + '#sell' } }]] } }
    );
  } catch(e) {
    console.log('Не удалось уведомить продавца:', e.message);
  }
}

// ─────────────────────────────────────────────
//  Уведомление — новое объявление (для админов)
// ─────────────────────────────────────────────
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
      `📦 <b>Новое объявление на проверке</b>\n` +
      `─────────────────\n` +
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

// ─────────────────────────────────────────────
//  Уведомление — новая заявка (для админов)
// ─────────────────────────────────────────────
async function notifyInquiry(inq, productTitle, productSlug, productId) {
  const url = (productSlug || productId)
    ? `${getMiniAppUrl()}/#product-${productSlug || productId}`
    : null;
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

// ─────────────────────────────────────────────
//  Магазины: уведомления
// ─────────────────────────────────────────────
async function notifyShopRegistration(shop) {
  await sendToAdmins(
    `🏪 <b>Новая заявка на регистрацию магазина!</b>\n` +
    `─────────────────\n` +
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
      `✅ <b>Ваш магазин одобрен!</b>\n\n` +
      `Теперь вы можете войти как магазин на ReBuket и размещать объявления.\n\n` +
      `📞 Телефон для входа: ${escHtml(shop.phone)}`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🏪 Открыть ReBuket', web_app: { url: getMiniAppUrl() } }]] }
      }
    );
  } catch(e) {
    console.log('notifyShopApproved error:', e.message);
  }
}

async function notifyShopRejected(shop) {
  if (!userBot || !shop.telegram_chat_id) return;
  try {
    await userBot.sendMessage(shop.telegram_chat_id,
      `❌ <b>Заявка на регистрацию магазина отклонена</b>\n\nСвяжитесь с администратором для уточнения причин.`,
      { parse_mode: 'HTML' }
    );
  } catch(e) {
    console.log('notifyShopRejected error:', e.message);
  }
}

// ─────────────────────────────────────────────
//  Callback: Одобрить / Отклонить (объявления и магазины)
// ─────────────────────────────────────────────
function setupCallbacks(onApprove, onReject) {
  if (!adminBot) return;
  adminBot.on('callback_query', async (q) => {
    const parts  = (q.data || '').split(':');
    const action = parts[0];
    const id     = parts[1];

    // ── Объявления ──
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

    // ── Магазины ──
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
        console.log('shop_approve error:', e.message);
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
        console.log('shop_reject error:', e.message);
        await adminBot.answerCallbackQuery(q.id, { text: '❌ Ошибка: ' + e.message });
      }
    }
  });
}

// ─────────────────────────────────────────────
//  Уведомление покупателю — заявка отправлена
// ─────────────────────────────────────────────
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
      '\nНажмите кнопку ниже — сообщение уже готово, останется только нажать Отправить.';

    await userBot.sendMessage(d.customer_chat_id, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✈️ Написать администратору', url: tgLink }
        ]]
      }
    });
  } catch(e) {
    console.log('notifyBuyerInquirySent error:', e.message);
  }
}

// ─────────────────────────────────────────────
// 🏪 SHOP BOT — для магазинов
// /start → запрос телефона → запрос пароля → привязка chat_id
// callbacks: shop_accept:<id>, shop_reject:<id>, shop_preparing/ready/delivered:<id>
// ─────────────────────────────────────────────

// Состояние авторизации по chat_id
const shopAuthState = new Map(); // chatId -> { step: 'phone'|'password', phone?: string }

function initShopBot() {
  const token = process.env.BOT_TOKEN_SHOP || process.env.SHOP_ID;
  if (!token) { console.log('BOT_TOKEN_SHOP / SHOP_ID не задан — shopBot не запущен'); return; }
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

  // /start — начинаем авторизацию: запрашиваем номер
  shopBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    shopAuthState.set(chatId, { step: 'phone' });
    await shopBot.sendMessage(chatId,
      `🏪 <b>ReBuket Shop Bot</b>\n\n` +
      `Чтобы получать заказы, авторизуйтесь как магазин.\n\n` +
      `📞 Шаг 1/2: отправьте <b>номер телефона</b> вашего магазина (тот, с которым вы регистрировались).\n\n` +
      `Можно нажать кнопку ниже или ввести вручную.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [[{ text: '📞 Поделиться номером', request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true
        }
      }
    );
  });

  // /logout — отвязать аккаунт
  shopBot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await getDb().from('shops').update({ telegram_chat_id: null }).eq('telegram_chat_id', chatId);
      shopAuthState.delete(chatId);
      await shopBot.sendMessage(chatId, '✅ Вы вышли из аккаунта. Отправьте /start чтобы войти снова.', { reply_markup: { remove_keyboard: true } });
    } catch (e) {
      console.error('[shopBot /logout]', e.message);
    }
  });

  // Контакт — используем как номер для шага 1
  shopBot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const phone = (msg.contact && msg.contact.phone_number || '').replace(/[^\d+]/g, '');
    if (!phone) return;
    await handlePhoneInput(chatId, phone);
  });

  // /endchat — shop leaves active order chat
  shopBot.onText(/\/endchat/, async (msg) => {
    try {
      const sess = await Chat.getActiveChat(msg.chat.id);
      if (sess) {
        await Chat.clearActiveChat(msg.chat.id);
        await shopBot.sendMessage(msg.chat.id, '✅ Вы вышли из чата по заказу.');
      } else {
        await shopBot.sendMessage(msg.chat.id, 'Активного чата нет.');
      }
    } catch (_) {}
  });

  // Любое текстовое сообщение — обрабатываем по состоянию или relay в чат
  shopBot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return; // команды обработаны выше
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

    // No auth flow → check for active chat session and relay to customer
    try {
      const sess = await Chat.getActiveChat(chatId);
      if (sess && sess.role === 'shop' && sess.order_id) {
        const order = await Chat.getOrderForChat(sess.order_id);
        if (order && order.chat_active && userBot && order.customer_chat_id) {
          const text = msg.text.trim().slice(0, 2000);
          const saved = await Chat.persistMessage({
            order_id: order.id, sender: 'shop', sender_phone: sess.shop_phone, text, tg_message_id: msg.message_id
          });
          try {
            await userBot.sendMessage(order.customer_chat_id,
              `💬 <b>Магазин (заказ #${order.id}):</b>\n` + escHtml(text),
              { parse_mode: 'HTML' }
            );
            if (saved) await Chat.markDelivered(saved.id);
            await shopBot.sendMessage(chatId, '✅ Сообщение передано клиенту', { reply_to_message_id: msg.message_id }).catch(_=>{});
          } catch (e) {
            await shopBot.sendMessage(chatId, '⚠️ Не удалось передать клиенту: ' + e.message).catch(_=>{});
          }
          return;
        }
      }
    } catch (e) { console.log('[shopBot relay]', e.message); }
  });

  async function handlePhoneInput(chatId, rawPhone) {
    try {
      const variants = [rawPhone, rawPhone.replace(/^\+/, ''), '+' + rawPhone.replace(/^\+/, '')];
      const { data: shops } = await getDb().from('shops').select('phone, shop_name, status').in('phone', variants);
      const shop = (shops || [])[0];
      if (!shop) {
        await shopBot.sendMessage(chatId, `❌ Магазин с номером <b>${rawPhone}</b> не найден.\n\nПроверьте номер и отправьте ещё раз. Если магазин не зарегистрирован — сначала пройдите регистрацию в приложении.`, { parse_mode: 'HTML' });
        return;
      }
      if (shop.status !== 'active') {
        await shopBot.sendMessage(chatId, `⚠️ Магазин найден, но статус: <b>${shop.status}</b>. Дождитесь одобрения администратором.`, { parse_mode: 'HTML' });
        shopAuthState.delete(chatId);
        return;
      }
      shopAuthState.set(chatId, { step: 'password', phone: shop.phone });
      await shopBot.sendMessage(chatId,
        `✅ Магазин найден: <b>${shop.shop_name || shop.phone}</b>\n\n` +
        `🔒 Шаг 2/2: отправьте <b>пароль</b> от аккаунта магазина.\n\n` +
        `<i>Сообщение с паролем будет удалено автоматически.</i>`,
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
      // Привязываем chat_id
      await db.from('shops').update({ telegram_chat_id: chatId }).eq('phone', shop.phone);
      shopAuthState.delete(chatId);
      await shopBot.sendMessage(chatId,
        `✅ <b>${shop.shop_name || 'Магазин'}</b> успешно подключён!\n\n` +
        `Теперь вы будете получать только <b>свои</b> заказы — после подтверждения оплаты администратором.\n\n` +
        `📞 Телефон: ${shop.phone}\n` +
        `Команды:\n• /logout — выйти из аккаунта`,
        { parse_mode: 'HTML' }
      );
      console.log('[shopBot] Authorized:', shop.phone, '→ chat_id:', chatId);
    } catch (e) {
      console.error('[shopBot handlePasswordInput]', e.message);
      await shopBot.sendMessage(chatId, '❌ Ошибка авторизации. Попробуйте /start снова.');
      shopAuthState.delete(chatId);
    }
  }

  // /cancel — отмена ожидания фото
  shopBot.onText(/\/cancel/, async (msg) => {
    if (shopPendingPhoto.has(msg.chat.id)) {
      shopPendingPhoto.delete(msg.chat.id);
      await shopBot.sendMessage(msg.chat.id, '↩️ Отмена. Фото не отправлено.');
    }
  });

  // Photo handler — фото-отчёт магазина для статуса 'ready'
  shopBot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const orderId = shopPendingPhoto.get(chatId);
    if (!orderId) return; // не ждём фото
    shopPendingPhoto.delete(chatId);

    try {
      // Получаем file_url через API Telegram
      const photo = msg.photo[msg.photo.length - 1]; // самое большое
      const fileLink = await shopBot.getFileLink(photo.file_id);

      // Скачиваем и загружаем в Supabase storage
      const https = require('https');
      const buffer = await new Promise((resolve, reject) => {
        https.get(fileLink, (resp) => {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
          resp.on('error', reject);
        }).on('error', reject);
      });

      const { uploadPhoto } = require('../db/supabase');
      const photoUrl = await uploadPhoto(buffer, `delivery-${orderId}-${Date.now()}.jpg`, 'image/jpeg');

      const db = getDb();
      const { data: updated } = await db.from('orders')
        .update({ status: 'ready', delivery_photo_url: photoUrl })
        .eq('id', orderId)
        .select()
        .single();

      const { data: shop } = await db.from('shops').select('phone, shop_name').eq('telegram_chat_id', chatId).single();

      await shopBot.sendMessage(chatId, `✅ Фото отправлено клиенту. Заказ #${orderId} помечен как «📦 Готов».`, {
        reply_markup: { inline_keyboard: [[{ text: '🚚 Доставлен', callback_data: `shop_delivered:${orderId}` }]] }
      });

      try { await notifyCustomerStatusChanged(updated, shop); } catch(e) { console.log('notify customer err:', e.message); }
    } catch (e) {
      console.error('[shopBot photo]', e.message);
      try { await shopBot.sendMessage(chatId, '❌ Не удалось обработать фото: ' + e.message); } catch(_){}
    }
  });

  // Callbacks: accept / reject orders, mark stages
  shopBot.on('callback_query', async (q) => {
    const data = q.data || '';

    // Refund approval/dispute by shop
    const mref = data.match(/^shop_refund_(approve|dispute):(.+)$/);
    if (mref) {
      const [, refundAction, orderId] = mref;
      const newStatus = refundAction === 'approve' ? 'refunded' : 'refund_disputed';
      try {
        const db = getDb();
        const { data: shop } = await db.from('shops').select('phone, shop_name').eq('telegram_chat_id', q.message.chat.id).single();
        if (!shop) {
          await shopBot.answerCallbackQuery(q.id, { text: 'Сначала /start', show_alert: true });
          return;
        }
        const { data: updated } = await db.from('orders').update({ status: newStatus }).eq('id', orderId).select().single();
        await shopBot.answerCallbackQuery(q.id, { text: refundAction === 'approve' ? '✅ Возврат одобрен' : '⚠️ Возврат оспорен' });
        await shopBot.sendMessage(q.message.chat.id, refundAction === 'approve'
          ? `✅ Возврат по заказу #${orderId} одобрен. Клиент уведомлён.`
          : `⚠️ Возврат по заказу #${orderId} оспорен. Администратор разберётся.`);
        // notify customer
        if (updated && updated.customer_chat_id) {
          try {
            await userBot && userBot.sendMessage(updated.customer_chat_id,
              refundAction === 'approve'
                ? `✅ <b>Возврат одобрен</b>\n\nЗаказ #${orderId} — магазин одобрил возврат. Свяжитесь с администратором @rebuket_admin.`
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
    const action = m[1];
    const orderId = m[2];

    // Спецслучай: ready — сначала запрашиваем фото
    if (action === 'ready') {
      try {
        const db = getDb();
        const { data: shop } = await db.from('shops').select('phone').eq('telegram_chat_id', q.message.chat.id).single();
        if (!shop) {
          await shopBot.answerCallbackQuery(q.id, { text: 'Сначала /start', show_alert: true });
          return;
        }
        shopPendingPhoto.set(q.message.chat.id, orderId);
        await shopBot.answerCallbackQuery(q.id, { text: '📸 Отправьте фото готового букета' });
        await shopBot.sendMessage(q.message.chat.id,
          `📸 <b>Фото-отчёт по заказу #${orderId}</b>\n\nОтправьте фотографию готового букета — она будет переслана клиенту вместе с уведомлением.\n\n<i>Отмена: /cancel</i>`,
          { parse_mode: 'HTML' });
        return;
      } catch (e) {
        console.error('[shopBot ready prompt]', e.message);
      }
    }

    const newStatus = action === 'accept' ? 'seller_accepted'
                    : action === 'reject' ? 'rejected'
                    : action;
    const labels = {
      seller_accepted: '✅ Заказ принят — контакты клиента открыты',
      rejected: '❌ Заказ отклонён',
      preparing: '👨‍🍳 Готовим заказ',
      ready: '📦 Заказ готов к выдаче',
      delivered: '🚚 Заказ доставлен'
    };

    try {
      const db = getDb();
      // Проверяем что этот chat_id привязан к магазину
      const { data: shop } = await db.from('shops').select('phone, shop_name').eq('telegram_chat_id', q.message.chat.id).single();
      if (!shop) {
        await shopBot.answerCallbackQuery(q.id, { text: 'Сначала авторизуйтесь через /start', show_alert: true });
        return;
      }

      // Проверяем что заказ принадлежит этому магазину
      const { data: order } = await db.from('orders').select('status, items, customer_phone, customer_address').eq('id', orderId).single();
      if (!order) {
        await shopBot.answerCallbackQuery(q.id, { text: 'Заказ не найден', show_alert: true });
        return;
      }
      let items = [];
      if (typeof order.items === 'string') { try { items = JSON.parse(order.items); } catch(_){} }
      else if (Array.isArray(order.items)) items = order.items;
      const orderHasShopItem = items.some(it => (it.seller_phone || '').toString().trim() === shop.phone);
      if (!orderHasShopItem) {
        await shopBot.answerCallbackQuery(q.id, { text: 'Этот заказ не для вашего магазина', show_alert: true });
        return;
      }
      if (order.status === 'pending') {
        await shopBot.answerCallbackQuery(q.id, { text: 'Заказ ещё не подтверждён админом', show_alert: true });
        return;
      }

      const updateFields = { status: newStatus };
      if (newStatus === 'delivered') updateFields.delivered_at = new Date().toISOString();
      const { data: updated, error } = await db.from('orders').update(updateFields).eq('id', orderId).select().single();
      if (error) throw error;

      await shopBot.answerCallbackQuery(q.id, { text: labels[newStatus] || 'OK' });

      let reply = `<b>${labels[newStatus] || newStatus}</b>\nЗаказ #${orderId}\n`;
      if (newStatus === 'seller_accepted') {
        reply += `\n📞 Клиент: <b>${updated.customer_phone}</b>\n🏠 Адрес: ${updated.customer_address}`;
      }
      const nextKb = [];
      if (newStatus === 'seller_accepted') nextKb.push([{ text: '👨‍🍳 Готовим', callback_data: `shop_preparing:${orderId}` }]);
      if (newStatus === 'preparing') nextKb.push([{ text: '📦 Готов (отправить фото)', callback_data: `shop_ready:${orderId}` }]);
      if (newStatus === 'ready') nextKb.push([{ text: '🚚 Доставлен', callback_data: `shop_delivered:${orderId}` }]);

      await shopBot.sendMessage(q.message.chat.id, reply, {
        parse_mode: 'HTML',
        reply_markup: nextKb.length ? { inline_keyboard: nextKb } : undefined
      });

      // Уведомление клиента в красивом виде
      try { await notifyCustomerStatusChanged(updated, shop); } catch (e) { console.log('customer notify err:', e.message); }

      try {
        await notifyAdminAboutShopOrder(updated, shop);
      } catch (e) { console.log('admin notify err:', e.message); }
    } catch (e) {
      console.error('[shopBot callback] error:', e.message);
      try { await shopBot.answerCallbackQuery(q.id, { text: 'Ошибка: ' + e.message, show_alert: true }); } catch(_){}
    }
  });

  shopBot.on('polling_error', (err) => {
    if (!err.message?.includes('409')) console.log('SHOP BOT error:', err.message);
  });

  console.log('🏪 SHOP BOT запущен');
}

// ─────────────────────────────────────────────
// ✅ Уведомление клиенту: чек подтверждён админом
// ─────────────────────────────────────────────
async function notifyCustomerPaymentConfirmed(order) {
  console.log('[notifyCustomerPaymentConfirmed] called for order', order?.id, 'customer_chat_id:', order?.customer_chat_id);
  if (!userBot && !ensureUserBot()) { console.log('[notifyCustomerPaymentConfirmed] userBot is null — skipping'); return; }
  if (!order) { console.log('[notifyCustomerPaymentConfirmed] order is null — skipping'); return; }
  if (!order.customer_chat_id) {
    console.log('[notifyCustomerPaymentConfirmed] customer_chat_id missing for order', order.id);
    return;
  }

  const total = (Number(order.total) || 0).toLocaleString('ru');
  const text =
    `✅ <b>Чек подтверждён</b>\n\n` +
    `Ваш заказ <b>#${order.id}</b> принят администратором.\n` +
    `Магазин получил уведомление и уже начинает сборку.\n\n` +
    `💰 Сумма: ${total} сом`;

  try {
    await userBot.sendMessage(order.customer_chat_id, text, { parse_mode: 'HTML' });
  } catch (e) {
    console.log('[notifyCustomerPaymentConfirmed]', e.message);
  }
}

// ─────────────────────────────────────────────
// 📲 Красивые уведомления клиенту о смене статуса заказа
// ─────────────────────────────────────────────
async function notifyCustomerStatusChanged(order, shop) {
  console.log('[notifyCustomer] called for order', order?.id, 'status:', order?.status,
              'customer_chat_id:', order?.customer_chat_id,
              'delivery_photo_url:', order?.delivery_photo_url ? 'yes' : 'no');
  if (!userBot && !ensureUserBot()) { console.log('[notifyCustomer] userBot is null — skipping'); return; }
  if (!order) { console.log('[notifyCustomer] order is null — skipping'); return; }
  if (!order.customer_chat_id) {
    console.log('[notifyCustomer] customer_chat_id missing for order', order.id,
                '— клиент не открывал Telegram Mini App или столбец БД пуст. Уведомление не отправлено.');
    return;
  }
  const shopName = shop?.shop_name || 'Магазин';
  const orderId = order.id;

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
      await userBot.sendMessage(order.customer_chat_id, text, { parse_mode: 'HTML' });
    } catch (e) { console.log('[notifyCustomer]', e.message); }
    return;
  }

  // Ready — отправляем фотоотчёт
  if (order.status === 'ready') {
    const text = `📸 <b>Ваш букет готов!</b>\n\n<b>${shopName}</b> прислал фото-отчёт. Заказ скоро будет в пути! 🚚\n\n📦 Заказ #${orderId}`;
    try {
      if (order.delivery_photo_url) {
        await userBot.sendPhoto(order.customer_chat_id, order.delivery_photo_url, { caption: text, parse_mode: 'HTML' });
      } else {
        await userBot.sendMessage(order.customer_chat_id, text, { parse_mode: 'HTML' });
      }
    } catch (e) { console.log('[notifyCustomer ready]', e.message); }
    return;
  }

  // Delivered — кнопки подтверждения / проблемы
  if (order.status === 'delivered') {
    const text = `🚚 <b>Ваш заказ доставлен!</b>\n\nПожалуйста, подтвердите получение в течение <b>2 часов</b>. Если не подтвердите — заказ будет автоматически отмечен как полученный.\n\n📦 Заказ #${orderId}\n💐 ${shopName}`;
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
        await userBot.sendPhoto(order.customer_chat_id, order.delivery_photo_url, { caption: text, ...opts });
      } else {
        await userBot.sendMessage(order.customer_chat_id, text, opts);
      }
    } catch (e) { console.log('[notifyCustomer delivered]', e.message); }
    return;
  }

  // Refunded
  if (order.status === 'refunded') {
    try {
      await userBot.sendMessage(order.customer_chat_id,
        `✅ <b>Возврат оформлен</b>\n\nЗаказ #${orderId} — деньги будут возвращены. Свяжитесь с @rebuket_admin для уточнений.`,
        { parse_mode: 'HTML' });
    } catch(_) {}
    return;
  }
}

// ─────────────────────────────────────────────
// 👤 Customer callbacks: подтверждение / проблема
// ─────────────────────────────────────────────
function setupCustomerOrderHandlers() {
  if (!userBot) return;

  userBot.on('callback_query', async (q) => {
    const data = q.data || '';
    const m = data.match(/^cust_(confirm|problem):(.+)$/);
    if (!m) return;
    const [, action, orderId] = m;
    const chatId = q.message.chat.id;

    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();

      if (action === 'confirm') {
        const { data: updated } = await db.from('orders')
          .update({ status: 'confirmed_received', confirmed_at: new Date().toISOString() })
          .eq('id', orderId).eq('customer_chat_id', chatId)
          .select().single();
        if (!updated) {
          await userBot.answerCallbackQuery(q.id, { text: 'Заказ не найден', show_alert: true });
          return;
        }
        await userBot.answerCallbackQuery(q.id, { text: '✅ Спасибо!' });
        await userBot.sendMessage(chatId, `🌟 <b>Спасибо за заказ!</b>\n\nНадеемся, букет вам понравился! Оставьте отзыв @rebuket_admin.`, { parse_mode: 'HTML' });

        // Notify shop
        try {
          let items = updated.items;
          if (typeof items === 'string') items = JSON.parse(items);
          const sellerPhones = [...new Set((items||[]).map(it => it.seller_phone).filter(Boolean))];
          const { data: shops } = await db.from('shops').select('telegram_chat_id, shop_name').in('phone', sellerPhones);
          for (const s of shops || []) {
            if (s.telegram_chat_id && shopBot) {
              await shopBot.sendMessage(s.telegram_chat_id, `🌟 Клиент подтвердил получение заказа #${orderId}!`).catch(_=>{});
            }
          }
        } catch(_){}
      } else if (action === 'problem') {
        // Запрашиваем причину
        customerPendingRefundReason.set(chatId, orderId);
        await userBot.answerCallbackQuery(q.id, { text: 'Опишите проблему' });
        await userBot.sendMessage(chatId,
          `⚠️ <b>Опишите проблему с заказом #${orderId}</b>\n\nНапишите одним сообщением — что не так? Можете прикрепить фото следующим сообщением.\n\nПосле этого магазин рассмотрит запрос на возврат.\n\n<i>Отмена: /cancel</i>`,
          { parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('[userBot order callback]', e.message);
      try { await userBot.answerCallbackQuery(q.id, { text: 'Ошибка', show_alert: true }); } catch(_){}
    }
  });

  // /cancel для customer refund flow
  userBot.onText(/\/cancel/, async (msg) => {
    if (customerPendingRefundReason.has(msg.chat.id)) {
      customerPendingRefundReason.delete(msg.chat.id);
      await userBot.sendMessage(msg.chat.id, '↩️ Запрос на возврат отменён.');
    }
  });

  // Текст-сообщение от клиента, ожидающего ввода причины
  userBot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const orderId = customerPendingRefundReason.get(chatId);
    if (!orderId) return;
    customerPendingRefundReason.delete(chatId);

    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const reason = msg.text.trim().slice(0, 1000);

      const { data: updated } = await db.from('orders')
        .update({ status: 'refund_requested', refund_reason: reason })
        .eq('id', orderId).eq('customer_chat_id', chatId)
        .select().single();
      if (!updated) {
        await userBot.sendMessage(chatId, '❌ Заказ не найден.');
        return;
      }
      await userBot.sendMessage(chatId, `✅ <b>Запрос на возврат отправлен</b>\n\nМагазин рассмотрит ваше обращение и свяжется с админом.\n\n📦 Заказ #${orderId}\n📝 Причина: ${reason}`, { parse_mode: 'HTML' });

      // Notify shop with reason + approve/dispute buttons
      try {
        let items = updated.items;
        if (typeof items === 'string') items = JSON.parse(items);
        const sellerPhones = [...new Set((items||[]).map(it => it.seller_phone).filter(Boolean))];
        const { data: shops } = await db.from('shops').select('telegram_chat_id, shop_name, phone').in('phone', sellerPhones);
        const shopText = `⚠️ <b>Запрос на возврат от клиента</b>\n\n📦 Заказ #${orderId}\n💰 ${(Number(updated.total)||0).toLocaleString('ru')} сом\n\n📝 <b>Причина:</b>\n${reason}\n\nПосле одобрения возврата клиент получит деньги обратно, а вы — товар.`;
        for (const s of shops || []) {
          if (s.telegram_chat_id && shopBot) {
            await shopBot.sendMessage(s.telegram_chat_id, shopText, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Одобрить возврат', callback_data: `shop_refund_approve:${orderId}` },
                  { text: '⚠️ Оспорить',         callback_data: `shop_refund_dispute:${orderId}` }
                ]]
              }
            }).catch(_=>{});
          }
        }
      } catch(e) { console.log('refund notify shop err:', e.message); }

      // Also notify admin
      try {
        for (const adminChat of adminChatIds) {
          if (adminBot) await adminBot.sendMessage(adminChat, `⚠️ Возврат запрошен: заказ #${orderId}\nПричина: ${reason}`).catch(_=>{});
        }
      } catch(_){}
    } catch (e) {
      console.error('[userBot refund reason]', e.message);
    }
  });
}

// ─────────────────────────────────────────────
// ⏱ Авто-подтверждение получения через 2 часа после доставки
// ─────────────────────────────────────────────
function startAutoConfirmInterval() {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const cutoff = new Date(Date.now() - TWO_HOURS_MS).toISOString();
      const { data: orders } = await db.from('orders')
        .select('id, customer_chat_id')
        .eq('status', 'delivered')
        .lt('delivered_at', cutoff)
        .limit(50);
      for (const o of orders || []) {
        await db.from('orders').update({ status: 'confirmed_received', confirmed_at: new Date().toISOString() }).eq('id', o.id);
        if (o.customer_chat_id && userBot) {
          await userBot.sendMessage(o.customer_chat_id, `✅ Заказ #${o.id} автоматически подтверждён (прошло 2 часа). Спасибо за покупку!`).catch(_=>{});
        }
      }
    } catch (e) { console.log('[auto-confirm interval]', e.message); }
  }, 10 * 60 * 1000); // каждые 10 минут
  console.log('⏱ Auto-confirm interval запущен (каждые 10 мин)');
}

// ─────────────────────────────────────────────
//  💬 ORDER CHAT RELAY — customer ↔ shop via bots
//  Activated after admin confirms payment.
// ─────────────────────────────────────────────

async function activateOrderChatFlow(order) {
  if (!order || !order.id) return;
  try { await Chat.activateOrderChat(order.id); } catch (e) { console.log('[chat.activate] err:', e.message); }

  // Persist a system "chat opened" message
  try {
    await Chat.persistMessage({
      order_id: order.id,
      sender: 'system',
      text: 'Оплата подтверждена. Чат с магазином активирован.',
    });
  } catch (_) {}

  // Activate session for customer
  if (order.customer_chat_id) {
    try { await Chat.setActiveChat(order.customer_chat_id, 'customer', order.id, null); } catch (_) {}
  }

  // Activate session(s) for shop(s)
  let items = order.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
  const sellerPhones = [...new Set((items || []).map(it => (it.seller_phone || '').toString().trim()).filter(Boolean))];
  if (sellerPhones.length) {
    try {
      const { createSupabaseClient } = require('../db/supabase');
      const db = createSupabaseClient();
      const { data: shops } = await db.from('shops').select('phone, telegram_chat_id, shop_name').in('phone', sellerPhones);
      for (const s of shops || []) {
        if (s.telegram_chat_id) {
          await Chat.setActiveChat(s.telegram_chat_id, 'shop', order.id, s.phone);
          if (shopBot) {
            try {
              await shopBot.sendMessage(s.telegram_chat_id,
                `💬 <b>Чат по заказу #${order.id} открыт</b>\n\nКлиент может писать вам сюда напрямую — все сообщения идут через бот, ваши Telegram-контакты не раскрываются.\n\n<i>Чтобы выйти из чата — отправьте /endchat</i>`,
                { parse_mode: 'HTML' }
              );
            } catch (_) {}
          }
        }
      }
    } catch (e) { console.log('[chat.activate shops] err:', e.message); }
  }

  // Notify customer with chat-opened CTA
  if (order.customer_chat_id && userBot) {
    try {
      await userBot.sendMessage(order.customer_chat_id,
        `✅ <b>Оплата подтверждена!</b>\n\n` +
        `📦 Заказ #${order.id}\n` +
        `💰 Сумма: ${(Number(order.total)||0).toLocaleString('ru')} сом\n\n` +
        `💬 <b>Чат с магазином открыт.</b>\nПросто пишите сообщения сюда — они будут переданы магазину. Telegram-контакты не раскрываются ни одной из сторон.\n\n` +
        `<i>Чтобы выйти из чата — отправьте /endchat</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { console.log('[chat.activate customer notify] err:', e.message); }
  }
}

// Called by REST API (chat.shopSendMessage): send shop's text to customer
async function relayShopToCustomer(order, msg) {
  if (!userBot || !order?.customer_chat_id || !msg?.text) return;
  const prefix = '💬 <b>Магазин:</b>\n';
  await userBot.sendMessage(order.customer_chat_id, prefix + escHtml(msg.text), { parse_mode: 'HTML' });
}

// Send a raw HTML message directly to a customer's Telegram chat (used by admin actions)
async function notifyCustomerRaw(chatId, html) {
  if (!userBot || !chatId || !html) return;
  try { await userBot.sendMessage(chatId, html, { parse_mode: 'HTML' }); } catch (e) { console.log('[notifyCustomerRaw]', e.message); }
}

// Send a raw HTML message directly to a shop's Telegram chat (used by admin actions)
async function notifyShopRaw(chatId, html) {
  if (!shopBot || !chatId || !html) return;
  try { await shopBot.sendMessage(chatId, html, { parse_mode: 'HTML' }); } catch (e) { console.log('[notifyShopRaw]', e.message); }
}

// Called by user-bot text handler: relay customer's text to shop(s)
async function relayCustomerToShop(order, text) {
  if (!shopBot || !text) return 0;
  let items = order.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
  const sellerPhones = [...new Set((items || []).map(it => (it.seller_phone || '').toString().trim()).filter(Boolean))];
  if (!sellerPhones.length) return 0;
  const { createSupabaseClient } = require('../db/supabase');
  const db = createSupabaseClient();
  const { data: shops } = await db.from('shops').select('phone, telegram_chat_id').in('phone', sellerPhones);
  let delivered = 0;
  const prefix = `💬 <b>Клиент (заказ #${order.id}):</b>\n`;
  for (const s of shops || []) {
    if (s.telegram_chat_id) {
      try {
        await shopBot.sendMessage(s.telegram_chat_id, prefix + escHtml(text), { parse_mode: 'HTML' });
        delivered++;
      } catch (e) { console.log('[relayCustomerToShop]', s.phone, e.message); }
    }
  }
  return delivered;
}

// ─────────────────────────────────────────────
//  Уведомление — магазин изменил публикацию
// ─────────────────────────────────────────────
async function notifyProductEdited(p, shopPhone) {
  const url = `${getMiniAppUrl()}/#product-${p.slug || p.id}`;
  const COMMISSION = p.category === 'sweets' ? 0.10 : 0.20;
  const sellerPrice = Number(p.price) || 0;
  const buyerPrice  = Math.ceil(sellerPrice * (1 + COMMISSION) / 10) * 10;

  const text =
    `✏️ <b>МАГАЗИН ИЗМЕНИЛ ПУБЛИКАЦИЮ</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${CATS[p.category] || p.category}: <b>${escHtml(p.title)}</b>\n\n` +
    `🏬 <b>Магазин:</b> ${escHtml(p.seller_name || shopPhone || '—')}\n` +
    `📞 <b>Телефон:</b> ${escHtml(p.seller_phone || shopPhone)}\n` +
    `📍 <b>Город:</b> ${escHtml(p.city || '—')}\n\n` +
    `💵 <b>Цена продавца:</b> ${sellerPrice.toLocaleString('ru')} TJS\n` +
    `💰 <b>Цена для покупателя:</b> ${buyerPrice.toLocaleString('ru')} TJS\n\n` +
    (p.description ? `📝 ${escHtml(p.description.substring(0, 120))}${p.description.length > 120 ? '…' : ''}\n\n` : '') +
    `🔗 <a href="${url}">Открыть объявление</a>`;

  await sendToAdmins(text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔗 Открыть объявление', url }]
      ]
    }
  });
}

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
  notifyCustomerStatusChanged,
  activateOrderChatFlow,
  relayShopToCustomer,
  relayCustomerToShop,
  notifyCustomerRaw,
  notifyShopRaw,
  savePendingInquiry,
  getPendingInquiry,
};
