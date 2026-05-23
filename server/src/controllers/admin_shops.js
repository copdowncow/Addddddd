'use strict';

const bcrypt = require('bcryptjs');
const { getClient } = require('../db/supabase');

// GET /api/admin/shops
//   ?status=pending|active|rejected   ?search=string
exports.listShops = async (req, res) => {
  const t0 = Date.now();
  try {
    const { status, search } = req.query;
    console.log('[admin.listShops] ▶', { status: status || 'all', search: search || null });
    let q = getClient()
      .from('shops')
      .select('id, phone, shop_name, city, telegram, status, photo_url, description, delivery_info, categories, verified, rating, rating_count, commission_percent, telegram_chat_id, is_blocked, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) { console.error('[admin.listShops] ✗ db error:', error); throw error; }
    console.log('[admin.listShops] shops fetched:', (data || []).length);
    let rows = data || [];
    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter(sh =>
        (sh.phone || '').toLowerCase().includes(s) ||
        (sh.shop_name || '').toLowerCase().includes(s) ||
        (sh.city || '').toLowerCase().includes(s)
      );
    }

    // Per-shop stats: order count + product count + completed payouts
    const phones = rows.map(r => r.phone).filter(Boolean);
    const stats = {};
    if (phones.length) {
      // Products per shop
      const { data: prods } = await getClient()
        .from('products')
        .select('seller_phone, status')
        .in('seller_phone', phones);
      for (const p of prods || []) {
        const k = p.seller_phone;
        if (!stats[k]) stats[k] = { products: 0, products_active: 0, orders: 0, payout: 0 };
        stats[k].products++;
        if (p.status === 'active') stats[k].products_active++;
      }
      // Orders: scan items, sum per phone
      const { data: orders } = await getClient()
        .from('orders')
        .select('id, status, items')
        .in('status', ['payment_confirmed', 'seller_accepted', 'preparing', 'ready', 'delivered', 'confirmed_received']);
      for (const o of orders || []) {
        let items = o.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
        for (const it of (items || [])) {
          const ph = (it.seller_phone || '').trim();
          if (!ph || !stats[ph]) continue;
          stats[ph].orders++;
          stats[ph].payout += Number(it.seller_payout || 0);
        }
      }
    }

    const enriched = rows.map(s => ({
      ...s,
      stats: stats[s.phone] || { products: 0, products_active: 0, orders: 0, payout: 0 },
      bot_connected: !!s.telegram_chat_id,
    }));
    console.log('[admin.listShops] ✓ done in', Date.now()-t0, 'ms — returning', enriched.length, 'shops');
    res.json({ data: enriched });
  } catch (e) {
    console.error('[admin.listShops] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// PATCH /api/admin/shops/:id
//   body: { status?, verified?, commission_percent?, shop_name?, city?, delivery_info?, telegram? }
exports.updateShop = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[admin.updateShop] ▶ id=', id, 'body:', req.body);
    const allowed = ['status', 'verified', 'commission_percent', 'shop_name', 'city', 'delivery_info', 'telegram'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (updates.status && !['pending', 'active', 'rejected'].includes(updates.status)) {
      console.warn('[admin.updateShop] ✗ bad status:', updates.status);
      return res.status(400).json({ error: 'Неверный статус' });
    }
    if (updates.commission_percent != null) {
      const n = Number(updates.commission_percent);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        console.warn('[admin.updateShop] ✗ bad commission:', updates.commission_percent);
        return res.status(400).json({ error: 'Комиссия 0..100 или null' });
      }
      updates.commission_percent = n;
    }
    if (updates.verified !== undefined) updates.verified = !!updates.verified;

    if (!Object.keys(updates).length) {
      console.warn('[admin.updateShop] ✗ empty updates');
      return res.status(400).json({ error: 'Нет данных' });
    }

    console.log('[admin.updateShop] applying updates:', updates);
    const { data, error } = await getClient()
      .from('shops')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) { console.error('[admin.updateShop] ✗ db error:', error); throw error; }
    console.log('[admin.updateShop] ✓ saved shop:', { id: data.id, phone: data.phone, status: data.status });

    // If status changed, send a Telegram notification
    if (updates.status === 'active') {
      try {
        const { notifyShopApproved } = require('../services/telegram');
        await notifyShopApproved(data);
      } catch (_) {}
    } else if (updates.status === 'rejected') {
      try {
        const { notifyShopRejected } = require('../services/telegram');
        await notifyShopRejected(data);
      } catch (_) {}
    }

    res.json({ ok: true, shop: data });
  } catch (e) {
    console.error('[admin.updateShop] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// POST /api/admin/shops/:id/reset-password
//   body: { new_password }
exports.resetShopPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;
    console.log('[admin.resetShopPassword] ▶ id=', id, 'pwLen=', (new_password || '').length);
    if (!new_password || new_password.length < 6) {
      console.warn('[admin.resetShopPassword] ✗ password too short');
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }
    const password_hash = await bcrypt.hash(new_password, 10);
    const { data, error } = await getClient()
      .from('shops')
      .update({ password_hash })
      .eq('id', id)
      .select('id, phone, shop_name')
      .single();
    if (error) { console.error('[admin.resetShopPassword] ✗ db error:', error); throw error; }
    console.log('[admin.resetShopPassword] ✓ reset for shop:', data);
    res.json({ ok: true, shop: data });
  } catch (e) {
    console.error('[admin.resetShopPassword] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// DELETE /api/admin/shops/:id  — полностью удалить магазин
exports.deleteShop = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[admin.deleteShop] ▶ id=', id);
    
    // Сначала получаем данные магазина для уведомления
    const { data: shop, error: fetchError } = await getClient()
      .from('shops')
      .select('*')
      .eq('id', id)
      .single();
    
    if (fetchError || !shop) {
      console.error('[admin.deleteShop] ✗ shop not found:', fetchError);
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    // Удаляем связанные товары
    await getClient()
      .from('products')
      .delete()
      .eq('seller_phone', shop.phone);

    // Удаляем магазин
    const { error } = await getClient()
      .from('shops')
      .delete()
      .eq('id', id);
    
    if (error) { console.error('[admin.deleteShop] ✗ db error:', error); throw error; }
    console.log('[admin.deleteShop] ✓ deleted shop:', { id: shop.id, phone: shop.phone });
    
    // Отправляем уведомление в Telegram если есть chat_id
    if (shop.telegram_chat_id) {
      try {
        const { sendToShopChat } = require('../services/telegram');
        await sendToShopChat(shop.telegram_chat_id, 
          `⚠️ <b>Ваш магазин был удалён</b>\n\n` +
          `Магазин: ${shop.shop_name || shop.phone}\n` +
          `Если у вас есть вопросы, обратитесь к @rebuket_admin`
        );
      } catch (e) {
        console.log('[admin.deleteShop] notification failed:', e.message);
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin.deleteShop] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// PATCH /api/admin/shops/:id/block  — заблокировать магазин (is_blocked=true)
exports.blockShop = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[admin.blockShop] ▶ id=', id);
    const { data, error } = await getClient()
      .from('shops')
      .update({ is_blocked: true })
      .eq('id', id)
      .select()
      .single();
    if (error) { console.error('[admin.blockShop] ✗ db error:', error); throw error; }
    console.log('[admin.blockShop] ✓ blocked shop:', { id: data.id, phone: data.phone });
    
    // Отправляем уведомление в Telegram если есть chat_id
    if (data.telegram_chat_id) {
      try {
        const { sendToShopChat } = require('../services/telegram');
        await sendToShopChat(data.telegram_chat_id, 
          `🚫 <b>Ваш магазин заблокирован</b>\n\n` +
          `Магазин: ${data.shop_name || data.phone}\n\n` +
          `Для разблокировки обратитесь к @rebuket_admin`
        );
      } catch (e) {
        console.log('[admin.blockShop] notification failed:', e.message);
      }
    }
    
    res.json({ ok: true, shop: data });
  } catch (e) {
    console.error('[admin.blockShop] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// PATCH /api/admin/shops/:id/unblock  — разблокировать магазин (is_blocked=false)
exports.unblockShop = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[admin.unblockShop] ▶ id=', id);
    const { data, error } = await getClient()
      .from('shops')
      .update({ is_blocked: false })
      .eq('id', id)
      .select()
      .single();
    if (error) { console.error('[admin.unblockShop] ✗ db error:', error); throw error; }
    console.log('[admin.unblockShop] ✓ unblocked shop:', { id: data.id, phone: data.phone });
    
    // Отправляем уведомление в Telegram если есть chat_id
    if (data.telegram_chat_id) {
      try {
        const { sendToShopChat } = require('../services/telegram');
        await sendToShopChat(data.telegram_chat_id, 
          `✅ <b>Ваш магазин разблокирован</b>\n\n` +
          `Магазин: ${data.shop_name || data.phone}\n\n` +
          `Вы снова можете принимать заказы.`
        );
      } catch (e) {
        console.log('[admin.unblockShop] notification failed:', e.message);
      }
    }
    
    res.json({ ok: true, shop: data });
  } catch (e) {
    console.error('[admin.unblockShop] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// DELETE /api/admin/shops/:id  — soft "ban": set status=rejected (deprecated, use blockShop instead)
exports.banShop = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[admin.banShop] ▶ id=', id);
    const { data, error } = await getClient()
      .from('shops')
      .update({ status: 'rejected' })
      .eq('id', id)
      .select()
      .single();
    if (error) { console.error('[admin.banShop] ✗ db error:', error); throw error; }
    console.log('[admin.banShop] ✓ banned shop:', { id: data.id, phone: data.phone });
    try {
      const { notifyShopRejected } = require('../services/telegram');
      await notifyShopRejected(data);
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin.banShop] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};
