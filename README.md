# kaitalk · 聊活

> **兩人隨機語音盲盒**——配對、講話、跨語言即時字幕。
> 純 P2P 架構，伺服器只做訊令轉發，媒體永遠不經過 server。

---

## 產品定位

不是交友軟體，是「**有人陪**」的服務。
- 隨機配對兩個人 → WebRTC P2P 語音直連
- 即時字幕（每人標自己的語言）
- 跨語言自動翻譯（中 ↔ 日 ↔ 英 ↔ 韓）
- 想再聊就繼續，不想就結束 → 抽下一個

主力市場：**台灣 ↔ 日本**——語音比文字親密、比視訊安全，加上字幕翻譯打通語言牆。

---

## Phase 0 + 1（已完成）

- [x] Socket.IO 訊令 server + 兩人配對佇列
- [x] WebRTC P2P 音訊（Opus）
- [x] 雙向音量視覺化 meter
- [x] 喇叭靜音切換（給單機測試）
- [x] 即時 STT 字幕（Web Speech API）
- [x] 每人標自己的語言（zh-TW / ja-JP / en-US / ko-KR / zh-CN）
- [x] 跨語言翻譯（自動偵測對方語言 → 翻成我的語言）
- [x] 翻譯 provider 多層 fallback（Apple → Chrome built-in → Google → MyMemory）
- [x] 字幕開關按鈕

## Phase 2（接下來）

- [ ] PWA manifest + Service Worker
- [ ] 部署到永久 URL（Zeabur）
- [ ] iOS Capacitor wrap + AppleTranslation plugin
- [ ] Google 登入（Supabase Auth）
- [ ] 性別篩選
- [ ] 試聊 10 秒倒數 + 豆知識題目庫

---

## 技術架構

```
┌─────────┐                      ┌─────────┐
│  Alice  │                      │   Bob   │
│ (手機)  │                      │ (手機)  │
└────┬────┘                      └────┬────┘
     │                                │
     │   1. WebSocket → 唯一一台      │
     │      訊令 server (server.js)   │
     ▼                                ▼
   ┌──────────────────────────────────┐
   │  signaling: matchmaking + relay  │
   │  ⚠️ 完全不碰 audio / 字幕內容    │
   └──────────────────────────────────┘
     │                                │
     │   2. 透過 Google STUN 查公網 IP │
     │   3. WebRTC P2P 直連            │
     ▼                                ▼
   ┌──────────────────────────────────┐
   │  ⚡ 音訊 / 字幕 DataChannel       │
   │  ⚡ 完全不經過任何 server         │
   │  ⚡ 字幕翻譯在用戶手機跑          │
   └──────────────────────────────────┘
```

### 隱私架構

| 資料 | 存哪裡 | 為什麼 |
|---|---|---|
| 音訊 | 不存任何地方 | P2P 即時、不錄音 |
| 字幕文字（通話中） | 雙方手機 in-memory | 翻譯需要 context |
| 字幕翻譯 | 用戶手機快取 | 同一句不翻第二次 |
| 配對 metadata | server | 只記「誰跟誰配過」，不含對話內容 |

---

## 翻譯 Provider 順序

```js
PROVIDERS = [
  AppleTranslationProvider,    // ← iOS Capacitor App，最佳
  ChromeBuiltinTranslator,      // ← Chrome 138+ 桌面/Android，免費本地
  GoogleFreeTranslator,         // ← 任何瀏覽器，預設
  MyMemoryTranslator,           // ← 終極 fallback
]
```

第一個 `isAvailable()` 回 true 的就用，每次失敗就 fallback 到下一個。
新加 provider 只要 push 進陣列，**其他程式碼不用改**。

---

## 在本地跑

```bash
npm install
npm start
# → http://localhost:9001
```

開**兩個瀏覽器分頁**訪問同一個 URL，各按「開始配對」。

### 同電腦測試訣竅
1. 兩個分頁都按「🔇 喇叭靜音」（避免 echo）
2. 對著一邊講話
3. 另一邊的「對方聲音」音量條會跳 = 配對成功

### 跨裝置測試
用 [cloudflared](https://github.com/cloudflare/cloudflared) 開隧道：
```bash
cloudflared tunnel --url http://localhost:9001
```
拿到的 https URL 任何手機/電腦都能開。

### 端到端訊令測試（純 Node，不用瀏覽器）
```bash
node test-e2e.mjs
```
模擬兩個假客戶端做完整 WebRTC 訊令交換 + 配對流程。

---

## 平台策略

| 平台 | 部署方式 | 翻譯 |
|---|---|---|
| iPhone / iPad | Capacitor App（App Store） | Apple Translation |
| Android Chrome | PWA（add to home screen） | Chrome Built-in |
| Mac/Win Chrome | PWA | Chrome Built-in |
| Mac Safari / iOS Safari / Firefox | PWA fallback | Google 免費 endpoint |

**一份 web 程式碼** → Capacitor wrap iOS / 直接 PWA → 自動偵測環境用最佳翻譯。

---

## 檔案結構

```
kaitalk/
├── server.js                # 訊令 server（Socket.IO + 配對佇列）
├── package.json             # 只有 2 個依賴：express + socket.io
├── public/
│   ├── index.html           # 單頁 UI
│   └── main.js              # WebRTC + STT + 翻譯 + 字幕邏輯
├── test-e2e.mjs             # 端到端訊令測試
└── README.md
```

---

## License

私有專案 · © 2026 youweulin
