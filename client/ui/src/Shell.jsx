import { useState } from 'react'

const NAV = [
  { id: 'session', label: 'Session', icon: '⏻' },
  { id: 'breakpoints', label: 'Breakpoints', icon: '⏸' },
  { id: 'threads', label: 'Threads & Scope', icon: '🧵' },
  { id: 'logs', label: 'Live Logs', icon: '📜' },
  { id: 'timelens', label: 'TimeLens', icon: '⏱' },
  { id: 'cluster', label: 'Cluster', icon: '☸' },
  { id: 'api', label: 'API Client', icon: '⚡' },
]

export default function Shell({ state, actions }) {
  const [nav, setNav] = useState('session')
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">JD</div>
        {NAV.map((n) => (
          <button key={n.id} className={`rail__btn ${nav === n.id ? 'active' : ''}`}
            onClick={() => setNav(n.id)} title={n.label}>
            <span>{n.icon}</span>
            <small>{n.label}</small>
          </button>
        ))}
      </aside>

      <div className="main">
        <header className="topbar">
          <Pill ok={state.connected} text={state.connected ? 'VM attached' : 'detached'} />
          <Pill ok={state.hitTotal > 0} text={`${state.hitTotal} hits`} />
          <input
            className="token-input"
            placeholder="API token (optional)"
            type="password"
            value={state.apiToken}
            onChange={(e) => state.setApiToken(e.target.value)}
          />
          <Btn kind="danger" onClick={actions.panic} disabled={!state.connected}>PANIC</Btn>
        </header>
        <div className="content">{renderSection(nav, state, actions)}</div>
      </div>
    </div>
  )
}

function renderSection(nav, s, a) {
  switch (nav) {
    case 'session': return <SessionView s={s} a={a} />
    case 'breakpoints': return <BpsView s={s} a={a} />
    case 'threads': return <ThreadsView s={s} a={a} />
    case 'logs': return <LogsView s={s} />
    case 'timelens': return <LensView s={s} a={a} />
    case 'cluster': return <ClusterView s={s} a={a} />
    case 'api': return <ApiView s={s} a={a} />
    default: return null
  }
}
