-- Shop Bot: привязка Telegram chat_id к магазину (обязательно для уведомлений о заказах)
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_shops_telegram_chat_id ON public.shops (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

COMMENT ON COLUMN public.shops.telegram_chat_id IS 'Telegram chat_id после /start в Shop Bot (телефон + пароль)';
