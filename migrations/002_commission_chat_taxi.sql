-- ──────────────────────────────────────────────────────────────
-- Migration 002: Commission system + Chat relay + Taxi delivery
-- Aditive: existing rows untouched, all new columns nullable
-- Run in Supabase SQL editor
-- ──────────────────────────────────────────────────────────────

-- ── Platform settings (single-row config table) ─────────────
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  taxi_fixed_fee             NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.platform_settings DISABLE ROW LEVEL SECURITY;

-- ── Per-product commission override + pricing semantics ─────
-- pricing_mode:
--   'inclusive' (NEW): listed price IS what the customer pays;
--                     commission is deducted from it for the seller.
--   'exclusive' (legacy): listed price is what the seller wants;
--                     customer pays price * (1 + commission).
-- Existing rows have NULL → treated as legacy 'exclusive' for backward compat.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS pricing_mode       TEXT
    CHECK (pricing_mode IN ('inclusive','exclusive'));

-- ── Per-shop commission override (optional) ─────────────────
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2);

-- ── Editable shop profile fields ────────────────────────────
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS cover_url        TEXT,
  ADD COLUMN IF NOT EXISTS delivery_info    TEXT,
  ADD COLUMN IF NOT EXISTS categories       TEXT[],
  ADD COLUMN IF NOT EXISTS verified         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rating           NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS rating_count     INTEGER NOT NULL DEFAULT 0;

-- ── Order: financial breakdown + delivery payer + chat flag ─
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS subtotal           NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS delivery_fee       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_payer     TEXT
    CHECK (delivery_payer IN ('buyer','fixed','pickup','none')),
  ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS platform_fee       NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seller_payout      NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_active        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chat_opened_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_chat_active ON public.orders(chat_active) WHERE chat_active = TRUE;

-- ── Chat messages (relay between customer ↔ shop via bots) ──
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL CHECK (sender IN ('customer','shop','admin','system')),
  sender_phone TEXT,                 -- shop.phone if sender='shop'
  text        TEXT,
  photo_url   TEXT,
  tg_message_id BIGINT,              -- original Telegram message id (for de-dup)
  delivered   BOOLEAN NOT NULL DEFAULT FALSE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_order ON public.chat_messages(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON public.chat_messages(sender, created_at);
ALTER TABLE public.chat_messages DISABLE ROW LEVEL SECURITY;

-- ── Active-chat lookup: which order is each user currently chatting about ──
-- For relay: when shop / customer types in their bot, we need to know which order.
CREATE TABLE IF NOT EXISTS public.chat_sessions (
  chat_id     BIGINT PRIMARY KEY,        -- Telegram chat id
  role        TEXT NOT NULL CHECK (role IN ('customer','shop')),
  order_id    UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  shop_phone  TEXT,                      -- if role='shop'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_order ON public.chat_sessions(order_id);
ALTER TABLE public.chat_sessions DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
