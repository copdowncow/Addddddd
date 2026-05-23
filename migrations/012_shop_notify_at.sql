-- Таймер магазина только для заказов, куда Shop Bot реально отправил уведомление (не для старых)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_notify_at TIMESTAMPTZ;

-- Снять искусственные дедлайны с прошлых заказов (backfill из 010_payment_confirmed_at.sql)
UPDATE orders
SET shop_response_deadline_at = NULL
WHERE shop_notify_at IS NULL
  AND status IN ('payment_confirmed', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_orders_shop_notify_timer
  ON orders (status, shop_notify_at, shop_response_deadline_at)
  WHERE shop_notify_at IS NOT NULL
    AND status IN ('payment_confirmed', 'confirmed');
