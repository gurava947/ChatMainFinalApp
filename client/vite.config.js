import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
    },
  },
  preview: { port: 4173, host: '0.0.0.0' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // React, the router and the socket client change on their own cadence;
        // keeping them in named chunks means an app-code deploy reuses the
        // vendor chunks a returning visitor already has cached.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-router')) return 'router'
          if (id.includes('socket.io') || id.includes('engine.io')) return 'socket'
          if (id.includes('lucide-react')) return 'icons'
          if (id.includes('react-dom') || id.includes('scheduler') || id.includes('react')) return 'react'
          return 'vendor'
        },
      },
    },
  },
})
