import { useEffect, useState, useRef } from 'react'
import { rest, k8sApi } from '../endpoints.js'
import { Section, Btn } from './atoms.jsx'

export default function ClusterPanel({ toast, pushActivity }) {
  const [kubeconfigPath, setKubeconfigPath] = useState('')
  const [kubeconfigContent, setKubeconfigContent] = useState('')
  const [contexts, setContexts] = useState([])
  const [ctx, setCtx] = useState('')
  const [nsList, setNsList] = useState([])
  const [ns, setNs] = useState('default')
  const [reach, setReach] = useState(null)
  const [pods, setPods] = useState([])
  const [podErr, setPodErr] = useState(null)
  const [forwards, setForwards] = useState([])
  const [podLogs, setPodLogs] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const kcParam = kubeconfigPath.trim() ? { kubeconfig: kubeconfigPath.trim() } : {}
  const ctxParam = ctx.trim() ? { context: ctx.trim() } : {}

  const loadForwards = async () => {
    try {
      const r = await k8sApi.forwards()
      if (r.data?.success) setForwards(r.data.forwards || [])
    } catch { /* ignore */ }
  }

  const refreshContexts = async () => {
    try {
      const r = await k8sApi.contexts(kcParam.kubeconfig)
      if (r.data?.success) {
        setContexts(r.data.contexts || [])
        if (!ctx && r.data.contexts.length) setCtx(r.data.contexts[0])
      }
    } catch { /* offline */ }
  }

  const testConnection = async () => {
    try {
      const r = await k8sApi.namespaces(kcParam.kubeconfig, ctxParam.context)
      if (r.data?.success) {
        setNsList(r.data.namespaces || [])
        setReach(true)
      } else {
        setReach(false)
      }
    } catch { setReach(false) }
  }

  const discoverPods = async () => {
    setBusy(true)
    try {
      const r = await k8sApi.pods(kcParam.kubeconfig, ctxParam.context, ns.trim() || 'default')
      if (r.data?.success) {
        setPods(r.data.pods || [])
        setPodErr(r.data.pods?.length ? null : `No pods in "${ns}"`)
      } else {
        setPods([]); setPodErr(r.data?.message || 'kubectl failed')
      }
    } finally { setBusy(false) }
  }

  const fetchPodLogs = async (pod) => {
    if (podLogs?.pod === pod) return setPodLogs(null)
    try {
      const r = await k8sApi.podLogs(kcParam.kubeconfig, ctxParam.context, ns, pod, 100)
      setPodLogs({ pod, text: r.data?.success ? r.data.logs : (r.data?.message || 'failed') })
    } catch (e) { setPodLogs({ pod, text: String(e) }) }
  }

  const debugPod = async (podName, jdwpPort) => {
    const port = jdwpPort > 0 ? jdwpPort : (Number(document.getElementById('web-jdwp-port')?.value) || 5005)
    setBusy(true)
    try {
      const f = await k8sApi.forward({
        ...(kcParam.kubeconfig ? { kubeconfig: kubeconfigPath.trim() } : {}),
        ...(ctx.trim() ? { context: ctx.trim() } : {}),
        namespace: ns.trim() || 'default', pod: podName, remotePort: port, localPort: 5005,
      })
      if (!f.data?.success && !f.data?.reused) {
        toast(`Forward failed: ${f.data?.message || 'unknown'}`)
        return
      }
      pushActivity(`Tunnel :5005 <- ${ns}/${podName}:${port}`)
      // The parent App listens for this event to run the attach flow.
      window.dispatchEvent(new CustomEvent('jdwp-debug-pod', { detail: { pod: podName, port } }))
    } finally { setBusy(false) }
  }

  const onFilePicked = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const text = await f.text()
      const res = await k8sApi.uploadKubeconfig({ content: text })
      if (res.data?.success) {
        setKubeconfigPath(res.data.path)
        toast('Kubeconfig imported')
      } else toast(res.data?.message || 'Import failed', true)
    } catch (err) { toast('Import failed', true) }
  }

  useEffect(() => { refreshContexts(); testConnection(); loadForwards() }, [])
  useEffect(() => { if (ctx) testConnection() }, [ctx])
  useEffect(() => { const iv = setInterval(loadForwards, 4000); return () => clearInterval(iv) }, [])

  const runningPods = pods.filter((p) => p.running)

  return (
    <div className="stack">
      <Section title="Cluster" right={
        reach !== null && (
          <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: reach ? 'var(--ok)' : '#f85149' }}>
            ● {reach ? 'connected' : 'unreachable'}
          </span>
        )
      }>
        <label>Context</label>
        <div className="row">
          <select value={ctx} onChange={(e) => setCtx(e.target.value)} disabled={!contexts.length}>
            {!contexts.length && <option value="">no contexts found</option>}
            {contexts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Btn onClick={refreshContexts}>↻</Btn>
        </div>

        <label>Namespace</label>
        <div className="row">
          <input
            list="web-ns-list"
            value={ns}
            onChange={(e) => setNs(e.target.value)}
            placeholder="default"
          />
          <datalist id="web-ns-list">{nsList.map((n) => <option key={n} value={n} />)}</datalist>
          <Btn onClick={testConnection}>Test</Btn>
        </div>

        <label>Kubeconfig</label>
        <div className="row">
          <input
            value={kubeconfigPath}
            onChange={(e) => setKubeconfigPath(e.target.value)}
            placeholder="default (~/.kube/config)"
          />
          <Btn
            title="Import a company-provided kubeconfig"
            onClick={() => fileRef.current?.click()}
          >
            Import…
          </Btn>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,.json,.txt,.conf,.config"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) f.text().then(setKubeconfigPath)
            }}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: -4 }}>
          Paste or pick a file — its content is saved server-side and used by every cluster call.
        </div>
      </Section>

      <Section title={`Attach to any pod${runningPods.length ? ` (${runningPods.length} running)` : ''}`}>
        <div className="toolbar">
          <Btn kind="primary" onClick={discoverPods} disabled={busy}>Discover pods</Btn>
        </div>
        {podErr && <div className="hint err">{podErr}</div>}
        {runningPods.map((p) => (
          <div key={p.name} className="list-row">
            <span className="dot ok" />
            <span className="grow mono">{p.name}</span>
            <button className="btn btn--sm btn-ghost" onClick={() => fetchPodLogs(p.name)}>logs</button>
            <button className="btn btn--sm btn-primary" disabled={busy} onClick={() => debugPod(p.name)}>
              Debug :{document.getElementById('web-jdwp-port')?.value || 5005}
            </button>
          </div>
        ))}
        {!runningPods.length && pods.length === 0 && !podErr && (
          <div className="hint">Discover pods to see them here.</div>
        )}

        <label style={{ marginTop: 10 }}>JDWP port in pod</label>
        <input id="web-jdwp-port" defaultValue="5005" className="w80 mono" />

        {forwards.length > 0 && (
          <>
            <label style={{ marginTop: 10 }}>Active tunnels</label>
            {forwards.map((f) => (
              <div key={f.localPort} className="list-row mono" style={{ fontSize: 11 }}>
                <span className="dot ok" />
                <span className="grow">localhost:{f.localPort} ← {f.namespace}/{f.pod}:{f.remotePort}</span>
                <button className="btn btn--sm btn-ghost" onClick={async () => {
                  await k8sApi.stopForward(f.localPort); loadForwards()
                }}>stop</button>
              </div>
            ))}
          </>
        )}
        {podLogs && (
          <pre className="code-block small">{`--- ${podLogs.pod} ---\n${podLogs.text}`}</pre>
        )}
      </Section>
    </div>
  )
}
