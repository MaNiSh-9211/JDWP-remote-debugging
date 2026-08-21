/**
 * Runs kubectl from the app shell with context/namespace from cluster prefs.
 *
 * Security model:
 *  - Only an allow-list of READ-ONLY / tunneling kubectl subcommands is permitted.
 *  - No shell is spawned (shell: false) and shell metacharacters are rejected.
 *  - Destructive verbs (delete/exec/apply/patch/...) are always refused.
 */
const { spawn } = require('child_process')

const MAX_LEN = 8000
const TIMEOUT_MS = 120000

/** Subcommands the renderer may run. Everything else is refused. */
const ALLOWED_SUBCOMMANDS = new Set([
  'get',
  'describe',
  'logs',
  'explain',
  'api-resources',
  'version',
  'top',
  'port-forward',
  'config',
  'auth',
  'cluster-info',
  'events',
])

/** `config` is only safe for viewing; block mutating config subcommands. */
const CONFIG_ALLOWED = new Set(['view', 'current-context', 'get-contexts', 'get-clusters'])

function tokenize(line) {
  const out = []
  let cur = ''
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === q) q = null
      else cur += c
    } else if (c === '"' || c === "'") {
      q = c
    } else if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += c
    }
  }
  if (cur) out.push(cur)
  return out
}

function hasBlockedMetacharacters(s) {
  for (const b of ['\n', '\r', ';', '|', '&', '>', '<', '`', '$(']) {
    if (s.includes(b)) return true
  }
  return false
}

function registerClusterExecIpc(ipcMain) {
  ipcMain.handle('cluster-exec', async (_event, payload) => {
    const { context, namespace, kubeconfig, commandLine } = payload || {}
    if (typeof commandLine !== 'string') {
      return { ok: false, error: 'Invalid command' }
    }
    const trimmed = commandLine.trim()
    if (!trimmed) return { ok: false, error: 'Empty command' }
    if (trimmed.length > MAX_LEN) return { ok: false, error: 'Command too long' }
    if (hasBlockedMetacharacters(trimmed)) {
      return {
        ok: false,
        error: 'Shell operators are not allowed. Enter kubectl arguments only (e.g. get pods -o wide).',
      }
    }

    let tokens = tokenize(trimmed)
    if (tokens.length === 0) return { ok: false, error: 'Empty command' }
    if (tokens[0].toLowerCase() === 'kubectl') tokens.shift()
    if (tokens.length === 0) return { ok: false, error: 'Missing kubectl subcommand' }

    // Strip global flags so we can find the real subcommand.
    const globalFlags = new Set(['--context', '--namespace', '-n', '--kubeconfig', '--cluster', '--user'])
    let subIdx = 0
    while (
      subIdx < tokens.length &&
      (tokens[subIdx].startsWith('-') ||
        (subIdx > 0 && globalFlags.has(tokens[subIdx - 1])))
    ) {
      subIdx++
    }
    if (subIdx >= tokens.length) return { ok: false, error: 'Missing kubectl subcommand' }

    const sub = tokens[subIdx].toLowerCase()
    if (!ALLOWED_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        error: `kubectl "${sub}" is not allowed. Read-only commands only: ${[...ALLOWED_SUBCOMMANDS].join(', ')}.`,
      }
    }
    if (sub === 'config') {
      const cfgSub = tokens[subIdx + 1] ? tokens[subIdx + 1].toLowerCase() : ''
      if (!CONFIG_ALLOWED.has(cfgSub)) {
        return { ok: false, error: 'Only read-only config commands are allowed (view, current-context, get-contexts, get-clusters).' }
      }
    }

    const args = []
    if (context && String(context).trim()) {
      args.push('--context', String(context).trim())
    }
    if (namespace && String(namespace).trim()) {
      args.push('-n', String(namespace).trim())
    }
    args.push(...tokens)

    const env = { ...process.env }
    if (kubeconfig && typeof kubeconfig === 'string' && kubeconfig.trim()) {
      env.KUBECONFIG = kubeconfig.trim()
    }

    return await new Promise((resolve) => {
      const child = spawn('kubectl', args, {
        env,
        shell: false,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        finish({
          ok: true,
          code: -1,
          stdout,
          stderr: `${stderr}\n[timeout after ${TIMEOUT_MS}ms]`,
          timedOut: true,
        })
      }, TIMEOUT_MS)

      child.stdout?.on('data', (d) => {
        stdout += d.toString()
      })
      child.stderr?.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('close', (code) => {
        finish({ ok: true, code: code ?? 0, stdout, stderr })
      })
      child.on('error', (err) => {
        finish({ ok: false, error: err.message })
      })
    })
  })
}

module.exports = { registerClusterExecIpc }
