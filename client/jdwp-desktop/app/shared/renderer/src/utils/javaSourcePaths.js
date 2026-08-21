/**
 * Try common Maven/Gradle layouts under a user-chosen project root.
 * @param {string} className - e.g. com.jdwp.server.controller.UserController
 * @returns {string[]} relative paths using forward slashes
 */
const JAVA_SRC_PREFIXES = [
  'src/main/java/',
  'src/test/java/',
  'server/src/main/java/',
  'client/src/main/java/',
  'module/src/main/java/',
]

/**
 * Map a path relative to project root → FQCN (for line breakpoints).
 * @param {string} relPath - e.g. server/src/main/java/com/foo/Bar.java
 */
export function relJavaPathToFqcn(relPath) {
  if (!relPath || typeof relPath !== 'string') return null
  let p = relPath.replace(/\\/g, '/')
  if (!p.toLowerCase().endsWith('.java')) return null
  p = p.slice(0, -5)
  for (const pref of JAVA_SRC_PREFIXES) {
    if (p.startsWith(pref)) {
      return p.slice(pref.length).replace(/\//g, '.')
    }
  }
  if (p.includes('/')) return p.replace(/\//g, '.')
  return null
}

export function candidateJavaRelPaths(className) {
  if (!className || typeof className !== 'string') return []
  const fq = className.trim()
  if (!fq) return []
  const sub = `${fq.replace(/\./g, '/')}.java`
  return [
    sub,
    `src/main/java/${sub}`,
    `src/test/java/${sub}`,
    `server/src/main/java/${sub}`,
    `client/src/main/java/${sub}`,
    `module/src/main/java/${sub}`,
  ]
}

/** Parse breakpoint id/location like com.foo.Bar:42 */
export function parseBreakpointLocation(loc) {
  const s = String(loc || '')
  const i = s.lastIndexOf(':')
  if (i <= 0) return null
  const lineNumber = parseInt(s.slice(i + 1), 10)
  const className = s.slice(0, i)
  if (!className || !Number.isFinite(lineNumber)) return null
  return { className, lineNumber }
}
