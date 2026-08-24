import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const API = localStorage.getItem('jdwpApiBase') || ''
const tok = () => sessionStorage.getItem('jdwp-token') || ''

function req(method, path, body) {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok() ? { 'X-Debug-Token': tok() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }))
}

const NAV = [
  { id: 'session', label: 'Session', icon: '⚡' },
  { id: 'breakpoints', label: 'Breakpoints', icon: '⏸' },
  { id: 'threads', label: 'Threads', icon: '🧵' },
  { id: 'logs', label: 'Live Logs', icon: '📜' },
  { id: 'timelens', label: 'TimeLens', icon: '⏱' },
  { id: 'cluster', label: 'Cluster', icon: '☸' },
]

export default function App() {
  /* ---- connection ---- */
  const [connected, setConnected] = useState(false)
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('5005')
  const [vmInfo, setVmInfo] = useState('')
  const [toastMsg, setToastMsg] = useState(null)

  const toast = useCallback((text, isErr) => {
    setToastMsg({ text, err: !!isErr })
    setTimeout(() => setToastMsg(null), 3500)
  }, [])

  /* ---- threads ---- */
  const [threads, setThreads] = useState([])
  const [selectedThread, setSelectedThread] = useState(null)
  const [frames, setFrames] = useState([])
  const [vars, setVars] = useState({})
  const [evalExpr, setEvalExpr] = useState('a + 1')
  const [evalOut, setEvalOut] = useState(null)

  /* ---- breakpoints ---- */
  const [bps, setBps] = useState([])
  const [bpMuted, setBpMuted] = useState(false)
  const [hitStats, setHitStats] = useState({})
  const hitSeenRef = useRef({})

  /* ---- logs ---- */
  const [logs, setLogs] = useState([])

  /* ---- cluster ---- */
  const [kubeconfigPath, setKubeconfigPath] = useState(sessionStorage.getItem('jdwp-kc') || '')
  const [ctxList, setCtxList] = useState([])
  const [ctx, setCtx] = useState('')
  const [nsList, setNsList] = useState([])
  const [ns, setNs] = useState('default')
  const [reach, setReach] = useState(null)
  const [pods, setPods] = useState([])
  const [podLogs, setPodLogs] = useState(null)
  const [forwards, setForwards] = useState([])

  /* ---- time lens ---- */
  const [lensLocs, setLensLocs] = useState('')
  const [lensSteps, setLensSteps] = useState([])
  const [lensRec, setLensRec] = useState(false)
  const lensSessionRef = useRef(`flight-${Date.now().toString(36)}`)

  /* ---- misc ---- */
  const [nav, setNav] = useState('session')
  const [busy, setBusy] = useState(false)
  const [apiToken, setApiTokenState] = useState(sessionStorage.getItem('jdwp-token') || '')

  const req = useCallback((method, path, body) => req2(method, path, body), [])
  function req2(method, path, body) {
    return req0(method, path, body)
  }
  function req0(method, path, body) { return reqInner(method, path, body) }
  function reqInner(method, path, body) { return doReq(method, path, body) }
  function doReq(method, path, body) { return fetchReq(method, path, body) }
  function fetchReq(method, path, body) { return httpReq(method, path, body) }
  function httpReq(method, path, body) {
    return fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(tok() ? { 'X-Debug-Token': tok() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json().catch(() => ({})))
  }
  const GET = (p) => httpReq('GET', p)
  const POST = (p, b) => httpReq('POST', p, b)
  const DEL = (p) => httpReq('DELETE', p)

  /* ---- connect/disconnect ---- */
  const doConnect = async (h = host, p = port) => {
    setBusy(true)
    try {
      const r = await POST('/connect?host=' + encodeURIComponent(h) + '&port=' + encodeURIComponent(p))
      if (r.success) {
        setConnected(true); toast('Attached to JVM'); refreshThreads()
      } else { toast(r.message || 'Attach failed', true); }
    } catch (e) { toast(String(e), true) }
    setBusy(false)
  }

  const doDisconnect = async () => {
    await POST('/disconnect')
    setConnected(false); setThreads([]); setSelectedThread(null); setFrames([]); setVars({})
    toast('Detached')
  }

  const refreshThreads = async () => {
    try { const t = await GET('/threads'); if (t.threads) setThreads(t.threads) } catch {}
  }

  /* ---- breakpoints ---- */
  const refreshBps = async () => {
    try { const r = await GET('/breakpoints'); if (r.breakpoints) setBps(r.breakpoints) } catch {}
  }

  const addAdvancedBp = async (payload) => {
    const r = await POST('/breakpoints/advanced', payload)
    if (!r.success && r.message) { toast(r.message, true); return null }
    await refreshBps(); return r
  }

  const removeBp = async (id) => { await DEL(`/breakpoints/${encodeURIComponent(id)}`); await refreshBps() }
  const toggleBp = async (id, cur) => { await POST('/breakpoints/toggle', { id, enabled: !!cur }); await refreshBps() }
  const removeAllBps = async () => { await DEL('/breakpoints'); await refreshBps() }
  const muteAll = async () => { const r = await POST('/breakpoints/mute', null); setBpMuted(!!r.muted); toast(bpMuted ? 'Unmuted' : 'Muted') }

  /* ---- thread ops ---- */
  const resumeThread = async (tn) => { await POST(`/threads/${encodeURIComponent(tn)}/resume`); await refreshThreads() }
  const continueVm = async () => { await POST('/continue'); await refreshThreads() }
  const stepOp = async (op) => {
    if (!selectedThread) return
    await POST(`/threads/${encodeURIComponent(selectedThread)}/step-${op}`)
    setTimeout(async () => {
      const f = await GET(`/threads/${encodeURIComponent(selectedThread)}/frames`)
      if (f.frames?.length) setFrames(f.frames)
    }, 1200)
  }

  const loadFramesAndVars = async (tn) => {
    setSelectedThread(tn)
    try {
      const f = await GET(`/threads/${encodeURIComponent(tn)}/frames`)
      setFrames(f.frames || [])
      const v = await GET(`/threads/${encodeURIComponent(tn)}/variables-enhanced`)
      setVars(v.variables ?? v)
    } catch { setFrames([]); setVars({}) }
  }

  const runEvaluate = async () => {
    if (!selectedThread || !evalExpr.trim()) return
    try {
      const r = await POST(`/threads/${encodeURIComponent(selectedThread)}/evaluate`, null)
      // evaluate uses query param; fall back:
      if (!r || Object.keys(r).length === 0) throw new Error('empty')
    } catch {}
    try {
      const res = await fetch(`${API}/threads/${encodeURIComponent(selectedThread)}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok() ? { 'X-Debug-Token': tok() } : {}) },
      })
      const j = await res.json()
      setEvalOut(j.result ?? j.message ?? JSON.stringify(j))
    } catch (e) { setEvalOut('Error: ' + e.message) }
  }

  const dropFrame = async () => {
    if (!selectedThread) return
    await POST(`/threads/${encodeURIComponent(selectedThread)}/reset-frame`)
    await loadFramesAndVars(selectedThread)
  }

  /* ---- live logs SSE ---- */
  useEffect(() => {
    if (!connected) return
    const src = new EventSource(`${API}/logs/stream${tok() ? `?token=${tok()}` : ''}`)
    src.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        setLogs((prev) => [...prev.slice(-299), d])
      } catch {}
    }
    src.onerror = () => src.close()
    return () => src.close()
  }, [connected])

  /* ---- cluster ---- */
  const loadContexts = async () => {
    try {
      const r = await GET('/k8s/contexts' + (kubeconfigPath ? `?kubeconfig=${encodeURIComponent(kubeconfigPath)}` : ''))
      setCtxList(r.contexts || [])
      if (r.contexts?.length && !ctx) setCtx(r.contexts[0])
      setReach(true)
    } catch { setCtxList([]); setReach(false) }
  }

  const loadNamespaces = async () => {
    try {
      const r = await GET(`/k8s/namespaces${ctx ? `?context=${encodeURIComponent(ctx)}&kubeconfig=${encodeURIComponent(kubeconfigPath)}` : ''}`)
      setNsList((r.namespaces || []).map((x) => x.replace(/^namespace\//, '')))
    } catch { setNsList([]) }
  }

  const loadPods = async () => {
    try {
      const r = await GET(`/k8s/pods?namespace=${encodeURIComponent(ns)}&context=${encodeURIComponent(ctx)}`)
      setPods(r.pods || [])
    } catch { setPods([]) }
  }

  const loadForwards = async () => {
    try { const r = await GET('/k8s/forwards'); setForwards(r.forwards || []) } catch {}
  }

  const attachToPod = async (podName, jdwpPort) => {
    setBusy(true)
    try {
      if (connected) await doDisconnect()
      const fwd = await POST('/k8s/forward', {
        context: ctx, namespace: ns, pod: podName,
        remotePort: jdwpPort || 5005, localPort: 5005,
        kubeconfig: kubeconfigPath || undefined,
      })
      if (!fwd.success && !fwd.reused) { toast(fwd.message || 'forward failed', true); return }
      await new Promise((r) => setTimeout(r, 1500))
      const c = await POST(`/connect?host=localhost&port=5005`)
      if (c.success) {
        setConnected(true); toast(`Attached to ${podName} through tunnel`)
        await refreshThreads()
      } else toast('JDWP attach failed after forward', true)
    } finally { setBusy(false) }
  }

  const stopForward = async (lp) => { await DEL(`/k8s/forward/${lp}`); await loadForwards() }

  const fetchPodLogsWeb = async (podName) => {
    if (podLogs?.pod === podName) return setPodLogs(null)
    try {
      const r = await GET(`/k8s/logs?namespace=${encodeURIComponent(ns)}&pod=${encodeURIComponent(podName)}&tail=100&context=${encodeURIComponent(ctx)}`)
      setPodLogs({ pod: podName, text: r.logs || '(empty)' })
    } catch { setPodLogs({ pod: podName, text: 'failed to fetch' }) }
  }

  useEffect(() => {
    if (nav !== 'cluster') return
    loadContexts()
    loadForwards()
  }, [nav])

  useEffect(() => { if (nav === 'cluster' && ctx) loadNamespaces() }, [nav, ctx])

  /* ---- TimeLens ---- */
  const lensStart = async () => {
    const locs = lensLocs.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!locs.length) { toast('Add at least one Class:line', true); return }
    setBusy(true)
    try {
      const r = await POST('/recorder/start', { sessionKey: lensSessionRef.current, locations: locs })
      if (r.installed != null) { setLensRec(true); toast(`Recording on ${r.installed} lines`) }
      else toast(r.message || 'Failed', true)
    } finally { setBusy(false) }
  }

  const lensStop = async () => {
    await POST(`/recorder/${lensSessionRef.current}/stop`)
    setLensRec(false); toast('Recorder stopped')
  }

  const lensRefresh = async () => {
    try { const r = await GET(`/recorder/${lensSessionRef.current}`); setLensSteps(r.steps || []); setLensRec(!!r.recording) } catch {}
  }

  useEffect(() => { if (nav === 'timelens') lensRefresh() }, [nav])

  /* ---- hit notifications ---- */
  useEffect(() => {
    if (!connected) { hitSeenRef.current = {}; return }
    const iv = setInterval(async () => {
      try {
        const h = await GET('/breakpoints/hit-stats')
        for (const [id, count] of Object.entries(h.hits || {})) {
          const before = hitSeenRef.current[id] || 0
          if (count > before) {
            toast(`Breakpoint hit: ${id} (+${count - before})`)
          }
        }
        hitSeenRef.current = { ...h.hits }
      } catch {}
    }, 4000)
    return () => clearInterval(iv)
  }, [connected])

  const hitSeenRef = useRef({})
  const [toastMsg, setToastMsg] = useState(null)
  const toast = useCallback((text, isErr) => {
    setToastMsg({ text, err: !!isErr })
    setTimeout(() => setToastMsg(null), 4000)
  }, [])

  /* ---- render ---- */
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">JD</div>
        {NAV.map((n) => (
          <button key={n.id} className={`rail-btn ${nav === n.id ? 'active' : ''}`} onClick={() => setNav(n.id)}>
            <span className="rail-icon">{n.icon}</span>
            <span className="rail-label">{n.label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <Btn kind="danger" onClick={async () => {
          if (!window.confirm('Resume all threads, remove all BPs and detach?')) return
          const p = await POST('/panic')
          toast(`Panic: resumed ${p.threadsResumed}, removed ${p.breakpointsRemoved}, detached=${p.detached}`)
          setConnected(false); setBps([]); await refreshThreads()
        }} disabled={!connected}>PANIC</Btn>
      </aside>

      <div className="main">
        <header className="topbar">
          <Pill ok={connected} text={connected ? `● ${host}:${port}` : '○ not attached'} />
          <Pill ok={bpMuted} text={bpMuted ? 'muted' : 'active'} />
          <span className="spacer" />
          <input
            type="password" placeholder="API token" value={apiToken}
            onChange={(e) => { setApiTokenState(e.target.value); sessionStorage.setItem('jdwp-token', e.target.value) }}
            className="token-input"
          />
        </header>

        {/* ---- TOASTS ---- */}
        {toastMsg && (
          <div className={`toast ${toastMsg.err ? 'toast--err' : ''}`}>{toastMsg.text}</div>
        )}

        <main className="content">
          {/* ======== SESSION ======== */}
          {nav === 'session' && (
            <>
              <Card title="Connect to target VM">
                <div className="grid2">
                  <Field label="Host"><input className="mono" value={host} onChange={(e) => setHost(e.target.value)} /></Field>
                  <Field label="JDWP port"><input className="mono" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
                </div>
                <Btn kind="primary" disabled={busy || connected} onClick={() => doConnect()}>
                  {connected ? 'Attached ✓' : 'Attach'}
                </Btn>
                <Btn onClick={doDisconnect} disabled={!connected}>Detach</Btn>
                {connected && vmInfo && <pre className="hint mono">{vmInfo}</pre>}
              </Card>

              <Card title="Breakpoints">
                <div className="toolbar">
                  <Btn onClick={refreshBps} disabled={!connected}>Refresh</Btn>
                  <Btn kind="danger" onClick={removeAllBps} disabled={!connected || !bps.length}>Remove all</Btn>
                  <Btn onClick={muteAll} disabled={!connected}>{bpMuted ? 'Unmute all' : 'Mute all'}</Btn>
                  <label className="btn btn--ghost" style={{ cursor: 'pointer' }}>
                    Import
                    <input type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => {
                      const f = e.target.files?.[0]; e.target.value = ''; if (!f) return
                      f.text().then(async (txt) => {
                        let list; try { list = JSON.parse(txt) } catch { return toast('Invalid JSON', true) }
                        let okCount = 0
                        for (const bp of Array.isArray(list) ? list : []) {
                          const idx = String(bp.id || bp.location || '').lastIndexOf(':')
                          if (idx < 0) continue
                          const cn = String(bp.id || bp.location).slice(0, idx)
                          const ln = parseInt(String(bp.id || bp.location).slice(idx + 1))
                          if (!cn || Number.isNaN(ln)) continue
                          try {
                            if (bp.logMessage || bp.condition || bp.minHits != null)
                              await POST('/breakpoints/advanced', { className: cn, lineNumber: ln, logMessage: bp.logMessage || null, condition: bp.condition || null, minHits: bp.minHits ?? null })
                            else await POST('/breakpoints', null, undefined)
                            okCount++
                          } catch {}
                        }
                        await refreshBps()
                        toast(`Imported ${okCount}/${list.length}`)
                      })
                    }} />
                  </label>
                  <Btn onClick={handleExportBps} disabled={!bps.length}>Export</Btn>
                </div>
                {!bps.length ? <Empty>No breakpoints.</Empty> :
                  bps.map((b) => (
                    <div key={b.id} className={`list-row ${b.disabled ? 'dim' : ''}`}>
                      <span className="mono grow">{b.logMessage ? '📝 ' : b.condition ? '❓ ' : '⏸ '}{b.id}</span>
                      <Btn kind="danger" onClick={() => handleRemoveBp(b.id)}>✕</Btn>
                    </div>
                  ))}
              </Card>
            </>
          )}

          {/* ======== BREAKPOINTS ======== */}
          {nav === 'breakpoints' && (
            <>
              <Card title="Add breakpoint">
                <div className="grid2">
                  <Field label="Class">
                    <input className="mono" value={cls} onChange={(e) => setCls(e.target.value)}
                      placeholder="com.example.Foo" />
                  </Field>
                  <Field label="Line"><input className="mono" value={line} onChange={(e) => setLine(e.target.value.replace(/\D/g, ''))} /></Field>
                </div>

                <Field label="Type">
                  <select value={type} onChange={(e) => setType(e.target.value)}>
                    <option value="line">Line (suspend)</option>
                    <option value="logpoint">Logpoint (trace, no pause)</option>
                    <option value="expression">Expression condition</option>
                    <option value="request">Request-ID scoped</option>
                  </select>
                </Field>
                {type === 'logpoint' && (
                  <Field label="Log message ({var} tokens)"><input value={logMsg} onChange={(e) => setLogMsg(e.target.value)} placeholder="hit user={user}" /></Field>
                )}
                {(type === 'expression' || type === 'logpoint') && (
                  <Field label={type === 'logpoint' ? 'Condition (optional)' : 'Condition'}>
                    <input value={cond} onChange={(e) => setCond(e.target.value)} placeholder='a > 10 && status == "ok"' />
                  </Field>
                )}
                {type === 'request' && (
                  <Field label="Request ID"><input value={reqId} onChange={(e) => setReqId(e.target.value)} placeholder="X-Debug-Request-Id" /></Field>
                )}
                {type === 'line' && (
                  <Field label="Break after N hits (optional)">
                    <input value={minHits} onChange={(e) => setMinHits(e.target.value.replace(/\D/g, ''))} placeholder="e.g., 5" />
                  </Field>
                )}
                <Btn kind="primary" onClick={() => addBp({ type, cls, line, logMsg, cond, reqId, minHits })}>
                  {labelFor(type)}
                </Btn>
              </Card>
            </>
          )}

          {/* ======== THREADS ======== */}
          {nav === 'threads' && (
            <>
              <Card title="Threads"
                right={<Btn onClick={refreshThreads} disabled={!connected}>Refresh</Btn>}>
                {!connected ? <Empty>Not attached.</Empty> :
                  threads.map((t) => (
                    <div key={t.name} className={`list-row ${t.suspended ? 'highlighted' : ''}`}>
                      <span>{t.suspended ? '⏸' : '▶'} {t.name}</span>
                      {t.suspended && <Btn onClick={() => { setSelectedThread(t.name); loadFramesAndVars(t.name) }}>inspect</Btn>}
                      {!t.suspended && <Btn kind="ghost" onClick={() => POST(`/threads/${encodeURIComponent(t.name)}/suspend`)}>suspend</Btn>}
                      {t.suspended && <Btn kind="ghost" onClick={() => resumeThread(t.name)}>resume</Btn>}
                    </div>
                  ))}
              </Card>
              {selectedThread && vars && Object.keys(vars).length > 0 && (
                <Card title={`Variables — ${selectedThread}`}>
                  <pre className="code-block small">{JSON.stringify(vars, null, 2).slice(0, 5000)}</pre>
                </Card>
              )}
            </>
          )}

          {/* ======== LIVE LOGS ======== */}
          {nav === 'logs' && (
            <>
              <Card title="Live target logs (SSE)" right={
                <Btn onClick={() => setLogs([])}>Clear</Btn>
              }>
                {!connected && <Empty>Not attached — logs appear when connected.</Empty>}
                <div className="log-viewer">
                  {logs.map((l, i) => (
                    <div key={i} className="log-line">
                      [{new Date(l.timestamp).toLocaleTimeString()}] {l.thread}: {l.message}
                    </div>
                  ))}
                  {!logs.length && <Empty>Waiting for entries…</Empty>}
                </div>
              </Card>
            </>
          )}

          {/* ======== TIMELENS ======== */}
          {nav === 'timelens' && (
            <Card title="TimeLens — request causality recorder">
              <textarea rows={3} value={lensLocs} onChange={(e) => setLensLocs(e.target.value)}
                placeholder={'com.example.Foo:31\ncom.example.Bar:88'} />
              <div className="toolbar">
                <Btn kind="primary" disabled={!connected} onClick={lensStart}>Start recording</Btn>
                <Btn onClick={lensStop}>Stop</Btn>
                <Btn kind="ghost" onClick={lensRefresh}>Refresh</Btn>
              </div>
              {lensSteps.map((s, i) => (
                <div key={`${s.timestamp}-${i}`} className="step">
                  <b>#{i + 1}</b> {s.class}.{s.method}:{s.line}
                  <span style={{ color: '#858585', marginLeft: 8 }}>{s.thread}</span>
                  {s.locals && <pre>{JSON.stringify(s.locals, null, 1).slice(0, 2000)}</pre>}
                </div>
              ))}
            </Card>
          )}

          {/* ======== CLUSTER ======== */}
          {nav === 'cluster' && (
            <Card title="Kubernetes cluster">
              <div className="grid2">
                <Field label="Context">
                  <select value={ctx} onChange={(e) => { setCtx(e.target.value); loadNamespaces() }}>
                    <option value="">— select context —</option>
                    {ctxList.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Namespace">
                  <input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="default" />
                </Field>
              </div>
              <div className="toolbar">
                <Btn onClick={() => { loadContexts(); loadNamespaces() }}>Refresh</Btn>
                <Btn kind="primary" disabled={!connected} onClick={discoverPods}>Discover pods</Btn>
              </div>
              {pods.map((pd) => (
                <div key={pd.name} className="list-row">
                  <span>{pd.running ? '🟢' : '⚪'} {pd.name}</span>
                  <Btn kind="primary" onClick={() => attachToPod(pd.name, pd.jdwpPort)}>Attach</Btn>
                </div>
              ))}
            </Card>
          )}

          {/* ======== API CLIENT ======== */}
          {nav === 'api' && (
            <Card title="API client">
              <div className="grid2">
                <Field label="Method">
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {['GET', 'POST', 'PUT', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label="URL">
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/path" />
                </Field>
              </div>
              <Field label="Headers (JSON)"><input value={hdrs} onChange={(e) => setHdrs(e.target.value)} placeholder='{"key": "value"}' /></Field>
              <Field label="Body (JSON)"><input value={bdy} onChange={(e) => setBdy(e.target.value)} placeholder='{"key": "value"}' /></Field>
              <Btn onClick={sendApiCall}>Send</Btn>
              {resp && <pre className="code-block small">{typeof resp === 'object' ? JSON.stringify(resp, null, 2).slice(0, 3000) : resp}</pre>}
            </Card>
          )}
        </main>
      </div>
    </div>
  )
}
