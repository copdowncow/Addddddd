'use strict';

const Commission = require('./commission');

function enrichProductPricing(product, shop = null) {
  if (!product) return null;
  const listed = Number(product.price) || 0;
  const pct = Commission.effectivePercent(product, shop);
  const mode = Commission.effectiveMode(product);
  const br = Commission.calculate(listed, pct, mode);
  return {
    ...product,
    buyer_price: br.customer_pays,
    seller_payout_amount: br.seller_payout,
    platform_fee_amount: br.platform_fee,
    commission_percent: br.commission_percent,
    pricing_mode: br.pricing_mode,
  };
}

module.exports = { enrichProductPricing, Commission };
