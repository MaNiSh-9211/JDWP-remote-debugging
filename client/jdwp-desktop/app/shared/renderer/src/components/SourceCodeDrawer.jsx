import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  candidateJavaRelPaths,
  parseBreakpointLocation,
  relJavaPathToFqcn,
} from '../utils/javaSourcePaths.js'

function activeDebugLocation(frames, frameIndex, sourceLoc) {
  const f = frames?.[frameIndex]
  if (f && (f.class || f.className) && f.lineNumber != null && f.lineNumber > 0) {
    return {
      className: f.class || f.className,
      lineNumber: f.lineNumber,
      sourceName: f.sourceName,
      methodName: f.method,
    }
  }
  if (sourceLoc && typeof sourceLoc === 'object') {
    return {
      className: sourceLoc.className,
      lineNumber: sourceLoc.lineNumber,
      sourceName: sourceLoc.sourceName,
      methodName: sourceLoc.methodName,
    }
  }
  return null
}

function TreeNode({
  relPath,
  name,
  isDirectory,
  depth,
  sourceRoot,
  electron,
  expanded,
  toggle,
  cache,
  ensureLoaded,
  onOpenJava,
}) {
  const key = relPath || '.'
  const isOpen = expanded.has(key)
  const kids = cache[key]

  return (
    <div className="source-tree__node">
      <button
        type="button"
        className={`source-tree__row source-tree__row--depth-${Math.min(depth, 8)}`}
        onClick={async () => {
          if (isDirectory) {
            if (!isOpen) await ensureLoaded(key)
            toggle(key)
          } else if (name.endsWith('.java')) {
            onOpenJava(relPath)
          }
        }}
      >
        <span className="source-tree__chevron">{isDirectory ? (isOpen ? '▼' : '▶') : ' '}</span>
        <span className="source-tree__name">{name}</span>
      </button>
      {isDirectory && isOpen && kids?.length ? (
        <div className="source-tree__kids">
          {kids.map((e) => (
            <TreeNode
              key={e.relPath}
              relPath={e.relPath}
              name={e.name}
              isDirectory={e.isDirectory}
              depth={depth + 1}
              sourceRoot={sourceRoot}
              electron={electron}
              expanded={expanded}
              toggle={toggle}
              cache={cache}
              ensureLoaded={ensureLoaded}
              onOpenJava={onOpenJava}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function SourceCodeDrawer({
  open,
  onClose,
  width,
  onWidthChange,
  stacked = false,
  panelToggles = null,
  sourceRoot,
  setSourceRoot,
  frames,
  frameIndex,
  sourceLoc,
  connected,
  breakpoints,
  toggleBreakpointAtSource,
  evaluateFromSource,
}) {
  const [pathInput, setPathInput] = useState('')
  const [status, setStatus] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [gitBusy, setGitBusy] = useState(false)

  const [treeWidth, setTreeWidth] = useState(() => {
    const w = parseInt(localStorage.getItem('jdwp-source-tree-w') || '248', 10)
    return Number.isFinite(w) ? Math.min(420, Math.max(160, w)) : 248
  })
  const [fileContent, setFileContent] = useState('')
  const [resolvedRel, setResolvedRel] = useState('')
  const [fileLoadErr, setFileLoadErr] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)

  const [expanded, setExpanded] = useState(() => new Set())
  const [dirCache, setDirCache] = useState({})
  const [evalBubble, setEvalBubble] = useState(null)

  const treeSplitRef = useRef(null)
  const editorViewportRef = useRef(null)
  const dragTree = useRef({ startX: 0, startW: 0 })

  const electron = typeof window !== 'undefined' ? window.jdwpElectron : null
  const loc = useMemo(() => activeDebugLocation(frames, frameIndex, sourceLoc), [frames, frameIndex, sourceLoc])

  const openFqcn = useMemo(() => relJavaPathToFqcn(resolvedRel), [resolvedRel])

  const bpLinesForFile = useMemo(() => {
    if (!openFqcn || !breakpoints?.length) return new Set()
    const s = new Set()
    for (const b of breakpoints) {
      const p = parseBreakpointLocation(b.location || b.id)
      if (p && p.className === openFqcn) s.add(p.lineNumber)
    }
    return s
  }, [breakpoints, openFqcn])

  useEffect(() => {
    localStorage.setItem('jdwp-source-tree-w', String(treeWidth))
  }, [treeWidth])

  useEffect(() => {
    if (!open) return
    setPathInput((sourceRoot || '').trim())
  }, [open, sourceRoot])

  useEffect(() => {
    if (!open || !sourceRoot?.trim()) {
      setDirCache({})
      setExpanded(new Set())
      return
    }
    setDirCache({})
    setExpanded(new Set(['.']))
    ;(async () => {
      const r = await electron?.listDirUnderRoot?.(sourceRoot.trim(), '.')
      if (r?.ok) setDirCache({ '.': r.entries })
    })()
  }, [open, sourceRoot, electron])

  const ensureLoaded = useCallback(
    async (dirKey) => {
      if (!sourceRoot?.trim() || !electron?.listDirUnderRoot) return
      if (dirCache[dirKey]) return
      const r = await electron.listDirUnderRoot(sourceRoot.trim(), dirKey)
      if (r?.ok) setDirCache((c) => ({ ...c, [dirKey]: r.entries }))
    },
    [sourceRoot, electron, dirCache],
  )

  const toggleExpand = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const openFileByRel = useCallback(
    async (relPath) => {
      if (!sourceRoot?.trim() || !electron?.readSourceUnderRoot) return
      setLoadingFile(true)
      setFileLoadErr('')
      try {
        const r = await electron.readSourceUnderRoot(sourceRoot.trim(), relPath)
        if (r?.ok && typeof r.content === 'string') {
          setFileContent(r.content)
          setResolvedRel(r.resolvedRel || relPath)
        } else {
          setFileContent('')
          setResolvedRel('')
          setFileLoadErr(r?.error || 'Could not open file')
        }
      } catch (e) {
        setFileLoadErr(e?.message || String(e))
      } finally {
        setLoadingFile(false)
      }
    },
    [electron, sourceRoot],
  )

  const loadFileForDebugLoc = useCallback(async () => {
    if (!open || !sourceRoot?.trim() || !loc?.className) return
    if (!electron?.readSourceUnderRoot) return
    setLoadingFile(true)
    setFileLoadErr('')
    try {
      const paths = candidateJavaRelPaths(loc.className)
      for (const rel of paths) {
        const r = await electron.readSourceUnderRoot(sourceRoot.trim(), rel)
        if (r?.ok && typeof r.content === 'string') {
          setFileContent(r.content)
          setResolvedRel(r.resolvedRel || rel)
          setLoadingFile(false)
          return
        }
      }
      setFileLoadErr('Source file not found under this root for ' + loc.className)
    } catch (e) {
      setFileLoadErr(e?.message || String(e))
    } finally {
      setLoadingFile(false)
    }
  }, [open, sourceRoot, loc, electron])

  useEffect(() => {
    loadFileForDebugLoc()
  }, [loadFileForDebugLoc])

  const commitOpenPath = useCallback(async () => {
    const t = pathInput.trim()
    if (!t) {
      setStatus('Paste a folder path.')
      return
    }
    if (!electron?.normalizeSourceRootPath) {
      setStatus('Requires JDWP Studio (Electron).')
      return
    }
    const r = await electron.normalizeSourceRootPath(t)
    if (r?.ok && r.path) {
      setSourceRoot(r.path)
      localStorage.setItem('jdwp-source-root', r.path)
      setPathInput(r.path)
      setStatus('')
      setFileContent('')
      setResolvedRel('')
    } else setStatus(r?.error || 'Invalid path')
  }, [electron, pathInput, setSourceRoot])

  const onDropRoot = async (e) => {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    const p = f?.path
    if (!p || !electron?.normalizeSourceRootPath) {
      setStatus('Drop a folder from Explorer (Electron).')
      return
    }
    const r = await electron.normalizeSourceRootPath(p)
    if (r?.ok && r.path) {
      setSourceRoot(r.path)
      localStorage.setItem('jdwp-source-root', r.path)
      setPathInput(r.path)
      setStatus('')
    } else setStatus(r?.error || 'Invalid path')
  }

  const runGitClone = async () => {
    const u = gitUrl.trim()
    if (!u) {
      setStatus('Paste a git URL.')
      return
    }
    if (!electron?.gitCloneRepo) {
      setStatus('Git clone needs Electron + git on PATH.')
      return
    }
    setGitBusy(true)
    setStatus('Cloning…')
    try {
      const r = await electron.gitCloneRepo({ url: u })
      if (r?.ok && r.path) {
        setSourceRoot(r.path)
        localStorage.setItem('jdwp-source-root', r.path)
        setPathInput(r.path)
        setGitUrl('')
        setStatus('Cloned — tree refreshed.')
      } else setStatus(r?.error || 'Clone failed')
    } catch (err) {
      setStatus(err?.message || String(err))
    } finally {
      setGitBusy(false)
    }
  }

  const onGutterClick = async (lineNum) => {
    const fqcn = openFqcn
    if (!fqcn) {
      setStatus('Open a .java file from the tree (need classpath path).')
      return
    }
    if (!connected) {
      setStatus('Connect JDWP first.')
      return
    }
    await toggleBreakpointAtSource(fqcn, lineNum)
  }

  const onEditorMouseUp = () => {
    const sel = window.getSelection()?.toString()?.trim()
    if (sel && sel.length < 4000) {
      try {
        const range = window.getSelection().getRangeAt(0)
        const rect = range.getBoundingClientRect()
        setEvalBubble({ text: sel, top: rect.bottom + 4, left: rect.left })
      } catch {
        setEvalBubble({ text: sel, top: 120, left: 120 })
      }
    } else setEvalBubble(null)
  }

  const onTreeSplitDown = (e) => {
    e.preventDefault()
    dragTree.current = { startX: e.clientX, startW: treeWidth }
    const onMove = (ev) => {
      const dx = ev.clientX - dragTree.current.startX
      const next = Math.min(420, Math.max(160, dragTree.current.startW + dx))
      setTreeWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const outerResizeDown = useCallback(
    (e) => {
      if (stacked) return
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      const onMove = (ev) => {
        const dx = startX - ev.clientX
        const next = Math.min(960, Math.max(380, startW + dx))
        onWidthChange(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [width, onWidthChange, stacked],
  )

  const lines = useMemo(() => (fileContent ? fileContent.split(/\r?\n/) : []), [fileContent])
  const execLine = loc?.className && openFqcn === loc.className && loc.lineNumber > 0 ? loc.lineNumber : 0

  useEffect(() => {
    if (!open || !execLine) return
    const vp = editorViewportRef.current
    const lineEl = document.getElementById('jdwp-source-exec-line')
    if (!vp || !lineEl) return
    const vpr = vp.getBoundingClientRect()
    const lr = lineEl.getBoundingClientRect()
    const lineCenterY = lr.top + lr.height / 2 - vpr.top + vp.scrollTop
    const targetTop = Math.max(0, lineCenterY - vp.clientHeight / 2)
    vp.scrollTo({ top: targetTop, behavior: 'smooth' })
  }, [open, fileContent, execLine, loc?.lineNumber, resolvedRel, loc?.className])

  useEffect(() => {
    if (!evalBubble) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setEvalBubble(null)
    }
    const onDocClick = (e) => {
      if (e.target.closest?.('.source-eval-bubble')) return
      setEvalBubble(null)
    }
    document.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => document.addEventListener('click', onDocClick), 0)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onDocClick)
    }
  }, [evalBubble])

  return (
    <div
      className={`source-drawer ${open ? 'source-drawer--open' : ''}${stacked ? ' source-drawer--stacked' : ''}`}
      style={stacked ? { width: '100%' } : { width: open ? width : 0 }}
      aria-hidden={!open}
    >
      {open && (
        <>
          {!stacked ? (
            <div
              className="source-drawer__resize source-drawer__resize--outer"
              onMouseDown={outerResizeDown}
              title="Drag to resize panel"
              role="separator"
              aria-orientation="vertical"
            />
          ) : null}
          <div
            className={`source-drawer__inner source-drawer__inner--workspace${stacked ? ' source-drawer__inner--stacked' : ''}`}
          >
            <header className="source-drawer__head source-drawer__head--compact">
              <h3 className="source-drawer__title">Source</h3>
              <div className="drawer-head-actions">
                {panelToggles}
                <button type="button" className="btn source-drawer__close" onClick={onClose}>
                  ×
                </button>
              </div>
            </header>

            <div className="source-drawer__bar">
              <input
                className="source-drawer__path-input source-drawer__path-input--bar"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitOpenPath()}
                placeholder="Folder path…"
                spellCheck={false}
              />
              <button type="button" className="btn btn-primary btn--sm" onClick={commitOpenPath}>
                Open
              </button>
            </div>
            <div
              className="source-drawer__dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDropRoot}
            >
              Drop folder to open
            </div>
            <div className="source-drawer__bar source-drawer__bar--git">
              <input
                className="source-drawer__path-input source-drawer__path-input--bar"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                spellCheck={false}
              />
              <button type="button" className="btn btn--sm" disabled={gitBusy} onClick={runGitClone}>
                {gitBusy ? '…' : 'Clone'}
              </button>
            </div>
            {status ? <p className="source-drawer__status">{status}</p> : null}
            {fileLoadErr ? <p className="source-drawer__err source-drawer__err--inline">{fileLoadErr}</p> : null}

            <div className="source-workspace" ref={treeSplitRef}>
              <aside className="source-workspace__tree scroll-y" style={{ width: treeWidth, flex: 'none' }}>
                {!sourceRoot?.trim() ? (
                  <p className="source-tree__empty">Open or clone a project</p>
                ) : (
                  <TreeNode
                    relPath=""
                    name="/"
                    isDirectory
                    depth={0}
                    sourceRoot={sourceRoot}
                    electron={electron}
                    expanded={expanded}
                    toggle={toggleExpand}
                    cache={dirCache}
                    ensureLoaded={ensureLoaded}
                    onOpenJava={openFileByRel}
                  />
                )}
              </aside>
              <div
                className="source-workspace__split"
                onMouseDown={onTreeSplitDown}
                role="separator"
                aria-label="Resize tree"
              />
              <section className="source-workspace__editor">
                <div className="source-editor__title mono">{resolvedRel || '—'}</div>
                <div
                  ref={editorViewportRef}
                  className="source-editor__viewport scroll-y"
                  onMouseUp={onEditorMouseUp}
                >
                  {loadingFile ? (
                    <div className="source-editor__placeholder">Loading…</div>
                  ) : lines.length ? (
                    <div className="source-editor__lines">
                      {lines.map((line, i) => {
                        const n = i + 1
                        const isExec = execLine === n
                        const hasBp = bpLinesForFile.has(n)
                        return (
                          <div
                            key={i}
                            id={isExec ? 'jdwp-source-exec-line' : undefined}
                            className={`source-editor__line${isExec ? ' source-editor__line--exec' : ''}`}
                          >
                            <button
                              type="button"
                              className={`source-editor__gutter${hasBp ? ' source-editor__gutter--bp' : ''}`}
                              title={connected ? 'Toggle breakpoint' : 'Connect JDWP to toggle'}
                              onClick={(e) => {
                                e.stopPropagation()
                                onGutterClick(n)
                              }}
                            >
                              <span className="source-editor__gutter-num">{n}</span>
                              {hasBp ? <span className="source-editor__bp-dot">●</span> : null}
                            </button>
                            <span className="source-editor__code">{line || ' '}</span>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="source-editor__placeholder">
                      Pick a .java file or run the debugger — execution line follows steps.
                    </div>
                  )}
                </div>
              </section>
            </div>

            {evalBubble ? (
              <div
                className="source-eval-bubble"
                style={{ top: evalBubble.top, left: evalBubble.left }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="btn btn-primary btn--sm"
                  onClick={() => {
                    evaluateFromSource(evalBubble.text)
                    setEvalBubble(null)
                  }}
                >
                  Evaluate in Debug
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
