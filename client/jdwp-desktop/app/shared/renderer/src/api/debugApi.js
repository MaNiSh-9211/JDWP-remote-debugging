import axios from 'axios'

function base() {
  return localStorage.getItem('jdwpApiBase') || 'http://localhost:8083'
}

export function setApiBase(url) {
  localStorage.setItem('jdwpApiBase', url.replace(/\/$/, ''))
}

/** Persists API base after main-process sanitization (Electron). */
export async function setApiBaseSafe(url) {
  let u = (url || '').trim().replace(/\/$/, '') || 'http://localhost:8083'
  if (typeof window !== 'undefined' && window.jdwpElectron?.sanitizeApiBase) {
    try {
      u = await window.jdwpElectron.sanitizeApiBase(u)
    } catch {
      /* keep u */
    }
  }
  localStorage.setItem('jdwpApiBase', u)
}

export function getApiBase() {
  return base()
}

/** Full URL for SSE live logs (EventSource). */
export function logsStreamUrl() {
  return `${base()}/api/debug/logs/stream`
}

function api() {
  return axios.create({
    baseURL: `${base()}/api/debug`,
    /** No cap — stepping/variables can take arbitrarily long while the target thread stays paused. */
    timeout: 0,
    validateStatus: () => true,
  })
}

export const debugApi = {
  ping: () => api().get('/ping'),
  status: () => api().get('/status'),
  clientConfig: () => api().get('/client-config'),
  getDemoAppBase: () => api().get('/demo-app-base'),
  setDemoAppBase: (baseUrl) => api().post('/demo-app-base', { baseUrl }),
  breakpointsSeedDefault: () => api().get('/breakpoints/seed-default'),
  connect: (host, port) => api().post('/connect', null, { params: { host, port } }),
  disconnect: () => api().post('/disconnect'),
  threads: () => api().get('/threads'),
  frames: (threadName) => api().get(`/threads/${encodeURIComponent(threadName)}/frames`),
  setBreakpoint: (className, lineNumber, triggerLoadUrl) =>
    api().post('/breakpoints', null, { params: { className, lineNumber, triggerLoadUrl } }),
  setConditionalBreakpoint: (className, lineNumber, targetRequestId, triggerLoadUrl) =>
    api().post('/breakpoints/conditional', null, {
      params: { className, lineNumber, targetRequestId, triggerLoadUrl },
    }),
  setAdvancedBreakpoint: (payload) => api().post('/breakpoints/advanced', payload),
  toggleBreakpoint: (id, enabled) => api().post('/breakpoints/toggle', { id, enabled }),
  setMethodBreakpoint: (className, methodName, signature) =>
    api().post('/breakpoints/method', null, {
      params: { className, methodName, ...(signature ? { signature } : {}) },
    }),
  muteBreakpoints: (muted) => api().post('/breakpoints/mute', null, { params: { muted } }),
  muteState: () => api().get('/breakpoints/mute'),
  breakpointHitStats: () => api().get('/breakpoints/hit-stats'),
  removeBreakpoint: (bpId) => api().delete(`/breakpoints/${encodeURIComponent(bpId)}`),
  removeAllBreakpoints: () => api().delete('/breakpoints'),
  setBreakpointsBatch: (list) => api().post('/breakpoints/batch', list),
  listBreakpoints: () => api().get('/breakpoints'),
  apiBreakpointsConfig: () => api().get('/api-breakpoints-config'),
  resumeThread: (threadName) => api().post(`/threads/${encodeURIComponent(threadName)}/resume`),
  suspendThread: (threadName) => api().post(`/threads/${encodeURIComponent(threadName)}/suspend`),
  continueVm: () => api().post('/continue'),
  classes: () => api().get('/classes'),
  stepOver: (threadName) => api().post(`/threads/${encodeURIComponent(threadName)}/step-over`),
  stepInto: (threadName) => api().post(`/threads/${encodeURIComponent(threadName)}/step-into`),
  stepOut: (threadName) => api().post(`/threads/${encodeURIComponent(threadName)}/step-out`),
  resetFrame: (threadName, applicationPackagePrefix) =>
    api().post(`/threads/${encodeURIComponent(threadName)}/reset-frame`, null, {
      params: applicationPackagePrefix?.trim()
        ? { applicationPackagePrefix: applicationPackagePrefix.trim() }
        : {},
    }),
  variablesNextLine: (threadName) => api().get(`/threads/${encodeURIComponent(threadName)}/variables-next-line`),
  variablesEnhanced: (threadName, includeInstance = true) =>
    api().get(`/threads/${encodeURIComponent(threadName)}/variables-enhanced`, {
      params: { includeInstance },
    }),
  evaluate: (threadName, expression, frameIndex) =>
    api().post(`/threads/${encodeURIComponent(threadName)}/evaluate`, null, {
      params: {
        expression,
        ...(frameIndex != null && frameIndex >= 0 ? { frameIndex } : {}),
      },
    }),
  sourceLocation: (threadName) => api().get(`/threads/${encodeURIComponent(threadName)}/source-location`),
  requestIdForThread: (threadName) =>
    api().get(`/threads/${encodeURIComponent(threadName)}/request-id`),
  threadDump: () => api().get('/thread-dump'),
  executionRadar: () => api().get('/execution-radar'),
  fieldWatchpointAdd: (className, fieldName, onRead, onWrite) =>
    api().post('/watchpoints/field', null, { params: { className, fieldName, onRead, onWrite } }),
  fieldWatchpointRemove: (id) => api().delete(`/watchpoints/${encodeURIComponent(id)}`),
  fieldWatchpointsList: () => api().get('/watchpoints'),
  logs: (params = {}) =>
    api().get('/logs', {
      params: { limit: 100, filter: true, ...params },
    }),
  logEntries: (params = {}) => api().get('/logs/entries', { params: { filter: true, ...params } }),
  logsText: () => api().get('/logs/text', { responseType: 'text' }),
  logsClear: () => api().post('/logs/clear'),
  logsStatus: () => api().get('/logs/status'),
  logsAgent: () => api().get('/logs/agent'),
  exceptionBreakpoint: (enabled, exceptionClass) =>
    api().post('/exception-breakpoint', null, { params: { enabled, exceptionClass } }),
  waitForBreakpoint: (timeout, pollInterval) =>
    api().post('/wait-for-breakpoint', null, { params: { timeout, pollInterval } }),
}

/** No timeout: HTTP probe waits while the target JVM is paused on breakpoints (can be hours). Cancel in UI if needed. */
export const serverApi = axios.create({ timeout: 0, validateStatus: () => true })

/** Path only for `/api/server` proxy. If a full URL was pasted, use its pathname (demo base is already configured). */
export function normalizeServerProxyPath(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return '/'
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      const p = u.pathname + u.search
      return p || '/'
    } catch {
      /* ignore */
    }
  }
  return s.startsWith('/') ? s : `/${s}`
}

/** Same rules as App unwrap() for axios responses (used by HTTP probe with AbortSignal). */
export function unwrapServerProbeResponse(res) {
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
}

export function serverRequest(method, path, body, extraHeaders = {}, signal) {
  const b = base()
  const headers = { ...extraHeaders }
  if (body != null && typeof body === 'object' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  return serverApi.request({
    method,
    url: `${b}/api/server${path}`,
    data: body,
    headers: Object.keys(headers).length ? headers : undefined,
    ...(signal ? { signal } : {}),
  })
}
