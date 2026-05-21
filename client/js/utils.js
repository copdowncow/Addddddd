'use strict';
export const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export const fmt  = p => Number(p).toLocaleString('ru-RU') + ' TJS';
export const fmtD = d => new Date(d).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3600);
}
export function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
export function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
window.closeModal = closeModal;

export function goPage(name, pushState = true) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  document.getElementById('page-' + name)?.classList.add('active');
  document.getElementById('nav-drawer')?.classList.remove('open');
  document.getElementById('burger')?.classList.remove('open');
  if (pushState && name !== 'product') history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.dispatchEvent(new CustomEvent('rbt:page', { detail: name }));
}
window.goPage = goPage;
