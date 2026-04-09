/**
 * db/apply.js — kaitalk schema migration runner
 *
 * 跑 db/migrations/ 目錄下所有 .sql 檔，按檔名順序執行。
 *
 * Idempotent：所有 migration 都用 CREATE TABLE IF NOT EXISTS，
 * 重複跑不會壞。
 *
 * 用法：
 *   1. 在 .env.local 裡放：
 *        TURSO_URL=libsql://kaiup-youwei911.aws-ap-northeast-1.turso.io
 *        TURSO_TOKEN=eyJ...
 *   2. 從 app/ 目錄跑：
 *        node --env-file=.env.local db/apply.js
 *
 *   或直接給環境變數：
 *        TURSO_URL=... TURSO_TOKEN=... node db/apply.js
 *
 * 想加新 migration？
 *   - 在 db/migrations/ 新增一個 005_xxx.sql
 *   - 永遠不要改舊的 migration 檔
 *   - 跑 node --env-file=.env.local db/apply.js
 */

import { createClient } from '@libsql/client';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, 'migrations');

// ─── 讀環境變數 ───
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌ 缺少環境變數 TURSO_URL 或 TURSO_TOKEN');
  console.error('');
  console.error('請在 app/.env.local 放：');
  console.error('  TURSO_URL=libsql://kaiup-youwei911.aws-ap-northeast-1.turso.io');
  console.error('  TURSO_TOKEN=你的 token');
  console.error('');
  console.error('然後跑：');
  console.error('  node --env-file=.env.local db/apply.js');
  process.exit(1);
}

// ─── 連 DB ───
const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

console.log(`\n🗃  kaitalk schema migration`);
console.log(`   ──────────────────────────`);
console.log(`   target: ${TURSO_URL}`);
console.log('');

// ─── 讀所有 .sql 檔，按檔名排序 ───
let files;
try {
  files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
} catch (err) {
  console.error(`❌ 讀不到 migrations 目錄: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`❌ ${MIGRATIONS_DIR} 沒有 .sql 檔`);
  process.exit(1);
}

console.log(`   找到 ${files.length} 個 migration:`);
files.forEach(f => console.log(`     - ${f}`));
console.log('');

// ─── 一個一個跑 ───
//
// libsql 不支援單個 execute 跑多個 statement，所以要手動切。
// 簡單版 splitter：用 ';' 切，過濾空白與註解。
// 我們的 .sql 檔都是簡單 CREATE TABLE / CREATE INDEX，
// 沒有 stored procedure 或 string literal 含 ';' 的情況。

function splitSql(sql) {
  return sql
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      if (!s) return false;
      // 過濾掉只有 comment 的 chunk
      const stripped = s.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim();
      return stripped.length > 0;
    });
}

let totalStatements = 0;
let totalErrors = 0;

for (const file of files) {
  const path = join(MIGRATIONS_DIR, file);
  const sql = readFileSync(path, 'utf8');
  const statements = splitSql(sql);

  console.log(`▶  ${file} (${statements.length} statements)`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    // 顯示 statement 第一行給 visual feedback
    const firstLine = stmt
      .split('\n')
      .find(l => !l.trim().startsWith('--') && l.trim()) || '';
    const preview = firstLine.trim().slice(0, 60);

    try {
      await db.execute(stmt);
      console.log(`   ✅ ${preview}${firstLine.length > 60 ? '...' : ''}`);
      totalStatements++;
    } catch (err) {
      console.error(`   ❌ ${preview}`);
      console.error(`      ${err.message}`);
      totalErrors++;
    }
  }
  console.log('');
}

// ─── 結果 ───
console.log(`──────────────────────────`);
if (totalErrors === 0) {
  console.log(`✅ ${totalStatements} statements 全部成功`);
} else {
  console.log(`⚠️  ${totalStatements} 成功, ${totalErrors} 失敗`);
}

// ─── 驗證表都存在 ───
console.log('');
console.log(`🔍 驗證表存在:`);
try {
  const tables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  for (const row of tables.rows) {
    console.log(`   ✓ ${row.name}`);
  }
} catch (err) {
  console.error(`   ❌ 查表清單失敗: ${err.message}`);
}

console.log('');
process.exit(totalErrors > 0 ? 1 : 0);
