import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kaitalk.app',
  appName: 'KaiTalk',
  webDir: 'public',
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
  },
  plugins: {},
};

export default config;
