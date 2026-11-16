import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/private/**', '**/artifacts/**', '**/.local-reference/**'],
    },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/private/**',
        '**/*.local.json',
        '**/*.db*',
        '**/*.sqlite*',
      ],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: 'chrome105', sourcemap: false },
});
