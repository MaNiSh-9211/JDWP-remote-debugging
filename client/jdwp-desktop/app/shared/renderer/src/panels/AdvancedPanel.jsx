import { useState } from 'react'
import { debugApi } from '../api/debugApi.js'

async function unwrap(promise) {
  try {
    const res = await promise
    const data = res?.data
    if (data && data.success === false) {
      return { ok: false, data, error: data.message || 'Request failed' }
    }
    return { ok: res?.status >= 200 && res?.status < 300, data: data ?? {}, error: null }
  } catch (e) {
    return { ok: false, data: {}, error: e.message || String(e) }
  }
}

export default function AdvancedPanel({ showToast }) {
  const [classesOut, setClassesOut] = useState('')
  const [batchJson, setBatchJson] = useState('[{"className":"com.example.Foo","lineNumber":1}]')
  const [configOut, setConfigOut] = useState('')

  const loadClasses = async () => {
    const { ok, data } = await unwrap(debugApi.classes())
    if (ok) setClassesOut(JSON.stringify(data.classes || data, null, 2))
    else showToast('Classes failed', true)
  }

  const applyBatch = async () => {
    let list
    try {
      list = JSON.parse(batchJson)
    } catch {
      showToast('Invalid JSON', true)
      return
    }
    const { ok, data } = await unwrap(debugApi.setBreakpointsBatch(list))
    if (ok && data.success !== false) showToast('Batch applied')
    else showToast(data?.message || 'Batch failed', true)
  }

  const loadConfig = async () => {
    const { ok, data } = await unwrap(debugApi.apiBreakpointsConfig())
    if (ok) setConfigOut(JSON.stringify(data.config || data, null, 2))
    else showToast('Config failed', true)
  }

  return (
    <div style={{ padding: 8, fontSize: 11 }}>
      <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text-muted)' }}>Advanced (classes / batch / API config)</div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button type="button" className="btn" onClick={loadClasses}>
          Load classes
        </button>
        <button type="button" className="btn" onClick={loadConfig}>
          API breakpoints config
        </button>
        <button type="button" className="btn btn-primary" onClick={applyBatch}>
          Apply batch BPs
        </button>
      </div>
      <textarea
        value={batchJson}
        onChange={(e) => setBatchJson(e.target.value)}
        style={{
          width: '100%',
          minHeight: 56,
          marginBottom: 8,
          padding: 8,
          borderRadius: 6,
          background: 'var(--bg-deep)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
        }}
      />
      <pre className="mono-block" style={{ maxHeight: 120, marginBottom: 8 }}>
        {classesOut || '—'}
      </pre>
      <pre className="mono-block" style={{ maxHeight: 100 }}>
        {configOut || '—'}
      </pre>
    </div>
  )
}
