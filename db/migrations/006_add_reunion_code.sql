-- ════════════════════════════════════════════════════════════════
-- 006_add_reunion_code.sql
--
-- 重逢碼：互相「想再遇」的配對拿到一組 6 位碼
-- 任一方輸入碼 → 優先配對
-- ════════════════════════════════════════════════════════════════

ALTER TABLE connections ADD COLUMN reunion_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_reunion_code
  ON connections(reunion_code) WHERE reunion_code IS NOT NULL;
