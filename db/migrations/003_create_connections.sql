-- ════════════════════════════════════════════════════════════════
-- 003_create_connections.sql
--
-- 跨產品共用：兩個用戶之間的「關係」
-- - 在 kaitalk 配對過幾次
-- - 在 porkergame 一起玩過幾次
-- - 是否互相按了「想再遇」
-- - 是否封鎖
--
-- Composite primary key (user_a, user_b)
-- 慣例：user_a < user_b（lexicographical 排序），避免重複
-- 例如 ('alice', 'bob') 跟 ('bob', 'alice') 不會同時存在
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS connections (
  -- ─── 雙方識別 ───
  user_a TEXT NOT NULL,                 -- → users.id (alphabetically smaller)
  user_b TEXT NOT NULL,                 -- → users.id (alphabetically larger)

  -- ─── 第一次認識 ───
  first_met_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  first_met_via TEXT NOT NULL,          -- 'kaitalk' | 'porkergame' | 'invite'

  -- 最近一次互動時間（kaitalk 通話結束 or porkergame 一局結束）
  last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- ─── 互動統計 ───
  -- kaitalk
  kaitalk_call_count INTEGER NOT NULL DEFAULT 0,
  kaitalk_total_sec INTEGER NOT NULL DEFAULT 0,

  -- porkergame
  porkergame_game_count INTEGER NOT NULL DEFAULT 0,

  -- ─── 「想再遇」狀態 ───
  -- 兩人各自獨立決定，雙方都按了就 matched=true
  a_likes_b BOOLEAN NOT NULL DEFAULT FALSE,
  a_likes_at TIMESTAMP,
  b_likes_a BOOLEAN NOT NULL DEFAULT FALSE,
  b_likes_at TIMESTAMP,

  -- 兩人都按了→ matched=true
  -- 配對佇列會優先把 matched=true 的兩人配在一起
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  matched_at TIMESTAMP,

  -- ─── 封鎖 ───
  -- 任一方封鎖了就不會再被配對到
  a_blocked_b BOOLEAN NOT NULL DEFAULT FALSE,
  a_blocked_at TIMESTAMP,
  b_blocked_a BOOLEAN NOT NULL DEFAULT FALSE,
  b_blocked_at TIMESTAMP,

  PRIMARY KEY (user_a, user_b)
);

-- ─── Indexes ───
-- 查 "誰跟我 matched" 用
CREATE INDEX IF NOT EXISTS idx_connections_a_matched ON connections(user_a, matched);
CREATE INDEX IF NOT EXISTS idx_connections_b_matched ON connections(user_b, matched);

-- 查 "我封鎖了誰 / 被誰封鎖" 用
CREATE INDEX IF NOT EXISTS idx_connections_blocks ON connections(a_blocked_b, b_blocked_a);

-- 查 "誰最近跟我互動過" 用
CREATE INDEX IF NOT EXISTS idx_connections_last ON connections(last_interaction_at);
