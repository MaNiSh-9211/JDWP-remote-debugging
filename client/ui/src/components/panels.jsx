import { useEffect, useState } from 'react'
import { Section, Btn, Pill } from './atoms.jsx'
import rest from './lib.js'

/* ---------------- Session ---------------- */
export function SessionPanel({ connected, host, port, setHost, setPort, onConnect, onDisconnect, loading, vmDescription, status }) {
  return (
    <div className="stack">
      <Section title="1 · Debug client">
        <label>API base</label>
        <input className="mono" value={rest.getBase()} readOnly />
        <div className="row" style={{ marginTop: 6 }}>
          <Btn kind="primary" onClick={() => rest.ping().then((r) => r.data?.ok && toastP())}>Ping</Btn>
        </div>
      </Section>

      <Section title="2 · Target JVM (JDWP)">
        <div className="toolbar wrap">
          {[['Local', 'localhost', '5005']].map(([l]) => (
            <button key={l} className={`btn btn--sm ${host === 'localhost' ? 'btn-primary' : ''}`}
              onClick={() => { setHost('localhost'); setPort('5005') }}>{l}</button>
          ))}
        </div>
        <div className="grid2">
          <div><label>Host</label><input className="mono" value={host} onChange={(e) => setHost(e.target.value)} disabled={connected} placeholder="localhost" /></div>
          <div><label>Port</label><input className="mono w80" value={port} onChange={(e) => setPort(e.target.value)} disabled={connected} /></div>
        </div>
        <div className="toolbar">
          <Btn kind="primary" disabled={loading || connected} onClick={onConnect}>Attach</Btn>
          <Btn disabled={!connected || loading} onClick={onDisconnect}>Detach</Btn>
        </div>
      </Section>
    </div>
  )
}
function toastP() {}

/* ---------------- Debugger (threads / frames / vars / eval) -------------- */
export function DebuggerPanel(p) {
  const {
    threads, selectedThread, setSelectedThread, frames, frameIndex, setFrameIndex,
    varsEnhanced, currentLocation, evalExpr, setEvalExpr, evalOut,
    runEval, step, resumeThread, suspendThread, continueVm, dropFrame,
    dbgToolbarBusy, connected,
  } = p
  const suspended = selectedThread && threads.find((t) => t.name === selectedThread)?.isSuspended
  return (
    <div className="stack">
      <Section title={`Threads${connected ? '' : ' (detached)'}`}>
        <select
          value={selectedThread || ''}
          onChange={(e) => setSelectedThread(e.target.value)}
          disabled={!connected}
        >
          <option value="">— select thread —</option>
          {threads.map((t) => (
            <option key={t.name} value={t.name}>
              {t.isSuspended ? '⏸ ' : '▶ '}{t.name}{t.atBreakpoint ? ' · BP' : ''}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Execution control">
        <div className="toolbar wrap">
          <Btn kind="primary" disabled={!suspended || dbgToolbarBusy} onClick={() => step('over')} title="F8">Step over</Btn>
          <Btn disabled={!suspended || dbgToolbarBusy} onClick={() => step('into')} title="F7">Step into</Btn>
          <Btn disabled={!suspended || dbgToolbarBusy} onClick={() => step('out')} title="Shift+F8">Step out</Btn>
          <Btn disabled={!suspended || dbgToolbarBusy} onClick={resumeThread}>Resume</Btn>
          <Btn disabled={!connected || dbgToolbarBusy} onClick={suspendThread}>Suspend</Btn>
          <Btn disabled={!connected || dbgToolbarBusy} onClick={continueVm}>Resume VM</Btn>
          <Btn kind="ghost" disabled={!suspended || dbgToolbarBusy}
            onClick={async () => {
              try {
                const res = await rest.resetFrame(selectedThread)
                p.toast(`Dropped ${res.data.poppedFrames ?? ''} frame(s)`)
              } catch (e) { p.toast('Drop frame failed', true) }
            }} title="Rewind to last app frame">↩ Drop frame</Btn>
        </div>
      </Section>

      {suspended && (
        <>
          {currentLocation && (
            <Section title="Current location">
              <div className="mono small">
                {currentLocation.className}.{currentLocation.methodName}:<b>{currentLocation.lineNumber}</b>
              </div>
            </Section>
          )}
          <Section title="Stack frames">
            <div className="frames">
              {(p.frameList || []).map((f, i) => (
                <div key={i} className={`list-row clickable ${i === p.frameIdx ? 'active' : ''}`}
                  onClick={() => p.setFrameIdx(i)}>
                  <span className="mono small">{i}. {f.className?.split('.').pop()}.{f.methodName}:{f.lineNumber}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Variables (frame 0)">
            <pre className="code-block small">{JSON.stringify(p.varsAtFrame ?? varsEnhanced ?? {}, null, 2).slice(0, 4000)}</pre>
          </Section>
          <Section title="Evaluate expression">
            <div className="toolbar">
              <input value={evalExpr} onChange={(e) => setEvalExpr(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runEval()}
                placeholder="e.g. a + 1, user.getName()" />
              <Btn kind="primary" onClick={runEval}>Run</Btn>
            </div>
            {evalOut && <pre className="code-block small">{evalOut}</pre>}
          </Section>
        </>
      )}
    </div>
  )
}

/* ---------------- Breakpoints ---------------- */
export function BpsPanel(p) {
  const [type, setType] = useState('line')
  const [cls, setCls] = useState('')
  const [line, setLine] = useState('')
  const [logMsg, setLogMsg] = useState('')
  const [cond, setCond] = useState('')
  const [reqId, setReqId] = useState('')
  const [minHits, setMinHits] = useState('')

  const add = async () => {
    if (!p.connected) return p.toast('Connect first', true)
    const lineNumber = parseInt(line, 10)
    if (!cls || Number.isNaN(lineNumber)) return p.toast('Class and line required', true)
    p.addBp({ type, cls, lineNumber, logMsg: logMsg.trim(), cond: cond.trim(), reqId: reqId.trim(), minHits: minHits })
    setLine('')
  }

  return (
    <div className="stack">
      <Section title="Add breakpoint">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="line">Line (suspend)</option>
          <option value="logpoint">Logpoint (trace, no pause)</option>
          <option value="expression">Expression condition</option>
          <option value="request">Request-ID scoped</option>
        </select>
        <input value={cls} onChange={(e) => setCls(e.target.value)} placeholder="com.example.Foo" />
        <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Line number" />

        {type === 'logpoint' && (
          <>
            <label>Log message</label>
            <input value={logMsg} onChange={(e) => setLogMsg(e.target.value)}
              placeholder={'{var} tokens supported'} />
            <label>Condition (optional)</label>
            <input value={cond} onChange={(e) => setCond(e.target.value)}
              placeholder='only log when true, e.g. amount > 1000' />
          </>
        )}
        {type === 'expression' && (
          <>
            <label>Condition</label>
            <input value={cond} onChange={(e) => setCond(e.target.value)}
              placeholder='a > 10 && status == "ok"' />
          </>
        )}
        {type === 'request' && (
          <>
            <label>Request ID</label>
            <input value={reqId} onChange={(e) => setReqId(e.target.value)}
              placeholder="X-Debug-Request-Id value" />
          </>
        )}
        {type === 'line' && (
          <>
            <label>Break after N hits (optional)</label>
            <input value={minHits} onChange={(e) => setMinHits(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 5" />
          </>
        )}
        <div className="toolbar">
          <Btn kind="primary" disabled={!p.connected || p.busy} onClick={add}>{labelFor(type)}</Btn>
        </div>
      </Section>

      <Section title={`Active (${p.breakpoints.length})`} right={
        <span className="card__right">
          <Btn kind="ghost" onClick={p.handleMuteAll} disabled={!p.connected}>
            {p.bpMuted ? 'Unmute all' : 'Mute all'}
          </Btn>
          <Btn kind="ghost" onClick={p.handleExportBps} disabled={!p.breakpoints.length}>Export</Btn>
          <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
            Import
            <input type="file" accept=".json" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) f.text().then(p.handleImportBpsText) }} />
          </label>
        </span>
      }>
        {!p.breakpoints.length ? <div className="hint">No breakpoints.</div> :
          p.breakpoints.map((b) => (
            <div key={b.id} className={`list-row ${b.disabled ? 'dim' : ''}`}>
              <span className="mono small grow"
                title={[b.logMessage && `log: ${b.logMessage}`, b.condition && `if ${b.condition}`].filter(Boolean).join(' | ')}>
                {b.logMessage ? `📝 ${b.id}` : b.condition ? `❓ ${b.id}` : b.id}
              </span>
              <Btn kind="ghost" onClick={() => p.handleToggleBp(b.id, !!b.disabled)}>{b.disabled ? '◌ enable' : '⏻ disable'}</Btn>
              <Btn kind="ghost" onClick={() => p.handleRemoveBp(b.id)}>✕</Btn>
            </div>
          ))}
      </Section>
    </div>
  )
}
function labelFor(t) {
  return t === 'logpoint' ? 'Add logpoint' : t === 'expression' ? 'Add expression BP'
    : t === 'request' ? 'Add request BP' : 'Add line breakpoint'
}

/* ---------------- TimeLens ---------------- */
export function TimeLensPanel(p) {
  return (
    <div className="stack">
      <Section title="TimeLens recorder" right={p.recording ? <span className="rec-badge">● RECORDING</span> : null}>
        <label>Probes (one Class:line per line)</label>
        <textarea rows={4} value={p.locations} onChange={(e) => p.setLocations(e.target.value)}
          placeholder={'com.example.Foo:31\ncom.example.Bar:88'} />
        <div className="toolbar">
          <Btn kind="primary" disabled={!p.connected || !p.locations.trim()} onClick={p.start}>Start recording</Btn>
          <Btn disabled={!p.recording} onClick={p.stop}>Stop</Btn>
          <Btn kind="ghost" onClick={p.refresh}>Refresh</Btn>
        </div>
      </Section>

      {p.steps.length > 0 && (
        <Section title={`Timeline (${p.steps.length} steps)`}>
          {p.steps.map((s, i) => {
            const prev = i > 0 ? p.steps[i - 1] : null
            const delta = i > 0 ? s.timestamp - prev.timestamp : null
            return (
              <div key={`${s.timestamp}-${i}`} className="step">
                <div className="step__head mono">
                  <b>#{i + 1}</b>
                  <span className="grow">{s.class}.{s.method}:<b>{s.line}</b></span>
                  {delta != null && delta >= 0 && <span className="delta">+{delta}ms</span>}
                </div>
                {s.locals && Object.keys(s.locals).length > 0 && (
                  <div className="locals mono">
                    {Object.entries(s.locals).map(([k, v]) => {
                      const changed = prev && prev.locals?.[k] !== v
                      return <div key={k} className={changed ? 'changed' : ''}>{k} = {v}</div>
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </Section>
      )}
    </div>
  )
}
