import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.resolve(__dirname, '../shared/renderer')

// Renderer sources live outside this package; every dependency must resolve
// against THIS app's node_modules (pinned via aliases so Rollup never tries
// to look upward from the shared directory).
const nm = (p) => path.resolve(__dirname, 'node_modules', p)

export default defineConfig({
  root: rendererRoot,
  plugins: [react()],
  base: './',
  resolve: {
    modules: [path.resolve(__dirname, 'node_modules'), 'node_modules'],
    alias: {
      '@tanstack/react-virtual': nm('@tanstack/react-virtual'),
      react: nm('react'),
      'react-dom': nm('react-dom'),
      'react/jsx-runtime': path.resolve(nm('react'), 'jsx-runtime.js'),
    },
  },
  server: { port: 5179, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
