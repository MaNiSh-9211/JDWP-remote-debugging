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
  const [classes, setClasses] = useState([])
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
  const logsEndRef = useRef(null)
  const processedThreadsRef = useRef(new Set()) // Track threads we've already processed
  const isProcessingBreakpointRef = useRef(false) // CRITICAL: Prevent processing multiple breakpoints

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
        await refreshClasses()
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

  const refreshClasses = async () => {
    try {
      const response = await axios.get(`${API_BASE}/classes`)
      if (response.data.success) {
        setClasses(response.data.classes || [])
      }
    } catch (error) {
      console.error('Failed to fetch classes:', error)
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

  const handleSuspendThread = async (threadName) => {
    try {
      const response = await axios.post(`${API_BASE}/threads/${encodeURIComponent(threadName)}/suspend`)
      addLog('action', '✓ Thread Suspended', { thread: threadName, response: response.data })
      setMessage(`✓ Thread "${threadName}" suspended. All debug features are now available.`)
      setTimeout(() => setMessage(''), 3000)
      await refreshThreads()
      // Auto-select the suspended thread and load its data
      setSelectedThread(threadName)
      await handleThreadClick(threadName)
    } catch (error) {
      addLog('error', '✗ Suspend Error', error.response?.data || error.message)
      setMessage('✗ Error: ' + (error.response?.data?.message || error.message))
      setTimeout(() => setMessage(''), 5000)
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
          const response = await axios.post(`${API_BASE}/breakpoints`, null, {
            params: { className: cleanClassName, lineNumber: parseInt(lineNumber) }
          })
          if (response.data.success) {
            successCount++
            results.push({ lineNumber, success: true })
            addLog('action', `✓ Breakpoint Set at ${cleanClassName}:${lineNumber}`, response.data)
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>🔍 JDWP Remote Debugger</h1>
        <div className="connection-panel">
          {!connected ? (
            <div className="connect-form">
              <input
                type="text"
                placeholder="Host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={loading}
              />
              <input
                type="number"
                placeholder="Port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={loading}
              />
              <button onClick={handleConnect} disabled={loading}>
                {loading ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          ) : (
            <div className="connected-status">
              <span className="status-indicator connected">● Connected</span>
              <button onClick={handleDisconnect} disabled={loading}>
                Disconnect
              </button>
            </div>
          )}
        </div>
      </header>

      {message && (
        <div className={`message ${message.includes('Error') ? 'error' : 'success'}`}>
          {message}
        </div>
      )}

      {/* Debug Control Panel - Shows when thread is suspended */}
      {connected && selectedThread && threads.find(t => t.name === selectedThread && t.isSuspended) && (
        <div className="debug-control-panel">
          <div className="debug-control-header">
            <h3>🔴 Debugging: {selectedThread}</h3>
            <span className="debug-status">PAUSED AT BREAKPOINT</span>
          </div>
          <div className="debug-control-buttons">
            <button
              onClick={() => handleStepOver(selectedThread)}
              className="debug-btn step-over"
              title="Execute current line and move to next line"
            >
              ⏭ Step Over (F10)
            </button>
            <button
              onClick={() => handleStepInto(selectedThread)}
              className="debug-btn step-into"
              title="Step into method call"
            >
              ⬇ Step Into (F11)
            </button>
            <button
              onClick={() => handleStepOut(selectedThread)}
              className="debug-btn step-out"
              title="Step out of current method"
            >
              ⬆ Step Out (Shift+F11)
            </button>
            <button
              onClick={handleContinue}
              className="debug-btn resume"
              title="Continue execution until next breakpoint (resumes all threads)"
            >
              ▶ Continue (F5)
            </button>
          </div>
        </div>
      )}

      {connected && (
        <div className="main-content">
          <div className="left-panel">
            <div className="panel">
              <div className="panel-header">
                <h2>Breakpoints ({breakpoints.length})</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={refreshBreakpoints} className="refresh-btn">🔄</button>
                  {breakpoints.length > 0 && (
                    <button 
                      onClick={handleRemoveAllBreakpoints} 
                      className="remove-all-btn"
                      title="Remove all breakpoints"
                    >
                      🗑️ Remove All
                    </button>
                  )}
                </div>
              </div>
              
              {/* API-based Breakpoint Setting - Always show when connected */}
              <div className="api-breakpoints-section">
                <h3 style={{ margin: '0.5rem 0', color: '#4ec9b0', fontSize: '0.95rem' }}>
                  📍 Set Breakpoints for API (Auto-set multiple breakpoints):
                </h3>
                {apiBreakpointsConfig && apiBreakpointsConfig.apiEndpoints ? (
                  <>
                    <div className="api-breakpoint-selector">
                      <select
                        value={selectedApiForBreakpoints}
                        onChange={(e) => setSelectedApiForBreakpoints(e.target.value)}
                        className="api-select"
                      >
                        <option value="">Select API endpoint...</option>
                        {Object.entries(apiBreakpointsConfig.apiEndpoints).map(([apiName, config]) => (
                          <option key={apiName} value={apiName}>
                            {apiName} - {config.description} ({config.breakpoints?.length || 0} breakpoints)
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleSetBreakpointsForApi(selectedApiForBreakpoints)}
                        disabled={!selectedApiForBreakpoints}
                        className="set-api-breakpoints-btn"
                      >
                        Set All Breakpoints
                      </button>
                    </div>
                    {selectedApiForBreakpoints && apiBreakpointsConfig.apiEndpoints[selectedApiForBreakpoints] && (
                      <div className="api-breakpoints-preview">
                        <div style={{ fontSize: '0.85rem', color: '#858585', marginTop: '0.5rem' }}>
                          Breakpoints to be set:
                        </div>
                        {apiBreakpointsConfig.apiEndpoints[selectedApiForBreakpoints].breakpoints.map((bp, idx) => (
                          <div key={idx} className="breakpoint-preview-item">
                            <span className="bp-preview-class">{bp.className}</span>
                            <span className="bp-preview-line">Line {bp.lineNumber}</span>
                            <span className="bp-preview-desc">{bp.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ padding: '0.5rem', color: '#858585', fontSize: '0.85rem', fontStyle: 'italic' }}>
                    Loading API breakpoints configuration...
                  </div>
                )}
              </div>
              
              <div className="breakpoint-list">
                {breakpoints.length === 0 ? (
                  <div className="info-text">No breakpoints set</div>
                ) : (
                  breakpoints.map((bp, idx) => (
                    <div key={idx} className="breakpoint-item">
                      <span className="breakpoint-location">{bp.location}</span>
                      <button
                        onClick={() => handleRemoveBreakpoint(bp.id)}
                        className="remove-btn"
                        title="Remove this breakpoint"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
              
              <div className="add-breakpoint">
                <h3 style={{ margin: '0.5rem 0', color: '#4ec9b0', fontSize: '0.95rem' }}>
                  ➕ Add Single Breakpoint:
                </h3>
                <input
                  type="text"
                  id="bp-class"
                  placeholder="Class (e.g., com.jdwp.server.controller.UserController)"
                  value={persistentClassName}
                  onChange={(e) => setPersistentClassName(e.target.value)}
                />
                <input
                  type="text"
                  id="bp-line"
                  placeholder="Line number(s) - e.g., 31 or 31,32,33"
                />
                <button
                  onClick={() => {
                    // Get class name from state (persistent) or input field
                    const className = (persistentClassName || document.getElementById('bp-class')?.value || '').trim()
                    const lineNumbers = (document.getElementById('bp-line')?.value || '').trim()
                    
                    if (!className) {
                      setMessage('✗ Please enter a class name (e.g., com.jdwp.server.controller.UserController)')
                      setTimeout(() => setMessage(''), 5000)
                      addLog('error', 'Missing Class Name', { 
                        hint: 'Enter full class name like: com.jdwp.server.controller.UserController'
                      })
                      return
                    }
                    
                    if (!lineNumbers) {
                      setMessage('✗ Please enter line number(s) (e.g., 31 or 31,32,33)')
                      setTimeout(() => setMessage(''), 3000)
                      return
                    }
                    
                    // Validate class name format - must be full class name, not package
                    if (className.includes('package ') || 
                        className.endsWith('.controller') || 
                        className.endsWith('.service') || 
                        !className.includes('.')) {
                      setMessage('✗ Invalid class name. Use full class name like: com.jdwp.server.controller.UserController')
                      setTimeout(() => setMessage(''), 5000)
                      addLog('error', 'Invalid Class Name Format', { 
                        provided: className,
                        hint: 'Use full class name like: com.jdwp.server.controller.UserController (not just package name)'
                      })
                      return
                    }
                    
                    handleSetBreakpoint(className, lineNumbers)
                  }}
                >
                  Add Breakpoint(s)
                </button>
              </div>
            </div>
          </div>

          <div className="right-panel">
            {selectedThread && (
              <>
                {/* Current Source Location - Always show when thread is suspended */}
                {selectedThread && threads.find(t => t.name === selectedThread && t.isSuspended) && (
                  currentLocation ? (
                    <div className="panel source-location-panel">
                      <div className="panel-header">
                        <h2>📍 Current Code Location</h2>
                        <button onClick={() => handleThreadClick(selectedThread)} className="refresh-btn" title="Refresh location">🔄</button>
                      </div>
                      <div className="source-location-content">
                        <div className="location-line">
                          <span className="location-label">Class:</span>
                          <span className="location-value">{currentLocation.className}</span>
                        </div>
                        <div className="location-line">
                          <span className="location-label">Method:</span>
                          <span className="location-value">{currentLocation.methodName}()</span>
                        </div>
                        <div className="location-line highlight">
                          <span className="location-label">Line:</span>
                          <span className="location-value highlight-line">Line {currentLocation.lineNumber}</span>
                        </div>
                        {currentLocation.sourceName && (
                          <div className="location-line">
                            <span className="location-label">Source File:</span>
                            <span className="location-value">{currentLocation.sourceName}</span>
                          </div>
                        )}
                        {currentLocation.className && (
                          currentLocation.className.startsWith('org.apache.') || 
                          currentLocation.className.startsWith('org.springframework.') ||
                          currentLocation.className.startsWith('java.') ||
                          currentLocation.className.startsWith('jdk.internal.')
                        ) ? (
                          <div className="location-note" style={{ marginTop: '0.5rem', padding: '0.5rem', fontSize: '0.85rem', color: '#ff9800', fontStyle: 'italic', backgroundColor: '#fff3cd', borderRadius: '4px' }}>
                            ⚠️ Thread is in framework code. Use Step Over/Into to reach your application code.
                          </div>
                        ) : (
                          <div className="location-note" style={{ marginTop: '0.5rem', padding: '0.5rem', fontSize: '0.85rem', color: '#858585', fontStyle: 'italic' }}>
                            💡 To view source code, open: {currentLocation.className.replace(/\./g, '/')}.java at line {currentLocation.lineNumber}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="panel source-location-panel" style={{ borderColor: '#858585', opacity: 0.7 }}>
                      <div className="panel-header">
                        <h2>📍 Current Code Location</h2>
                        <button onClick={() => handleThreadClick(selectedThread)} className="refresh-btn" title="Refresh location">🔄</button>
                      </div>
                      <p style={{ color: '#858585', fontStyle: 'italic', padding: '1rem' }}>
                        Loading location... Click refresh to update.
                      </p>
                    </div>
                  )
                )}
                
                {/* Debug Features - Available when thread is suspended */}
                {selectedThread && threads.find(t => t.name === selectedThread && t.isSuspended) && (
                  <>
                    {/* Debug Controls Panel */}
                    <div className="panel debug-features-panel">
                      <div className="panel-header">
                        <h2>🛠️ Debug Features {breakpointHit ? '(Breakpoint Hit)' : '(Thread Suspended)'}</h2>
                      </div>
                      <div className="debug-features-grid">
                        <div className="debug-feature-item">
                          <h4>Step Operations</h4>
                          <div className="debug-feature-buttons">
                            <button
                              onClick={() => handleStepOver(selectedThread)}
                              className="debug-feature-btn step-over"
                              title="Execute current line and move to next line"
                            >
                              ⏭ Step Over
                            </button>
                            <button
                              onClick={() => handleStepInto(selectedThread)}
                              className="debug-feature-btn step-into"
                              title="Step into method call"
                            >
                              ⬇ Step Into
                            </button>
                            <button
                              onClick={() => handleStepOut(selectedThread)}
                              className="debug-feature-btn step-out"
                              title="Step out of current method"
                            >
                              ⬆ Step Out
                            </button>
                          </div>
                        </div>
                        <div className="debug-feature-item">
                          <h4>Execution Control</h4>
                          <div className="debug-feature-buttons">
            <button
              onClick={async () => {
                await handleContinue()
                setBreakpointHit(false) // Reset when continuing
                setCurrentLocation(null) // Clear location
                setVariables({}) // Clear variables
                // Remove from processed threads so we can detect next breakpoint
                if (selectedThread) {
                  processedThreadsRef.current.delete(selectedThread)
                }
              }}
              className="debug-feature-btn resume"
              title="Continue execution until next breakpoint"
            >
              ▶ Continue
            </button>
                            <button
                              onClick={() => {
                                handleThreadClick(selectedThread)
                                setMessage('✓ Refreshed variables and location')
                                setTimeout(() => setMessage(''), 2000)
                              }}
                              className="debug-feature-btn refresh"
                              title="Refresh variables and source location"
                            >
                              🔄 Refresh
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Evaluate Expression */}
                    <div className="panel evaluate-panel">
                      <div className="panel-header">
                        <h2>🔍 Evaluate Expression</h2>
                      </div>
                      <div className="evaluate-form">
                        <input
                          type="text"
                          placeholder="Enter expression (e.g., variableName, variableName.field, variableName.method())"
                          value={evaluateExpression}
                          onChange={(e) => setEvaluateExpression(e.target.value)}
                          onKeyPress={(e) => {
                            if (e.key === 'Enter') {
                              handleEvaluateExpression(selectedThread, evaluateExpression)
                            }
                          }}
                          className="evaluate-input"
                        />
                        <button
                          onClick={() => handleEvaluateExpression(selectedThread, evaluateExpression)}
                          className="evaluate-btn"
                          disabled={!evaluateExpression.trim()}
                        >
                          Evaluate
                        </button>
                      </div>
                      {evaluateResult && (
                        <div className={`evaluate-result ${evaluateResult.success ? 'success' : 'error'}`}>
                          <div className="evaluate-result-label">
                            {evaluateResult.success ? '✓ Result:' : '✗ Error:'}
                          </div>
                          <div className="evaluate-result-value">
                            {evaluateResult.expression} = {evaluateResult.result}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
                
                {/* Scope Variables - Auto-loaded when breakpoint hits */}
                {Object.keys(variables).length > 0 && (
                  <div className="panel variables-panel">
                    <div className="panel-header">
                      <h2>📊 Scope Variables (Current Location)</h2>
                      <button onClick={() => handleThreadClick(selectedThread)} className="refresh-btn">🔄</button>
                    </div>
                    <div className="variables-grid">
                      {Object.entries(variables).map(([key, value]) => (
                        <div key={key} className="variable-item">
                          <span className="var-name">{key}:</span>
                          <span className="var-value">{String(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(variables).length === 0 && selectedThread && threads.find(t => t.name === selectedThread && t.isSuspended) && (
                  <div className="panel variables-panel" style={{ borderColor: '#858585', opacity: 0.7 }}>
                    <div className="panel-header">
                      <h2>📊 Scope Variables</h2>
                      <button onClick={() => handleThreadClick(selectedThread)} className="refresh-btn">🔄</button>
                    </div>
                    <p style={{ color: '#858585', fontStyle: 'italic', padding: '1rem' }}>No variables available at this location. Thread may be in framework code. Try stepping to application code.</p>
                  </div>
                )}
              </>
            )}

            <div className="panel">
              <div className="panel-header">
                <h2>Server API Endpoints</h2>
              </div>
              <div className="api-test-panel">
                <div className="endpoints-list">
                  {endpoints.map(([endpoint, desc], idx) => {
                    const [method, path] = endpoint.split(' ')
                    return (
                      <div key={idx} className="endpoint-item">
                        <span className="endpoint-method">{method}</span>
                        <span className="endpoint-path">{path}</span>
                        <span className="endpoint-desc">{desc}</span>
                        <button
                          onClick={() => {
                            if (method === 'GET' || method === 'DELETE') {
                              callServerApi(path.replace('{id}', '1'), method)
                            } else {
                              const body = method === 'POST' 
                                ? { name: 'Test User', email: 'test@example.com', age: 25 }
                                : { name: 'Updated User', email: 'updated@example.com', age: 30 }
                              callServerApi(path.replace('{id}', '1'), method, body)
                            }
                          }}
                          disabled={apiLoading}
                          className="api-btn-small"
                        >
                          Call
                        </button>
                      </div>
                    )
                  })}
                </div>
                <div className="custom-api-call">
                  <h4>Custom API Call</h4>
                  <div className="custom-api-form">
                    <select
                      value={customEndpoint.method}
                      onChange={(e) => setCustomEndpoint({ ...customEndpoint, method: e.target.value })}
                    >
                      <option>GET</option>
                      <option>POST</option>
                      <option>PUT</option>
                      <option>DELETE</option>
                    </select>
                    <input
                      type="text"
                      placeholder="/api/users or /api/users/1"
                      value={customEndpoint.path}
                      onChange={(e) => setCustomEndpoint({ ...customEndpoint, path: e.target.value })}
                    />
                    {(customEndpoint.method === 'POST' || customEndpoint.method === 'PUT') && (
                      <textarea
                        placeholder='{"name": "User", "email": "user@example.com", "age": 25}'
                        value={customEndpoint.body}
                        onChange={(e) => setCustomEndpoint({ ...customEndpoint, body: e.target.value })}
                        rows="3"
                      />
                    )}
                    <button onClick={handleCustomApiCall} disabled={apiLoading} className="api-btn">
                      Send Request
                    </button>
                  </div>
                </div>
                {apiLoading && (
                  <div className="api-loading">Loading...</div>
                )}
                {apiResponse && (
                  <div className="api-response">
                    <h4>Server Response:</h4>
                    <pre>{JSON.stringify(apiResponse, null, 2)}</pre>
                  </div>
                )}
              </div>
            </div>

            <div className="panel logs-panel">
              <div className="panel-header">
                <h2>Debug Logs</h2>
                <button onClick={() => setLogs([])} className="refresh-btn">Clear</button>
              </div>
              <div className="logs-list-scrollable">
                {logs.length === 0 ? (
                  <div className="info-text">No logs yet. Debugging actions will appear here.</div>
                ) : (
                  logs.map((log, idx) => (
                    <div key={idx} className={`log-item log-${log.type}`}>
                      <div className="log-header">
                        <span className="log-time">{log.timestamp}</span>
                        <span className="log-title">{log.title}</span>
                      </div>
                      {log.data && Object.keys(log.data).length > 0 && typeof log.data === 'object' && (
                        <pre className="log-data">{JSON.stringify(log.data, null, 2)}</pre>
                      )}
                      {log.data && typeof log.data === 'string' && (
                        <div className="log-data-text">{log.data}</div>
                      )}
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
