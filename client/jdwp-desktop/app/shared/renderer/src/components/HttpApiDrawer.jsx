import { useCallback, useRef, useState } from 'react'

const TABS = [
  { id: 'request', label: 'Request' },
  { id: 'headers', label: 'Headers' },
  { id: 'auth', label: 'Auth' },
  { id: 'history', label: 'History' },
]

export default function HttpApiDrawer({
  open,
  onClose,
  width,
  onWidthChange,
  stacked = false,
  panelToggles = null,
  probeMethod,
  setProbeMethod,
  probePath,
  setProbePath,
  probeBody,
  setProbeBody,
  probeHeadersStr,
  setProbeHeadersStr,
  authBearer,
  setAuthBearer,
  probeOut,
  runProbe,
  cancelProbe,
  busy,
  onSaveHistory,
  historyItems,
  onApplyHistory,
  onClearHistory,
}) {
  const [tab, setTab] = useState('request')
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
        const next = Math.min(720, Math.max(300, startW.current + dx))
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
        className={`http-drawer ${open ? 'http-drawer--open' : ''}${stacked ? ' http-drawer--stacked' : ''}`}
        style={stacked ? { width: '100%' } : { width: open ? width : 0 }}
        aria-hidden={!open}
      >
        {open && (
          <>
            {!stacked ? (
              <div
                className="http-drawer__resize"
                onMouseDown={onResizeDown}
                title="Drag to resize width"
                role="separator"
                aria-orientation="vertical"
              />
            ) : null}
            <div className={`http-drawer__inner${stacked ? ' http-drawer__inner--stacked' : ''}`}>
              <div className="http-drawer__head">
                <div>
                  <h3 className="http-drawer__title">HTTP console</h3>
                  <p className="http-drawer__sub">Spring proxy → target app</p>
                </div>
                <div className="drawer-head-actions">
                  {panelToggles}
                  <button type="button" className="btn http-drawer__close" onClick={onClose}>
                    ✕
                  </button>
                </div>
              </div>
              <div className="http-drawer__tabs">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`http-tab ${tab === t.id ? 'http-tab--active' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="http-drawer__middle scroll-y">
              <div className="http-drawer__panel">
                {tab === 'request' && (
                  <>
                    <div className="http-toolbar-wrap">
                      <p className="http-toolbar-hint">
                        Probe has <strong>no time limit</strong> while the server thread is paused. Use <strong>Cancel</strong> or Send again if needed; resume the VM to finish the call.
                      </p>
                      <div className="toolbar http-toolbar">
                      <select
                        value={probeMethod}
                        onChange={(e) => setProbeMethod(e.target.value)}
                        className="http-method-select"
                      >
                        <option>GET</option>
                        <option>POST</option>
                        <option>PUT</option>
                        <option>PATCH</option>
                        <option>DELETE</option>
                      </select>
                      <input
                        className="http-path-input"
                        value={probePath}
                        onChange={(e) => setProbePath(e.target.value)}
                        placeholder="/api/users (path only — not full URL)"
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        title="Aborts any in-flight probe and sends again"
                        onClick={() => {
                          runProbe()
                          onSaveHistory?.()
                        }}
                      >
                        {busy ? 'Send (abort prev)' : 'Send'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={!busy}
                        title="Stop waiting for the HTTP response"
                        onClick={() => cancelProbe?.()}
                      >
                        Cancel
                      </button>
                    </div>
                    </div>
                    <label className="http-field-label">Body (JSON)</label>
                    <textarea
                      className="http-textarea"
                      value={probeBody}
                      onChange={(e) => setProbeBody(e.target.value)}
                      placeholder='{"name":"test"}'
                      rows={6}
                    />
                  </>
                )}
                {tab === 'headers' && (
                  <>
                    <p className="http-help">
                      One per line: <code>Header-Name: value</code>
                    </p>
                    <textarea
                      className="http-textarea"
                      value={probeHeadersStr}
                      onChange={(e) => setProbeHeadersStr(e.target.value)}
                      placeholder={'Accept: application/json\nX-Request-Id: debug-1'}
                      rows={10}
                    />
                  </>
                )}
                {tab === 'auth' && (
                  <>
                    <p className="http-help">
                      Sends <code>Authorization: Bearer …</code> on each request.
                    </p>
                    <div className="input-row">
                      <label>Token</label>
                      <input
                        value={authBearer}
                        onChange={(e) => setAuthBearer(e.target.value)}
                        placeholder="Bearer token (optional)"
                      />
                    </div>
                  </>
                )}
                {tab === 'history' && (
                  <>
                    <div className="toolbar">
                      <button type="button" className="btn btn-ghost" onClick={onClearHistory}>
                        Clear
                      </button>
                    </div>
                    <ul className="http-history-list">
                      {(historyItems || []).map((h, i) => (
                        <li key={`${h.path}-${i}`}>
                          <button type="button" className="http-history-item" onClick={() => onApplyHistory(h)}>
                            <span className="http-history-method">{h.method}</span>
                            <span className="http-history-path">{h.path}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!historyItems?.length && <p className="http-help">History fills after you Send from Request.</p>}
                  </>
                )}
              </div>
              </div>
              <div className="http-drawer__response">
                <div className="http-field-label">Last response</div>
                <pre className="mono-block http-response-block">{probeOut || '—'}</pre>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}
