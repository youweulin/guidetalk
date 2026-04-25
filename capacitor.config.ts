import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.guidetalk.app',
  appName: 'GuideTalk',
  webDir: 'public',
  server: {
    allowNavigation: [
      'guidetalk.zeabur.app',
    ],
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    allowsLinkPreview: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    Geolocation: {
      // 位置權限與背景模式由 Info.plist 控制
    },
  },
};

export default config;
