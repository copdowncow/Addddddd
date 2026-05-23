-- Таймер ответа магазина: от момента подтверждения оплаты, не от updated_at
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;

UPDATE orders
SET payment_confirmed_at = updated_at
WHERE payment_confirmed_at IS NULL
  AND status IN ('payment_confirmed', 'confirmed', 'seller_accepted', 'preparing', 'ready', 'delivered', 'confirmed_received');

CREATE INDEX IF NOT EXISTS idx_orders_shop_timeout
  ON orders (status, payment_confirmed_at)
  WHERE status IN ('payment_confirmed', 'confirmed');
