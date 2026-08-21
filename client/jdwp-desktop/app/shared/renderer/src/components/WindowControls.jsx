import { useEffect, useState } from 'react'

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  const wc = typeof window !== 'undefined' ? window.jdwpElectron?.windowControls : null

  useEffect(() => {
    const unsub = window.jdwpElectron?.onWindowState?.((s) => {
      if (s && typeof s.maximized === 'boolean') setMaximized(s.maximized)
    })
    return typeof unsub === 'function' ? unsub : undefined
  }, [])

  if (!wc) {
    return (
      <div className="window-controls window-controls--placeholder" aria-hidden>
        <span className="window-controls__hint">Web</span>
      </div>
    )
  }

  return (
    <div className="window-controls" role="toolbar" aria-label="Window">
      <button type="button" className="window-btn window-btn--min" title="Minimize" onClick={() => wc.minimize()}>
        <span className="window-ico window-ico--min" />
      </button>
      <button
        type="button"
        className="window-btn window-btn--max"
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => wc.toggleMaximize()}
      >
        <span className={maximized ? 'window-ico window-ico--restore' : 'window-ico window-ico--max'} />
      </button>
      <button type="button" className="window-btn window-btn--close" title="Close" onClick={() => wc.close()}>
        <span className="window-ico window-ico--close" />
      </button>
    </div>
  )
}
