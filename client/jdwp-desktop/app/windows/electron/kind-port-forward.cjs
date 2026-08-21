/**
 * Runs kubectl port-forward for Kind demo pods (JDWP 5005 -> host).
 * Requires kubectl on PATH and context kind-jdwp-demo (or pass kubeContext).
 */
const { spawn, execFileSync } = require('child_process')

/** Electron on Windows often has a short PATH; kubectl ships with Docker Desktop. */
function kubectlEnv() {
  const env = { ...process.env }
  if (process.platform === 'win32') {
    const extra = ['C:\\Program Files\\Docker\\Docker\\resources\\bin', 'C:\\Program Files\\Kubernetes\\Minikube']
    env.PATH = [...extra, env.PATH || ''].join(';')
  }
  return env
}

let pfProcess = null
let lastInfo = null

function killPf() {
  if (!pfProcess) return
  try {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pfProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        pfProcess.kill()
      }
    } else {
      pfProcess.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
  pfProcess = null
}

function getPodName(namespace, appLabel, kubeContext) {
  const args = [
    ...(kubeContext ? ['--context', kubeContext] : []),
    'get',
    'pod',
    '-n',
    namespace,
    '-l',
    `app=${appLabel}`,
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]
  const name = execFileSync('kubectl', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: kubectlEnv(),
  }).trim()
  if (!name) {
    throw new Error(`No pod found in ${namespace} with app=${appLabel}`)
  }
  return name
}

function startForward({ instance, namespace = 'jdwp-demo', localPort = 5005, kubeContext = 'kind-jdwp-demo' }) {
  killPf()
  const appLabel = instance === 'b' ? 'jdwp-demo-b' : 'jdwp-demo-a'
  const pod = getPodName(namespace, appLabel, kubeContext)
  const args = [
    ...(kubeContext ? ['--context', kubeContext] : []),
    '-n',
    namespace,
    'port-forward',
    `pod/${pod}`,
    `${localPort}:5005`,
  ]
  pfProcess = spawn('kubectl', args, {
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
    env: kubectlEnv(),
  })
  lastInfo = { podName: pod, instance, localPort, namespace, appLabel }

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      fn(arg)
    }
    const failEarly = (msg) => {
      killPf()
      lastInfo = null
      finish(reject, new Error(msg))
    }
    pfProcess.on('error', (err) => failEarly(err.message || String(err)))
    pfProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        failEarly(`kubectl port-forward exited with code ${code}`)
      }
    })
    setTimeout(() => {
      if (!pfProcess || pfProcess.killed) return
      finish(resolve, { ok: true, podName: pod, instance, localPort, namespace })
    }, 600)
  })
}

function registerKindPortForwardIpc(ipcMain) {
  ipcMain.handle('kind-jdwp-forward-stop', () => {
    killPf()
    lastInfo = null
    return { ok: true }
  })

  ipcMain.handle('kind-jdwp-forward', async (_, opts) => {
    try {
      const instance = opts?.instance
      if (instance !== 'a' && instance !== 'b') {
        throw new Error('instance must be "a" or "b"')
      }
      const namespace = typeof opts?.namespace === 'string' ? opts.namespace : 'jdwp-demo'
      const localPort = Number(opts?.localPort) || 5005
      const kubeContext = typeof opts?.kubeContext === 'string' ? opts.kubeContext : 'kind-jdwp-demo'
      if (!/^[\w-]+$/.test(namespace)) {
        throw new Error('Invalid namespace')
      }
      return await startForward({ instance, namespace, localPort, kubeContext })
    } catch (e) {
      return { ok: false, message: e.message || String(e) }
    }
  })

  ipcMain.handle('kind-jdwp-forward-status', () => ({
    active: !!(pfProcess && !pfProcess.killed && pfProcess.exitCode === null),
    ...lastInfo,
  }))
}

function killPfOnAppQuit(app) {
  app.on('before-quit', () => killPf())
}

module.exports = { registerKindPortForwardIpc, killPfOnAppQuit, killPf }
