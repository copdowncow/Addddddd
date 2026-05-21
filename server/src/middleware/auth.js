'use strict';
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'rebuket_secret_key';

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '����� �� ������������' });
  }

  const token = authHeader.split(' ')[1];

  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: '����� �������������� ��� ����. ������� ������.' });
  }
}

function tryShopAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'shop') {
      req.shop = payload;
    }
  } catch (err) {
    // ignore invalid token and continue as anonymous
  }
  next();
}

function shopAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '����� �� ������������' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'shop') {
      return res.status(403).json({ error: '��� �������' });
    }
    req.shop = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: '����� �������������� ��� ����. ������� ������.' });
  }
}

module.exports = { adminAuth, shopAuth, tryShopAuth };
