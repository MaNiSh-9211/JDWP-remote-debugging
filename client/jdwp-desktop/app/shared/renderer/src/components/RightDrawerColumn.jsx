import { Fragment, useCallback, useRef } from 'react'

const PANEL_ORDER = ['source', 'bp', 'http']

/**
 * Vertical stack: Code (top) → BP → HTTP (bottom). Drag horizontal bars to resize heights.
 */
export default function RightDrawerColumn({ width, onWidthChange, panels, flexWeights, onPairDrag, slots }) {
  const dragCol = useRef({ startX: 0, startW: 0 })

  const onColumnResizeDown = useCallback(
    (e) => {
      e.preventDefault()
      dragCol.current = { startX: e.clientX, startW: width }
      const onMove = (ev) => {
        const dx = dragCol.current.startX - ev.clientX
        const next = Math.min(960, Math.max(320, dragCol.current.startW + dx))
        onWidthChange(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [width, onWidthChange],
  )

  const visible = PANEL_ORDER.filter((k) => panels[k])
  if (!visible.length) return null

  return (
    <div className="right-drawer-column" style={{ width }}>
      <div
        className="right-drawer-column__resize"
        onMouseDown={onColumnResizeDown}
        title="Drag to resize column width"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="right-drawer-column__stack">
        {visible.map((key, i) => (
          <Fragment key={key}>
            <div
              className="right-drawer-slot"
              style={{
                flex: `${Math.max(0.12, flexWeights[key] ?? 1)} 1 0`,
                minHeight: 72,
              }}
            >
              {slots[key]}
            </div>
            {i < visible.length - 1 ? (
              <HeightSplitter upperKey={visible[i]} lowerKey={visible[i + 1]} onPairDrag={onPairDrag} />
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function HeightSplitter({ upperKey, lowerKey, onPairDrag }) {
  const down = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    let lastY = e.clientY
    const move = (ev) => {
      const dy = ev.clientY - lastY
      lastY = ev.clientY
      onPairDrag(upperKey, lowerKey, dy)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      className="right-drawer-column__h-split"
      onMouseDown={down}
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize panel height"
    />
  )
}
