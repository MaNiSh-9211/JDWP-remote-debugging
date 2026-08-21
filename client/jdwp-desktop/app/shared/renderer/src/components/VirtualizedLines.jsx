import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export function VirtualizedLines({
  lines,
  rowHeight = 18,
  maxHeight = 160,
  /** When true, parent must be a flex column with a defined height; fills remaining space. */
  flexFill = false,
  onRowClick,
  activeIndex = -1,
  className = 'log-line',
  fontSize = 10,
}) {
  const parentRef = useRef(null)
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()
  const scrollStyle = flexFill
    ? { flex: 1, minHeight: 160, overflow: 'auto', contain: 'strict', width: '100%' }
    : { maxHeight, overflow: 'auto', contain: 'strict' }
  return (
    <div ref={parentRef} style={scrollStyle}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {items.map((vi) => (
          <div
            key={vi.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
            }}
          >
            <div
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={`${className} ${activeIndex === vi.index ? 'active' : ''}`}
              style={{
                fontSize,
                cursor: onRowClick ? 'pointer' : undefined,
                padding: '2px 4px',
                borderRadius: 4,
              }}
              onClick={() => onRowClick?.(vi.index)}
              onKeyDown={(e) => e.key === 'Enter' && onRowClick?.(vi.index)}
            >
              {lines[vi.index]}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
