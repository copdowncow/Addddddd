'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL или SUPABASE_SERVICE_KEY не заданы в .env');
  process.exit(1);
}

let _client = null;

function getClient() {
  if (_client) return _client;
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

async function q(fn) {
  try {
    const client = getClient();
    const { data, error } = await fn(client);

    if (error) {
      console.error('Supabase error:', error);
      throw new Error(error.message || 'Ошибка базы данных');
    }

    return data;
  } catch (err) {
    throw err;
  }
}

async function uploadPhoto(buffer, filename, mimetype) {
  const client = getClient();
  const path = `products/${Date.now()}_${filename}`;

  const { error } = await client.storage
    .from('rebuket-photos')
    .upload(path, buffer, { contentType: mimetype, upsert: true });

  if (error) throw new Error('Storage upload failed: ' + error.message);

  const { data: urlData } = client.storage
    .from('rebuket-photos')
    .getPublicUrl(path);

  return urlData.publicUrl;
}

module.exports = { getClient, q, uploadPhoto };