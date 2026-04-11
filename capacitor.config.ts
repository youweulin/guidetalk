import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kaitalk.app',
  appName: 'KaiTalk',
  webDir: 'public',
  server: {
    // 允許本地 WebView 請求這些遠端 URL
    allowNavigation: [
      'kaitalk.zeabur.app',
      'snzyltibimkbxshkzhyr.supabase.co',
      'imagedelivery.net',
    ],
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    allowsLinkPreview: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true, // 用原生 HTTP 繞過 CORS
    },
  },
};

export default config;
