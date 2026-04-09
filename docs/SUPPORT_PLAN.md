# kaitalk · Support Plan（變現計劃）

> 寫於 2026-04-10。
> 這份不是「現在要做的事」，是「**Phase 4 要做的事的設計藍圖**」。
> 現在做了會死得很慘（沒 OAuth、沒 IAP、沒真實用戶）。
> 但**設計現在記下來**，避免之後忘記今天的靈感。

---

## 🎯 命名

**「💚 支持 kaitalk」**

- 中文：支持 kaitalk
- 英文：Support kaitalk
- 日文：kaitalk を応援

**為什麼用「支持」不用「VIP」「Premium」「Pro」**：
- 「支持」= 用戶**主動付出**的姿態（不是被收費）
- 「VIP」= 商業 / 階級感
- 「支持」= 共創、夥伴感
- 跨文化都吃這套（投げ銭、打賞、後援）

---

## 🧠 核心 Insight：**贊助 = VIP 通道**

這不是兩個東西，是**同一個東西**。

### 兩個失敗的單一模式

**純贊助**（GitHub Sponsors / Buy Me a Coffee）：
- ❌ 沒回報 → 收入不穩
- ❌ 用戶覺得「捐錢就沒了」

**純 VIP 訂閱**（Spotify / Netflix）：
- ❌ 用戶覺得「被收費」
- ❌ 開發者像商人

### 合併之後

**「支持 kaitalk → 自動解鎖 VIP 通道」**

- ✅ 用戶感受：**我在做好事**（情感）
- ✅ 用戶實得：**穩定通話 + 無限翻譯**（理性）
- ✅ 開發者感受：**我有支持者，不是消費者**
- ✅ 收入結構：**訂閱穩定**

→ 教科書級的 freemium 設計。對標 Patreon / Twitch Subs / YouTube Memberships。

---

## 💰 定價（最終決定）

### 兩個 SKU 就好

```
🎁 體驗包 NT$49 一次性
   - 1 次完整翻譯通話（無 30 句限制）
   - 永不過期
   - 給害怕承諾的人嚐鮮

🌟 月度支持 NT$249/月 訂閱
   - 無限翻譯
   - VIP 通話通道（TURN 連線）
   - 「想再遇」優先配對
   - 進階篩選（性別、語言、國家）
   - ⭐ VIP 徽章顯示
   - 字幕本機記憶 90 天
   - 陪伴升級：與會員聊天時，對方也享受無限翻譯
```

### 為什麼是 NT$249

**用戶說的**（也就是你，創辦人）：
> 「如果一個月 249 讓我有機會認識不同日本人！我覺得很值得！」

這是最好的價格驗證 —— **創辦人自己會付**。

**為什麼不是 NT$80 或 NT$149**：
- NT$80：太便宜，**用戶不會珍惜**，你也養不活自己
- NT$149：太尷尬，介於「衝動」跟「理性」之間
- **NT$249**：剛好「**要想 5 秒但會付**」的甜蜜點

**為什麼不是 NT$349 或更高**：
- 同類訂閱 App 區間就在 NT$199-299
- 太高 = 退訂率上升
- 留 buffer 給之後 promotion

### 對應的國際定價（之後做）

| 國家 | 月費 | 為什麼 |
|---|---|---|
| 台灣 | NT$249 | base |
| 日本 | ¥1,000 | 文化上 ¥1,000 是「一杯咖啡 + 一塊蛋糕」 |
| 韓國 | ₩9,900 | 對標 Tinder Plus 韓區價 |
| 美國 | US$8 | 對標 Spotify 個人版 |
| 歐洲 | €7 | 同上 |
| 中國 | ¥35 (~NT$149) | 購買力調整 |
| 東南亞 | ~NT$99 | 購買力調整 |
| 印度 | ₹199 (~NT$79) | 購買力調整 |

→ Apple IAP / Stripe 都支援按國家定價。
→ Phase 5 才做。

---

## 🚪 免費 vs 付費的分界

### 核心原則

**翻譯是 kaitalk 的核心存在意義 → 翻譯就是付費 gateway**

不是 TURN（只有 20% 用戶會 hit）
不是「想再遇」（只有黏性用戶才會 hit）
是 **翻譯**（**100% 跨語言用戶**都會 hit）

### 三層 freemium

```
🆓 免費版
─────────
✅ 配對 + 通話 + 字幕原文
✅ 跨語言翻譯：每通 30 句
   （第 31 句起顯示「💎 升級看翻譯」）
✅ 字幕記憶 in-memory（掛斷清空）
✅ 每天 3 通 cap, 每通 60 分鐘 cap


🎁 NT$49 體驗包 (一次性)
─────────────────────
1 次完整翻譯通話（無 30 句限制）
永不過期，慢慢用
給害怕承諾的人嘗試


🌟 NT$249/月 月度會員
─────────────────────
✅ **無限翻譯**（核心賣點）
✅ VIP 通話通道（TURN，連線最穩）
✅ 「想再遇」優先配對
✅ 進階篩選（性別、語言、國家）
✅ ⭐ VIP 徽章顯示
✅ 字幕本機記憶 90 天
✅ 跟付費會員聊天：對方也享受無限翻譯（陪伴升級）

每天 3 通 / 每通 60 分鐘 cap 一樣保留
```

---

## 🎨 「30 句翻譯 cap」設計細節

### 為什麼是 30 句

**30 句 ≈ 5-8 分鐘對話**：
- 太少（10 句）= 用戶覺得被坑
- 太多（100 句）= 用戶覺得不需要付費
- **30 句**：剛好讓「**進入聊天爽點**就被卡」

**心理學**：
- 第 31 句是「**情緒高峰**」
- 用戶在這個時刻付費的轉換率最高
- 對比「一開始就付費」：轉換率差 5-10 倍

### 卡住之後的體驗

**重要**：卡住 ≠ 斷線。**通話繼續，只是降級**。

```
免費用戶第 31 句之後：
   ✅ 字幕原文還在（聽得到對方）
   ❌ 翻譯不顯示
   💎 顯示「升級看翻譯」CTA
   ⏰ 通話本身可以繼續到 60 分鐘 cap
```

**對比錯誤設計**：
- ❌ 第 31 句直接斷線 → 用戶覺得被勒索
- ❌ 第 31 句翻譯亂碼 → 用戶以為 App 壞
- ✅ 第 31 句顯示「💎 升級」→ 用戶有選擇

### 對方的體驗

**Risk**：A 是免費、B 是免費，A 講第 31 句被卡 → B 也卡 → 兩人都沒翻譯

**解法**：
- 單方卡住 = 雙方都看不到翻譯（公平）
- 但**字幕原文還在**
- 兩邊都看到 toast：「對方達到免費翻譯上限，升級看完整對話」
- → **B 會想：「我想看，我來付」** = viral

### 「陪伴升級」邏輯（最重要的設計）

**A 是付費會員，B 是免費**：
- A 看到 B 的話 → **無限翻譯**（A 是 VIP）
- B 看到 A 的話 → **也是無限翻譯**！

為什麼這樣設計：
- A 付的錢 = **一張兩個人的票**
- A 變成 kaitalk 的**主動推銷員**：「跟我聊就無限翻譯！」
- B 體驗到「無限翻譯」的爽感
- → B 會想升級
- → **viral loop**

對標：Spotify Family Plan 的設計邏輯（一個人付，全家爽）

---

## 🛡️ 防濫用機制

### 1. **每日 3 通 cap**
- 不論免費還付費
- 防止「24 小時掛網」
- 對話需要情緒投入，3 通就是極限

### 2. **每通 60 分鐘 cap**
- 不論免費還付費
- 達 60 分鐘自動結束通話
- 防止「掛網不結束」爆 TURN 流量

### 3. **5 分鐘保護機制**
- 通話 < 5 分鐘 = **不扣** VIP 通話次數
- 防止「配對失敗 / 對方秒掛 / 配到怪人」算到用戶頭上

### 4. **裝置指紋防匿名濫用**
- cap 綁 IP + browser fingerprint
- 不只 user.id
- 防止「開新分頁繞過 cap」
- Phase 4 才實作

### 5. **訂閱不能用體驗包繞**
- 體驗包只給「**從未訂閱過的用戶**」
- 不能買 10 個體驗包當訂閱用

---

## 🎯 預估收入

### 假設 8% 付費轉換率

> 為什麼 8%：字幕 cap 是「核心痛點」，比一般 freemium 高。
> 對標：Spotify 約 40% 付費（但他們是純訂閱）；Patreon 約 5%（純贊助）。
> 8% 是中位數，介於兩者之間。

| 日活 | 付費人 | 月收入 (NT$) | 月成本 | **月利潤** | 美金 |
|---|---|---|---|---|---|
| 100 | 8 | 1,992 | 165 | **+1,827** | $57 |
| 500 | 40 | 9,960 | 375 | **+9,585** | $300 |
| 1,000 | 80 | 19,920 | 450 | **+19,470** | $608 |
| 2,000 | 160 | 39,840 | 1,350 | **+38,490** | $1,203 |
| 5,000 | 400 | 99,600 | 4,710 | **+94,890** | $2,965 |
| 10,000 | 800 | 199,200 | 11,070 | **+188,130** | $5,879 |
| 30,000 | 2,400 | 597,600 | 33,000 | **+564,600** | $17,644 |
| 50,000 | 4,000 | 996,000 | 62,640 | **+933,360** | $29,167 |

### 里程碑解讀

| 階段 | 意義 |
|---|---|
| 1,000 DAU | **NT$19,470/月**：兼職薪水，可以辭職全職做 |
| 5,000 DAU | **NT$94,890/月**：一個全職開發者薪水 |
| 10,000 DAU | **NT$188,000/月**：可以雇 1 個人 |
| 50,000 DAU | **NT$933,000/月**：小團隊，正式公司 |

---

## 📐 技術需要的東西（Phase 4 才做）

### Schema 變更

```sql
-- 005_add_subscription.sql

ALTER TABLE users ADD COLUMN is_supporter BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN subscription_tier TEXT;       -- 'monthly' | 'experience'
ALTER TABLE users ADD COLUMN subscription_until TIMESTAMP;
ALTER TABLE users ADD COLUMN total_supported_twd INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN experience_credits_remaining INTEGER DEFAULT 0;

-- 訂閱事件 log（從 Stripe / IAP webhook 寫進來）
CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,           -- 'started' | 'renewed' | 'cancelled' | 'refunded'
  tier TEXT NOT NULL,             -- 'monthly' | 'experience'
  amount_twd INTEGER,
  provider TEXT,                  -- 'stripe' | 'apple_iap' | 'google_iap'
  provider_id TEXT,               -- Stripe sub_xxx / Apple txn_xxx
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sub_events_user ON subscription_events(user_id, occurred_at);
```

### Server 端

- `/api/checkout/create-session` — 建 Stripe checkout session
- `/api/iap/verify` — 驗 Apple/Google IAP receipt
- `/api/webhook/stripe` — Stripe 訂閱事件 webhook
- 配對時讀 `users.is_supporter` 決定要不要：
  - 給 TURN credentials
  - 標 VIP 徽章
  - 跳過 30 句翻譯 cap

### Client 端

- 字幕計數器（in-memory）
- 第 31 句顯示 paywall toast
- 「升級」按鈕 → checkout flow
- 訂閱狀態持久化（localStorage）
- 配對時 server 確認 subscription state（不能只信 client）

---

## 🛣️ Phase 4 上線順序

```
Phase 4.1: 加 schema 欄位 (5 分鐘 migration)
Phase 4.2: 加付款 endpoint (Stripe / IAP)
Phase 4.3: client 端 paywall UI
Phase 4.4: 字幕 30 句計數器
Phase 4.5: VIP 徽章 + 「想再遇」優先配對
Phase 4.6: TURN gating（only VIP）
Phase 4.7: 上線 + 內測 1 週
Phase 4.8: 收第一個付費用戶 🎉
```

---

## 🚫 不要做的事

### 1. 不要用「免費試用」
- 免費試用 = 用戶記得取消
- 我們的免費版**就是永久免費**
- 「**升級**」是主動行為，不是「**避免被收費**」

### 2. 不要做「年費 2 個月免費」促銷
- 年費 = 用戶承諾大 = 退訂時痛
- 月費自由 = 信任感高
- 之後再考慮年費（Phase 5+）

### 3. 不要做「廣告免費版」
- 廣告破壞語音的親密感
- 廣告吸引短期低品質流量
- 訂閱模型勝過廣告模型

### 4. 不要做「贈送朋友月費」
- 太複雜
- 容易被濫用
- 「陪伴升級」邏輯已經有 viral 效應，不需要

### 5. 不要做「永久會員一次付」
- 一次性大金額難以維繫產品
- 訂閱才能養活開發

---

## ⏰ 上線時機

**現在（2026-04-10）絕對不上線**，因為：

1. ❌ 沒 OAuth → 匿名 user 無法對應訂閱
2. ❌ 沒 Stripe / IAP 整合
3. ❌ 沒 iOS App
4. ❌ 沒 retention 數據（不知道值得付的時長）
5. ❌ 沒**真實的痛點**（30 句 cap 還沒人 hit 過）
6. ❌ 用戶數 = 0，付費 = 0/0 = 沒意義

### 上線前置條件

✅ Phase 2C 完成：「想再遇」運作
✅ Phase 3 完成：Google + Apple OAuth 升級
✅ Phase 4.1-4.6 全部完成
✅ 至少 100 個真實活躍用戶
✅ D7 retention > 20%
✅ 至少 5 個用戶**主動詢問**「怎麼付費支持」

第 6 點最重要 —— **如果沒人主動問怎麼付，現在做付費系統也是白做**。

---

## 💎 最後一個 insight

### 為什麼「字幕 cap」勝過「TURN cap」

我之前推 TURN 是錯的。原因是：

| 維度 | TURN cap | **字幕 cap** |
|---|---|---|
| 觸發比例 | 20% 用戶 | **100% 跨語言用戶** |
| 痛點時機 | 配對失敗（負面） | **聊天高峰**（正面） |
| 用戶反應 | 「這 App 爛」 | **「我要繼續聊」** |
| 工程複雜度 | 高（credentials, server） | **低（前端 counter）** |
| 跟產品定位 | 弱關係 | **完美吻合** |
| 轉換率 | 1-3% | **5-15%** |

**結論**：TURN 仍然要做，但**不是付費 gateway**，是**附帶福利**。

```
付費 gateway：字幕無限翻譯 ⭐
付費 bonus：TURN 連線、想再遇優先、徽章、篩選
```

---

## 🔗 相關文件

- [PRODUCT_VISION.md](./PRODUCT_VISION.md) — 為什麼做 kaitalk
- [ROADMAP.md](./ROADMAP.md) — Phase 0-5 執行計劃
- [../README.md](../README.md) — 技術架構

---

## ✍️ 創辦人筆記

**2026-04-10 晚上的演化**：

1. 「TURN 太貴 → 當付費」（最初）
2. 「VIP 通道」（精緻化）
3. 「贊助 = VIP」（情感框架）
4. 「次數包」（拒絕吃到飽）
5. 「**月費 NT$249 我會付**」（發現自己是用戶）
6. 「**字幕 cap 一天 30 句**」（找到真正的 freemium gateway）
7. 「**翻譯本來就是核心，何必開發這個 app**」（最終 framing）

從技術問題（TURN）走到產品 thesis（**翻譯就是 kaitalk**），這個演化是 6 個月的事，今天一晚做完。

把它記住。然後睡覺。
