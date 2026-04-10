-- ════════════════════════════════════════════════════════════════
-- 008_create_letters.sql
--
-- 信件系統（付費功能）
-- 只有互相想再遇（matched=true）的好友才能寫信
-- 免費用戶不能寫，付費用戶每天 3 封
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kaitalk_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_uid TEXT NOT NULL,
  to_uid TEXT NOT NULL,
  body TEXT NOT NULL,
  lang TEXT,
  translated TEXT,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_letters_to ON kaitalk_letters(to_uid, read_at);
CREATE INDEX IF NOT EXISTS idx_letters_from ON kaitalk_letters(from_uid, created_at);
