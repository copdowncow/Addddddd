'use strict';

const { getClient, uploadPhoto } = require('../db/supabase');
const sharp = require('sharp');
const { notifyAdminAboutOrder } = require('../services/telegram');
const Commission = require('../services/commission');

async function processImage(file) {
  let buffer = file.buffer;
  const name = (file.originalname || '').toLowerCase();

  try {
    const output = await sharp(buffer)
      .rotate()
      .resize(1200, 1200, { fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer();

    return output;
  } catch (e) {
    console.error('Image error:', e.message);
    throw new Error('Ошибка обработки изображения');
  }
}

exports.createOrder = async (req, res) => {
  try {
    const {
      customer_phone,
      customer_name,
      customer_address,
      delivery_type,
      delivery_payer,        // 'buyer' | 'fixed' (only meaningful for delivery_type=taxi)
      total,
      items,
      receiver_name,
      receiver_phone,
      receiver_address,
      customer_chat_id,
      customer_telegram,
      fast_order,
      delivery_time,
    } = req.body;

    const receiptFile = req.file;

    if (!customer_phone || !customer_address || !delivery_type || !items) {
      return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }

    // Normalize phone number for consistency
    const normalizedPhone = customer_phone.replace(/[^\d+]/g, '');
    const phoneWithPlus = normalizedPhone.startsWith('+') ? normalizedPhone : '+' + normalizedPhone;

    if (!receiptFile) {
      return res.status(400).json({ error: 'Загрузите чек оплаты' });
    }

    // Validate items: only shop products (sellers registered in shops) allowed
    let parsedItems;
    try {
      parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный формат items' });
    }
    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      return res.status(400).json({ error: 'Корзина пуста' });
    }

    // Get active shop phones + per-shop commission overrides
    const { data: activeShops } = await getClient()
      .from('shops')
      .select('phone, commission_percent')
      .eq('status', 'active');
    const { phoneDigits } = require('../services/telegram');
    const shopByPhone = new Map();
    for (const s of (activeShops || [])) {
      const raw = (s.phone || '').toString().trim();
      shopByPhone.set(raw, s);
      const digits = phoneDigits(raw);
      if (digits) shopByPhone.set(digits, s);
    }
    const shopPhoneSet = new Set(shopByPhone.keys());

    // Fetch full product details for commission + integrity check
    const productIds = parsedItems.map(it => it.id || it.pub_id).filter(Boolean);
    const productById = new Map();
    if (productIds.length > 0) {
      const { data: prods } = await getClient()
        .from('products')
        .select('id, seller_phone, title, price, commission_percent, pricing_mode')
        .in('id', productIds);
      for (const p of (prods || [])) productById.set(p.id, p);
      const ecoItems = (prods || []).filter(p => {
        const sp = (p.seller_phone || '').toString().trim();
        return !shopPhoneSet.has(sp) && !shopPhoneSet.has(phoneDigits(sp));
      });
      if (ecoItems.length > 0) {
        return res.status(400).json({
          error: 'В корзине есть эко-товары. Эко-товары заказываются через Telegram, а не через корзину.',
          eco_items: ecoItems.map(p => p.title)
        });
      }
    }

    // ── Commission breakdown per item ──────────────────────
    const settings = await Commission.getPlatformSettings();
    let subtotal = 0;
    let platform_fee_total = 0;
    let seller_payout_total = 0;
    let commission_percent_sample = null;

    const enrichedItems = parsedItems.map(it => {
      const pid = it.id || it.pub_id;
      const prod = productById.get(pid);
      const sellerPhone = (it.seller_phone || prod?.seller_phone || '').toString().trim();
      const shop = shopByPhone.get(sellerPhone) || shopByPhone.get(phoneDigits(sellerPhone));
      const pct = Commission.effectivePercent(prod, shop, settings);
      const mode = Commission.effectiveMode(prod);
      // Trust DB price over client-supplied to prevent tampering
      const listed = Number(prod?.price ?? it.price) || 0;
      const qty = Math.max(1, Number(it.qty || 1));
      const br = Commission.calculate(listed, pct, mode);
      const lineCustomer = Commission.round2(br.customer_pays * qty);
      const linePlatform = Commission.round2(br.platform_fee * qty);
      const linePayout   = Commission.round2(br.seller_payout * qty);
      subtotal += lineCustomer;
      platform_fee_total += linePlatform;
      seller_payout_total += linePayout;
      commission_percent_sample = pct;
      return {
        ...it,
        id: pid,
        seller_phone: sellerPhone,
        price: br.customer_pays,         // what customer pays per unit
        qty,
        commission_percent: pct,
        pricing_mode: br.pricing_mode,
        platform_fee: linePlatform,
        seller_payout: linePayout,
        line_total: lineCustomer,
      };
    });
    subtotal = Commission.round2(subtotal);
    platform_fee_total = Commission.round2(platform_fee_total);
    seller_payout_total = Commission.round2(seller_payout_total);

    // ── Delivery payer + fee ───────────────────────────────
    let final_delivery_payer = 'pickup';
    let delivery_fee = 0;
    if (delivery_type === 'taxi') {
      if (delivery_payer === 'fixed') {
        final_delivery_payer = 'fixed';
        delivery_fee = Number(settings.taxi_fixed_fee) || 50;
      } else {
        // default: buyer pays taxi separately to driver — 0 in order total
        final_delivery_payer = 'buyer';
        delivery_fee = 0;
      }
    } else if (delivery_type === 'pickup') {
      final_delivery_payer = 'pickup';
    }

    const total_final = Commission.round2(subtotal + delivery_fee);

    // Optional client-provided total: warn if drastically different but trust server calc
    if (total && Math.abs(Number(total) - total_final) > 1) {
      console.warn('[createOrder] client total', total, 'differs from server-computed', total_final);
    }

    // Process and upload receipt
    const processed = await processImage(receiptFile);
    const receipt_url = await uploadPhoto(processed, `receipt-${Date.now()}.jpg`, 'image/jpeg');

    const customerTelegram = customer_telegram
      ? (customer_telegram.toString().trim().startsWith('@')
          ? customer_telegram.toString().trim()
          : '@' + customer_telegram.toString().trim())
      : null;

    // Try to resolve customer_telegram to chat_id if customer_chat_id is not provided
    let finalChatId = customer_chat_id ? Number(customer_chat_id) : null;
    if (!finalChatId) {
      console.log('[createOrder] customer_chat_id missing, trying to resolve from phone/username');
      try {
        const { resolveChatId } = require('../services/telegram');
        finalChatId = await resolveChatId({
          phone: phoneWithPlus,
          username: customerTelegram,
        });
        if (finalChatId) {
          console.log('[createOrder] Resolved chat_id:', finalChatId);
        }
      } catch (e) {
        console.log('[createOrder] Error resolving chat_id:', e.message);
      }
    }

    const { data, error } = await getClient()
      .from('orders')
      .insert({
        customer_name: customer_name || null,
        customer_phone: phoneWithPlus,
        customer_address,
        delivery_type,
        delivery_payer: final_delivery_payer,
        delivery_fee,
        subtotal,
        commission_percent: commission_percent_sample,
        platform_fee: platform_fee_total,
        seller_payout: seller_payout_total,
        total: total_final,
        items: enrichedItems,
        receipt_url,
        receiver_name: receiver_name || null,
        receiver_phone: receiver_phone || null,
        receiver_address: receiver_address || null,
        customer_chat_id: finalChatId,
        customer_telegram: customerTelegram,
        fast_order: fast_order === 'true',
        delivery_time: delivery_time || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    if (finalChatId || customerTelegram) {
      try {
        const { registerCustomerFromTelegram, trySendToCustomer } = require('../services/telegram');
        await registerCustomerFromTelegram({
          chatId: finalChatId,
          username: customerTelegram,
          phone: phoneWithPlus,
          orderId: data.id,
        });
        if (finalChatId) {
          const ping = await trySendToCustomer(
            finalChatId,
            `🌸 <b>Заказ #${data.id} принят!</b>\n\nОжидайте подтверждения оплаты администратором.\nМы сообщим о каждом статусе здесь, в Telegram.`
          );
          if (!ping.ok) console.log('[createOrder] welcome ping failed:', ping.reason, ping.error);
        }
      } catch (e) {
        console.log('[createOrder] registerCustomerFromTelegram:', e.message);
      }
    }

    console.log('[createOrder] Order created, sending notification:', data.id);

    // Send notification to admin via Telegram
    try {
      await notifyAdminAboutOrder(data);
      console.log('[createOrder] Notification sent successfully');
    } catch (notifyErr) {
      console.error('Failed to send Telegram notification:', notifyErr);
    }

    res.status(201).json({
      ok: true,
      order: data,
      message: 'Заказ отправлен на подтверждение',
    });
  } catch (e) {
    console.error('[createOrder]', e);
    res.status(500).json({ error: e.message || 'Ошибка создания заказа' });
  }
};

exports.getOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Number(page) - 1) * lim;

    let query = getClient()
      .from('orders')
      .select('*', { count: 'exact' });

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) throw error;

    res.json({
      data: data || [],
      total: count || 0,
      page: Number(page),
      limit: lim,
      total_pages: Math.ceil((count || 0) / lim)
    });
  } catch (e) {
    console.error('[getOrders]', e);
    res.status(500).json({ error: e.message || 'Ошибка получения заказов' });
  }
};

// Order state machine:
// pending → payment_confirmed (admin verifies receipt) → seller_accepted (shop accepts) → preparing
// at any step → rejected
const ORDER_STATUSES = ['pending', 'payment_confirmed', 'confirmed', 'seller_accepted', 'preparing', 'ready', 'delivered', 'rejected'];
// Statuses where seller can see full customer contact/address
const CONTACT_VISIBLE_STATUSES = new Set(['seller_accepted', 'preparing', 'ready', 'delivered']);

function maskOrderForShop(order) {
  if (!order) return order;
  const isContactVisible = CONTACT_VISIBLE_STATUSES.has(order.status);
  if (isContactVisible) return order;
  // Hide customer & receiver contact/address before seller accepts
  return {
    ...order,
    customer_phone: '***',
    customer_address: '***',
    receiver_phone: order.receiver_phone ? '***' : null,
    receiver_address: order.receiver_address ? '***' : null,
  };
}

exports.updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Неверный статус' });
    }

    // Backward compat: 'confirmed' from admin = payment_confirmed (notifies seller)
    const newStatus = status === 'confirmed' ? 'payment_confirmed' : status;

    let query = getClient()
      .from('orders')
      .update({ status: newStatus })
      .eq('id', id);

    if (newStatus === 'payment_confirmed' || newStatus === 'rejected') {
      query = query.eq('status', 'pending');
    }

    const { data, error } = await query.select().single();

    if (error) throw error;
    if (!data) {
      return res.status(409).json({ error: 'Заказ уже обработан или статус изменился' });
    }

    if (newStatus === 'payment_confirmed') {
      console.log('[updateOrderStatus] Payment confirmed for order', data.id, '— notifying shop + customer');
      try {
        const { notifySellerAboutOrder, notifyCustomerOnPaymentConfirmed } = require('../services/telegram');
        await notifySellerAboutOrder(data);
        await notifyCustomerOnPaymentConfirmed(data);
      } catch (e) {
        console.error('[updateOrderStatus] notify failed:', e.message);
      }
    }
    
    // If payment failed/rejected, notify customer with support contact
    if (newStatus === 'rejected') {
      console.log('[updateOrderStatus] Payment rejected for order', data.id, '— notifying customer');
      try {
        const { notifyCustomerPaymentRejected } = require('../services/telegram');
        await notifyCustomerPaymentRejected(data);
      } catch (e) {
        console.error('[updateOrderStatus] Failed to notify customer about payment rejection:', e.message);
      }
    }

    res.json(data);
  } catch (e) {
    console.error('[updateOrderStatus]', e);
    res.status(500).json({ error: e.message || 'Ошибка обновления статуса' });
  }
};

exports.shopUpdateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const shop = req.shop;

    // Shop can: accept (seller_accepted), reject, mark preparing/ready/delivered
    const allowedShopStatuses = ['seller_accepted', 'preparing', 'ready', 'delivered', 'rejected', 'confirmed'];
    if (!allowedShopStatuses.includes(status)) {
      return res.status(400).json({ error: 'Неверный статус' });
    }

    // Verify order is in a state where shop can act (must be payment_confirmed or later)
    const { data: existing } = await getClient()
      .from('orders')
      .select('status')
      .eq('id', id)
      .single();
    if (!existing) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    if (existing.status === 'pending') {
      return res.status(400).json({ error: 'Заказ ещё не подтверждён админом (оплата)' });
    }

    // Backward compat: 'confirmed' from shop = seller_accepted
    const newStatus = status === 'confirmed' ? 'seller_accepted' : status;
    const waitingShop = ['payment_confirmed', 'confirmed'];
    if (['seller_accepted', 'rejected'].includes(newStatus) && !waitingShop.includes(existing.status)) {
      return res.status(409).json({ error: 'Заказ уже обработан' });
    }

    const { data, error } = await getClient()
      .from('orders')
      .update({ status: newStatus })
      .eq('id', id)
      .eq('status', existing.status)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(409).json({ error: 'Заказ уже обработан' });
    }

    // Send notification to main admin about shop decision
    try {
      const { notifyAdminAboutShopOrder } = require('../services/telegram');
      await notifyAdminAboutShopOrder(data, shop);
    } catch (notifyErr) {
      console.error('Failed to send shop notification:', notifyErr);
    }

    // Notify customer about shop-side status change (seller_accepted/preparing/ready/delivered/rejected)
    try {
      const { notifyCustomerStatusChanged } = require('../services/telegram');
      console.log('[shopUpdateOrderStatus] notifying customer for order', data.id, 'newStatus:', newStatus, 'customer_chat_id:', data.customer_chat_id);
      await notifyCustomerStatusChanged(data, shop);
    } catch (notifyErr) {
      console.error('[shopUpdateOrderStatus] Failed to notify customer:', notifyErr.message);
    }

    res.json(data);
  } catch (e) {
    console.error('[shopUpdateOrderStatus]', e);
    res.status(500).json({ error: e.message || 'Ошибка обновления статуса' });
  }
};

exports.getShopOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Number(page) - 1) * lim;
    const { phone } = req.shop;

    // Get all orders (we'll filter in JS); only show seller orders that have been payment_confirmed by admin
    const { data, error } = await getClient()
      .from('orders')
      .select('*')
      .neq('status', 'pending') // hide orders not yet payment-confirmed
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Filter orders that contain items from this shop
    const shopOrders = (data || []).filter(order => {
      const items = typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []);
      return Array.isArray(items) && items.some(item => item.seller_phone === phone);
    });

    // Apply status filter if provided
    const filteredOrders = status ? shopOrders.filter(o => o.status === status) : shopOrders;

    // Mask customer data based on order status
    const maskedOrders = filteredOrders.map(maskOrderForShop);

    // Paginate
    const paginated = maskedOrders.slice(off, off + lim);

    res.json({
      data: paginated,
      total: maskedOrders.length,
      page: Number(page),
      limit: lim,
      total_pages: Math.ceil(maskedOrders.length / lim)
    });
  } catch (e) {
    console.error('[getShopOrders]', e);
    res.status(500).json({ error: e.message || 'Ошибка получения заказов' });
  }
};
