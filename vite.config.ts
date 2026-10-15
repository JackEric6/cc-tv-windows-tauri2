import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'dist/ui'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
  }
})
