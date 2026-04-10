/**
 * lib/karma.js — Karma 信用評分 + 自動懲罰引擎
 *
 * 分數規則：
 *   被檢舉 -10、被封鎖 -5、被快速掛斷(<15秒) -2
 *   完成通話(>60秒) +1、被按想再遇 +3
 *
 * 自動懲罰：
 *   同一人被 3+ 不同人檢舉 → 自動暫封 24h
 *   同一人被 5+ 不同人檢舉 → 自動暫封 7 天
 *   karma < 0 → 自動暫封 7 天
 *
 * 所有操作 fire-and-forget，不阻塞主流程。
 */

// ─── Karma 加減分 ───

export async function adjustKarma(db, userId, delta, reason) {
  if (!db || !userId || !delta) return;
  try {
    await db.execute({
      sql: `UPDATE users SET karma = MAX(-100, MIN(200, karma + ?)) WHERE id = ?`,
      args: [delta, userId],
    });
    console.log(`[⭐] karma ${delta > 0 ? '+' : ''}${delta} for ${userId.slice(0, 8)} (${reason})`);
  } catch (err) {
    console.warn(`[⭐] adjustKarma failed: ${err.message}`);
  }
}

export async function getKarma(db, userId) {
  if (!db || !userId) return 100;
  try {
    const r = await db.execute({ sql: `SELECT karma FROM users WHERE id = ?`, args: [userId] });
    return r.rows[0]?.karma ?? 100;
  } catch {
    return 100;
  }
}

// ─── 自動懲罰規則 ───

export async function checkAutoModeration(db, reportedId) {
  if (!db || !reportedId) return;
  try {
    // 計算被多少不同人檢舉
    const r = await db.execute({
      sql: `SELECT COUNT(DISTINCT reporter_id) as cnt FROM kaitalk_reports WHERE reported_id = ?`,
      args: [reportedId],
    });
    const reportCount = r.rows[0]?.cnt || 0;

    if (reportCount >= 5) {
      await autoBan(db, reportedId, 7 * 24, 'auto_report_threshold', `被 ${reportCount} 人檢舉`);
    } else if (reportCount >= 3) {
      await autoBan(db, reportedId, 24, 'auto_report_threshold', `被 ${reportCount} 人檢舉`);
    }

    // 檢查 karma
    const karma = await getKarma(db, reportedId);
    if (karma < 0) {
      await autoBan(db, reportedId, 7 * 24, 'auto_karma_low', `karma=${karma}`);
    }
  } catch (err) {
    console.warn(`[🤖] checkAutoModeration failed: ${err.message}`);
  }
}

async function autoBan(db, userId, hours, reason, details) {
  try {
    // 檢查是否已有未過期的封禁
    const existing = await db.execute({
      sql: `SELECT id FROM kaitalk_penalties
            WHERE user_id = ? AND action IN ('temp_ban','perm_ban')
            AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            AND revoked_at IS NULL`,
      args: [userId],
    });
    if (existing.rows.length > 0) return; // 已封禁中

    const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

    // 寫懲罰紀錄
    await db.execute({
      sql: `INSERT INTO kaitalk_penalties (user_id, action, reason, details, duration_hours, expires_at)
            VALUES (?, 'temp_ban', ?, ?, ?, ?)`,
      args: [userId, reason, details, hours, expiresAt],
    });

    // 更新 users.banned_until
    await db.execute({
      sql: `UPDATE users SET banned_until = ? WHERE id = ? AND (banned_until IS NULL OR banned_until < ?)`,
      args: [expiresAt, userId, expiresAt],
    });

    console.log(`[🤖] Auto-ban: ${userId.slice(0, 8)} for ${hours}h (${reason}: ${details})`);
  } catch (err) {
    console.warn(`[🤖] autoBan failed: ${err.message}`);
  }
}

// ─── 封禁檢查（配對時用）───

export async function isBanned(db, userId) {
  if (!db || !userId) return false;
  try {
    const r = await db.execute({
      sql: `SELECT banned_until FROM users WHERE id = ?`,
      args: [userId],
    });
    const bannedUntil = r.rows[0]?.banned_until;
    if (!bannedUntil) return false;
    return new Date(bannedUntil) > new Date();
  } catch {
    return false;
  }
}

// ─── 通話結束時的 karma 事件 ───

export async function onCallEnd(db, { userA, userB, durationSec, aMarkedMeetAgain, bMarkedMeetAgain }) {
  if (!db) return;

  // 完成通話 > 60 秒 → 雙方 +1
  if (durationSec > 60) {
    adjustKarma(db, userA, 1, 'call_completed');
    adjustKarma(db, userB, 1, 'call_completed');
  }

  // 被快速掛斷 < 15 秒 → 不扣分（可能是網路問題）
  // 只有 < 5 秒才算惡意秒掛
  if (durationSec < 5 && durationSec >= 0) {
    // 不知道誰掛的，暫時不扣
  }

  // 被按想再遇 → +3
  if (aMarkedMeetAgain) adjustKarma(db, userB, 3, 'received_meet_again');
  if (bMarkedMeetAgain) adjustKarma(db, userA, 3, 'received_meet_again');
}

// ─── 被檢舉時的 karma 事件 ───

export async function onReport(db, reportedId) {
  if (!db || !reportedId) return;
  await adjustKarma(db, reportedId, -10, 'reported');
  await checkAutoModeration(db, reportedId);
}

// ─── 被封鎖時的 karma 事件 ───

export async function onBlock(db, blockedId) {
  if (!db || !blockedId) return;
  await adjustKarma(db, blockedId, -5, 'blocked');
}
