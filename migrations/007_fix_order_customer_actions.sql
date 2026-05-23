-- Обязательно для кнопок «Получил заказ» и «Есть проблема»
-- Выполните в Supabase → SQL Editor

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (
  status IN (
    'pending', 'payment_confirmed', 'confirmed', 'seller_accepted',
    'preparing', 'ready', 'delivered', 'rejected', 'cancelled',
    'confirmed_received', 'refund_requested', 'refunded', 'refund_disputed',
    'shipped'
  )
);

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_chat_id BIGINT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
