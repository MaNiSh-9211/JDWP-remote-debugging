import { useCallback, useRef, useState } from 'react'

const MAX = 80

export function useActivityLog() {
  const [lines, setLines] = useState([])
  const linesRef = useRef(lines)

  const push = useCallback((text) => {
    const ts = new Date().toLocaleTimeString()
    const line = `[${ts}] ${text}`
    setLines((prev) => {
      const next = [...prev, line]
      if (next.length > MAX) next.splice(0, next.length - MAX)
      linesRef.current = next
      return next
    })
  }, [])

  const clear = useCallback(() => setLines([]), [])

  return { lines, push, clear }
}
