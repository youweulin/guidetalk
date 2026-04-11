-- ════════════════════════════════════════════════════════════════
-- 010_add_invite_token.sql
--
-- 邀請碼：每個用戶一組隨機 token，分享連結邀好友
-- 用戶可以重新產生 token 讓舊連結失效
-- ════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN invite_token TEXT;
ALTER TABLE users ADD COLUMN invite_token_created_at TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_token
  ON users(invite_token) WHERE invite_token IS NOT NULL;
