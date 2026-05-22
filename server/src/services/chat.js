'use strict';

// ─────────────────────────────────────────────────────────────
//  Order chat relay: customer ↔ shop via Telegram bots
//  - Neither party sees the other's Telegram contact.
//  - All messages persisted in chat_messages.
//  - Active chat session tracked in chat_sessions (per chat_id).
//  - Triggered by order.status = 'payment_confirmed' (chat_active=true).
// ─────────────────────────────────────────────────────────────

const { getClient } = require('../db/supabase');

function db() { return getClient(); }

async function persistMessage({ order_id, sender, sender_phone, text, photo_url, tg_message_id }) {
  const { data, error } = await db()
    .from('chat_messages')
    .insert({
      order_id,
      sender,
      sender_phone: sender_phone || null,
      text: text || null,
      photo_url: photo_url || null,
      tg_message_id: tg_message_id || null,
      delivered: false,
    })
    .select()
    .single();
  if (error) {
    console.error('[chat.persistMessage]', error.message);
    return null;
  }
  return data;
}

async function markDelivered(id) {
  if (!id) return;
  try { await db().from('chat_messages').update({ delivered: true }).eq('id', id); }
  catch (e) { console.error('[chat.markDelivered]', e.message); }
}

async function setActiveChat(chatId, role, orderId, shopPhone) {
  if (!chatId) return;
  try {
    await db().from('chat_sessions').upsert({
      chat_id: chatId,
      role,
      order_id: orderId,
      shop_phone: shopPhone || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'chat_id' });
  } catch (e) { console.error('[chat.setActiveChat]', e.message); }
}

async function clearActiveChat(chatId) {
  if (!chatId) return;
  try { await db().from('chat_sessions').delete().eq('chat_id', chatId); }
  catch (e) { console.error('[chat.clearActiveChat]', e.message); }
}

async function getActiveChat(chatId) {
  if (!chatId) return null;
  try {
    const { data } = await db().from('chat_sessions').select('*').eq('chat_id', chatId).maybeSingle();
    return data || null;
  } catch (e) { return null; }
}

async function getOrderForChat(orderId) {
  if (!orderId) return null;
  const { data } = await db().from('orders').select('*').eq('id', orderId).maybeSingle();
  return data || null;
}

// Check that this chat_id is a participant of the order (customer or shop seller_phone)
async function isParticipant(chatId, orderId) {
  const order = await getOrderForChat(orderId);
  if (!order) return false;
  if (order.customer_chat_id && Number(order.customer_chat_id) === Number(chatId)) return true;
  // shop?
  const { data: shop } = await db().from('shops').select('phone').eq('telegram_chat_id', chatId).maybeSingle();
  if (!shop) return false;
  let items = order.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
  if (!Array.isArray(items)) return false;
  return items.some(it => (it.seller_phone || '').toString().trim() === shop.phone);
}

async function listMessages(orderId, limit = 100) {
  const { data } = await db()
    .from('chat_messages')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, 500));
  return data || [];
}

// Activate chat session on an order (called after admin confirms payment)
async function activateOrderChat(orderId) {
  const { error } = await db().from('orders')
    .update({ chat_active: true, chat_opened_at: new Date().toISOString() })
    .eq('id', orderId);
  if (error) console.error('[chat.activateOrderChat]', error.message);
}

module.exports = {
  persistMessage,
  markDelivered,
  setActiveChat,
  clearActiveChat,
  getActiveChat,
  getOrderForChat,
  isParticipant,
  listMessages,
  activateOrderChat,
};
