-- Table to store Telegram username/phone -> chat_id mappings for notifications
DROP TABLE IF EXISTS public.telegram_users CASCADE;

CREATE TABLE public.telegram_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT,
  phone TEXT,
  chat_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (username),
  UNIQUE (phone)
);

-- Index for fast lookup by username
CREATE INDEX idx_telegram_users_username ON public.telegram_users(username) WHERE username IS NOT NULL;

-- Index for fast lookup by phone
CREATE INDEX idx_telegram_users_phone ON public.telegram_users(phone) WHERE phone IS NOT NULL;

-- Trigger for updated_at
CREATE TRIGGER telegram_users_updated_at
BEFORE UPDATE ON public.telegram_users
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

NOTIFY pgrst, 'reload schema';
