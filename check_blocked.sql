-- Проверить статус блокировки магазина
SELECT id, phone, shop_name, is_blocked, status 
FROM public.shops 
WHERE phone = 'ВАШ_ТЕЛЕФОН';

-- Если is_blocked = false, заблокируйте магазин:
-- UPDATE public.shops 
-- SET is_blocked = true 
-- WHERE phone = 'ВАШ_ТЕЛЕФОН';
