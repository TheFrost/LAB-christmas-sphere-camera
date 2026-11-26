import { defineConfig } from 'vite';

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/sphere-christmas/' : '/',
  build: { target: 'es2022' },
  server: { host: true },
}));
