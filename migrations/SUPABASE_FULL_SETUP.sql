-- ═══════════════════════════════════════════════════════════════
-- ReBuket — полная настройка Supabase (выполнить один раз)
-- Dashboard → SQL Editor → New query → вставить → Run
-- ═══════════════════════════════════════════════════════════════

-- 1) Статусы заказов (магазин, бот, споры, возвраты)
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (
  status IN (
    'pending',
    'payment_confirmed',
    'confirmed',
    'seller_accepted',
    'preparing',
    'ready',
    'delivered',
    'rejected',
    'cancelled',
    'confirmed_received',
    'refund_requested',
    'refund_disputed',
    'refunded',
    'shipped'
  )
);

-- 2) Колонки для Telegram и админки
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_chat_id BIGINT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_telegram TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_address TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_type TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_photo_url TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receiver_name TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receiver_phone TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receiver_address TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fast_order BOOLEAN DEFAULT FALSE;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_time TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total NUMERIC(10,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS items JSONB;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS seller_payout NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_payer TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2);

-- 3) Telegram: привязка телефона/username → chat_id
CREATE TABLE IF NOT EXISTS public.telegram_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT,
  phone TEXT,
  chat_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_users_username_key ON public.telegram_users (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_users_phone_key ON public.telegram_users (phone) WHERE phone IS NOT NULL;

-- 4) Магазины: telegram_chat_id для Shop Bot
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS shop_name TEXT;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- 5) Индексы для споров и заказов
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_chat ON public.orders (customer_chat_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON public.orders (created_at DESC);

NOTIFY pgrst, 'reload schema';
