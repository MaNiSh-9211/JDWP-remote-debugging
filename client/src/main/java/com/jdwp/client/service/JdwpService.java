package com.jdwp.client.service;

import com.sun.jdi.*;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.IllegalConnectorArgumentsException;
import com.sun.jdi.event.*;
import com.sun.jdi.request.AccessWatchpointRequest;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import com.sun.jdi.request.ModificationWatchpointRequest;
import com.sun.jdi.request.StepRequest;
import com.sun.jdi.request.WatchpointRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

@Service
public class JdwpService {
    private static final Logger logger = LoggerFactory.getLogger(JdwpService.class);
    private VirtualMachine vm;
    private final Map<String, BreakpointRequest> breakpoints = new ConcurrentHashMap<>();
    // Track which threads we've already seen as suspended to avoid spam
    private final Set<String> knownSuspendedThreads = ConcurrentHashMap.newKeySet();
    // Track conditional breakpoints - maps breakpointId to targetRequestId
    private final Map<String, String> conditionalBreakpoints = new ConcurrentHashMap<>();
    private volatile Thread conditionalResumeThread = null;

    /** Field read/write watchpoints (JDI); cleared on disconnect */
    private final Map<String, WatchpointRequest> fieldWatchpoints = new ConcurrentHashMap<>();
    /** When true, new and existing line breakpoints stay disabled until unmuted */
    private volatile boolean breakpointsMuted = false;

    /** Session-scoped breakpoint hit counts (for analytics UI). */
    private final Map<String, AtomicInteger> breakpointHitCounts = new ConcurrentHashMap<>();

    /**
     * Advanced per-breakpoint behaviour: logpoint messages, boolean conditions,
     * disabled state. Keyed by breakpoint id.
     */
    public static final class BpOptions {
        public String logMessage;      // when set: logpoint - capture vars, emit, auto-resume
        public String condition;       // when set: suspend only if expression evaluates truthy
        public Integer minHits;        // when set: only start suspending from the Nth hit
        public volatile boolean disabled;
    }

    private final Map<String, BpOptions> breakpointOptions = new ConcurrentHashMap<>();

    /** Broadcasts a logpoint entry to the live SSE stream and the log store (best effort). */
    private void emitLogpoint(String bpId, String threadName, String message) {
        logger.info("[JDWP CLIENT] LOGPOINT {} on {}: {}", bpId, threadName, message);
        try {
            LogReceiverService.LogEntry e = new LogReceiverService.LogEntry();
            e.type = "logpoint";
            e.stream = "stdout";
            e.thread = threadName;
            e.timestamp = System.currentTimeMillis();
            e.message = "[LOGPOINT " + bpId + "] " + message;
            if (logReceiverService != null) {
                logReceiverService.ingestExternal(e); // store + broadcast in one path
            } else if (logStreamService != null) {
                logStreamService.broadcast(e);
            }
        } catch (Exception ex) {
            logger.debug("logpoint broadcast failed: {}", ex.getMessage());
        }
    }

    /** Capture frame-0 local variables as name=value strings (fast, no JDI invokes). */
    private Map<String, String> captureFrameLocals(ThreadReference thread) {
        Map<String, String> out = new LinkedHashMap<>();
        try {
            com.sun.jdi.StackFrame frame = thread.frame(0);
            for (com.sun.jdi.LocalVariable var : frame.visibleVariables()) {
                com.sun.jdi.Value v = frame.getValue(var);
                String s = v == null ? "null" : v.toString();
                if (s.length() > 200) s = s.substring(0, 200) + "...";
                out.put(var.name(), s);
            }
        } catch (Exception e) {
            logger.debug("captureFrameLocals failed: {}", e.getMessage());
        }
        return out;
    }

    /** Substitute {var} tokens in a logpoint template with captured locals. */
    private static String renderLogTemplate(String template, Map<String, String> locals) {
        StringBuilder sb = new StringBuilder(template.length() + 64);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\{(\\w+)\\}").matcher(template);
        while (m.find()) {
            String val = locals.getOrDefault(m.group(1), "{" + m.group(1) + "?}");
            m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(val));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /**
     * JDWP event pump. JDI only applies SUSPEND_* policies when the debugger
     * READS the EventSet — without this thread breakpoints and steps would
     * fire on the wire but never suspend anything.
     */
    private volatile Thread eventPumpThread;
    /** Most recent breakpoint hit: bpId, threadName, className, methodName, lineNumber, timestamp. */
    private volatile Map<String, Object> lastBreakpointHit;

    @Autowired(required = false)
    private com.jdwp.client.service.LogReceiverService logReceiverService;

    @Autowired(required = false)
    private com.jdwp.client.service.LogStreamService logStreamService;

    @Autowired(required = false)
    private com.jdwp.client.security.AuditService auditService;

    /** Fire-and-forget audit event (no-op when the audit service is absent). */
    private void audit(String action, Map<String, ?> detail) {
        if (auditService != null) {
            auditService.log(action, detail);
        }
    }
    
    private static final int CONNECT_RETRIES = 3;
    private static final long CONNECT_RETRY_DELAY_MS = 2500;
    private static final String CONNECTOR_TIMEOUT_MS = "10000";

    /** Last JDWP attach target (cleared on disconnect). */
    private volatile String sessionTargetHost = "";
    private volatile int sessionTargetPort = 0;

    /**
     * All JDI / VirtualMachine calls must be serialized — Spring serves concurrent HTTP requests;
     * com.sun.jdi is not thread-safe. Child worker threads in the target VM are handled by JDI;
     * we only serialize access to the debugger client side.
     */
    public synchronized boolean connect(String host, int port) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] Attempting to connect to JDWP server at {}:{}", host, port);
        logger.info("========================================");
        try {
            // Clear all breakpoint state so each connection starts fresh (avoids stale breakpoints after target restart at 5005)
            breakpoints.clear();
            conditionalBreakpoints.clear();
            breakpointOptions.clear();
            knownSuspendedThreads.clear();
            logger.info("[JDWP CLIENT] Cleared breakpoints and thread state for fresh connection");

            if (vm != null) {
                logger.info("[JDWP CLIENT] Disposing existing VM connection...");
                try {
                    vm.dispose();
                } catch (Exception e) {
                    logger.debug("[JDWP CLIENT] VM already disposed or disconnected: {}", e.getMessage());
                }
            }
            
            logger.info("[JDWP CLIENT] Getting SocketAttach connector...");
            AttachingConnector connector = Bootstrap.virtualMachineManager()
                    .attachingConnectors()
                    .stream()
                    .filter(c -> c.name().equals("com.sun.jdi.SocketAttach"))
                    .findFirst()
                    .orElseThrow(() -> new RuntimeException("SocketAttach connector not found"));
            
            Map<String, Connector.Argument> arguments = connector.defaultArguments();
            arguments.get("hostname").setValue(host);
            arguments.get("port").setValue(String.valueOf(port));
            Connector.Argument timeoutArg = arguments.get("timeout");
            if (timeoutArg != null) {
                timeoutArg.setValue(CONNECTOR_TIMEOUT_MS);
                logger.info("[JDWP CLIENT] Set connector timeout: {} ms", CONNECTOR_TIMEOUT_MS);
            }
            
            RuntimeException lastException = null;
            for (int attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
                try {
                    logger.info("[JDWP CLIENT] Attaching to JDWP server (attempt {}/{}...", attempt, CONNECT_RETRIES);
                    vm = connector.attach(arguments);
                    break;
                } catch (Exception e) {
                    lastException = new RuntimeException("Failed to connect to JDWP server: " + e.getMessage(), e);
                    boolean isHandshakeOrPremature = e.getMessage() != null
                            && (e.getMessage().toLowerCase().contains("handshake")
                                    || e.getMessage().toLowerCase().contains("premature"));
                    if (isHandshakeOrPremature && attempt < CONNECT_RETRIES) {
                        logger.warn("[JDWP CLIENT] Handshake failed (attempt {}/{}), retrying in {} ms...", attempt, CONNECT_RETRIES, CONNECT_RETRY_DELAY_MS);
                        try {
                            Thread.sleep(CONNECT_RETRY_DELAY_MS);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            throw new RuntimeException("Interrupted while retrying JDWP connect", ie);
                        }
                    } else {
                        throw buildConnectException(e, host, port);
                    }
                }
            }
            if (vm == null && lastException != null) {
                throw lastException;
            }
            logger.info("[JDWP CLIENT] ✓✓✓ Successfully connected to JDWP server at {}:{}", host, port);
            logger.info("[JDWP CLIENT] VM Description: {}", vm.description());
            sessionTargetHost = host;
            sessionTargetPort = port;
            audit("connect", Map.of("host", host, "port", port));
            
            // Set VM reference for log receiver
            if (logReceiverService != null) {
                logReceiverService.setVirtualMachine(vm);
                // Start log receiver BEFORE agent injection so it's ready
                if (!logReceiverService.isRunning()) {
                    logger.info("[JDWP CLIENT] Starting log receiver on port 9999...");
                    try {
                        logReceiverService.start(9999);
                        // Wait a moment for receiver to start
                        Thread.sleep(1000);
                        if (logReceiverService.isRunning()) {
                            logger.info("[JDWP CLIENT] ✓ Log receiver started successfully");
                        } else {
                            logger.error("[JDWP CLIENT] ✗ Log receiver failed to start");
                        }
                    } catch (Exception e) {
                        logger.error("[JDWP CLIENT] Failed to start log receiver: {}", e.getMessage(), e);
                    }
                } else {
                    logger.info("[JDWP CLIENT] Log receiver already running");
                }
            } else {
                logger.warn("[JDWP CLIENT] LogReceiverService is null - cannot start log receiver");
            }
            
            // Inject logging agent in background so we return success to frontend immediately.
            // Agent works independently of JDWP; blocking here was preventing the connect response.
            logger.info("[JDWP CLIENT] Starting agent injection in background (connect response will return now).");
            startEventPump();
            ExecutorService agentExecutor = Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "jdwp-agent-inject");
                t.setDaemon(true);
                return t;
            });
            agentExecutor.execute(() -> {
                try {
                    injectLoggingAgent();
                    logger.info("[JDWP CLIENT] Agent injection completed (background).");
                } catch (Exception e) {
                    logger.error("[JDWP CLIENT] Failed to inject logging agent: {}", e.getMessage(), e);
                }
            });
            agentExecutor.shutdown();
            
            logger.info("========================================");
            return true;
        } catch (Exception e) {
            sessionTargetHost = "";
            sessionTargetPort = 0;
            logger.error("[JDWP CLIENT] ✗✗✗ Failed to connect to JDWP server: {}", e.getMessage(), e);
            throw buildConnectException(e, host, port);
        }
    }

    public String getSessionTargetHost() {
        return sessionTargetHost;
    }

    public int getSessionTargetPort() {
        return sessionTargetPort;
    }

    /** Best-effort VM description for status API; empty when not connected. */
    public synchronized String getVmDescriptionSafe() {
        if (vm == null) {
            return "";
        }
        try {
            return vm.description();
        } catch (Exception e) {
            return "";
        }
    }

    private static RuntimeException buildConnectException(Exception e, String host, int port) {
        String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        boolean handshakeOrPremature = msg.toLowerCase().contains("handshake") || msg.toLowerCase().contains("premature");
        String full = "Failed to connect to JDWP server: " + msg;
        if (handshakeOrPremature) {
            full += ". Tips: Only one debugger can attach — disconnect other clients or IDE. Ensure port-forward is to the container JDWP port (5005), not HTTP. Wait for the pod to be fully ready and retry.";
        }
        return new RuntimeException(full, e);
    }
    
    public synchronized void disconnect() {
        logger.info("[JDWP CLIENT] Disconnecting from JDWP server...");
        audit("disconnect", Map.of("host", sessionTargetHost, "port", sessionTargetPort));
        stopEventPump();
        if (vm != null) {
            try {
                logger.info("[JDWP CLIENT] Disposing VM connection...");
                vm.dispose();
                logger.info("[JDWP CLIENT] ✓ VM disposed successfully");
            } catch (Exception e) {
                logger.debug("[JDWP CLIENT] VM already disposed: {}", e.getMessage());
            }
            vm = null;
        }
        breakpoints.clear();
        conditionalBreakpoints.clear();
        breakpointOptions.clear();
        knownSuspendedThreads.clear(); // Clear tracking
        fieldWatchpoints.clear();
        breakpointsMuted = false;
        breakpointHitCounts.clear();
        sessionTargetHost = "";
        sessionTargetPort = 0;
        logger.info("[JDWP CLIENT] ✓✓✓ Disconnected from JDWP server");
    }
    
    public synchronized boolean isConnected() {
        if (vm == null) {
            return false;
        }
        try {
            // Try to access VM to check if it's still connected
            vm.allThreads();
            // Also check if VM is still alive
            if (vm.process() != null) {
                return true;
            }
            return true;
        } catch (com.sun.jdi.VMDisconnectedException e) {
            logger.debug("[JDWP CLIENT] VM disconnected: {}", e.getMessage());
            vm = null;
            return false;
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] Connection check failed: {}", e.getMessage());
            return false;
        }
    }
    
    public synchronized List<Map<String, Object>> getAllThreads() {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        // Get all threads
        List<ThreadReference> allThreads = vm.allThreads();
        
        // Update our tracking of suspended threads
        Set<String> currentlySuspended = allThreads.stream()
                .filter(ThreadReference::isSuspended)
                .map(ThreadReference::name)
                .collect(Collectors.toSet());
        
        // Remove threads that are no longer suspended from our tracking
        knownSuspendedThreads.retainAll(currentlySuspended);
        
        // Return thread info
        return allThreads.stream()
                .map(thread -> {
                    Map<String, Object> threadInfo = new HashMap<>();
                    threadInfo.put("name", thread.name());
                    threadInfo.put("status", getThreadStatusString(thread.status()));
                    threadInfo.put("isSuspended", thread.isSuspended());
                    threadInfo.put("suspended", thread.isSuspended()); // frontend expects "suspended"
                    threadInfo.put("threadGroup", thread.threadGroup() != null ? thread.threadGroup().name() : "N/A");
                    
                    // CRITICAL: Check if this thread is suspended at one of OUR breakpoints
                    boolean isAtOurBreakpoint = false;
                    if (thread.isSuspended()) {
                        try {
                            List<StackFrame> frames = thread.frames();
                            if (!frames.isEmpty()) {
                                StackFrame frame = frames.get(0);
                                Location currentLocation = frame.location();
                                String currentClassName = currentLocation.declaringType().name();
                                int currentLineNumber = currentLocation.lineNumber();
                                
                                // Check if this location matches any of our breakpoints
                                // Compare by className and lineNumber (more reliable than codeIndex)
                                for (Map.Entry<String, BreakpointRequest> entry : breakpoints.entrySet()) {
                                    try {
                                        String bpId = entry.getKey();
                                        BreakpointRequest bpRequest = entry.getValue();
                                        
                                        // Extract className and lineNumber from breakpoint ID (format: "className:lineNumber")
                                        if (bpId.contains(":")) {
                                            String[] parts = bpId.split(":", 2);
                                            String bpClassName = parts[0];
                                            int bpLineNumber = Integer.parseInt(parts[1]);
                                            
                                            // Match by className and lineNumber
                                            if (bpClassName.equals(currentClassName) && bpLineNumber == currentLineNumber) {
                                                // Match! Thread is at our breakpoint!
                                                isAtOurBreakpoint = true;
                                                logger.debug("[JDWP CLIENT] ✓ Thread {} is at breakpoint: {}:{}", 
                                                           thread.name(), currentClassName, currentLineNumber);
                                                break;
                                            }
                                        }
                                    } catch (Exception e) {
                                        logger.debug("[JDWP CLIENT] Could not check breakpoint location: {}", e.getMessage());
                                    }
                                }
                                
                                if (!isAtOurBreakpoint) {
                                    logger.debug("[JDWP CLIENT] Thread {} is suspended but NOT at our breakpoint: {}:{}", 
                                               thread.name(), currentClassName, currentLineNumber);
                                }
                            }
                        } catch (Exception e) {
                            logger.debug("[JDWP CLIENT] Could not check breakpoint location for thread {}: {}", thread.name(), e.getMessage());
                        }
                    }
                    
                    // Mark if this is a newly suspended thread (not seen before)
                    // AND it's at one of our breakpoints (not just randomly suspended)
                    boolean isNewlySuspended = thread.isSuspended() && 
                                             !knownSuspendedThreads.contains(thread.name()) &&
                                             isAtOurBreakpoint; // Only mark as new if at our breakpoint
                    
                    if (isNewlySuspended) {
                        threadInfo.put("isNewlySuspended", true);
                        knownSuspendedThreads.add(thread.name()); // Track it now
                        logger.debug("[JDWP CLIENT] ✓ NEW breakpoint hit detected: thread {} at breakpoint", thread.name());
                    } else {
                        threadInfo.put("isNewlySuspended", false);
                    }
                    threadInfo.put("atBreakpoint", isAtOurBreakpoint); // frontend uses this to pick the right thread for variables

                    return threadInfo;
                })
                .sorted((a, b) -> {
                    // 1) At-breakpoint threads first
                    boolean aAtBp = Boolean.TRUE.equals(a.get("atBreakpoint"));
                    boolean bAtBp = Boolean.TRUE.equals(b.get("atBreakpoint"));
                    if (aAtBp != bAtBp) return aAtBp ? -1 : 1;
                    // 2) Among at-breakpoint/suspended, prefer request-executor threads (http-nio-*-exec-*), not Acceptor/Poller
                    String aName = (String) a.get("name");
                    String bName = (String) b.get("name");
                    boolean aExec = aName != null && aName.matches(".*-exec-\\d+$");
                    boolean bExec = bName != null && bName.matches(".*-exec-\\d+$");
                    if (aExec != bExec) return aExec ? -1 : 1;
                    // 3) Then prefer other http-nio-* over non-http
                    boolean aHttp = aName != null && aName.startsWith("http-nio-");
                    boolean bHttp = bName != null && bName.startsWith("http-nio-");
                    if (aHttp != bHttp) return aHttp ? -1 : 1;
                    // 4) Suspended before running
                    boolean aSus = Boolean.TRUE.equals(a.get("isSuspended"));
                    boolean bSus = Boolean.TRUE.equals(b.get("isSuspended"));
                    if (aSus != bSus) return aSus ? -1 : 1;
                    // 5) Stable order by name
                    return (aName != null && bName != null) ? aName.compareTo(bName) : 0;
                })
                .collect(Collectors.toList());
    }
    
    public synchronized List<Map<String, Object>> getThreadStackFrames(String threadName) {
        logger.info("[JDWP CLIENT] Getting stack frames for thread: {}", threadName);
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        try {
            if (!thread.isSuspended()) {
                logger.info("[JDWP CLIENT] Thread not suspended, suspending...");
                thread.suspend();
            }
            
            // Wait a bit for thread to be fully suspended
            Thread.sleep(200);
            
            List<Map<String, Object>> frames = new ArrayList<>();
            int frameIndex = 0;
            for (StackFrame frame : thread.frames()) {
                Map<String, Object> frameInfo = new HashMap<>();
                Location location = frame.location();
                String className = location.declaringType().name();
                String methodName = location.method().name();
                int lineNumber = location.lineNumber();
                
                frameInfo.put("method", methodName);
                frameInfo.put("class", className);
                frameInfo.put("lineNumber", lineNumber);
                
                Map<String, Object> variables = new HashMap<>();
                try {
                    for (LocalVariable var : frame.visibleVariables()) {
                        try {
                            Value value = frame.getValue(var);
                            String valueStr = value != null ? value.toString() : "null";
                            variables.put(var.name(), valueStr);
                            logger.info("[JDWP CLIENT]   Frame {} - Variable: {} = {}", frameIndex, var.name(), valueStr);
                        } catch (Exception e) {
                            logger.debug("[JDWP CLIENT]   Frame {} - Variable {} not accessible: {}", frameIndex, var.name(), e.getMessage());
                        }
                    }
                } catch (Exception e) {
                    logger.debug("[JDWP CLIENT]   Frame {} - Some variables not accessible: {}", frameIndex, e.getMessage());
                }
                frameInfo.put("variables", variables);
                
                logger.info("[JDWP CLIENT]   Frame #{}: {}:{}:{} ({} variables)", 
                           frameIndex, 
                           className,
                           methodName, 
                           lineNumber,
                           variables.size());
                if (!variables.isEmpty()) {
                    for (String varName : variables.keySet()) {
                        logger.info("[JDWP CLIENT]     - {} = {}", varName, variables.get(varName));
                    }
                }
                
                frames.add(frameInfo);
                frameIndex++;
            }
            
            logger.info("[JDWP CLIENT] ✓ Retrieved {} stack frames for thread {}", frames.size(), threadName);
            logger.info("[JDWP CLIENT] Stack trace (top to bottom):");
            for (int i = 0; i < Math.min(frames.size(), 10); i++) {
                Map<String, Object> f = frames.get(i);
                logger.info("[JDWP CLIENT]   [{}/{}] {}:{}:{}", 
                           i+1, frames.size(),
                           f.get("class"), f.get("method"), f.get("lineNumber"));
            }
            return frames;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗ Failed to get stack frames: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to get stack frames: " + e.getMessage(), e);
        }
    }
    
    public synchronized String setBreakpoint(String className, int lineNumber) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] Setting breakpoint at {}:{}", className, lineNumber);
        logger.info("========================================");
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        try {
            logger.info("[JDWP CLIENT] Waiting for class {} to be loaded...", className);
            // Wait for class to be loaded (with retries - 20 x 500ms = 10s)
            List<ReferenceType> classes = null;
            for (int i = 0; i < 20; i++) {
                classes = vm.classesByName(className);
                if (!classes.isEmpty()) {
                    logger.info("[JDWP CLIENT] ✓ Class found (attempt {})", i + 1);
                    break;
                }
                logger.debug("[JDWP CLIENT] Class not loaded yet, waiting... (attempt {})", i + 1);
                Thread.sleep(500);
            }
            
            if (classes == null || classes.isEmpty()) {
                logger.error("[JDWP CLIENT] ✗ Class not found or not loaded yet: {}", className);
                throw new RuntimeException("Class not found or not loaded yet: " + className
                    + ". Trigger a request to an API that uses this class (e.g. call the VCP endpoint once), then set the breakpoint again.");
            }
            
            ReferenceType clazz = classes.get(0);
            logger.info("[JDWP CLIENT] Looking for executable code at line {}...", lineNumber);
            List<Location> locations = clazz.locationsOfLine(lineNumber);
            
            if (locations.isEmpty()) {
                logger.info("[JDWP CLIENT] No executable code at line {}, searching nearby lines...", lineNumber);
                // Try to find nearest executable line
                for (int offset = 1; offset <= 5; offset++) {
                    locations = clazz.locationsOfLine(lineNumber + offset);
                    if (!locations.isEmpty()) {
                        lineNumber = lineNumber + offset;
                        logger.info("[JDWP CLIENT] Found executable code at line {} (offset +{})", lineNumber, offset);
                        break;
                    }
                    locations = clazz.locationsOfLine(lineNumber - offset);
                    if (!locations.isEmpty()) {
                        lineNumber = lineNumber - offset;
                        logger.info("[JDWP CLIENT] Found executable code at line {} (offset -{})", lineNumber, offset);
                        break;
                    }
                }
                
                if (locations.isEmpty()) {
                    logger.error("[JDWP CLIENT] ✗ No executable code found at line {} in class {}", lineNumber, className);
                    throw new RuntimeException("No executable code found at line " + lineNumber + 
                        " in class " + className + ". The line may be a comment, blank, or not yet compiled.");
                }
            } else {
                logger.info("[JDWP CLIENT] ✓ Found executable code at line {}", lineNumber);
            }
            
            Location location = locations.get(0);
            String actualClassName = location.declaringType().name();
            String methodName = location.method().name();
            int actualLineNumber = location.lineNumber();
            
            logger.info("[JDWP CLIENT] Location details:");
            logger.info("[JDWP CLIENT]   Class: {}", actualClassName);
            logger.info("[JDWP CLIENT]   Method: {}", methodName);
            logger.info("[JDWP CLIENT]   Line: {} (requested: {})", actualLineNumber, lineNumber);
            
            EventRequestManager erm = vm.eventRequestManager();
            BreakpointRequest bpRequest = erm.createBreakpointRequest(location);
            // Default JDWP policy is often SUSPEND_ALL → every thread shows ⏸ in the UI. Only suspend the hitting thread.
            bpRequest.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            bpRequest.enable();
            if (breakpointsMuted) {
                bpRequest.setEnabled(false);
            }
            
            String bpId = className + ":" + lineNumber;
            breakpoints.put(bpId, bpRequest);
            audit("set-breakpoint", Map.of("breakpoint", bpId, "conditional", conditionalBreakpoints.containsKey(bpId)));
            startConditionalResumeThreadIfNeeded(); // so regular breakpoints auto-resume when no debug header
            logger.info("[JDWP CLIENT] ✓✓✓ BREAKPOINT SET SUCCESSFULLY");
            logger.info("[JDWP CLIENT]   Breakpoint ID: {}", bpId);
            logger.info("[JDWP CLIENT]   Actual Location: {}:{}:{}", actualClassName, methodName, actualLineNumber);
            logger.info("[JDWP CLIENT]   Breakpoint is ACTIVE and will suspend execution when hit");
            logger.info("========================================");
            return bpId;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗✗✗ Failed to set breakpoint: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to set breakpoint: " + e.getMessage(), e);
        }
    }
    
    /**
     * Set a CONDITIONAL breakpoint: only requests with X-Debug-Request-Id header matching targetRequestId will be suspended.
     * Other requests that hit this line are auto-resumed. Requires the target app to have a filter that sets requestId from the header
     * (e.g. DebugRequestFilter from debug-filter-lib, or request-scoped variable in controller).
     *
     * @param className The fully qualified class name
     * @param lineNumber The line number for the breakpoint
     * @param targetRequestId The X-Debug-Request-Id value that should trigger suspension
     * @return The breakpoint ID
     */
    public synchronized String setConditionalBreakpoint(String className, int lineNumber, String targetRequestId) {
        logger.info("[JDWP CLIENT] Setting CONDITIONAL breakpoint at {}:{} (only X-Debug-Request-Id: {} will suspend)", className, lineNumber, targetRequestId);
        String bpId = setBreakpoint(className, lineNumber);
        conditionalBreakpoints.put(bpId, targetRequestId);
        startConditionalResumeThreadIfNeeded();
        logger.info("[JDWP CLIENT] Conditional breakpoint registered; other requests will auto-resume");
        return bpId;
    }

    /**
     * Enterprise breakpoint: plain line BP plus optional logpoint message
     * ({var} tokens), boolean condition (evaluated on hit via expression
     * evaluation; falsy auto-resumes), or disabled state.
     *
     * @return map with breakpointId + resolved location info
     */
    public synchronized Map<String, Object> setAdvancedBreakpoint(String className, int lineNumber,
                                                                  String logMessage, String condition,
                                                                  Integer minHits) {
        // One breakpoint per location (IDE semantics): replace any existing one.
        String existingId = className + ":" + lineNumber;
        if (breakpoints.containsKey(existingId)) {
            removeBreakpoint(existingId);
        }
        String bpId = setBreakpoint(className, lineNumber);
        BpOptions opts = new BpOptions();
        if (logMessage != null && !logMessage.isBlank()) opts.logMessage = logMessage.trim();
        if (condition != null && !condition.isBlank()) opts.condition = condition.trim();
        if (minHits != null && minHits > 0) opts.minHits = minHits;
        if (opts.logMessage != null || opts.condition != null || opts.minHits != null) {
            breakpointOptions.put(bpId, opts);
        } else {
            breakpointOptions.remove(bpId);
        }
        Map<String, Object> out = new HashMap<>();
        out.put("breakpointId", bpId);
        out.put("logMessage", opts.logMessage);
        out.put("condition", opts.condition);
        out.put("minHits", opts.minHits);
        return out;
    }

    /** Enable/disable one breakpoint without removing it. */
    public synchronized boolean toggleBreakpoint(String bpId, boolean enabled) {
        BreakpointRequest req = breakpoints.get(bpId);
        if (req == null) throw new IllegalArgumentException("Unknown breakpoint: " + bpId);
        req.setEnabled(enabled);
        BpOptions opts = breakpointOptions.computeIfAbsent(bpId, k -> new BpOptions());
        opts.disabled = !enabled;
        audit("toggle-breakpoint", Map.of("breakpoint", bpId, "enabled", enabled));
        return enabled;
    }

    /** Options snapshot for the breakpoints listing. */
    public BpOptions getBreakpointOptions(String bpId) {
        return breakpointOptions.get(bpId);
    }
    
    /** True only when this request had X-Debug-Request-Id header with a non-empty value (from DebugRequestFilter frame). */
    private boolean isDebugRequestId(String requestId) {
        if (requestId == null) return false;
        String t = requestId.trim();
        return !t.isEmpty();
    }

    /**
     * Returns true when the thread has X-Debug-Request-Id (any value) in its stack (e.g. debugRequestId in DebugRequestFilter).
     * Only such requests stay suspended; all others are auto-resumed.
     */
    private boolean hasDebugRequestIdInStack(ThreadReference thread) {
        try {
            if (!thread.isSuspended()) return false;
            String found = findRequestIdInStack(thread);
            return isDebugRequestId(found);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Find X-Debug-Request-Id value from the thread's stack.
     * Prefer DebugRequestFilter frame (debugRequestId = request.getHeader(X-Debug-Request-Id)).
     * Fallback: if filter isn't present (e.g. mock service), read debugRequestId from any frame.
     */
    private String findRequestIdInStack(ThreadReference thread) {
        try {
            List<StackFrame> frames = thread.frames();
            String fallback = null;
            for (StackFrame frame : frames) {
                try {
                    Location loc = frame.location();
                    String className = loc.declaringType().name();
                    boolean isFilter = className.contains("DebugRequestFilter") || className.contains("debugger.filter");
                    try {
                        LocalVariable v = frame.visibleVariableByName("debugRequestId");
                        if (v == null && isFilter) {
                            v = frame.visibleVariableByName("requestId");
                        }
                        if (v != null) {
                            Value val = frame.getValue(v);
                            if (val != null) {
                                String s = val.toString();
                                if (s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
                                if (s != null && !s.trim().isEmpty()) {
                                    if (isFilter) return s; // strongest signal
                                    if (fallback == null) fallback = s;
                                }
                            }
                        }
                    } catch (AbsentInformationException ignored) {}
                } catch (Exception ignored) {}
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Check if a thread should be suspended based on its request ID.
     * Looks for the requestId variable in DebugRequestFilter's stack frame.
     * 
     * @param thread The suspended thread to check
     * @param targetRequestId The request ID that should trigger suspension
     * @return true if this thread should remain suspended, false if it should be resumed
     */
    private boolean shouldSuspendThread(ThreadReference thread, String targetRequestId) {
        try {
            if (!thread.isSuspended()) {
                return false;
            }
            
            String foundRequestId = findRequestIdInStack(thread);
            
            // If we couldn't find a request ID in the stack: RESUME so the request completes. Otherwise every
            // request that hits the breakpoint would hang until the user clicks Continue.
            // Only requests that have X-Debug-Request-Id set in the target app (and we can read it from the stack) stay suspended.
            if (foundRequestId == null) {
                logger.debug("[JDWP CLIENT] Thread {} has no requestId in stack - resuming (request will complete; add X-Debug-Request-Id in target app to pause only that request)", thread.name());
                return false; // Do NOT keep suspended - resume so normal requests complete
            }
            
            boolean matches = targetRequestId.equals(foundRequestId);
            
            if (matches) {
                logger.debug("[JDWP CLIENT] ✓ Thread {} has MATCHING request ID: {} - KEEPING SUSPENDED", 
                           thread.name(), foundRequestId);
            } else {
                logger.debug("[JDWP CLIENT] → Thread {} has different request ID: {} (expected: {}) - WILL RESUME", 
                           thread.name(), foundRequestId, targetRequestId);
            }
            
            return matches;
            
        } catch (Exception e) {
            logger.warn("[JDWP CLIENT] Error checking request ID for thread {}: {}", thread.name(), e.getMessage());
            // On error, don't suspend - safer to let requests through than to block all traffic
            return false;
        }
    }

    /**
     * Background thread that drains the JDWP EventQueue.
     *
     * JDI semantics: the target JVM suspends a thread (per the event request's
     * suspend policy) only when the debugger reads the EventSet. This pump is
     * therefore what makes breakpoints/step events physically suspend threads.
     * Suspension policy decisions (keep vs auto-resume non-matching requests)
     * stay with {@link #runConditionalResumePass()}.
     */
    private synchronized void startEventPump() {
        stopEventPump();
        Thread pump = new Thread(() -> {
            logger.info("[JDWP CLIENT] JDWP event pump started");
            while (!Thread.currentThread().isInterrupted()) {
                VirtualMachine currentVm = this.vm;
                if (currentVm == null) {
                    break;
                }
                try {
                    com.sun.jdi.event.EventSet events = currentVm.eventQueue().remove();
                    for (com.sun.jdi.event.Event event : events) {
                        if (event instanceof com.sun.jdi.event.BreakpointEvent) {
                            handleBreakpointEvent((com.sun.jdi.event.BreakpointEvent) event);
                        } else if (event instanceof com.sun.jdi.event.StepEvent) {
                            logger.debug("[JDWP CLIENT] Step completed on thread {}",
                                    ((com.sun.jdi.event.StepEvent) event).thread().name());
                        } else if (event instanceof com.sun.jdi.event.ExceptionEvent) {
                            com.sun.jdi.event.ExceptionEvent ee = (com.sun.jdi.event.ExceptionEvent) event;
                            logger.debug("[JDWP CLIENT] Exception event: {}",
                                    ee.exception() == null || ee.exception().referenceType() == null ? "?"
                                            : ee.exception().referenceType().name());
                        }
                    }
                    // Do NOT resume here except for logpoints/conditions/disabled
                    // (handled inline above): the conditional-resume pass decides
                    // which remaining threads stay suspended (request-scoped).
                } catch (com.sun.jdi.VMDisconnectedException e) {
                    logger.info("[JDWP CLIENT] Event pump stopping (VM disconnected)");
                    break;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    logger.debug("[JDWP CLIENT] Event pump error: {}", e.getMessage());
                }
            }
            logger.info("[JDWP CLIENT] JDWP event pump stopped");
        }, "jdwp-event-pump");
        pump.setDaemon(true);
        this.eventPumpThread = pump;
        pump.start();
    }

    /**
     * Enterprise breakpoint behaviour on hit, in order:
     *   disabled -> resume immediately (no record)
     *   logpoint -> capture locals, render template, emit to log stream, resume
     *   condition-> evaluate; falsy resumes, truthy falls through to suspend flow
     *   default  -> record hit metadata and leave suspended for the resume pass
     */
    private void handleBreakpointEvent(com.sun.jdi.event.BreakpointEvent event) {
        String bpId;
        String threadName;
        try {
            bpId = event.location().declaringType().name() + ":" + event.location().lineNumber();
            threadName = event.thread() != null ? event.thread().name() : "unknown";
        } catch (Exception e) {
            recordEventHit(event);
            return;
        }

        BpOptions opts = breakpointOptions.get(bpId);
        int hitNumber = recordBreakpointHit(bpId); // 1-based count for this event

        if (opts != null && opts.disabled) {
            try { event.thread().resume(); } catch (Exception ignore) { }
            logger.debug("[JDWP CLIENT] Breakpoint {} disabled - resumed", bpId);
            return;
        }

        if (opts != null && opts.minHits != null && hitNumber < opts.minHits) {
            try { event.thread().resume(); } catch (Exception ignore) { }
            logger.debug("[JDWP CLIENT] Breakpoint {} hit {} < {} - skipped", bpId, hitNumber, opts.minHits);
            return;
        }

        if (opts != null && opts.logMessage != null && !opts.logMessage.isBlank()) {
            Map<String, String> locals = captureFrameLocals(event.thread());
            String rendered = renderLogTemplate(opts.logMessage, locals);
            emitLogpoint(bpId, threadName, rendered);
            recordBreakpointHit(bpId);
            try { event.thread().resume(); } catch (Exception ignore) { }
            return;
        }

        if (opts != null && opts.condition != null && !opts.condition.isBlank()) {
            boolean truthy;
            try {
                String res = evaluateExpression(threadName, opts.condition);
                truthy = isTruthy(res);
            } catch (Exception e) {
                logger.warn("[JDWP CLIENT] Condition '{}' eval failed on {}: {} - treating as false",
                        opts.condition, threadName, e.getMessage());
                truthy = false;
            }
            if (!truthy) {
                try { event.thread().resume(); } catch (Exception ignore) { }
                recordBreakpointHit(bpId);
                logger.debug("[JDWP CLIENT] Condition false at {} on {} - resumed", bpId, threadName);
                return;
            }
            // condition true: fall through to normal suspension recording
        }

        recordEventHit(event);
    }

    /** Logpoint/condition style truthiness for string evaluation results. */
    private static boolean isTruthy(String result) {
        if (result == null) return false;
        String s = result.trim();
        if (s.isEmpty()) return false;
        try {
            if (s.matches("\"?\\d+(\\.0*)?\"?") && Double.parseDouble(s.replace("\"", "")) == 0d) return false;
        } catch (NumberFormatException ignore) { }
        return !s.equalsIgnoreCase("false") && !s.equalsIgnoreCase("null");
    }

    private synchronized void stopEventPump() {
        Thread pump = this.eventPumpThread;
        if (pump != null && pump.isAlive()) {
            pump.interrupt();
        }
        this.eventPumpThread = null;
    }

    /** Capture hit metadata for the UI/wait-for-breakpoint API and analytics counters. */
    private void recordEventHit(com.sun.jdi.event.BreakpointEvent event) {
        try {
            Location loc = event.location();
            String className = loc.declaringType().name();
            int lineNumber = loc.lineNumber();
            String threadName = event.thread() != null ? event.thread().name() : "unknown";
            String bpId = className + ":" + lineNumber;

            Map<String, Object> hit = new HashMap<>();
            hit.put("breakpointId", bpId);
            hit.put("threadName", threadName);
            hit.put("className", className);
            hit.put("methodName", loc.method().name());
            hit.put("lineNumber", lineNumber);
            hit.put("timestamp", System.currentTimeMillis());
            hit.put("isConditional", conditionalBreakpoints.containsKey(bpId));
            hit.put("targetRequestId", conditionalBreakpoints.get(bpId));
            this.lastBreakpointHit = hit;
            recordBreakpointHit(bpId);
            logger.info("[JDWP CLIENT] ✓ BREAKPOINT HIT: {} on thread {} at {}:{}",
                    bpId, threadName, className, lineNumber);
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] Failed to record breakpoint hit: {}", e.getMessage());
        }
    }

    /** Latest breakpoint hit for polling APIs; null when nothing has hit yet. */
    public Map<String, Object> getLastBreakpointHit() {
        return lastBreakpointHit == null ? null : new HashMap<>(lastBreakpointHit);
    }

    private synchronized void startConditionalResumeThreadIfNeeded() {
        if (conditionalResumeThread != null && conditionalResumeThread.isAlive()) {
            return;
        }
        conditionalResumeThread = new Thread(() -> {
            logger.info("[JDWP CLIENT] Conditional resume checker thread started");
            while (isConnected() && !Thread.currentThread().isInterrupted()) {
                try {
                    // Run for any breakpoints: conditional (match header) or regular (resume when no header)
                    if (!breakpoints.isEmpty()) {
                        runConditionalResumePass();
                    }
                    Thread.sleep(25);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    logger.debug("[JDWP CLIENT] Conditional resume pass error: {}", e.getMessage());
                }
            }
            logger.info("[JDWP CLIENT] Conditional resume checker thread stopped");
        }, "jdwp-conditional-resume");
        conditionalResumeThread.setDaemon(true);
        conditionalResumeThread.start();
    }

    /** One pass: find suspended threads at breakpoints and resume when (1) conditional and ID doesn't match, or (2) regular and no debug header. */
    private void runConditionalResumePass() {
        if (!isConnected() || vm == null || breakpoints.isEmpty()) {
            return;
        }
        try {
            List<ThreadReference> suspendedThreads = vm.allThreads().stream()
                    .filter(ThreadReference::isSuspended)
                    .collect(Collectors.toList());
            for (ThreadReference thread : suspendedThreads) {
                try {
                    List<StackFrame> frames = thread.frames();
                    if (frames.isEmpty()) continue;
                    StackFrame frame = frames.get(0);
                    Location location = frame.location();
                    String className = location.declaringType().name();
                    int lineNumber = location.lineNumber();
                    for (Map.Entry<String, BreakpointRequest> entry : breakpoints.entrySet()) {
                        String bpId = entry.getKey();
                        if (!bpId.contains(":")) continue;
                        String[] parts = bpId.split(":", 2);
                        String bpClassName = parts[0];
                        int bpLineNumber = Integer.parseInt(parts[1]);
                        if (bpClassName.equals(className) && bpLineNumber == lineNumber) {
                            String targetRequestId = conditionalBreakpoints.get(bpId);
                            boolean shouldResume = false;
                            if (targetRequestId != null) {
                                // Conditional breakpoint: resume if request ID doesn't match
                                shouldResume = !shouldSuspendThread(thread, targetRequestId);
                            } else {
                                // Regular breakpoint: resume unless request has DEBUG header (e.g. X-Debug-Request-Id: debug-xxx)
                                shouldResume = !hasDebugRequestIdInStack(thread);
                            }
                            if (shouldResume) {
                                thread.resume();
                                logger.info("[JDWP CLIENT] Auto-resumed thread {} (no X-Debug-Request-Id header - request continues)", thread.name());
                            }
                            break;
                        }
                    }
                } catch (Exception e) {
                    // continue with next thread
                }
            }
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] runConditionalResumePass: {}", e.getMessage());
        }
    }
    
    public synchronized int removeAllBreakpoints() {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] REMOVING ALL BREAKPOINTS");
        logger.info("========================================");
        
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        int count = breakpoints.size();
        logger.info("[JDWP CLIENT] Removing {} breakpoints...", count);
        
        try {
            EventRequestManager erm = vm.eventRequestManager();
            for (BreakpointRequest bp : breakpoints.values()) {
                try {
                    erm.deleteEventRequest(bp);
                    logger.info("[JDWP CLIENT]   Removed breakpoint: {}", bp);
                } catch (Exception e) {
                    logger.warn("[JDWP CLIENT]   Failed to remove breakpoint: {}", e.getMessage());
                }
            }
            breakpoints.clear();
            logger.info("[JDWP CLIENT] ✓ All {} breakpoints removed successfully", count);
            logger.info("========================================");
            return count;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗ Failed to remove all breakpoints: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to remove all breakpoints: " + e.getMessage(), e);
        }
    }
    
    public synchronized void removeBreakpoint(String bpId) {
        logger.info("[JDWP CLIENT] Removing breakpoint: {}", bpId);
        BreakpointRequest bp = breakpoints.remove(bpId);
        if (bp != null) {
            vm.eventRequestManager().deleteEventRequest(bp);
            logger.info("[JDWP CLIENT] ✓ Breakpoint removed: {}", bpId);
        } else {
            logger.warn("[JDWP CLIENT] Breakpoint not found: {}", bpId);
        }
    }
    
    public synchronized List<Map<String, Object>> getAllBreakpoints() {
        return breakpoints.entrySet().stream()
                .map(entry -> {
                    Map<String, Object> bpInfo = new HashMap<>();
                    bpInfo.put("id", entry.getKey());
                    bpInfo.put("location", entry.getKey());
                    return bpInfo;
                })
                .collect(Collectors.toList());
    }
    
    // Exception breakpoint support
    private com.sun.jdi.request.ExceptionRequest exceptionRequest = null;
    
    public synchronized void setExceptionBreakpoint(boolean enabled, String exceptionClass) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] Setting exception breakpoint: enabled={}, exception={}", enabled, exceptionClass);
        logger.info("========================================");
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        if (vm == null) {
            throw new IllegalStateException("VM is null");
        }
        
        try {
            EventRequestManager erm = vm.eventRequestManager();
            if (erm == null) {
                throw new IllegalStateException("EventRequestManager is null");
            }
            
            // Remove existing exception request
            if (exceptionRequest != null) {
                try {
                    erm.deleteEventRequest(exceptionRequest);
                } catch (Exception e) {
                    logger.debug("[JDWP CLIENT] Could not delete existing exception request: {}", e.getMessage());
                }
                exceptionRequest = null;
            }
            
            if (enabled) {
                if (exceptionClass != null && !exceptionClass.isEmpty()) {
                    // Specific exception class
                    List<ReferenceType> exceptionTypes = vm.classesByName(exceptionClass);
                    if (exceptionTypes.isEmpty()) {
                        // Try to wait a bit for class to load
                        for (int i = 0; i < 5; i++) {
                            try {
                                Thread.sleep(200);
                            } catch (InterruptedException ie) {
                                Thread.currentThread().interrupt();
                                throw new RuntimeException("Interrupted while waiting for exception class", ie);
                            }
                            exceptionTypes = vm.classesByName(exceptionClass);
                            if (!exceptionTypes.isEmpty()) {
                                break;
                            }
                        }
                        if (exceptionTypes.isEmpty()) {
                            throw new RuntimeException("Exception class not found: " + exceptionClass + ". The class may not be loaded yet. Try triggering code that uses this exception first.");
                        }
                    }
                    exceptionRequest = erm.createExceptionRequest(exceptionTypes.get(0), true, true);
                } else {
                    // All exceptions
                    exceptionRequest = erm.createExceptionRequest(null, true, true);
                }
                if (exceptionRequest != null) {
                    exceptionRequest.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
                    exceptionRequest.enable();
                    logger.info("[JDWP CLIENT] ✓ Exception breakpoint enabled");
                } else {
                    throw new RuntimeException("Failed to create exception request");
                }
            } else {
                logger.info("[JDWP CLIENT] Exception breakpoint disabled");
            }
        } catch (IllegalStateException e) {
            logger.error("[JDWP CLIENT] Illegal state while setting exception breakpoint: {}", e.getMessage());
            throw e;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] Failed to set exception breakpoint: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to set exception breakpoint: " + e.getMessage(), e);
        }
    }
    
    // Wait for breakpoint hit with polling — lock is NOT held during Thread.sleep so other JDWP API calls can proceed.
    // For CONDITIONAL breakpoints: auto-resumes threads that don't match the target request ID
    public Map<String, Object> waitForBreakpointHit(long timeoutMs, long pollIntervalMs) {
        logger.info("[JDWP CLIENT] Waiting for breakpoint hit (timeout: {}ms, poll: {}ms)", timeoutMs, pollIntervalMs);
        logger.info("[JDWP CLIENT] Conditional breakpoints active: {}", conditionalBreakpoints.size());
        synchronized (this) {
            if (!isConnected()) {
                throw new IllegalStateException("Not connected to JDWP server");
            }
            if (breakpoints.isEmpty()) {
                Map<String, Object> result = new HashMap<>();
                result.put("success", false);
                result.put("message", "No breakpoints set");
                return result;
            }
        }

        long startTime = System.currentTimeMillis();
        int autoResumedCount = 0;

        while (System.currentTimeMillis() - startTime < timeoutMs) {
            try {
                // Fast path: the event pump records hits as they happen.
                Map<String, Object> lastHit = lastBreakpointHit;
                if (lastHit != null) {
                    long hitAt = lastHit.get("timestamp") instanceof Long ? (Long) lastHit.get("timestamp") : 0L;
                    if (hitAt >= startTime) {
                        Map<String, Object> result = new HashMap<>(lastHit);
                        result.put("success", true);
                        result.put("autoResumedThreads", autoResumedCount);
                        return result;
                    }
                }

                Map<String, Object> pollResult;
                synchronized (this) {
                    if (!isConnected()) {
                        Map<String, Object> result = new HashMap<>();
                        result.put("success", false);
                        result.put("message", "Connection lost while waiting for breakpoint");
                        return result;
                    }

                    List<ThreadReference> suspendedThreads = vm.allThreads().stream()
                            .filter(ThreadReference::isSuspended)
                            .collect(Collectors.toList());

                    pollResult = null;
                    threadLoop:
                    for (ThreadReference thread : suspendedThreads) {
                        try {
                            List<StackFrame> frames = thread.frames();
                            if (!frames.isEmpty()) {
                                StackFrame frame = frames.get(0);
                                Location location = frame.location();
                                String className = location.declaringType().name();
                                int lineNumber = location.lineNumber();

                                for (Map.Entry<String, BreakpointRequest> entry : breakpoints.entrySet()) {
                                    String bpId = entry.getKey();
                                    if (bpId.contains(":")) {
                                        String[] parts = bpId.split(":", 2);
                                        String bpClassName = parts[0];
                                        int bpLineNumber = Integer.parseInt(parts[1]);

                                        if (bpClassName.equals(className) && bpLineNumber == lineNumber) {
                                            String targetRequestId = conditionalBreakpoints.get(bpId);
                                            if (targetRequestId != null) {
                                                if (!shouldSuspendThread(thread, targetRequestId)) {
                                                    thread.resume();
                                                    autoResumedCount++;
                                                    continue threadLoop;
                                                }
                                                logger.info("[JDWP CLIENT] ✓ Conditional breakpoint hit (request ID matches): {} at {}:{}", thread.name(), className, lineNumber);
                                            } else {
                                                logger.info("[JDWP CLIENT] ✓ Breakpoint hit: {} at {}:{}", thread.name(), className, lineNumber);
                                            }
                                            Map<String, Object> result = new HashMap<>();
                                            result.put("success", true);
                                            result.put("breakpointId", bpId);
                                            result.put("threadName", thread.name());
                                            result.put("className", className);
                                            result.put("lineNumber", lineNumber);
                                            result.put("methodName", location.method().name());
                                            result.put("isConditional", targetRequestId != null);
                                            result.put("targetRequestId", targetRequestId);
                                            result.put("autoResumedThreads", autoResumedCount);
                                            pollResult = result;
                                            recordBreakpointHit(bpId);
                                            break threadLoop;
                                        }
                                    }
                                }
                            }
                        } catch (IncompatibleThreadStateException e) {
                            // Thread might have resumed, continue
                        } catch (Exception e) {
                            // Continue checking other threads
                        }
                    }
                }
                if (pollResult != null) {
                    return pollResult;
                }

                Thread.sleep(pollIntervalMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                logger.debug("[JDWP CLIENT] Error while waiting for breakpoint: {}", e.getMessage());
            }
        }

        Map<String, Object> result = new HashMap<>();
        result.put("success", false);
        result.put("message", "Timeout waiting for breakpoint hit");
        result.put("autoResumedThreads", autoResumedCount);
        return result;
    }
    
    // Enhanced variable inspection with instance variables
    public synchronized Map<String, Object> getVariablesEnhanced(String threadName, boolean includeInstance) {
        logger.info("[JDWP CLIENT] Getting enhanced variables for thread: {}", threadName);
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        Map<String, Object> result = new HashMap<>();
        Map<String, Object> variables = new HashMap<>();
        
        try {
            ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
            
            if (!thread.isSuspended()) {
                logger.info("[JDWP CLIENT] Thread not suspended, suspending to get variables...");
                thread.suspend();
                try {
                    Thread.sleep(100); // Give it a moment to suspend
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            
            variables = getVariablesAtNextLine(threadName);
        } catch (Exception e) {
            logger.warn("[JDWP CLIENT] Could not get local variables: {}", e.getMessage(), e);
            // Continue with empty local variables
            variables = new HashMap<>();
        }
        result.put("local", variables != null ? variables : new HashMap<>());
        
        if (includeInstance) {
            try {
                ThreadReference thread = vm.allThreads().stream()
                    .filter(t -> t.name().equals(threadName))
                    .findFirst()
                    .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
                
                if (!thread.isSuspended()) {
                    thread.suspend();
                }
                
                List<StackFrame> frames = thread.frames();
                if (!frames.isEmpty()) {
                    StackFrame frame = frames.get(0);
                    try {
                        // Get 'this' reference
                        List<LocalVariable> visibleVars = frame.visibleVariables();
                        LocalVariable thisVar = null;
                        for (LocalVariable var : visibleVars) {
                            if (var.name().equals("this")) {
                                thisVar = var;
                                break;
                            }
                        }
                        
                        if (thisVar != null) {
                            Value thisValue = frame.getValue(thisVar);
                            if (thisValue instanceof ObjectReference) {
                                ObjectReference thisRef = (ObjectReference) thisValue;
                                Map<String, Object> instanceVars = new HashMap<>();
                                
                                // Get all fields from the object
                                ReferenceType refType = thisRef.referenceType();
                                List<Field> fields = refType.allFields();
                                
                                for (Field field : fields) {
                                    try {
                                        if (!field.isStatic()) { // Only instance fields
                                            Value fieldValue = thisRef.getValue(field);
                                            String valueStr = formatValue(fieldValue, 0, thread);
                                            instanceVars.put(field.name(), valueStr);
                                        }
                                    } catch (Exception e) {
                                        logger.debug("[JDWP CLIENT] Could not get field {}: {}", field.name(), e.getMessage());
                                    }
                                }
                                
                                result.put("instance", instanceVars);
                                logger.info("[JDWP CLIENT] ✓ Retrieved {} instance variables", instanceVars.size());
                            }
                        } else {
                            logger.debug("[JDWP CLIENT] No 'this' reference available in current frame");
                            result.put("instance", new HashMap<>());
                        }
                    } catch (AbsentInformationException e) {
                        logger.debug("[JDWP CLIENT] Variable information not available: {}", e.getMessage());
                        result.put("instance", new HashMap<>());
                    } catch (Exception e) {
                        logger.debug("[JDWP CLIENT] Could not get instance variables: {}", e.getMessage());
                        result.put("instance", new HashMap<>());
                    }
                } else {
                    result.put("instance", new HashMap<>());
                }
            } catch (Exception e) {
                logger.warn("[JDWP CLIENT] Error getting enhanced variables: {}", e.getMessage());
                result.put("instance", new HashMap<>());
            }
        } else {
            result.put("instance", new HashMap<>());
        }
        try {
            result.put("variablesTree", getVariablesTree(threadName));
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] variablesTree: {}", e.getMessage());
            result.put("variablesTree", Collections.emptyList());
        }
        return result;
    }
    
    public synchronized void resumeThread(String threadName) {
        logger.info("[JDWP CLIENT] Resuming thread: {}", threadName);
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        thread.resume();
        // CRITICAL: Remove from tracking since it's no longer suspended
        // This allows us to detect if it hits a breakpoint again later
        knownSuspendedThreads.remove(threadName);
        logger.info("[JDWP CLIENT] ✓✓✓ Thread resumed: {} (removed from suspended tracking)", threadName);
    }
    
    /**
     * Continue execution - resumes the entire VM (all threads)
     * This is different from resumeThread which only resumes one thread
     * CRITICAL: Clears all step requests so execution continues until breakpoint, not one line
     */
    public synchronized void continueExecution() {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] CONTINUE EXECUTION (Resume VM)");
        logger.info("========================================");
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        // CRITICAL: Delete ALL step requests before continuing
        // If step requests are active, execution will stop at next line instead of continuing to breakpoint
        EventRequestManager erm = vm.eventRequestManager();
        List<StepRequest> allStepRequests = erm.stepRequests();
        if (!allStepRequests.isEmpty()) {
            logger.info("[JDWP CLIENT] Clearing {} active step request(s) before continuing...", allStepRequests.size());
            for (StepRequest stepRequest : allStepRequests) {
                try {
                    erm.deleteEventRequest(stepRequest);
                    logger.info("[JDWP CLIENT]   Deleted step request for thread: {}", stepRequest.thread().name());
                } catch (Exception e) {
                    logger.warn("[JDWP CLIENT]   Could not delete step request: {}", e.getMessage());
                }
            }
        }
        
        // Resume the entire VM - this resumes ALL threads
        vm.resume();
        
        // Clear ALL suspended thread tracking since we're continuing execution
        int count = knownSuspendedThreads.size();
        knownSuspendedThreads.clear();
        logger.info("[JDWP CLIENT] ✓✓✓ VM resumed - all threads continuing execution");
        logger.info("[JDWP CLIENT] Cleared tracking for {} suspended threads", count);
        logger.info("[JDWP CLIENT] Execution will continue until next breakpoint is hit (NOT one line)");
        logger.info("========================================");
    }
    
    /**
     * Clear tracking for a specific thread - useful when you want to re-detect a breakpoint hit
     */
    public synchronized void clearSuspendedThreadTracking(String threadName) {
        knownSuspendedThreads.remove(threadName);
        logger.info("[JDWP CLIENT] Cleared suspended tracking for thread: {}", threadName);
    }
    
    /**
     * Clear all suspended thread tracking - useful when you want to reset
     */
    public synchronized void clearAllSuspendedThreadTracking() {
        int count = knownSuspendedThreads.size();
        knownSuspendedThreads.clear();
        logger.info("[JDWP CLIENT] Cleared all suspended thread tracking ({} threads)", count);
    }
    
    public synchronized void suspendThread(String threadName) {
        logger.info("[JDWP CLIENT] Suspending thread: {}", threadName);
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        thread.suspend();
        logger.info("[JDWP CLIENT] ✓✓✓ Thread suspended: {}", threadName);
    }
    
    public synchronized List<Map<String, Object>> getAllClasses() {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        return vm.allClasses().stream()
                .map(clazz -> {
                    Map<String, Object> classInfo = new HashMap<>();
                    classInfo.put("name", clazz.name());
                    try {
                        classInfo.put("isInterface", clazz instanceof InterfaceType);
                        classInfo.put("isAbstract", clazz instanceof ClassType && ((ClassType) clazz).isAbstract());
                    } catch (Exception e) {
                        classInfo.put("isInterface", false);
                        classInfo.put("isAbstract", false);
                    }
                    return classInfo;
                })
                .collect(Collectors.toList());
    }
    
    public synchronized void stepOver(String threadName) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] EXECUTING STEP OVER");
        logger.info("[JDWP CLIENT] Thread: {}", threadName);
        logger.info("========================================");
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        if (!thread.isSuspended()) {
            logger.error("[JDWP CLIENT] ✗ Thread must be suspended to step. Thread '{}' is currently running. Set a breakpoint first or suspend the thread manually.", threadName);
            throw new IllegalStateException("Thread must be suspended to step. Thread '" + threadName + "' is currently running. Set a breakpoint first or suspend the thread manually using jdwp_suspend_thread.");
        }
        
        try {
            StackFrame frame = thread.frame(0);
            Location currentLocation = frame.location();
            String beforeClass = currentLocation.declaringType().name();
            String beforeMethod = currentLocation.method().name();
            int beforeLine = currentLocation.lineNumber();
            
            logger.info("[JDWP CLIENT] BEFORE STEP OVER:");
            logger.info("[JDWP CLIENT]   Location: {}:{}:{}", beforeClass, beforeMethod, beforeLine);
            logger.info("[JDWP CLIENT]   Stack depth: {}", thread.frameCount());
            
            EventRequestManager erm = vm.eventRequestManager();
            
            // CRITICAL: Delete any existing step requests for this thread first
            // JDWP only allows one step request per thread at a time
            List<StepRequest> existingSteps = erm.stepRequests();
            for (StepRequest existing : existingSteps) {
                if (existing.thread().equals(thread)) {
                    logger.info("[JDWP CLIENT] Deleting existing step request for thread");
                    erm.deleteEventRequest(existing);
                }
            }
            
            StepRequest stepRequest = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_OVER);
            stepRequest.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            
            // CRITICAL: Add class exclusion filters to skip JDK/framework internal classes
            // Without these, step can land on AbstractQueuedSynchronizer, thread pool internals, etc.
            addStepFilters(stepRequest);
            
            stepRequest.enable();
            logger.info("[JDWP CLIENT] Step request created and enabled (STEP_OVER, no count filter)");
            logger.info("[JDWP CLIENT] Resuming thread to execute step...");
            
            // CRITICAL: Clear tracking for this thread so we can detect when it suspends again after step
            knownSuspendedThreads.remove(threadName);
            
            thread.resume();
            logger.info("[JDWP CLIENT] ✓✓✓ STEP OVER EXECUTED");
            logger.info("[JDWP CLIENT] Thread will suspend at the next executable line in the same method");
            logger.info("[JDWP CLIENT] NOTE: If breakpoints exist in called methods, they will be hit first");
            logger.info("[JDWP CLIENT] Tracking cleared - will detect new suspension after step completes");
            logger.info("========================================");
            // Step will complete and thread will suspend again
            // The step request will automatically delete itself after completion
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗✗✗ Failed to step over: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to step over: " + e.getMessage(), e);
        }
    }
    
    public synchronized void stepInto(String threadName) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] EXECUTING STEP INTO");
        logger.info("[JDWP CLIENT] Thread: {}", threadName);
        logger.info("========================================");
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        if (!thread.isSuspended()) {
            logger.error("[JDWP CLIENT] ✗ Thread must be suspended to step. Thread '{}' is currently running. Set a breakpoint first or suspend the thread manually.", threadName);
            throw new IllegalStateException("Thread must be suspended to step. Thread '" + threadName + "' is currently running. Set a breakpoint first or suspend the thread manually using jdwp_suspend_thread.");
        }
        
        try {
            StackFrame frame = thread.frame(0);
            Location currentLocation = frame.location();
            String beforeClass = currentLocation.declaringType().name();
            String beforeMethod = currentLocation.method().name();
            int beforeLine = currentLocation.lineNumber();
            
            logger.info("[JDWP CLIENT] BEFORE STEP INTO:");
            logger.info("[JDWP CLIENT]   Location: {}:{}:{}", beforeClass, beforeMethod, beforeLine);
            logger.info("[JDWP CLIENT]   Stack depth: {}", thread.frameCount());
            
            EventRequestManager erm = vm.eventRequestManager();
            
            // CRITICAL: Delete any existing step requests for this thread first
            // JDWP only allows one step request per thread at a time
            List<StepRequest> existingSteps = erm.stepRequests();
            for (StepRequest existing : existingSteps) {
                if (existing.thread().equals(thread)) {
                    logger.info("[JDWP CLIENT] Deleting existing step request for thread");
                    erm.deleteEventRequest(existing);
                }
            }
            
            StepRequest stepRequest = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
            stepRequest.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            
            // CRITICAL: Add class exclusion filters to skip JDK/framework internal classes
            // Without these, step can land on AbstractQueuedSynchronizer, thread pool internals, etc.
            addStepFilters(stepRequest);
            
            stepRequest.enable();
            logger.info("[JDWP CLIENT] Step request created and enabled (STEP_INTO, no count filter)");
            logger.info("[JDWP CLIENT] Resuming thread to execute step...");
            
            // CRITICAL: Clear tracking for this thread so we can detect when it suspends again after step
            knownSuspendedThreads.remove(threadName);
            
            thread.resume();
            logger.info("[JDWP CLIENT] ✓✓✓ STEP INTO EXECUTED");
            logger.info("[JDWP CLIENT] Thread will suspend at the first line inside the called method (if any)");
            logger.info("[JDWP CLIENT] Tracking cleared - will detect new suspension after step completes");
            logger.info("========================================");
            // Step will complete and thread will suspend again
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗✗✗ Failed to step into: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to step into: " + e.getMessage(), e);
        }
    }
    
    public synchronized void stepOut(String threadName) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] Executing STEP OUT on thread: {}", threadName);
        logger.info("========================================");
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        if (!thread.isSuspended()) {
            logger.error("[JDWP CLIENT] ✗ Thread must be suspended to step. Thread '{}' is currently running. Set a breakpoint first or suspend the thread manually.", threadName);
            throw new IllegalStateException("Thread must be suspended to step. Thread '" + threadName + "' is currently running. Set a breakpoint first or suspend the thread manually using jdwp_suspend_thread.");
        }
        
        try {
            StackFrame frame = thread.frame(0);
            Location currentLocation = frame.location();
            logger.info("[JDWP CLIENT] Current location before step: {}:{}:{}", 
                       currentLocation.declaringType().name(), 
                       currentLocation.method().name(), 
                       currentLocation.lineNumber());
            logger.info("[JDWP CLIENT] Stack depth: {}", thread.frameCount());
            
            EventRequestManager erm = vm.eventRequestManager();
            
            // CRITICAL: Delete any existing step requests for this thread first
            // JDWP only allows one step request per thread at a time
            List<StepRequest> existingSteps = erm.stepRequests();
            for (StepRequest existing : existingSteps) {
                if (existing.thread().equals(thread)) {
                    logger.info("[JDWP CLIENT] Deleting existing step request for thread");
                    erm.deleteEventRequest(existing);
                }
            }
            
            StepRequest stepRequest = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_OUT);
            stepRequest.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            
            // CRITICAL: Add class exclusion filters to skip JDK/framework internal classes
            // Without these, step can land on AbstractQueuedSynchronizer, thread pool internals, etc.
            addStepFilters(stepRequest);
            
            stepRequest.enable();
            logger.info("[JDWP CLIENT] Step request created and enabled (STEP_OUT, no count filter), resuming thread...");
            
            // CRITICAL: Clear tracking for this thread so we can detect when it suspends again after step
            knownSuspendedThreads.remove(threadName);
            
            thread.resume();
            logger.info("[JDWP CLIENT] ✓✓✓ STEP OUT executed, thread will suspend at caller");
            logger.info("[JDWP CLIENT] Tracking cleared - will detect new suspension after step completes");
            logger.info("========================================");
            // Step will complete and thread will suspend again
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗✗✗ Failed to step out: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to step out: " + e.getMessage(), e);
        }
    }

    /**
     * Drop stack frames from the top until the current frame is in the application package (IntelliJ-style
     * "drop / reset frame" through JDK and dependency code). Uses JDI {@link ThreadReference#popFrames}.
     *
     * @param threadName suspended thread
     * @param applicationPackagePrefix e.g. {@code com.jdwp.server} — top declaring type must start with this package
     * @return number of frames popped
     */
    public synchronized int resetFrameToApplicationCode(String threadName, String applicationPackagePrefix) {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        if (!vm.canPopFrames()) {
            throw new IllegalStateException("This JVM does not support dropping frames (canPopFrames=false). Use a HotSpot JDK with JVMTI PopFrames.");
        }
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        if (!thread.isSuspended()) {
            throw new IllegalStateException("Thread must be suspended to reset frames: " + threadName);
        }
        String prefix = (applicationPackagePrefix != null && !applicationPackagePrefix.isBlank())
                ? applicationPackagePrefix.trim()
                : "com.jdwp.server";
        if (!prefix.endsWith(".")) {
            prefix = prefix + ".";
        }
        final String matchPrefix = prefix;
        int popped = 0;
        final int maxPops = 256;
        while (popped < maxPops) {
            try {
                if (thread.frameCount() <= 0) {
                    break;
                }
                StackFrame top = thread.frame(0);
                String cn = top.location().declaringType().name();
                if (cn.startsWith(matchPrefix)) {
                    logger.info("[JDWP CLIENT] resetFrame: top frame is application code after {} pop(s): {}", popped, cn);
                    return popped;
                }
                if (thread.frameCount() <= 1) {
                    throw new IllegalStateException(
                            "Cannot pop further — no caller below non-application frame " + cn);
                }
                thread.popFrames(top);
                popped++;
            } catch (NativeMethodException e) {
                throw new IllegalStateException(
                        "Cannot drop through native frame — resume/step to leave native code first.", e);
            } catch (InvalidStackFrameException e) {
                throw new IllegalStateException("Stack changed while dropping frames: " + e.getMessage(), e);
            } catch (IncompatibleThreadStateException e) {
                throw new IllegalStateException("Thread not suspended or state changed: " + e.getMessage(), e);
            }
        }
        if (popped >= maxPops) {
            throw new IllegalStateException("Safety limit: too many frames to pop while searching for application code.");
        }
        return popped;
    }
    
    /**
     * Add class exclusion filters to a step request to skip JDK and framework internal classes.
     * Without these filters, stepping can land on internal classes like:
     * - java.util.concurrent.locks.AbstractQueuedSynchronizer
     * - java.lang.Thread
     * - sun.* internal classes
     * - Tomcat/Spring framework internals
     * 
     * This ensures step operations stay within application code.
     */
    private void addStepFilters(StepRequest stepRequest) {
        // JDK core classes
        stepRequest.addClassExclusionFilter("java.*");
        stepRequest.addClassExclusionFilter("javax.*");
        stepRequest.addClassExclusionFilter("jdk.*");
        
        // Sun/Oracle internal classes
        stepRequest.addClassExclusionFilter("sun.*");
        stepRequest.addClassExclusionFilter("com.sun.*");
        
        // Tomcat internals
        stepRequest.addClassExclusionFilter("org.apache.tomcat.*");
        stepRequest.addClassExclusionFilter("org.apache.catalina.*");
        stepRequest.addClassExclusionFilter("org.apache.coyote.*");
        stepRequest.addClassExclusionFilter("org.apache.naming.*");
        
        // Spring framework internals (proxies, AOP, etc.)
        stepRequest.addClassExclusionFilter("org.springframework.aop.*");
        stepRequest.addClassExclusionFilter("org.springframework.cglib.*");
        stepRequest.addClassExclusionFilter("org.springframework.transaction.*");
        
        // CGLIB proxies (Spring uses these)
        stepRequest.addClassExclusionFilter("net.sf.cglib.*");
        stepRequest.addClassExclusionFilter("org.springframework.*.$$*");  // Generated proxy classes
        
        // Hibernate internals
        stepRequest.addClassExclusionFilter("org.hibernate.proxy.*");
        stepRequest.addClassExclusionFilter("org.hibernate.engine.*");
        
        logger.debug("[JDWP CLIENT] Added step exclusion filters for JDK/framework classes");
    }
    
    /**
     * Format a JDI Value to a simple readable string representation
     * Like IntelliJ - shows primitives, strings, arrays/collections simply, objects as type name only
     */
    private String formatValue(Value value, int depth, ThreadReference thread) {
        if (value == null) return "null";
        
        try {
            if (value instanceof StringReference) {
                // Return actual string value without quotes (JSON will handle quoting when serialized)
                return redactString(((StringReference) value).value());
            }
            if (value instanceof PrimitiveValue) {
                return value.toString();
            }
            
            // Handle Arrays
            if (value instanceof ArrayReference) {
                ArrayReference array = (ArrayReference) value;
                int length = array.length();
                if (depth > 0 && length > 5) return "Array[" + length + "]";
                if (length == 0) return "[]";
                
                List<String> elements = new ArrayList<>();
                int displayLen = Math.min(length, 10);
                for (int i = 0; i < displayLen; i++) {
                    elements.add(formatValue(array.getValue(i), depth + 1, thread));
                }
                if (length > 10) elements.add("...");
                return "[" + String.join(", ", elements) + "]";
            }
            
            // Handle Objects: Check if it's a Collection first, then try toString()
            if (value instanceof ObjectReference) {
                ObjectReference objRef = (ObjectReference) value;
                ReferenceType refType = objRef.referenceType();
                String typeName = refType.name();
                
                // Handle Collections (ArrayList, List, etc.) - extract actual values
                if (typeName.startsWith("java.util.") && 
                    (typeName.contains("List") || typeName.contains("Collection") || 
                     typeName.contains("Set") || typeName.contains("Queue"))) {
                    try {
                        // Get size() method
                        Method sizeMethod = null;
                        ReferenceType searchType = refType;
                        while (searchType != null) {
                            List<Method> methods = searchType.methodsByName("size");
                            if (!methods.isEmpty()) {
                                // Find the one with no parameters: size()
                                for (Method m : methods) {
                                    if (m.signature().equals("()I")) { // Returns int
                                        sizeMethod = m;
                                        break;
                                    }
                                }
                                if (sizeMethod != null) break;
                            }
                            if (searchType instanceof ClassType) {
                                searchType = ((ClassType) searchType).superclass();
                            } else {
                                break;
                            }
                        }
                        
                        if (sizeMethod != null) {
                            Value sizeValue = objRef.invokeMethod(thread, sizeMethod, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                            int size = ((IntegerValue) sizeValue).value();
                            
                            if (size == 0) {
                                return "[]";
                            }
                            
                            // Get iterator or get() method to access elements
                            // For List, try get(int index) method
                            Method getMethod = null;
                            searchType = refType;
                            while (searchType != null) {
                                List<Method> methods = searchType.methodsByName("get");
                                if (!methods.isEmpty()) {
                                    // Find get(int) method
                                    for (Method m : methods) {
                                        if (m.signature().startsWith("(I)")) { // Takes int, returns Object
                                            getMethod = m;
                                            break;
                                        }
                                    }
                                    if (getMethod != null) break;
                                }
                                if (searchType instanceof ClassType) {
                                    searchType = ((ClassType) searchType).superclass();
                                } else {
                                    break;
                                }
                            }
                            
                            if (getMethod != null) {
                                List<String> elements = new ArrayList<>();
                                int displayLen = Math.min(size, 20); // Show up to 20 items
                                
                                for (int i = 0; i < displayLen; i++) {
                                    try {
                                        Value indexValue = vm.mirrorOf(i);
                                        Value elementValue = objRef.invokeMethod(thread, getMethod, 
                                            Collections.singletonList(indexValue), ObjectReference.INVOKE_SINGLE_THREADED);
                                        
                                        // Format the element - for objects, show their fields
                                        if (elementValue instanceof ObjectReference) {
                                            String elementStr = formatObjectWithFields((ObjectReference) elementValue, depth + 1, thread);
                                            elements.add(elementStr);
                                        } else {
                                            elements.add(formatValue(elementValue, depth + 1, thread));
                                        }
                                    } catch (Exception e) {
                                        elements.add("?");
                                        break;
                                    }
                                }
                                
                                if (size > displayLen) {
                                    elements.add("... (" + size + " total)");
                                }
                                
                                return "[" + String.join(", ", elements) + "]";
                            }
                        }
                    } catch (Exception e) {
                        // If collection handling fails, fall through to toString()
                        logger.debug("[JDWP CLIENT] Could not extract collection contents: {}", e.getMessage());
                    }
                }
                
                // Avoid invoking toString on basic types we know might be boring or already handled
                if (typeName.equals("java.lang.Object")) {
                    return "Object";
                }

                // Limit recursion for toString invocation to avoid infinite loops/stack overflow in target VM
                if (depth > 0) {
                     // For nested objects in an array, simple type name is often safer unless it's a Collection
                     if (!typeName.startsWith("java.util.") && !typeName.startsWith("java.lang.")) {
                         return typeName.substring(typeName.lastIndexOf('.') + 1);
                     }
                }

                try {
                    // Find toString() method
                    Method toStringMethod = null;
                    ReferenceType searchType = refType;
                    while (searchType != null) {
                        List<Method> methods = searchType.methodsByName("toString", "()Ljava/lang/String;");
                        if (!methods.isEmpty()) {
                            toStringMethod = methods.get(0);
                            break;
                        }
                        if (searchType instanceof ClassType) {
                            searchType = ((ClassType) searchType).superclass();
                        } else {
                            break;
                        }
                    }

                    if (toStringMethod != null) {
                        // Invoke toString()
                        Value result = objRef.invokeMethod(thread, toStringMethod, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                        if (result instanceof StringReference) {
                            return redactString(((StringReference) result).value());
                        }
                    }
                } catch (Exception e) {
                    // If invocation fails (e.g. thread not suspended, exception in toString), fall back
                }
                
                return typeName.substring(typeName.lastIndexOf('.') + 1) + "@" + objRef.uniqueID();
            }
            
            return value.toString();
        } catch (Exception e) {
            return "Error";
        }
    }
    
    /**
     * Format an ObjectReference to show its fields (like IntelliJ debugger shows object properties)
     */
    private String formatObjectWithFields(ObjectReference objRef, int depth, ThreadReference thread) {
        if (objRef == null) return "null";
        if (depth > 4) {
            // Too deep, just show class name
            return objRef.referenceType().name().substring(objRef.referenceType().name().lastIndexOf('.') + 1) + "@" + objRef.uniqueID();
        }
        
        try {
            ReferenceType refType = objRef.referenceType();
            String typeName = refType.name();
            
            // For simple types, just return toString
            if (typeName.startsWith("java.lang.") && !typeName.equals("java.lang.Object")) {
                return formatValue(objRef, depth, thread);
            }
            
            // Get all non-static fields of the object
            List<Field> allFields = refType.allFields();
            List<Field> instanceFields = new ArrayList<>();
            for (Field field : allFields) {
                if (!field.isStatic()) {
                    instanceFields.add(field);
                }
            }
            
            if (instanceFields.isEmpty()) {
                return typeName.substring(typeName.lastIndexOf('.') + 1) + "@" + objRef.uniqueID();
            }
            
            // Build a string showing field: value pairs (like IntelliJ)
            List<String> fieldStrings = new ArrayList<>();
            int fieldCount = 0;
            int maxFields = 20; // Show more fields
            
            logger.debug("[JDWP CLIENT] Formatting object {} with {} instance fields", typeName, instanceFields.size());
            
            for (Field field : instanceFields) {
                if (fieldCount >= maxFields) {
                    fieldStrings.add("...");
                    break;
                }
                
                try {
                    Value fieldValue = objRef.getValue(field);
                    String fieldName = field.name();
                    
                    // Format field value - handle different types directly
                    String fieldValueStr;
                    if (fieldValue == null) {
                        fieldValueStr = "null";
                    } else if (fieldValue instanceof StringReference) {
                        // Use actual string value without quotes (JSON will handle quoting)
                        fieldValueStr = redactString(((StringReference) fieldValue).value());
                    } else if (fieldValue instanceof PrimitiveValue) {
                        fieldValueStr = fieldValue.toString();
                    } else if (fieldValue instanceof ObjectReference) {
                        // For nested objects, show their fields too (but limit depth)
                        ObjectReference nestedObj = (ObjectReference) fieldValue;
                        String nestedType = nestedObj.referenceType().name();
                        // For simple nested objects, try to show fields, but for complex ones just show type
                        if (depth < 2 && !nestedType.startsWith("java.")) {
                            fieldValueStr = formatObjectWithFields(nestedObj, depth + 1, thread);
                        } else {
                            // Just show type name for nested objects to avoid too much nesting
                            fieldValueStr = nestedType.substring(nestedType.lastIndexOf('.') + 1);
                        }
                    } else if (fieldValue instanceof ArrayReference) {
                        // Handle arrays - format each element properly
                        ArrayReference array = (ArrayReference) fieldValue;
                        int length = array.length();
                        if (length == 0) {
                            fieldValueStr = "[]";
                        } else {
                            List<String> elements = new ArrayList<>();
                            int displayLen = Math.min(length, 5);
                            for (int i = 0; i < displayLen; i++) {
                                Value elemValue = array.getValue(i);
                                if (elemValue instanceof StringReference) {
                                    elements.add(redactString(((StringReference) elemValue).value()));
                                } else {
                                    elements.add(formatValue(elemValue, 0, thread));
                                }
                            }
                            if (length > 5) elements.add("...");
                            fieldValueStr = "[" + String.join(", ", elements) + "]";
                        }
                    } else {
                        // For other types, use formatValue with depth 0 to avoid early return
                        fieldValueStr = formatValue(fieldValue, 0, thread);
                    }
                    
                    // Truncate very long values
                    if (fieldValueStr.length() > 200) {
                        fieldValueStr = fieldValueStr.substring(0, 200) + "...";
                    }
                    
                    fieldStrings.add(fieldName + "=" + fieldValueStr);
                    fieldCount++;
                } catch (Exception e) {
                    // Skip fields we can't access - but log for debugging
                    logger.debug("[JDWP CLIENT] Could not access field {}: {}", field.name(), e.getMessage());
                    continue;
                }
            }
            
            String className = typeName.substring(typeName.lastIndexOf('.') + 1);
            if (fieldStrings.isEmpty()) {
                logger.debug("[JDWP CLIENT] No fields accessible for {}", typeName);
                return className + "@" + objRef.uniqueID();
            }
            
            String result = className + "{" + String.join(", ", fieldStrings) + "}";
            logger.debug("[JDWP CLIENT] Formatted {} with {} fields: {}", typeName, fieldCount, result.substring(0, Math.min(200, result.length())));
            return result;
        } catch (Exception e) {
            logger.warn("[JDWP CLIENT] Error formatting object fields for {}: {} - {}", 
                       objRef.referenceType().name(), e.getClass().getSimpleName(), e.getMessage());
            return objRef.referenceType().name().substring(objRef.referenceType().name().lastIndexOf('.') + 1) + "@" + objRef.uniqueID();
        }
    }

    private static final int MAX_TREE_DEPTH = 15;

    /**
     * Build a tree node for a variable so the frontend can show nested/collections expandably.
     * Returns Map with: name, type, value (summary string), children (optional list of same structure).
     */
    private Map<String, Object> valueToTree(Value value, String name, String typeName, int depth, ThreadReference thread) {
        Map<String, Object> node = new HashMap<>();
        node.put("name", name);
        node.put("type", typeName != null ? typeName : "?");
        if (depth >= MAX_TREE_DEPTH) {
            node.put("value", typeName != null ? typeName.substring(Math.max(0, typeName.lastIndexOf('.') + 1)) + " (max depth)" : "...");
            return node;
        }
        try {
            if (value == null) {
                node.put("value", "null");
                return node;
            }
            if (value instanceof StringReference) {
                node.put("value", redactString(((StringReference) value).value()));
                return node;
            }
            if (value instanceof PrimitiveValue) {
                node.put("value", value.toString());
                return node;
            }
            if (value instanceof ArrayReference) {
                ArrayReference arr = (ArrayReference) value;
                int len = arr.length();
                node.put("value", "Array[" + len + "]");
                List<Map<String, Object>> children = new ArrayList<>();
                int maxShow = Math.min(len, 100);
                for (int i = 0; i < maxShow; i++) {
                    Value elem = arr.getValue(i);
                    children.add(valueToTree(elem, "[" + i + "]", getValueTypeName(elem), depth + 1, thread));
                }
                if (len > maxShow) children.add(leafNode("...", len + " total"));
                node.put("children", children);
                return node;
            }
            if (value instanceof ObjectReference) {
                ObjectReference objRef = (ObjectReference) value;
                ReferenceType refType = objRef.referenceType();
                String typeNameStr = refType.name();
                // List / Collection: expand elements
                if (typeNameStr.startsWith("java.util.") &&
                    (typeNameStr.contains("List") || typeNameStr.contains("Collection") || typeNameStr.contains("Set") || typeNameStr.contains("Queue"))) {
                    try {
                        Method sizeM = findMethod(refType, "size", "()I");
                        if (sizeM != null) {
                            Value sizeVal = objRef.invokeMethod(thread, sizeM, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                            int size = sizeVal != null ? ((IntegerValue) sizeVal).value() : 0;
                            node.put("value", refType.name().substring(refType.name().lastIndexOf('.') + 1) + "[" + size + "]");
                            Method getM = findMethod(refType, "get", "(I)");
                            if (getM != null && size > 0) {
                                List<Map<String, Object>> children = new ArrayList<>();
                                int maxShow = Math.min(size, 100);
                                for (int i = 0; i < maxShow; i++) {
                                    Value elem = objRef.invokeMethod(thread, getM, Collections.singletonList(vm.mirrorOf(i)), ObjectReference.INVOKE_SINGLE_THREADED);
                                    children.add(valueToTree(elem, "[" + i + "]", getValueTypeName(elem), depth + 1, thread));
                                }
                                if (size > maxShow) children.add(leafNode("...", size + " total"));
                                node.put("children", children);
                            }
                        }
                    } catch (Exception e) {
                        node.put("value", formatValue(value, 0, thread));
                    }
                    return node;
                }
                // Map: expand entries
                if (typeNameStr.startsWith("java.util.") && typeNameStr.contains("Map")) {
                    try {
                        Method sizeM = findMethod(refType, "size", "()I");
                        if (sizeM != null) {
                            Value sizeVal = objRef.invokeMethod(thread, sizeM, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                            int size = sizeVal != null ? ((IntegerValue) sizeVal).value() : 0;
                            node.put("value", refType.name().substring(refType.name().lastIndexOf('.') + 1) + "[" + size + "]");
                            Method entrySetM = refType.methodsByName("entrySet").stream().filter(this::methodHasNoArgs).findFirst().orElse(null);
                            if (entrySetM != null && size > 0) {
                                Value entrySetVal = objRef.invokeMethod(thread, entrySetM, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                                if (entrySetVal instanceof ObjectReference) {
                                    Method toArrayM = ((ObjectReference) entrySetVal).referenceType().methodsByName("toArray").stream()
                                            .filter(this::methodHasNoArgs).findFirst().orElse(null);
                                    if (toArrayM != null) {
                                        Value arrVal = ((ObjectReference) entrySetVal).invokeMethod(thread, toArrayM, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                                        if (arrVal instanceof ArrayReference) {
                                            ArrayReference entryArr = (ArrayReference) arrVal;
                                            List<Map<String, Object>> children = new ArrayList<>();
                                            int maxShow = Math.min(entryArr.length(), 50);
                                            for (int i = 0; i < maxShow; i++) {
                                                Value entry = entryArr.getValue(i);
                                                if (entry instanceof ObjectReference) {
                                                    Map<String, Object> entryNode = new HashMap<>();
                                                    entryNode.put("name", "entry[" + i + "]");
                                                    entryNode.put("type", "Map.Entry");
                                                    entryNode.put("value", "");
                                                    List<Map<String, Object>> kv = new ArrayList<>();
                                                    try {
                                                        Method getKeyM = ((ObjectReference) entry).referenceType().methodsByName("getKey").stream().findFirst().orElse(null);
                                                        Method getValM = ((ObjectReference) entry).referenceType().methodsByName("getValue").stream().findFirst().orElse(null);
                                                        if (getKeyM != null) kv.add(valueToTree(((ObjectReference) entry).invokeMethod(thread, getKeyM, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED), "key", "Object", depth + 1, thread));
                                                        if (getValM != null) kv.add(valueToTree(((ObjectReference) entry).invokeMethod(thread, getValM, Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED), "value", "Object", depth + 1, thread));
                                                    } catch (Exception ignored) {}
                                                    entryNode.put("children", kv);
                                                    children.add(entryNode);
                                                }
                                            }
                                            if (entryArr.length() > maxShow) children.add(leafNode("...", entryArr.length() + " entries"));
                                            node.put("children", children);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (Exception e) {
                        node.put("value", formatValue(value, 0, thread));
                    }
                    return node;
                }
                // Plain object: expand fields
                List<Field> instanceFields = refType.allFields().stream().filter(f -> !f.isStatic()).collect(Collectors.toList());
                String shortName = typeNameStr.substring(typeNameStr.lastIndexOf('.') + 1);
                node.put("value", instanceFields.isEmpty() ? shortName : shortName + " {...}");
                if (!instanceFields.isEmpty()) {
                    List<Map<String, Object>> children = new ArrayList<>();
                    int maxFields = 50;
                    for (int i = 0; i < Math.min(instanceFields.size(), maxFields); i++) {
                        Field f = instanceFields.get(i);
                        try {
                            Value fv = objRef.getValue(f);
                            children.add(valueToTree(fv, f.name(), f.typeName(), depth + 1, thread));
                        } catch (Exception e) {
                            children.add(leafNode(f.name(), "?"));
                        }
                    }
                    if (instanceFields.size() > maxFields) children.add(leafNode("...", instanceFields.size() + " fields"));
                    node.put("children", children);
                }
                return node;
            }
            node.put("value", value.toString());
            return node;
        } catch (Exception e) {
            node.put("value", "Error: " + e.getMessage());
            return node;
        }
    }

    private Map<String, Object> leafNode(String name, String value) {
        Map<String, Object> n = new HashMap<>();
        n.put("name", name);
        n.put("type", "");
        n.put("value", value);
        return n;
    }

    private static String getValueTypeName(Value value) {
        if (value == null) return "null";
        if (value instanceof ObjectReference) return ((ObjectReference) value).referenceType().name();
        if (value instanceof ArrayReference) return ((ArrayReference) value).referenceType().name();
        if (value instanceof StringReference) return "java.lang.String";
        if (value instanceof PrimitiveValue) return ((PrimitiveValue) value).type().name();
        return "Object";
    }

    /** Safe check for no-arg method (argumentTypes() can throw ClassNotLoadedException). */
    private boolean methodHasNoArgs(Method m) {
        try {
            return m.argumentTypes().isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private Method findMethod(ReferenceType refType, String methodName, String signaturePrefix) {
        ReferenceType search = refType;
        while (search != null) {
            for (Method m : search.methodsByName(methodName)) {
                if (signaturePrefix == null || m.signature().startsWith(signaturePrefix)) return m;
            }
            if (search instanceof ClassType) search = ((ClassType) search).superclass();
            else break;
        }
        return null;
    }

    /**
     * Returns variables as a tree (name, type, value, children) so frontend can show nested/collections clearly.
     */
    public synchronized List<Map<String, Object>> getVariablesTree(String threadName) {
        if (!isConnected() || vm == null) return Collections.emptyList();
        ThreadReference thread = vm.allThreads().stream().filter(t -> t.name().equals(threadName)).findFirst().orElse(null);
        if (thread == null) return Collections.emptyList();
        try {
            if (!thread.isSuspended()) thread.suspend();
            Thread.sleep(80);
            List<StackFrame> frames = thread.frames();
            if (frames.isEmpty()) return Collections.emptyList();
            StackFrame frame = frames.get(0);
            Location loc = frame.location();
            String className0 = loc.declaringType().name();
            if (className0.startsWith("jdk.") || className0.startsWith("java.") || className0.startsWith("sun.") || className0.startsWith("org.springframework.")) {
                for (StackFrame f : frames) {
                    Location l = f.location();
                    String cn = l.declaringType().name();
                    if (!cn.startsWith("jdk.") && !cn.startsWith("java.") && !cn.startsWith("sun.") && !cn.startsWith("org.springframework.") && l.lineNumber() > 0) {
                        frame = f;
                        break;
                    }
                }
            }
            // If chosen frame has no variable info, use first frame that does (e.g. wrong thread = Acceptor)
            try {
                frame.visibleVariables();
            } catch (AbsentInformationException e) {
                for (StackFrame f : frames) {
                    try {
                        if (!f.visibleVariables().isEmpty()) {
                            frame = f;
                            break;
                        }
                    } catch (AbsentInformationException ignored) {}
                }
            }
            List<Map<String, Object>> tree = new ArrayList<>();
            java.util.Set<String> addedNames = new java.util.HashSet<>();
            try {
                // 1) Add all visible variables (including "this" so instance fields show)
                for (LocalVariable var : frame.visibleVariables()) {
                    try {
                        Value value = frame.getValue(var);
                        tree.add(valueToTree(value, var.name(), var.typeName(), 0, thread));
                        addedNames.add(var.name());
                    } catch (Exception e) {
                        tree.add(leafNode(var.name(), "?"));
                        addedNames.add(var.name());
                    }
                }
                // 2) Add any method locals not "visible" at this line (e.g. ddWidgetDTOS, ddWidget) - method.variables() has all locals in scope
                try {
                    Method method = frame.location().method();
                    for (LocalVariable var : method.variables()) {
                        if (addedNames.contains(var.name())) continue;
                        try {
                            Value value = frame.getValue(var);
                            tree.add(valueToTree(value, var.name(), var.typeName(), 0, thread));
                            addedNames.add(var.name());
                        } catch (Exception e) {
                            tree.add(leafNode(var.name(), "?"));
                            addedNames.add(var.name());
                        }
                    }
                } catch (AbsentInformationException e) {
                    // No full variable table (e.g. -g:vars not set) - visible only
                }
            } catch (AbsentInformationException e) {
                return Collections.emptyList();
            }
            return tree;
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] getVariablesTree: {}", e.getMessage());
            return Collections.emptyList();
        }
    }
    
    public synchronized Map<String, Object> getVariablesAtNextLine(String threadName) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] GETTING VARIABLES");
        logger.info("[JDWP CLIENT] Thread: {}", threadName);
        logger.info("========================================");
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        try {
            if (!thread.isSuspended()) {
                logger.info("[JDWP CLIENT] Thread not suspended, suspending...");
                thread.suspend();
            }
            
            List<StackFrame> frames = thread.frames();
            if (frames.isEmpty()) {
                logger.warn("[JDWP CLIENT] No stack frames available");
                return new HashMap<>();
            }
            
            // CRITICAL: ALWAYS use frame 0 if it's application code (where breakpoint actually hit)
            // This ensures we get variables from the EXACT location where execution stopped
            StackFrame frame = null;
            Location location = null;
            
            StackFrame frame0 = frames.get(0);
            Location loc0 = frame0.location();
            String className0 = loc0.declaringType().name();
            
            // Check if frame 0 is application code
            boolean isAppCode0 = !className0.startsWith("jdk.internal.") && 
                !className0.startsWith("java.") && 
                !className0.startsWith("sun.") &&
                !className0.startsWith("com.sun.") &&
                !className0.startsWith("org.apache.") &&
                !className0.startsWith("org.springframework.") &&
                !className0.startsWith("org.eclipse.") &&
                !className0.startsWith("ch.qos.logback.") &&
                !className0.startsWith("org.slf4j.") &&
                loc0.lineNumber() > 0;
            
            if (isAppCode0) {
                // PERFECT: Frame 0 is application code - use it (this is where breakpoint hit)
                frame = frame0;
                location = loc0;
                logger.info("[JDWP CLIENT] ✓ Using frame 0 (breakpoint location): {}:{}:{}", 
                           className0, loc0.method().name(), loc0.lineNumber());
            } else {
                // Frame 0 is framework code, find first application frame
                // But prioritize controller > service > other (like IntelliJ)
                logger.info("[JDWP CLIENT] Frame 0 is framework code ({}), searching for application frame...", className0);
                
                StackFrame controllerFrame = null;
                StackFrame serviceFrame = null;
                StackFrame otherAppFrame = null;
                
                for (StackFrame f : frames) {
                    Location loc = f.location();
                    String className = loc.declaringType().name();
                    
                    if (!className.startsWith("jdk.internal.") && 
                        !className.startsWith("java.") && 
                        !className.startsWith("sun.") &&
                        !className.startsWith("com.sun.") &&
                        !className.startsWith("org.apache.") &&
                        !className.startsWith("org.springframework.") &&
                        !className.startsWith("org.eclipse.") &&
                        !className.startsWith("ch.qos.logback.") &&
                        !className.startsWith("org.slf4j.") &&
                        loc.lineNumber() > 0) {
                        
                        if (className.contains(".controller.") && controllerFrame == null) {
                            controllerFrame = f;
                            logger.info("[JDWP CLIENT] Found controller frame: {}:{}:{}", 
                                      className, loc.method().name(), loc.lineNumber());
                        } else if (className.contains(".service.") && serviceFrame == null && controllerFrame == null) {
                            serviceFrame = f;
                            logger.info("[JDWP CLIENT] Found service frame: {}:{}:{}", 
                                      className, loc.method().name(), loc.lineNumber());
                        } else if (otherAppFrame == null && controllerFrame == null && serviceFrame == null) {
                            otherAppFrame = f;
                            logger.info("[JDWP CLIENT] Found application frame: {}:{}:{}", 
                                      className, loc.method().name(), loc.lineNumber());
                        }
                    }
                }
                
                // Use controller first, then service, then other app code
                if (controllerFrame != null) {
                    frame = controllerFrame;
                    location = controllerFrame.location();
                    logger.info("[JDWP CLIENT] ✓ Using controller frame: {}:{}:{}", 
                              location.declaringType().name(), location.method().name(), location.lineNumber());
                } else if (serviceFrame != null) {
                    frame = serviceFrame;
                    location = serviceFrame.location();
                    logger.info("[JDWP CLIENT] ✓ Using service frame: {}:{}:{}", 
                              location.declaringType().name(), location.method().name(), location.lineNumber());
                } else if (otherAppFrame != null) {
                    frame = otherAppFrame;
                    location = otherAppFrame.location();
                    logger.info("[JDWP CLIENT] ✓ Using other application frame: {}:{}:{}", 
                              location.declaringType().name(), location.method().name(), location.lineNumber());
                } else {
                    // Fallback to frame 0 if no application frame found
                    frame = frame0;
                    location = loc0;
                    logger.warn("[JDWP CLIENT] ✗ No application frame found, falling back to frame 0: {}:{}:{}", 
                              className0, loc0.method().name(), loc0.lineNumber());
                }
            }
            
            // If chosen frame has no variable info (e.g. native/framework), use first frame that has variables
            try {
                if (frame.visibleVariables().isEmpty()) {
                    for (int i = 0; i < frames.size(); i++) {
                        StackFrame f = frames.get(i);
                        try {
                            List<LocalVariable> vars = f.visibleVariables();
                            if (vars != null && !vars.isEmpty()) {
                                frame = f;
                                location = f.location();
                                logger.info("[JDWP CLIENT] Chosen frame had no variables; using frame {} ({}:{}:{})", 
                                          i, location.declaringType().name(), location.method().name(), location.lineNumber());
                                break;
                            }
                        } catch (AbsentInformationException ignored) {}
                    }
                }
            } catch (AbsentInformationException e) {
                for (int i = 0; i < frames.size(); i++) {
                    StackFrame f = frames.get(i);
                    try {
                        List<LocalVariable> vars = f.visibleVariables();
                        if (vars != null && !vars.isEmpty()) {
                            frame = f;
                            location = f.location();
                            logger.info("[JDWP CLIENT] Chosen frame has no variable info; using frame {} ({}:{}:{})", 
                                      i, location.declaringType().name(), location.method().name(), location.lineNumber());
                            break;
                        }
                    } catch (AbsentInformationException ignored) {}
                }
            }
            
            String className = location.declaringType().name();
            String methodName = location.method().name();
            int lineNumber = location.lineNumber();
            
            logger.info("[JDWP CLIENT] Current execution context:");
            logger.info("[JDWP CLIENT]   Class: {}", className);
            logger.info("[JDWP CLIENT]   Method: {}", methodName);
            logger.info("[JDWP CLIENT]   Line: {}", lineNumber);
            logger.info("[JDWP CLIENT]   Stack depth: {}", frames.size());
            logger.info("[JDWP CLIENT]   Using frame index: {}", frames.indexOf(frame));
            
            Map<String, Object> variables = new HashMap<>();
            int varCount = 0;
            
            // Skip 'this' reference - not needed like IntelliJ
            
            // Get method arguments/parameters
            try {
                Method method = location.method();
                List<LocalVariable> arguments = method.arguments();
                if (arguments != null && !arguments.isEmpty()) {
                    logger.info("[JDWP CLIENT] Method has {} parameters", arguments.size());
                    for (LocalVariable arg : arguments) {
                        try {
                            Value value = frame.getValue(arg);
                            String valueStr = formatValue(value, 0, thread);
                            String argType = arg.typeName();
                            variables.put(arg.name(), valueStr);
                            varCount++;
                            logger.info("[JDWP CLIENT]   [PARAMETER] {} (type: {}) = {}", arg.name(), argType, valueStr);
                        } catch (Exception e) {
                            logger.debug("[JDWP CLIENT] Could not get parameter {}: {}", arg.name(), e.getMessage());
                        }
                    }
                }
            } catch (Exception e) {
                logger.debug("[JDWP CLIENT] Could not get method arguments: {}", e.getMessage());
            }
            
            // Get all visible local variables
            try {
                logger.info("[JDWP CLIENT] Inspecting local variables in scope at line {}:", lineNumber);
                
                // Wait a bit to ensure thread is fully suspended
                Thread.sleep(100);
                
                // CRITICAL: Get variables visible at the EXACT line number where breakpoint hit
                List<LocalVariable> visibleVars = frame.visibleVariables();
                
                // Also try to get ALL local variables (not just visible at this line)
                // Some variables might be declared earlier but still in scope
                try {
                    Method method = location.method();
                    List<LocalVariable> allLocalVars = method.variables();
                    logger.info("[JDWP CLIENT] Method has {} total local variables (including those declared earlier)", allLocalVars.size());
                    
                    // Add variables that are in scope but might not be "visible" at this exact line
                    for (LocalVariable var : allLocalVars) {
                        try {
                            // Check if variable is in scope at this line
                            if (var.name().equals("this")) continue; // Skip 'this'
                            
                            // Skip if already in visibleVars (will be processed below)
                            boolean alreadyInVisible = visibleVars.stream().anyMatch(v -> v.name().equals(var.name()));
                            if (alreadyInVisible) continue;
                            
                            // Try to get the variable value directly - if it succeeds, it's accessible
                            // This will work even if the variable is not "visible" at this exact line
                            // but is still in scope (declared earlier in the method)
                            Value value = frame.getValue(var);
                            if (!variables.containsKey(var.name())) {
                                String valueStr = formatValue(value, 0, thread);
                                String varType = var.typeName();
                                variables.put(var.name(), valueStr);
                                varCount++;
                                logger.info("[JDWP CLIENT]   ✓ [ADDITIONAL VARIABLE] {} (type: {}) = {} (found via method.variables(), accessible at line {})", 
                                           var.name(), varType, valueStr, lineNumber);
                            }
                        } catch (Exception e) {
                            // Variable not in scope or not accessible - skip
                            logger.debug("[JDWP CLIENT] Variable {} not accessible at line {}: {} - {}", var.name(), lineNumber, e.getClass().getSimpleName(), e.getMessage());
                        }
                    }
                } catch (Exception e) {
                    logger.debug("[JDWP CLIENT] Could not get all method variables: {}", e.getMessage());
                }
                logger.info("[JDWP CLIENT] Found {} visible variables at line {}", visibleVars.size(), lineNumber);
                
                if (visibleVars.isEmpty()) {
                    logger.error("[JDWP CLIENT] ✗✗✗ CRITICAL: No visible variables found!");
                    logger.error("[JDWP CLIENT] This means the server code was NOT compiled with debug information.");
                    logger.error("[JDWP CLIENT] SOLUTION: Rebuild the server using rebuild-and-start.bat");
                    logger.error("[JDWP CLIENT] The server JAR must be rebuilt with -g flag to include variable debug info.");
                }
                
                for (LocalVariable var : visibleVars) {
                    try {
                        // Skip if we already have it (might be a parameter)
                        if (variables.containsKey(var.name())) {
                            logger.debug("[JDWP CLIENT] Skipping duplicate variable: {}", var.name());
                            continue;
                        }
                        
                        // Get variable value
                        Value value = frame.getValue(var);
                        String valueStr = formatValue(value, 0, thread);
                        String varType = var.typeName();
                        
                        variables.put(var.name(), valueStr);
                        varCount++;
                        logger.info("[JDWP CLIENT]   ✓ [VARIABLE #{}/{}] {} (type: {}) = {}", 
                                   varCount, visibleVars.size(), var.name(), varType, valueStr);
                    } catch (Exception e) {
                        logger.warn("[JDWP CLIENT] ✗ Could not get variable {}: {} - {}", var.name(), e.getClass().getSimpleName(), e.getMessage());
                    }
                }
            } catch (AbsentInformationException e) {
                logger.error("[JDWP CLIENT] ✗✗✗ CRITICAL: Local variable information not available!");
                logger.error("[JDWP CLIENT] Code is NOT compiled with debug information (-g flag)");
                logger.error("[JDWP CLIENT] Server must be rebuilt with: mvn clean package (with -g flag in pom.xml)");
                logger.error("[JDWP CLIENT] Error: {}", e.getMessage());
                // Return empty map but log the issue clearly
            } catch (Exception e) {
                logger.error("[JDWP CLIENT] ✗✗✗ Error getting visible variables: {} - {}", e.getClass().getSimpleName(), e.getMessage(), e);
            }
            
            logger.info("[JDWP CLIENT] ✓ Retrieved {} total variables from current scope (this + params + locals)", varCount);
            if (variables.isEmpty()) {
                logger.warn("[JDWP CLIENT] ⚠️  No variables found! This might mean:");
                logger.warn("[JDWP CLIENT]   1. Code not compiled with debug information (-g flag)");
                logger.warn("[JDWP CLIENT]   2. Variables not yet initialized at this line");
                logger.warn("[JDWP CLIENT]   3. Variables optimized away by JVM");
            }
            logger.info("========================================");
            return variables;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗ Failed to get variables: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to get variables at next line: " + e.getMessage(), e);
        }
    }
    
    public synchronized String evaluateExpression(String threadName, String expression) {
        return evaluateExpression(threadName, null, expression);
    }

    /**
     * Evaluate in the context of a specific stack frame (IntelliJ-style) or, if frameIndex is null,
     * the first "application" frame (skips JDK/Spring frames like the legacy behavior).
     */
    public synchronized String evaluateExpression(String threadName, Integer frameIndex, String expression) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] EVALUATING EXPRESSION");
        logger.info("[JDWP CLIENT] Thread: {}", threadName);
        logger.info("[JDWP CLIENT] Frame index: {}", frameIndex);
        logger.info("[JDWP CLIENT] Expression: {}", expression);
        logger.info("========================================");
        
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        try {
            if (!thread.isSuspended()) {
                logger.info("[JDWP CLIENT] Thread not suspended, suspending...");
                thread.suspend();
            }
            
            List<StackFrame> frames = thread.frames();
            if (frames.isEmpty()) {
                throw new RuntimeException("No stack frames available");
            }
            
            StackFrame frame;
            Location location;
            if (frameIndex != null) {
                if (frameIndex < 0 || frameIndex >= frames.size()) {
                    throw new RuntimeException("Invalid frame index " + frameIndex + " (0.." + (frames.size() - 1) + ")");
                }
                frame = frames.get(frameIndex);
                location = frame.location();
            } else {
                // Find first frame in application code (not in jdk.internal, java.*, sun.*, org.apache.*, etc.)
                frame = null;
                location = null;
                for (StackFrame f : frames) {
                    Location loc = f.location();
                    String className = loc.declaringType().name();
                    if (!className.startsWith("jdk.internal.") && 
                        !className.startsWith("java.") && 
                        !className.startsWith("sun.") &&
                        !className.startsWith("com.sun.") &&
                        !className.startsWith("org.apache.") &&
                        !className.startsWith("org.springframework.") &&
                        !className.startsWith("org.eclipse.") &&
                        !className.startsWith("ch.qos.logback.") &&
                        !className.startsWith("org.slf4j.") &&
                        loc.lineNumber() > 0) {
                        frame = f;
                        location = loc;
                        break;
                    }
                }
                if (frame == null) {
                    frame = frames.get(0);
                    location = frame.location();
                }
            }
            
            ReferenceType refType = location.declaringType();
            
            logger.info("[JDWP CLIENT] Evaluating in context:");
            logger.info("[JDWP CLIENT]   Class: {}", refType.name());
            logger.info("[JDWP CLIENT]   Method: {}", location.method().name());
            logger.info("[JDWP CLIENT]   Line: {}", location.lineNumber());
            
            // Use JDI's evaluation capability
            Value result = null;

            // --- Enterprise conditions: comparisons & logic -------------------
            if (isConditionExpression(expression)) {
                boolean boolResult = evalBool(frame, thread, expression);
                logger.info("[JDWP CLIENT] Condition '{}' -> {}", expression, boolResult);
                return boolResult ? "true" : "false";
            }

            try {
                // Try to evaluate as a simple expression
                // Note: JDI doesn't have built-in expression evaluation, so we'll use a workaround
                // We can evaluate field access, method calls on objects in scope
                result = frame.getValue(frame.visibleVariableByName(expression));
                logger.info("[JDWP CLIENT] Expression matched variable: {}", expression);
            } catch (Exception e1) {
                // If not a variable, try to evaluate as a method call or field access
                try {
                    // For simple expressions like "variable.method()" or "variable.field"
                    if (expression.contains(".")) {
                        String[] parts = expression.split("\\.", 2);
                        String varName = parts[0];
                        String member = parts[1];
                        
                        LocalVariable var = frame.visibleVariableByName(varName);
                        Value varValue = frame.getValue(var);
                        
                        if (varValue instanceof ObjectReference) {
                            ObjectReference objRef = (ObjectReference) varValue;
                            ReferenceType type = objRef.referenceType();
                            
                            // Try as method call
                            if (member.endsWith("()")) {
                                String methodName = member.substring(0, member.length() - 2);
                                result = objRef.invokeMethod(thread, type.methodsByName(methodName).get(0), 
                                    Collections.emptyList(), ObjectReference.INVOKE_SINGLE_THREADED);
                            } else {
                                // Try as field access
                                Field field = type.fieldByName(member);
                                result = objRef.getValue(field);
                            }
                        }
                    } else {
                        throw new RuntimeException("Expression not supported: " + expression);
                    }
                } catch (Exception e2) {
                    logger.error("[JDWP CLIENT] Failed to evaluate expression: {}", e2.getMessage());
                    throw new RuntimeException("Failed to evaluate expression: " + e2.getMessage() + 
                        ". Supported: variable names, variable.field, variable.method()", e2);
                }
            }
            
            // Use formatValue to properly format the result (handles Collections, Arrays, etc.)
            String resultStr = result != null ? formatValue(result, 0, thread) : "null";
            String resultType = result != null ? result.type().name() : "null";
            
            logger.info("[JDWP CLIENT] ✓ Expression evaluated successfully");
            logger.info("[JDWP CLIENT]   Result type: {}", resultType);
            logger.info("[JDWP CLIENT]   Result value: {}", resultStr);
            logger.info("========================================");
            
            return resultStr;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗ Failed to evaluate expression: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to evaluate expression: " + e.getMessage(), e);
        }
    }
    
    /** Detect comparison/logical condition expressions (a > 10, b == "x", a > 1 && b < 2). */
    private static boolean isConditionExpression(String e) {
        return e.contains("&&") || e.contains("||") || e.contains("==") || e.contains("!=")
                || e.contains(">=") || e.contains("<=")
                || e.matches("(?s).*\\s[<>]\\s.*");
    }

    private boolean evalBool(StackFrame frame, ThreadReference thread, String expression) {
        // Split on || first (lowest precedence), then && inside each side.
        int depth = 0;
        List<int[]> orSplits = new ArrayList<>();
        char[] chars = expression.toCharArray();
        for (int i = 0; i < chars.length; i++) {
            if (chars[i] == '(') depth++;
            else if (chars[i] == ')') depth--;
            else if (depth == 0 && i + 1 < chars.length && chars[i] == '|' && chars[i + 1] == '|') {
                orSplits.add(new int[]{i, i + 2});
                i++;
            }
        }
        if (!orSplits.isEmpty()) {
            int start = 0;
            for (int[] sp : orSplits) {
                if (evalBool(frame, thread, expression.substring(start, sp[0]).trim())) return true;
                start = sp[1];
            }
            return evalBool(frame, thread, expression.substring(start).trim());
        }
        List<int[]> andSplits = new ArrayList<>();
        for (int i = 0; i < chars.length; i++) {
            if (chars[i] == '(') depth++;
            else if (chars[i] == ')') depth--;
            else if (depth == 0 && i + 1 < chars.length && chars[i] == '&' && chars[i + 1] == '&') {
                andSplits.add(new int[]{i, i + 2});
                i++;
            }
        }
        if (!andSplits.isEmpty()) {
            int start = 0;
            for (int[] sp : andSplits) {
                if (!evalBool(frame, thread, expression.substring(start, sp[0]).trim())) return false;
                start = sp[1];
            }
            return evalBool(frame, thread, expression.substring(start).trim());
        }

        java.util.regex.Matcher cm = java.util.regex.Pattern.compile(">=|<=|==|!=|>|<").matcher(expression);
        if (cm.find()) {
            String op = cm.group();
            Object lv = operandValue(expression.substring(0, cm.start()).trim(), frame);
            Object rv = operandValue(expression.substring(cm.end()).trim(), frame);
            int cmp;
            if (lv instanceof Number && rv instanceof Number) {
                cmp = Double.compare(((Number) lv).doubleValue(), ((Number) rv).doubleValue());
            } else if (lv instanceof Boolean || rv instanceof Boolean) {
                boolean lb = lv instanceof Boolean ? (Boolean) lv : Boolean.parseBoolean(String.valueOf(lv));
                boolean rb = rv instanceof Boolean ? (Boolean) rv : Boolean.parseBoolean(String.valueOf(rv));
                cmp = Boolean.compare(lb, rb);
            } else {
                cmp = String.valueOf(lv).compareTo(String.valueOf(rv));
            }
            switch (op) {
                case ">":  return cmp > 0;
                case "<":  return cmp < 0;
                case ">=": return cmp >= 0;
                case "<=": return cmp <= 0;
                case "==": return cmp == 0;
                default:   return cmp != 0;
            }
        }

        Object v = operandValue(expression.trim(), frame);
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof Number) return ((Number) v).doubleValue() != 0d;
        String s = String.valueOf(v);
        if (s.equalsIgnoreCase("true")) return true;
        if (s.equalsIgnoreCase("false") || s.equals("null")) return false;
        throw new RuntimeException("Cannot interpret as boolean: " + expression);
    }

    /** Resolve a condition operand: string/number/boolean literals or in-scope variables. */
    private Object operandValue(String token, StackFrame frame) {
        String s = token.trim();
        if (s.length() >= 2 && ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'")))) {
            return s.substring(1, s.length() - 1);
        }
        if (s.equals("true")) return Boolean.TRUE;
        if (s.equals("false")) return Boolean.FALSE;
        if (s.equals("null")) return null;
        if (s.matches("-?\\d+\\.\\d+") || s.matches("-?\\d+")) return Double.parseDouble(s);
        try {
            LocalVariable var = frame.visibleVariableByName(s);
            if (var != null) {
                Value v = frame.getValue(var);
                if (v == null) return null;
                if (v instanceof com.sun.jdi.BooleanValue) return ((com.sun.jdi.BooleanValue) v).value();
                if (v instanceof com.sun.jdi.IntegerValue) return ((com.sun.jdi.IntegerValue) v).value();
                if (v instanceof com.sun.jdi.LongValue) return ((com.sun.jdi.LongValue) v).value();
                if (v instanceof com.sun.jdi.DoubleValue) return ((com.sun.jdi.DoubleValue) v).value();
                if (v instanceof com.sun.jdi.FloatValue) return (double) ((com.sun.jdi.FloatValue) v).value();
                if (v instanceof com.sun.jdi.ShortValue) return ((com.sun.jdi.ShortValue) v).value();
                if (v instanceof com.sun.jdi.ByteValue) return ((com.sun.jdi.ByteValue) v).value();
                if (v instanceof com.sun.jdi.CharValue) return String.valueOf(((com.sun.jdi.CharValue) v).value());
                if (v instanceof StringReference) return ((StringReference) v).value();
                return v.toString();
            }
        } catch (Exception ignore) { }
        throw new RuntimeException("Unknown operand: " + token);
    }

    public synchronized Map<String, Object> getCurrentSourceLocation(String threadName) {
        logger.info("========================================");
        logger.info("[JDWP CLIENT] GETTING CURRENT SOURCE LOCATION");
        logger.info("[JDWP CLIENT] Thread: {}", threadName);
        logger.info("========================================");
        
        if (!isConnected()) {
            logger.error("[JDWP CLIENT] ✗ Not connected to JDWP server");
            throw new IllegalStateException("Not connected to JDWP server");
        }
        
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Thread not found: " + threadName));
        
        try {
            if (!thread.isSuspended()) {
                logger.info("[JDWP CLIENT] Thread not suspended, suspending...");
                thread.suspend();
            }
            
            List<StackFrame> frames = thread.frames();
            if (frames.isEmpty()) {
                throw new RuntimeException("No stack frames available");
            }
            
            // CRITICAL: Frame 0 is where the breakpoint actually hit - show that FIRST
            // This is the exact location where execution stopped
            StackFrame frame = null;
            Location location = null;
            
            // Check frame 0 first - this is the breakpoint location
            StackFrame frame0 = frames.get(0);
            Location loc0 = frame0.location();
            String className0 = loc0.declaringType().name();
            
            // If frame 0 is in application code, use it (this is where breakpoint hit)
            boolean isAppCode0 = !className0.startsWith("jdk.internal.") && 
                !className0.startsWith("java.") && 
                !className0.startsWith("sun.") &&
                !className0.startsWith("com.sun.") &&
                !className0.startsWith("org.apache.") &&
                !className0.startsWith("org.springframework.") &&
                !className0.startsWith("org.eclipse.") &&
                !className0.startsWith("ch.qos.logback.") &&
                !className0.startsWith("org.slf4j.") &&
                loc0.lineNumber() > 0;
            
            if (isAppCode0) {
                frame = frame0;
                location = loc0;
                logger.info("[JDWP CLIENT] ✓ Using frame 0 (breakpoint location): {}:{}:{}", 
                           className0, loc0.method().name(), loc0.lineNumber());
            } else {
                // Frame 0 is in framework code, find first application frame
                // PRIORITIZE: Controller frames over Service frames (like IntelliJ)
                logger.info("[JDWP CLIENT] Frame 0 is in framework code ({}), searching for application frame...", className0);
                
                StackFrame controllerFrame = null;
                StackFrame serviceFrame = null;
                StackFrame otherAppFrame = null;
                
                for (StackFrame f : frames) {
                    Location loc = f.location();
                    String className = loc.declaringType().name();
                    
                    // Check if it's application code
                    if (!className.startsWith("jdk.internal.") && 
                        !className.startsWith("java.") && 
                        !className.startsWith("sun.") &&
                        !className.startsWith("com.sun.") &&
                        !className.startsWith("org.apache.") &&
                        !className.startsWith("org.springframework.") &&
                        !className.startsWith("org.eclipse.") &&
                        !className.startsWith("ch.qos.logback.") &&
                        !className.startsWith("org.slf4j.") &&
                        loc.lineNumber() > 0) {
                        
                        // Prioritize controller over service
                        if (className.contains(".controller.") && controllerFrame == null) {
                            controllerFrame = f;
                            logger.info("[JDWP CLIENT] Found controller frame: {}:{}:{}", 
                                       className, loc.method().name(), loc.lineNumber());
                        } else if (className.contains(".service.") && serviceFrame == null && controllerFrame == null) {
                            serviceFrame = f;
                            logger.info("[JDWP CLIENT] Found service frame: {}:{}:{}", 
                                       className, loc.method().name(), loc.lineNumber());
                        } else if (otherAppFrame == null && controllerFrame == null && serviceFrame == null) {
                            otherAppFrame = f;
                            logger.info("[JDWP CLIENT] Found application frame: {}:{}:{}", 
                                       className, loc.method().name(), loc.lineNumber());
                        }
                    }
                }
                
                // Use controller first, then service, then other app code
                if (controllerFrame != null) {
                    frame = controllerFrame;
                    location = controllerFrame.location();
                } else if (serviceFrame != null) {
                    frame = serviceFrame;
                    location = serviceFrame.location();
                } else if (otherAppFrame != null) {
                    frame = otherAppFrame;
                    location = otherAppFrame.location();
                } else {
                    // Fallback to frame 0 if no application frame found
                    frame = frame0;
                    location = loc0;
                    logger.info("[JDWP CLIENT] No application frame found, using frame 0: {}:{}:{}", 
                               className0, loc0.method().name(), loc0.lineNumber());
                }
            }
            
            ReferenceType refType = location.declaringType();
            
            String className = refType.name();
            String methodName = location.method().name();
            int lineNumber = location.lineNumber();
            String sourceName = null;
            
            try {
                sourceName = location.sourceName();
            } catch (Exception e) {
                logger.debug("[JDWP CLIENT] Source name not available: {}", e.getMessage());
            }
            
            Map<String, Object> locationInfo = new HashMap<>();
            locationInfo.put("className", className);
            locationInfo.put("methodName", methodName);
            locationInfo.put("lineNumber", lineNumber);
            locationInfo.put("sourceName", sourceName);
            
            logger.info("[JDWP CLIENT] Current location:");
            logger.info("[JDWP CLIENT]   Class: {}", className);
            logger.info("[JDWP CLIENT]   Method: {}", methodName);
            logger.info("[JDWP CLIENT]   Line: {}", lineNumber);
            logger.info("[JDWP CLIENT]   Source: {}", sourceName != null ? sourceName : "N/A");
            logger.info("========================================");
            
            return locationInfo;
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] ✗ Failed to get source location: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to get source location: " + e.getMessage(), e);
        }
    }
    
    private String getThreadStatusString(int status) {
        switch (status) {
            case ThreadReference.THREAD_STATUS_MONITOR:
                return "MONITOR";
            case ThreadReference.THREAD_STATUS_NOT_STARTED:
                return "NOT_STARTED";
            case ThreadReference.THREAD_STATUS_RUNNING:
                return "RUNNING";
            case ThreadReference.THREAD_STATUS_SLEEPING:
                return "SLEEPING";
            case ThreadReference.THREAD_STATUS_UNKNOWN:
                return "UNKNOWN";
            case ThreadReference.THREAD_STATUS_WAIT:
                return "WAIT";
            case ThreadReference.THREAD_STATUS_ZOMBIE:
                return "ZOMBIE";
            default:
                return "UNKNOWN(" + status + ")";
        }
    }
    
    /**
     * Inject the console logging agent into the target JVM
     */
    private synchronized void injectLoggingAgent() {
        if (vm == null) {
            return;
        }
        
        try {
            // Find the agent JAR path
            String agentJarPath = findAgentJarPath();
            if (agentJarPath == null) {
                logger.warn("[JDWP CLIENT] Console log agent JAR not found, skipping injection");
                return;
            }
            
            // Get the log receiver port (default 9999)
            int logPort = 9999;
            if (logReceiverService != null && logReceiverService.isRunning()) {
                // Port is already set when receiver started
            } else {
                // Start log receiver if not already running
                if (logReceiverService != null) {
                    logReceiverService.start(logPort);
                }
            }
            
            // Build agent arguments: "localhost:9999"
            String agentArgs = "localhost:" + logPort;
            
            logger.info("[JDWP CLIENT] Injecting console log agent: {}", agentJarPath);
            logger.info("[JDWP CLIENT] Agent args: {}", agentArgs);
            
            // Load agent using Attach API via reflection (works with Java 9+)
            // JDI doesn't support agent loading directly, so we use Attach API
            try {
                // Get process ID from VM description or process list
                // VM description typically contains process info
                String vmDescription = vm.description();
                logger.debug("[JDWP CLIENT] VM Description: {}", vmDescription);
                
                // Get VM ID using Attach API - try to find the VM that matches our JDWP connection
                String vmId = null;
                boolean injectionSuccessful = false;
                
                try {
                    Class<?> vmClass = Class.forName("com.sun.tools.attach.VirtualMachine");
                    java.util.List<?> vms = (java.util.List<?>) vmClass.getMethod("list").invoke(null);
                    
                    logger.info("[JDWP CLIENT] Found {} VMs via Attach API", vms.size());
                    
                    // Try each VM - prioritize the one that looks like our target app (port 8081, Spring Boot, etc.)
                    java.util.List<Object> sortedVMs = new java.util.ArrayList<>(vms);
                    // Sort: put VMs that look like our target app first
                    sortedVMs.sort((v1, v2) -> {
                        try {
                            String d1 = (String) v1.getClass().getMethod("displayName").invoke(v1);
                            String d2 = (String) v2.getClass().getMethod("displayName").invoke(v2);
                            // Prioritize VMs that look like our target app and are not IDEs
                            boolean isIDE1 = d1 != null && (d1.contains("jetbrains") || d1.contains("IntelliJ") || d1.contains("jps.cmdline") || d1.contains("idea.Main") || d1.contains("MavenServer") || d1.contains("idea."));
                            boolean isTarget1 = d1 != null && !isIDE1 && (d1.contains(".jar") || d1.contains("8080") || d1.contains("8081") || d1.contains("spring") || d1.contains("Spring") || d1.contains("VcPlatform") || d1.contains("app.jar"));

                            boolean isIDE2 = d2 != null && (d2.contains("jetbrains") || d2.contains("IntelliJ") || d2.contains("jps.cmdline") || d2.contains("idea.Main") || d2.contains("MavenServer") || d2.contains("idea."));
                            boolean isTarget2 = d2 != null && !isIDE2 && (d2.contains(".jar") || d2.contains("8080") || d2.contains("8081") || d2.contains("spring") || d2.contains("Spring") || d2.contains("VcPlatform") || d2.contains("app.jar"));
                            if (isTarget1 && !isTarget2) return -1;
                            if (!isTarget1 && isTarget2) return 1;
                            return 0;
                        } catch (Exception e) {
                            return 0;
                        }
                    });
                    
                    for (Object v : sortedVMs) {
                        try {
                            String id = (String) v.getClass().getMethod("id").invoke(v);
                            String displayName = (String) v.getClass().getMethod("displayName").invoke(v);
                            String dn = displayName != null ? displayName : "";
                            String dnLower = dn.toLowerCase();
                            
                            // Skip IDE and non-target VMs (case-insensitive so "intellij" / "idea.Main" etc. are caught)
                            if (dnLower.contains("jetbrains") || dnLower.contains("intellij") || dnLower.contains("jps.cmdline")
                                    || dnLower.contains("idea.main") || dnLower.contains("mavenserver") || dnLower.contains("remotemaven") || dnLower.contains("idea.")) {
                                logger.debug("[JDWP CLIENT] Skipping IDE VM: id={}", id);
                                continue;
                            }

                            // Only attempt injection on VMs that look like the target app (JDWP debuggee)
                            boolean isTargetApp = dn.contains("8080") || dn.contains("8081") || dn.contains("app.jar")
                                    || dn.contains("VcPlatform") || dnLower.contains("spring");

                            if (!isTargetApp) {
                                logger.debug("[JDWP CLIENT] Skipping non-target VM: id={}", id);
                                continue;
                            }

                            logger.info("[JDWP CLIENT] Trying VM: id={}, displayName={}", id, dn.length() > 200 ? dn.substring(0, 200) + "..." : dn);

                            // Try to attach and inject into this VM
                            Object attachVM = vmClass.getMethod("attach", String.class).invoke(null, id);
                            try {
                                // Try to load the agent
                                logger.info("[JDWP CLIENT] Calling loadAgent({}, {}) on VM {}", agentJarPath, agentArgs, id);
                                vmClass.getMethod("loadAgent", String.class, String.class).invoke(attachVM, agentJarPath, agentArgs);
                                logger.info("[JDWP CLIENT] ✓✓✓ Console log agent injected successfully into VM: {} ({})", id, displayName != null && displayName.length() > 200 ? displayName.substring(0, 200) + "..." : displayName);
                                logger.info("[JDWP CLIENT] ⚠️ CHECK TARGET APP CONSOLE FOR: [ConsoleLogAgent] ✓✓✓ AGENT AGENTMAIN CALLED ✓✓✓");
                                vmId = id; // Mark as successful
                                injectionSuccessful = true;
                                break; // Success - stop trying
                            } catch (Exception injectError) {
                                logger.debug("[JDWP CLIENT] Failed to inject into VM {}: {}", id, injectError.getMessage());
                                // Try next VM
                            } finally {
                                try {
                                    vmClass.getMethod("detach").invoke(attachVM);
                                } catch (Exception e) {
                                    // Ignore detach errors
                                }
                            }
                        } catch (Exception e) {
                            logger.debug("[JDWP CLIENT] Error checking VM: {}", e.getMessage());
                        }
                    }
                    
                    // Do not fallback to first VM - it is often the IDE; debuggee may be in Docker (not in local VM list)
                } catch (ClassNotFoundException e) {
                    logger.error("[JDWP CLIENT] Attach API not available (Java 9+ module system): {}", e.getMessage());
                    logger.error("[JDWP CLIENT] Agent injection skipped - logging will not be available");
                    return;
                } catch (Exception e) {
                    logger.error("[JDWP CLIENT] Could not list VMs: {}", e.getMessage(), e);
                }
                
                if (!injectionSuccessful) {
                    logger.info("[JDWP CLIENT] Agent injection skipped (debuggee may be in Docker or not in local VM list). Logging will not be available.");
                }
            } catch (com.sun.jdi.VMDisconnectedException e) {
                logger.error("[JDWP CLIENT] VM disconnected during agent injection: {}", e.getMessage());
            } catch (Exception e) {
                logger.error("[JDWP CLIENT] Agent injection failed: {}", e.getMessage(), e);
                // Continue without agent - logging is optional
            }
        } catch (Exception e) {
            logger.error("[JDWP CLIENT] Failed to inject logging agent: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to inject logging agent: " + e.getMessage(), e);
        }
    }
    
    /**
     * Find the path to the console log agent JAR
     */
    /** Redact credential-looking content before exposing target strings to the UI. */
    private static String redactString(String s) {
        return com.jdwp.client.security.SecretRedactor.redact(s);
    }

    private String findAgentJarPath() {
        // console-log-agent.jar (built by the Maven assembly in every package) is the
        // standalone javaagent for live log capture. It lives next to the client JAR
        // or in target/ — a handful of deterministic locations, no filesystem crawl.
        java.util.List<String> candidates = new java.util.ArrayList<>();
        try {
            java.net.URL url = getClass().getProtectionDomain().getCodeSource().getLocation();
            String p = url.getPath();
            if (p.startsWith("file:")) p = p.substring(5);
            if (p.startsWith("/") && p.length() > 2 && p.charAt(2) == ':') p = p.substring(1);
            java.io.File self = new java.io.File(java.net.URLDecoder.decode(p, "UTF-8"));
            java.io.File dir = self.isFile() ? self.getParentFile() : self;
            if (dir != null) {
                candidates.add(new java.io.File(dir, "console-log-agent.jar").getPath());
                java.io.File parent = dir.getParentFile();
                if (parent != null) {
                    candidates.add(new java.io.File(parent, "target/console-log-agent.jar").getPath());
                }
            }
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] Could not resolve own location: {}", e.getMessage());
        }
        String userDir = System.getProperty("user.dir");
        if (userDir != null) {
            candidates.add(userDir + "/target/console-log-agent.jar");
            candidates.add(userDir + "/client/target/console-log-agent.jar");
        }

        for (String path : candidates) {
            try {
                java.io.File f = new java.io.File(path);
                logger.debug("[JDWP CLIENT] Checking: {} -> exists: {}", path, f.exists());
                if (f.isFile()) {
                    logger.info("[JDWP CLIENT] ✓ Found log agent JAR: {}", f.getAbsolutePath());
                    return f.getAbsolutePath();
                }
            } catch (Exception e) {
                logger.debug("[JDWP CLIENT] Error checking {}: {}", path, e.getMessage());
            }
        }

        logger.error("[JDWP CLIENT] ❌ console-log-agent.jar not found — run 'mvn package' to produce it; live log capture disabled for this session.");
        return null;
    }
    
    /**
     * Get the directory where the client JAR is running from
     */
    private String getJarDirectory() {
        try {
            // Get the path of the JAR file
            java.net.URL url = getClass().getProtectionDomain().getCodeSource().getLocation();
            String jarPath = url.getPath();
            if (jarPath.startsWith("file:")) {
                jarPath = jarPath.substring(5);
            }
            // Handle Windows paths
            if (jarPath.startsWith("/") && jarPath.length() > 2 && jarPath.charAt(2) == ':') {
                jarPath = jarPath.substring(1);
            }
            java.io.File jarFile = new java.io.File(java.net.URLDecoder.decode(jarPath, "UTF-8"));
            return jarFile.getParent();
        } catch (Exception e) {
            logger.debug("[JDWP CLIENT] Could not determine JAR directory: {}", e.getMessage());
            return null;
        }
    }

    public synchronized boolean isBreakpointsMuted() {
        return breakpointsMuted;
    }

    /** Mute or unmute all line breakpoints without removing them (IDE-style). */
    public synchronized void setBreakpointsMuted(boolean muted) {
        this.breakpointsMuted = muted;
        for (BreakpointRequest br : breakpoints.values()) {
            br.setEnabled(!muted);
        }
        logger.info("[JDWP CLIENT] Breakpoints {}", muted ? "MUTED" : "UNMUTED");
    }

    /**
     * Method breakpoint: resolves the first executable line of the named method and sets a line breakpoint.
     * For overloaded methods, pass {@code signature} in JNI form, e.g. {@code (Ljava/lang/String;)V}.
     */
    public synchronized String setMethodBreakpoint(String className, String methodName, String signature) {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        List<ReferenceType> types = vm.classesByName(className);
        if (types == null || types.isEmpty()) {
            throw new RuntimeException("Class not loaded: " + className + ". Trigger a code path that loads it first.");
        }
        ReferenceType rt = types.get(0);
        List<Method> candidates = rt.methodsByName(methodName);
        if (candidates.isEmpty()) {
            throw new RuntimeException("Method not found: " + methodName);
        }
        Method method;
        if (signature != null && !signature.isBlank()) {
            method = candidates.stream()
                    .filter(m -> m.signature().equals(signature.trim()))
                    .findFirst()
                    .orElseThrow(() -> new RuntimeException("No overload with signature " + signature));
        } else if (candidates.size() > 1) {
            throw new RuntimeException("Method " + methodName + " is overloaded; pass signature (JNI), e.g. (Ljava/lang/String;)V");
        } else {
            method = candidates.get(0);
        }
        try {
            List<Location> locs = method.allLineLocations();
            if (locs == null || locs.isEmpty()) {
                throw new RuntimeException("No line locations for method (native/abstract or no debug info)");
            }
            int line = locs.get(0).lineNumber();
            logger.info("[JDWP CLIENT] Method breakpoint -> first line {} in {}", line, className);
            return setBreakpoint(className, line);
        } catch (AbsentInformationException e) {
            throw new RuntimeException("Absent line information for method: " + e.getMessage(), e);
        }
    }

    /**
     * Field watchpoint: break on read and/or write. Requires class loaded.
     */
    public synchronized Map<String, Object> addFieldWatchpoint(String className, String fieldName, boolean onRead, boolean onWrite) {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        if (!onRead && !onWrite) {
            throw new IllegalArgumentException("Select onRead and/or onWrite");
        }
        List<ReferenceType> types = vm.classesByName(className);
        if (types == null || types.isEmpty()) {
            throw new RuntimeException("Class not loaded: " + className);
        }
        ReferenceType rt = types.get(0);
        Field field = rt.fieldByName(fieldName);
        if (field == null) {
            throw new RuntimeException("Field not found: " + fieldName);
        }
        EventRequestManager erm = vm.eventRequestManager();
        List<String> ids = new ArrayList<>();
        if (onRead) {
            String id = className + "#" + fieldName + ":read";
            AccessWatchpointRequest ar = erm.createAccessWatchpointRequest(field);
            ar.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            ar.enable();
            fieldWatchpoints.put(id, ar);
            ids.add(id);
        }
        if (onWrite) {
            String id = className + "#" + fieldName + ":write";
            ModificationWatchpointRequest mr = erm.createModificationWatchpointRequest(field);
            mr.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            mr.enable();
            fieldWatchpoints.put(id, mr);
            ids.add(id);
        }
        Map<String, Object> out = new HashMap<>();
        out.put("success", true);
        out.put("ids", ids);
        return out;
    }

    public synchronized void removeFieldWatchpoint(String watchpointId) {
        if (!isConnected()) {
            return;
        }
        WatchpointRequest wr = fieldWatchpoints.remove(watchpointId);
        if (wr != null) {
            try {
                vm.eventRequestManager().deleteEventRequest(wr);
            } catch (Exception e) {
                logger.debug("[JDWP CLIENT] remove watchpoint: {}", e.getMessage());
            }
        }
    }

    public synchronized List<Map<String, Object>> listFieldWatchpoints() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (String id : fieldWatchpoints.keySet()) {
            Map<String, Object> row = new HashMap<>();
            row.put("id", id);
            list.add(row);
        }
        return list;
    }

    /** Full JVM thread dump with stacks (robust diagnostics, similar to jstack). */
    public synchronized Map<String, Object> captureThreadDump() {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (ThreadReference t : vm.allThreads()) {
            Map<String, Object> row = new HashMap<>();
            row.put("name", t.name());
            try {
                row.put("status", t.status());
            } catch (Exception e) {
                row.put("status", "?");
            }
            row.put("isSuspended", t.isSuspended());
            List<String> stackLines = new ArrayList<>();
            try {
                if (t.isSuspended()) {
                    for (StackFrame sf : t.frames()) {
                        Location loc = sf.location();
                        stackLines.add(loc.declaringType().name() + "." + loc.method().name()
                                + "(" + (loc.lineNumber() >= 0 ? loc.lineNumber() : "?") + ")");
                    }
                }
            } catch (Exception e) {
                stackLines.add("<unreadable: " + e.getMessage() + ">");
            }
            row.put("stack", stackLines);
            rows.add(row);
        }
        Map<String, Object> out = new HashMap<>();
        out.put("success", true);
        out.put("threads", rows);
        return out;
    }

    /**
     * Lightweight "execution radar": where each live thread's top frame is (innovation — quick mental map of worker activity).
     */
    public synchronized Map<String, Object> getExecutionRadar() {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        List<Map<String, Object>> dots = new ArrayList<>();
        for (ThreadReference t : vm.allThreads()) {
            Map<String, Object> d = new HashMap<>();
            d.put("name", t.name());
            d.put("isSuspended", t.isSuspended());
            try {
                if (t.isSuspended() && t.frameCount() > 0) {
                    Location loc = t.frame(0).location();
                    d.put("topClass", loc.declaringType().name());
                    d.put("topMethod", loc.method().name());
                    d.put("line", loc.lineNumber());
                } else {
                    d.put("topClass", null);
                    d.put("topMethod", null);
                    d.put("line", null);
                }
            } catch (Exception e) {
                d.put("topClass", null);
                d.put("error", e.getMessage());
            }
            dots.add(d);
        }
        Map<String, Object> out = new HashMap<>();
        out.put("success", true);
        out.put("threads", dots);
        return out;
    }

    private int recordBreakpointHit(String bpId) {
        if (bpId == null) {
            return 0;
        }
        return breakpointHitCounts.computeIfAbsent(bpId, k -> new AtomicInteger()).incrementAndGet();
    }

    public synchronized Map<String, Integer> getBreakpointHitCounts() {
        Map<String, Integer> m = new HashMap<>();
        for (Map.Entry<String, AtomicInteger> e : breakpointHitCounts.entrySet()) {
            m.put(e.getKey(), e.getValue().get());
        }
        return m;
    }

    /**
     * X-Debug-Request-Id style value read from stack (DebugRequestFilter), if present.
     */
    public synchronized String getRequestIdForThread(String threadName) {
        if (!isConnected()) {
            throw new IllegalStateException("Not connected to JDWP server");
        }
        ThreadReference thread = vm.allThreads().stream()
                .filter(t -> t.name().equals(threadName))
                .findFirst()
                .orElse(null);
        if (thread == null) {
            return null;
        }
        return findRequestIdInStack(thread);
    }
}

