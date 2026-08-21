const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { validateApiBase, setupContentSecurityPolicy, attachNavigationGuards } = require('./electron-security.cjs')
const { registerClusterExecIpc } = require('./cluster-exec.cjs')
const { registerKindPortForwardIpc, killPfOnAppQuit } = require('./kind-port-forward.cjs')
const { registerPodJdwpForwardIpc, killAllForwards } = require('./pod-jdwp-forward.cjs')

function looksLikeJdwpMonorepoRoot(dir) {
  try {
    const serverPom = path.join(dir, 'server', 'pom.xml')
    const clientPom = path.join(dir, 'client', 'pom.xml')
    return fs.existsSync(serverPom) && fs.existsSync(clientPom)
  } catch {
    return false
  }
}

/** Walk parents from Electron main dir to find JDWP-clinet-springboot-main-style repo. */
function resolveSuggestedSourceRoot(startDir) {
  const env = (process.env.JDWP_SOURCE_ROOT || process.env.JDWP_REPO_ROOT || '').trim()
  if (env) {
    const r = path.resolve(env)
    try {
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) return r
    } catch {
      /* ignore */
    }
  }
  let dir = path.resolve(startDir)
  for (let i = 0; i < 16; i++) {
    if (looksLikeJdwpMonorepoRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const isDev = !app.isPackaged
const VITE_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5177'

function resolveAppIcon() {
  const distIcon = path.join(__dirname, '../dist/app-icon.svg')
  const srcIcon = path.join(__dirname, '../../shared/renderer/public/app-icon.svg')
  if (fs.existsSync(distIcon)) return distIcon
  if (fs.existsSync(srcIcon)) return srcIcon
  return undefined
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'JDWP Studio',
    icon: resolveAppIcon(),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    backgroundColor: '#141210',
  })

  win.on('maximize', () => win.webContents.send('window-state', { maximized: true }))
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }))

  attachNavigationGuards(win.webContents, isDev, VITE_URL)

  if (isDev) {
    win.loadURL(VITE_URL)
    if (process.env.JDWP_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url)
      }
    } catch {
      /* ignore */
    }
    return { action: 'deny' }
  })
}

registerClusterExecIpc(ipcMain)
registerKindPortForwardIpc(ipcMain)
registerPodJdwpForwardIpc(ipcMain)
killPfOnAppQuit(app)
app.on('before-quit', () => killAllForwards())

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  setupContentSecurityPolicy(isDev ? VITE_URL : undefined)
  createWindow()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

ipcMain.handle('get-default-api-base', () => {
  return validateApiBase(process.env.JDWP_API_BASE)
})

// Read-only kube context discovery for the Cluster panel dropdown.
// Runs `kubectl config get-contexts` (no cluster calls, local config only).
ipcMain.handle('kube-context-list', async (_, payload) => {
  const kubeconfig = payload && typeof payload.kubeconfig === 'string' ? payload.kubeconfig.trim() : ''
  const args = ['config', 'get-contexts', '--no-headers', '-o', 'name']
  if (kubeconfig) args.unshift('--kubeconfig', kubeconfig)
  return await new Promise((resolve) => {
    const child = spawn('kubectl', args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      resolve({ ok: false, error: 'kubectl timed out', contexts: [] })
    }, 10000)
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message || String(err), contexts: [] })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const contexts = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      resolve({ ok: contexts.length > 0, error: contexts.length ? null : (stderr.trim() || 'No contexts found'), contexts })
    })
  })
})

ipcMain.handle('sanitize-api-base', (_, url) => {
  return validateApiBase(url)
})

const SEED_FILE_MAX_BYTES = 512 * 1024

// Seed files may only be read from the suggested repo root (or its parents),
// never from arbitrary disk locations.
ipcMain.handle('read-text-file-allowed', async (_, rawPath) => {
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) {
    throw new Error('Empty path')
  }
  const resolved = path.resolve(trimmed)
  if (!resolved.toLowerCase().endsWith('.json')) {
    throw new Error('Only .json seed files are allowed')
  }
  const root = resolveSuggestedSourceRoot(__dirname)
  if (!root || !isInsideRoot(root, resolved)) {
    throw new Error('Seed files must live inside the detected repository root')
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('File not found')
  }
  const buf = fs.readFileSync(resolved)
  if (buf.length > SEED_FILE_MAX_BYTES) {
    throw new Error('File too large')
  }
  return buf.toString('utf8')
})

const SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024

function normalizeFsRoot(p) {
  return path.resolve(String(p || '').trim())
}

function isInsideRoot(rootResolved, candidateResolved) {
  const r = normalizeFsRoot(rootResolved)
  const c = path.resolve(candidateResolved)
  const prefix = r.endsWith(path.sep) ? r : r + path.sep
  if (process.platform === 'win32') {
    return c === r || c.toLowerCase().startsWith(prefix.toLowerCase())
  }
  return c === r || c.startsWith(prefix)
}

ipcMain.handle('get-suggested-source-root', () => {
  const p = resolveSuggestedSourceRoot(__dirname)
  return {
    path: p,
    hint: p
      ? 'Detected JDWP monorepo (server/ + client/). Use Apply or open the picker — it starts here.'
      : 'Set JDWP_SOURCE_ROOT or clone this repo; then reopen Source.',
  }
})

ipcMain.handle('pick-source-root', async (event, defaultPath) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const suggested = resolveSuggestedSourceRoot(__dirname)
  const raw = typeof defaultPath === 'string' ? defaultPath.trim() : ''
  const def = raw && fs.existsSync(path.resolve(raw)) ? path.resolve(raw) : suggested
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    properties: ['openDirectory'],
    defaultPath: def && fs.existsSync(def) ? def : undefined,
  })
  if (canceled || !filePaths?.[0]) return null
  return filePaths[0]
})

ipcMain.handle('normalize-source-root-path', async (_, rawPath) => {
  const trimmed = String(rawPath || '').trim()
  if (!trimmed) return { ok: false, error: 'Empty path' }
  let p = path.resolve(trimmed)
  if (!fs.existsSync(p)) return { ok: false, error: 'Path not found' }
  const st = fs.statSync(p)
  if (st.isFile()) p = path.dirname(p)
  else if (!st.isDirectory()) return { ok: false, error: 'Not a file or folder' }
  return { ok: true, path: p }
})

ipcMain.handle('read-source-under-root', async (_, rootRaw, relRaw) => {
  const root = normalizeFsRoot(rootRaw)
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: 'Invalid source root' }
  }
  let rel = String(relRaw || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.includes('..')) {
    return { ok: false, error: 'Invalid relative path' }
  }
  const lower = rel.toLowerCase()
  if (!lower.endsWith('.java') && !lower.endsWith('.kt') && !lower.endsWith('.scala')) {
    return { ok: false, error: 'Only source files allowed' }
  }
  const candidate = path.resolve(path.join(root, ...rel.split('/')))
  if (!isInsideRoot(root, candidate)) {
    return { ok: false, error: 'Path escapes root' }
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return { ok: false, error: 'not found' }
  }
  const buf = fs.readFileSync(candidate)
  if (buf.length > SOURCE_FILE_MAX_BYTES) {
    return { ok: false, error: 'File too large' }
  }
  const resolvedRel = path.relative(root, candidate).split(path.sep).join('/')
  return { ok: true, content: buf.toString('utf8'), resolvedRel }
})

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.idea', '__pycache__'])

function resolvePathUnderRoot(root, relRaw) {
  const rel = String(relRaw ?? '.').replace(/\\/g, '/').replace(/^\/+/, '') || '.'
  if (rel.includes('..')) return null
  const segs = rel === '.' ? [] : rel.split('/').filter(Boolean)
  const dir = path.resolve(path.join(normalizeFsRoot(root), ...segs))
  return dir
}

ipcMain.handle('list-dir-under-root', async (_, rootRaw, relRaw) => {
  const root = normalizeFsRoot(rootRaw)
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: 'Invalid source root' }
  }
  const dir = resolvePathUnderRoot(root, relRaw)
  if (!dir || !isInsideRoot(root, dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: 'not found' }
  }
  let rel = String(relRaw ?? '.').replace(/\\/g, '/').replace(/^\/+/, '') || '.'
  const dirents = fs.readdirSync(dir, { withFileTypes: true })
  const entries = []
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue
    if (SKIP_DIR_NAMES.has(d.name)) continue
    const childRel = rel === '.' ? d.name : `${rel}/${d.name}`
    entries.push({
      name: d.name,
      isDirectory: d.isDirectory(),
      relPath: childRel.split(path.sep).join('/'),
    })
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return { ok: true, entries }
})

ipcMain.handle('git-clone-repo', async (_, payload) => {
  const url = String(payload?.url || '').trim()
  if (!url) return { ok: false, error: 'Empty URL' }
  // Only https(s) and ssh git URLs; reject anything with shell-hostile characters.
  const urlOk = /^(https:\/\/[\w.-]+(:\d+)?(\/[\w./~%-]*)?(\.git)?|git@[\w.-]+:[\w./~-]+(\.git)?)$/.test(url)
  if (!urlOk) return { ok: false, error: 'Only https:// or git@… URLs are allowed' }
  let parent
  const pd = payload?.parentDir
  if (pd && String(pd).trim()) {
    parent = normalizeFsRoot(pd)
  } else {
    parent = path.join(app.getPath('userData'), 'jdwp-cloned-repos')
  }
  try {
    fs.mkdirSync(parent, { recursive: true })
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
  const tail = url
    .replace(/\.git$/i, '')
    .split(/[/\\]/)
    .filter(Boolean)
    .pop() || 'repo'
  const safeBase = tail.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'repo'
  let dest = path.join(parent, safeBase)
  let n = 0
  while (fs.existsSync(dest)) {
    n += 1
    dest = path.join(parent, `${safeBase}-${n}`)
  }
  return await new Promise((resolve) => {
    const proc = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      cwd: parent,
      shell: false,
    })
    let stderr = ''
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', (err) => resolve({ ok: false, error: err.message || String(err) }))
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, path: dest })
      else resolve({ ok: false, error: stderr.trim() || `git exited with code ${code}` })
    })
  })
})

ipcMain.handle('win-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.handle('win-toggle-maximize', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender)
  if (!w) return
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
})
ipcMain.handle('win-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
