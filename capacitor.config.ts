import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kaitalk.app',
  appName: 'KaiTalk',
  webDir: 'public',
  server: {
    url: 'https://kaitalk.zeabur.app',
    cleartext: false,
    // 允許 Capacitor bridge 注入到遠端 URL
    allowNavigation: ['kaitalk.zeabur.app'],
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'kaitalk',
  },
  plugins: {},
};

export default config;
