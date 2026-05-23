-- Shop listings: listed price is what the customer pays (commission deducted, not added).
UPDATE products
SET pricing_mode = 'inclusive'
WHERE pricing_mode IS NULL
  AND (
    listing_type = 'shop'
    OR seller_phone IN (SELECT phone FROM shops WHERE status = 'active')
  );
