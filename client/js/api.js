'use strict';

const BASE = '/api';
let _tok = localStorage.getItem('rbt_tok') || '';

export const setTok = (t) => {
  _tok = t;
  localStorage.setItem('rbt_tok', t);
};

export const clrTok = () => {
  _tok = '';
  localStorage.removeItem('rbt_tok');
};

export const isAuth = () => !!_tok;

async function req(method, url, body = null, isForm = false, skipAuthError = false) {
  const headers = {};
  if (_tok) headers['Authorization'] = 'Bearer ' + _tok;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + url, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : null),
  });

  if (!skipAuthError && res.status === 401) {
    clrTok();
    window.dispatchEvent(new Event('rbt:unauth'));
    throw new Error('Сессия истекла. Пожалуйста, войдите заново.');
  }

  let d = {};
  try { d = await res.json(); } catch (e) {}

  if (!res.ok) {
    throw new Error(d.error || d.message || 'Ошибка сервера');
  }

  return d;
}

const qs = (params) => {
  const s = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
  ).toString();
  return s ? '?' + s : '';
};

export const api = {
  config:     ()        => req('GET',    '/config'),
  products:   (p = {})  => req('GET',    '/products' + qs(p)),
  product:    (id)      => req('GET',    '/products/' + id),
  shopsPub:   (p = {})  => req('GET',    '/shops-pub' + qs(p)),
  cities:     ()        => req('GET',    '/cities'),
  addProduct: (fd)      => req('POST',   '/products', fd, true),
  inquiry:    (d)       => req('POST',   '/inquiries', d),

  login:      (u, p)    => req('POST',   '/admin/login', { username: u, password: p }, false, true),
  changePwd:  (c, n)    => req('POST',   '/admin/change-password', { current_password: c, new_password: n }),

  adminProducts: (p = {}) => req('GET',  '/admin/products' + qs(p)),
  adminProduct:  (id)     => req('GET',  '/admin/products/' + id),
  updateProduct: (id, fd) => req('PUT',  '/admin/products/' + id, fd, true),
  deleteProduct: (id)     => req('DELETE','/admin/products/' + id),

  inquiries:  (p = {})  => req('GET',    '/admin/inquiries' + qs(p)),
  updInquiry: (id, s)   => req('PATCH',  '/admin/inquiries/' + id + '/status', { status: s }),

  stats:      ()        => req('GET',    '/admin/stats'),

  // Счётчики ID публикаций
  setCounter: (channel, value) => req('POST', '/admin/counter', { channel, value }),
};
