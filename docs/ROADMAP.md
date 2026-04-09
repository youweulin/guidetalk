# kaitalk Roadmap

哪些事情已經做了、哪些刻意先不做、哪些之後再做。

---

## ✅ 已完成（Phase 0 + Phase 1）

- 兩人配對（Socket.IO 訊令 + in-memory 佇列）
- WebRTC P2P 音訊（Opus）
- 雙向音量視覺化 meter
- 喇叭靜音開關（單機測試用）
- Web Speech API STT 即時字幕
- 每用戶自選 STT 語言（zh-TW / ja-JP / en-US / ko-KR / zh-CN）
- 跨語言自動翻譯（Google 免費 endpoint，fallback MyMemory）
- 翻譯結果持久化到 localStorage（30 天 TTL）
- 字幕開關
- iPhone (4G) ↔ Mac (wifi) 跨網路 + 跨語言對話實測成功

---

## 🚫 刻意暫時不做

### TURN 中繼伺服器
**為什麼不做**：燒錢、增加複雜度、Phase 0 不需要。

**什麼時候需要做**：
- 上線後發現有用戶在 4G/CGNAT/企業網路後面連不上
- 數據顯示「配對成功但通話 0 秒」的失敗率超過 10%
- 用戶開始抱怨「對方聽不到我」

**做的方式**（不要急，先看真實數據再決定）：
| 階段 | 方案 | 成本 |
|---|---|---|
| 早期測試 | OpenRelay 公共免費（`openrelayproject` credentials） | $0，但不穩 |
| 正式上線 | **Cloudflare Realtime TURN** | $0（前 1000 GB / 月），9000 日活內免費 |
| 量爆掉時 | 自架 coturn on VPS | $5-20/月 |

**架構**：[main.js 的 ICE_SERVERS](public/main.js) 是一個 array，加 TURN 就是 push 一個物件，零重構。
未來加 TURN 時：
1. 用戶註冊 Cloudflare 拿 API token
2. server.js 加一個 endpoint：`POST /turn-credentials` → 回傳臨時 username/credential（用 token 跟 Cloudflare API 換）
3. main.js 在配對時呼叫一次拿到 credentials，傳給 RTCPeerConnection
4. 完成

**為什麼不要自動加 OpenRelay**：之前實測 OpenRelay 公共服務時好時壞，反而會讓 debug 變難——「ICE 連得上但音訊不通」的問題就是 OpenRelay 失敗時的症狀。等真的需要時直接上 Cloudflare 才對。

---

### 自訂 STUN/TURN 伺服器
**為什麼不做**：Google 公共 STUN 已經夠了，沒理由自己跑。

**什麼時候需要做**：永遠不需要，除非要做亞洲區延遲優化（很後期）。

---

### Service Worker / PWA 離線快取
**為什麼暫時不做**：需要的東西不多，先把核心對話跑順比較重要。

**什麼時候做**：要上 Add to Home Screen 體驗時。
- iOS: PWA 受限，主力還是要走 Capacitor App
- Android: Chrome PWA 有完整體驗，加 manifest + sw 即可

---

### Echo cross-talk 過濾
**為什麼暫時不做**：之前加了發現會誤殺正常字幕。`echoCancellation: true` 已經在 getUserMedia 設好，現代瀏覽器處理八成 OK。

**什麼時候做**：
- 用戶實測抱怨「字幕重複跑」或「對方講話被當成自己講」
- 改用 VAD（語音活動檢測）而不是純音量比較

---

## 🎯 下一個要做（按優先序）

### Phase 1.5（UI / 體驗優化）
- [ ] 把語言按鈕從字幕滑動區拉出來，固定在上方 ⭐ **就要做了**
- [ ] 字幕開關按鈕也跟語言按鈕放一起
- [ ] 配對成功後在卡片顯示自己的暱稱（不只顯示對方）
- [ ] 雙音量 meter 改成同一行（節省垂直空間）
- [ ] 合併「狀態列」跟「配對卡片」（重複顯示對方名字）
- [ ] STT 結果 debounce 0.5 秒避免「は → 牙齒」這種片段翻譯

### Phase 2（差異化武器）
- [ ] **iOS Capacitor App** + Apple Translation plugin → 上 App Store
  - iOS 上能用的最佳翻譯，0 成本、本地、隱私
- [ ] 試聊 10 秒倒數機制
- [ ] 豆知識題目庫（中日雙語，配對成功推一張當話題）

### Phase 3（變現）
- [ ] Google 登入（Supabase Auth）
- [ ] 性別篩選
- [ ] 「想再遇」付費標記（只存 metadata 在 server）
- [ ] 檢舉/封鎖機制

### Phase 4（規模化）
- [ ] 部署到永久 URL（取代 cloudflared，可能 Zeabur）
- [ ] 加 TURN（看上方刻意暫時不做的條件）
- [ ] 翻譯改用 Apple Translation（iOS）+ Chrome Built-in（PWA）
- [ ] 合作遊戲（找不同、問 AI 真假題、塗鴉接龍）

---

## 🧭 開發原則（給未來的我）

1. **一次只改一件事**——就算看起來「可以順便」，也忍住
2. **每改完都實測**——尤其是用戶能看見的部分
3. **不要相信「無害」的添加**——TURN 那次教訓
4. **不要為了 1% 的情境寫複雜代碼**——例如 echo filter
5. **server 只做最薄的事**——不解析媒體、不存對話、不做業務邏輯
6. **client 是整個體驗的家**——翻譯、字幕、快取都在用戶手機，不在 server
7. **隱私是承諾不是話術**——對話文字 in-memory only，掛斷即清空
8. **想賺錢前先想用戶要什麼**——TURN/STUN/server 都是錢，能省則省
