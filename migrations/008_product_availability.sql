-- Доступность товара магазина + статус «снято с продажи»
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS availability_type TEXT DEFAULT 'in_stock';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS prepare_hours INTEGER;

-- status: sold_out = снято с продажи (не в каталоге, видно магазину)
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE public.products ADD CONSTRAINT products_status_check CHECK (
  status IN ('pending', 'active', 'hidden', 'rejected', 'sold_out')
);

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_availability_type_check;
ALTER TABLE public.products ADD CONSTRAINT products_availability_type_check CHECK (
  availability_type IN ('in_stock', 'on_order')
);

NOTIFY pgrst, 'reload schema';
