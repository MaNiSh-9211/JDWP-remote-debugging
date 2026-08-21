/**
 * Security helpers (bundled next to main.cjs for electron-builder).
 */
const { session } = require('electron')

const DEFAULT_API = 'http://localhost:8083'

function isAllowedApiBaseUrl(urlString) {
  try {
    const u = new URL(urlString.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

function validateApiBase(raw) {
  const s = (raw && String(raw).trim()) || DEFAULT_API
  if (!isAllowedApiBaseUrl(s)) return DEFAULT_API
  return s.replace(/\/$/, '')
}

function setupContentSecurityPolicy(devServerOrigin) {
  const connectParts = [
    "'self'",
    'http://localhost:8083',
    'http://127.0.0.1:8083',
    'ws://localhost:8083',
    'http://localhost:5177',
    'http://localhost:5178',
    'http://localhost:5179',
    'ws://localhost:5177',
    'ws://localhost:5178',
    'ws://localhost:5179',
    'http://127.0.0.1:5177',
    'http://127.0.0.1:5178',
    'http://127.0.0.1:5179',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ]
  if (devServerOrigin) {
    try {
      const u = new URL(devServerOrigin)
      const origin = `${u.protocol}//${u.host}`
      if (!connectParts.includes(origin)) connectParts.push(origin)
      if (u.protocol === 'http:') connectParts.push(`ws://${u.host}`)
      else if (u.protocol === 'https:') connectParts.push(`wss://${u.host}`)
    } catch {
      /* ignore */
    }
  }

  // Vite's production build uses external hashed assets, so scripts can be
  // locked down fully; the dev server needs inline for HMR/React refresh.
  const scriptSrc = devServerOrigin ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src ${connectParts.join(' ')}`,
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function attachNavigationGuards(webContents, isDev, devServerOrigin) {
  webContents.on('will-navigate', (event, url) => {
    if (isDev) {
      try {
        const u = new URL(url)
        const dev = new URL(devServerOrigin || 'http://localhost:5177')
        if (u.origin === dev.origin) return
        if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === dev.port) return
      } catch {
        event.preventDefault()
        return
      }
      event.preventDefault()
    } else if (!url.startsWith('file:')) {
      event.preventDefault()
    }
  })
}

module.exports = {
  validateApiBase,
  setupContentSecurityPolicy,
  attachNavigationGuards,
  DEFAULT_API,
}
