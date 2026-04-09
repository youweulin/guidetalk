# kaitalk schema

跨產品共用的資料庫 schema（kaitalk + porkergame）。

DB host: **Turso (libSQL)** at `kaiup-youwei911.aws-ap-northeast-1.turso.io`

---

## 📋 表清單

| 表名 | 用途 | 共用？ |
|---|---|---|
| `users` | 用戶主表（id / 暱稱 / OAuth / 國家） | ✅ kaitalk + porkergame 共用 |
| `kaitalk_calls` | 通話 metadata（時間 / 國家 / 想再遇） | kaitalk 專用 |
| `connections` | 兩用戶間關係（互動次數 / 想再遇 / 封鎖） | ✅ 共用 |
| `kaitalk_reports` | 用戶檢舉 | kaitalk 專用 |

> 之後 porkergame 加用戶系統時，會新增 `porkergame_*` 開頭的表，
> 但 `users` 跟 `connections` 兩張共用表不會動。

---

## 🔐 隱私原則

**通話內容絕對不存** —— server 完全沒有任何欄位放音訊、字幕、翻譯。

唯一例外：用戶**主動按檢舉**時，client 會把 in-memory subtitle buffer
打包成 JSON 上傳到 `kaitalk_reports.evidence_snapshot`。
這是用戶授權的，不是 server 偷存的。

IP 位址用 `sha256(ip)[:16]` hash，不存原 IP。
找不回原 IP，但能偵測同 IP 重複行為（防濫用）。

---

## 🚀 怎麼跑 migration

### 第一次設定

1. 建 `app/.env.local`（已被 `.gitignore` 排除，**絕不會被 push**）：
   ```
   TURSO_URL=libsql://kaiup-youwei911.aws-ap-northeast-1.turso.io
   TURSO_TOKEN=你的 token
   ```
2. 安裝相依：
   ```bash
   cd app
   npm install
   ```
3. 跑 migration：
   ```bash
   node --env-file=.env.local db/apply.js
   ```

### 之後再跑

migration 是 **idempotent** 的（用 `CREATE TABLE IF NOT EXISTS`），
重複跑不會壞。

```bash
node --env-file=.env.local db/apply.js
```

預期輸出：
```
🗃  kaitalk schema migration
   ──────────────────────────
   target: libsql://kaiup-youwei911.aws-ap-northeast-1.turso.io

   找到 4 個 migration:
     - 001_create_users.sql
     - 002_create_kaitalk_calls.sql
     - 003_create_connections.sql
     - 004_create_kaitalk_reports.sql

▶  001_create_users.sql (5 statements)
   ✅ CREATE TABLE IF NOT EXISTS users (...
   ✅ CREATE INDEX IF NOT EXISTS idx_users_nickname ...
   ...

──────────────────────────
✅ 18 statements 全部成功

🔍 驗證表存在:
   ✓ connections
   ✓ kaitalk_calls
   ✓ kaitalk_reports
   ✓ users
```

---

## ➕ 怎麼加新 migration

**永遠不要改舊的 migration 檔。** 只新增新的：

```bash
# 例如要加 user.avatar_url
echo "ALTER TABLE users ADD COLUMN avatar_url TEXT;" \
  > db/migrations/005_add_user_avatar.sql

# 跑一下
node --env-file=.env.local db/apply.js
```

檔名前綴的數字決定執行順序，永遠遞增。

---

## 🤝 porkergame 整合計劃（Phase 4）

目前 porkergame 完全不知道這個 schema 存在。整合時要做的事：

1. **porkergame server.js 加 Supabase Auth client**
   - 讀同一份 `users` 表
   - 當 porkergame 玩家加入房間時，更新 `users.last_seen_at`

2. **打牌結束後寫 `connections` 表**
   - 在 porkergame 玩過的人 → `connections.first_met_via='porkergame'`
   - 累計 `porkergame_game_count`

3. **跨產品「我的朋友」頁**
   - 在 porkergame 顯示「在 kaitalk 配對過 + matched 的人」
   - 在 kaitalk 顯示「在 porkergame 一起玩過的人」
   - 一鍵邀請對方到另一個產品

4. **這些工作完全不需要動 schema** —— 因為現在就設計好了。

---

## ⚠️ 不要做的事

- ❌ 不要在 production 用 GUI 工具直接改 schema（用 migration）
- ❌ 不要把 `TURSO_TOKEN` 寫進 git tracked 檔（用 `.env.local`）
- ❌ 不要改舊的 migration 檔（新增）
- ❌ 不要在 `users` 表加 kaitalk-only 或 porkergame-only 的欄位
  （那種放各自的專屬表）
- ❌ 不要在 server.js 直接寫 SQL string concat（用 prepared statement）
