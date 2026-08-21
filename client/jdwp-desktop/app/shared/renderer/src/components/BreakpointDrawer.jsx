import { useCallback, useRef } from 'react'

export default function BreakpointDrawer({
  open,
  onClose,
  width,
  onWidthChange,
  stacked = false,
  panelToggles = null,
  bpClass,
  setBpClass,
  bpLine,
  setBpLine,
  bpTriggerUrl,
  setBpTriggerUrl,
  bpRequestId,
  setBpRequestId,
  addBreakpoint,
  clearBps,
  toggleMute,
  bpMuted,
  breakpoints,
  removeBp,
  connected,
  busy,
}) {
  const startX = useRef(0)
  const startW = useRef(0)

  const onResizeDown = useCallback(
    (e) => {
      if (stacked) return
      e.preventDefault()
      startX.current = e.clientX
      startW.current = width
      const onMove = (ev) => {
        const dx = startX.current - ev.clientX
        const next = Math.min(640, Math.max(280, startW.current + dx))
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

  return (
    <>
      <div
        className={`bp-drawer ${open ? 'bp-drawer--open' : ''}${stacked ? ' bp-drawer--stacked' : ''}`}
        style={stacked ? { width: '100%' } : { width: open ? width : 0 }}
        aria-hidden={!open}
      >
        {open && (
          <>
            {!stacked ? (
              <div
                className="bp-drawer__resize"
                onMouseDown={onResizeDown}
                title="Drag to resize"
                role="separator"
                aria-orientation="vertical"
              />
            ) : null}
            <div className={`bp-drawer__inner scroll-y${stacked ? ' bp-drawer__inner--stacked' : ''}`}>
              <div className="bp-drawer__head">
                <div>
                  <h3 className="bp-drawer__title">Breakpoints</h3>
                  <p className="bp-drawer__sub">Line breakpoints · same as IDE gutter</p>
                </div>
                <div className="drawer-head-actions">
                  {panelToggles}
                  <button type="button" className="btn bp-drawer__close" onClick={onClose}>
                    ✕
                  </button>
                </div>
              </div>
              <p className="bp-drawer__hint">
                Conditional, method, field &amp; exception breakpoints stay under <strong>Breakpoints</strong> in the left nav.
              </p>
              <div className="input-row">
                <label>Class</label>
                <input value={bpClass} onChange={(e) => setBpClass(e.target.value)} placeholder="com.example.Foo" />
              </div>
              <div className="input-row">
                <label>Line</label>
                <input value={bpLine} onChange={(e) => setBpLine(e.target.value)} placeholder="42" />
              </div>
              <div className="input-row">
                <label>Trigger</label>
                <input
                  value={bpTriggerUrl}
                  onChange={(e) => setBpTriggerUrl(e.target.value)}
                  placeholder="optional GET URL to load class"
                />
              </div>
              <div className="input-row">
                <label>Request ID (conditional)</label>
                <input
                  value={bpRequestId}
                  onChange={(e) => setBpRequestId(e.target.value)}
                  placeholder="optional — only suspend requests with this X-Debug-Request-Id"
                />
              </div>
              <div className="toolbar">
                <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={addBreakpoint}>
                  {bpRequestId.trim() ? 'Add conditional breakpoint' : 'Add line breakpoint'}
                </button>
                <button type="button" className="btn" disabled={!connected || busy} onClick={clearBps}>
                  Remove all
                </button>
                <button type="button" className="btn" disabled={!connected || busy} onClick={toggleMute}>
                  {bpMuted ? 'Unmute' : 'Mute'}
                </button>
              </div>
              <div className="bp-drawer__list-head">Active</div>
              <ul className="bp-drawer__list">
                {breakpoints.map((b) => (
                  <li key={b.id} className="bp-drawer__row">
                    <span className="bp-drawer__loc">{b.location || b.id}</span>
                    <button type="button" className="btn btn-ghost" onClick={() => removeBp(b.id)}>
                      ×
                    </button>
                  </li>
                ))}
                {!breakpoints.length && <li className="bp-drawer__empty">No breakpoints</li>}
              </ul>
            </div>
          </>
        )}
      </div>
    </>
  )
}
