-- ──────────────────────────────────────────────────────────────
-- Migration 001: Create shops, orders, and chat tables
-- Run in Supabase SQL editor FIRST before any other migrations
-- ──────────────────────────────────────────────────────────────

-- ── SHOPS TABLE ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  shop_name TEXT,
  city TEXT,
  telegram TEXT,
  photo_url TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shops_phone ON public.shops(phone);
CREATE INDEX IF NOT EXISTS idx_shops_status ON public.shops(status);

-- ── ORDERS TABLE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  shop_phone TEXT,
  customer_name TEXT,
  customer_phone TEXT NOT NULL,
  customer_address TEXT,
  customer_telegram TEXT,
  items JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','shipped','delivered','cancelled','confirmed_received')),
  total_amount NUMERIC(10,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_product ON public.orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop_phone ON public.orders(shop_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at);

-- ── CHAT MESSAGES TABLE ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('customer','shop','admin','system')),
  sender_phone TEXT,
  text TEXT,
  photo_url TEXT,
  tg_message_id BIGINT,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_order ON public.chat_messages(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON public.chat_messages(sender, created_at);

-- ── CHAT SESSIONS TABLE ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  chat_id BIGINT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer','shop')),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  shop_phone TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_order ON public.chat_sessions(order_id);

-- ── DISABLE RLS ──────────────────────────────────────────────
ALTER TABLE public.shops DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions DISABLE ROW LEVEL SECURITY;

-- ── UPDATE TRIGGERS ──────────────────────────────────────────
DROP TRIGGER IF EXISTS shops_updated_at ON public.shops;
DROP TRIGGER IF EXISTS orders_updated_at ON public.orders;

CREATE TRIGGER shops_updated_at
BEFORE UPDATE ON public.shops
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER orders_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

NOTIFY pgrst, 'reload schema';
