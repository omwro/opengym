import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseChangelog } from './src/lib/changelog.js'

// `virtual:changelog` — the newest CHANGELOG.md entries, parsed at build time for the
// "What's new" sheet. The file sits at the repository root, outside the frontend: a build that
// cannot see it (a Docker build without the COPY) gets an empty list rather than failing.
function changelog() {
  const file = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))
  const id = 'virtual:changelog'
  return {
    name: 'opengym-changelog',
    resolveId: x => (x === id ? '\0' + id : null),
    load(x) {
      if (x !== '\0' + id) return null
      let md = ''
      try { md = readFileSync(file, 'utf8'); this.addWatchFile(file) } catch { this.warn('CHANGELOG.md not found — "What\'s new" will be empty') }
      return 'export default ' + JSON.stringify(parseChangelog(md, 15))
    }
  }
}

const backend = process.env.API_TARGET || 'http://127.0.0.1:3000'
const media = process.env.MEDIA_TARGET || 'http://127.0.0.1:8888'

export default defineConfig({
  plugins: [react(), changelog()],
  base: './',
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/img': { target: media, changeOrigin: true },
      '/gif': { target: media, changeOrigin: true }
    }
  },
  build: { chunkSizeWarningLimit: 1500 }
})
