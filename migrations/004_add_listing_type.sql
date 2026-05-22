-- Add listing_type column to products table if it doesn't exist
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS listing_type TEXT DEFAULT 'eco';

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_products_listing_type ON public.products(listing_type);

-- Update existing products: mark as 'shop' if seller is in shops table
UPDATE public.products p
SET listing_type = 'shop'
WHERE EXISTS (
  SELECT 1 FROM public.shops s
  WHERE s.phone = p.seller_phone
  AND s.status = 'active'
);

-- Mark remaining as 'eco'
UPDATE public.products
SET listing_type = 'eco'
WHERE listing_type IS NULL OR listing_type = '';
