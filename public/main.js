/**
 * kaitalk 客戶端 — Phase 0 + 音量視覺化
 *
 * 流程：
 *   1. 連 Socket.IO 訊令 server
 *   2. 點「開始配對」→ 取得麥克風 + 進佇列 + 開始本地 mic 音量分析
 *   3. server 配對成功 → 顯示對方暱稱 + 房號
 *   4. host 建 RTCPeerConnection、加 audio track、createOffer → 透過 server 轉發
 *   5. guest 收 offer → setRemoteDescription → createAnswer → 轉發回去
 *   6. ICE candidates 雙向轉發
 *   7. P2P 連通後：對方的 audio track 接到 <audio> 播放 + Web Audio Analyser 顯示音量
 *
 * 同一台電腦測試訣竅：
 *   - 兩個分頁都按「靜音喇叭」
 *   - 對著一個分頁講話，另一個分頁的「對方聲音」meter 會跳動
 *   - 證明 P2P 真的連通且音訊有在流，但耳朵不會 echo
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ─── DOM ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');
const btnStart = $('btn-start');
const btnCancel = $('btn-cancel');
const btnHangup = $('btn-hangup');
const btnMute = $('btn-mute');
const btnSubtitle = $('btn-subtitle');
const nameInput = $('name');
const remoteAudio = $('remote-audio');

const peerCard = $('peer-card');
const peerNameEl = $('peer-name');
const roomCodeEl = $('room-code');
const myRoleEl = $('my-role');

const metersEl = $('meters');
const localMeter = $('local-meter');
const remoteMeter = $('remote-meter');
const localLevelEl = $('local-level');
const remoteLevelEl = $('remote-level');

const subtitlesEl = $('subtitles');
const subtitlesListEl = $('subtitles-list');
const langBtn = $('lang-btn');
const sttStatusEl = $('stt-status');

// ─── State ───────────────────────────────────────────
let socket = null;
let pc = null;
let localStream = null;
let peerId = null;
let peerName = null;
let isHost = false;
let pendingCandidates = [];

// Web Audio analyser state
let audioCtx = null;
let localAnalyser = null;
let remoteAnalyser = null;
let meterRafId = null;

// Subtitle / STT state
let subtitleDC = null;          // RTCDataChannel for subtitle messages
let recognition = null;         // SpeechRecognition instance
let sttActive = false;          // 是否正在跑 STT
let sttLang = detectInitialLang(); // 我講的語言（影響 STT + 對方知道我在講什麼）
let peerLang = null;            // 對方講的語言（從對方第一筆字幕學到）
let subtitlesEnabled = localStorage.getItem('kaitalk.subtitles') !== 'false'; // 用戶開關，預設開
const subtitleBuffer = [];      // event log: [{ id, speaker, text, lang, interim, ts }]
const MAX_BUFFER = 50;          // in-memory buffer 上限

// 支援的語言（之後加翻譯時，只要每個都能對應到翻譯 API 的 code 即可）
const LANGS = [
  { code: 'zh-TW', flag: '🇹🇼', label: '中文' },
  { code: 'ja-JP', flag: '🇯🇵', label: '日本語' },
  { code: 'en-US', flag: '🇺🇸', label: 'English' },
  { code: 'ko-KR', flag: '🇰🇷', label: '한국어' },
  { code: 'zh-CN', flag: '🇨🇳', label: '简中' },
];

function detectInitialLang() {
  // 1. localStorage 記住用戶上次的選擇
  const saved = localStorage.getItem('kaitalk.lang');
  if (saved) return saved;
  // 2. 從瀏覽器語言推測
  const nav = (navigator.language || 'zh-TW');
  if (nav.startsWith('zh-TW') || nav === 'zh-Hant') return 'zh-TW';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ja')) return 'ja-JP';
  if (nav.startsWith('ko')) return 'ko-KR';
  if (nav.startsWith('en')) return 'en-US';
  return 'zh-TW';
}

function langInfo(code) {
  return LANGS.find(l => l.code === code) || { code, flag: '🌐', label: code };
}

// ─── Translation Provider (Phase 2) ──────────────────
//
// 介面：translate(text, fromLang, toLang) → Promise<string>
//
// 多 provider 策略，依序嘗試：
//   1. Apple Translation     ← iOS 原生 App（透過 Capacitor plugin），最佳選擇
//   2. Chrome Built-in       ← Chrome 138+ 桌面/Android，裝置上 AI 模型，免費
//   3. Google Free endpoint  ← 任何瀏覽器，免費但 unofficial
//   4. MyMemory              ← 終極 fallback
//
// 新加 provider 就 push 進 PROVIDERS 即可，不用改其他地方。

class TranslationProvider {
  get name() { return this.constructor.name; }
  async isAvailable(from, to) { return false; }
  async translate(text, fromLang, toLang) { return text; }
}

// ─── Provider 1: Apple Translation（iOS 原生 App 才能用）───
//
// 需要的條件：
//   - kaitalk 必須打包成 Capacitor iOS App（不能只開 Safari 網頁）
//   - iOS 17.4+ 才有 Translation framework
//   - iOS 18+ 才有完整的 TranslationSession（裝置上 AI）
//   - 需要寫一個 Capacitor plugin 把原生 API 橋接到 JS
//
// Plugin 的 Swift code 大致長這樣（之後在 ios/App/App/Plugins/ 加）：
//
//   import Capacitor
//   import Translation
//
//   @objc(AppleTranslationPlugin)
//   public class AppleTranslationPlugin: CAPPlugin {
//     @objc func translate(_ call: CAPPluginCall) {
//       let text = call.getString("text") ?? ""
//       let from = call.getString("from") ?? "zh"
//       let to = call.getString("to") ?? "ja"
//       Task {
//         let session = TranslationSession(
//           configuration: .init(source: Locale.Language(identifier: from),
//                                target: Locale.Language(identifier: to)))
//         let response = try await session.translate(text)
//         call.resolve(["translated": response.targetText])
//       }
//     }
//   }
//
// JS 端就會有 window.Capacitor.Plugins.AppleTranslation.translate({...})
class AppleTranslationProvider extends TranslationProvider {
  static isInstalled() {
    return !!(window.Capacitor?.Plugins?.AppleTranslation);
  }
  async isAvailable(from, to) {
    return AppleTranslationProvider.isInstalled();
  }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const result = await window.Capacitor.Plugins.AppleTranslation.translate({
      text, from, to,
    });
    return result.translated;
  }
}

// ─── Provider 2: Chrome Built-in Translator API（NOW 可用）───
//
// Chrome 138+ 提供 window.Translator，裝置上跑 AI 模型：
//   - 完全免費、零延遲（不用網路）
//   - 隱私 100%（文字不離開瀏覽器）
//   - 第一次用某語言對會下載約 22MB 模型
//   - 支援 zh, ja, en, ko, fr, de, es, ... 等主要語言
//
// 你現在 Chrome 桌面版測試的話，這個會自動被選用！
class ChromeBuiltinTranslator extends TranslationProvider {
  constructor() {
    super();
    this.instances = new Map(); // 'from|to' → Translator instance
  }
  static isInstalled() {
    return typeof self !== 'undefined' && 'Translator' in self;
  }
  async isAvailable(fromLang, toLang) {
    if (!ChromeBuiltinTranslator.isInstalled()) return false;
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return true;
    try {
      const availability = await Translator.availability({
        sourceLanguage: from,
        targetLanguage: to,
      });
      return availability !== 'unavailable';
    } catch {
      return false;
    }
  }
  async getInstance(from, to) {
    const key = `${from}|${to}`;
    if (this.instances.has(key)) return this.instances.get(key);
    const inst = await Translator.create({
      sourceLanguage: from,
      targetLanguage: to,
    });
    this.instances.set(key, inst);
    return inst;
  }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const instance = await this.getInstance(from, to);
    return await instance.translate(text);
  }
}

// ─── Provider 3: Google 免費 endpoint ───
class GoogleFreeTranslator extends TranslationProvider {
  async isAvailable() { return true; }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data[0].map(seg => seg[0]).join('');
  }
}

// ─── Provider 4: MyMemory（fallback）───
class MyMemoryTranslator extends TranslationProvider {
  async isAvailable() { return true; }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.responseData?.translatedText || text;
  }
}

// 順序就是優先順序：第一個能用的就用
const PROVIDERS = [
  new AppleTranslationProvider(),
  new ChromeBuiltinTranslator(),
  new GoogleFreeTranslator(),
  new MyMemoryTranslator(),
];

// ─── Persistent Translation Cache ────────────────────
//
// 為什麼要持久化：
//   - Google/MyMemory 都有 IP 每日上限
//   - 如果快取只活在記憶體，每次 refresh / 新對話都從零翻譯
//   - 把快取存到 localStorage → 跨對話/跨天累積
//   - 用戶用越久，自己的「常用語料庫」越完整，API 用量越來越低
//
// 隱私：完全只在用戶手機，server 永遠看不到
const TRANSLATION_CACHE_KEY = 'kaitalk.translationCache.v1';
const TRANSLATION_CACHE_LIMIT = 500;
const TRANSLATION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

function loadTranslationCache() {
  // 注意：這個 function 在 module top-level 就會跑（const translationCache = loadTranslationCache()），
  // 比 log() 還早被叫，所以這裡只能用 console.log，不能用 log()
  try {
    const raw = localStorage.getItem(TRANSLATION_CACHE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    const now = Date.now();
    const map = new Map();
    let expired = 0;
    for (const [key, entry] of Object.entries(obj)) {
      if (entry?.ts && now - entry.ts < TRANSLATION_CACHE_TTL) {
        map.set(key, entry);
      } else {
        expired++;
      }
    }
    console.log(`[kaitalk] 📚 載入翻譯快取 ${map.size} 筆${expired ? `（過期 ${expired} 筆）` : ''}`);
    return map;
  } catch (err) {
    console.warn(`[kaitalk] 快取載入失敗: ${err.message}`);
    return new Map();
  }
}

let saveTimer = null;
function saveTranslationCacheDebounced() {
  // 每 2 秒最多寫一次，避免頻繁 I/O
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = {};
      for (const [k, v] of translationCache) obj[k] = v;
      localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(obj));
    } catch (err) {
      log(`快取存檔失敗: ${err.message}`);
      // 通常是 quota exceeded → 砍一半重試
      try {
        const sorted = [...translationCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < Math.floor(sorted.length / 2); i++) {
          translationCache.delete(sorted[i][0]);
        }
        const obj = {};
        for (const [k, v] of translationCache) obj[k] = v;
        localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(obj));
        log(`已清掉一半舊快取重新存`);
      } catch {}
    }
  }, 2000);
}

function evictOldestIfNeeded() {
  if (translationCache.size <= TRANSLATION_CACHE_LIMIT) return;
  // LRU：按 ts 排序，刪掉最舊的 50 筆（一次刪多筆減少刪除頻率）
  const sorted = [...translationCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toDelete = translationCache.size - TRANSLATION_CACHE_LIMIT + 50;
  for (let i = 0; i < toDelete; i++) {
    translationCache.delete(sorted[i][0]);
  }
}

const translationCache = loadTranslationCache();

let lastWorkingProvider = null; // 紀錄最後一次成功的 provider，下次優先用

async function translateText(text, fromLang, toLang) {
  if (!text || !text.trim()) return null;
  const key = `${fromLang}|${toLang}|${text}`;

  // 查快取
  const cached = translationCache.get(key);
  if (cached) {
    // 更新 ts（LRU 用），但不寫檔（避免每次讀都寫）
    cached.ts = Date.now();
    return cached.value;
  }

  // 把 lastWorkingProvider 排到最前，避免每次都重試前面的 provider
  const ordered = lastWorkingProvider
    ? [lastWorkingProvider, ...PROVIDERS.filter(p => p !== lastWorkingProvider)]
    : PROVIDERS;

  for (const p of ordered) {
    try {
      if (!(await p.isAvailable(fromLang, toLang))) continue;
      const translated = await p.translate(text, fromLang, toLang);
      if (translated && translated !== text) {
        if (lastWorkingProvider !== p) {
          log(`✨ 翻譯使用: ${p.name}`);
          lastWorkingProvider = p;
        }
        translationCache.set(key, { value: translated, ts: Date.now() });
        evictOldestIfNeeded();
        saveTranslationCacheDebounced();
        return translated;
      }
    } catch (err) {
      log(`翻譯失敗 (${p.name}): ${err.message}`);
      continue;
    }
  }
  log(`所有翻譯 provider 都失敗`);
  return null;
}

// 給 UI/Console 用：清掉所有翻譯快取
window.kaitalkClearTranslationCache = function() {
  translationCache.clear();
  localStorage.removeItem(TRANSLATION_CACHE_KEY);
  log(`🗑️ 翻譯快取已清空`);
};

// ─── Helpers ─────────────────────────────────────────
const log = (msg) => {
  const t = new Date().toLocaleTimeString();
  logEl.innerHTML = `[${t}] ${msg}<br>` + logEl.innerHTML;
  console.log(`[kaitalk] ${msg}`);
};

const setStatus = (text, withPulse = false) => {
  statusEl.innerHTML = (withPulse ? '<span class="pulse"></span>' : '') + text;
};

const showButtons = (state) => {
  btnStart.style.display = state === 'idle' ? 'block' : 'none';
  btnCancel.style.display = state === 'matching' ? 'block' : 'none';
  btnHangup.style.display = state === 'in-call' ? 'block' : 'none';
  btnMute.style.display = state === 'in-call' ? 'block' : 'none';
  btnSubtitle.style.display = state === 'in-call' ? 'block' : 'none';
};

const showPeerCard = (name, room, role) => {
  peerNameEl.textContent = name;
  roomCodeEl.textContent = room;
  myRoleEl.textContent = role === 'host' ? 'HOST' : 'GUEST';
  myRoleEl.className = `role ${role}`;
  peerCard.classList.add('active');
};

const hidePeerCard = () => {
  peerCard.classList.remove('active');
};

const showMeters = () => metersEl.classList.add('active');
const hideMeters = () => metersEl.classList.remove('active');

const showSubtitles = () => subtitlesEl.classList.add('active');
const hideSubtitles = () => subtitlesEl.classList.remove('active');

// ─── Web Audio Analyser ──────────────────────────────
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function attachAnalyser(stream) {
  const ctx = ensureAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  // 注意：不接到 ctx.destination，避免本地 mic 變 echo
  return analyser;
}

// 算 RMS level（time domain，比 frequency 準）
function getLevel(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 3); // ×3 讓視覺更靈敏
}

function startMeterLoop() {
  if (meterRafId) return;
  const tick = () => {
    const localLv = getLevel(localAnalyser);
    const remoteLv = getLevel(remoteAnalyser);

    localMeter.style.width = (localLv * 100) + '%';
    remoteMeter.style.width = (remoteLv * 100) + '%';
    localLevelEl.textContent = Math.round(localLv * 100) + '%';
    remoteLevelEl.textContent = Math.round(remoteLv * 100) + '%';

    meterRafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeterLoop() {
  if (meterRafId) {
    cancelAnimationFrame(meterRafId);
    meterRafId = null;
  }
  localMeter.style.width = '0%';
  remoteMeter.style.width = '0%';
  localLevelEl.textContent = '0%';
  remoteLevelEl.textContent = '0%';
}

// ─── Subtitle Buffer ─────────────────────────────────
//
// 設計：
//   - in-memory event log，掛斷瞬間清空
//   - 每筆 { id, speaker: 'self'|'peer', text, interim, ts }
//   - interim（暫時的中間結果）會被同 speaker 的下一個 interim 取代
//   - final 把 interim 升級為定稿
//
// 之後要做：本機 IndexedDB 持久化、「保存對話」按鈕、檢舉時打包證據
function addSubtitle(speaker, text, lang, interim) {
  if (!text || !text.trim()) return;

  // 找到該 speaker 最後一筆 interim
  let lastInterimIdx = -1;
  for (let i = subtitleBuffer.length - 1; i >= 0; i--) {
    if (subtitleBuffer[i].speaker === speaker && subtitleBuffer[i].interim) {
      lastInterimIdx = i;
      break;
    }
  }

  let entry;
  if (lastInterimIdx !== -1) {
    // 取代既有 interim
    entry = subtitleBuffer[lastInterimIdx];
    entry.text = text;
    entry.lang = lang;
    entry.interim = interim;
    entry.ts = Date.now();
    entry.translated = null; // 重新翻譯
  } else {
    // 新增一筆
    entry = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      speaker,
      text,
      lang,
      interim,
      ts: Date.now(),
      translated: null,
    };
    subtitleBuffer.push(entry);
  }

  while (subtitleBuffer.length > MAX_BUFFER) subtitleBuffer.shift();
  renderSubtitles();

  // 翻譯邏輯：
  //   - 只翻譯對方的最終結果（self 不用翻、interim 太花費）
  //   - 對方語言跟我不一樣才翻
  //   - 翻好後更新 entry 並重新 render
  if (
    speaker === 'peer' &&
    !interim &&
    lang &&
    lang.split('-')[0] !== sttLang.split('-')[0]
  ) {
    translateText(text, lang, sttLang).then(translated => {
      if (translated && translated !== text) {
        entry.translated = translated;
        entry.translatedTo = sttLang;
        renderSubtitles();
      }
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderSubtitles() {
  if (subtitleBuffer.length === 0) {
    subtitlesListEl.innerHTML = '<div class="subtitles-empty">開始講話試試看...</div>';
    return;
  }
  subtitlesListEl.innerHTML = subtitleBuffer.map(s => {
    const label = s.speaker === 'self' ? '你' : (peerName || '對方');
    const li = langInfo(s.lang || 'unknown');
    const translationHTML = s.translated
      ? `<div class="translation">↳ ${escapeHtml(s.translated)}</div>`
      : '';
    return `<div class="subtitle-line ${s.speaker} ${s.interim ? 'interim' : ''}">
      <span class="speaker">${li.flag} ${escapeHtml(label)}</span>
      <div class="text-wrap">
        <div class="text">${escapeHtml(s.text)}</div>
        ${translationHTML}
      </div>
    </div>`;
  }).join('');
  // 自動捲到底
  subtitlesListEl.parentElement.scrollTop = subtitlesListEl.parentElement.scrollHeight;
}

function clearSubtitles() {
  subtitleBuffer.length = 0;
  renderSubtitles();
}

// ─── Web Speech API (STT) ────────────────────────────
//
// 兩邊各自的瀏覽器跑 STT 處理「自己」的麥克風，
// 結果透過 DataChannel 傳給對方顯示。
//
// 跟翻譯解耦：未來加翻譯只是在 onresult 多套一層 translateFn 再 send。
function isSTTSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function setSTTStatus(state, label) {
  if (!sttStatusEl) return;
  sttStatusEl.className = `stt-status ${state}`;
  sttStatusEl.innerHTML = `<span class="dot"></span>${label}`;
}

function startSTT() {
  if (!isSTTSupported()) {
    log('⚠️ 瀏覽器不支援 Web Speech API');
    setSTTStatus('error', '不支援');
    subtitlesListEl.innerHTML = '<div class="subtitles-empty">此瀏覽器不支援即時字幕<br>請改用 Chrome / Edge / Safari</div>';
    return;
  }
  if (sttActive) {
    log('STT 已經在跑了，跳過');
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = sttLang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    log(`✅ STT onstart 觸發 (${sttLang})`);
    setSTTStatus('active', '辨識中');
    if (subtitleBuffer.length === 0) {
      subtitlesListEl.innerHTML = '<div class="subtitles-empty">講話試試看...（已在辨識）</div>';
    }
  };

  recognition.onaudiostart = () => log('🎤 STT 開始接收音訊');
  recognition.onspeechstart = () => log('🗣️ STT 偵測到人聲');
  recognition.onnomatch = () => log('STT 沒辨識出內容');

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      const isFinal = result.isFinal;
      if (!text) continue;

      log(`📝 STT result: "${text}" (final=${isFinal})`);

      // 顯示在自己這邊（標自己的語言）
      addSubtitle('self', text, sttLang, !isFinal);

      // 透過 DataChannel 傳給對方
      // 注意：lang 一定要帶，未來翻譯才知道從什麼翻成什麼
      if (subtitleDC && subtitleDC.readyState === 'open') {
        try {
          subtitleDC.send(JSON.stringify({
            type: 'subtitle',
            v: 1,
            data: {
              text,
              lang: sttLang,
              interim: !isFinal,
              ts: Date.now(),
            },
          }));
        } catch (err) {
          log(`字幕送出失敗: ${err.message}`);
        }
      } else if (isFinal) {
        // DC 還沒開：等開了之後再送可能來不及，但 self 顯示一定要有
        log(`(DC 未開，僅本地顯示)`);
      }
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') {
      // 常見、無害；no-speech 是 Chrome 沒聽到聲音超過幾秒
      return;
    }
    log(`❌ STT error: ${e.error}`);
    setSTTStatus('error', e.error);

    // 'not-allowed' = 用戶拒絕麥克風
    // 'service-not-allowed' = Chrome 連不到 Google STT 服務
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      sttActive = false; // 不要 auto restart
    }
  };

  recognition.onend = () => {
    log(`STT onend (sttActive=${sttActive})`);
    // Safari/Chrome 會在停頓後自動結束 → 沒掛斷的話自動重啟
    if (sttActive) {
      try {
        recognition.start();
      } catch (err) {
        log(`STT restart 失敗: ${err.message}`);
        setSTTStatus('error', '重啟失敗');
      }
    } else {
      setSTTStatus('idle', '已停止');
    }
  };

  setSTTStatus('starting', '啟動中...');
  try {
    recognition.start();
    sttActive = true;
    log(`▶️ STT.start() 已呼叫 (${sttLang})`);
  } catch (err) {
    log(`❌ STT.start() 失敗: ${err.message}`);
    setSTTStatus('error', err.message);
  }
}

function stopSTT() {
  sttActive = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
  setSTTStatus('idle', '未啟動');
}

function updateLangBtn() {
  const li = langInfo(sttLang);
  langBtn.textContent = `${li.flag} ${li.label}`;
}

function toggleLang() {
  const idx = LANGS.findIndex(l => l.code === sttLang);
  sttLang = LANGS[(idx + 1) % LANGS.length].code;
  localStorage.setItem('kaitalk.lang', sttLang);
  updateLangBtn();
  log(`我講的語言改成: ${sttLang}`);
  // 重啟 STT 套用新語言
  if (sttActive) {
    stopSTT();
    setTimeout(() => startSTT(), 200);
  }
}

// ─── Subtitle DataChannel ────────────────────────────
function setupSubtitleDC(dc) {
  subtitleDC = dc;
  dc.onopen = () => {
    log(`字幕 DataChannel open（雙向字幕通道已建立）`);
  };
  dc.onmessage = (e) => {
    if (!subtitlesEnabled) return; // 用戶關掉字幕就不顯示對方的
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'subtitle' && msg.data) {
        const { text, lang, interim } = msg.data;
        // 第一次收到對方字幕 → 記住對方的語言（之後可以判斷要不要翻譯）
        if (!peerLang && lang) {
          peerLang = lang;
          log(`對方語言: ${lang}`);
        }
        addSubtitle('peer', text, lang, interim);
      }
    } catch (err) {
      log(`DC parse error: ${err.message}`);
    }
  };
  dc.onclose = () => log(`字幕 DataChannel closed`);
  dc.onerror = (e) => log(`字幕 DC error: ${e.error || 'unknown'}`);
}

// ─── Socket ──────────────────────────────────────────
function connectSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    log(`Socket connected: ${socket.id.slice(0, 8)}`);
    setStatus('就緒，按下方按鈕開始配對');
    showButtons('idle');
  });

  socket.on('match_queued', ({ position }) => {
    log(`進入佇列 (#${position})`);
    setStatus('等待其他使用者...', true);
  });

  socket.on('match_found', async ({ roomCode, isHost: hostFlag, peer }) => {
    peerId = peer.id;
    peerName = peer.name;
    isHost = hostFlag;
    log(`配對成功！房號 ${roomCode}, 對方 ${peer.name}, 我是 ${isHost ? 'host' : 'guest'}`);
    setStatus(`🎉 已配對到 ${peer.name}，建立連線中...`, true);
    showPeerCard(peer.name, roomCode, isHost ? 'host' : 'guest');
    showButtons('in-call');
    showMeters();
    if (subtitlesEnabled) showSubtitles();
    clearSubtitles();
    await setupPeerConnection();
  });

  socket.on('webrtc_signal', async ({ from, signal }) => {
    if (!pc) return;
    try {
      if (signal.type === 'offer') {
        log(`收到 offer`);
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_signal', { target: from, signal: answer });
        log(`回送 answer`);
      } else if (signal.type === 'answer') {
        log(`收到 answer`);
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
      } else if (signal.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal));
        } else {
          pendingCandidates.push(new RTCIceCandidate(signal));
        }
      }
    } catch (err) {
      log(`signal error: ${err.message}`);
    }
  });

  socket.on('peer_hangup', () => {
    log(`對方掛斷`);
    const oldName = peerName;
    cleanup();
    setStatus(`${oldName || '對方'} 掛斷了`);
    hidePeerCard();
    hideMeters();
    hideSubtitles();
    showButtons('idle');
  });

  socket.on('match_cancelled', () => {
    log(`配對已取消`);
    setStatus('已取消');
    showButtons('idle');
  });

  socket.on('disconnect', () => {
    log(`Socket disconnected`);
    setStatus('連線中斷');
  });
}

// ─── WebRTC ──────────────────────────────────────────
async function setupPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // 加入本地音訊 track（這就是 kaitalk vs porkergame 的關鍵差別）
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    log(`本地 audio track 已加入`);
  }

  // 字幕 DataChannel：host 建立、guest 接收
  // 用獨立的 DataChannel 是為了 protocol 擴充性——
  // 之後可以再加 'reaction'、'game' 等 channel，互不干擾
  if (isHost) {
    const dc = pc.createDataChannel('subtitle', { ordered: true });
    setupSubtitleDC(dc);
    log(`Host: 建立 subtitle DataChannel`);
  } else {
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'subtitle') {
        log(`Guest: 收到 subtitle DataChannel`);
        setupSubtitleDC(event.channel);
      }
    };
  }

  // STT 立刻啟動，不等 DataChannel —— 即使 DC 還沒開，本地字幕一定要先看得到
  // DC 開好後送出去的訊息會自動帶走，沒開的話就只在自己這邊顯示
  if (subtitlesEnabled) {
    startSTT();
  }

  // 收到對方的 track → 接到 <audio> 播放 + 接到 analyser 顯示音量
  pc.ontrack = (event) => {
    log(`收到對方 audio track`);
    const remoteStream = event.streams[0];
    remoteAudio.srcObject = remoteStream;
    remoteAnalyser = attachAnalyser(remoteStream);
    setStatus(`🎙️ 與 ${peerName} 通話中`, true);
  };

  // ICE candidate → 透過 server 轉給對方
  pc.onicecandidate = (event) => {
    if (event.candidate && peerId) {
      socket.emit('webrtc_signal', { target: peerId, signal: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'connected') {
      setStatus(`🎙️ 與 ${peerName} P2P 連線成功，正在通話`, true);
    } else if (pc.iceConnectionState === 'failed') {
      setStatus('連線失敗（可能需要 TURN）');
    }
  };

  // host 主動發 offer
  if (isHost) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc_signal', { target: peerId, signal: offer });
    log(`已發送 offer 給 ${peerId.slice(0, 8)}`);
  }
  // guest 等對方的 offer
}

// ─── Actions ─────────────────────────────────────────
async function startMatching() {
  try {
    setStatus('請求麥克風權限...');
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    log(`麥克風 OK`);

    // 立刻掛上本地 mic analyser，這樣配對時就能看自己的 mic 動
    localAnalyser = attachAnalyser(localStream);
    showMeters();
    startMeterLoop();

    const name = nameInput.value.trim() || `Anon${Math.floor(Math.random() * 1000)}`;
    socket.emit('find_match', { name });
    showButtons('matching');
  } catch (err) {
    log(`getUserMedia 失敗: ${err.message}`);
    setStatus('無法取得麥克風權限');
  }
}

function cancelMatching() {
  socket.emit('cancel_match');
  cleanup();
  hidePeerCard();
  hideMeters();
  hideSubtitles();
  showButtons('idle');
}

function hangup() {
  if (peerId) socket.emit('hangup', { target: peerId });
  cleanup();
  setStatus('已掛斷');
  hidePeerCard();
  hideMeters();
  hideSubtitles();
  showButtons('idle');
}

function toggleMute() {
  const muted = !remoteAudio.muted;
  remoteAudio.muted = muted;
  if (muted) {
    btnMute.textContent = '🔇 喇叭：靜音中（meter 仍然會動）';
    btnMute.classList.add('muted');
  } else {
    btnMute.textContent = '🔊 喇叭：開（單機測試請按靜音）';
    btnMute.classList.remove('muted');
  }
  log(`喇叭 ${muted ? '靜音' : '開啟'}`);
}

function updateSubtitleBtn() {
  if (subtitlesEnabled) {
    btnSubtitle.textContent = '💬 字幕：開（點此關閉）';
    btnSubtitle.classList.remove('off');
  } else {
    btnSubtitle.textContent = '💬 字幕：關（點此開啟）';
    btnSubtitle.classList.add('off');
  }
}

function toggleSubtitles() {
  subtitlesEnabled = !subtitlesEnabled;
  localStorage.setItem('kaitalk.subtitles', subtitlesEnabled ? 'true' : 'false');
  updateSubtitleBtn();
  log(`字幕 ${subtitlesEnabled ? '開啟' : '關閉'}`);

  if (subtitlesEnabled) {
    showSubtitles();
    // 只有正在通話才啟動 STT
    if (pc) startSTT();
  } else {
    stopSTT();
    hideSubtitles();
    clearSubtitles();
  }
}

function cleanup() {
  stopSTT();
  stopMeterLoop();
  if (subtitleDC) {
    try { subtitleDC.close(); } catch {}
    subtitleDC = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (remoteAudio.srcObject) {
    remoteAudio.srcObject = null;
  }
  localAnalyser = null;
  remoteAnalyser = null;
  peerId = null;
  peerName = null;
  peerLang = null;
  isHost = false;
  pendingCandidates = [];
}

// ─── Wire up ─────────────────────────────────────────
btnStart.addEventListener('click', startMatching);
btnCancel.addEventListener('click', cancelMatching);
btnHangup.addEventListener('click', hangup);
btnMute.addEventListener('click', toggleMute);
btnSubtitle.addEventListener('click', toggleSubtitles);
langBtn.addEventListener('click', toggleLang);

// 初始化按鈕（用偵測到的或記住的設定）
updateLangBtn();
updateSubtitleBtn();

if (!isSTTSupported()) {
  log('⚠️ 此瀏覽器不支援即時字幕（請用 Chrome / Edge / Safari）');
}

setStatus('連接 server...');
connectSocket();
