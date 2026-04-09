/**
 * lib/auth.js — Supabase JWT 驗證 helper
 *
 * 用 JWKS 機制（非對稱）驗 Supabase 發出來的 JWT。
 * 不需要 secret，server 從 Supabase 自動 fetch public key。
 *
 * 設計原則：
 * - **Lazy init**：只有第一次 verify 才建 JWKS client
 * - **永遠不 throw**：任何錯誤都回 null，讓 caller 自己決定要不要 graceful degrade
 * - **不打 server log**：這裡只負責 verify，log 由 caller 處理
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ISSUER = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : null;
const JWKS_URL = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` : null;

let JWKS = null;
let jwksReady = false;

function ensureJwks() {
  if (jwksReady) return JWKS;
  if (!JWKS_URL) return null;
  try {
    JWKS = createRemoteJWKSet(new URL(JWKS_URL));
    jwksReady = true;
    return JWKS;
  } catch {
    return null;
  }
}

/**
 * 驗證 JWT，回傳 { userId, isAnonymous, payload } 或 null
 *
 * 失敗的所有可能：
 * - 沒設 SUPABASE_URL
 * - JWKS endpoint 連不上
 * - token 過期
 * - token 簽名錯
 * - issuer 不對
 * 任何失敗都回 null，不 throw
 */
export async function verifySupabaseJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const jwks = ensureJwks();
  if (!jwks) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
    return {
      userId: payload.sub,
      isAnonymous: payload.is_anonymous === true,
      role: payload.role,
      payload,
    };
  } catch {
    return null;
  }
}

export function authConfigured() {
  return !!SUPABASE_URL;
}

export function authConfig() {
  return { SUPABASE_URL, ISSUER, JWKS_URL };
}
