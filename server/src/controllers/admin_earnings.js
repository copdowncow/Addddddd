'use strict';

const { getClient } = require('../db/supabase');
const Commission = require('../services/commission');

// Statuses considered as "completed revenue" (admin can see realized earnings)
const COMPLETED_STATUSES = ['confirmed_received', 'delivered', 'seller_accepted', 'preparing', 'ready'];
const COUNTED_STATUSES   = ['payment_confirmed', ...COMPLETED_STATUSES];

// GET /api/admin/earnings
//   ?from=ISO&to=ISO  (optional)
exports.getEarnings = async (req, res) => {
  const t0 = Date.now();
  try {
    const { from, to } = req.query;
    console.log('[admin.getEarnings] ▶ start', { from: from || null, to: to || null, COUNTED_STATUSES });
    let q = getClient().from('orders')
      .select('id, status, total, subtotal, platform_fee, seller_payout, commission_percent, delivery_fee, items, created_at')
      .in('status', COUNTED_STATUSES);
    if (from) q = q.gte('created_at', from);
    if (to)   q = q.lte('created_at', to);
    const { data: orders, error } = await q.order('created_at', { ascending: false }).limit(2000);
    if (error) { console.error('[admin.getEarnings] ✗ orders query error:', error); throw error; }
    console.log('[admin.getEarnings] orders fetched:', (orders || []).length);

    const totals = {
      orders: 0,
      revenue: 0,         // what customers paid (sum of order.total — minus delivery_fee = subtotal)
      gross: 0,           // sum of subtotal
      commission: 0,      // platform fees
      payouts: 0,         // money owed to sellers
      delivery: 0,        // sum of delivery_fee
      completed_orders: 0,
      completed_commission: 0,
    };
    const perShop = new Map();

    for (const o of orders || []) {
      totals.orders++;
      const subtotal     = Number(o.subtotal     || 0);
      const platform_fee = Number(o.platform_fee || 0);
      const seller_payout= Number(o.seller_payout|| 0);
      const delivery_fee = Number(o.delivery_fee || 0);
      totals.gross      += subtotal;
      totals.commission += platform_fee;
      totals.payouts    += seller_payout;
      totals.delivery   += delivery_fee;
      totals.revenue    += Number(o.total || 0);
      if (COMPLETED_STATUSES.includes(o.status)) {
        totals.completed_orders++;
        totals.completed_commission += platform_fee;
      }
      // per-shop breakdown using items
      let items = o.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
      for (const it of (items || [])) {
        const phone = (it.seller_phone || '').toString().trim();
        if (!phone) continue;
        const cur = perShop.get(phone) || { phone, orders: new Set(), gross: 0, commission: 0, payout: 0, items: 0 };
        cur.orders.add(o.id);
        cur.gross      += Number(it.line_total    || 0);
        cur.commission += Number(it.platform_fee  || 0);
        cur.payout     += Number(it.seller_payout || 0);
        cur.items += Number(it.qty || 1);
        perShop.set(phone, cur);
      }
    }

    // Resolve shop names
    const phones = [...perShop.keys()];
    let shopMeta = {};
    if (phones.length) {
      const { data: shops } = await getClient().from('shops').select('phone, shop_name, photo_url').in('phone', phones);
      for (const s of shops || []) shopMeta[s.phone] = s;
    }
    const by_shop = phones.map(p => {
      const c = perShop.get(p);
      const meta = shopMeta[p] || {};
      return {
        phone: p,
        shop_name: meta.shop_name || p,
        photo_url: meta.photo_url || null,
        orders: c.orders.size,
        items: c.items,
        gross:      Commission.round2(c.gross),
        commission: Commission.round2(c.commission),
        payout:     Commission.round2(c.payout),
      };
    }).sort((a, b) => b.gross - a.gross);

    const payload = {
      totals: {
        orders: totals.orders,
        revenue:    Commission.round2(totals.revenue),
        gross:      Commission.round2(totals.gross),
        commission: Commission.round2(totals.commission),
        payouts:    Commission.round2(totals.payouts),
        delivery:   Commission.round2(totals.delivery),
        completed_orders: totals.completed_orders,
        completed_commission: Commission.round2(totals.completed_commission),
      },
      by_shop,
      from: from || null,
      to:   to   || null,
    };
    console.log('[admin.getEarnings] ✓ done in', Date.now()-t0, 'ms', {
      orders: payload.totals.orders,
      revenue: payload.totals.revenue,
      commission: payload.totals.commission,
      shops: payload.by_shop.length,
    });
    res.json(payload);
  } catch (e) {
    console.error('[admin.getEarnings] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Ошибка' });
  }
};

// GET /api/admin/settings
exports.getSettings = async (req, res) => {
  try {
    console.log('[admin.getSettings] ▶ fetching platform settings');
    const s = await Commission.getPlatformSettings();
    console.log('[admin.getSettings] ✓', s);
    res.json(s);
  } catch (e) {
    console.error('[admin.getSettings] ✗', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// PATCH /api/admin/settings
exports.updateSettings = async (req, res) => {
  try {
    console.log('[admin.updateSettings] ▶ body:', req.body);
    const { default_commission_percent, taxi_fixed_fee } = req.body;
    const updates = {};
    if (default_commission_percent != null) {
      const n = Number(default_commission_percent);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        console.warn('[admin.updateSettings] ✗ bad commission:', default_commission_percent);
        return res.status(400).json({ error: 'Комиссия 0..100' });
      }
      updates.default_commission_percent = n;
    }
    if (taxi_fixed_fee != null) {
      const n = Number(taxi_fixed_fee);
      if (Number.isNaN(n) || n < 0) {
        console.warn('[admin.updateSettings] ✗ bad taxi_fee:', taxi_fixed_fee);
        return res.status(400).json({ error: 'Доставка >= 0' });
      }
      updates.taxi_fixed_fee = n;
    }
    if (!Object.keys(updates).length) {
      console.warn('[admin.updateSettings] ✗ empty updates');
      return res.status(400).json({ error: 'Нет данных' });
    }
    updates.updated_at = new Date().toISOString();
    console.log('[admin.updateSettings] applying updates:', updates);
    const { data, error } = await getClient()
      .from('platform_settings')
      .update(updates)
      .eq('id', 1)
      .select()
      .single();
    if (error) { console.error('[admin.updateSettings] ✗ db error:', error); throw error; }
    Commission.invalidateSettingsCache();
    console.log('[admin.updateSettings] ✓ saved:', data);
    res.json(data);
  } catch (e) {
    console.error('[admin.updateSettings] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// GET /api/admin/disputes  — orders in refund_requested / refund_disputed
exports.listDisputes = async (req, res) => {
  const t0 = Date.now();
  try {
    const { status, search } = req.query;
    const wanted = status ? [status] : ['refund_requested', 'refund_disputed'];
    console.log('[admin.listDisputes] ▶', { wanted, search: search || null });
    let q = getClient()
      .from('orders')
      .select('*')
      .in('status', wanted)
      .order('created_at', { ascending: false })
      .limit(200);
    const { data, error } = await q;
    if (error) { console.error('[admin.listDisputes] ✗ db error:', error); throw error; }
    console.log('[admin.listDisputes] orders found:', (data || []).length);
    let rows = data || [];
    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter(o =>
        (o.customer_phone || '').toLowerCase().includes(s) ||
        (o.refund_reason  || '').toLowerCase().includes(s) ||
        (o.id || '').toLowerCase().includes(s)
      );
    }
    // Resolve shop info for each order
    const phones = new Set();
    for (const o of rows) {
      let items = o.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
      for (const it of (items || [])) if (it.seller_phone) phones.add(it.seller_phone);
    }
    let shopMap = {};
    if (phones.size) {
      const { data: shops } = await getClient()
        .from('shops')
        .select('phone, shop_name, photo_url, telegram_chat_id')
        .in('phone', [...phones]);
      for (const s of shops || []) shopMap[s.phone] = s;
    }
    const enriched = rows.map(o => {
      let items = o.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
      const sellerPhone = (items || [])[0]?.seller_phone;
      return { ...o, items, shop: sellerPhone ? shopMap[sellerPhone] : null };
    });
    console.log('[admin.listDisputes] ✓ done in', Date.now()-t0, 'ms — returning', enriched.length, 'rows');
    res.json({ data: enriched });
  } catch (e) {
    console.error('[admin.listDisputes] ✗ FATAL', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
};

// PATCH /api/admin/orders/:id/dispute-resolve
//   body: { action: 'refund' | 'reject', note?: string }
//     'refund' → status='refunded' (customer gets money back)
//     'reject' → status='confirmed_received' (close in shop's favor)
exports.resolveDispute = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, note } = req.body;
    console.log('[admin.resolveDispute] ▶', { id, action, note: note || null });
    if (!['refund', 'reject'].includes(action)) {
      console.warn('[admin.resolveDispute] ✗ bad action:', action);
      return res.status(400).json({ error: 'action: refund | reject' });
    }
    const newStatus = action === 'refund' ? 'refunded' : 'confirmed_received';

    const { data: order, error: fetchErr } = await getClient()
      .from('orders')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr || !order) return res.status(404).json({ error: 'Заказ не найден' });

    const updates = { status: newStatus };
    if (action === 'reject') updates.confirmed_at = new Date().toISOString();

    const { data: updated, error } = await getClient()
      .from('orders')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // Persist system message in chat history (audit trail)
    try {
      const Chat = require('../services/chat');
      await Chat.persistMessage({
        order_id: id,
        sender: 'admin',
        text: (action === 'refund'
          ? '✅ Администратор: возврат одобрен. Деньги будут возвращены клиенту.'
          : '✅ Администратор: спор закрыт в пользу магазина.') + (note ? '\nКомментарий: ' + note : ''),
      });
    } catch (_) {}

    // Notify both sides via bots
    try {
      const { notifyCustomerRaw, notifyShopRaw } = require('../services/telegram');
      const escHtml = s => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
      let items = updated.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }

      const customerHtml = action === 'refund'
        ? `✅ <b>Возврат одобрен администратором</b>\n\nЗаказ #${id}\n${note ? '\nКомментарий: ' + escHtml(note) + '\n' : ''}\nДеньги будут возвращены в течение нескольких дней. По любым вопросам — @rebuket_admin.`
        : `ℹ️ <b>Спор закрыт</b>\n\nАдминистратор рассмотрел ваш запрос по заказу #${id} в пользу магазина.\n${note ? '\nКомментарий: ' + escHtml(note) + '\n' : ''}\nЕсли нужны уточнения — @rebuket_admin.`;
      await notifyCustomerRaw(updated.customer_chat_id, customerHtml).catch(() => {});

      const sellerPhones = [...new Set((items || []).map(it => (it.seller_phone || '').toString().trim()).filter(Boolean))];
      if (sellerPhones.length) {
        const { data: shops } = await getClient()
          .from('shops')
          .select('telegram_chat_id, phone, shop_name')
          .in('phone', sellerPhones);
        const shopHtml = action === 'refund'
          ? `⚠️ <b>Возврат одобрен администратором</b>\n\nЗаказ #${id}\n${note ? '\nКомментарий: ' + escHtml(note) + '\n' : ''}\nДеньги будут возвращены клиенту. Подробности — @rebuket_admin.`
          : `✅ <b>Спор закрыт в вашу пользу</b>\n\nЗаказ #${id}\n${note ? '\nКомментарий: ' + escHtml(note) + '\n' : ''}`;
        for (const s of shops || []) {
          if (s.telegram_chat_id) {
            await notifyShopRaw(s.telegram_chat_id, shopHtml).catch(() => {});
          }
        }
      }
    } catch (e) { console.error('[resolveDispute] notify err:', e.message); }

    res.json({ ok: true, order: updated });
  } catch (e) {
    console.error('[admin.resolveDispute]', e);
    res.status(500).json({ error: e.message });
  }
};

// GET /api/platform-settings  (public — used by checkout to know taxi_fixed_fee)
exports.getPublicSettings = async (req, res) => {
  try {
    const s = await Commission.getPlatformSettings();
    const payload = {
      default_commission_percent: Number(s.default_commission_percent || 20),
      taxi_fixed_fee: Number(s.taxi_fixed_fee || 50),
    };
    console.log('[platform.getPublicSettings] ✓', payload);
    res.json(payload);
  } catch (e) {
    console.error('[platform.getPublicSettings] ✗', e.message);
    res.status(500).json({ error: e.message });
  }
};
