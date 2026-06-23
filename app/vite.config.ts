import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __GITHUB_REPO__: JSON.stringify(process.env.VITE_UPDATE_REPO ?? 'Its-ze/roadlens-scout'),
  },
  server: {
    host: '127.0.0.1',
    port: 5177,
  },
  preview: {
    host: '127.0.0.1',
    port: 4177,
  },
});
