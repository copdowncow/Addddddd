'use strict';

// ─────────────────────────────────────────────────────────────
//  Marketplace commission service
//
//  pricing_mode:
//    'inclusive' — listed price IS what the customer pays;
//                  commission deducted from it for the seller.
//    'exclusive' — legacy: listed price is what the seller wants;
//                  customer pays price * (1 + commission), rounded up to 10.
//
//  Returns: { customer_pays, seller_payout, platform_fee, commission_percent, pricing_mode }
//  All values rounded to 2 decimals.
// ─────────────────────────────────────────────────────────────

const { getClient } = require('../db/supabase');

let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_TTL = 60 * 1000;

async function getPlatformSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheTime < SETTINGS_TTL) return _settingsCache;
  try {
    const { data } = await getClient()
      .from('platform_settings')
      .select('default_commission_percent, taxi_fixed_fee')
      .eq('id', 1)
      .maybeSingle();
    _settingsCache = data || { default_commission_percent: 20, taxi_fixed_fee: 50 };
  } catch (_) {
    _settingsCache = { default_commission_percent: 20, taxi_fixed_fee: 50 };
  }
  _settingsCacheTime = now;
  return _settingsCache;
}

function invalidateSettingsCache() {
  _settingsCache = null;
  _settingsCacheTime = 0;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Calculate commission breakdown for a single line
//   listedPrice  — price as stored on product
//   pct          — commission percent (0..100)
//   mode         — 'inclusive' | 'exclusive'
function calculate(listedPrice, pct, mode) {
  const price = Number(listedPrice) || 0;
  const c = Math.max(0, Math.min(100, Number(pct) || 0));
  const m = mode === 'inclusive' ? 'inclusive' : 'exclusive';
  if (price <= 0) {
    return { customer_pays: 0, seller_payout: 0, platform_fee: 0, commission_percent: c, pricing_mode: m };
  }
  if (m === 'inclusive') {
    const platform_fee = round2(price * c / 100);
    const seller_payout = round2(price - platform_fee);
    return { customer_pays: round2(price), seller_payout, platform_fee, commission_percent: c, pricing_mode: m };
  }
  // exclusive (legacy)
  const customer_pays = round2(Math.ceil(price * (1 + c / 100) / 10) * 10);
  const platform_fee = round2(customer_pays - price);
  return { customer_pays, seller_payout: round2(price), platform_fee, commission_percent: c, pricing_mode: m };
}

// Pick effective commission percent for a product
//   precedence: product.commission_percent > shop.commission_percent > platform default
function effectivePercent(product, shop, settings) {
  if (product && product.commission_percent != null) return Number(product.commission_percent);
  if (shop && shop.commission_percent != null) return Number(shop.commission_percent);
  return Number(settings?.default_commission_percent ?? 20);
}

// Pick effective pricing mode for a product
//   New shop products created after migration → 'inclusive'
//   Legacy products (mode null) → 'exclusive' (current behaviour preserved)
function effectiveMode(product) {
  if (product && product.pricing_mode) return product.pricing_mode;
  return 'exclusive';
}

module.exports = {
  getPlatformSettings,
  invalidateSettingsCache,
  calculate,
  effectivePercent,
  effectiveMode,
  round2,
};
