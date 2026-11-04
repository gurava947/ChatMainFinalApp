import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['.sg2.manus.computer'],
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
    },
  },
  preview: { port: 4173, host: '0.0.0.0' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
