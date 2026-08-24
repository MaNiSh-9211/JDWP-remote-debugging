import { useState, useEffect } from 'react'

export default function Render({ nav, setNav, connected, panicStop }) {
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">JD</div>
        {[['session','Session','⚡'],['breakpoints','Breakpoints','⏸'],['threads','Threads & Scope','🧵'],['logs','Live Logs','📜'],['timelens','TimeLens','⏱'],['cluster','Cluster','☸'],['api','API Client','⚡']].map(([id,label,icon]) => (
          <button key={id} className={`rail-btn ${nav===id?'active':''}`} onClick={() => setNav(id)}>
            <span className="rail-icon">{icon}</span>
            <span className="rail-label">{label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {connected && (
          <button className="rail-btn panic" onClick={panicStop} title="Resume all, remove BPs, detach">
            <span style={{ fontSize: '1.2em' }}>🚨</span>
            <span className="rail-label">PANIC</span>
          </button>
        )}
      </aside>

      <div style={{ flex: 1 }} />
    </div>
  )
}
