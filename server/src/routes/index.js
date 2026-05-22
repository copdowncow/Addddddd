'use strict';

const router = require('express').Router();
const { adminAuth, shopAuth, tryShopAuth } = require('../middleware/auth');
const { uploadMiddleware, uploadMiddlewareOptional } = require('../middleware/upload');

const A = require('../controllers/auth');
const P = require('../controllers/products');
const I = require('../controllers/inquiries');
const S = require('../controllers/shops');

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

module.exports = router;
