-- Table to store Telegram username -> chat_id mappings for notifications
DROP TABLE IF EXISTS public.telegram_users CASCADE;

CREATE TABLE public.telegram_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  chat_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by username
CREATE INDEX idx_telegram_users_username ON public.telegram_users(username);

-- Trigger for updated_at
CREATE TRIGGER telegram_users_updated_at
BEFORE UPDATE ON public.telegram_users
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

NOTIFY pgrst, 'reload schema';
