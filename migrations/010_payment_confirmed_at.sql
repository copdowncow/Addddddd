-- Таймер ответа магазина: от момента подтверждения оплаты, не от updated_at
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_response_deadline_at TIMESTAMPTZ;

UPDATE orders
SET payment_confirmed_at = COALESCE(payment_confirmed_at, updated_at)
WHERE status IN ('payment_confirmed', 'confirmed')
  AND payment_confirmed_at IS NULL;

UPDATE orders
SET shop_response_deadline_at = payment_confirmed_at + INTERVAL '10 minutes'
WHERE status IN ('payment_confirmed', 'confirmed')
  AND shop_response_deadline_at IS NULL
  AND payment_confirmed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_shop_timeout
  ON orders (status, shop_response_deadline_at)
  WHERE status IN ('payment_confirmed', 'confirmed');
