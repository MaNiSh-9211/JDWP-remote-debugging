/**
 * Generic JDWP port-forward to ANY pod — the production attach path.
 *
 * Unlike kind-port-forward (demo-specific labels), this takes an explicit
 * pod name and works on any cluster reachable via kubectl. Forwards are
 * tracked per local port; status is introspectable from the renderer.
 *
 * Security: pod/namespace/context validated, no shell spawned.
 */
const { spawn } = require('child_process')

const MAX_FORWARDS = 8

/** Map<localPort, { proc, info }> */
const forwards = new Map()

function kubectlEnv() {
  const env = { ...process.env }
  if (process.platform === 'win32') {
    const extra = ['C:\\Program Files\\Docker\\Docker\\resources\\bin', 'C:\\Program Files\\Kubernetes\\Minikube']
    env.PATH = [...extra, env.PATH || ''].join(';')
  }
  return env
}

function validateName(value, label) {
  const s = String(value || '').trim()
  if (!s || !/^[a-z0-9]([-a-z0-9.]{0,250}[a-z0-9])?$/i.test(s)) {
    throw new Error(`Invalid ${label}`)
  }
  return s
}

function killForward(localPort) {
  const entry = forwards.get(localPort)
  if (!entry) return
  try {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(entry.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        entry.proc.kill()
      }
    } else {
      entry.proc.kill('SIGTERM')
    }
  } catch { /* already gone */ }
  forwards.delete(localPort)
}

function killAllForwards() {
  for (const port of Array.from(forwards.keys())) killForward(port)
}

function startPodForward({ namespace, pod, remotePort = 5005, localPort, kubeContext, kubeconfig }) {
  namespace = validateName(namespace, 'namespace')
  pod = validateName(pod, 'pod name')
  remotePort = Number(remotePort)
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('Invalid remote port')
  localPort = Number(localPort) || remotePort
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Invalid local port')
  if (/[\s;"'|&<>]/.test(String(kubeContext || ''))) throw new Error('Invalid kube context')

  // Reuse an existing identical forward instead of failing on a busy port.
  const existing = forwards.get(localPort)
  if (existing && existing.info.pod === pod && existing.info.namespace === namespace && existing.info.remotePort === remotePort) {
    return Promise.resolve({ ok: true, reused: true, ...existing.info })
  }
  killForward(localPort)

  if (forwards.size >= MAX_FORWARDS) {
    return Promise.reject(new Error(`Too many active forwards (max ${MAX_FORWARDS})`))
  }

  const args = [
    ...(kubeconfig ? ['--kubeconfig', String(kubeconfig).trim()] : []),
    ...(kubeContext ? ['--context', String(kubeContext).trim()] : []),
    '-n', namespace,
    'port-forward', `pod/${pod}`,
    `${localPort}:${remotePort}`,
  ]

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    const proc = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const info = { pod, namespace, localPort, remotePort, startedAt: Date.now() }

    const failEarly = (msg) => {
      try { proc.kill() } catch { /* ignore */ }
      forwards.delete(localPort)
      finish(reject, new Error(msg))
    }
    proc.on('error', (err) => failEarly(err.message || String(err)))
    proc.stderr?.on('data', (d) => {
      const t = d.toString()
      if (t.includes('Unable to listen') || t.includes('error') || t.includes('NotFound')) {
        failEarly(t.trim().split('\n')[0])
      }
    })
    proc.on('exit', (code) => {
      forwards.delete(localPort)
      if (code !== 0 && code !== null) failEarly(`kubectl port-forward exited with code ${code}`)
    })

    // kubectl prints "Forwarding from ..." when the tunnel accepts connections.
    proc.stdout?.on('data', (d) => {
      if (String(d).includes('Forwarding from')) {
        forwards.set(localPort, { proc, info })
        finish(resolve, { ok: true, ...info })
      }
    })

    setTimeout(() => {
      if (settled) return
      if (proc.exitCode !== null) return // exit handler already reported failure
      forwards.set(localPort, { proc, info })
      finish(resolve, { ok: true, assumed: true, ...info })
    }, 1500)
  })
}

function registerPodJdwpForwardIpc(ipcMain) {
  ipcMain.handle('pod-jdwp-forward', async (_, opts) => {
    try {
      return await startPodForward(opts || {})
    } catch (e) {
      return { ok: false, message: e.message || String(e) }
    }
  })

  ipcMain.handle('pod-jdwp-forward-stop', (_, payload) => {
    const localPort = Number(payload?.localPort)
    if (Number.isInteger(localPort)) killForward(localPort)
    else killAllForwards()
    return { ok: true }
  })

  ipcMain.handle('pod-jdwp-forward-status', () => ({
    forwards: Array.from(forwards.entries()).map(([localPort, { info }]) => ({
      localPort,
      pod: info.pod,
      namespace: info.namespace,
      remotePort: info.remotePort,
      startedAt: info.startedAt,
    })),
  }))
}

module.exports = { registerPodJdwpForwardIpc, killAllForwards }
