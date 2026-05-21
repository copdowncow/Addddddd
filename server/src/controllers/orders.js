'use strict';

const { getClient, uploadPhoto } = require('../db/supabase');
const sharp = require('sharp');
const { notifyAdminAboutOrder } = require('../services/telegram');

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
      customer_address,
      delivery_type,
      total,
      items,
      receiver_name,
      receiver_phone,
      receiver_address,
      customer_chat_id,
    } = req.body;

    const receiptFile = req.file;

    if (!customer_phone || !customer_address || !delivery_type || !total || !items) {
      return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }

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
    
    // Get active shop phones
    const { data: activeShops } = await getClient()
      .from('shops')
      .select('phone')
      .eq('status', 'active');
    const shopPhoneSet = new Set((activeShops || []).map(s => (s.phone || '').toString().trim()));
    
    // Get product details for each item to verify seller_phone
    const productIds = parsedItems.map(it => it.id || it.pub_id).filter(Boolean);
    if (productIds.length > 0) {
      const { data: prods } = await getClient()
        .from('products')
        .select('id, seller_phone, title')
        .in('id', productIds);
      const ecoItems = (prods || []).filter(p => !shopPhoneSet.has((p.seller_phone || '').toString().trim()));
      if (ecoItems.length > 0) {
        return res.status(400).json({ 
          error: 'В корзине есть эко-товары. Эко-товары заказываются через Telegram, а не через корзину.',
          eco_items: ecoItems.map(p => p.title)
        });
      }
    }

    // Process and upload receipt
    const processed = await processImage(receiptFile);
    const receipt_url = await uploadPhoto(processed, `receipt-${Date.now()}.jpg`, 'image/jpeg');

    const { data, error } = await getClient()
      .from('orders')
      .insert({
        customer_phone,
        customer_address,
        delivery_type,
        total: Number(total),
        items: parsedItems,
        receipt_url,
        receiver_name: receiver_name || null,
        receiver_phone: receiver_phone || null,
        receiver_address: receiver_address || null,
        customer_chat_id: customer_chat_id ? Number(customer_chat_id) : null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

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

    const { data, error } = await getClient()
      .from('orders')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // After admin confirms payment, notify seller
    if (newStatus === 'payment_confirmed') {
      console.log('[updateOrderStatus] Payment confirmed for order', data.id, '— notifying seller');
      try {
        const { notifySellerAboutOrder } = require('../services/telegram');
        await notifySellerAboutOrder(data);
      } catch (e) {
        console.error('[updateOrderStatus] Seller notify failed:', e.message);
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
    if (existing && existing.status === 'pending') {
      return res.status(400).json({ error: 'Заказ ещё не подтверждён админом (оплата)' });
    }

    // Backward compat: 'confirmed' from shop = seller_accepted
    const newStatus = status === 'confirmed' ? 'seller_accepted' : status;

    const { data, error } = await getClient()
      .from('orders')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Send notification to main admin about shop decision
    try {
      const { notifyAdminAboutShopOrder } = require('../services/telegram');
      await notifyAdminAboutShopOrder(data, shop);
    } catch (notifyErr) {
      console.error('Failed to send shop notification:', notifyErr);
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
