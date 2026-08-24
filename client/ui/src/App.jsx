import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import './App.css'

const API_BASE = '/api/debug'
const SERVER_API_BASE = '/api/server'

function App() {
  const [connected, setConnected] = useState(false)
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('5005')
  const [threads, setThreads] = useState([])
  const [selectedThread, setSelectedThread] = useState(null)
  const [frames, setFrames] = useState([])
  const [variables, setVariables] = useState({})
  const [breakpoints, setBreakpoints] = useState([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [apiResponse, setApiResponse] = useState(null)
  const [apiLoading, setApiLoading] = useState(false)
  const [logs, setLogs] = useState([])
  const [endpoints, setEndpoints] = useState([])
  const [customEndpoint, setCustomEndpoint] = useState({ method: 'GET', path: '/api/users', body: '' })
  const [currentLocation, setCurrentLocation] = useState(null)
  const [evaluateExpression, setEvaluateExpression] = useState('')
  const [evaluateResult, setEvaluateResult] = useState(null)
  const [apiBreakpointsConfig, setApiBreakpointsConfig] = useState(null)
  const [selectedApiForBreakpoints, setSelectedApiForBreakpoints] = useState('')
  const [breakpointHit, setBreakpointHit] = useState(false)
  const [persistentClassName, setPersistentClassName] = useState('')
  const [bpTypeUi, setBpTypeUi] = useState('line')
  const [bpLogMsgUi, setBpLogMsgUi] = useState('')
  const [bpCondUi, setBpCondUi] = useState('')
  const [bpMinHitsUi, setBpMinHitsUi] = useState('')
  const [bpMuted, setBpMuted] = useState(false)
  const [hitTotal, setHitTotal] = useState(0)
  const processedThreadsRef = useRef(new Set()) // Track threads we've already processed
  const isProcessingBreakpointRef = useRef(false) // CRITICAL: Prevent processing multiple breakpoints

  // Hit-stats polling with new-hit notifications (parity with Studio)
  const hitStatsSeenRef = useRef({})
  useEffect(() => {
    if (!connected) {
      hitStatsSeenRef.current = {}
      return
    }
    const load = async () => {
      try {
        const res = await axios.get(`${API_BASE}/breakpoints/hit-stats`)
        const hits = res.data && res.data.hits ? res.data.hits : {}
        let deltaTotal = 0
        const deltas = []
        for (const [id, count] of Object.entries(hits)) {
          const before = hitStatsSeenRef.current[id] || 0
          if (count > before) {
            deltaTotal += count - before
            deltas.push(`${id} +${count - before}`)
          }
        }
        hitStatsSeenRef.current = { ...hits }
        setHitTotal(Object.values(hits).reduce((a, b) => a + b, 0))
        if (deltaTotal > 0) {
          setMessage(`Breakpoint hit x${deltaTotal}: ${deltas.join(', ')}`)
          setTimeout(() => setMessage(''), 4000)
        }
      } catch (e) { /* ignore */ }
    }
    load()
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [connected])

  useEffect(() => {
    checkStatus()
    if (connected) {
      refreshThreads()
      refreshBreakpoints()
      loadEndpoints()
      loadApiBreakpointsConfig()
      const interval = setInterval(() => {
        refreshThreads()
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [connected])

  // NO AUTO-SCROLL - User controls scrolling manually
  // Removed auto-scroll completely as requested

  const addLog = (type, title, data) => {
    const timestamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev, { timestamp, type, title, data }])
  }

  const checkStatus = async () => {
    try {
      const response = await axios.get(`${API_BASE}/status`)
      setConnected(response.data.connected)
    } catch (error) {
      setConnected(false)
    }
  }

  // API token for secured clients (session-only; sent on every request)
  const [apiToken, setApiTokenState] = useState(() => sessionStorage.getItem('jdwp-token') || '')
  useEffect(() => {
    axios.defaults.headers.common['X-Debug-Token'] = apiToken || ''
  }, [apiToken])

  const handleConnect = async () => {
    setLoading(true)
    setMessage('')
    addLog('info', 'Connecting', { host, port })
    try {
      const response = await axios.post(`${API_BASE}/connect`, null, {
        params: { host, port: parseInt(port) }
      })
      addLog('success', 'JDWP Connection', response.data)
      if (response.data.success) {
        setConnected(true)
        setMessage('Connected successfully!')
        await refreshThreads()
        await refreshBreakpoints()
          loadEndpoints()
      } else {
        setMessage('Connection failed: ' + response.data.message)
      }
    } catch (error) {
      addLog('error', 'Connection Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnect = async () => {
    setLoading(true)
    addLog('info', 'Disconnecting', {})
    try {
      await axios.post(`${API_BASE}/disconnect`)
      setConnected(false)
      setThreads([])
      setFrames([])
      setVariables({})
      setBreakpoints([])
      setMessage('Disconnected')
      addLog('info', 'Disconnected', {})
    } catch (error) {
      addLog('error', 'Disconnect Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    } finally {
      setLoading(false)
    }
  }

  const refreshThreads = async () => {
    try {
      const response = await axios.get(`${API_BASE}/threads`)
      if (response.data.success) {
        const newThreads = response.data.threads || []
        // Get previous suspended threads BEFORE updating state
        const previousSuspendedThreads = threads.filter(t => t.isSuspended).map(t => t.name)
        setThreads(newThreads)
        
        // Check if any thread hit a breakpoint (became suspended)
        // Filter out system threads and framework threads (Tomcat, etc.)
        const systemThreadPatterns = [
          'Reference Handler', 'Finalizer', 'Signal Dispatcher', 'Notification Thread',
          'Common-Cleaner', 'Cleaner-', 'Catalina-utility-', 'container-', 'Poller',
          'Acceptor', 'DestroyJavaVM', 'Attach Listener', 'GC task thread',
          'VM Thread', 'VM Periodic Task Thread', 'C1 CompilerThread', 'C2 CompilerThread'
        ]
        
        // CRITICAL: STRICTLY require backend's isNewlySuspended flag
        // NO FALLBACK - if backend doesn't mark it as new, we ignore it
        const newlySuspendedThreads = newThreads.filter(t => 
          t.isSuspended && 
          t.isNewlySuspended === true && // STRICT: Must be marked as new by backend
          (t.name.includes('http-nio') || t.name.includes('exec-')) && // Only HTTP threads
          !systemThreadPatterns.some(pattern => t.name.includes(pattern)) &&
          !processedThreadsRef.current.has(t.name) // Not already processed by frontend
        )
        
        // CRITICAL: Only process ONE breakpoint at a time
        // If we're already processing a breakpoint, IGNORE all others
        if (newlySuspendedThreads.length > 0 && !isProcessingBreakpointRef.current) {
          // Check if we already have a selected suspended thread
          const currentSuspendedThread = newThreads.find(t => t.name === selectedThread && t.isSuspended)
          if (currentSuspendedThread) {
            // Already debugging a thread - IGNORE all new breakpoint hits
            console.log('[UI] Already debugging thread, ignoring new breakpoint hits')
            return
          }
          
          // Process the FIRST one only
          const suspendedThread = newlySuspendedThreads[0]
          
          // Double-check it's not already processed (race condition protection)
          if (!processedThreadsRef.current.has(suspendedThread.name)) {
            // Set flag IMMEDIATELY to prevent processing other threads
            isProcessingBreakpointRef.current = true
            processedThreadsRef.current.add(suspendedThread.name) // Mark as processed IMMEDIATELY
            
            console.log('[UI] Processing FIRST breakpoint hit for thread:', suspendedThread.name)
            
            // Set state immediately
            setSelectedThread(suspendedThread.name)
            setBreakpointHit(true)
            
            // Automatically fetch frames and variables when breakpoint hits
            // CRITICAL: Load location and variables IMMEDIATELY
            try {
              // Load location and variables in parallel for faster display
              const [locationResponse, varsResponse] = await Promise.all([
                axios.get(`${API_BASE}/threads/${encodeURIComponent(suspendedThread.name)}/source-location`).catch(e => ({ data: { success: false } })),
                axios.get(`${API_BASE}/threads/${encodeURIComponent(suspendedThread.name)}/variables-next-line`).catch(e => ({ data: { success: false } }))
              ])
              
              // Set location immediately
              if (locationResponse.data.success && locationResponse.data.location) {
                const location = locationResponse.data.location
                if (location.className && location.lineNumber > 0) {
                  console.log('[UI] Setting location immediately:', location)
                  setCurrentLocation(location)
                }
              }
              
              // Set variables immediately
              if (varsResponse.data.success && varsResponse.data.variables) {
                const vars = varsResponse.data.variables || {}
                console.log('[UI] Setting variables immediately:', vars)
                setVariables(vars)
              }
              
              // Also call handleThreadClick to ensure everything is loaded
              await handleThreadClick(suspendedThread.name)
              
              addLog('breakpoint', '🔴 Breakpoint Hit!', { 
                thread: suspendedThread.name,
                message: 'Thread suspended at breakpoint. Location and variables loaded.'
              })
              setMessage(`🔴 Breakpoint hit! Check Location and Variables panels above.`)
              setTimeout(() => setMessage(''), 8000) // Clear message after 8 seconds
            } catch (error) {
              console.error('[UI] Error loading breakpoint data:', error)
              setMessage(`Breakpoint hit but error loading data: ${error.message}`)
            }
            // Keep flag set - only clear when user resumes/continues
          }
        } else if (newlySuspendedThreads.length > 0 && isProcessingBreakpointRef.current) {
          // Silently ignore - we're already processing a breakpoint
          console.log('[UI] Ignoring breakpoint hits - already processing one')
        }
        
        // Clean up processed threads that are no longer suspended
        // BUT: Keep the currently selected thread in the set even if it resumes
        // (so we don't re-process it if it hits the same breakpoint again)
        const currentlySuspended = newThreads.filter(t => t.isSuspended).map(t => t.name)
        const selectedThreadName = selectedThread
        for (const processedThread of Array.from(processedThreadsRef.current)) {
          // Only remove if thread is not suspended AND it's not the currently selected thread
          if (!currentlySuspended.includes(processedThread) && processedThread !== selectedThreadName) {
            processedThreadsRef.current.delete(processedThread)
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch threads:', error)
    }
  }

  const refreshBreakpoints = async () => {
    try {
      const response = await axios.get(`${API_BASE}/breakpoints`)
      if (response.data.success) {
        setBreakpoints(response.data.breakpoints || [])
      }
    } catch (error) {
      console.error('Failed to fetch breakpoints:', error)
    }
  }

  const loadEndpoints = async () => {
    try {
      const response = await axios.get(`${SERVER_API_BASE}/endpoints`)
      if (response.data && response.data.endpoints) {
        setEndpoints(Object.entries(response.data.endpoints))
      }
    } catch (error) {
      // Fallback to default endpoints
      setEndpoints([
        ['GET /api/users', 'Get all users'],
        ['GET /api/users/{id}', 'Get user by ID'],
        ['POST /api/users', 'Create new user'],
        ['PUT /api/users/{id}', 'Update user'],
        ['DELETE /api/users/{id}', 'Delete user'],
        ['GET /health', 'Health check']
      ])
    }
  }

  const handleThreadClick = async (threadName) => {
    setSelectedThread(threadName)
    try {
      // Get scope variables (automatically loaded when breakpoint hits)
      const varsResponse = await axios.get(`${API_BASE}/threads/${encodeURIComponent(threadName)}/variables-next-line`)
      if (varsResponse.data.success) {
        const vars = varsResponse.data.variables || {}
        console.log('[UI] Setting variables:', vars)
        setVariables(vars)
        const varCount = Object.keys(vars).length
        if (varCount > 0) {
          addLog('info', '📊 Scope Variables Loaded', { 
            count: varCount,
            variables: Object.keys(vars).join(', ')
          })
          setMessage(`📊 Loaded ${varCount} variable(s): ${Object.keys(vars).slice(0, 3).join(', ')}${varCount > 3 ? '...' : ''}`)
        } else {
          setMessage('📊 No variables available at this location')
        }
      }
      // Get current source location - ALWAYS fetch and show, even if in framework code
      try {
        const locationResponse = await axios.get(`${API_BASE}/threads/${encodeURIComponent(threadName)}/source-location`)
        if (locationResponse.data.success) {
          const location = locationResponse.data.location
            // Always set location - we'll show it with a warning if it's framework code
            if (location.className && location.lineNumber > 0) {
              console.log('[UI] Setting location:', location)
              setCurrentLocation(location)
              // Check if it's application code
              const isApplicationCode = !location.className.startsWith('jdk.internal.') && 
                !location.className.startsWith('java.') &&
                !location.className.startsWith('sun.') &&
                !location.className.startsWith('org.apache.') &&
                !location.className.startsWith('org.springframework.')
              
              if (isApplicationCode) {
                addLog('info', '📍 Source Location', { 
                  class: location.className,
                  method: location.methodName,
                  line: location.lineNumber
                })
                setMessage(`📍 At ${location.className}:${location.lineNumber} in ${location.methodName}()`)
              } else {
                addLog('info', '📍 Source Location (Framework Code)', { 
                  class: location.className,
                  method: location.methodName,
                  line: location.lineNumber,
                  note: 'Thread is in framework code. Step to reach application code.'
                })
                setMessage(`⚠️ In framework code: ${location.className}. Step to reach application code.`)
              }
            } else {
              console.warn('[UI] Invalid location:', location)
              setCurrentLocation(null)
            }
        }
      } catch (locError) {
        // Location might not be available for all threads
        console.debug('Location not available:', locError)
        setCurrentLocation(null)
      }
    } catch (error) {
      setMessage('Error loading thread data: ' + (error.response?.data?.message || error.message))
      setVariables({})
      setCurrentLocation(null)
    }
  }

  const handleResumeThread = async (threadName) => {
    try {
      const response = await axios.post(`${API_BASE}/threads/${encodeURIComponent(threadName)}/resume`)
      addLog('action', 'Thread Resumed', { thread: threadName, response: response.data })
      // CRITICAL: Clear breakpoint processing flag when resuming
      isProcessingBreakpointRef.current = false
      processedThreadsRef.current.delete(threadName) // Allow this thread to be processed again if it hits another breakpoint
      await refreshThreads()
      if (threadName === selectedThread) {
        await handleThreadClick(threadName)
      }
    } catch (error) {
      addLog('error', 'Resume Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    }
  }

  const handleContinue = async () => {
    try {
      const response = await axios.post(`${API_BASE}/continue`)
      addLog('action', '▶ Continue Execution', { response: response.data })
      // CRITICAL: Clear ALL breakpoint processing flags when continuing
      isProcessingBreakpointRef.current = false
      processedThreadsRef.current.clear() // Clear all processed threads
      setMessage('▶ Execution continuing until next breakpoint...')
      setTimeout(() => setMessage(''), 3000)
      await refreshThreads()
    } catch (error) {
      addLog('error', 'Continue Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    }
  }

  const handleStepOver = async (threadName) => {
    try {
      // Get current location before step
      let beforeLocation = null
      try {
        const beforeLocResponse = await axios.get(`${API_BASE}/threads/${encodeURIComponent(threadName)}/source-location`)
        if (beforeLocResponse.data.success && beforeLocResponse.data.location) {
          beforeLocation = beforeLocResponse.data.location
        }
      } catch (e) {
        console.warn('Could not get location before step:', e)
      }
      
      // Remove from processed threads so we can detect the step completion
      processedThreadsRef.current.delete(threadName)
      const response = await axios.post(`${API_BASE}/threads/${encodeURIComponent(threadName)}/step-over`)
      addLog('action', 'Step Over', { thread: threadName, response: response.data })
      
      // Wait for step to complete - poll until thread is suspended again
      // CRITICAL: Step over will execute the method call, and if there are breakpoints
      // inside the called method, those will be hit FIRST before the step completes
      let attempts = 0
      let lastLocation = beforeLocation
      while (attempts < 50) { // More attempts to handle method calls
        await new Promise(resolve => setTimeout(resolve, 200))
        const threadsResponse = await axios.get(`${API_BASE}/threads`)
        if (threadsResponse.data.success) {
          const thread = threadsResponse.data.threads.find(t => t.name === threadName)
          if (thread && thread.isSuspended) {
            // Get new location
            try {
              const locResponse = await axios.get(`${API_BASE}/threads/${encodeURIComponent(threadName)}/source-location`)
              if (locResponse.data.success && locResponse.data.location) {
                const newLocation = locResponse.data.location
                
                // If we're at a different location, step completed successfully
                if (beforeLocation && newLocation) {
                  const sameLocation = beforeLocation.className === newLocation.className &&
                                     beforeLocation.lineNumber === newLocation.lineNumber
                  
                  if (!sameLocation) {
                    // We've moved! Step completed
                    console.log('[UI] Step completed - moved from', beforeLocation, 'to', newLocation)
                    await refreshThreads()
                    await handleThreadClick(threadName)
                    return
                  } else if (attempts > 15) {
                    // Same location but waited long enough - might be stuck
                    console.warn('[UI] Step may be stuck at same location')
                    await refreshThreads()
                    await handleThreadClick(threadName)
                    setMessage('⚠️ Step completed but still at same location. The method call may have breakpoints inside - use Step Into to enter the method.')
                    return
                  }
                } else {
                  // No before location, just proceed
                  await refreshThreads()
                  await handleThreadClick(threadName)
                  return
                }
              }
            } catch (locError) {
              // Location fetch failed, but thread is suspended, so proceed
              await refreshThreads()
              await handleThreadClick(threadName)
              return
            }
          }
        }
        attempts++
      }
      
      // Final refresh even if we didn't detect suspension
      await refreshThreads()
      await handleThreadClick(threadName)
      setMessage('⚠️ Step may not have completed. Check location manually.')
    } catch (error) {
      addLog('error', 'Step Over Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    }
  }
  
  const handleEvaluateExpression = async (threadName, expression) => {
    if (!expression || !expression.trim()) {
      setMessage('Please enter an expression to evaluate')
      return
    }
    try {
      const response = await axios.post(`${API_BASE}/threads/${encodeURIComponent(threadName)}/evaluate`, null, {
        params: { expression: expression.trim() }
      })
      if (response.data.success) {
        setEvaluateResult({
          expression: expression,
          result: response.data.result,
          success: true
        })
        addLog('action', 'Expression Evaluated', { expression, result: response.data.result })
        setMessage(`Expression evaluated: ${response.data.result}`)
      }
    } catch (error) {
      setEvaluateResult({
        expression: expression,
        result: error.response?.data?.message || error.message,
        success: false
      })
      addLog('error', 'Evaluate Error', error.response?.data || error.message)
      setMessage('Error evaluating expression: ' + (error.response?.data?.message || error.message))
    }
  }

  const handleStepInto = async (threadName) => {
    try {
      // Remove from processed threads so we can detect the step completion
      processedThreadsRef.current.delete(threadName)
      const response = await axios.post(`${API_BASE}/threads/${encodeURIComponent(threadName)}/step-into`)
      addLog('action', 'Step Into', { thread: threadName, response: response.data })
      // Wait for step to complete - poll until thread is suspended again
      let attempts = 0
      while (attempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 200))
        const threadsResponse = await axios.get(`${API_BASE}/threads`)
        if (threadsResponse.data.success) {
          const thread = threadsResponse.data.threads.find(t => t.name === threadName)
          if (thread && thread.isSuspended) {
            await refreshThreads()
            await handleThreadClick(threadName)
            return
          }
        }
        attempts++
      }
      // Final refresh even if we didn't detect suspension
      await refreshThreads()
      await handleThreadClick(threadName)
    } catch (error) {
      addLog('error', 'Step Into Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    }
  }

  const handleStepOut = async (threadName) => {
    try {
      // Remove from processed threads so we can detect the step completion
      processedThreadsRef.current.delete(threadName)
      const response = await axios.post(`${API_BASE}/threads/${encodeURIComponent(threadName)}/step-out`)
      addLog('action', 'Step Out', { thread: threadName, response: response.data })
      // Wait for step to complete - poll until thread is suspended again
      let attempts = 0
      while (attempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 200))
        const threadsResponse = await axios.get(`${API_BASE}/threads`)
        if (threadsResponse.data.success) {
          const thread = threadsResponse.data.threads.find(t => t.name === threadName)
          if (thread && thread.isSuspended) {
            await refreshThreads()
            await handleThreadClick(threadName)
            return
          }
        }
        attempts++
      }
      // Final refresh even if we didn't detect suspension
      await refreshThreads()
      await handleThreadClick(threadName)
    } catch (error) {
      addLog('error', 'Step Out Error', error.response?.data || error.message)
      setMessage('Error: ' + (error.response?.data?.message || error.message))
    }
  }

  // ---- Advanced breakpoint handlers (parity with Studio) --------------------
  const handleToggleBp = async (id, enabled) => {
    try {
      await axios.post(`${API_BASE}/breakpoints/toggle`, { id, enabled })
      await refreshBreakpoints()
    } catch (error) {
      setMessage('Toggle failed: ' + (error.response?.data?.message || error.message))
    }
  }

  const handleMuteAll = async () => {
    try {
      const res = await axios.post(`${API_BASE}/breakpoints/mute`, null, { params: { muted: !bpMuted } })
      setBpMuted(!!res.data.muted)
    } catch (error) {
      setMessage('Mute failed: ' + (error.response?.data?.message || error.message))
    }
  }

  const handleExportBps = () => {
    if (!breakpoints.length) return
    const blob = new Blob([JSON.stringify(breakpoints, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `jdwp-breakpoints-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    let list
    try { list = JSON.parse(await file.text()) } catch { setMessage('Invalid JSON'); return }
    if (!Array.isArray(list)) { setMessage('Expected a breakpoints JSON array'); return }
    let okCount = 0
    for (const bp of list) {
      const id = String(bp.id || bp.location || '')
      const idx = id.lastIndexOf(':')
      if (idx < 0) continue
      const cn = id.slice(0, idx).replace(/\$\d+$/, '')
      const ln = parseInt(id.slice(idx + 1), 10)
      if (!cn || Number.isNaN(ln)) continue
      try {
        if (bp.logMessage || bp.condition || bp.minHits != null) {
          await axios.post(`${API_BASE}/breakpoints/advanced`, {
            className: cn, lineNumber: ln,
            logMessage: bp.logMessage || null,
            condition: bp.condition || null,
            minHits: bp.minHits != null ? Number(bp.minHits) : null,
          })
        } else {
          await axios.post(`${API_BASE}/breakpoints`, null, { params: { className: cn, lineNumber: ln } })
        }
        okCount++
      } catch { /* skip bad entries */ }
    }
    await refreshBreakpoints()
    setMessage(`Imported ${okCount}/${list.length} breakpoint(s)`)
    setTimeout(() => setMessage(''), 4000)
  }

  /** Route single-add by type: line / logpoint / expression / request */
  const handleSingleAdd = async () => {
    const className = (persistentClassName || document.getElementById('bp-class')?.value || '').trim()
    const lineStr = (document.getElementById('bp-line')?.value || '').trim()
    const logMsg = (document.getElementById('bp-logmsg')?.value || '').trim()
    const cond = (document.getElementById('bp-cond')?.value || '').trim()
    const minHitsStr = (document.getElementById('bp-minhits')?.value || '').trim()
    const reqId = (document.getElementById('bp-request-id')?.value || '').trim()

    if (!className || !className.includes('.')) {
      setMessage('Enter the full class name, e.g. com.jdwp.server.controller.UserController')
      setTimeout(() => setMessage(''), 4000)
      return
    }
    const lineNumber = parseInt(lineStr, 10)
    if (Number.isNaN(lineNumber)) {
      setMessage('Enter a valid line number')
      setTimeout(() => setMessage(''), 3000)
      return
    }

    try {
      let res
      if (bpTypeUi === 'logpoint') {
        if (!logMsg) { setMessage('Log message required for a logpoint'); return }
        res = await axios.post(`${API_BASE}/breakpoints/advanced`, { className, lineNumber, logMessage: logMsg, condition: cond || null })
        addLog('action', `Logpoint at ${className}:${lineNumber}`, res.data)
      } else if (bpTypeUi === 'expression') {
        if (!cond) { setMessage('Condition expression required'); return }
        res = await axios.post(`${API_BASE}/breakpoints/advanced`, { className, lineNumber, condition: cond })
        addLog('action', `Expression BP at ${className}:${lineNumber} [${cond}]`, res.data)
      } else if (bpTypeUi === 'request') {
        if (!reqId) { setMessage('Request ID required for request-scoped BP'); return }
        res = await axios.post(`${API_BASE}/breakpoints/conditional`, null, { params: { className, lineNumber, targetRequestId: reqId } })
        addLog('action', `Request-scoped BP at ${className}:${lineNumber}`, res.data)
      } else if (minHitsStr) {
        res = await axios.post(`${API_BASE}/breakpoints/advanced`, { className, lineNumber, minHits: parseInt(minHitsStr, 10) })
        addLog('action', `Hit-count BP at ${className}:${lineNumber} (after ${minHitsStr})`, res.data)
      } else {
        res = await axios.post(`${API_BASE}/breakpoints`, null, { params: { className, lineNumber } })
        addLog('action', `Breakpoint at ${className}:${lineNumber}`, res.data)
      }
      if (res.data.success === false) throw new Error(res.data.message || 'failed')
      await refreshBreakpoints()
      setMessage(`✓ Breakpoint set at ${className}:${lineNumber}`)
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      const msg = error.response?.data?.message || error.message
      setMessage('✗ ' + msg)
      addLog('error', 'Add breakpoint failed', msg)
    }
  }

  const minHitsPresent = () => {
    const v = (document.getElementById('bp-minhits')?.value || '').trim()
    return v !== '' && parseInt(v, 10) > 0
  }

  const handleSetBreakpoint = async (className, lineNumbersStr) => {
    // Validate and clean class name
    const cleanClassName = className.trim()
    
    // Validate class name format - must be full class name, not package
    if (!cleanClassName) {
      setMessage('✗ Class name cannot be empty')
      setTimeout(() => setMessage(''), 3000)
      return
    }
    
    // Check for package keyword
    if (cleanClassName.includes('package ')) {
      const fixedName = cleanClassName.replace('package ', '').trim()
      const suggestedName = `${fixedName}.UserController`
      setMessage(`✗ Do not include "package" keyword. Did you mean: ${suggestedName}?`)
      setTimeout(() => setMessage(''), 7000)
      addLog('error', 'Invalid Class Name', { 
        provided: className,
        hint: `Remove "package" keyword. Use: ${suggestedName}`
      })
      // Auto-fill the suggested class name so user doesn't have to type it again
      setPersistentClassName(suggestedName)
      return
    }
    
    // Check if it ends with package name instead of class name
    if (cleanClassName.endsWith('.controller') || cleanClassName.endsWith('.service') || cleanClassName.endsWith('.model')) {
      const suggestedName = `${cleanClassName}.UserController`
      setMessage(`✗ "${cleanClassName}" is a package name, not a class name. Use: ${suggestedName}`)
      setTimeout(() => setMessage(''), 7000)
      addLog('error', 'Package Name Instead of Class Name', { 
        provided: className,
        hint: `You entered a package. Use full class name like: ${suggestedName}`
      })
      // Auto-fill the suggested class name so user doesn't have to type it again
      setPersistentClassName(suggestedName)
      return
    }
    
    // Must have at least one dot
    if (!cleanClassName.includes('.')) {
      setMessage('✗ Invalid class name format. Use full class name like: com.jdwp.server.controller.UserController')
      setTimeout(() => setMessage(''), 5000)
      // Keep the entered value so user can fix it
      setPersistentClassName(cleanClassName)
      return
    }
    
    // Support multiple line numbers separated by comma
    const lineNumbers = lineNumbersStr.split(',').map(ln => ln.trim()).filter(ln => ln)
    
    // Optional request-id: when set, use the conditional endpoint so ONLY
    // requests carrying this X-Debug-Request-Id are suspended.
    const requestId = (document.getElementById('bp-request-id')?.value || '').trim()
    
    if (lineNumbers.length === 0) {
      setMessage('✗ Please enter at least one line number')
      setTimeout(() => setMessage(''), 3000)
      return
    }
    
    try {
      let successCount = 0
      let failCount = 0
      const results = []
      
      for (const lineNumber of lineNumbers) {
        try {
          const endpoint = requestId ? '/breakpoints/conditional' : '/breakpoints'
          const params = { className: cleanClassName, lineNumber: parseInt(lineNumber) }
          if (requestId) params.targetRequestId = requestId
          const response = await axios.post(`${API_BASE}${endpoint}`, null, { params })
          if (response.data.success) {
            successCount++
            results.push({ lineNumber, success: true })
            addLog('action', `✓ ${requestId ? 'Conditional b' : 'B'}reakpoint Set at ${cleanClassName}:${lineNumber}`, response.data)
          } else {
            failCount++
            results.push({ lineNumber, success: false, message: response.data.message })
            addLog('error', `✗ Failed to set breakpoint at ${cleanClassName}:${lineNumber}`, response.data.message)
          }
        } catch (error) {
          failCount++
          const errorMsg = error.response?.data?.message || error.message
          results.push({ lineNumber, success: false, message: errorMsg })
          addLog('error', `✗ Error setting breakpoint at ${cleanClassName}:${lineNumber}`, errorMsg)
        }
      }
      
      // CRITICAL: Keep class name persistent - NEVER clear it
      // Set it immediately so it persists even if there's an error
      setPersistentClassName(cleanClassName)
      
      // Only clear the line number input, NOT the class name
      const lineInput = document.getElementById('bp-line')
      if (lineInput) {
        lineInput.value = ''
      }
      
      await refreshBreakpoints()
      
      if (successCount > 0) {
        setMessage(`✓ ${successCount} breakpoint(s) set at ${cleanClassName}. Call an API to hit the breakpoint.`)
        setTimeout(() => setMessage(''), 7000)
        // Disable debug features until breakpoint is hit (after API call)
        setBreakpointHit(false)
        addLog('info', 'Breakpoints Set - Waiting for API call', { 
          className: cleanClassName, 
          breakpoints: successCount,
          message: 'Call an API endpoint to hit the breakpoint and enable debugging'
        })
      } else {
        setMessage(`✗ Failed to set all breakpoints: ${results.map(r => r.message).join(', ')}`)
        setTimeout(() => setMessage(''), 5000)
      }
      
      // ALWAYS keep class name - set it again to be absolutely sure
      setPersistentClassName(cleanClassName)
    } catch (error) {
      addLog('error', '✗ Set Breakpoint Error', error.response?.data || error.message)
      setMessage('✗ Error: ' + (error.response?.data?.message || error.message))
      setTimeout(() => setMessage(''), 5000)
    }
  }

  const handleRemoveBreakpoint = async (bpId) => {
    try {
      const response = await axios.delete(`${API_BASE}/breakpoints/${encodeURIComponent(bpId)}`)
      addLog('action', '✓ Breakpoint Removed', { bpId, response: response.data })
      await refreshBreakpoints()
      setMessage('✓ Breakpoint removed successfully')
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      addLog('error', '✗ Remove Breakpoint Error', error.response?.data || error.message)
      setMessage('✗ Error removing breakpoint: ' + (error.response?.data?.message || error.message))
      setTimeout(() => setMessage(''), 5000)
    }
  }
  
  const handleRemoveAllBreakpoints = async () => {
    if (!window.confirm('Are you sure you want to remove all breakpoints?')) {
      return
    }
    try {
      const response = await axios.delete(`${API_BASE}/breakpoints`)
      addLog('action', '✓ All Breakpoints Removed', { count: response.data.count, response: response.data })
      await refreshBreakpoints()
      setMessage(`✓ All ${response.data.count} breakpoints removed successfully`)
      setTimeout(() => setMessage(''), 3000)
    } catch (error) {
      addLog('error', '✗ Remove All Breakpoints Error', error.response?.data || error.message)
      setMessage('✗ Error removing all breakpoints: ' + (error.response?.data?.message || error.message))
      setTimeout(() => setMessage(''), 5000)
    }
  }
  
  const handleSetBreakpointsForApi = async (apiName) => {
    if (!apiBreakpointsConfig || !apiBreakpointsConfig.apiEndpoints || !apiBreakpointsConfig.apiEndpoints[apiName]) {
      setMessage('✗ No breakpoints configured for this API')
      return
    }
    
    const apiConfig = apiBreakpointsConfig.apiEndpoints[apiName]
    const breakpointsToSet = apiConfig.breakpoints || []
    
    if (breakpointsToSet.length === 0) {
      setMessage('✗ No breakpoints defined for this API')
      return
    }
    
    try {
      setMessage(`Setting ${breakpointsToSet.length} breakpoints for ${apiName}...`)
      addLog('action', 'Setting Breakpoints for API', { api: apiName, count: breakpointsToSet.length })
      
      const response = await axios.post(`${API_BASE}/breakpoints/batch`, breakpointsToSet)
      
      if (response.data.success) {
        const successCount = response.data.successCount
        const failCount = response.data.failCount
        addLog('success', `✓ Breakpoints Set for ${apiName}`, {
          success: successCount,
          failed: failCount,
          results: response.data.results
        })
        await refreshBreakpoints()
        setMessage(`✓ ${successCount} breakpoints set successfully${failCount > 0 ? `, ${failCount} failed` : ''} for ${apiName}`)
        setTimeout(() => setMessage(''), 5000)
        setSelectedApiForBreakpoints('') // Reset selection
      }
    } catch (error) {
      addLog('error', '✗ Set API Breakpoints Error', error.response?.data || error.message)
      setMessage('✗ Error setting breakpoints: ' + (error.response?.data?.message || error.message))
      setTimeout(() => setMessage(''), 5000)
    }
  }
  
  const loadApiBreakpointsConfig = async () => {
    try {
      const response = await axios.get(`${API_BASE}/api-breakpoints-config`)
      if (response.data.success) {
        setApiBreakpointsConfig(response.data.config)
        addLog('info', '✓ API Breakpoints Config Loaded', { endpoints: Object.keys(response.data.config.apiEndpoints || {}).length })
      }
    } catch (error) {
      addLog('error', 'Failed to load API breakpoints config', error.response?.data || error.message)
    }
  }

  const callServerApi = async (endpoint, method = 'GET', body = null) => {
    setApiLoading(true)
    setApiResponse(null)
    addLog('api', `API Call: ${method} ${endpoint}`, { endpoint, method, body })
    try {
      let response
      if (method === 'GET') {
        response = await axios.get(`${SERVER_API_BASE}${endpoint}`)
      } else if (method === 'POST') {
        response = await axios.post(`${SERVER_API_BASE}${endpoint}`, body)
      } else if (method === 'PUT') {
        response = await axios.put(`${SERVER_API_BASE}${endpoint}`, body)
      } else if (method === 'DELETE') {
        response = await axios.delete(`${SERVER_API_BASE}${endpoint}`)
      }
      setApiResponse(response.data)
      addLog('api-success', `API Response: ${method} ${endpoint}`, response.data)
      setMessage(`API call successful: ${method} ${endpoint}`)
      // Refresh threads to check for breakpoint hits
      setTimeout(() => refreshThreads(), 500)
    } catch (error) {
      const errorData = error.response?.data || error.message
      setApiResponse({ error: errorData })
      addLog('api-error', `API Error: ${method} ${endpoint}`, errorData)
      setMessage(`API call failed: ${error.response?.data?.message || error.message}`)
    } finally {
      setApiLoading(false)
    }
  }

  const handleCustomApiCall = () => {
    let body = null
    if (customEndpoint.body) {
      try {
        body = JSON.parse(customEndpoint.body)
      } catch (e) {
        setMessage('Invalid JSON in body')
        return
      }
    }
    callServerApi(customEndpoint.path, customEndpoint.method, body)
  }


  // ---- Layout nav ----
  const [nav, setNav] = useState('session')
  const [toastMsg, setToastMsg] = useState(null)
  const toast = (text) => { setToastMsg({ text }); setTimeout(() => setToastMsg(null), 3500) }

  // ---- TimeLens recorder ----
  const [lensLocs, setLensLocs] = useState('')
  const [lensSteps, setLensSteps] = useState([])
  const [lensRec, setLensRec] = useState(false)
  const lensKeyRef = useRef('flight-' + Date.now().toString(36))
  const lensStart = async () => {
    const locs = lensLocs.split('\n').map(s => s.trim()).filter(Boolean)
    if (!locs.length || !connected) { setMessage('Attach and add probes first'); return }
    try {
      await axios.post(API_BASE + '/recorder/start', { sessionKey: lensKeyRef.current, locations: locs })
      setLensRec(true)
    } catch (e) { setMessage('Recorder failed') }
  }
  const lensStop = async () => {
    try { await axios.post(API_BASE + '/recorder/' + encodeURIComponent(lensKeyRef.current) + '/stop') } catch {}
    setLensRec(false)
  }
  const lensRefresh = async () => {
    try {
      const r = await axios.get(API_BASE + '/recorder/' + encodeURIComponent(lensKeyRef.current))
      setLensSteps(r.data.steps || []); setLensRec(!!r.data.recording)
    } catch {}
  }

  // ---- Cluster (server-side kubectl via /api/k8s) ----
  const [ctxList, setCtxList] = useState([])
  const [ctx, setCtx] = useState('')
  const [nsList, setNsList] = useState([])
  const [ns, setNs] = useState('default')
  const [reach, setReach] = useState(null)
  const [k8sPods, setK8sPods] = useState([])
  const [kubeconfigPath, setKubeconfigPath] = useState(sessionStorage.getItem('jdwp-kc-path') || '')
  const [podLogsUi, setPodLogsUi] = useState(null)

  const K8S = API_BASE.replace('/api/debug', '') + '/api/k8s'
  const KC = kubeconfigPath.trim() ? '&kubeconfig=' + encodeURIComponent(kubeconfigPath.trim()) : ''
  const CTX = ctx.trim() ? '&context=' + encodeURIComponent(ctx.trim()) : ''

  const loadContexts = async () => {
    try {
      const r = await axios.get(K8S + '/contexts' + KC.replace('&kubeconfig=', '?kubeconfig='))
      setCtxList(r.data.contexts || [])
      if (!ctx && r.data.contexts?.length) setCtx(r.data.contexts[0])
    } catch { setCtxList([]) }
  }
  const loadNamespaces = async () => {
    try {
      const r = await axios.get(K8S + '/namespaces' + (KC || CTX ? '?' + (KC + CTX).replace(/^&/, '') : ''))
      setNsList(r.data.namespaces || []); setReach(true)
    } catch { setReach(false) }
  }
  const discoverK8sPods = async () => {
    try {
      const r = await axios.get(K8S + '/pods?' + (KC + CTX + '&namespace=' + encodeURIComponent(ns.trim() || 'default')).replace(/^&/, ''))
      setK8sPods((r.data.pods || []).map(p2 => ({ name: p2.name, phase: p2.phase, running: p2.running, jdwpPort: p2.jdwpPort })))
    } catch { setK8sPods([]) }
  }
  const attachViaTunnel = async (podName, jdwpPortNum) => {
    if (!connected) return setMessage && setMessage('Attach first')
    try {
      await axios.post(API_BASE + '/disconnect')
      const f = await axios.post(K8S + '/forward', {
        ...(KC ? { kubeconfig: decodeURIComponent(KC.replace('&kubeconfig=', '')) } : {}),
        ...(CTX ? { context: decodeURIComponent(CTX.replace('&context=', '')) } : {}),
        namespace: ns.trim() || 'default', pod: podName,
        remotePort: jdwpPortNum > 0 ? jdwpPortNum : 5005, localPort: 5005,
      })
      if (!(f.data.success || f.data.reused)) throw new Error(f.data.message || 'forward failed')
      await new Promise(r => setTimeout(r, 1500))
      const c = await axios.post(API_BASE + '/connect?host=localhost&port=5005')
      if (c.data.success) { setConnected(true); await refreshThreads() }
      else throw new Error(c.data.message || 'attach failed')
    } catch (e) { setMessage('Tunnel error: ' + e.message) }
  }
  const fetchK8sPodLogsWeb = async (podName) => {
    try {
      const r = await axios.get(K8S + '/logs', { params: { namespace: ns.trim() || 'default', pod: podName, tail: 100 } })
      setPodLogsUi({ pod: podName, text: r.data.logs || '(empty)' })
    } catch { setPodLogsUi({ pod: podName, text: 'failed' }) }
  }

  // ---- Panic stop ----
  const panicStop = async () => {
    if (!window.confirm('PANIC STOP\n\nResume all threads, remove all breakpoints/watchpoints and detach?')) return
    setLoading(true)
    try {
      const p = await axios.post(API_BASE + '/panic')
      setConnected(false); setThreads([]); setSelectedThread(null); setFrames([]); setVariables({})
      setMessage('PANIC: resumed ' + (p.data.threadsResumed ?? 0) + ', removed ' + (p.data.breakpointsRemoved ?? 0) + ' BPs, detached=' + p.data.detached)
      setTimeout(() => setMessage(''), 6000)
    } catch (e) { setMessage('Panic failed: ' + (e.response?.data?.message || e.message)) }
    finally { setLoading(false) }
  }


  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">JD</div>
        {[['session','Session','⚡'],['breakpoints','Breakpoints','⏸'],['threads','Threads & Scope','🧵'],['logs','Live Logs','📜'],['timelens','TimeLens','⏱'],['cluster','Cluster','☸']].map(([id,label,icon]) => (
          <button key={id} className={`rail-btn ${nav===id?'active':''}`} onClick={() => setNav(id)}>
            <span className="rail-icon">{icon}</span>
            <span className="rail-label">{label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{nav === 'session' ? 'Session' : nav === 'breakpoints' ? 'Breakpoints' : nav === 'threads' ? 'Threads & Scope' : nav === 'logs' ? 'Live Logs' : nav === 'timelens' ? 'TimeLens' : 'Cluster'}</h1>
          <div className="topbar-pills">
            <span className={`pill ${connected ? 'pill-ok' : 'pill-off'}`}>{connected ? `● ${host}:${port}` : '○ detached'}</span>
          </div>
          {connected && (
            <button type="button" className="btn btn--sm" style={{ background: '#f85149', color: '#fff', fontWeight: 700 }} onClick={panicStop}>PANIC</button>
          )}
        </header>
        {toastMsg && (
          <div className="banner">{toastMsg.text}</div>
        )}
        <main className="content-area">

          {/* SESSION */}
          {nav === 'session' && (
            <>
              <div className="card">
                <div className="card-head">Target VM</div>
                <div className="form-grid">
                  <label>Host</label>
                  <input value={host} onChange={(e) => setHost(e.target.value)} disabled={connected} />
                  <label>Port</label>
                  <input value={port} onChange={(e) => setPort(e.target.value)} disabled={connected} />
                </div>
                <div className="toolbar">
                  {!connected
                    ? <button onClick={handleConnect} disabled={loading} className="primary">Attach to JVM</button>
                    : <button onClick={handleDisconnect} disabled={loading} className="primary">Detach</button>}
                </div>
              </div>
              <div className="card">
                <div className="card-head">Status</div>
                <div className="status-row"><Pill ok={connected} text={connected ? 'attached' : 'not attached'} /></div>
              </div>
            </>
          )}

          {/* BREAKPOINTS */}
          {nav === 'breakpoints' && (
            <>
              <Card title={`Breakpoints (${breakpoints.length})`}
                right={<Btn ghost onClick={handleMuteAll}>{bpMuted ? 'Unmute all' : 'Mute all'}</Btn>}>
                <div className="form-grid">
                  <label>Type</label>
                  <select id="bp-type" defaultValue="line">
                    <option value="line">Line</option>
                    <option value="logpoint">Logpoint</option>
                    <option value="expression">Expression</option>
                    <option value="request">Request-ID</option>
                  </select>
                  <label>Class</label>
                  <input id="bp-class" placeholder="com.example.Foo" defaultValue={persistentClassName} />
                  <label>Line</label>
                  <input id="bp-line" placeholder="31" />
                  <label>Log message (logpoint)</label>
                  <input id="bp-logmsg" placeholder="order {id} amount={amount}" />
                  <label>Condition</label>
                  <input id="bp-cond" placeholder="amount > 1000" />
                  <label>Request ID</label>
                  <input id="bp-reqid" placeholder="X-Debug-Request-Id value" />
                  <label>Min hits</label>
                  <input id="bp-minhits" placeholder="e.g. 5" />
                </div>
                <Btn primary onClick={handleSingleAdd}>Add breakpoint</Btn>
                <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                  <Btn ghost onClick={handleExportBps} disabled={!breakpoints.length}>Export JSON</Btn>
                  <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
                    Import
                    <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
                  </label>
                </div>
              </Card>
              {breakpoints.length > 0 && (
                <Card title={`Active (${breakpoints.length})`}>
                  {breakpoints.map((b) => (
                    <div key={b.id || b.location} className="list-row">
                      <span className="mono small grow">{b.logMessage ? '📝 ' : b.condition ? '❓ ' : ''}{b.id || b.location}</span>
                      <Btn ghost onClick={() => handleToggleBp(b.id, !!b.disabled)}>{b.disabled ? 'enable' : 'disable'}</Btn>
                      <Btn ghost onClick={() => handleRemoveBp(b.id)}>✕</Btn>
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}

          {/* THREADS */}
          {nav === 'threads' && (
            <>
              <Card title={`Threads (${threads.length})`}>
                {!threads.length ? <Empty>No threads.</Empty> :
                  threads.map((t) => (
                    <div key={t.name} className={`list-row ${t.suspended ? 'suspended' : ''}`}>
                      <span>{t.suspended ? '⏸' : '▶'} </span>
                      <span className="mono small grow">{t.name}</span>
                      {t.suspended && <Btn ghost onClick={() => handleThreadClick(t.name)}>inspect</Btn>}
                    </div>
                  ))}
              </Card>
              {selectedThread && frames && frames.length > 0 && (
                <Card title={`Stack frames — ${selectedThread}`}>
                  <div className="stack-frames">
                    {frames.map((f, i) => (
                      <div key={i} className="frame-row mono small">
                        {i}. {f.className?.split('.').pop()}.{f.methodName}:{f.lineNumber}
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              {selectedThread && variables && Object.keys(variables).length > 0 && (
                <Card title="Variables">
                  <pre className="code-block small">{JSON.stringify(variables, null, 2).slice(0, 5000)}</pre>
                </Card>
              )}
            </>
          )}

          {/* LIVE LOGS */}
          {nav === 'logs' && (
            <Card title="Live target logs"
              right={<Btn onClick={() => setLogs([])}>Clear</Btn>}>
              {!connected && <Empty>Not attached — connect to see logs.</Empty>}
              <div className="log-viewer mono">
                {logs.map((l, i) => (
                  <div key={i}>{l.timestamp ? `[${new Date(l.timestamp).toLocaleTimeString()}] ` : ''}{l.message || l.text || String(l)}</div>
                ))}
                {!logs.length && <Empty>No entries yet.</Empty>}
              </div>
            </Card>
          )}

          {/* TIMELENS */}
          {nav === 'timelens' && (
            <Card title="TimeLens — request causality recorder">
              <textarea rows={3} value={lensLocs} onChange={(e) => setLensLocs(e.target.value)}
                placeholder={'com.example.Foo:31\ncom.example.Bar:88'} />
              <div className="toolbar">
                <Btn kind="primary" disabled={!connected} onClick={lensStart}>Start recording</Btn>
                <Btn onClick={lensStop}>Stop</Btn>
                <Btn ghost onClick={lensRefresh}>Refresh</Btn>
              </div>
              {lensSteps.map((s, i) => (
                <div key={`${s.timestamp}-${i}`} className="step">
                  <b>#{i + 1}</b> {s.class}.{s.method}:{s.line}
                  <span style={{ color: '#858585', marginLeft: 8 }}>{s.thread}</span>
                  {s.locals && Object.keys(s.locals).length > 0 && (
                    <pre>{JSON.stringify(s.locals, null, 1).slice(0, 2000)}</pre>
                  )}
                </div>
              ))}
            </Card>
          )}

          {/* CLUSTER */}
          {nav === 'cluster' && (
            <Card title="Kubernetes cluster">
              <div className="grid2">
                <Field label="Context">
                  <select value={ctx} onChange={(e) => { setCtx(e.target.value); loadNamespaces() }}>
                    <option value="">— select context —</option>
                    {ctxList.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Namespace">
                  <input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="default" />
                </Field>
              </div>
              <div className="toolbar">
                <Btn onClick={() => { loadContexts(); loadNamespaces() }}>Refresh</Btn>
                <Btn kind="primary" disabled={!connected} onClick={discoverPods}>Discover pods</Btn>
              </div>
              {pods.map((pd) => (
                <div key={pd.name} className="list-row">
                  <span>{pd.running ? '🟢' : '⚪'} {pd.name}</span>
                  <Btn kind="primary" onClick={() => attachToPod(pd.name, pd.jdwpPort)}>Attach</Btn>
                </div>
              ))}
            </Card>
          )}

          {/* API CLIENT */}
          {nav === 'api' && (
            <Card title="API client">
              <div className="grid2">
                <Field label="Method">
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {['GET', 'POST', 'PUT', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label="URL"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/path" /></Field>
              </div>
              <Field label="Headers (JSON)"><input value={hdrs} onChange={(e) => setHdrs(e.target.value)} placeholder='{"key": "value"}' /></Field>
              <Field label="Body (JSON)"><input value={bdy} onChange={(e) => setBdy(e.target.value)} placeholder='{"key": "value"}' /></Field>
              <Btn onClick={handleCustomApiCall}>Send</Btn>
              {apiResponse && <pre className="code-block small">{JSON.stringify(apiResponse, null, 2).slice(0, 3000)}</pre>}
            </Card>
          )}
        </main>

        {/* PANIC button floating bottom-right */}
        {connected && (
          <button className="panic-fab" onClick={panicStop}
            title="Resume all threads, remove all BPs, detach from VM">🚨 PANIC</button>
        )}
      </div>
    </div>
  )
}

export default App
