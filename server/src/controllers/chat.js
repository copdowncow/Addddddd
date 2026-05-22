'use strict';

const Chat = require('../services/chat');
const { getClient } = require('../db/supabase');

// GET /api/chat/orders/:id/messages   (shop auth — shop can list its own order messages)
exports.shopListMessages = async (req, res) => {
  try {
    const orderId = req.params.id;
    const shop = req.shop;
    const order = await Chat.getOrderForChat(orderId);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    let items = order.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
    const owns = Array.isArray(items) && items.some(it => (it.seller_phone || '').toString().trim() === shop.phone);
    if (!owns) return res.status(403).json({ error: 'Нет доступа к чату' });
    const msgs = await Chat.listMessages(orderId);
    res.json({ data: msgs, chat_active: !!order.chat_active });
  } catch (e) {
    console.error('[chat.shopListMessages]', e);
    res.status(500).json({ error: e.message });
  }
};

// POST /api/chat/orders/:id/messages   (shop auth — shop sends a message to customer)
exports.shopSendMessage = async (req, res) => {
  try {
    const orderId = req.params.id;
    const shop = req.shop;
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустое сообщение' });

    const order = await Chat.getOrderForChat(orderId);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    if (!order.chat_active) return res.status(400).json({ error: 'Чат ещё не активирован (ожидается подтверждение оплаты)' });

    let items = order.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
    const owns = Array.isArray(items) && items.some(it => (it.seller_phone || '').toString().trim() === shop.phone);
    if (!owns) return res.status(403).json({ error: 'Нет доступа к чату' });

    const msg = await Chat.persistMessage({
      order_id: orderId,
      sender: 'shop',
      sender_phone: shop.phone,
      text: text.trim().slice(0, 2000),
    });

    // Relay to customer via user bot
    try {
      const { relayShopToCustomer } = require('../services/telegram');
      await relayShopToCustomer(order, msg);
      await Chat.markDelivered(msg.id);
    } catch (e) {
      console.error('[chat.shopSendMessage relay]', e.message);
    }

    res.json({ ok: true, message: msg });
  } catch (e) {
    console.error('[chat.shopSendMessage]', e);
    res.status(500).json({ error: e.message });
  }
};

// GET /api/admin/chat/orders/:id/messages  (admin auth)
exports.adminListMessages = async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await Chat.getOrderForChat(orderId);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    const msgs = await Chat.listMessages(orderId);
    res.json({ data: msgs, chat_active: !!order.chat_active, order });
  } catch (e) {
    console.error('[chat.adminListMessages]', e);
    res.status(500).json({ error: e.message });
  }
};
