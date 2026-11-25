import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/ncbi-api': {
        target: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ncbi-api/, ''),
      },
      '/api/hetop': {
        target: 'https://www.hetop.eu/CISMeFhetopservice/REST',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hetop/, ''),
      },
    },
  },
  test: {
    fileParallelism: false,
  },
})
