-- ──────────────────────────────────────────────────────────────
-- Main Schema - Complete database structure for Re.Buket
-- This file includes all tables needed for the application
-- ──────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.chat_sessions CASCADE;
DROP TABLE IF EXISTS public.chat_messages CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.inquiries CASCADE;
DROP TABLE IF EXISTS public.products CASCADE;
DROP TABLE IF EXISTS public.shops CASCADE;
DROP TABLE IF EXISTS public.admins CASCADE;
DROP TABLE IF EXISTS public.platform_settings CASCADE;

-- ── ADMINS TABLE ─────────────────────────────────────────────
CREATE TABLE public.admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── SHOPS TABLE ──────────────────────────────────────────────
CREATE TABLE public.shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  shop_name TEXT,
  city TEXT,
  telegram TEXT,
  photo_url TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','rejected')),
  commission_percent NUMERIC(5,2),
  cover_url TEXT,
  delivery_info TEXT,
  categories TEXT[],
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  rating NUMERIC(3,2),
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── PRODUCTS TABLE ───────────────────────────────────────────
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK(category IN ('bouquet','basket','bear','sweets')),
  price NUMERIC(10,2) NOT NULL,
  city TEXT NOT NULL,
  seller_name TEXT,
  seller_phone TEXT NOT NULL,
  seller_telegram TEXT,
  seller_chat_id BIGINT,
  address TEXT,
  pickup_time TEXT,
  gift_when TEXT,
  market_price NUMERIC(10,2),
  size TEXT,
  photos TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','hidden')),
  view_count INTEGER NOT NULL DEFAULT 0,
  slug TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ,
  listing_type TEXT,
  shop_name TEXT,
  photo_url TEXT,
  is_admin_price BOOLEAN DEFAULT FALSE,
  pricing_mode TEXT CHECK (pricing_mode IN ('inclusive','exclusive')),
  commission_percent NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ORDERS TABLE ─────────────────────────────────────────────
CREATE TABLE public.orders (
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
  subtotal NUMERIC(10,2),
  delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_payer TEXT CHECK (delivery_payer IN ('buyer','fixed','pickup','none')),
  commission_percent NUMERIC(5,2),
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  seller_payout NUMERIC(10,2) NOT NULL DEFAULT 0,
  chat_active BOOLEAN NOT NULL DEFAULT FALSE,
  chat_opened_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHAT MESSAGES TABLE ──────────────────────────────────────
CREATE TABLE public.chat_messages (
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

-- ── CHAT SESSIONS TABLE ──────────────────────────────────────
CREATE TABLE public.chat_sessions (
  chat_id BIGINT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer','shop')),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  shop_phone TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── INQUIRIES TABLE ──────────────────────────────────────────
CREATE TABLE public.inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT NOT NULL,
  customer_telegram TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','done')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── PLATFORM SETTINGS TABLE ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  taxi_fixed_fee NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX idx_shops_phone ON public.shops(phone);
CREATE INDEX idx_shops_status ON public.shops(status);
CREATE INDEX idx_products_status ON public.products(status);
CREATE INDEX idx_products_category ON public.products(category);
CREATE INDEX idx_products_slug ON public.products(slug);
CREATE INDEX idx_products_seller_phone ON public.products(seller_phone);
CREATE INDEX idx_products_city ON public.products(city);
CREATE INDEX idx_orders_product ON public.orders(product_id);
CREATE INDEX idx_orders_shop_phone ON public.orders(shop_phone);
CREATE INDEX idx_orders_status ON public.orders(status);
CREATE INDEX idx_orders_created_at ON public.orders(created_at);
CREATE INDEX idx_orders_chat_active ON public.orders(chat_active) WHERE chat_active = TRUE;
CREATE INDEX idx_chat_messages_order ON public.chat_messages(order_id, created_at);
CREATE INDEX idx_chat_messages_sender ON public.chat_messages(sender, created_at);
CREATE INDEX idx_chat_sessions_order ON public.chat_sessions(order_id);
CREATE INDEX idx_inquiries_status ON public.inquiries(status);

-- ── FUNCTIONS ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── TRIGGERS ─────────────────────────────────────────────────
CREATE TRIGGER admins_updated_at
BEFORE UPDATE ON public.admins
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER shops_updated_at
BEFORE UPDATE ON public.shops
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER products_updated_at
BEFORE UPDATE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER orders_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

-- ── DISABLE ROW LEVEL SECURITY ───────────────────────────────
ALTER TABLE public.admins DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.shops DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.products DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inquiries DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
