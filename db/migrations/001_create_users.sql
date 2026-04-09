-- ════════════════════════════════════════════════════════════════
-- 001_create_users.sql
--
-- 跨產品共用的 user 主表。
-- porkergame 之後也會接這個表（Phase 4），所以欄位設計要考慮
-- 兩邊都用得到，不要只為 kaitalk 量身訂做。
--
-- Auth 流程設計（兩階段）：
--   1. 用戶第一次開 App → 自動建匿名帳號（auth_status='anonymous'）
--   2. 用戶選擇升級 → 接 Google/Apple/LINE OAuth → status='verified'
--   同一個 id 不變，所有歷史保留
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  -- ─── 識別 ───
  -- Supabase Auth user.id（UUID）。匿名跟正式帳號共用同一個 id。
  id TEXT PRIMARY KEY,

  -- 顯示用暱稱，8 字內，可以重複（不是 unique）
  nickname TEXT NOT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- ─── Auth 狀態 ───
  -- 'anonymous' = 還沒升級的匿名帳號
  -- 'verified'  = 接過 OAuth provider 的正式帳號
  auth_status TEXT NOT NULL DEFAULT 'anonymous',

  -- 升級為正式帳號後填的欄位
  email TEXT,
  google_id TEXT UNIQUE,
  apple_id TEXT UNIQUE,
  line_id TEXT UNIQUE,

  -- ─── 「我是哪裡人」（永久身份）───
  -- 跟 kaitalk_calls.a_country / b_country 不一樣。
  -- 那個是「通話時人在哪」（旅遊、移居、VPN 都可能不同）。
  -- 這個是「我長期屬於哪裡」，第一次配對自動填，用戶可以手動改。
  home_country TEXT,                    -- 'TW' | 'JP' | 'US' | 'KR' | ...
  home_city TEXT,                       -- '台北' | '東京' | ...

  -- ─── 偏好 ───
  -- 用戶選的 STT/翻譯語言
  preferred_lang TEXT,                  -- 'zh-TW' | 'ja-JP' | 'en-US' | 'ko-KR' | 'zh-CN'

  -- ─── 跨產品 stats ───
  -- 給未來的「成就感」+「分析」用
  porkergame_games INTEGER NOT NULL DEFAULT 0,
  kaitalk_calls INTEGER NOT NULL DEFAULT 0,

  -- ─── 軟刪除 + 封禁 ───
  deleted_at TIMESTAMP,
  banned_until TIMESTAMP
);

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);
CREATE INDEX IF NOT EXISTS idx_users_home_country ON users(home_country);
CREATE INDEX IF NOT EXISTS idx_users_auth_status ON users(auth_status);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
