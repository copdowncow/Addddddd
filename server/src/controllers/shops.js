'use strict';
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const sharp     = require('sharp');
const { getClient, uploadPhoto } = require('../db/supabase');
const { notifyShopRegistration, notifyProductEdited } = require('../services/telegram');
const { enrichProductPricing } = require('../services/productPricing');

const JWT_SECRET = process.env.JWT_SECRET || 'rebuket_secret_key';

function normalizePhone(phone) {
  return (phone || '').toString().replace(/[^\d]/g, '');
}

function phoneFilter(phone) {
  const normalized = normalizePhone(phone);
  return `phone.eq.${normalized},phone.ilike.%${normalized}%`;
}

exports.getByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Phone is required' });
    }

    const db = getClient();
    const { data, error } = await db
      .from('shops')
      .select('phone, shop_name, city, photo_url, description, status')
      .or(phoneFilter(phone))
      .limit(1);

    if (error) throw error;
    const shop = Array.isArray(data) ? data[0] : null;
    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    res.json(shop);
  } catch (err) {
    console.error('Get shop by phone error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.register = async (req, res) => {
  try {
    let { phone, password, shop_name, city, telegram, address } = req.body;
    phone = normalizePhone(phone);

    if (!phone || !password) {
      return res.status(400).json({ error: 'Телефон и пароль обязательны' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }

    const db = getClient();

    const { data: existing } = await db
      .from('shops')
      .select('id')
      .or(phoneFilter(phone))
      .maybeSingle();
    

    if (existing) {
      return res.status(409).json({ error: 'Магазин с таким телефоном уже зарегистрирован' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data, error } = await db
      .from('shops')
      .insert({
        phone,
        password_hash,
        shop_name: shop_name || null,
        city:      city      || null,
        telegram:  telegram  || null,
        address:   address   || null,
        status:    'pending',
        photo_url: null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Уведомляем админа в Telegram
    notifyShopRegistration(data).catch(e =>
      console.log('notifyShopRegistration error:', e.message)
    );

    res.json({ ok: true, message: 'Заявка отправлена. Ожидайте одобрения администратора.' });
  } catch (e) {
    console.error('shops.register error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.login = async (req, res) => {
  try {
    let { phone, password } = req.body;
    phone = normalizePhone(phone);

    if (!phone || !password) {
      return res.status(400).json({ error: 'Введите телефон и пароль' });
    }

    const db = getClient();

    const { data: shop, error } = await db
      .from('shops')
      .select('*')
      .or(phoneFilter(phone))
      .single();

    if (error || !shop) {
      return res.status(401).json({ error: 'Неверный телефон или пароль' });
    }

    if (shop.status === 'pending') {
      return res.status(403).json({ error: 'Аккаунт ещё не одобрен администратором' });
    }
    if (shop.status === 'rejected') {
      return res.status(403).json({ error: 'Аккаунт отклонён. Свяжитесь с администратором.' });
    }

    const valid = await bcrypt.compare(password, shop.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный телефон или пароль' });
    }

    const token = jwt.sign(
      { shop_id: shop.id, phone: shop.phone, role: 'shop' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      ok:        true,
      token,
      shop_name: shop.shop_name || shop.phone,
      phone:     shop.phone,
    });
  } catch (e) {
    console.error('shops.login error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.adminLogin = async (req, res) => {
  try {
    let { phone, password } = req.body;
    phone = normalizePhone(phone);
    if (!phone || !password) {
      return res.status(400).json({ error: 'Требуется телефон и пароль' });
    }

    const { data: shop, error } = await getClient()
      .from('shops')
      .select('id,shop_name,city,telegram,phone,status,photo_url')
      .or(phoneFilter(phone))
      .eq('admin_password', password)
      .single();

    if (error || !shop) {
      return res.status(401).json({ error: 'Неверный телефон или пароль админа' });
    }

    if (shop.status !== 'active') {
      return res.status(403).json({ error: 'Магазин не активирован. Ожидайте подтверждения.' });
    }

    const token = jwt.sign({ phone: shop.phone, isAdmin: true }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    res.json({
      ok: true,
      token,
      shop_name: shop.shop_name || shop.phone,
      phone: shop.phone,
      city: shop.city,
      telegram: shop.telegram,
      status: shop.status,
      photo_url: shop.photo_url,
    });
  } catch (e) {
    console.error('shops.adminLogin error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.me = async (req, res) => {
  try {
    const phone = normalizePhone(req.shop?.phone);
    const { data: shop, error } = await getClient()
      .from('shops')
      .select('id,shop_name,city,telegram,phone,status,photo_url,description,delivery_info,categories,verified,rating,rating_count,cover_url')
      .or(phoneFilter(phone))
      .single();

    if (error || !shop) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    res.json({
      ok: true,
      shop_name:     shop.shop_name || shop.phone,
      phone:         shop.phone,
      city:          shop.city,
      telegram:      shop.telegram,
      status:        shop.status,
      photo_url:     shop.photo_url,
      cover_url:     shop.cover_url || null,
      description:   shop.description || '',
      delivery_info: shop.delivery_info || '',
      categories:    shop.categories || [],
      verified:      !!shop.verified,
      rating:        shop.rating ?? null,
      rating_count:  shop.rating_count ?? 0,
    });
  } catch (e) {
    console.error('shops.me error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

async function processImage(file) {
  const buffer = file.buffer;
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

exports.updateProfile = async (req, res) => {
  try {
    const { phone } = req.shop;
    const {
      shop_name, description, city, telegram,
      new_phone, delivery_info, categories,
    } = req.body;
    const photoFile = req.file;

    const updates = {};
    if (shop_name !== undefined)     updates.shop_name = shop_name || null;
    if (description !== undefined)   updates.description = description || null;
    if (city !== undefined)          updates.city = city || null;
    if (telegram !== undefined)      updates.telegram = telegram || null;
    if (delivery_info !== undefined) updates.delivery_info = delivery_info || null;
    if (categories !== undefined) {
      let cats = categories;
      if (typeof cats === 'string') { try { cats = JSON.parse(cats); } catch (_) { cats = cats.split(',').map(s => s.trim()).filter(Boolean); } }
      updates.categories = Array.isArray(cats) ? cats.slice(0, 20) : null;
    }

    // Phone change: requires unique new_phone
    if (new_phone && new_phone.trim() && normalizePhone(new_phone) !== phone) {
      const np = normalizePhone(new_phone);
      const { data: dup } = await getClient().from('shops').select('id').or(phoneFilter(np)).maybeSingle();
      if (dup) return res.status(409).json({ error: 'Магазин с таким телефоном уже существует' });
      updates.phone = np;
    }

    if (photoFile) {
      const processed = await processImage(photoFile);
      const photo_url = await uploadPhoto(processed, `shop-${phone}-${Date.now()}.jpg`, 'image/jpeg');
      updates.photo_url = photo_url;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Нет данных для обновления' });
    }

    const { data, error } = await getClient()
      .from('shops')
      .update(updates)
      .eq('phone', phone)
      .select()
      .single();

    if (error) throw error;

    // Phone changed → issue new JWT
    let token = null;
    if (updates.phone) {
      token = jwt.sign(
        { shop_id: data.id, phone: data.phone, role: 'shop' },
        JWT_SECRET,
        { expiresIn: '30d' }
      );
    }

    res.json({
      ok: true,
      token,
      shop_name:     data.shop_name,
      phone:         data.phone,
      city:          data.city,
      telegram:      data.telegram,
      status:        data.status,
      photo_url:     data.photo_url,
      description:   data.description || '',
      delivery_info: data.delivery_info || '',
      categories:    data.categories || [],
      verified:      !!data.verified,
      rating:        data.rating ?? null,
      rating_count:  data.rating_count ?? 0,
    });
  } catch (e) {
    console.error('shops.updateProfile error:', e.message);
    res.status(500).json({ error: e.message || 'Ошибка обновления профиля' });
  }
};

exports.listProducts = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const lim = Math.min(Number(limit) || 20, 100);
    const off = (Number(page) - 1) * lim;
    const phone = normalizePhone(req.shop?.phone);

    // Look up the actual shop record to get the DB phone value
    const { data: shopRow } = await getClient()
      .from('shops')
      .select('phone')
      .eq('id', req.shop.shop_id)
      .limit(1);

    const dbPhone = Array.isArray(shopRow) ? (shopRow[0]?.phone || phone) : phone;
    const phones = [...new Set([dbPhone, phone].filter(Boolean))];
    console.log('[listProducts] Shop phones to match:', phones);

    // Build filter: exact match on each phone variant
    const orParts = phones.map(p => `seller_phone.eq.${p}`).join(',');
    const { data, error, count } = await getClient()
      .from('products')
      .select('*', { count: 'exact' })
      .or(orParts)
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) throw error;

    console.log('[listProducts] Found products:', count, 'data length:', data?.length);

    const { data: shopInfo } = await getClient()
      .from('shops')
      .select('commission_percent')
      .eq('id', req.shop.shop_id)
      .maybeSingle();

    const enriched = (data || []).map(p => enrichProductPricing({ ...p, listing_type: p.listing_type || 'shop' }, shopInfo));

    res.json({
      data: enriched,
      total: count || 0,
      page: Number(page),
      limit: lim,
      total_pages: Math.ceil((count || 0) / lim)
    });
  } catch (e) {
    console.error('shops.listProducts error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.shop;

    const { data: product, error: fetchErr } = await getClient()
      .from('products')
      .select('id,seller_phone,title,description,category,price,city,size,address,pickup_time,slug,listing_type,status,photos')
      .eq('id', id)
      .single();

    if (fetchErr || !product) {
      return res.status(404).json({ error: 'Публикация не найдена' });
    }
    if (normalizePhone(product.seller_phone) !== normalizePhone(phone)) {
      return res.status(403).json({ error: 'Нет доступа к этой публикации' });
    }

    const {
      title, description, category, size, address,
      availability_type, prepare_hours
    } = req.body;

    const updates = {};
    if (title       !== undefined && title.trim())       updates.title       = title.trim();
    if (description !== undefined)                       updates.description = description || null;
    if (category    !== undefined && category.trim())    updates.category    = category.trim();
    if (size        !== undefined)                       updates.size        = size || null;
    if (address     !== undefined)                       updates.address     = address || null;

    if (availability_type !== undefined) {
      const at = availability_type === 'on_order' ? 'on_order' : 'in_stock';
      updates.availability_type = at;
      if (at === 'on_order') {
        const hrs = Number(prepare_hours);
        if (!hrs || hrs < 1) {
          return res.status(400).json({ error: 'Укажите срок готовности в часах' });
        }
        updates.prepare_hours = hrs;
      } else {
        updates.prepare_hours = null;
      }
    } else if (prepare_hours !== undefined && product.availability_type === 'on_order') {
      const hrs = Number(prepare_hours);
      if (hrs >= 1) updates.prepare_hours = hrs;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Нет данных для обновления' });
    }

    const { data, error } = await getClient()
      .from('products')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Notify admins about the shop edit
    notifyProductEdited({ ...product, ...updates }, phone).catch(e =>
      console.log('notifyProductEdited error:', e.message)
    );

    res.json({ ok: true, data });
  } catch (e) {
    console.error('shops.updateProduct error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.setProductStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    const phone = normalizePhone(req.shop?.phone);

    const allowed = { show: 'active', hide: 'hidden', delist: 'sold_out' };
    const newStatus = allowed[action];
    if (!newStatus) {
      return res.status(400).json({ error: 'Действие: show, hide или delist' });
    }

    const { data: product, error: fetchErr } = await getClient()
      .from('products')
      .select('id,seller_phone,status')
      .eq('id', id)
      .single();

    if (fetchErr || !product) {
      return res.status(404).json({ error: 'Публикация не найдена' });
    }
    if (normalizePhone(product.seller_phone) !== phone) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    if (newStatus === 'active' && product.status === 'pending') {
      return res.status(400).json({ error: 'Публикация ещё на проверке' });
    }

    let statusToSet = newStatus;
    let { data, error } = await getClient()
      .from('products')
      .update({ status: statusToSet })
      .eq('id', id)
      .select()
      .single();

    // БД без sold_out в CHECK (миграция 008 не выполнена) — снимаем как hidden
    if (error && action === 'delist' && /products_status_check/i.test(error.message || '')) {
      statusToSet = 'hidden';
      ({ data, error } = await getClient()
        .from('products')
        .update({ status: statusToSet })
        .eq('id', id)
        .select()
        .single());
    }

    if (error) throw error;
    res.json({
      ok: true,
      data,
      status_applied: statusToSet,
      needs_migration: action === 'delist' && statusToSet === 'hidden' && newStatus === 'sold_out',
    });
  } catch (e) {
    console.error('shops.setProductStatus error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.bulkUpdateAvailability = async (req, res) => {
  try {
    const phone = normalizePhone(req.shop?.phone);
    const { availability_type, prepare_hours } = req.body;

    if (!availability_type) {
      return res.status(400).json({ error: 'Укажите availability_type' });
    }
    const at = availability_type === 'on_order' ? 'on_order' : 'in_stock';
    const updates = { availability_type: at };
    if (at === 'on_order') {
      const hrs = Number(prepare_hours);
      if (!hrs || hrs < 1) {
        return res.status(400).json({ error: 'Укажите срок готовности в часах' });
      }
      updates.prepare_hours = hrs;
    } else {
      updates.prepare_hours = null;
    }

    const { data: shopRow } = await getClient()
      .from('shops')
      .select('phone')
      .eq('id', req.shop.shop_id)
      .maybeSingle();
    const dbPhone = shopRow?.phone || phone;

    const { data, error } = await getClient()
      .from('products')
      .update(updates)
      .or(`seller_phone.eq.${dbPhone},seller_phone.eq.${phone}`)
      .neq('status', 'pending')
      .select('id');

    if (error) throw error;
    res.json({ ok: true, updated: (data || []).length });
  } catch (e) {
    console.error('shops.bulkUpdateAvailability error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { phone } = req.shop;

    const { data: product, error: fetchErr } = await getClient()
      .from('products')
      .select('id,seller_phone')
      .eq('id', id)
      .single();

    if (fetchErr || !product) {
      return res.status(404).json({ error: 'Публикация не найдена' });
    }
    if (normalizePhone(product.seller_phone) !== normalizePhone(phone)) {
      return res.status(403).json({ error: 'Нет доступа к этой публикации' });
    }

    const { error } = await getClient()
      .from('products')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Публикация удалена' });
  } catch (e) {
    console.error('shops.deleteProduct error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// Вызывается из telegram.js при нажатии ✅ в боте
exports.approve = async (id) => {
  const { data, error } = await getClient()
    .from('shops')
    .update({ status: 'active' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
};

exports.reject = async (id) => {
  const { data, error } = await getClient()
    .from('shops')
    .update({ status: 'rejected' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
};
