/**
 * lib/db.js — Turso (libSQL) client + 寫入 helpers
 *
 * 設計原則：
 * - **Lazy init**：只有第一次 query 才連 Turso
 * - **永遠不 throw**：任何 DB 錯誤都 log + 回 null/false，不阻塞 caller
 * - **記憶體 fallback**：如果 Turso 連不上，server 一切照舊，只是不存任何東西
 *
 * Phase 2B Commit 1：只有 upsertUser（連線時呼叫）
 * Phase 2B Commit 3：再加 startCall / endCall
 */

import { createClient } from '@libsql/client';

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

let db = null;
let dbReady = false;
let dbFailed = false;

function ensureDb() {
  if (dbReady) return db;
  if (dbFailed) return null;
  if (!TURSO_URL || !TURSO_TOKEN) {
    dbFailed = true;
    console.warn('[db] TURSO_URL or TURSO_TOKEN not set — DB writes disabled');
    return null;
  }
  try {
    db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
    dbReady = true;
    console.log(`[db] connected: ${TURSO_URL}`);
    return db;
  } catch (err) {
    dbFailed = true;
    console.warn(`[db] init failed: ${err.message}`);
    return null;
  }
}

export function dbConfigured() {
  return !!(TURSO_URL && TURSO_TOKEN);
}

/**
 * Upsert a user record. Called when a socket connects with a verified JWT.
 *
 * Behavior:
 * - If user.id 已存在 → 更新 last_seen_at + nickname
 * - If 不存在 → 建新 row, auth_status='anonymous'
 *
 * 永遠不 throw，失敗就 log + 回 false。
 */
export async function upsertUser({ id, nickname, isAnonymous }) {
  const conn = ensureDb();
  if (!conn) return false;
  if (!id) return false;

  try {
    await conn.execute({
      sql: `
        INSERT INTO users (id, nickname, auth_status, created_at, last_seen_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          nickname = COALESCE(excluded.nickname, users.nickname),
          last_seen_at = CURRENT_TIMESTAMP
      `,
      args: [id, nickname || 'Anonymous', isAnonymous ? 'anonymous' : 'verified'],
    });
    return true;
  } catch (err) {
    console.warn(`[db] upsertUser failed: ${err.message}`);
    return false;
  }
}

/**
 * Health check. Used by server startup or /health endpoint.
 * Returns { ok: bool, tables?: string[], error?: string }
 */
export async function healthCheck() {
  const conn = ensureDb();
  if (!conn) return { ok: false, error: 'db not configured' };
  try {
    const r = await conn.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    return { ok: true, tables: r.rows.map(row => row.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
