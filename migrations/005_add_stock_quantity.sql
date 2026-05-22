-- ──────────────────────────────────────────────────────────────
-- Migration 005: Add stock_quantity field to products table
-- ──────────────────────────────────────────────────────────────

-- Add stock_quantity field to products table
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 999999;

-- Add comment for documentation
COMMENT ON COLUMN public.products.stock_quantity IS 'Total available stock quantity. Default 999999 means unlimited/unspecified.';

NOTIFY pgrst, 'reload schema';
