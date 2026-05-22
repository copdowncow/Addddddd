'use strict';
require('dotenv').config();

let TelegramClientLib = null;
let StringSessionLib  = null;
try {
  TelegramClientLib = require('telegram').TelegramClient;
  StringSessionLib  = require('telegram/sessions').StringSession;
  console.log('✅ telegram (gramjs) загружен');
} catch(e) {
  console.log('⚠️  telegram (gramjs) не найден:', e.message);
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const { getClient } = require('./db/supabase');
const { initBots, setupCallbacks, notifySellerApproved, notifySellerRejected, markExpiredInChannel } = require('./services/telegram');
const { uploadMiddleware, uploadMiddlewareOptional, uploadReceiptMiddleware, uploadPhotoOptional } = require('./middleware/upload');

const { adminAuth, shopAuth, tryShopAuth } = require('./middleware/auth');
const A    = require('./controllers/auth');
const P    = require('./controllers/products');
const I    = require('./controllers/inquiries');
const S    = require('./controllers/shops');
const O    = require('./controllers/orders');
const E    = require('./controllers/admin_earnings');
const AS   = require('./controllers/admin_shops');

const app    = express();
const PORT   = Number(process.env.PORT || 3000);
const MAX_PORT = PORT + 10;
const router = express.Router();

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

function tryListen(port) {
  return new Promise((resolve, reject) => {
    let srv;
    try {
      srv = app.listen(port, () => resolve(srv));
    } catch (err) {
      return reject(err);
    }
    srv.on('error', reject);
  });
}

async function listenWithFallback(startPort, maxPort) {
  let port = startPort;
  while (port <= maxPort) {
    try {
      const server = await tryListen(port);
      return { server, port };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      console.warn(`Порт ${port} занят, пробую ${port + 1}...`);
      port += 1;
    }
  }
  throw new Error(`Не удалось найти свободный порт в диапазоне ${startPort}-${maxPort}`);
}

// ── Роуты ────────────────────────────────────────────────
router.post('/admin/login',           A.login);
router.post('/admin/change-password', adminAuth, A.changePassword);

router.get('/products',     P.getProducts);
router.get('/products/:id', P.getProduct);
router.get('/shops-pub',    tryShopAuth, P.getShopPublications);
router.get('/cities',       P.getCities);
router.post('/products',    uploadMiddleware, P.createProduct);

router.post('/inquiries', I.createInquiry);

router.post('/orders', uploadReceiptMiddleware, O.createOrder);
router.get('/admin/orders', adminAuth, O.getOrders);
router.patch('/admin/orders/:id/status', adminAuth, O.updateOrderStatus);

router.post('/shops/admin-login', S.adminLogin);
router.get('/shops/admin/orders', shopAuth, O.getShopOrders);
router.patch('/shops/admin/orders/:id/status', shopAuth, O.shopUpdateOrderStatus);

router.post('/shops/register',      S.register);
router.post('/shops/login',         S.login);
router.get('/shops/by-phone',       S.getByPhone);
router.get('/shops/me',             shopAuth, S.me);
router.patch('/shops/me',           shopAuth, uploadPhotoOptional, S.updateProfile);
router.get('/shops/products',       shopAuth, S.listProducts);
router.patch('/shops/products/:id', shopAuth, S.updateProduct);
router.delete('/shops/products/:id', shopAuth, S.deleteProduct);

router.get('/admin/products',         adminAuth, P.adminList);
router.get('/admin/products/:id',     adminAuth, P.adminGet);
router.put('/admin/products/:id',     adminAuth, uploadMiddlewareOptional, P.adminUpdate);
router.delete('/admin/products/:id',  adminAuth, P.adminDelete);

router.get('/admin/inquiries',              adminAuth, I.getInquiries);
router.patch('/admin/inquiries/:id/status', adminAuth, I.updateInquiry);
router.get('/admin/stats',                  adminAuth, I.getStats);

// ── Marketplace earnings + settings ──────────────────────
router.get('/admin/earnings',     adminAuth, E.getEarnings);
router.get('/admin/settings',     adminAuth, E.getSettings);
router.patch('/admin/settings',   adminAuth, E.updateSettings);
router.get('/platform-settings',             E.getPublicSettings);
const TelegramLink = require('./controllers/telegram_link');
router.post('/telegram/link-customer', TelegramLink.linkCustomer);
router.get('/config',            (req, res) => res.json({
  instagram:    process.env.ADMIN_INSTAGRAM || 'https://instagram.com/rebuket',
  telegram:     process.env.ADMIN_TELEGRAM  || 'https://t.me/rebuket_admin',
  bot_username: process.env.BOT_USERNAME    || 'ReBuket_bot',
}));

// ── Disputes ─────────────────────────────────────────────
router.get('/admin/disputes',                       adminAuth, E.listDisputes);
router.patch('/admin/orders/:id/dispute-resolve',   adminAuth, E.resolveDispute);

// ── Shops administration ─────────────────────────────────
router.get('/admin/shops',                          adminAuth, AS.listShops);
router.patch('/admin/shops/:id',                    adminAuth, AS.updateShop);
router.post('/admin/shops/:id/reset-password',      adminAuth, AS.resetShopPassword);
router.delete('/admin/shops/:id',                   adminAuth, AS.banShop);

// ── App ──────────────────────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*' }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 500, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const CLIENT_DIR = path.join(__dirname, '../../client');
app.use(express.static(CLIENT_DIR));

app.get('/api/config', (req, res) => res.json({
  instagram:    process.env.ADMIN_INSTAGRAM || 'https://instagram.com/rebuket',
  telegram:     process.env.ADMIN_TELEGRAM  || 'https://t.me/rebuket_admin',
  bot_username: process.env.BOT_USERNAME    || 'ReBuket_bot',
}));

app.use('/api', router);

// ── Счётчики ID ──────────────────────────────────────────
app.post('/api/admin/counter', async (req, res) => {
  try {
    const { channel, value } = req.body;
    if (!channel || value === undefined) return res.status(400).json({ error: 'channel и value обязательны' });
    const { error } = await getClient()
      .from('channel_counters')
      .upsert({ channel, value: Number(value) }, { onConflict: 'channel' });
    if (error) throw new Error(error.message);
    res.json({ ok: true, channel, value });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── User Bot авторизация ──────────────────────────────────
const _authState = {};
app.get('/api/userbot/auth', async (req, res) => {
  try {
    const TelegramClient = TelegramClientLib;
    const StringSession  = StringSessionLib;
    if (!TelegramClient) return res.json({ error: 'telegram модуль не установлен' });
    const apiId   = Number(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    const phone   = process.env.TG_PHONE;
    if (!apiId || !apiHash || !phone) return res.json({ error: 'TG_API_ID, TG_API_HASH, TG_PHONE не заданы' });
    const c = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    await c.connect();
    await c.sendCode({ apiId, apiHash }, phone);
    _authState.client = c;
    res.json({ ok: true, message: 'Код отправлен на ' + phone + '. Введи: /api/userbot/confirm?code=XXXXX' });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/api/userbot/confirm', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code || !_authState.client) return res.json({ error: 'Сначала вызови /api/userbot/auth' });
    const phone = process.env.TG_PHONE;
    await _authState.client.signInUser(
      { apiId: Number(process.env.TG_API_ID), apiHash: process.env.TG_API_HASH },
      { phoneNumber: phone, phoneCode: async () => code, onError: e => { throw e; } }
    );
    const session = _authState.client.session.save();
    delete _authState.client;
    res.json({ ok: true, session, message: 'Добавь в Railway: TG_SESSION=' + session });
  } catch(e) { res.json({ error: e.message }); }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Файл слишком большой (макс 10 МБ)' });
  console.error('❌', err.message);
  res.status(500).json({ error: err.message || 'Ошибка сервера' });
});

app.get('*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

// ── Автоудаление просроченных ─────────────────────────────
async function removeExpiredProducts() {
  try {
    const now        = new Date().toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { data: expired, error: fetchErr } = await getClient()
      .from('products')
      .select('*')
      .in('category', ['bouquet', 'basket'])
      .or(`expires_at.lt.${now},and(expires_at.is.null,created_at.lt.${twoDaysAgo})`);
    if (fetchErr) { console.log('Expire check error:', fetchErr.message); return; }
    if (expired?.length) {
      for (const p of expired) await markExpiredInChannel(p).catch(() => {});
      const ids = expired.map(p => p.id);
      const { error: delErr } = await getClient().from('products').delete().in('id', ids);
      if (delErr) { console.log('Delete error:', delErr.message); return; }
      console.log(`🗑  Удалено просроченных: ${expired.length}`);
    }
  } catch(e) { console.log('Expire check error:', e.message); }
}

async function start() {
  try {
    await getClient().from('products').select('id').limit(1);
    console.log('✅ Supabase подключён');
  } catch(e) {
    console.error('❌ Ошибка Supabase:', e.message);
  }

  initBots();

  setupCallbacks(
    async (id) => {
      const { data: existing } = await getClient().from('products').select('*').eq('id', id).single();
      const updates = { status: 'active' };
      if (existing && ['bouquet','basket'].includes(existing.category)) {
        updates.expires_at = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      }
      await getClient().from('products').update(updates).eq('id', id);
      const { data } = await getClient().from('products').select('*').eq('id', id).single();
      if (data) notifySellerApproved(data).catch(e => console.log('notifySellerApproved error:', e.message));
    },
    async (id) => {
      await getClient().from('products').update({ status: 'hidden' }).eq('id', id);
      const { data } = await getClient().from('products').select('*').eq('id', id).single();
      if (data) notifySellerRejected(data).catch(e => console.log('notifySellerRejected error:', e.message));
    }
  );

  await removeExpiredProducts();
  setInterval(removeExpiredProducts, 30 * 60 * 1000);

  let server;
  let port;
  try {
    ({ server, port } = await listenWithFallback(PORT, MAX_PORT));
  } catch (err) {
    console.error('❌ Ошибка запуска сервера:', err.message);
    process.exit(1);
  }
  console.log('');
  console.log('  🌸 ══════════════════════════════════════════');
  console.log(`  🌸  Rebuket запущен → http://localhost:${port}`);
  console.log(`  🔐  Панель Admin   → http://localhost:${port}/#admin`);
  console.log('  🌸 ══════════════════════════════════════════');
  console.log('');

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Порт ${port} уже используется. Остановите другой процесс или задайте PORT в окружении на свободный порт.\n`);
      process.exit(1);
    }
    console.error('❌Ошибка сервера:', err);
    process.exit(1);
  });
}

start();
