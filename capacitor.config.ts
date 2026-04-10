import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kaitalk.app',
  appName: 'KaiTalk',
  webDir: 'public',
  server: {
    // 直接載入 Zeabur 上的 web app
    url: 'https://kaitalk.zeabur.app',
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'kaitalk',
  },
  plugins: {},
};

export default config;
