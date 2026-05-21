'use strict';
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const sharp     = require('sharp');
const { getClient, uploadPhoto } = require('../db/supabase');
const { notifyShopRegistration } = require('../services/telegram');

const JWT_SECRET = process.env.JWT_SECRET || 'rebuket_secret_key';

exports.getByPhone = async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'Phone is required' });
    }

    const db = getClient();
    const { data, error } = await db
      .from('shops')
      .select('phone, shop_name, city, photo_url, description, status')
      .eq('phone', phone)
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    res.json(data);
  } catch (err) {
    console.error('Get shop by phone error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.register = async (req, res) => {
  try {
    const { phone, password, shop_name, city, telegram } = req.body;

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
      .eq('phone', phone)
      .single();
    

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
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Введите телефон и пароль' });
    }

    const db = getClient();

    const { data: shop, error } = await db
      .from('shops')
      .select('*')
      .eq('phone', phone)
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
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Требуется телефон и пароль' });
    }

    const { data: shop, error } = await getClient()
      .from('shops')
      .select('id,shop_name,city,telegram,phone,status,photo_url')
      .eq('phone', phone)
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
    const { phone } = req.shop;
    const { data: shop, error } = await getClient()
      .from('shops')
      .select('id,shop_name,city,telegram,phone,status,photo_url,description')
      .eq('phone', phone)
      .single();

    if (error || !shop) {
      return res.status(404).json({ error: 'Магазин не найден' });
    }

    res.json({
      ok: true,
      shop_name: shop.shop_name || shop.phone,
      phone: shop.phone,
      city: shop.city,
      telegram: shop.telegram,
      status: shop.status,
      photo_url: shop.photo_url,
      description: shop.description || '',
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
    const { shop_name, description } = req.body;
    const photoFile = req.file;

    console.log('[updateProfile] phone:', phone, 'shop_name:', shop_name, 'has photo:', !!photoFile, 'description length:', (description || '').length);

    const updates = {};
    if (shop_name) updates.shop_name = shop_name;
    if (description !== undefined) updates.description = description || null;

    if (photoFile) {
      console.log('[updateProfile] Processing photo...');
      const processed = await processImage(photoFile);
      const photo_url = await uploadPhoto(processed, `shop-${phone}-${Date.now()}.jpg`, 'image/jpeg');
      updates.photo_url = photo_url;
      console.log('[updateProfile] Photo uploaded:', photo_url);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Нет данных для обновления' });
    }

    console.log('[updateProfile] Updating with:', updates);
    const { data, error } = await getClient()
      .from('shops')
      .update(updates)
      .eq('phone', phone)
      .select()
      .single();

    if (error) throw error;

    console.log('[updateProfile] Updated shop:', data);
    res.json({
      ok: true,
      shop_name: data.shop_name,
      phone: data.phone,
      city: data.city,
      telegram: data.telegram,
      status: data.status,
      photo_url: data.photo_url,
      description: data.description || '',
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
    const { phone } = req.shop;

    console.log('[listProducts] Fetching products for shop phone:', phone);

    const { data, error, count } = await getClient()
      .from('products')
      .select('*', { count: 'exact' })
      .eq('seller_phone', phone)
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) throw error;

    console.log('[listProducts] Found products:', count, 'data length:', data?.length);

    res.json({
      data: data || [],
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
    if (product.seller_phone !== phone) {
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
