'use strict';
const { getClient } = require('../db/supabase');
const { notifyInquiry, savePendingInquiry } = require('../services/telegram');

exports.createInquiry = async (req, res) => {
  try {
    const { product_id, customer_name, customer_phone, customer_telegram, note, customer_chat_id } = req.body;
    if (!customer_phone) return res.status(400).json({ error: 'Телефон обязателен' });

    const { data, error } = await getClient().from('inquiries').insert({
      product_id:        product_id || null,
      customer_name:     customer_name || null,
      customer_phone,
      customer_telegram: customer_telegram || null,
      note:              note || null
    }).select().single();

    if (error) throw new Error(error.message);

    // Получаем данные товара для уведомления
    let productTitle = null;
    let productSlug  = null;
    let productId    = null;
    let productPrice = null;

    if (product_id) {
      const { data: prod } = await getClient()
        .from('products')
        .select('title, slug, id, price')
        .eq('id', product_id)
        .single();

      productTitle = prod?.title || null;
      productSlug  = prod?.slug  || null;
      productId    = prod?.id    || null;
      productPrice = prod?.price || null;
    }

    notifyInquiry(data, productTitle, productSlug, productId).catch(() => {});

    // Сохраняем данные заявки для бота
    const inqKey = 'inq_' + Date.now();
    const siteUrl = process.env.SITE_URL || process.env.MINI_APP_URL || '';
    savePendingInquiry(inqKey, {
      productTitle,
      productUrl: productSlug ? siteUrl + '/#product-' + productSlug : siteUrl,
      customer_phone,
      customer_name:     customer_name     || null,
      customer_telegram: customer_telegram || null,
      note:              note              || null,
    });

    res.status(201).json({ id: data.id, message: 'Заявка отправлена! Мы свяжемся с вами.', inq_key: inqKey });({ id: data.id, message: 'Заявка отправлена! Мы свяжемся с вами.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

exports.getInquiries = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const lim = Math.min(+limit || 30, 100);
    const off = ((+page || 1) - 1) * lim;

    let query = getClient()
      .from('inquiries')
      .select('*, products(title, category, price)', { count: 'exact' });
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);

    if (error) throw new Error(error.message);
    res.json({
      data: data || [],
      total: count || 0,
      page: +page || 1,
      limit: lim,
      total_pages: Math.ceil((count || 0) / lim)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
};

exports.updateInquiry = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new','done'].includes(status))
      return res.status(400).json({ error: 'Неверный статус' });
    const { data, error } = await getClient()
      .from('inquiries').update({ status }).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
};

exports.getStats = async (req, res) => {
  try {
    const sb = getClient();
    const [{ data: products }, { data: inquiries }, { data: byDay }] = await Promise.all([
      sb.from('products').select('status, category'),
      sb.from('inquiries').select('status'),
      sb.from('inquiries').select('created_at').gte('created_at',
        new Date(Date.now() - 30*86400000).toISOString()),
    ]);

    const pStats = { total:0, active:0, pending:0, bouquets:0, baskets:0, bears:0, sweets:0 };
    for (const p of products || []) {
      pStats.total++;
      if (p.status === 'active')    pStats.active++;
      if (p.status === 'pending')   pStats.pending++;
      if (p.category === 'bouquet') pStats.bouquets++;
      if (p.category === 'basket')  pStats.baskets++;
      if (p.category === 'bear')    pStats.bears++;
      if (p.category === 'sweets')  pStats.sweets++;
    }

    const iStats = {
      total:   (inquiries||[]).length,
      new_inq: (inquiries||[]).filter(i => i.status === 'new').length
    };

    const dayMap = {};
    for (const i of byDay || []) {
      const d = i.created_at.split('T')[0];
      dayMap[d] = (dayMap[d] || 0) + 1;
    }
    const days = Object.entries(dayMap)
      .map(([d, cnt]) => ({ date: d, count: cnt }))
      .sort((a, b) => b.date.localeCompare(a.date));

    res.json({ products: pStats, inquiries: iStats, by_day: days });
  } catch(e) { res.status(500).json({ error: e.message }); }
};
