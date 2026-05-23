-- Orders: статусы приложения + поля для Telegram-уведомлений
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
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_photo_url TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_type TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receiver_name TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receiver_phone TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS receiver_address TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS fast_order BOOLEAN DEFAULT FALSE;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_time TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total NUMERIC(10,2);

NOTIFY pgrst, 'reload schema';
