import { memo, useState } from 'react'

function Node({ node, depth }) {
  const [open, setOpen] = useState(depth < 2)
  const hasChildren = Array.isArray(node.children) && node.children.length > 0
  return (
    <div style={{ marginLeft: depth * 12 }}>
      <div
        className="list-item"
        style={{ padding: '4px 6px', fontSize: 11 }}
        onClick={() => hasChildren && setOpen(!open)}
      >
        {hasChildren ? (open ? '▼ ' : '▶ ') : '  '}
        <span style={{ color: 'var(--sage)' }}>{node.name ?? '?'}</span>
        <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{node.type ?? ''}</span>
        <span style={{ marginLeft: 8 }}>{node.value != null ? String(node.value) : ''}</span>
      </div>
      {hasChildren && open && node.children.map((ch, i) => <Node key={i} node={ch} depth={depth + 1} />)}
    </div>
  )
}

function VariableTreeComponent({ tree }) {
  if (!tree || !Array.isArray(tree) || tree.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>No variables tree (use enhanced variables)</div>
  }
  return (
    <div style={{ maxHeight: 280, overflow: 'auto' }}>
      {tree.map((n, i) => (
        <Node key={i} node={n} depth={0} />
      ))}
    </div>
  )
}

export default memo(VariableTreeComponent)
