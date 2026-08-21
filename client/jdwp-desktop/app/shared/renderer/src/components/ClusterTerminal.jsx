import { useCallback, useEffect, useRef, useState } from 'react'

function buildPreviewLine(context, namespace, userLine) {
  const parts = ['kubectl']
  if (context?.trim()) parts.push(`--context=${context.trim()}`)
  if (namespace?.trim()) parts.push('-n', namespace.trim())
  const rest = (userLine || '').trim().replace(/^\s*kubectl\s+/i, '')
  if (rest) parts.push(rest)
  return parts.join(' ')
}

const QUICK = [
  { label: 'Pods', cmd: 'get pods -o wide' },
  { label: 'Services', cmd: 'get svc -o wide' },
  { label: 'Deployments', cmd: 'get deploy -o wide' },
  { label: 'Events', cmd: 'get events --sort-by=.lastTimestamp' },
  { label: 'Nodes', cmd: 'get nodes -o wide' },
  { label: 'API resources', cmd: 'api-resources' },
]

export default function ClusterTerminal({ context, namespace, kubeconfig, showToast }) {
  const [lines, setLines] = useState([])
  const [input, setInput] = useState('get pods -o wide')
  const [busy, setBusy] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const scrollRef = useRef(null)
  const exec = typeof window !== 'undefined' ? window.jdwpElectron?.clusterExec : null

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const append = useCallback((type, text) => {
    setLines((prev) => [...prev, { type, text }])
  }, [])

  const runLine = useCallback(
    async (raw) => {
      const userLine = (raw ?? input).trim()
      if (!userLine) return
      if (!exec) {
        showToast?.('Cluster shell needs JDWP Studio (Electron). Use “Copy command” below.', true)
        return
      }
      const drySuffix = dryRun && !/\bdry-run=/.test(userLine) ? ' --dry-run=client -o yaml' : ''
      const toRun = userLine + drySuffix
      append('in', `$ ${buildPreviewLine(context, namespace, userLine)}${drySuffix}`)
      setBusy(true)
      try {
        const res = await exec({
          context,
          namespace,
          kubeconfig,
          commandLine: toRun,
        })
        if (!res?.ok) {
          append('err', res?.error || 'Failed')
        } else {
          if (res.stdout) append('out', res.stdout)
          if (res.stderr) append('err', res.stderr)
          if (res.code !== 0 && res.code != null && !res.stderr && !res.stdout) {
            append('err', `[exit ${res.code}]`)
          }
        }
      } catch (e) {
        append('err', e.message || String(e))
      } finally {
        setBusy(false)
      }
    },
    [append, context, dryRun, exec, input, kubeconfig, namespace],
  )

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      runLine()
    }
  }

  const copyPreview = async () => {
    const preview = buildPreviewLine(context, namespace, input)
    try {
      await navigator.clipboard.writeText(preview)
      showToast?.('Command copied')
    } catch {
      showToast?.('Could not copy', true)
    }
  }

  const clearOut = () => setLines([])

  return (
    <div className="cluster-terminal">
      <div className="cluster-terminal__head">
        <span className="cluster-terminal__title">Cluster shell</span>
        <span className="cluster-terminal__hint">kubectl on your machine · context / namespace injected from above</span>
      </div>
      {!exec && (
        <p className="cluster-terminal__warn">
          Live exec is available in the desktop app (Electron). In the browser build you can still copy the exact command line.
        </p>
      )}
      <div className="cluster-terminal__quick">
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            className="btn btn-ghost btn--sm"
            disabled={busy}
            onClick={() => {
              setInput(q.cmd)
              runLine(q.cmd)
            }}
          >
            {q.label}
          </button>
        ))}
      </div>
      <label className="cluster-terminal__dry">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        <span>Dry-run (client) + YAML</span>
      </label>
      <div ref={scrollRef} className="cluster-terminal__scroll mono-block" tabIndex={0}>
        {lines.length === 0 && <div className="cluster-terminal__placeholder">Output appears here. Enter a kubectl subcommand (without typing “kubectl”).</div>}
        {lines.map((l, i) => (
          <div key={i} className={`cluster-terminal__line cluster-terminal__line--${l.type}`}>
            {l.text}
          </div>
        ))}
      </div>
      <div className="cluster-terminal__input-row">
        <span className="cluster-terminal__prompt">$</span>
        <input
          className="cluster-terminal__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="get pods -o wide"
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label="kubectl arguments"
        />
        <button type="button" className="btn btn-primary btn--sm" disabled={busy} onClick={() => runLine()}>
          {busy ? '…' : 'Run'}
        </button>
        <button type="button" className="btn btn-ghost btn--sm" onClick={copyPreview} title="Copy full kubectl command">
          Copy cmd
        </button>
        <button type="button" className="btn btn-ghost btn--sm" onClick={clearOut}>
          Clear
        </button>
      </div>
    </div>
  )
}
