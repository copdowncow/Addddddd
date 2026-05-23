'use strict';

const router = require('express').Router();
const { adminAuth, shopAuth, tryShopAuth } = require('../middleware/auth');
const { uploadMiddleware, uploadMiddlewareOptional } = require('../middleware/upload');

const A = require('../controllers/auth');
const P = require('../controllers/products');
const I = require('../controllers/inquiries');
const S = require('../controllers/shops');
const AS = require('../controllers/admin_shops');

router.post('/admin/login',           A.login);
router.post('/admin/change-password', adminAuth, A.changePassword);

router.get('/products',       P.getProducts);
router.get('/products/:id',   P.getProduct);
router.get('/shops-pub',      tryShopAuth, P.getShopPublications);
router.get('/cities',         P.getCities);
router.post('/products',      uploadMiddleware, P.createProduct);

router.post('/inquiries', I.createInquiry);

router.post('/shops/register', S.register);
router.post('/shops/login',    S.login);
router.get('/shops',           S.listAll);
router.get('/shops/me',        shopAuth, S.me);
router.get('/shops/by-phone',  S.getByPhone);
router.get('/shops/products', shopAuth, S.listProducts);
router.patch('/shops/products/:id', shopAuth, S.updateProduct);
router.delete('/shops/products/:id', shopAuth, S.deleteProduct);

router.get('/admin/products',         adminAuth, P.adminList);
router.get('/admin/products/:id',     adminAuth, P.adminGet);
router.put('/admin/products/:id',     adminAuth, uploadMiddlewareOptional, P.adminUpdate);
router.delete('/admin/products/:id',  adminAuth, P.adminDelete);

router.get('/admin/inquiries',              adminAuth, I.getInquiries);
router.patch('/admin/inquiries/:id/status', adminAuth, I.updateInquiry);
router.get('/admin/stats',                  adminAuth, I.getStats);

// Admin shops routes
router.get('/admin/shops',                  adminAuth, AS.listShops);
router.patch('/admin/shops/:id',            adminAuth, AS.updateShop);
router.post('/admin/shops/:id/reset-password', adminAuth, AS.resetShopPassword);
router.delete('/admin/shops/:id',           adminAuth, AS.deleteShop);
router.patch('/admin/shops/:id/block',      adminAuth, AS.blockShop);
router.patch('/admin/shops/:id/unblock',    adminAuth, AS.unblockShop);

module.exports = router;
