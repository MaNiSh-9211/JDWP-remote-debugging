// Central API surface - one function per server endpoint.
import api, { k8s } from './lib.js'

const q = (params) => ({ params })

export const rest = {
  ping: () => api.get('/ping'),
  status: () => api.get('/status'),
  connect: (host, port) => api.post('/connect', null, { params: { host, port } }),
  disconnect: () => api.post('/disconnect'),
  threads: () => api.get('/threads'),
  frames: (t) => api.get(`/threads/${encodeURIComponent(t)}/frames`),
  variablesEnhanced: (t) => api.get(`/threads/${encodeURIComponent(t)}/variables-enhanced`),
  sourceLocation: (t) => api.get(`/threads/${encodeURIComponent(t)}/source-location`),
  evaluate: (t, expr, frameIndex) =>
    api.post(`/threads/${encodeURIComponent(t)}/evaluate`, null,
      frameIndex != null ? { params: { expression: expr, frameIndex } } : { params: { expression: expr } }),
  stepOver: (t) => api.post(`/threads/${encodeURIComponent(t)}/step-over`),
  stepInto: (t) => api.post(`/threads/${encodeURIComponent(t)}/step-into`),
  stepOut: (t) => api.post(`/threads/${encodeURIComponent(t)}/step-out`),
  resumeThread: (t) => api.post(`/threads/${encodeURIComponent(t)}/resume`),
  suspendThread: (t) => api.post(`/threads/${encodeURIComponent(t)}/suspend`),
  continueVm: () => api.post('/continue'),
  resetFrame: (t, prefix) =>
    api.post(`/threads/${encodeURIComponent(t)}/reset-frame`, null,
      prefix ? { params: { applicationPackagePrefix: prefix } } : {}),
  listBps: () => api.get('/breakpoints'),
  addBp: (className, lineNumber) => api.post('/breakpoints', null, { params: { className, lineNumber } }),
  advancedBp: (payload) => api.post('/breakpoints/advanced', payload),
  requestBp: (className, lineNumber, targetRequestId) =>
    api.post('/breakpoints/conditional', null, { params: { className, lineNumber, targetRequestId } }),
  toggleBp: (id, enabled) => api.post('/breakpoints/toggle', { id, enabled }),
  removeBp: (id) => api.delete(`/breakpoints/${encodeURIComponent(id)}`),
  removeAllBps: () => api.delete('/breakpoints'),
  muteAll: (muted) => api.post('/breakpoints/mute', null, { params: { muted } }),
  hitStats: () => api.get('/breakpoints/hit-stats'),
  threadDump: () => api.get('/thread-dump'),
  radar: () => api.get('/execution-radar'),
  logsEntries: (limit = 100) => api.get(`/logs/entries?limit=${limit}`),
  panic: () => api.post('/panic'),
  recorderStart: (sessionKey, locations) => api.post('/recorder/start', { sessionKey, locations }),
  recorderStop: (k) => api.post(`/recorder/${encodeURIComponent(k)}/stop`),
  recorderGet: (k) => api.get(`/recorder/${encodeURIComponent(k)}`),
}

export const k8sApi = {
  contexts: (kc) => k8s.get('/contexts', kc ? q({ kubeconfig: kc }) : {}),
  namespaces: (kc, ctx) => k8s.get('/namespaces', q({ ...(kc ? { kubeconfig: kc } : {}), ...(ctx ? { context: ctx } : {}) })),
  pods: (kc, ctx, ns) => k8s.get('/pods', q({ ...(kc ? { kubeconfig: kc } : {}), ...(ctx ? { context: ctx } : {}), namespace: ns })),
  podLogs: (kc, ctx, ns, pod, tail = 100) =>
    k8s.get('/logs', q({ ...(kc ? { kubeconfig: kc } : {}), ...(ctx ? { context: ctx } : {}), namespace: ns, pod, tail })),
  forward: (p) => k8s.post('/forward', p),
  forwards: () => k8s.get('/forwards'),
  stopForward: (localPort) => k8s.delete(`/forward/${localPort}`),
  uploadKubeconfig: (content) => k8s.post('/kubeconfig', { content }),
}
