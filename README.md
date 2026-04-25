# GuideTalk · 導遊團車對講 + 位置同步

> **多車隊行程不走散**：即時對講機 + 即時位置共享。
> 為日本/海外導遊團車場景而生。

---

## 為什麼有這個 App

導遊帶團、多台車並行時，常碰到：
- 在前車的人不知道後車哪裡了，是要等？要繞回去？
- 用 LINE 問位置太慢，開車不方便看訊息
- 一般 LINE 群通話沒有「即時位置」這層

**GuideTalk 解法：**
1. 開團 → 拿到 6 碼房號 / 邀請連結
2. 同團導遊全部加入 → 地圖即時看到每台車在哪
3. 想講話按住 PTT 按鈕 → 全房聽得到（像對講機）
4. 點任一夥伴 → 「在地圖開啟」直接導航過去

---

## 架構

```
┌──────────────────────────────────────────┐
│ Socket.IO server（你的 Zeabur）          │
│  • 房間（建立 / 加入 / 12 小時 TTL）       │
│  • WebRTC 訊令轉發（offer/answer/ICE）    │
│  • GPS pub/sub（in-memory，不寫 DB）      │
└──────────────────────────────────────────┘
        ↑ 訊令          ↑ GPS
        │               │
   ┌────┴───────────────┴────┐
   │ 每支手機                │
   │  • WebRTC P2P mesh 音訊 │  ← 媒體永遠 P2P 直連
   │  • Leaflet + OSM 地圖   │
   │  • iOS: Capacitor 原生  │
   │     ├ CoreLocation 背景 │
   │     └ 麥克風背景音訊    │
   └─────────────────────────┘
```

| 資料 | 走哪 | 為什麼 |
|---|---|---|
| 通話音訊 | WebRTC P2P，**完全不經 server** | 隱私、零伺服器流量 |
| 位置 GPS | Socket.IO 經 server 廣播 | 即時、新加入者立刻看到全部、收訊不穩也不會掉 |
| 位置儲存 | **server in-memory，房結束即消失** | 無 DB、無 log |

## 通話架構選擇

純語音 + PTT 場景下，4-8 人的 **WebRTC Mesh** 就夠了：
- 8 人 mesh，每人下載 7 路 Opus = 224 kbps（一張 IG 圖的流量）
- 純音訊不像視訊會發燙
- 不需要 SFU，**伺服器零媒體成本**

10+ 人或加視訊再考慮升級到 LiveKit / mediasoup。

---

## 開發 / 本機跑

```bash
npm install
npm start
# → http://localhost:9001
```

開兩個分頁，第一個建房，第二個輸入房號加入。允許麥克風 + 定位權限即可開始測。

---

## 平台支援

| 平台 | 通話 | 位置 | 鎖屏/背景持續定位 |
|---|---|---|---|
| iPhone（Capacitor App） | ✅ | ✅ Capacitor Geolocation | ✅（Info.plist 已設定）|
| Android Chrome / PWA | ✅ | ✅ Web Geolocation | ❌ 切後台會停 |
| 桌面 Chrome / Safari | ✅ | ✅ | N/A |

> Android 要支援背景定位需另外做 Capacitor Android 建構（目前專案只有 iOS）。

---

## iOS 上架重點

`ios/App/App/Info.plist` 已預設：
- `NSMicrophoneUsageDescription` —— 對講通話
- `NSLocationWhenInUseUsageDescription` —— 前景定位
- `NSLocationAlwaysAndWhenInUseUsageDescription` —— 背景定位（鎖屏行車）
- `UIBackgroundModes`：`audio`、`location`、`voip`

App Store 審查說明範本：

> 本 App 為導遊帶團、多車隊行車場景設計。使用者在團體房間中與同團夥伴分享即時位置，避免行車途中分車走散。位置只在房間連線期間即時轉發給同房夥伴，不上傳資料庫、不存儲於裝置外，房間結束即停止。

---

## 部署到 Zeabur

```bash
# 已預設網域 guidetalk.zeabur.app
# 1. push 到 youweulin/guidetalk
# 2. Zeabur Dashboard → New Service → GitHub → guidetalk
# 3. Build: 自動偵測 Node
# 4. PORT 由 Zeabur 注入
```

---

## 接下來可以做

- [ ] Android Capacitor build（背景定位）
- [ ] 對講機快捷貼圖（「等紅燈」「我先到了」）
- [ ] 軌跡記錄（行程結束自動產生 GPX）
- [ ] 地圖加路線規劃（OSRM）
- [ ] LiveKit 整合（>10 人團）

---

## License

私有專案 · © 2026 youweulin
