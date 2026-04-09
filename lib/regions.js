/**
 * lib/regions.js — 大區定義 + IP region 對應
 *
 * 「附近配對」「指定地方」用的就是這些大區。
 *
 * 為什麼用大區不用縣市/都道府縣：
 * - 縣市太細 → 配對池子小到 0
 * - 例如「鳥取縣」可能整個 App 沒有任何用戶
 * - 大區夠粗 → 池子大到能配，但夠細 → 「附近」感真實
 *
 * 大區清單（先做台灣 + 日本，之後擴充）：
 *
 * 台灣 (5 區):
 *   tw-north    台北 / 新北 / 基隆 / 桃園 / 新竹 / 苗栗
 *   tw-central  台中 / 彰化 / 南投 / 雲林
 *   tw-south    嘉義 / 台南 / 高雄 / 屏東
 *   tw-east     宜蘭 / 花蓮 / 台東
 *   tw-island   澎湖 / 金門 / 馬祖
 *
 * 日本 (8 區):
 *   jp-hokkaido  北海道
 *   jp-tohoku    青森 / 岩手 / 宮城 / 秋田 / 山形 / 福島
 *   jp-kanto     茨城 / 栃木 / 群馬 / 埼玉 / 千葉 / 東京 / 神奈川
 *   jp-chubu     新潟 / 富山 / 石川 / 福井 / 山梨 / 長野 / 岐阜 / 静岡 / 愛知
 *   jp-kansai    三重 / 滋賀 / 京都 / 大阪 / 兵庫 / 奈良 / 和歌山
 *   jp-chugoku   鳥取 / 島根 / 岡山 / 広島 / 山口
 *   jp-shikoku   徳島 / 香川 / 愛媛 / 高知
 *   jp-kyushu    福岡 / 佐賀 / 長崎 / 熊本 / 大分 / 宮崎 / 鹿児島 / 沖縄
 */

// 大區顯示資訊
export const REGIONS = [
  // 台灣
  { id: 'tw-north',   country: 'TW', flag: '🇹🇼', name_zh: '北部',   name_ja: '北部',   name_en: 'North' },
  { id: 'tw-central', country: 'TW', flag: '🇹🇼', name_zh: '中部',   name_ja: '中部',   name_en: 'Central' },
  { id: 'tw-south',   country: 'TW', flag: '🇹🇼', name_zh: '南部',   name_ja: '南部',   name_en: 'South' },
  { id: 'tw-east',    country: 'TW', flag: '🇹🇼', name_zh: '東部',   name_ja: '東部',   name_en: 'East' },
  { id: 'tw-island',  country: 'TW', flag: '🇹🇼', name_zh: '離島',   name_ja: '離島',   name_en: 'Islands' },

  // 日本
  { id: 'jp-hokkaido', country: 'JP', flag: '🇯🇵', name_zh: '北海道', name_ja: '北海道', name_en: 'Hokkaido' },
  { id: 'jp-tohoku',   country: 'JP', flag: '🇯🇵', name_zh: '東北',   name_ja: '東北',   name_en: 'Tohoku' },
  { id: 'jp-kanto',    country: 'JP', flag: '🇯🇵', name_zh: '關東',   name_ja: '関東',   name_en: 'Kanto' },
  { id: 'jp-chubu',    country: 'JP', flag: '🇯🇵', name_zh: '中部',   name_ja: '中部',   name_en: 'Chubu' },
  { id: 'jp-kansai',   country: 'JP', flag: '🇯🇵', name_zh: '關西',   name_ja: '関西',   name_en: 'Kansai' },
  { id: 'jp-chugoku',  country: 'JP', flag: '🇯🇵', name_zh: '中國',   name_ja: '中国',   name_en: 'Chugoku' },
  { id: 'jp-shikoku',  country: 'JP', flag: '🇯🇵', name_zh: '四國',   name_ja: '四国',   name_en: 'Shikoku' },
  { id: 'jp-kyushu',   country: 'JP', flag: '🇯🇵', name_zh: '九州',   name_ja: '九州',   name_en: 'Kyushu' },
];

// 從 ipinfo.io 的 region 字串對應到大區 id
// ipinfo.io 的 region 是 ISO 子層級的英文名（如 "Taipei", "Saitama"）
// 對應規則：英文小寫部分匹配
const TW_REGION_MAP = {
  // 北部
  'taipei':    'tw-north',
  'new taipei':'tw-north',
  'keelung':   'tw-north',
  'taoyuan':   'tw-north',
  'hsinchu':   'tw-north',
  'miaoli':    'tw-north',
  // 中部
  'taichung':  'tw-central',
  'changhua':  'tw-central',
  'nantou':    'tw-central',
  'yunlin':    'tw-central',
  // 南部
  'chiayi':    'tw-south',
  'tainan':    'tw-south',
  'kaohsiung': 'tw-south',
  'pingtung':  'tw-south',
  // 東部
  'yilan':     'tw-east',
  'hualien':   'tw-east',
  'taitung':   'tw-east',
  // 離島
  'penghu':    'tw-island',
  'kinmen':    'tw-island',
  'lienchiang':'tw-island',
};

const JP_REGION_MAP = {
  // 北海道
  'hokkaido':  'jp-hokkaido',
  // 東北
  'aomori':    'jp-tohoku',
  'iwate':     'jp-tohoku',
  'miyagi':    'jp-tohoku',
  'akita':     'jp-tohoku',
  'yamagata':  'jp-tohoku',
  'fukushima': 'jp-tohoku',
  // 関東
  'ibaraki':   'jp-kanto',
  'tochigi':   'jp-kanto',
  'gunma':     'jp-kanto',
  'saitama':   'jp-kanto',
  'chiba':     'jp-kanto',
  'tokyo':     'jp-kanto',
  'kanagawa':  'jp-kanto',
  // 中部
  'niigata':   'jp-chubu',
  'toyama':    'jp-chubu',
  'ishikawa':  'jp-chubu',
  'fukui':     'jp-chubu',
  'yamanashi': 'jp-chubu',
  'nagano':    'jp-chubu',
  'gifu':      'jp-chubu',
  'shizuoka':  'jp-chubu',
  'aichi':     'jp-chubu',
  // 関西
  'mie':       'jp-kansai',
  'shiga':     'jp-kansai',
  'kyoto':     'jp-kansai',
  'osaka':     'jp-kansai',
  'hyogo':     'jp-kansai',
  'nara':      'jp-kansai',
  'wakayama':  'jp-kansai',
  // 中国
  'tottori':   'jp-chugoku',
  'shimane':   'jp-chugoku',
  'okayama':   'jp-chugoku',
  'hiroshima': 'jp-chugoku',
  'yamaguchi': 'jp-chugoku',
  // 四国
  'tokushima': 'jp-shikoku',
  'kagawa':    'jp-shikoku',
  'ehime':     'jp-shikoku',
  'kochi':     'jp-shikoku',
  // 九州
  'fukuoka':   'jp-kyushu',
  'saga':      'jp-kyushu',
  'nagasaki':  'jp-kyushu',
  'kumamoto':  'jp-kyushu',
  'oita':      'jp-kyushu',
  'miyazaki':  'jp-kyushu',
  'kagoshima': 'jp-kyushu',
  'okinawa':   'jp-kyushu',
};

/**
 * 把 ipinfo 給的 region/city 對應到大區 id
 *
 * ipinfo.io 對不同國家給的格式不一樣：
 *   TW: region="Taiwan", city="Changhua" → 用 city
 *   JP: region="Saitama", city="Niiza"   → 用 region (都道府縣) 比較準
 *
 * 所以兩個 field 都試。
 */
export function regionToBigRegion(country, region, city) {
  if (!country) return null;
  const tryKey = (s) => String(s || '').toLowerCase().trim();

  if (country === 'TW') {
    // 台灣優先用 city（region 通常是「Taiwan」沒幫助）
    return TW_REGION_MAP[tryKey(city)]
        || TW_REGION_MAP[tryKey(region)]
        || null;
  }
  if (country === 'JP') {
    // 日本優先用 region（都道府縣），city 是更細的市町村
    return JP_REGION_MAP[tryKey(region)]
        || JP_REGION_MAP[tryKey(city)]
        || null;
  }
  return null;
}

/**
 * 拿一個大區的顯示資訊
 */
export function getRegionInfo(bigRegionId) {
  return REGIONS.find(r => r.id === bigRegionId) || null;
}

/**
 * 拿一個國家的所有大區
 */
export function getRegionsByCountry(country) {
  return REGIONS.filter(r => r.country === country);
}
