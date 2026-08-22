import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  debugApi,
  getApiBase,
  logsStreamUrl,
  normalizeServerProxyPath,
  serverRequest,
  setApiBaseSafe,
  unwrapServerProbeResponse,
} from './api/debugApi.js'
import VariableTree from './components/VariableTree.jsx'
import { VirtualizedLines } from './components/VirtualizedLines.jsx'
import BreakpointDrawer from './components/BreakpointDrawer.jsx'
import HttpApiDrawer from './components/HttpApiDrawer.jsx'
import RightDrawerColumn from './components/RightDrawerColumn.jsx'
import RightPanelToggles from './components/RightPanelToggles.jsx'
import SourceCodeDrawer from './components/SourceCodeDrawer.jsx'
import ClusterTerminal from './components/ClusterTerminal.jsx'
import SidebarNavIcon from './components/SidebarNavIcon.jsx'
import StudioLogo from './components/StudioLogo.jsx'
import WindowControls from './components/WindowControls.jsx'
import { useActivityLog } from './hooks/useActivityLog.js'

const AdvancedPanel = lazy(() => import('./panels/AdvancedPanel.jsx'))

function useToast() {
  const [msg, setMsg] = useState(null)
  const timer = useRef(0)
  const show = useCallback((text, isError = false) => {
    setMsg({ text, isError })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 5000)
  }, [])
  return [msg, show]
}

async function unwrap(promise, fallback = {}) {
  try {
    const res = await promise
    const data = res?.data
    if (data && data.success === false) {
      return { ok: false, data, error: data.message || 'Request failed' }
    }
    const httpOk = res?.status >= 200 && res?.status < 300
    if (!httpOk) {
      const errMsg =
        (data && typeof data === 'object' && (data.message || data.error)) ||
        (typeof data === 'string' && data.trim().slice(0, 200)) ||
        `HTTP ${res?.status ?? '?'}`
      return { ok: false, data: data ?? {}, error: String(errMsg) }
    }
    return { ok: true, data: data ?? {}, error: null }
  } catch (e) {
    return { ok: false, data: fallback, error: e.message || String(e) }
  }
}

const NAV_SECTIONS = [
  { id: 'debugger', label: 'Debugger', hint: 'Frames, scope, evaluate, console' },
  { id: 'session', label: 'Session', hint: 'Client ping, JDWP attach, threads' },
  { id: 'breakpoints', label: 'Breakpoints', hint: 'Lines & conditions' },
  { id: 'cluster', label: 'Cluster', hint: 'K8s context & shell' },
  { id: 'insights', label: 'Insights', hint: 'Radar & dumps' },
]

function parseHeaderLines(text) {
  const h = {}
  if (!text || !text.trim()) return h
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const k = line.slice(0, idx).trim()
      const v = line.slice(idx + 1).trim()
      if (k) h[k] = v
    }
  }
  return h
}

function loadHttpHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem('jdwp-http-history') || '[]')
    if (!Array.isArray(raw)) return []
    // Never restore persisted bearer tokens — they are memory-only per session.
    for (const h of raw) {
      if (h && typeof h === 'object') delete h.bearer
    }
    return raw
  } catch {
    return []
  }
}

function loadK8sPrefs() {
  try {
    return JSON.parse(localStorage.getItem('jdwp-k8s-cluster') || '{}')
  } catch {
    return {}
  }
}

export default function App() {
  const [apiBaseInput, setApiBaseInput] = useState(() => getApiBase())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connected, setConnected] = useState(false)
  const [clientApiReachable, setClientApiReachable] = useState(false)
  const [targetVmHost, setTargetVmHost] = useState('')
  const [targetVmPort, setTargetVmPort] = useState(0)
  const [vmDescription, setVmDescription] = useState('')
  const [demoAppBaseHint, setDemoAppBaseHint] = useState('http://localhost:8081')
  const [seedPath, setSeedPath] = useState(() => localStorage.getItem('jdwp-seed-path') || '')
  const [jdwpAttachProfile, setJdwpAttachProfile] = useState(
    () => localStorage.getItem('jdwp-attach-profile') || 'local-spring',
  )
  const [host, setHost] = useState(() => localStorage.getItem('jdwp-target-host') || 'localhost')
  const [port, setPort] = useState(() => localStorage.getItem('jdwp-target-port') || '5005')
  const [threads, setThreads] = useState([])
  const [selectedThread, setSelectedThread] = useState(null)
  const [frames, setFrames] = useState([])
  const [frameIndex, setFrameIndex] = useState(0)
  const [varsEnhanced, setVarsEnhanced] = useState(null)
  const [sourceLoc, setSourceLoc] = useState(null)
  const [breakpoints, setBreakpoints] = useState([])
  const [bpClass, setBpClass] = useState('')
  const [bpLine, setBpLine] = useState('')
  const [bpTriggerUrl, setBpTriggerUrl] = useState('')
  const [bpRequestId, setBpRequestId] = useState('')
  const [bpType, setBpType] = useState('line')
  const [bpLogMessage, setBpLogMessage] = useState('')
  const [bpCondition, setBpCondition] = useState('')
  const [excClass, setExcClass] = useState('')
  const [evalExpr, setEvalExpr] = useState('')
  const [evalOut, setEvalOut] = useState('')
  const [logEntries, setLogEntries] = useState([])
  const [logFilterThread, setLogFilterThread] = useState('')
  const [busy, setBusy] = useState(false)
  /** Step / resume / suspend / continue / wait-BP only — never tied to connect, seed, or variables fetch. */
  const [debugCmdBusy, setDebugCmdBusy] = useState(false)
  const [toast, showToast] = useToast()

  /** HTTP drawer only — avoids locking the whole UI (Resume, etc.) while a probe is in flight. */
  const [probeBusy, setProbeBusy] = useState(false)
  const probeAbortRef = useRef(null)
  const [probeMethod, setProbeMethod] = useState('GET')
  const [probePath, setProbePath] = useState('/health')
  const [probeBody, setProbeBody] = useState('')
  const [probeOut, setProbeOut] = useState('')
  const [probeHeadersStr, setProbeHeadersStr] = useState('')
  const [authBearer, setAuthBearer] = useState('')
  const [rightPanels, setRightPanels] = useState(() => {
    try {
      const raw = localStorage.getItem('jdwp-right-panels')
      if (raw) {
        const o = JSON.parse(raw)
        return {
          source: !!o.source,
          bp: !!o.bp,
          http: !!o.http,
        }
      }
      const single = localStorage.getItem('jdwp-right-panel-active')
      if (single === 'source') return { source: true, bp: false, http: false }
      if (single === 'bp') return { source: false, bp: true, http: false }
      if (single === 'http') return { source: false, bp: false, http: true }
    } catch {
      /* default */
    }
    return { source: false, bp: false, http: false }
  })
  const [rightFlexWeights, setRightFlexWeights] = useState(() => {
    try {
      const raw = localStorage.getItem('jdwp-right-flex')
      if (raw) {
        const o = JSON.parse(raw)
        return {
          source: Math.max(0.15, Number(o.source) || 1),
          bp: Math.max(0.15, Number(o.bp) || 1),
          http: Math.max(0.15, Number(o.http) || 1),
        }
      }
    } catch {
      /* default */
    }
    return { source: 1, bp: 1, http: 1 }
  })
  const [rightColumnWidth, setRightColumnWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem('jdwp-right-column-w') || '0', 10)
    if (Number.isFinite(saved) && saved > 0) return Math.min(960, Math.max(320, saved))
    const wHttp = parseInt(localStorage.getItem('jdwp-http-drawer-w') || '420', 10)
    const wBp = parseInt(localStorage.getItem('jdwp-bp-drawer-w') || '380', 10)
    const wSrc = parseInt(localStorage.getItem('jdwp-source-drawer-w') || '480', 10)
    const m = Math.max(
      Number.isFinite(wHttp) ? wHttp : 0,
      Number.isFinite(wBp) ? wBp : 0,
      Number.isFinite(wSrc) ? wSrc : 0,
      420,
    )
    return Math.min(960, Math.max(320, m))
  })
  const [sourceRoot, setSourceRoot] = useState(() => localStorage.getItem('jdwp-source-root') || '')
  const [logDockHeight, setLogDockHeight] = useState(() => {
    const h = parseInt(localStorage.getItem('jdwp-log-dock-px') || '280', 10)
    return Number.isFinite(h) ? Math.min(900, Math.max(120, h)) : 280
  })
  const [varsNextLine, setVarsNextLine] = useState(null)
  const [httpHistory, setHttpHistory] = useState(loadHttpHistory)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('jdwp-sidebar-collapsed') === '1')
  const [jdwpConnecting, setJdwpConnecting] = useState(false)
  const [evalUseFrame, setEvalUseFrame] = useState(true)
  const [bpMuted, setBpMuted] = useState(false)
  const [radar, setRadar] = useState([])
  const [threadDump, setThreadDump] = useState(null)
  const [methodClass, setMethodClass] = useState('')
  const [methodName, setMethodName] = useState('')
  const [methodSig, setMethodSig] = useState('')
  const [watchClass, setWatchClass] = useState('')
  const [watchField, setWatchField] = useState('')
  const [watchRead, setWatchRead] = useState(true)
  const [watchWrite, setWatchWrite] = useState(true)
  const [watchpoints, setWatchpoints] = useState([])
  const [watches, setWatches] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('jdwp-watches') || '[]')
    } catch {
      return []
    }
  })
  const [watchInput, setWatchInput] = useState('')
  const [watchResults, setWatchResults] = useState({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [condClass, setCondClass] = useState('')
  const [condLine, setCondLine] = useState('')
  const [condReqId, setCondReqId] = useState('')
  const [condTrigger, setCondTrigger] = useState('')
  const [requestIdLens, setRequestIdLens] = useState('')
  const [hitStats, setHitStats] = useState({})
  const lastLogTsRef = useRef(0)
  const logEsRef = useRef(null)
  const logSplitRef = useRef(null)
  const { lines: activityLines, push: pushActivity } = useActivityLog()

  const [activeNav, setActiveNav] = useState('debugger')
  const [k8sContext, setK8sContext] = useState(() => loadK8sPrefs().context || '')
  const [k8sNamespace, setK8sNamespace] = useState(() => loadK8sPrefs().namespace || 'default')
  const [k8sKubeconfig, setK8sKubeconfig] = useState(() => loadK8sPrefs().kubeconfig || '')
  const [k8sNotes, setK8sNotes] = useState(() => loadK8sPrefs().notes || '')
  // Live cluster data (not persisted — always re-discovered)
  const [kubeContextList, setKubeContextList] = useState([])
  const [kubeContextError, setKubeContextError] = useState(null)
  const [kindForwardStatus, setKindForwardStatus] = useState(null)

  useEffect(() => {
    localStorage.setItem(
      'jdwp-k8s-cluster',
      JSON.stringify({
        context: k8sContext,
        namespace: k8sNamespace,
        kubeconfig: k8sKubeconfig,
        notes: k8sNotes,
      }),
    )
  }, [k8sContext, k8sNamespace, k8sKubeconfig, k8sNotes])

  // Discover kube contexts from the local kubectl config (read-only).
  const refreshKubeContexts = useCallback(async () => {
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.kubeContexts) return
    const res = await electron.kubeContexts({ kubeconfig: (k8sKubeconfig || '').trim() || undefined })
    if (res?.ok && Array.isArray(res.contexts)) {
      setKubeContextList(res.contexts)
      setKubeContextError(null)
      // Auto-select the current default context if none chosen yet.
      if (!k8sContext && res.contexts.length > 0) {
        setK8sContext(res.contexts[0])
      }
    } else {
      setKubeContextList([])
      setKubeContextError(res?.error || 'kubectl not available')
    }
  }, [k8sKubeconfig, k8sContext])

  useEffect(() => {
    if (activeNav === 'cluster') refreshKubeContexts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, k8sKubeconfig])

  // Poll the port-forward status so the UI shows whether the tunnel is alive.
  useEffect(() => {
    if (activeNav !== 'cluster' && activeNav !== 'debugger') return
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.kindJdwpForwardStatus) return
    let cancelled = false
    const tick = async () => {
      try {
        const s = await electron.kindJdwpForwardStatus()
        if (!cancelled) setKindForwardStatus(s)
      } catch { /* ignore */ }
    }
    tick()
    const iv = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [activeNav])

  useEffect(() => {
    localStorage.setItem('jdwp-right-panels', JSON.stringify(rightPanels))
  }, [rightPanels])

  useEffect(() => {
    localStorage.setItem('jdwp-right-flex', JSON.stringify(rightFlexWeights))
  }, [rightFlexWeights])

  useEffect(() => {
    localStorage.setItem('jdwp-right-column-w', String(rightColumnWidth))
  }, [rightColumnWidth])

  useEffect(() => {
    if (sourceRoot) localStorage.setItem('jdwp-source-root', sourceRoot)
  }, [sourceRoot])

  useEffect(() => {
    localStorage.setItem('jdwp-log-dock-px', String(logDockHeight))
  }, [logDockHeight])

  useEffect(() => {
    localStorage.setItem('jdwp-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  useEffect(() => {
    // Persist history WITHOUT bearer tokens (secrets stay memory-only).
    const safe = httpHistory.slice(0, 24).map((h) => {
      const { bearer, ...rest } = h || {}
      return rest
    })
    localStorage.setItem('jdwp-http-history', JSON.stringify(safe))
  }, [httpHistory])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const def = window.jdwpElectron?.defaultApiBase
      if (typeof def === 'function') {
        try {
          const url = await def()
          if (!cancelled && url && !localStorage.getItem('jdwpApiBase')) {
            await setApiBaseSafe(url)
            setApiBaseInput(url)
          }
        } catch {
          /* ignore */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('jdwp-seed-path', seedPath)
  }, [seedPath])

  useEffect(() => {
    localStorage.setItem('jdwp-target-host', host)
  }, [host])

  useEffect(() => {
    localStorage.setItem('jdwp-target-port', port)
  }, [port])

  useEffect(() => {
    localStorage.setItem('jdwp-attach-profile', jdwpAttachProfile)
  }, [jdwpAttachProfile])

  const applyJdwpPreset = useCallback((profileId) => {
    setJdwpAttachProfile(profileId)
    if (profileId === 'custom') return
    if (profileId === 'local-spring') {
      setHost('localhost')
      setPort('5005')
    } else if (profileId === 'compose-client') {
      setHost('debug-server')
      setPort('5005')
    } else if (profileId === 'k8s-forward') {
      setHost('localhost')
      setPort('5005')
    } else if (profileId === 'k8s-kind-a') {
      setHost('localhost')
      setPort('5005')
    } else if (profileId === 'k8s-kind-b') {
      setHost('localhost')
      setPort('5006')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { ok, data } = await unwrap(debugApi.clientConfig())
      if (cancelled || !ok) return
      setDemoAppBaseHint(data.demoAppBaseUrl || 'http://localhost:8081')
      if (!localStorage.getItem('jdwp-seed-defaults-v1')) {
        if (data.defaultTargetHost) setHost(data.defaultTargetHost)
        if (data.defaultTargetPort != null) setPort(String(data.defaultTargetPort))
        localStorage.setItem('jdwp-seed-defaults-v1', '1')
        if (data.defaultTargetHost === 'debug-server') {
          setJdwpAttachProfile('compose-client')
        } else {
          setJdwpAttachProfile('local-spring')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const { ok, data } = await unwrap(debugApi.status())
    if (!ok) {
      setClientApiReachable(false)
      setConnected(false)
      setTargetVmHost('')
      setTargetVmPort(0)
      setVmDescription('')
      return
    }
    setClientApiReachable(true)
    const vmOn = !!data.targetVmConnected || !!data.connected
    setConnected(vmOn)
    setTargetVmHost(data.targetHost || '')
    setTargetVmPort(typeof data.targetPort === 'number' ? data.targetPort : parseInt(String(data.targetPort || '0'), 10) || 0)
    setVmDescription(data.vmDescription || '')
  }, [])

  const refreshThreads = useCallback(async () => {
    const { ok, data, error } = await unwrap(debugApi.threads())
    if (!ok) {
      showToast(error || 'Threads failed', true)
      return
    }
    setThreads(data.threads || [])
  }, [showToast])

  const refreshFrames = useCallback(
    async (threadName) => {
      if (!threadName) {
        setFrames([])
        return
      }
      const { ok, data, error } = await unwrap(debugApi.frames(threadName))
      if (!ok) {
        showToast(error || 'Frames failed', true)
        setFrames([])
        return
      }
      setFrames(data.frames || [])
      setFrameIndex(0)
    },
    [showToast],
  )

  const refreshVarsAndLoc = useCallback(
    async (threadName) => {
      if (!threadName) {
        setVarsEnhanced(null)
        setSourceLoc(null)
        return
      }
      const [v, s] = await Promise.all([
        unwrap(debugApi.variablesEnhanced(threadName, true)),
        unwrap(debugApi.sourceLocation(threadName)),
      ])
      if (v.ok) setVarsEnhanced(v.data.variables || null)
      else setVarsEnhanced(null)
      if (s.ok) setSourceLoc(s.data?.location ?? s.data ?? null)
      else setSourceLoc(null)
    },
    [],
  )

  const refreshBreakpoints = useCallback(async () => {
    const { ok, data } = await unwrap(debugApi.listBreakpoints())
    if (ok) setBreakpoints(data.breakpoints || [])
  }, [])

  const toggleBreakpointAtSource = useCallback(
    async (className, lineNumber) => {
      if (!connected) {
        showToast('Connect to the VM first', true)
        return
      }
      if (!className || !Number.isFinite(lineNumber)) return
      const key = `${className}:${lineNumber}`
      const existing = breakpoints.find((b) => b.location === key || b.id === key)
      setDebugCmdBusy(true)
      try {
        if (existing) {
          const { ok, data } = await unwrap(debugApi.removeBreakpoint(existing.id))
          if (!ok || data?.success === false) showToast(data?.message || 'Remove breakpoint failed', true)
        } else {
          const { ok, data } = await unwrap(debugApi.setBreakpoint(className, lineNumber))
          if (!ok || data?.success === false) showToast(data?.message || 'Breakpoint failed', true)
        }
        await refreshBreakpoints()
      } finally {
        setDebugCmdBusy(false)
      }
    },
    [connected, breakpoints, refreshBreakpoints, showToast],
  )

  const evaluateFromSource = useCallback(
    async (expr) => {
      const t = String(expr || '').trim()
      if (!t) return
      setActiveNav('debugger')
      setEvalExpr(t)
      if (!selectedThread) {
        showToast('Select a thread in Debug, then Evaluate', true)
        return
      }
      setDebugCmdBusy(true)
      try {
        const fi = evalUseFrame ? frameIndex : undefined
        const { ok, data, error } = await unwrap(debugApi.evaluate(selectedThread, t, fi))
        if (ok && data.result != null) setEvalOut(String(data.result))
        else if (data?.message) setEvalOut(data.message)
        else setEvalOut(error || 'Evaluate failed')
        showToast(ok ? 'Result in Evaluate panel' : error || data?.message || 'Failed', !ok)
      } finally {
        setDebugCmdBusy(false)
      }
    },
    [selectedThread, evalUseFrame, frameIndex, showToast],
  )

  const formatLogLine = useCallback((e) => {
    const loc =
      e.className || e.lineNumber != null
        ? `  (${e.className || '?'}${e.lineNumber != null ? `:${e.lineNumber}` : ''})`
        : ''
    return `[${e.stream || '?'}][${e.thread || ''}] ${e.message || ''}${loc}`
  }, [])

  const filteredLogEntries = useMemo(() => {
    const ft = logFilterThread.trim()
    if (!ft) return logEntries
    return logEntries.filter((e) => (e.thread || '').includes(ft))
  }, [logEntries, logFilterThread])

  const logLines = useMemo(() => filteredLogEntries.map(formatLogLine), [filteredLogEntries, formatLogLine])

  const refreshLogsSimple = useCallback(async () => {
    const { ok, data } = await unwrap(debugApi.logEntries({ limit: 200, filter: true }))
    if (!ok || data?.success === false) {
      if (data?.message) showToast(data.message, true)
      return
    }
    const entries = data.entries || []
    setLogEntries(entries.slice(-400))
    if (entries.length) {
      lastLogTsRef.current = Math.max(...entries.map((e) => e.timestamp), 0)
    }
  }, [showToast])

  /** Merge new log rows with dedupe; keeps history across disconnect (console dock). */
  const mergeLogRows = useCallback((incoming) => {
    if (!incoming?.length) return
    setLogEntries((prev) => {
      const seen = new Set(prev.map((e) => `${e.timestamp}\0${e.thread}\0${e.message}`))
      const out = [...prev]
      for (const e of incoming) {
        const k = `${e.timestamp}\0${e.thread}\0${e.message}`
        if (!seen.has(k)) {
          seen.add(k)
          out.push(e)
        }
      }
      const next = out.slice(-500)
      const maxTs = next.reduce((m, e) => Math.max(m, Number(e.timestamp) || 0), 0)
      if (maxTs) lastLogTsRef.current = Math.max(lastLogTsRef.current, maxTs)
      return next
    })
  }, [])

  useEffect(() => {
    if (!connected) {
      if (logEsRef.current) {
        logEsRef.current.close()
        logEsRef.current = null
      }
      return
    }

    let cancelled = false
    let pollId = 0
    let retryTimer = 0
    let attempt = 0

    const openEventSource = () => {
      if (cancelled) return
      logEsRef.current?.close()
      try {
        const es = new EventSource(logsStreamUrl())
        logEsRef.current = es
        es.onmessage = (ev) => {
          try {
            const row = JSON.parse(ev.data)
            mergeLogRows([row])
            attempt = 0
          } catch {
            /* ignore */
          }
        }
        es.onerror = () => {
          es.close()
          if (logEsRef.current === es) logEsRef.current = null
          if (cancelled) return
          attempt = Math.min(attempt + 1, 8)
          retryTimer = window.setTimeout(openEventSource, Math.min(10000, 500 * 2 ** attempt))
        }
      } catch {
        if (!cancelled) {
          attempt = Math.min(attempt + 1, 8)
          retryTimer = window.setTimeout(openEventSource, Math.min(10000, 500 * 2 ** attempt))
        }
      }
    }

    ;(async () => {
      const { ok, data } = await unwrap(debugApi.logEntries({ limit: 200, filter: true }))
      if (!cancelled && ok && data?.entries?.length) mergeLogRows(data.entries)
    })()

    openEventSource()

    const poll = async () => {
      if (cancelled) return
      const { ok, data } = await unwrap(
        debugApi.logEntries({ after: lastLogTsRef.current, limit: 200, filter: true }),
      )
      if (!ok || !data.entries?.length) return
      mergeLogRows(data.entries)
    }
    pollId = window.setInterval(poll, 1400)

    return () => {
      cancelled = true
      window.clearInterval(pollId)
      window.clearTimeout(retryTimer)
      logEsRef.current?.close()
      logEsRef.current = null
    }
  }, [connected, mergeLogRows])

  useEffect(() => {
    refreshStatus()
    const id = setInterval(refreshStatus, 4000)
    return () => clearInterval(id)
  }, [refreshStatus])

  useEffect(() => {
    if (!connected) return
    refreshThreads()
    refreshBreakpoints()
    const id = setInterval(() => {
      refreshThreads()
    }, 2500)
    return () => clearInterval(id)
  }, [connected, refreshThreads, refreshBreakpoints])

  useEffect(() => {
    if (!selectedThread) return
    refreshFrames(selectedThread)
    refreshVarsAndLoc(selectedThread)
  }, [selectedThread, refreshFrames, refreshVarsAndLoc])

  useEffect(() => {
    setVarsNextLine(null)
  }, [selectedThread])

  const pingDebugClient = async () => {
    setBusy(true)
    let ok
    let error
    try {
      const r = await unwrap(debugApi.ping())
      ok = r.ok
      error = r.error
    } finally {
      setBusy(false)
    }
    if (ok) {
      setClientApiReachable(true)
      showToast('Spring debug client is reachable')
      await refreshStatus()
    } else {
      setClientApiReachable(false)
      showToast(error || 'Cannot reach Spring client — check API base (Settings → API)', true)
    }
  }

  const connect = async () => {
    setBusy(true)
    setJdwpConnecting(true)
    let ok
    let data
    let error
    try {
      const r = await unwrap(debugApi.connect(host, parseInt(port, 10) || 5005))
      ok = r.ok
      data = r.data
      error = r.error
    } finally {
      setBusy(false)
      setJdwpConnecting(false)
    }
    if (ok && data.success !== false) {
      setConnected(true)
      setClientApiReachable(true)
      showToast(data.message || 'Connected')
      pushActivity(`Connected to ${host}:${port}`)
      await refreshLogsSimple()
      await refreshThreads()
      await refreshBreakpoints()
    } else {
      showToast(error || data.message || 'Connect failed', true)
      pushActivity(`Connect failed: ${error || data?.message || 'unknown'}`)
      await refreshStatus()
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setJdwpConnecting(true)
    try {
      await unwrap(debugApi.disconnect())
    } finally {
      setBusy(false)
      setJdwpConnecting(false)
    }
    setConnected(false)
    setTargetVmHost('')
    setTargetVmPort(0)
    setVmDescription('')
    setThreads([])
    setSelectedThread(null)
    setFrames([])
    setVarsEnhanced(null)
    pushActivity('Disconnected from VM')
    showToast('Disconnected')
    await refreshStatus()
  }

  const debugKindPodAuto = useCallback(
    async (instance) => {
      const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
      if (!electron?.kindJdwpForward) {
        showToast('Kind automation needs JDWP Studio (Electron). kubectl must be on PATH; context kind-jdwp-demo.', true)
        return
      }
      setBusy(true)
      try {
        if (connected) {
          await unwrap(debugApi.disconnect())
          setConnected(false)
          setThreads([])
          setSelectedThread(null)
          setFrames([])
          setVarsEnhanced(null)
          await refreshStatus()
        }
        // Honor the Cluster panel settings — context/namespace/kubeconfig apply here too.
        const fr = await electron.kindJdwpForward({
          instance,
          namespace: (k8sNamespace || '').trim() || undefined,
          kubeContext: (k8sContext || '').trim() || undefined,
          kubeconfig: (k8sKubeconfig || '').trim() || undefined,
        })
        if (!fr?.ok) {
          showToast(fr?.message || 'kubectl port-forward failed', true)
          return
        }
        const jdwpPort = fr.localPort || (instance === 'b' ? 5006 : 5005)
        const base = instance === 'a' ? 'http://localhost:9081' : 'http://localhost:9082'
        const proxy = await unwrap(debugApi.setDemoAppBase(base))
        if (!proxy.ok || proxy.data?.success === false) {
          showToast(
            proxy.error || proxy.data?.message || 'Update Spring client (demo-app-base API missing)',
            true,
          )
          return
        }
        setDemoAppBaseHint(proxy.data.baseUrl || base)
        setPort(String(jdwpPort))
        setJdwpAttachProfile(instance === 'a' ? 'k8s-kind-a' : 'k8s-kind-b')
        const jdwpHost = (host || '').trim() || 'localhost'
        await new Promise((r) => setTimeout(r, 1500))
        setJdwpConnecting(true)
        const conn = await unwrap(debugApi.connect(jdwpHost, jdwpPort))
        setJdwpConnecting(false)
        if (conn.ok && conn.data.success !== false) {
          setConnected(true)
          setClientApiReachable(true)
          showToast(`Debugging Kind pod ${instance.toUpperCase()} (${fr.podName}) — JDWP ${jdwpHost}:${jdwpPort}`)
          pushActivity(`Kind ${instance}: ${fr.podName} → JDWP ${jdwpHost}:${jdwpPort}`)
          await refreshLogsSimple()
          await refreshThreads()
          await refreshBreakpoints()
          await refreshStatus()
        } else {
          showToast(conn.error || conn.data?.message || 'JDWP attach failed', true)
        }
      } finally {
        setBusy(false)
      }
    },
    [connected, host, k8sNamespace, k8sContext, k8sKubeconfig, refreshStatus, refreshThreads, refreshBreakpoints, refreshLogsSimple, showToast, pushActivity],
  )

  const stopKindJdwpForward = useCallback(async () => {
    if (window.jdwpElectron?.kindJdwpForwardStop) {
      await window.jdwpElectron.kindJdwpForwardStop()
      showToast('Kind JDWP port-forward stopped')
    }
  }, [showToast])

  // ---- Generic pod attach: discover pods, forward JDWP from ANY of them ----

  const [podList, setPodList] = useState([])
  const [podDiscoveryError, setPodDiscoveryError] = useState(null)
  const [selectedPod, setSelectedPod] = useState('')
  const [podJdwpPort, setPodJdwpPort] = useState('5005')

  const discoverPods = useCallback(async () => {
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.clusterExec) {
      showToast('Pod discovery needs JDWP Studio (Electron)', true)
      return
    }
    const ns = (k8sNamespace || 'default').trim()
    const res = await electron.clusterExec({
      context: k8sContext,
      namespace: ns,
      kubeconfig: k8sKubeconfig,
      commandLine: `get pods -o custom-columns=NAME:.metadata.name,PHASE:.status.phase --no-headers`,
    })
    if (!res?.ok) {
      setPodList([])
      setPodDiscoveryError(res?.error || 'kubectl failed')
      return
    }
    const rows = String(res.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(/\s+/)
        return { name: parts[0], phase: parts[1] || '?', running: parts[1] === 'Running' }
      })
    setPodList(rows)
    setPodDiscoveryError(rows.length === 0 ? `No pods in namespace "${ns}"` : null)
    if (rows.length > 0 && !rows.some((p) => p.name === selectedPod)) {
      // Preselect the first running pod, else the first pod.
      const firstRunning = rows.find((p) => p.running) || rows[0]
      setSelectedPod(firstRunning.name)
    }
  }, [k8sNamespace, k8sContext, k8sKubeconfig, selectedPod, showToast])

  useEffect(() => {
    if (activeNav === 'cluster') discoverPods()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav])

  const debugSelectedPod = useCallback(async (podArg) => {
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.podJdwpForward) {
      showToast('Generic pod attach needs JDWP Studio (Electron)', true)
      return
    }
    const pod = String(podArg || selectedPod || '').trim()
    if (!pod) {
      showToast('Select a pod first', true)
      return
    }
    const remotePort = Number(podJdwpPort) || 5005
    setBusy(true)
    try {
      if (connected) {
        await unwrap(debugApi.disconnect())
        setConnected(false)
        setThreads([])
        setSelectedThread(null)
        setFrames([])
        setVarsEnhanced(null)
        await refreshStatus()
      }
      const fr = await electron.podJdwpForward({
        namespace: (k8sNamespace || 'default').trim(),
        pod,
        remotePort,
        localPort: 5005,
        kubeContext: (k8sContext || '').trim() || undefined,
        kubeconfig: (k8sKubeconfig || '').trim() || undefined,
      })
      if (!fr?.ok) {
        showToast(fr?.message || 'Port-forward failed', true)
        return
      }
      setPort('5005')
      setJdwpAttachProfile('custom')
      const jdwpHost = (host || '').trim() || 'localhost'
      await new Promise((r) => setTimeout(r, 800))
      setJdwpConnecting(true)
      const conn = await unwrap(debugApi.connect(jdwpHost, 5005))
      setJdwpConnecting(false)
      if (conn.ok && conn.data.success !== false) {
        setConnected(true)
        setClientApiReachable(true)
        showToast(`Attached to ${pod} — JDWP localhost:5005 ← ${fr.namespace}/${pod}:${remotePort}`)
        pushActivity(`Pod ${fr.namespace}/${pod}:${remotePort} → localhost:5005`)
        await refreshLogsSimple()
        await refreshThreads()
        await refreshBreakpoints()
        await refreshStatus()
      } else {
        showToast(conn.error || conn.data?.message || 'JDWP attach failed', true)
      }
    } finally {
      setBusy(false)
    }
  }, [
    selectedPod, podJdwpPort, connected, host, k8sNamespace, k8sContext, k8sKubeconfig,
    refreshStatus, refreshThreads, refreshBreakpoints, refreshLogsSimple, showToast, pushActivity,
  ])

  // Live status for generic forwards.
  const [podForwards, setPodForwards] = useState([])
  useEffect(() => {
    if (activeNav !== 'cluster') return
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.podJdwpForwardStatus) return
    let cancelled = false
    const tick = async () => {
      try {
        const s = await electron.podJdwpForwardStatus()
        if (!cancelled) setPodForwards(s?.forwards || [])
      } catch { /* ignore */ }
    }
    tick()
    const iv = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [activeNav])

  // ---- Services: GitHub / Bitbucket repos ↔ running pods -------------------
  // Token is memory-only on purpose; provider + owner are persisted.

  const [gitProvider, setGitProvider] = useState(() => localStorage.getItem('jdwp-git-provider') || 'github')
  const [gitOwner, setGitOwner] = useState(() => localStorage.getItem('jdwp-git-owner') || '')
  const [gitToken, setGitToken] = useState('')
  const [gitRepos, setGitRepos] = useState([])
  const [gitError, setGitError] = useState(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitSearch, setGitSearch] = useState('')
  const [selectedService, setSelectedService] = useState('')

  useEffect(() => {
    localStorage.setItem('jdwp-git-provider', gitProvider)
    localStorage.setItem('jdwp-git-owner', gitOwner)
  }, [gitProvider, gitOwner])

  const loadServices = useCallback(async () => {
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.gitListRepos) {
      showToast('Services discovery needs JDWP Studio (Electron)', true)
      return
    }
    if (!(gitToken || '').trim()) {
      showToast('Paste an access token first (read-only scope is enough). It stays in memory only.', true)
      return
    }
    setGitLoading(true)
    try {
      const res = await electron.gitListRepos({
        provider: gitProvider,
        token: gitToken.trim(),
        // GitHub: empty owner = everything the token can reach (orgs included).
        // Bitbucket requires a workspace, so only pass it there.
        owner: gitProvider === 'bitbucket' ? gitOwner.trim() : '',
      })
      if (res?.ok) {
        setGitRepos(res.repos)
        setGitError(res.repos.length === 0 ? 'No repositories found for this token/scope' : null)
      } else {
        setGitRepos([])
        setGitError(res?.error || 'Failed to list repositories')
      }
    } finally {
      setGitLoading(false)
    }
  }, [gitProvider, gitToken, gitOwner, showToast])

  // Pods whose name contains the selected service name (repo name convention).
  const servicePods = (() => {
    if (!selectedService) return []
    const needle = selectedService.toLowerCase()
    return podList.filter((p) => p.name.toLowerCase().includes(needle))
  })()

  const debugServicePod = useCallback(
    async (podName) => {
      await debugSelectedPod(podName)
    },
    [debugSelectedPod],
  )

  // ---- Branch discovery for the selected service ---------------------------
  const [serviceBranches, setServiceBranches] = useState([]) // {name,isDefault,protected}
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState(null)
  const [selectedBranch, setSelectedBranch] = useState('')
  const [cloningService, setCloningService] = useState(false)
  // Full record of the selected repo (cloneUrl etc.) kept in memory.
  const selectedRepoRecord = gitRepos.find((r) => r.name === selectedService) || null

  const selectService = useCallback(async (repoName) => {
    if (!repoName) return
    setSelectedService(repoName)
    setServiceBranches([])
    setBranchesError(null)
    setSelectedBranch('')
    discoverPods()
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.gitListBranches) return
    setBranchesLoading(true)
    try {
      const res = await electron.gitListBranches({
        provider: gitProvider,
        token: gitToken.trim(),
        owner: gitOwner.trim(),
        repo: repoName,
      })
      if (res?.ok) {
        setServiceBranches(res.branches)
        const def = res.branches.find((b) => b.isDefault) || res.branches[0]
        if (def) setSelectedBranch(def.name)
      } else {
        setBranchesError(res?.error || 'Failed to list branches')
      }
    } finally {
      setBranchesLoading(false)
    }
  }, [gitProvider, gitToken, gitOwner, discoverPods])

  const cloneSelectedService = useCallback(async () => {
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.gitCloneRepo || !selectedRepoRecord) return
    setCloningService(true)
    try {
      const res = await electron.gitCloneRepo({
        url: selectedRepoRecord.cloneUrl,
        branch: selectedBranch.trim() || undefined,
      })
      if (res?.ok) {
        showToast(`Cloned ${selectedRepoRecord.name} (${selectedBranch}) → ${res.path}`)
        pushActivity(`Cloned ${selectedRepoRecord.name}@${selectedBranch}`)
        if (setSourceRoot && res.path) {
          setSourceRoot(res.path)
          setActiveNav('source')
        }
      } else {
        showToast(res?.error || 'Clone failed', true)
      }
    } finally {
      setCloningService(false)
    }
  }, [selectedRepoRecord, selectedBranch, showToast, pushActivity, setSourceRoot])

  // Read-only pod logs via the allow-listed kubectl shell.
  const [podLogs, setPodLogs] = useState(null) // { pod, text }
  const [podLogsLoading, setPodLogsLoading] = useState(false)

  const fetchPodLogs = useCallback(async (podName) => {
    const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
    if (!electron?.clusterExec) return
    if (podLogs?.pod === podName) { setPodLogs(null); return } // toggle off
    setPodLogsLoading(true)
    try {
      const res = await electron.clusterExec({
        context: k8sContext,
        namespace: (k8sNamespace || 'default').trim(),
        kubeconfig: k8sKubeconfig,
        commandLine: `logs ${podName} --tail=100`,
      })
      setPodLogs({
        pod: podName,
        text: res?.ok ? String(res.stdout || '(no output)') : `kubectl failed: ${res?.error || 'unknown'}`,
      })
    } finally {
      setPodLogsLoading(false)
    }
  }, [k8sContext, k8sNamespace, k8sKubeconfig, podLogs])

  const seedBreakpointsFromApi = async () => {
    if (!connected) {
      showToast('Connect JDWP to the target VM first', true)
      return
    }
    setBusy(true)
    let ok
    let data
    let error
    try {
      const r = await unwrap(debugApi.breakpointsSeedDefault())
      ok = r.ok
      data = r.data
      error = r.error
    } finally {
      setBusy(false)
    }
    if (!ok || data.success === false) {
      showToast(error || data?.message || 'Seed template failed', true)
      return
    }
    const raw = data.breakpoints || []
    const list = raw.map((b) => ({ className: b.className, lineNumber: Number(b.lineNumber) })).filter((b) => b.className && Number.isFinite(b.lineNumber))
    if (!list.length) {
      showToast('Seed list empty', true)
      return
    }
    setBusy(true)
    try {
      const batch = await unwrap(debugApi.setBreakpointsBatch(list))
      if (!batch.ok || batch.data.success === false) {
        showToast(batch.error || batch.data?.message || 'Batch failed', true)
        return
      }
      showToast(`Seeded ${batch.data.successCount ?? list.length} breakpoints`)
      await refreshBreakpoints()
      pushActivity(`Seeded ${list.length} breakpoints from API`)
    } finally {
      setBusy(false)
    }
  }

  const seedBreakpointsFromPath = async () => {
    if (!connected) {
      showToast('Connect JDWP to the target VM first', true)
      return
    }
    const p = seedPath.trim()
    if (!p) {
      showToast('Set a .json path or use Seed from API', true)
      return
    }
    let text
    try {
      if (window.jdwpElectron?.readTextFileAllowed) {
        text = await window.jdwpElectron.readTextFileAllowed(p)
      } else {
        showToast('Disk seed path needs JDWP Studio (Electron)', true)
        return
      }
    } catch (e) {
      showToast(e.message || String(e), true)
      return
    }
    let list
    try {
      list = JSON.parse(text)
    } catch {
      showToast('Invalid JSON in seed file', true)
      return
    }
    if (!Array.isArray(list)) {
      showToast('Seed file must be a JSON array', true)
      return
    }
    const normalized = list
      .map((b) => ({ className: b.className, lineNumber: Number(b.lineNumber) }))
      .filter((b) => b.className && Number.isFinite(b.lineNumber))
    if (!normalized.length) {
      showToast('No valid entries (className + lineNumber)', true)
      return
    }
    setBusy(true)
    try {
      const batch = await unwrap(debugApi.setBreakpointsBatch(normalized))
      if (!batch.ok || batch.data.success === false) {
        showToast(batch.error || batch.data?.message || 'Batch failed', true)
        return
      }
      showToast(`Loaded ${normalized.length} breakpoints from file`)
      await refreshBreakpoints()
      pushActivity(`Seeded ${normalized.length} breakpoints from ${p}`)
    } finally {
      setBusy(false)
    }
  }

  const onSelectThread = (name) => {
    setSelectedThread(name)
  }

  const resume = async () => {
    if (!selectedThread) return
    const thread = selectedThread
    setDebugCmdBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(debugApi.resumeThread(thread))
      ok = r.ok
      data = r.data
    } finally {
      setDebugCmdBusy(false)
    }
    if (!ok || data.success === false) showToast(data?.message || 'Resume failed', true)
    await refreshThreads()
  }

  const suspend = async () => {
    if (!selectedThread) return
    const thread = selectedThread
    setDebugCmdBusy(true)
    try {
      await unwrap(debugApi.suspendThread(thread))
    } finally {
      setDebugCmdBusy(false)
    }
    await refreshThreads()
  }

  const continueVm = async () => {
    setDebugCmdBusy(true)
    try {
      await unwrap(debugApi.continueVm())
    } finally {
      setDebugCmdBusy(false)
    }
    await refreshThreads()
  }

  /** debugCmdBusy only for the JDWP step RPC — variables/frames load afterward without dimming the toolbar. */
  const step = async (kind) => {
    if (!selectedThread) return
    const thread = selectedThread
    setDebugCmdBusy(true)
    try {
      const fn =
        kind === 'over'
          ? debugApi.stepOver
          : kind === 'into'
            ? debugApi.stepInto
            : debugApi.stepOut
      const { ok, data } = await unwrap(fn(thread))
      if (!ok || data.success === false) showToast(data?.message || 'Step failed', true)
      else pushActivity(`Step ${kind}`)
    } finally {
      setDebugCmdBusy(false)
    }
    await refreshFrames(thread)
    await refreshVarsAndLoc(thread)
    await refreshWatches()
  }

  // IDE-style shortcuts: F7 into, F8 over, Shift+F8 out, F9 resume
  useEffect(() => {
    const onKey = (e) => {
      if (!connected || !selectedThread || debugCmdBusy) return
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'F8' && e.shiftKey) { e.preventDefault(); step('out') }
      else if (e.key === 'F8') { e.preventDefault(); step('over') }
      else if (e.key === 'F7') { e.preventDefault(); step('into') }
      else if (e.key === 'F9') { e.preventDefault(); continueVm() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connected, selectedThread, debugCmdBusy, step, continueVm])

  const addBreakpoint = async () => {
    const cn = bpClass.trim()
    const ln = parseInt(bpLine, 10)
    if (!cn || Number.isNaN(ln)) {
      showToast('Class and line required', true)
      return
    }
    const reqId = bpRequestId.trim()
    const logMsg = bpType === 'logpoint' ? bpLogMessage.trim() : ''
    const cond = bpType === 'expression' ? bpCondition.trim() : ''
    if (bpType === 'logpoint' && !logMsg) {
      showToast('Log message required for a logpoint', true)
      return
    }
    if (bpType === 'expression' && !cond) {
      showToast('Condition expression required', true)
      return
    }
    setBusy(true)
    let ok
    let data
    try {
      let r
      if (bpType === 'logpoint' || bpType === 'expression') {
        r = await unwrap(debugApi.setAdvancedBreakpoint({ className: cn, lineNumber: ln, logMessage: logMsg || null, condition: cond || null }))
      } else if (reqId) {
        r = await unwrap(debugApi.setConditionalBreakpoint(cn, ln, reqId, bpTriggerUrl.trim() || undefined))
      } else {
        r = await unwrap(debugApi.setBreakpoint(cn, ln, bpTriggerUrl.trim() || undefined))
      }
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok && data.success !== false) {
      showToast(data.message || (logMsg ? 'Logpoint set' : cond ? 'Expression breakpoint set' : 'Breakpoint set'))
      setBpLine('')
      setBpRequestId('')
      setBpLogMessage('')
      setBpCondition('')
      await refreshBreakpoints()
    } else showToast(data?.message || 'Breakpoint failed', true)
  }

  const toggleBp = async (id, enabled) => {
    const r = await unwrap(debugApi.toggleBreakpoint(id, enabled))
    if (!r.ok || r.data?.success === false) showToast(r.data?.message || r.error || 'Toggle failed', true)
    await refreshBreakpoints()
  }

  const removeBp = async (id) => {
    await unwrap(debugApi.removeBreakpoint(id))
    await refreshBreakpoints()
  }

  const clearBps = async () => {
    await unwrap(debugApi.removeAllBreakpoints())
    await refreshBreakpoints()
  }

  const runEval = async () => {
    if (!selectedThread || !evalExpr.trim()) return
    setDebugCmdBusy(true)
    const fi = evalUseFrame ? frameIndex : undefined
    let ok
    let data
    let error
    try {
      const r = await unwrap(debugApi.evaluate(selectedThread, evalExpr.trim(), fi))
      ok = r.ok
      data = r.data
      error = r.error
    } finally {
      setDebugCmdBusy(false)
    }
    if (ok && data.result != null) setEvalOut(String(data.result))
    else if (data?.message) setEvalOut(data.message)
    else setEvalOut(error || 'Evaluate failed')
  }

  const refreshWatches = useCallback(async () => {
    if (!selectedThread || !watches.length) {
      setWatchResults({})
      return
    }
    const fi = evalUseFrame ? frameIndex : undefined
    const next = {}
    for (const w of watches) {
      const expr = String(w).trim()
      if (!expr) continue
      const { ok, data, error } = await unwrap(debugApi.evaluate(selectedThread, expr, fi))
      next[expr] = ok && data?.result != null ? String(data.result) : error || data?.message || '—'
    }
    setWatchResults(next)
  }, [selectedThread, watches, frameIndex, evalUseFrame])

  useEffect(() => {
    localStorage.setItem('jdwp-watches', JSON.stringify(watches))
  }, [watches])

  const refreshMute = useCallback(async () => {
    const { ok, data } = await unwrap(debugApi.muteState())
    if (ok && data.muted != null) setBpMuted(!!data.muted)
  }, [])

  const refreshWatchpoints = useCallback(async () => {
    const { ok, data } = await unwrap(debugApi.fieldWatchpointsList())
    if (ok && data.watchpoints) setWatchpoints(data.watchpoints)
  }, [])

  useEffect(() => {
    if (connected) {
      refreshMute()
      refreshWatchpoints()
    }
  }, [connected, refreshMute, refreshWatchpoints])

  const loadRadar = async () => {
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(debugApi.executionRadar())
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok && data.threads) setRadar(data.threads)
    else showToast('Radar failed', true)
  }

  const loadThreadDump = async () => {
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(debugApi.threadDump())
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok && data.threads) setThreadDump(data.threads)
    else showToast('Thread dump failed', true)
  }

  // ---- Session report export (Markdown) ------------------------------------
  const exportSessionReport = async () => {
    if (!connected) {
      showToast('Connect to a VM first', true)
      return
    }
    setBusy(true)
    try {
      const [statusR, bpR, hitsR, threadsR] = await Promise.all([
        unwrap(debugApi.status()),
        unwrap(debugApi.listBreakpoints()),
        unwrap(debugApi.breakpointHitStats()),
        unwrap(debugApi.threads()),
      ])
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const lines = []
      lines.push('# JDWP Debug Session Report')
      lines.push('')
      lines.push(`- Generated: ${new Date().toLocaleString()}`)
      const st = statusR.data || {}
      lines.push(`- Target: ${st.targetHost || '?'}:${st.targetPort ?? '?'}`)
      lines.push(`- JVM: ${(st.vmDescription || 'unknown').split('\n')[0]}`)
      lines.push('')

      lines.push('## Breakpoints')
      const bps = (bpR.data && bpR.data.breakpoints) || []
      if (bps.length === 0) lines.push('_none set_')
      else for (const b of bps) lines.push(`- \`${b.location || b.id}\``)
      lines.push('')

      const hits = (hitsR.ok && hitsR.data.hits) || {}
      lines.push('## Breakpoint hits (this session)')
      const hitKeys = Object.keys(hits)
      if (hitKeys.length === 0) lines.push('_no hits recorded_')
      else for (const k of hitKeys) lines.push(`- \`${k}\`: **${hits[k]}**`)
      lines.push('')

      lines.push('## Threads')
      const ths = (threadsR.ok && threadsR.data.threads) || []
      const suspended = ths.filter((t) => t.suspended)
      lines.push(`- Total: ${ths.length}, suspended: ${suspended.length}`)
      for (const t of suspended) lines.push(`- ⏸ **${t.name}** (${t.status || ''})`)
      lines.push('')

      if (varsEnhanced) {
        lines.push('## Variable snapshot (selected thread)')
        lines.push('```json')
        lines.push(JSON.stringify(varsEnhanced, null, 2).slice(0, 20000))
        lines.push('```')
        lines.push('')
      }

      lines.push('## Activity log')
      lines.push('```')
      for (const l of activityLines.slice(-40)) lines.push(typeof l === 'string' ? l : JSON.stringify(l))
      lines.push('```')

      const md = lines.join('\n')
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `jdwp-session-report-${ts}.md`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast('Session report downloaded')
    } finally {
      setBusy(false)
    }
  }

  const toggleMute = async () => {
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(debugApi.muteBreakpoints(!bpMuted))
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok) {
      setBpMuted(!!data.muted)
      showToast(data.muted ? 'Breakpoints muted' : 'Breakpoints active')
    }
  }

  const addMethodBp = async () => {
    const c = methodClass.trim()
    const m = methodName.trim()
    if (!c || !m) {
      showToast('Class + method required', true)
      return
    }
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(
        debugApi.setMethodBreakpoint(c, m, methodSig.trim() || undefined),
      )
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok && data.success !== false) {
      showToast('Method breakpoint set')
      await refreshBreakpoints()
    } else showToast(data?.message || 'Failed', true)
  }

  const addFieldWatch = async () => {
    const c = watchClass.trim()
    const f = watchField.trim()
    if (!c || !f) {
      showToast('Class + field required', true)
      return
    }
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(debugApi.fieldWatchpointAdd(c, f, watchRead, watchWrite))
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok && data.success !== false) {
      showToast('Field watchpoint set')
      await refreshWatchpoints()
    } else showToast(data?.message || 'Failed', true)
  }

  const removeWp = async (id) => {
    await unwrap(debugApi.fieldWatchpointRemove(id))
    await refreshWatchpoints()
  }

  const addWatchExpr = () => {
    const t = watchInput.trim()
    if (!t || watches.includes(t)) return
    setWatches((w) => [...w, t])
    setWatchInput('')
  }

  const removeWatchExpr = (expr) => {
    setWatches((w) => w.filter((x) => x !== expr))
    setWatchResults((r) => {
      const c = { ...r }
      delete c[expr]
      return c
    })
  }

  const saveSettings = async () => {
    await setApiBaseSafe(apiBaseInput.trim() || 'http://localhost:8083')
    setSettingsOpen(false)
    refreshStatus()
    showToast('API base updated — reconnect if needed')
  }

  const addConditionalBp = async () => {
    const cn = condClass.trim()
    const ln = parseInt(condLine, 10)
    const req = condReqId.trim()
    if (!cn || Number.isNaN(ln) || !req) {
      showToast('Class, line, and target request id are required', true)
      return
    }
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(
        debugApi.setConditionalBreakpoint(cn, ln, req, condTrigger.trim() || undefined),
      )
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (ok && data.success !== false) {
      showToast(data.message || 'Conditional breakpoint set')
      pushActivity(`Conditional BP ${cn}:${ln} req=${req}`)
      setCondLine('')
      await refreshBreakpoints()
    } else showToast(data?.message || 'Conditional breakpoint failed', true)
  }

  useEffect(() => {
    if (!connected || !selectedThread) {
      setRequestIdLens('')
      return
    }
    let cancelled = false
    ;(async () => {
      const { ok, data } = await unwrap(debugApi.requestIdForThread(selectedThread))
      if (!cancelled && ok && data?.requestId != null) setRequestIdLens(String(data.requestId))
      else if (!cancelled) setRequestIdLens('')
    })()
    return () => {
      cancelled = true
    }
  }, [connected, selectedThread])

  useEffect(() => {
    if (!connected) {
      setHitStats({})
      return
    }
    const load = async () => {
      const { ok, data } = await unwrap(debugApi.breakpointHitStats())
      if (ok && data.hits && typeof data.hits === 'object') setHitStats(data.hits)
    }
    load()
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [connected])

  const onLogRowClick = (index) => {
    const e = filteredLogEntries[index]
    const name = e?.thread?.trim()
    if (!name) return
    const hit = threads.find((t) => t.name === name)
    if (hit) {
      setSelectedThread(name)
      pushActivity(`Log → select thread "${name}"`)
    } else showToast(`No live thread named "${name}"`, true)
  }

  const copyJson = async (label, value) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      showToast(`${label} copied`)
    } catch {
      showToast('Clipboard failed', true)
    }
  }

  const threadLines = useMemo(
    () =>
      threads.map((t) => `${t.isSuspended ? '⏸ ' : '▶ '}${t.name}${t.atBreakpoint ? ' · BP' : ''}`),
    [threads],
  )
  const selectedThreadIndex = useMemo(
    () => threads.findIndex((t) => t.name === selectedThread),
    [threads, selectedThread],
  )

  const frameLines = useMemo(
    () =>
      frames.map((f) => `${String(f.class || '').split('.').pop()}::${f.method}:${f.lineNumber}`),
    [frames],
  )

  const cancelHttpProbe = useCallback(() => {
    probeAbortRef.current?.abort()
  }, [])

  const runProbe = async () => {
    let body
    if (probeBody.trim()) {
      try {
        body = JSON.parse(probeBody)
      } catch {
        showToast('Invalid JSON body', true)
        return
      }
    }
    const extraHeaders = parseHeaderLines(probeHeadersStr)
    if (authBearer.trim()) {
      extraHeaders.Authorization = `Bearer ${authBearer.trim()}`
    }
    probeAbortRef.current?.abort()
    const ac = new AbortController()
    probeAbortRef.current = ac
    setProbeBusy(true)
    try {
      const path = normalizeServerProxyPath(probePath)
      let res
      try {
        res = await serverRequest(probeMethod, path, body, extraHeaders, ac.signal)
      } catch (e) {
        const code = e?.code
        const name = e?.name
        if (code === 'ERR_CANCELED' || name === 'CanceledError' || name === 'AbortError') {
          setProbeOut(JSON.stringify({ info: 'Request cancelled (Send again or server resumed).' }, null, 2))
          return
        }
        setProbeOut(JSON.stringify({ error: e?.message || String(e) }, null, 2))
        showToast('HTTP probe failed', true)
        return
      }
      const { ok, data, error } = unwrapServerProbeResponse(res)
      const payload = ok ? data : { error }
      try {
        setProbeOut(JSON.stringify(payload, null, 2))
      } catch (stringifyErr) {
        setProbeOut(
          JSON.stringify(
            { error: 'Response could not be stringified', detail: String(stringifyErr?.message || stringifyErr) },
            null,
            2,
          ),
        )
      }
    } finally {
      if (probeAbortRef.current === ac) probeAbortRef.current = null
      setProbeBusy(false)
    }
  }

  const saveHttpHistory = useCallback(() => {
    const path = normalizeServerProxyPath(probePath)
    setHttpHistory((prev) => {
      const entry = {
        method: probeMethod,
        path,
        body: probeBody,
        headers: probeHeadersStr,
        bearer: authBearer,
        ts: Date.now(),
      }
      const rest = prev.filter((h) => !(h.method === entry.method && h.path === entry.path))
      return [entry, ...rest].slice(0, 24)
    })
  }, [probeMethod, probePath, probeBody, probeHeadersStr, authBearer])

  const applyHttpHistory = useCallback((h) => {
    setProbeMethod(h.method || 'GET')
    setProbePath(h.path || '/health')
    setProbeBody(h.body || '')
    setProbeHeadersStr(h.headers || '')
    setAuthBearer(h.bearer || '')
  }, [])

  const clearHttpHistory = useCallback(() => setHttpHistory([]), [])

  const toggleRightPanel = useCallback((id) => {
    setRightPanels((p) => ({ ...p, [id]: !p[id] }))
  }, [])

  const openHttpDrawer = useCallback(() => {
    setRightPanels((p) => ({ ...p, http: true }))
  }, [])

  const openBpDrawer = useCallback(() => {
    setRightPanels((p) => ({ ...p, bp: true }))
  }, [])

  const openSourceDrawer = useCallback(() => {
    setRightPanels((p) => ({ ...p, source: true }))
  }, [])

  /** Drag splitter down → grow panel above; drag up → grow panel below (natural resize feel). */
  const onRightFlexPairDrag = useCallback((upperKey, lowerKey, dy) => {
    setRightFlexWeights((w) => {
      const next = { ...w }
      const sens = 0.018
      next[upperKey] = Math.max(0.15, (next[upperKey] ?? 1) + dy * sens)
      next[lowerKey] = Math.max(0.15, (next[lowerKey] ?? 1) - dy * sens)
      return next
    })
  }, [])

  const rightPanelsTopmostKey = useMemo(() => {
    for (const k of ['source', 'bp', 'http']) {
      if (rightPanels[k]) return k
    }
    return null
  }, [rightPanels])

  const rightPanelTogglesEl = useMemo(
    () => <RightPanelToggles panels={rightPanels} onTogglePanel={toggleRightPanel} />,
    [rightPanels, toggleRightPanel],
  )

  const onLogSplitterPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const splitEl = e.currentTarget
    const container = logSplitRef.current
    if (!container) return

    const SPLITTER_PX = 12
    const dockMin = 120
    const mainMin = 96

    const apply = (clientY) => {
      const r = container.getBoundingClientRect()
      const maxDock = Math.max(dockMin, r.height - mainMin - SPLITTER_PX)
      const dock = Math.round(r.bottom - clientY)
      setLogDockHeight(Math.min(maxDock, Math.max(dockMin, dock)))
    }

    splitEl.setPointerCapture(e.pointerId)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => apply(ev.clientY)
    const onUp = (ev) => {
      try {
        splitEl.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      splitEl.removeEventListener('pointermove', onMove)
      splitEl.removeEventListener('pointerup', onUp)
      splitEl.removeEventListener('pointercancel', onUp)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    splitEl.addEventListener('pointermove', onMove)
    splitEl.addEventListener('pointerup', onUp)
    splitEl.addEventListener('pointercancel', onUp)
  }, [])

  const loadNextLineVars = useCallback(async () => {
    if (!selectedThread) {
      showToast('Select a thread first', true)
      return
    }
    setDebugCmdBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(debugApi.variablesNextLine(selectedThread))
      ok = r.ok
      data = r.data
    } finally {
      setDebugCmdBusy(false)
    }
    if (ok && data?.variables != null) setVarsNextLine(data.variables)
    else if (ok) setVarsNextLine(data ?? null)
    else {
      setVarsNextLine(null)
      showToast('Next-line variables unavailable', true)
    }
  }, [selectedThread, showToast])

  const frameVars = useMemo(() => {
    if (!frames.length || frameIndex < 0 || frameIndex >= frames.length) return {}
    const v = frames[frameIndex]?.variables
    return v && typeof v === 'object' ? v : {}
  }, [frames, frameIndex])

  const applyExceptionBp = async (enabled) => {
    setBusy(true)
    let ok
    let data
    try {
      const r = await unwrap(
        debugApi.exceptionBreakpoint(enabled, excClass.trim() || undefined),
      )
      ok = r.ok
      data = r.data
    } finally {
      setBusy(false)
    }
    if (!ok || data.success === false) showToast(data?.message || 'Exception BP failed', true)
    else showToast(enabled ? 'Exception breakpoint enabled' : 'Exception breakpoint disabled')
  }

  const dbgToolbarBusy = debugCmdBusy

  const apiPillClass = clientApiReachable ? 'conn-pill--green' : 'conn-pill--red'
  const apiPillLabel = clientApiReachable ? 'Client API' : 'Client offline'
  const vmStatusClass = jdwpConnecting
    ? 'conn-pill--yellow'
    : connected
      ? 'conn-pill--green'
      : clientApiReachable
        ? 'conn-pill--yellow'
        : 'conn-pill--red'
  const vmStatusLabel = jdwpConnecting
    ? 'Connecting…'
    : connected
      ? targetVmHost
        ? `Target VM ${targetVmHost}:${targetVmPort || 5005}`
        : 'Target VM linked'
      : clientApiReachable
        ? 'Target VM not attached'
        : 'Target VM offline'
  const vmStatusTitle = [
    'Spring JDWP client (HTTP) vs process under debug (JDWP).',
    vmDescription ? `VM: ${vmDescription}` : '',
    demoAppBaseHint ? `Demo app (proxied): ${demoAppBaseHint}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      className={`app-shell app-shell--electron ${sidebarCollapsed ? 'app-shell--sidebar-collapsed' : ''}`}
      data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
    >
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: 12,
            right: 16,
            zIndex: 999,
            padding: '10px 14px',
            borderRadius: 8,
            background: toast.isError ? 'rgba(201,74,74,0.95)' : 'rgba(107,143,113,0.95)',
            color: '#fff',
            fontSize: 12,
            maxWidth: 360,
            boxShadow: 'var(--shadow)',
          }}
        >
          {toast.text}
        </div>
      )}

      {advancedOpen && (
        <div className="settings-backdrop" onClick={() => setAdvancedOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: '92vw' }}>
            <h2>Advanced</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
              Classes, batch breakpoints, and API breakpoint configuration.
            </p>
            <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
              <AdvancedPanel showToast={showToast} />
            </Suspense>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => setAdvancedOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Backend API</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
              Spring JDWP client URL (default <code>http://localhost:8083</code>).
            </p>
            <input
              style={{ width: '100%', padding: 8, marginBottom: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)' }}
              value={apiBaseInput}
              onChange={(e) => setApiBaseInput(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={saveSettings}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="app-frame">
        <header className="app-topchrome">
          <div className="app-topchrome__brand">
            <button
              type="button"
              className="sidebar-toggle sidebar-toggle--mobile"
              onClick={() => setSidebarCollapsed((c) => !c)}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
            <div className="brand-lockup">
              <StudioLogo className="brand-lockup__logo" />
              <div className="brand-lockup__meta">
                <span className="sidebar-brand">JDWP Studio</span>
                <span className="sidebar-tag">Debug</span>
              </div>
            </div>
          </div>
          <div className="app-topchrome__spacer" aria-hidden />
          <div className="app-topchrome__controls">
            <div className={`conn-pill ${apiPillClass}`} title="Reachable Spring debug client (port 8083 by default)">
              <span className="conn-pill__dot" aria-hidden />
              <span className="conn-pill__text">{apiPillLabel}</span>
            </div>
            <div className={`conn-pill ${vmStatusClass}`} title={vmStatusTitle}>
              <span className="conn-pill__dot" aria-hidden />
              <span className="conn-pill__text">{vmStatusLabel}</span>
            </div>
            <WindowControls />
          </div>
        </header>
        <div className="app-body">
          <button
            type="button"
            className="sidebar-edge-toggle"
            onClick={() => setSidebarCollapsed((c) => !c)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        <aside className={`sidebar ${sidebarCollapsed ? 'sidebar--collapsed' : ''}`}>
          <nav className="sidebar-nav">
            {NAV_SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`nav-item ${activeNav === s.id ? 'nav-item--active' : ''}`}
                onClick={() => setActiveNav(s.id)}
                title={`${s.label} — ${s.hint}`}
              >
                <span className="nav-item__icon" aria-hidden>
                  <SidebarNavIcon id={s.id} />
                </span>
                <span className="nav-item__label">{s.label}</span>
                <span className="nav-item__hint">{s.hint}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-activity">
            {activityLines.slice(-5).map((line, i) => (
              <div key={`${line}-${i}`} className="sidebar-activity__line" title={line}>
                {line}
              </div>
            ))}
          </div>
          <div className="sidebar-footer">
            <span className={`badge ${connected ? 'badge-ok' : 'badge-off'}`}>{connected ? 'Live' : 'Off'}</span>
            <button type="button" className="btn btn-ghost btn--sm" onClick={() => setSettingsOpen(true)}>
              API
            </button>
            <button type="button" className="btn btn-ghost btn--sm" onClick={() => setAdvancedOpen(true)}>
              Tools
            </button>
          </div>
        </aside>
        <main className="main-stage main-stage--drawer-host">
          <div
            className={`main-stage__body ${activeNav === 'debugger' ? 'main-stage__body--debug-fill' : 'scroll-y'}`}
          >
            {activeNav === 'session' && (
        <section className="panel panel--page">
          <div className="panel-header">Session</div>
          <div className="panel-body">
            <div className="panel-header" style={{ fontSize: 12, marginTop: 0, paddingTop: 0 }}>
              1. Debug client
            </div>
            <div className="input-row">
              <label>API base</label>
              <input value={getApiBase()} readOnly disabled style={{ opacity: 0.85 }} />
            </div>
            <div className="toolbar">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={pingDebugClient}>
                Ping debug client
              </button>
            </div>

            <div
              className="panel-header"
              style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10, fontSize: 12 }}
            >
              2. Target VM (JDWP attach)
            </div>
            <div className="input-row">
              <label>Preset</label>
              <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
                <button
                  type="button"
                  className={`btn btn--sm ${jdwpAttachProfile === 'local-spring' ? 'btn-primary' : ''}`}
                  disabled={connected}
                  onClick={() => applyJdwpPreset('local-spring')}
                  title="Spring client on this machine → JDWP at localhost:5005 (Docker Desktop publishing 5005, or Kind port-forward)"
                >
                  Local client
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${jdwpAttachProfile === 'compose-client' ? 'btn-primary' : ''}`}
                  disabled={connected}
                  onClick={() => applyJdwpPreset('compose-client')}
                  title="jdwp-client container in Compose → JDWP host debug-server:5005"
                >
                  Compose client
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${jdwpAttachProfile === 'k8s-forward' ? 'btn-primary' : ''}`}
                  disabled={connected}
                  onClick={() => applyJdwpPreset('k8s-forward')}
                  title="Single pod: kubectl port-forward … 5005:5005 → localhost:5005"
                >
                  K8s port-forward
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${jdwpAttachProfile === 'k8s-kind-a' ? 'btn-primary' : ''}`}
                  disabled={connected}
                  onClick={() => applyJdwpPreset('k8s-kind-a')}
                  title="kind 2-pod demo: scripts/kind-jdwp-forward-jdwp → JDWP pod A on localhost:5005; HTTP http://localhost:9081"
                >
                  Kind pod A
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${jdwpAttachProfile === 'k8s-kind-b' ? 'btn-primary' : ''}`}
                  disabled={connected}
                  onClick={() => applyJdwpPreset('k8s-kind-b')}
                  title="kind 2-pod demo: pod B JDWP on localhost:5006; HTTP http://localhost:9082"
                >
                  Kind pod B
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${jdwpAttachProfile === 'custom' ? 'btn-primary' : ''}`}
                  disabled={connected}
                  onClick={() => applyJdwpPreset('custom')}
                >
                  Custom
                </button>
              </div>
            </div>
            <div className="input-row">
              <label title="Hostname or IP as seen by the Spring JDWP client JVM">JDWP host (target VM)</label>
              <input
                value={host}
                onChange={(e) => {
                  setJdwpAttachProfile('custom')
                  setHost(e.target.value)
                }}
                disabled={connected}
                placeholder="localhost or debug-server"
              />
            </div>
            <div className="input-row">
              <label title="JDWP listening port inside the target process (often 5005)">JDWP port (target VM)</label>
              <input
                value={port}
                onChange={(e) => {
                  setJdwpAttachProfile('custom')
                  setPort(e.target.value)
                }}
                disabled={connected}
                placeholder="5005"
              />
            </div>
            <div className="toolbar">
              <button type="button" className="btn btn-primary" disabled={busy || connected} onClick={connect}>
                Attach to target VM
              </button>
              <button type="button" className="btn" disabled={busy || !connected} onClick={disconnect}>
                Detach
              </button>
            </div>
            {typeof window !== 'undefined' && window.jdwpElectron?.kindJdwpForward ? (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
                <div className="panel-header" style={{ fontSize: 12, marginTop: 0, paddingTop: 0 }}>
                  3. Kind pods
                </div>
                <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => debugKindPodAuto('a')}
                    title="Port-forward pod A JDWP to localhost:5005, proxy demo HTTP to :9081, attach"
                  >
                    Debug Kind pod A
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => debugKindPodAuto('b')}
                    title="Pod B → JDWP localhost:5006, HTTP :9082, attach"
                  >
                    Debug Kind pod B
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={stopKindJdwpForward}>
                    Stop forward
                  </button>
                </div>
              </div>
            ) : null}
            {vmDescription ? (
              <p
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  margin: '8px 0 0',
                  wordBreak: 'break-all',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={vmDescription}
              >
                {vmDescription.split('\n').filter(Boolean).pop()}
              </p>
            ) : null}
            <div className="panel-header" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              Seed breakpoints
            </div>
            <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !connected}
                onClick={seedBreakpointsFromApi}
                title="Set the demo breakpoints list from the client's API config"
              >
                Seed from API
              </button>
              <button type="button" className="btn" disabled={busy || !connected} onClick={seedBreakpointsFromPath}>
                Seed from file
              </button>
            </div>
            <div className="input-row" style={{ marginTop: 8 }}>
              <label title="Absolute path to breakpoints-seed.json (Electron only)">Seed file path</label>
              <input
                value={seedPath}
                onChange={(e) => setSeedPath(e.target.value)}
                placeholder="e.g. C:\path\to\breakpoints-seed.json"
                disabled={busy}
              />
            </div>
            <div className="panel-header" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              Threads
            </div>
            <button type="button" className="btn" style={{ width: '100%', marginBottom: 8 }} onClick={refreshThreads} disabled={!connected}>
              Refresh
            </button>
            {threadLines.length ? (
              <VirtualizedLines
                lines={threadLines}
                rowHeight={22}
                maxHeight={280}
                className="list-item"
                fontSize={11}
                activeIndex={selectedThreadIndex}
                onRowClick={(i) => threads[i] && onSelectThread(threads[i].name)}
              />
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>No threads</div>
            )}
          </div>
        </section>
            )}
            {activeNav === 'debugger' && (
        <section className="panel panel--page ide-debug">
          <div className="panel-header ide-debug__header">
            <span>Debug</span>
          </div>
          <div ref={logSplitRef} className="panel-body ide-debug__body ide-debug__body--split">
            <div className="ide-debug__main scroll-y">
            <div className="ide-thread-bar">
              <label className="ide-thread-bar__label">Thread</label>
              <select
                className="ide-thread-select"
                value={selectedThread ?? ''}
                onChange={(e) => setSelectedThread(e.target.value || null)}
                disabled={!connected}
              >
                <option value="">— suspended / select thread —</option>
                {threads.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.isSuspended ? '⏸ ' : '▶ '}
                    {t.name}
                    {t.atBreakpoint ? ' · BP' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="ide-toolbar">
              <button type="button" className="btn btn-primary" disabled={!selectedThread || dbgToolbarBusy} onClick={() => step('over')}>
                Step over
              </button>
              <button type="button" className="btn" disabled={!selectedThread || dbgToolbarBusy} onClick={() => step('into')}>
                Step into
              </button>
              <button type="button" className="btn" disabled={!selectedThread || dbgToolbarBusy} onClick={() => step('out')}>
                Step out
              </button>
              <button type="button" className="btn" disabled={!selectedThread || dbgToolbarBusy} onClick={resume}>
                Resume
              </button>
              <button type="button" className="btn" disabled={!selectedThread || dbgToolbarBusy} onClick={suspend}>
                Suspend
              </button>
              <button type="button" className="btn" disabled={!connected || dbgToolbarBusy} onClick={continueVm}>
                Resume VM
              </button>
            </div>
            <div className="ide-grid ide-grid--frames">
              <div className="ide-pane">
                <div className="ide-pane__title">Frames</div>
                {frameLines.length ? (
                  <VirtualizedLines
                    lines={frameLines}
                    rowHeight={22}
                    maxHeight={200}
                    className="list-item"
                    fontSize={11}
                    activeIndex={frameIndex}
                    onRowClick={(i) => setFrameIndex(i)}
                  />
                ) : (
                  <div className="ide-pane__empty">No frames — suspend at a breakpoint</div>
                )}
              </div>
              <div className="ide-pane">
                <div className="ide-pane__title">Scope (locals)</div>
                <pre className="mono-block ide-scope-json">
                  {Object.keys(frameVars).length ? JSON.stringify(frameVars, null, 2) : '—'}
                </pre>
              </div>
            </div>
            <div className="ide-pane ide-pane--full">
              <div className="ide-pane__title">Variables</div>
              <VariableTree tree={varsEnhanced?.variablesTree} />
              <div className="ide-toolbar ide-toolbar--tight">
                <button type="button" className="btn btn-ghost btn--sm" disabled={!selectedThread || dbgToolbarBusy} onClick={loadNextLineVars}>
                  Load next-line scope
                </button>
              </div>
              {varsNextLine != null && (
                <pre className="mono-block ide-next-line">{JSON.stringify(varsNextLine, null, 2)}</pre>
              )}
            </div>
            <div className="ide-pane ide-pane--full ide-eval">
              <div className="ide-pane__title">Evaluate expression</div>
              <p className="ide-eval__hint">Like IntelliJ “Evaluate Expression” — runs on the selected thread{evalUseFrame ? ' at the selected frame' : ''}.</p>
              <label className="ide-eval__check">
                <input type="checkbox" checked={evalUseFrame} onChange={(e) => setEvalUseFrame(e.target.checked)} />
                Use current stack frame
              </label>
              <textarea
                className="ide-eval__input"
                value={evalExpr}
                onChange={(e) => setEvalExpr(e.target.value)}
                placeholder="Expression (e.g. this, field, method call)"
                rows={3}
              />
              <button type="button" className="btn btn-primary" disabled={!selectedThread || dbgToolbarBusy} onClick={runEval}>
                Evaluate
              </button>
              <pre className="mono-block ide-eval__out">{evalOut || '—'}</pre>
            </div>
            <div className="ide-pane ide-pane--full ide-location">
              <div className="ide-pane__title">Execution point</div>
              <pre className="mono-block ide-location__pre">{sourceLoc ? JSON.stringify(sourceLoc, null, 2) : '—'}</pre>
            </div>
            </div>
            <div
              className="ide-log-splitter"
              onPointerDown={onLogSplitterPointerDown}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize live logs height"
            />
            <div
              className="ide-console ide-console--dock"
              style={{ height: logDockHeight, flex: 'none' }}
            >
              <div className="ide-console__head">
                <span className="ide-console__title">Live logs</span>
                <button type="button" className="btn btn-ghost" style={{ fontSize: 10 }} onClick={refreshLogsSimple}>
                  Refresh
                </button>
              </div>
              <div className="ide-console__toolbar input-row">
                <label>Filter</label>
                <input value={logFilterThread} onChange={(e) => setLogFilterThread(e.target.value)} placeholder="thread contains…" />
              </div>
              <p className="ide-console__hint">
                SSE + poll while attached; lines stay in the dock after detach until you refresh the client. Click a line to select that thread above.
              </p>
              <div className="ide-console__viewport">
                {logLines.length ? (
                  <VirtualizedLines lines={logLines} rowHeight={16} flexFill onRowClick={onLogRowClick} />
                ) : (
                  <div className="ide-console__empty">No log lines (ensure log receiver + agent)</div>
                )}
              </div>
            </div>
          </div>
        </section>
            )}
            {activeNav === 'breakpoints' && (
        <section className="panel panel--page">
          <div className="panel-header">Breakpoints</div>
          <div className="panel-body">
            <div className="input-row">
              <label>Class</label>
              <input value={bpClass} onChange={(e) => setBpClass(e.target.value)} placeholder="com.example.Foo" />
            </div>
            <div className="input-row">
              <label>Line</label>
              <input value={bpLine} onChange={(e) => setBpLine(e.target.value)} placeholder="42" />
            </div>
            <div className="input-row">
              <label>Trigger URL</label>
              <input value={bpTriggerUrl} onChange={(e) => setBpTriggerUrl(e.target.value)} placeholder="optional" />
            </div>
            <div className="toolbar">
              <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={addBreakpoint}>
                Add
              </button>
              <button type="button" className="btn" disabled={!connected || busy} onClick={clearBps}>
                Clear all
              </button>
              <button type="button" className="btn" disabled={!connected || busy} onClick={toggleMute} title="Mute breakpoints without deleting (IDE-style)">
                {bpMuted ? 'Unmute BP' : 'Mute BP'}
              </button>
            </div>
            <div className="panel-header" style={{ marginTop: 12 }}>Conditional (request id)</div>
            <div className="input-row">
              <label>Class</label>
              <input value={condClass} onChange={(e) => setCondClass(e.target.value)} placeholder="fqcn" />
            </div>
            <div className="input-row">
              <label>Line</label>
              <input value={condLine} onChange={(e) => setCondLine(e.target.value)} placeholder="line" />
            </div>
            <div className="input-row">
              <label>Request id</label>
              <input value={condReqId} onChange={(e) => setCondReqId(e.target.value)} placeholder="X-Debug-Request-Id value" />
            </div>
            <div className="input-row">
              <label>Trigger URL</label>
              <input value={condTrigger} onChange={(e) => setCondTrigger(e.target.value)} placeholder="optional" />
            </div>
            <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={addConditionalBp} style={{ width: '100%', marginBottom: 8 }}>
              Add conditional BP
            </button>
            <div className="panel-header" style={{ marginTop: 12 }}>Method breakpoint</div>
            <div className="input-row">
              <label>Class</label>
              <input value={methodClass} onChange={(e) => setMethodClass(e.target.value)} placeholder="fqcn" />
            </div>
            <div className="input-row">
              <label>Method</label>
              <input value={methodName} onChange={(e) => setMethodName(e.target.value)} />
            </div>
            <div className="input-row">
              <label>JNI sig</label>
              <input value={methodSig} onChange={(e) => setMethodSig(e.target.value)} placeholder="overload only" />
            </div>
            <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={addMethodBp} style={{ width: '100%', marginBottom: 8 }}>
              Break on method entry
            </button>
            <div className="panel-header" style={{ marginTop: 8 }}>Field watchpoint</div>
            <div className="input-row">
              <label>Class</label>
              <input value={watchClass} onChange={(e) => setWatchClass(e.target.value)} />
            </div>
            <div className="input-row">
              <label>Field</label>
              <input value={watchField} onChange={(e) => setWatchField(e.target.value)} />
            </div>
            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)', fontSize: 11 }}>
                <input type="checkbox" checked={watchRead} onChange={(e) => setWatchRead(e.target.checked)} /> read
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)', fontSize: 11 }}>
                <input type="checkbox" checked={watchWrite} onChange={(e) => setWatchWrite(e.target.checked)} /> write
              </label>
            </div>
            <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={addFieldWatch} style={{ width: '100%', marginBottom: 8 }}>
              Add field watch
            </button>
            {watchpoints.map((w) => (
              <div key={w.id} className="list-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10 }}>{w.id}</span>
                <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => removeWp(w.id)}>
                  ×
                </button>
              </div>
            ))}
            {breakpoints.map((b) => (
              <div key={b.id} className="list-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{b.location || b.id}</span>
                <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => removeBp(b.id)}>
                  ×
                </button>
              </div>
            ))}
            <div className="panel-header" style={{ marginTop: 12 }}>Exception breakpoint</div>
            <div className="input-row">
              <label>Class</label>
              <input value={excClass} onChange={(e) => setExcClass(e.target.value)} placeholder="java.lang.NullPointerException" />
            </div>
            <div className="toolbar">
              <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={() => applyExceptionBp(true)}>
                Enable
              </button>
              <button type="button" className="btn" disabled={!connected || busy} onClick={() => applyExceptionBp(false)}>
                Disable
              </button>
            </div>
          </div>
        </section>
            )}
            {activeNav === 'cluster' && (
          <section className="panel panel--page cluster-panel">
            <div className="panel-header">
              <span>Kubernetes / cluster</span>
              {kindForwardStatus?.active && (
                <span
                  title={`pod/${kindForwardStatus.podName} → localhost:${kindForwardStatus.localPort}`}
                  style={{ fontSize: 10, color: 'var(--ok, #3fb950)', fontFamily: 'var(--font-mono)' }}
                >
                  ● forward active: {kindForwardStatus.podName} :{kindForwardStatus.localPort}
                </span>
              )}
            </div>
            <div className="panel-body cluster-panel__body">
              {kubeContextError && kubeContextList.length === 0 && (
                <div className="cluster-panel__snippet" style={{ color: 'var(--text-muted)' }}>
                  <span className="cluster-panel__snippet-label">kubectl discovery</span>
                  <pre className="mono-block cluster-panel__snippet-pre">{kubeContextError}</pre>
                </div>
              )}
              <div className="input-row">
                <label>
                  Context{' '}
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 10, padding: '1px 6px' }} onClick={refreshKubeContexts}>
                    refresh
                  </button>
                </label>
                {kubeContextList.length > 0 ? (
                  <select value={k8sContext} onChange={(e) => setK8sContext(e.target.value)}>
                    {!k8sContext && <option value="">— select context —</option>}
                    {kubeContextList.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={k8sContext}
                    onChange={(e) => setK8sContext(e.target.value)}
                    placeholder="context name (discovery needs kubectl on PATH)"
                  />
                )}
              </div>
              <div className="input-row">
                <label>Namespace</label>
                <input value={k8sNamespace} onChange={(e) => setK8sNamespace(e.target.value)} placeholder="default" />
              </div>
              <div className="input-row">
                <label>Kubeconfig path</label>
                <input
                  value={k8sKubeconfig}
                  onChange={(e) => setK8sKubeconfig(e.target.value)}
                  placeholder="optional — used by shell, discovery and port-forwards"
                />
              </div>
              <ClusterTerminal
                context={k8sContext}
                namespace={k8sNamespace}
                kubeconfig={k8sKubeconfig}
                showToast={showToast}
              />
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>
                  Services — repos from GitHub / Bitbucket, matched to running pods
                </label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={gitProvider}
                    onChange={(e) => { setGitProvider(e.target.value); setGitRepos([]); setGitError(null) }}
                    style={{ padding: 6, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 11 }}
                  >
                    <option value="github">GitHub</option>
                    <option value="bitbucket">Bitbucket</option>
                  </select>
                  {gitProvider === 'bitbucket' && (
                    <input
                      value={gitOwner}
                      onChange={(e) => setGitOwner(e.target.value)}
                      placeholder="workspace"
                      style={{ width: 130, padding: 6, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 11 }}
                    />
                  )}
                  <input
                    type="password"
                    value={gitToken}
                    onChange={(e) => setGitToken(e.target.value)}
                    placeholder={gitProvider === 'bitbucket' ? 'access token' : 'token (read-only)'}
                    style={{ flex: 1, minWidth: 180, padding: 6, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  />
                  <button type="button" className="btn" disabled={gitLoading} onClick={loadServices}>
                    {gitLoading ? 'Loading…' : 'Load services'}
                  </button>
                </div>
                {gitError && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{gitError}</div>
                )}
                {gitRepos.length > 0 && (
                  <>
                    <input
                      value={gitSearch}
                      onChange={(e) => setGitSearch(e.target.value)}
                      placeholder={`filter ${gitRepos.length} services…`}
                      style={{ width: '100%', marginTop: 6, padding: 6, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 11 }}
                    />
                    <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {gitRepos
                        .filter((r) => !gitSearch || r.name.toLowerCase().includes(gitSearch.toLowerCase()))
                        .slice(0, 50)
                        .map((r) => (
                          <button
                            key={r.fullName}
                            type="button"
                            className="btn btn-ghost"
                            title={`${r.fullName}${r.language ? ` · ${r.language}` : ''}`}
                            style={{
                              textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-mono)',
                              fontWeight: selectedService === r.name ? 700 : 400,
                              border: selectedService === r.name ? '1px solid var(--accent, #58a6ff)' : 'none',
                            }}
                            onClick={() => { selectService(r.name) }}
                          >
                            {r.name}{r.private ? ' 🔒' : ''}
                          </button>
                        ))}
                    </div>
                  </>
                )}
                {selectedService && (
                  <div style={{ marginTop: 8 }}>
                    {branchesLoading && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>loading branches…</div>}
                    {branchesError && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>branches: {branchesError}</div>
                    )}
                    {!branchesLoading && serviceBranches.length > 0 && (
                      <div className="input-row">
                        <label>Branch</label>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select
                            value={selectedBranch}
                            onChange={(e) => setSelectedBranch(e.target.value)}
                            style={{
                              flex: 1,
                              padding: 6,
                              borderRadius: 8,
                              border: '1px solid var(--border)',
                              background: 'var(--bg-deep)',
                              color: 'var(--text)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                            }}
                          >
                            {serviceBranches.map((b) => (
                              <option key={b.name} value={b.name}>
                                {b.name}{b.isDefault ? ' (default)' : ''}{b.protected ? ' 🔒' : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={cloningService}
                            title="Shallow-clone this branch and open it in the Source view"
                            onClick={cloneSelectedService}
                          >
                            {cloningService ? 'Cloning…' : 'Clone & open source'}
                          </button>
                        </div>
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text)', marginBottom: 4 }}>
                      Pods matching <code>{selectedService}</code> in namespace <code>{k8sNamespace}</code>:
                    </div>
                    {servicePods.length === 0 ? (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        No pods found for this service name — it may not be deployed here, or uses a different name/namespace.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {servicePods.map((p) => (
                          <div key={p.name} style={{ display: 'flex', gap: 6, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                            <span style={{ color: p.running ? 'var(--ok, #3fb950)' : 'var(--text-muted)' }}>●</span>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                            <span style={{ color: 'var(--text-muted)' }}>{p.phase}</span>
                            <button type="button" className="btn btn-ghost" style={{ fontSize: 9, padding: '2px 6px' }} onClick={() => fetchPodLogs(p.name)}>
                              logs
                            </button>
                            <button type="button" className="btn" style={{ fontSize: 9, padding: '2px 8px' }} disabled={!p.running || busy} onClick={() => debugServicePod(p.name)}>
                              Debug
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {podLogsLoading && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>fetching logs…</div>}
                    {podLogs && !podLogsLoading && (
                      <pre
                        className="mono-block"
                        style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6, fontSize: 9, whiteSpace: 'pre-wrap' }}
                      >
                        {`--- kubectl logs ${podLogs.pod} (last 100) ---\n${podLogs.text}`}
                      </pre>
                    )}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>
                  Attach to any pod (JDWP → localhost:5005)
                </label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-ghost" style={{ fontSize: 10 }} onClick={discoverPods}>
                    Discover pods
                  </button>
                  {podList.length > 0 && (
                    <select
                      value={selectedPod}
                      onChange={(e) => setSelectedPod(e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 200,
                        padding: 6,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--bg-deep)',
                        color: 'var(--text)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                      }}
                    >
                      {podList.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name} — {p.phase}
                          {p.running ? '' : ' (not running)'}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    value={podJdwpPort}
                    onChange={(e) => setPodJdwpPort(e.target.value)}
                    title="JDWP port inside the pod"
                    style={{ width: 70, padding: 6, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  />
                  <button type="button" className="btn" disabled={busy || !selectedPod} onClick={debugSelectedPod}>
                    Debug this pod
                  </button>
                </div>
                {podDiscoveryError && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{podDiscoveryError}</div>
                )}
                {podForwards.length > 0 && (
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--ok, #3fb950)', marginTop: 6 }}>
                    {podForwards.map((f) => (
                      <div key={f.localPort}>
                        ● localhost:{f.localPort} ← {f.namespace}/{f.pod}:{f.remotePort}{' '}
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ fontSize: 9, padding: '0 6px' }}
                          onClick={async () => {
                            await window.jdwpElectron?.podJdwpForwardStop({ localPort: f.localPort })
                            showToast(`Forward to ${f.pod} stopped`)
                          }}
                        >
                          stop
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11 }}>Notes</summary>
                <textarea
                  value={k8sNotes}
                  onChange={(e) => setK8sNotes(e.target.value)}
                  rows={3}
                  placeholder="Local scratchpad — saved in this app only."
                  style={{
                    width: '100%',
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-deep)',
                    color: 'var(--text)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    resize: 'vertical',
                  }}
                />
              </details>
            </div>
          </section>
            )}
            {activeNav === 'insights' && (
          <section className="panel panel--page diagnostics-panel">
            <div className="panel-header">
              <span>Radar · dump · watches</span>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 10 }} onClick={loadRadar} disabled={!connected || busy}>
                Radar
              </button>
            </div>
            <div className="panel-body">
              <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                Execution radar: top frame per thread (live map of worker activity). Thread dump: full stacks (jstack-style).
              </p>
              <div className="toolbar">
                <button type="button" className="btn" disabled={!connected || busy} onClick={loadThreadDump}>
                  Full thread dump
                </button>
                <button type="button" className="btn btn-ghost" disabled={!connected || busy} onClick={exportSessionReport} title="Download breakpoints, hits, threads, variables and activity as Markdown">
                  Export report
                </button>
                <button type="button" className="btn" disabled={!selectedThread || dbgToolbarBusy} onClick={refreshWatches}>
                  Refresh watches
                </button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
                Request id (stack lens){' '}
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{requestIdLens || '—'}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
                Breakpoint hits (session){' '}
                <pre className="mono-block" style={{ maxHeight: 56, marginTop: 4, fontSize: 9 }}>
                  {Object.keys(hitStats).length ? JSON.stringify(hitStats, null, 1) : '—'}
                </pre>
              </div>
              <div style={{ fontSize: 10, color: 'var(--accent)', marginBottom: 4 }}>Execution radar</div>
              {radar.length ? (
                <VirtualizedLines
                  lines={radar.map((r) =>
                    `${r.name}: ${r.topClass ? `${r.topClass}.${r.topMethod}:${r.line}` : 'running'}`,
                  )}
                  rowHeight={16}
                  maxHeight={100}
                />
              ) : (
                <pre className="mono-block" style={{ maxHeight: 100, marginBottom: 8 }}>
                  —
                </pre>
              )}
              <div className="toolbar" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={!varsEnhanced}
                  onClick={() => copyJson('Variables', varsEnhanced)}
                >
                  Snapshot variables
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!threadDump}
                  onClick={() => copyJson('Thread dump', threadDump)}
                >
                  Snapshot thread dump
                </button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--accent)', marginBottom: 4 }}>Thread dump (summary)</div>
              {threadDump?.length ? (
                <VirtualizedLines
                  lines={threadDump.map(
                    (t) => `${t.name} [${t.status}] ${(t.stack || []).slice(0, 4).join(' ← ')}`,
                  )}
                  rowHeight={16}
                  maxHeight={120}
                />
              ) : (
                <pre className="mono-block" style={{ maxHeight: 120 }}>
                  —
                </pre>
              )}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>Watches (persisted; re-eval on step)</div>
              <div className="toolbar diagnostics-panel__watch-row">
                <input
                  className="diagnostics-panel__input"
                  value={watchInput}
                  onChange={(e) => setWatchInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addWatchExpr()}
                  placeholder="expression"
                />
                <button type="button" className="btn btn-primary" onClick={addWatchExpr}>
                  +
                </button>
              </div>
              {watches.map((w) => (
                <div key={w} className="list-item" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10 }}>
                  <span>
                    {w} → {watchResults[w] ?? '…'}
                  </span>
                  <button type="button" className="btn btn-ghost" style={{ padding: '0 6px' }} onClick={() => removeWatchExpr(w)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
            )}
          </div>
          <div className="right-rail-stack" aria-label="Add side panels to the stack">
            {!rightPanels.source && (
              <button
                type="button"
                className="source-rail-tab"
                onClick={openSourceDrawer}
                title="Add Source panel (stacked top)"
              >
                <span className="source-rail-tab__text">Code</span>
              </button>
            )}
            {!rightPanels.bp && (
              <button type="button" className="bp-rail-tab" onClick={openBpDrawer} title="Add Breakpoints panel">
                <span className="bp-rail-tab__text">BP</span>
              </button>
            )}
            {!rightPanels.http && (
              <button type="button" className="http-rail-tab" onClick={openHttpDrawer} title="Add HTTP panel (stacked bottom)">
                <span className="http-rail-tab__text">HTTP</span>
              </button>
            )}
          </div>
          <RightDrawerColumn
            width={rightColumnWidth}
            onWidthChange={setRightColumnWidth}
            panels={rightPanels}
            flexWeights={rightFlexWeights}
            onPairDrag={onRightFlexPairDrag}
            slots={{
              source: (
                <SourceCodeDrawer
                  open
                  stacked
                  panelToggles={rightPanelsTopmostKey === 'source' ? rightPanelTogglesEl : null}
                  onClose={() => setRightPanels((p) => ({ ...p, source: false }))}
                  width={rightColumnWidth}
                  onWidthChange={setRightColumnWidth}
                  sourceRoot={sourceRoot}
                  setSourceRoot={setSourceRoot}
                  frames={frames}
                  frameIndex={frameIndex}
                  sourceLoc={sourceLoc}
                  connected={connected}
                  breakpoints={breakpoints}
                  toggleBreakpointAtSource={toggleBreakpointAtSource}
                  evaluateFromSource={evaluateFromSource}
                />
              ),
              bp: (
                <BreakpointDrawer
                  open
                  stacked
                  panelToggles={rightPanelsTopmostKey === 'bp' ? rightPanelTogglesEl : null}
                  onClose={() => setRightPanels((p) => ({ ...p, bp: false }))}
                  width={rightColumnWidth}
                  onWidthChange={setRightColumnWidth}
                  bpClass={bpClass}
                  setBpClass={setBpClass}
                  bpLine={bpLine}
                  setBpLine={setBpLine}
                  bpTriggerUrl={bpTriggerUrl}
                  setBpTriggerUrl={setBpTriggerUrl}
                  bpRequestId={bpRequestId}
                  setBpRequestId={setBpRequestId}
                  bpType={bpType}
                  setBpType={setBpType}
                  bpLogMessage={bpLogMessage}
                  setBpLogMessage={setBpLogMessage}
                  bpCondition={bpCondition}
                  setBpCondition={setBpCondition}
                  toggleBp={toggleBp}
                  addBreakpoint={addBreakpoint}
                  clearBps={clearBps}
                  toggleMute={toggleMute}
                  bpMuted={bpMuted}
                  breakpoints={breakpoints}
                  removeBp={removeBp}
                  connected={connected}
                  busy={busy}
                />
              ),
              http: (
                <HttpApiDrawer
                  open
                  stacked
                  panelToggles={rightPanelsTopmostKey === 'http' ? rightPanelTogglesEl : null}
                  onClose={() => setRightPanels((p) => ({ ...p, http: false }))}
                  width={rightColumnWidth}
                  onWidthChange={setRightColumnWidth}
                  probeMethod={probeMethod}
                  setProbeMethod={setProbeMethod}
                  probePath={probePath}
                  setProbePath={setProbePath}
                  probeBody={probeBody}
                  setProbeBody={setProbeBody}
                  probeHeadersStr={probeHeadersStr}
                  setProbeHeadersStr={setProbeHeadersStr}
                  authBearer={authBearer}
                  setAuthBearer={setAuthBearer}
                  probeOut={probeOut}
                  runProbe={runProbe}
                  cancelProbe={cancelHttpProbe}
                  busy={probeBusy}
                  onSaveHistory={saveHttpHistory}
                  historyItems={httpHistory}
                  onApplyHistory={applyHttpHistory}
                  onClearHistory={clearHttpHistory}
                />
              ),
            }}
          />
        </main>
        </div>
      </div>
    </div>
  )
}
