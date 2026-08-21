const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jdwpElectron', {
  defaultApiBase: () => ipcRenderer.invoke('get-default-api-base'),
  sanitizeApiBase: (url) => ipcRenderer.invoke('sanitize-api-base', url),
  readTextFileAllowed: (filePath) => ipcRenderer.invoke('read-text-file-allowed', filePath),
  getSuggestedSourceRoot: () => ipcRenderer.invoke('get-suggested-source-root'),
  pickSourceRoot: (defaultPath) => ipcRenderer.invoke('pick-source-root', defaultPath),
  normalizeSourceRootPath: (p) => ipcRenderer.invoke('normalize-source-root-path', p),
  readSourceUnderRoot: (root, relPath) => ipcRenderer.invoke('read-source-under-root', root, relPath),
  listDirUnderRoot: (root, relPath) => ipcRenderer.invoke('list-dir-under-root', root, relPath),
  gitCloneRepo: (opts) => ipcRenderer.invoke('git-clone-repo', opts),
  platform: process.platform,
  windowControls: {
    minimize: () => ipcRenderer.invoke('win-minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win-toggle-maximize'),
    close: () => ipcRenderer.invoke('win-close'),
  },
  onWindowState: (fn) => {
    const handler = (_, state) => {
      try {
        fn(state)
      } catch {
        /* ignore */
      }
    }
    ipcRenderer.on('window-state', handler)
    return () => ipcRenderer.removeListener('window-state', handler)
  },
  kubeContexts: (opts) => ipcRenderer.invoke('kube-context-list', opts),
  clusterExec: (payload) => ipcRenderer.invoke('cluster-exec', payload),
  kindJdwpForward: (opts) => ipcRenderer.invoke('kind-jdwp-forward', opts),
  kindJdwpForwardStop: () => ipcRenderer.invoke('kind-jdwp-forward-stop'),
  kindJdwpForwardStatus: () => ipcRenderer.invoke('kind-jdwp-forward-status'),
  podJdwpForward: (opts) => ipcRenderer.invoke('pod-jdwp-forward', opts),
  podJdwpForwardStop: (opts) => ipcRenderer.invoke('pod-jdwp-forward-stop', opts),
  podJdwpForwardStatus: () => ipcRenderer.invoke('pod-jdwp-forward-status'),
  gitListRepos: (opts) => ipcRenderer.invoke('git-list-repos', opts),
})
