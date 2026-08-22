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
  bpMinHits,
  setBpMinHits,
  bpType,
  setBpType,
  bpLogMessage,
  setBpLogMessage,
  bpCondition,
  setBpCondition,
  toggleBp,
  exportBps,
  importBpsFromFile,
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
                <label>Type</label>
                <select
                  value={bpType}
                  onChange={(e) => setBpType(e.target.value)}
                  style={{ padding: 6, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 11 }}
                >
                  <option value="line">Line (suspend)</option>
                  <option value="logpoint">Logpoint (trace, no pause)</option>
                  <option value="expression">Expression condition</option>
                  <option value="request">Request-ID conditional</option>
                </select>
              </div>
              {bpType === 'logpoint' && (
                <div className="input-row">
                  <label>Log message</label>
                  <input
                    value={bpLogMessage}
                    onChange={(e) => setBpLogMessage(e.target.value)}
                    placeholder="hit with {varName} tokens - thread never pauses"
                  />
                </div>
              )}
              {(bpType === 'expression' || bpType === 'logpoint') && (
                <div className="input-row">
                  <label>{bpType === 'logpoint' ? 'Condition (optional)' : 'Condition'}</label>
                  <input
                    value={bpCondition}
                    onChange={(e) => setBpCondition(e.target.value)}
                    placeholder={bpType === 'logpoint' ? 'optional - log only when true, e.g. a > 100' : 'e.g. a > 100 - suspends only when true'}
                  />
                </div>
              )}
              {bpType === 'request' && (
                <div className="input-row">
                  <label>Request ID</label>
                  <input
                    value={bpRequestId}
                    onChange={(e) => setBpRequestId(e.target.value)}
                    placeholder="only suspend requests with this X-Debug-Request-Id"
                  />
                </div>
              )}
              {bpType === 'line' && (
                <div className="input-row">
                  <label>Break after N hits</label>
                  <input
                    value={bpMinHits}
                    onChange={(e) => setBpMinHits(e.target.value.replace(/\D/g, ''))}
                    placeholder="optional — e.g. 5 suspends only on the 5th hit"
                  />
                </div>
              )}
              {bpType !== 'logpoint' && (
              <div className="input-row">
                <label>Trigger</label>
                <input
                  value={bpTriggerUrl}
                  onChange={(e) => setBpTriggerUrl(e.target.value)}
                  placeholder="optional GET URL to load class"
                />
              </div>
              )}
              <div className="toolbar">
                <button type="button" className="btn btn-primary" disabled={!connected || busy} onClick={addBreakpoint}>
                  {bpType === 'logpoint' ? 'Add logpoint'
                    : bpType === 'expression' ? 'Add expression BP'
                    : bpType === 'request' ? 'Add request BP'
                    : 'Add line breakpoint'}
                </button>
                <button type="button" className="btn" disabled={!connected || busy} onClick={clearBps}>
                  Remove all
                </button>
                <button type="button" className="btn" disabled={!connected || busy} onClick={toggleMute}>
                  {bpMuted ? 'Unmute all' : 'Mute all'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={!connected || busy} onClick={exportBps} title="Download breakpoints as JSON to share">
                  Export
                </button>
                <label className="btn btn-ghost" style={{ cursor: 'pointer', margin: 0 }} title="Import a breakpoints JSON file">
                  Import
                  <input
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0]
                      if (f) {
                        const reader = new FileReader()
                        reader.onload = () => importBpsFromFile(String(reader.result))
                        reader.readAsText(f)
                      }
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              <div className="bp-drawer__list-head">Active</div>
              <ul className="bp-drawer__list">
                {breakpoints.map((b) => {
                  const off = b.disabled
                  return (
                    <li key={b.id} className="bp-drawer__row" style={{ opacity: off ? 0.45 : 1 }}>
                      <span className="bp-drawer__loc" title={[b.logMessage && `log: ${b.logMessage}`, b.condition && `if: ${b.condition}`].filter(Boolean).join(' | ') || b.location || b.id}>
                        {b.logMessage ? `📝 ${b.location || b.id}` : b.condition ? `❓ ${b.location || b.id}` : (b.location || b.id)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        title={off ? 'Enable' : 'Disable'}
                        onClick={() => toggleBp(b.id, !!off)}
                      >
                        {off ? '◌' : '⏻'}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => removeBp(b.id)}>
                        ×
                      </button>
                    </li>
                  )
                })}
                {!breakpoints.length && <li className="bp-drawer__empty">No breakpoints</li>}
              </ul>
            </div>
          </>
        )}
      </div>
    </>
  )
}
