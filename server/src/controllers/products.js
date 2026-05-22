'use strict';

const { q, uploadPhoto, getClient } = require('../db/supabase');
const { notifyProduct, notifySellerApproved, notifySellerRejected } = require('../services/telegram');
const { v4: uuid } = require('uuid');

const sharp = require('sharp');
const convert = require('heic-convert');

// ─────────────────────────────
// 📸 ОБРАБОТКА ИЗОБРАЖЕНИЙ
// ─────────────────────────────
async function processImage(file) {
  let buffer = file.buffer;
  const name = (file.originalname || '').toLowerCase();

  try {
    // HEIC → JPG
    if (name.endsWith('.heic') || name.endsWith('.heif')) {
      buffer = await convert({
        buffer,
        format: 'JPEG',
        quality: 0.9
      });
    }

    // Любой формат → JPG, resize до 1200x1200
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

// ─────────────────────────────
// 🔤 SLUG
// ─────────────────────────────
function toSlug(str) {
  if (!str) return '';
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo',
    ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ы: 'y', э: 'e', ю: 'yu', я: 'ya'
  };
  return str
    .toLowerCase()
    .split('')
    .map(c => map[c] || c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function uniqueSlug(base) {
  if (!base) return `product-${Date.now()}`;
  let slug = base;
  let i = 1;
  while (true) {
    const rows = await q(sb =>
      sb.from('products').select('id').eq('slug', slug).limit(1)
    );
    if (!rows?.length) return slug;
    slug = `${base}-${i++}`;
    if (i > 100) throw new Error('Не удалось сгенерировать уникальный slug');
  }
}

function normalizePhone(phone) {
  return (phone || '').toString().replace(/[^\d]/g, '');
}

async function collectActiveShopPhones() {
  const { data, error } = await getClient()
    .from('shops')
    .select('phone')
    .eq('status', 'active');
  if (error) throw error;
  return (data || []).map(s => normalizePhone(s.phone)).filter(Boolean);
}

function isShopProduct(p, shopPhones = []) {
  if (!p) return false;
  // Only identify as shop if listing_type is explicitly 'shop'
  // Don't use market_price or seller_phone as criteria to avoid misidentifying eco products
  if (p.listing_type) return p.listing_type === 'shop';
  return false;
}

function publicProduct(p, shopPhones = []) {
  if (!p) return null;
  const { seller_telegram, seller_chat_id, ...pub } = p;
  // Source of truth: is seller_phone registered in shops table?
  const normalizedPhone = normalizePhone(p.seller_phone);
  const isShop = p.listing_type === 'shop' || (shopPhones.length > 0 && shopPhones.includes(normalizedPhone));

  const result = {
    ...pub,
    seller_phone: isShop ? (p.seller_phone || null) : null,
    photo_url: p.photo_url || null,
    shop_name: isShop ? (p.shop_name || p.seller_name || 'Магазин') : null,
    status: p.status || 'unknown',
    listing_type: isShop ? 'shop' : 'eco',
    is_shop_listing: isShop
  };
  
  return result;
}

// ─────────────────────────────
// 📦 GET PRODUCTS
// ─────────────────────────────
exports.getProducts = async (req, res) => {
  try {
    const {
      category,
      city,
      min_price,
      max_price,
      search,
      page = 1,
      limit = 20,
      listing_type,
      shop_phone
    } = req.query;

    const lim = Math.min(Number(limit) || 20, 100);
    const off = (Number(page) - 1) * lim;
    const now = new Date().toISOString();

    let query = getClient()
      .from('products')
      .select('*', { count: 'exact' })
      .eq('status', 'active')
      .or(`expires_at.is.null,expires_at.gt.${now}`);

    // Always fetch shopPhones - used as source of truth for shop vs eco classification
    const shopPhones = await collectActiveShopPhones();
    console.log('[getProducts v2] shopPhones loaded:', shopPhones.length, 'phones');

    if (category)  query = query.eq('category', category);
    if (city)      query = query.eq('city', city);
    if (min_price) query = query.gte('price', Number(min_price));
    if (max_price) query = query.lte('price', Number(max_price));
    if (search)    query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);

    // Filter by listing_type. Treat NULL as 'eco' for backwards-compat so old
    // rows without listing_type still appear in the eco catalog.
    if (listing_type === 'shop') {
      query = query.eq('listing_type', 'shop');
    } else if (listing_type === 'eco') {
      query = query.or('listing_type.eq.eco,listing_type.is.null');
    }

    if (shop_phone) {
      query = query.eq('seller_phone', shop_phone);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) throw error;

    // Fetch shop data ONLY for shop products (sellers in shops table)
    let products = data || [];
    
    if (products.length > 0 && shopPhones.length > 0) {
      // A product is a shop product if its seller_phone is in shopPhones
      const shopPhoneSet = new Set(shopPhones);
      const isShopProduct = p => shopPhoneSet.has(normalizePhone(p.seller_phone));
      const sellerPhones = [...new Set(products.filter(isShopProduct).map(p => normalizePhone(p.seller_phone)).filter(Boolean))];
      
      if (sellerPhones.length > 0) {
        const { data: shops, error: shopsError } = await getClient()
          .from('shops')
          .select('phone, photo_url, shop_name')
          .in('phone', sellerPhones);
        
        if (!shopsError && shops) {
          const shopMap = {};
          shops.forEach(s => { shopMap[normalizePhone(s.phone)] = s; });
          products = products.map(p => {
            if (isShopProduct(p)) {
              const np = normalizePhone(p.seller_phone);
              return {
                ...p,
                photo_url: shopMap[np]?.photo_url || p.photo_url || null,
                shop_name: shopMap[np]?.shop_name || p.shop_name
              };
            }
            return p;
          });
        }
      }
    }

    // Apply publicProduct transformation after shop data is merged
    const publicProducts = products.map(d => publicProduct(d, shopPhones));

    res.json({
      data: publicProducts,
      total: count || 0,
      page: Number(page),
      limit: lim,
      total_pages: Math.ceil((count || 0) / lim)
    });
  } catch (e) {
    console.error('[getProducts]', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
};

exports.getShopPublications = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const lim = Math.min(Number(limit) || 20, 100);
    const off = (Number(page) - 1) * lim;
    const explicitShopPhone = req.query.shop_phone;

    if (explicitShopPhone) {
      const shopPhone = explicitShopPhone;
      const { data, error, count } = await getClient()
        .from('products')
        .select('*', { count: 'exact' })
        .eq('seller_phone', shopPhone)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .range(off, off + lim - 1);

      if (error) throw error;
      const shopsMap = {};
      const { data: shops, error: shopsError } = await getClient()
        .from('shops')
        .select('phone, shop_name, photo_url')
        .eq('phone', shopPhone);
      if (!shopsError && Array.isArray(shops)) {
        shops.forEach(s => { shopsMap[normalizePhone(s.phone)] = s; });
      }

      const normalizedShopPhone = normalizePhone(shopPhone);
      const publicProducts = (data || []).map(d => publicProduct({
        ...d,
        listing_type: 'shop',
        shop_name: shopsMap[normalizedShopPhone]?.shop_name || d.shop_name || d.seller_name,
        photo_url: shopsMap[normalizedShopPhone]?.photo_url || d.photo_url
      }, [normalizedShopPhone]));
      return res.json({
        data: publicProducts,
        total: count || 0,
        page: Number(page),
        limit: lim,
        total_pages: Math.ceil((count || 0) / lim)
      });
    }

    req.query.listing_type = 'shop';
    return exports.getProducts(req, res);
  } catch (e) {
    console.error('[getShopPublications]', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
};

// ─────────────────────────────
// 📦 GET PRODUCT
// ─────────────────────────────

// Кеш просмотров: ip+productId -> timestamp последнего просмотра
const _viewCache = new Map();
const VIEW_TTL = 30 * 60 * 1000; // 30 минут

exports.getProduct = async (req, res) => {
  try {
    const param  = req.params.id;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

    const { data, error } = await getClient()
      .from('products')
      .select('*')
      .eq(isUUID ? 'id' : 'slug', param)
      .eq('status', 'active')
      .single();

    if (error || !data) {
      console.log(`[getProduct] не найден: param=${param}`);
      return res.status(404).json({ error: 'Товар не найден, не активен или на модерации' });
    }

    let product = data;
    const sellerPhone = normalizePhone(data.seller_phone);
    
    // Determine if this seller is a registered shop
    const allShopPhones = await collectActiveShopPhones();
    const isShopSeller = sellerPhone && allShopPhones.includes(sellerPhone);
    
    if (isShopSeller) {
      const { data: shopInfo, error: shopErr } = await getClient()
        .from('shops')
        .select('shop_name, photo_url')
        .eq('phone', sellerPhone)
        .single();
      if (!shopErr && shopInfo) {
        product = {
          ...product,
          shop_name: shopInfo.shop_name || product.shop_name || product.seller_name,
          photo_url: shopInfo.photo_url || product.photo_url
        };
      }
    }

    // Считаем просмотр только раз в 30 минут с одного IP
    const ip       = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const cacheKey = ip + ':' + data.id;
    const lastView = _viewCache.get(cacheKey);
    const now      = Date.now();

    let newCount = data.view_count || 0;
    if (!lastView || now - lastView > VIEW_TTL) {
      _viewCache.set(cacheKey, now);
      newCount += 1;
      getClient()
        .from('products')
        .update({ view_count: newCount })
        .eq('id', data.id)
        .then(() => {})
        .catch(e => console.log('view_count update error:', e.message));
    }

    res.json(publicProduct({ ...product, view_count: newCount }, allShopPhones));
  } catch (e) {
    console.error('[getProduct]', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
};

// ─────────────────────────────
// 🏙 GET CITIES
// ─────────────────────────────
exports.getCities = async (req, res) => {
  try {
    const { data, error } = await getClient()
      .from('products')
      .select('city')
      .eq('status', 'active')
      .not('city', 'is', null);

    if (error) throw error;

    const cities = [...new Set(data?.map(r => r.city) || [])]
      .filter(Boolean)
      .sort();

    res.json(cities);
  } catch (e) {
    console.error('[getCities]', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
};

// ─────────────────────────────
// 📦 CREATE PRODUCT
// ─────────────────────────────
exports.createProduct = async (req, res) => {
  try {
    let {
      title, description, category, price, city,
      seller_name, seller_phone, seller_telegram,
      address, pickup_time, gift_when, market_price, size,
      seller_chat_id
    } = req.body;

    if (!title || !category || !price || !seller_phone) {
      return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }

    const files = req.files || [];

    // Determine pricing mode and listing_type based on whether the seller is
    // a registered active shop. Source of truth: presence in `shops` table.
    let pricing_mode = null;
    let listing_type = 'eco';
    try {
      const { data: shopRow } = await getClient()
        .from('shops')
        .select('phone, status, shop_name, city, address, telegram')
        .eq('phone', normalizePhone(seller_phone))
        .maybeSingle();
      if (shopRow && shopRow.status === 'active') {
        pricing_mode = 'inclusive';
        listing_type = 'shop';
        // Auto-fill missing fields from shop profile so shops don't have to
        // re-enter city/address/name on every publication.
        if (!city)            city            = shopRow.city || null;
        if (!address)         address         = shopRow.address || null;
        if (!seller_name)     seller_name     = shopRow.shop_name || null;
        if (!seller_telegram) seller_telegram = shopRow.telegram || null;
      }
    } catch (_) { /* if shops query fails, fall back to eco/legacy */ }

    // City still required for non-shop listings
    if (listing_type !== 'shop' && !city) {
      return res.status(400).json({ error: 'Укажите город' });
    }

    // Photo requirement: shops need 1+, eco listings need 3+
    const minPhotos = listing_type === 'shop' ? 1 : 3;
    if (files.length < minPhotos) {
      return res.status(400).json({
        error: listing_type === 'shop'
          ? 'Загрузите минимум 1 фотографию'
          : 'Загрузите минимум 3 фотографии'
      });
    }

    const slug = await uniqueSlug(toSlug(title)).catch(() => `product-${Date.now()}`);

    // Сначала создаём объявление с пустыми фото — отвечаем клиенту быстро
    const { data, error } = await getClient()
      .from('products')
      .insert({
        title,
        description:     description     || null,
        category,
        price:           Number(price),
        city,
        seller_name:     seller_name     || null,
        seller_phone,
        seller_telegram: seller_telegram || null,
        address:         address         || null,
        pickup_time:     pickup_time     || null,
        gift_when:       gift_when       || null,
        market_price:    market_price    ? Number(market_price) : null,
        size:            size            || null,
        seller_chat_id:  seller_chat_id  || null,
        pricing_mode,
        listing_type,
        photos: [],
        slug,
        status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;

    // Отвечаем клиенту сразу, не ожидая загрузки фото
    res.status(201).json({
      id: data.id,
      slug: data.slug,
      status: data.status,
      message: 'Объявление подано! Ждёт проверки.',
      previewUrl: `/products/${data.slug}`
    });

    // Загружаем фото в фоне с обработкой (HEIC, resize, jpeg)
    Promise.all(
      files.map(async (f) => {
        const processed = await processImage(f);
        return uploadPhoto(processed, `${uuid()}.jpg`, 'image/jpeg');
      })
    )
      .then(photos => getClient().from('products').update({ photos }).eq('id', data.id))
      .then(() => notifyProduct({ ...data }))
      .catch(err => console.error('Фото/уведомление ошибка:', err));

  } catch (e) {
    console.error('[createProduct]', e);
    res.status(500).json({ error: e.message || 'Ошибка при создании объявления' });
  }
};

// ─────────────────────────────
// 🛠 ADMIN: LIST
// ─────────────────────────────
exports.adminList = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Number(page) - 1) * lim;

    let query = getClient()
      .from('products')
      .select('*', { count: 'exact' });

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) throw error;

    // Автоудаляем просроченные букеты и корзины
    const now = new Date();
    const expired = (data || []).filter(p =>
      ['bouquet', 'basket'].includes(p.category) &&
      p.expires_at && new Date(p.expires_at) < now
    );
    if (expired.length) {
      await Promise.all(expired.map(p =>
        getClient().from('products').delete().eq('id', p.id)
      ));
    }

    res.json({
      data: data || [],
      total: count || 0,
      page: Number(page),
      limit: lim,
      total_pages: Math.ceil((count || 0) / lim)
    });
  } catch (e) {
    console.error('[adminList]', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
};

// ─────────────────────────────
// 🛠 ADMIN: GET ONE
// ─────────────────────────────
exports.adminGet = async (req, res) => {
  try {
    const { data, error } = await getClient()
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    res.json(data);
  } catch (e) {
    console.error('[adminGet]', e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
};

// ─────────────────────────────
// 🛠 ADMIN: UPDATE
// ─────────────────────────────
exports.adminUpdate = async (req, res) => {
  try {
    const id = req.params.id;

    const { data: existing, error: fetchErr } = await getClient()
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    const updates = {};
    const fields = [
      'title', 'description', 'category', 'price', 'city',
      'seller_name', 'seller_phone', 'seller_telegram',
      'address', 'pickup_time', 'status',
      'gift_when', 'size', 'market_price'
    ];

    for (const f of fields) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }

    if (updates.price !== undefined) {
      // Цена от админа = окончательная цена (без добавления комиссии)
      updates.price = Number(updates.price);
      updates.is_admin_price = true; // Флаг что цена финальная
    }

    // Загружаем новые фото с обработкой (HEIC, resize, jpeg)
    if (req.files?.length) {
      const newUrls = await Promise.all(
        req.files.map(async (f) => {
          const processed = await processImage(f);
          return uploadPhoto(processed, `${uuid()}.jpg`, 'image/jpeg');
        })
      );
      updates.photos = [...(existing.photos || []), ...newUrls];
    }

    const { data, error } = await getClient()
      .from('products')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // ── Уведомляем продавца при смене статуса ──────────────
    if (updates.status === 'active' && existing.status !== 'active') {
      // Букеты и корзины — срок 2 дня
      if (['bouquet', 'basket'].includes(data.category)) {
        const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
        await getClient().from('products').update({ expires_at: expiresAt }).eq('id', data.id);
        data.expires_at = expiresAt;
      }
      notifySellerApproved(data).catch(() => {});
    }
    if (updates.status === 'hidden' && existing.status === 'pending') {
      notifySellerRejected(data).catch(() => {});
    }
    // ───────────────────────────────────────────────────────

    res.json(data);
  } catch (e) {
    console.error('[adminUpdate]', e);
    res.status(500).json({ error: e.message || 'Ошибка обновления' });
  }
};

// ─────────────────────────────
// 🛠 ADMIN: DELETE
// ─────────────────────────────
exports.adminDelete = async (req, res) => {
  try {
    const { error } = await getClient()
      .from('products')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ message: 'Товар удалён' });
  } catch (e) {
    console.error('[adminDelete]', e);
    res.status(500).json({ error: e.message || 'Ошибка удаления' });
  }
};
