-- Добавить колонку is_blocked в таблицу shops
-- Это позволит блокировать магазины без изменения статуса

ALTER TABLE public.shops 
ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;

-- Создать индекс для быстрого поиска заблокированных магазинов
CREATE INDEX IF NOT EXISTS idx_shops_is_blocked ON public.shops(is_blocked);

-- Обновить триггер updated_at (если нужно)
-- Триггер уже существует, поэтому обновлять его не нужно
