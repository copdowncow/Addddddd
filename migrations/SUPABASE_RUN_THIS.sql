-- ═══════════════════════════════════════════════════════════════
-- ReBuket — выполните ВЕСЬ файл в Supabase → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════

-- 1) Shop Bot: chat_id магазина
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_shops_telegram_chat_id ON public.shops (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- 2) Таймер ответа магазина
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shop_response_deadline_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shop_notify_at TIMESTAMPTZ;

-- 3) Старые заказы: убрать ложные дедлайны (чтобы не спамили «отклонено»)
UPDATE public.orders
SET shop_response_deadline_at = NULL
WHERE shop_notify_at IS NULL
  AND status IN ('payment_confirmed', 'confirmed');

-- 4) Индексы для таймера (только новые заказы с shop_notify_at)
CREATE INDEX IF NOT EXISTS idx_orders_shop_notify_timer
  ON public.orders (status, shop_notify_at, shop_response_deadline_at)
  WHERE shop_notify_at IS NOT NULL
    AND status IN ('payment_confirmed', 'confirmed');

-- 5) (опционально) Цены магазинов inclusive — если ещё не делали
-- ALTER TABLE public.products ADD COLUMN IF NOT EXISTS pricing_mode TEXT DEFAULT 'inclusive';
-- UPDATE public.products SET pricing_mode = 'inclusive'
-- WHERE listing_type = 'shop' OR seller_phone IN (SELECT phone FROM shops WHERE status = 'active');
