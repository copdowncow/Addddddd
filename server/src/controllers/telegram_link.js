'use strict';

const { registerCustomerFromTelegram } = require('../services/telegram');

// POST /api/telegram/link-customer — привязка chat_id из Telegram Mini App
exports.linkCustomer = async (req, res) => {
  try {
    const { chat_id, username, phone, order_id } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'chat_id обязателен' });

    await registerCustomerFromTelegram({
      chatId: chat_id,
      username: username || null,
      phone: phone || null,
      orderId: order_id || null,
    });

    res.json({ ok: true, chat_id: Number(chat_id) });
  } catch (e) {
    console.error('[linkCustomer]', e);
    res.status(500).json({ error: e.message });
  }
};
