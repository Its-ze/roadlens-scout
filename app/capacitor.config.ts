import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.itsz.roadlens',
  appName: 'RoadLens Scout',
  webDir: 'dist',
  bundledWebRuntime: false,
  android: {
    buildOptions: {
      releaseType: 'APK',
    },
  },
};

export default config;
