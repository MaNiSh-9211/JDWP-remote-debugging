import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(__dirname, '../shared/renderer')

export default defineConfig({
  root: rendererRoot,
  plugins: [react()],
  base: './',
  resolve: {
    modules: [path.resolve(__dirname, 'node_modules'), 'node_modules'],
    alias: {
      '@tanstack/react-virtual': path.resolve(__dirname, 'node_modules/@tanstack/react-virtual'),
    },
  },
  server: { port: 5179, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
