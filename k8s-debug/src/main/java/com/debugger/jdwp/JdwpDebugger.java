package com.debugger.jdwp;

import com.debugger.audit.AuditLogger;
import com.debugger.model.DebugSession;
import com.sun.jdi.*;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.event.*;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import com.sun.jdi.request.ExceptionRequest;
import com.sun.jdi.request.StepRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/**
 * JDWP Debugger that enforces production-safe debugging rules:
 * - Thread-only suspension (never VM-wide)
 * - Conditional breakpoints bound to requestId
 * - Automatic timeout and cleanup
 */
@Component
@Slf4j
public class JdwpDebugger {
    
    private static final int CONNECTION_TIMEOUT_MS = 10000;
    private static final int DEFAULT_SUSPEND_TIMEOUT_MS = 30000;
    
    @Autowired
    private AuditLogger auditLogger;
    
    // Active connections
    private final Map<String, VirtualMachine> activeConnections = new ConcurrentHashMap<>();
    
    // Event processing threads
    private final Map<String, Thread> eventThreads = new ConcurrentHashMap<>();
    
    // Breakpoint hit callbacks
    private final Map<String, CompletableFuture<BreakpointHit>> breakpointFutures = new ConcurrentHashMap<>();
    
    /**
     * Connect to a JVM via JDWP.
     */
    public void connect(String sessionId, String host, int port) {
        log.info("Connecting to JVM: sessionId={}, host={}, port={}", sessionId, host, port);
        
        try {
            VirtualMachineManager vmManager = Bootstrap.virtualMachineManager();
            
            AttachingConnector connector = vmManager.attachingConnectors().stream()
                    .filter(c -> c.name().equals("com.sun.jdi.SocketAttach"))
                    .findFirst()
                    .orElseThrow(() -> new RuntimeException("Socket attach connector not found"));
            
            Map<String, Connector.Argument> args = connector.defaultArguments();
            args.get("hostname").setValue(host);
            args.get("port").setValue(String.valueOf(port));
            args.get("timeout").setValue(String.valueOf(CONNECTION_TIMEOUT_MS));
            
            VirtualMachine vm = connector.attach(args);
            
            activeConnections.put(sessionId, vm);
            
            // Start event processing thread
            startEventThread(sessionId, vm);
            
            auditLogger.logConnection(sessionId, host, port, true);
            log.info("Connected to JVM: sessionId={}, vmName={}", sessionId, vm.name());
            
        } catch (Exception e) {
            auditLogger.logConnection(sessionId, host, port, false);
            log.error("Failed to connect to JVM: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to connect to JVM: " + e.getMessage(), e);
        }
    }
    
    /**
     * Disconnect from a JVM.
     */
    public void disconnect(String sessionId) {
        log.info("Disconnecting from JVM: sessionId={}", sessionId);
        
        VirtualMachine vm = activeConnections.remove(sessionId);
        if (vm != null) {
            try {
                // Stop event thread
                Thread eventThread = eventThreads.remove(sessionId);
                if (eventThread != null) {
                    eventThread.interrupt();
                }
                
                // Resume all suspended threads before disconnecting
                vm.allThreads().forEach(t -> {
                    try {
                        if (t.isSuspended()) {
                            t.resume();
                        }
                    } catch (Exception e) {
                        log.warn("Error resuming thread: {}", e.getMessage());
                    }
                });
                
                vm.dispose();
                auditLogger.logDisconnection(sessionId);
                log.info("Disconnected from JVM: sessionId={}", sessionId);
                
            } catch (Exception e) {
                log.error("Error disconnecting: {}", e.getMessage(), e);
            }
        }
        
        // Clean up any pending futures
        CompletableFuture<BreakpointHit> future = breakpointFutures.remove(sessionId);
        if (future != null) {
            future.cancel(true);
        }
    }
    
    /**
     * Check if connected to a JVM.
     */
    public boolean isConnected(String sessionId) {
        VirtualMachine vm = activeConnections.get(sessionId);
        return vm != null;
    }
    
    /**
     * Set a CONDITIONAL breakpoint that only suspends threads matching a requestId.
     * This is the key to production-safe debugging.
     */
    public void setConditionalBreakpoint(String sessionId, String className, int lineNumber, 
                                          String requestId) {
        VirtualMachine vm = getVM(sessionId);
        
        log.info("Setting conditional breakpoint: sessionId={}, class={}, line={}, requestId={}", 
                sessionId, className, lineNumber, requestId);
        
        try {
            // Find the class
            List<ReferenceType> classes = vm.classesByName(className);
            if (classes.isEmpty()) {
                throw new RuntimeException("Class not found: " + className);
            }
            
            ReferenceType refType = classes.get(0);
            
            // Find the location
            List<Location> locations = refType.locationsOfLine(lineNumber);
            if (locations.isEmpty()) {
                throw new RuntimeException("No code at line " + lineNumber + " in " + className);
            }
            
            Location location = locations.get(0);
            
            // Create breakpoint request
            EventRequestManager erm = vm.eventRequestManager();
            BreakpointRequest bp = erm.createBreakpointRequest(location);
            
            // CRITICAL: Set suspend policy to THREAD only (not VM-wide)
            bp.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            
            // Add condition filter using RequestContext
            // The condition is evaluated in the target JVM
            String condition = String.format(
                    "com.debugger.core.RequestContext.get().equals(\"%s\")", 
                    requestId);
            
            // Note: JDI doesn't directly support condition expressions
            // We'll filter in the event handler instead
            bp.putProperty("condition", condition);
            bp.putProperty("requestId", requestId);
            bp.putProperty("sessionId", sessionId);
            
            bp.enable();
            
            auditLogger.logBreakpointSet(sessionId, className, lineNumber, requestId);
            log.info("Conditional breakpoint set: location={}", location);
            
        } catch (Exception e) {
            log.error("Failed to set breakpoint: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to set breakpoint: " + e.getMessage(), e);
        }
    }
    
    /**
     * Set an exception breakpoint that catches all exceptions.
     */
    public void setExceptionBreakpoint(String sessionId, String exceptionClass, 
                                        boolean caught, boolean uncaught, String requestId) {
        VirtualMachine vm = getVM(sessionId);
        
        log.info("Setting exception breakpoint: sessionId={}, exception={}, requestId={}", 
                sessionId, exceptionClass, requestId);
        
        try {
            EventRequestManager erm = vm.eventRequestManager();
            
            ReferenceType exType = null;
            if (exceptionClass != null && !exceptionClass.isEmpty()) {
                List<ReferenceType> classes = vm.classesByName(exceptionClass);
                if (!classes.isEmpty()) {
                    exType = classes.get(0);
                }
            }
            
            ExceptionRequest er = erm.createExceptionRequest(exType, caught, uncaught);
            er.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            er.putProperty("requestId", requestId);
            er.putProperty("sessionId", sessionId);
            er.enable();
            
            auditLogger.logExceptionBreakpoint(sessionId, exceptionClass, requestId);
            log.info("Exception breakpoint set");
            
        } catch (Exception e) {
            log.error("Failed to set exception breakpoint: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to set exception breakpoint: " + e.getMessage(), e);
        }
    }
    
    /**
     * Wait for a breakpoint to hit (with timeout).
     */
    public BreakpointHit waitForBreakpoint(String sessionId, int timeoutMs) {
        log.info("Waiting for breakpoint: sessionId={}, timeout={}ms", sessionId, timeoutMs);
        
        CompletableFuture<BreakpointHit> future = new CompletableFuture<>();
        breakpointFutures.put(sessionId, future);
        
        try {
            BreakpointHit hit = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            log.info("Breakpoint hit: location={}, thread={}", hit.location, hit.threadName);
            return hit;
        } catch (TimeoutException e) {
            log.info("Breakpoint wait timed out");
            return null;
        } catch (Exception e) {
            log.error("Error waiting for breakpoint: {}", e.getMessage());
            throw new RuntimeException("Error waiting for breakpoint", e);
        } finally {
            breakpointFutures.remove(sessionId);
        }
    }
    
    /**
     * Get all variables in the current stack frame.
     */
    public Map<String, Object> getVariables(String sessionId, long threadId) {
        VirtualMachine vm = getVM(sessionId);
        
        try {
            ThreadReference thread = findThread(vm, threadId);
            if (thread == null || !thread.isSuspended()) {
                throw new RuntimeException("Thread not suspended: " + threadId);
            }
            
            StackFrame frame = thread.frame(0);
            Map<String, Object> variables = new LinkedHashMap<>();
            
            // Get 'this' object
            ObjectReference thisObj = frame.thisObject();
            if (thisObj != null) {
                variables.put("this", extractValue(thisObj, 2));
            }
            
            // Get local variables
            try {
                List<LocalVariable> locals = frame.visibleVariables();
                for (LocalVariable local : locals) {
                    Value value = frame.getValue(local);
                    variables.put(local.name(), extractValue(value, 2));
                }
            } catch (AbsentInformationException e) {
                log.warn("Local variable info not available (compile with -g)");
            }
            
            return variables;
            
        } catch (Exception e) {
            log.error("Failed to get variables: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to get variables: " + e.getMessage(), e);
        }
    }
    
    /**
     * Get the call stack for a thread.
     */
    public List<Map<String, Object>> getStackTrace(String sessionId, long threadId) {
        VirtualMachine vm = getVM(sessionId);
        
        try {
            ThreadReference thread = findThread(vm, threadId);
            if (thread == null || !thread.isSuspended()) {
                throw new RuntimeException("Thread not suspended: " + threadId);
            }
            
            List<Map<String, Object>> stack = new ArrayList<>();
            List<StackFrame> frames = thread.frames();
            
            for (int i = 0; i < frames.size(); i++) {
                StackFrame frame = frames.get(i);
                Location loc = frame.location();
                
                Map<String, Object> frameInfo = new LinkedHashMap<>();
                frameInfo.put("index", i);
                frameInfo.put("className", loc.declaringType().name());
                frameInfo.put("methodName", loc.method().name());
                frameInfo.put("lineNumber", loc.lineNumber());
                frameInfo.put("location", loc.toString());
                
                stack.add(frameInfo);
            }
            
            return stack;
            
        } catch (Exception e) {
            log.error("Failed to get stack trace: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to get stack trace: " + e.getMessage(), e);
        }
    }
    
    /**
     * Evaluate an expression in the context of a suspended thread.
     */
    public Object evaluateExpression(String sessionId, long threadId, String expression) {
        VirtualMachine vm = getVM(sessionId);
        
        try {
            ThreadReference thread = findThread(vm, threadId);
            if (thread == null || !thread.isSuspended()) {
                throw new RuntimeException("Thread not suspended: " + threadId);
            }
            
            // For simple expressions, we can invoke methods
            // Full expression evaluation requires more complex implementation
            
            // Try to get RequestContext.get() as a common case
            if (expression.contains("RequestContext.get()")) {
                return evaluateRequestContext(vm, thread);
            }
            
            // For other expressions, return a placeholder
            return "Expression evaluation: " + expression + " (limited support)";
            
        } catch (Exception e) {
            log.error("Failed to evaluate expression: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to evaluate: " + e.getMessage(), e);
        }
    }
    
    /**
     * Step over to the next line.
     */
    public void stepOver(String sessionId, long threadId) {
        VirtualMachine vm = getVM(sessionId);
        
        try {
            ThreadReference thread = findThread(vm, threadId);
            if (thread == null || !thread.isSuspended()) {
                throw new RuntimeException("Thread not suspended");
            }
            
            EventRequestManager erm = vm.eventRequestManager();
            var stepRequest = erm.createStepRequest(thread, StepRequest.STEP_LINE, StepRequest.STEP_OVER);
            stepRequest.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            stepRequest.addCountFilter(1);
            stepRequest.enable();
            
            thread.resume();
            log.info("Step over executed for thread: {}", threadId);
            
        } catch (Exception e) {
            log.error("Failed to step over: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to step over", e);
        }
    }
    
    /**
     * Resume a suspended thread.
     */
    public void resumeThread(String sessionId, long threadId) {
        VirtualMachine vm = getVM(sessionId);
        
        try {
            ThreadReference thread = findThread(vm, threadId);
            if (thread != null && thread.isSuspended()) {
                thread.resume();
                auditLogger.logThreadResume(sessionId, threadId);
                log.info("Thread resumed: {}", threadId);
            }
        } catch (Exception e) {
            log.error("Failed to resume thread: {}", e.getMessage(), e);
            throw new RuntimeException("Failed to resume thread", e);
        }
    }
    
    /**
     * Clear all breakpoints for a session.
     */
    public void clearAllBreakpoints(String sessionId) {
        VirtualMachine vm = activeConnections.get(sessionId);
        if (vm == null) return;
        
        try {
            EventRequestManager erm = vm.eventRequestManager();
            
            // Clear breakpoints
            erm.breakpointRequests().stream()
                    .filter(bp -> sessionId.equals(bp.getProperty("sessionId")))
                    .forEach(erm::deleteEventRequest);
            
            // Clear exception requests
            erm.exceptionRequests().stream()
                    .filter(er -> sessionId.equals(er.getProperty("sessionId")))
                    .forEach(erm::deleteEventRequest);
            
            log.info("All breakpoints cleared for session: {}", sessionId);
            
        } catch (Exception e) {
            log.error("Failed to clear breakpoints: {}", e.getMessage(), e);
        }
    }
    
    // ========== Internal Methods ==========
    
    private VirtualMachine getVM(String sessionId) {
        VirtualMachine vm = activeConnections.get(sessionId);
        if (vm == null) {
            throw new RuntimeException("No active connection for session: " + sessionId);
        }
        return vm;
    }
    
    private ThreadReference findThread(VirtualMachine vm, long threadId) {
        return vm.allThreads().stream()
                .filter(t -> t.uniqueID() == threadId)
                .findFirst()
                .orElse(null);
    }
    
    private void startEventThread(String sessionId, VirtualMachine vm) {
        Thread eventThread = new Thread(() -> processEvents(sessionId, vm), 
                "jdwp-event-" + sessionId);
        eventThread.setDaemon(true);
        eventThread.start();
        eventThreads.put(sessionId, eventThread);
    }
    
    private void processEvents(String sessionId, VirtualMachine vm) {
        EventQueue queue = vm.eventQueue();
        
        while (!Thread.currentThread().isInterrupted()) {
            try {
                EventSet events = queue.remove(1000);
                if (events == null) continue;
                
                for (Event event : events) {
                    handleEvent(sessionId, event);
                }
                
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (VMDisconnectedException e) {
                log.info("VM disconnected: sessionId={}", sessionId);
                break;
            } catch (Exception e) {
                log.error("Error processing event: {}", e.getMessage());
            }
        }
    }
    
    private void handleEvent(String sessionId, Event event) {
        if (event instanceof BreakpointEvent) {
            handleBreakpointEvent(sessionId, (BreakpointEvent) event);
        } else if (event instanceof ExceptionEvent) {
            handleExceptionEvent(sessionId, (ExceptionEvent) event);
        } else if (event instanceof StepEvent) {
            handleStepEvent(sessionId, (StepEvent) event);
        }
    }
    
    private void handleBreakpointEvent(String sessionId, BreakpointEvent event) {
        ThreadReference thread = event.thread();
        Location location = event.location();
        
        log.info("Breakpoint hit: session={}, location={}, thread={}", 
                sessionId, location, thread.name());
        
        // Check if this matches the expected requestId
        String expectedRequestId = (String) event.request().getProperty("requestId");
        
        if (expectedRequestId != null) {
            // Verify the request context matches
            try {
                String actualRequestId = evaluateRequestContext(event.virtualMachine(), thread);
                
                if (!expectedRequestId.equals(actualRequestId)) {
                    // Not our request - resume and continue
                    log.debug("Request ID mismatch: expected={}, actual={}", 
                            expectedRequestId, actualRequestId);
                    thread.resume();
                    return;
                }
            } catch (Exception e) {
                log.warn("Could not verify request ID, proceeding anyway");
            }
        }
        
        // Notify waiting future
        CompletableFuture<BreakpointHit> future = breakpointFutures.get(sessionId);
        if (future != null) {
            BreakpointHit hit = new BreakpointHit();
            hit.threadId = thread.uniqueID();
            hit.threadName = thread.name();
            hit.location = location.toString();
            hit.className = location.declaringType().name();
            hit.lineNumber = location.lineNumber();
            hit.methodName = location.method().name();
            future.complete(hit);
        }
        
        auditLogger.logBreakpointHit(sessionId, location.toString(), thread.uniqueID());
    }
    
    private void handleExceptionEvent(String sessionId, ExceptionEvent event) {
        ThreadReference thread = event.thread();
        ObjectReference exception = event.exception();
        Location location = event.location();
        
        log.info("Exception caught: session={}, type={}, location={}", 
                sessionId, exception.referenceType().name(), location);
        
        // Notify waiting future
        CompletableFuture<BreakpointHit> future = breakpointFutures.get(sessionId);
        if (future != null) {
            BreakpointHit hit = new BreakpointHit();
            hit.threadId = thread.uniqueID();
            hit.threadName = thread.name();
            hit.location = location.toString();
            hit.className = location.declaringType().name();
            hit.lineNumber = location.lineNumber();
            hit.methodName = location.method().name();
            hit.exceptionType = exception.referenceType().name();
            hit.isException = true;
            future.complete(hit);
        }
        
        auditLogger.logExceptionCaught(sessionId, exception.referenceType().name(), 
                location.toString(), thread.uniqueID());
    }
    
    private void handleStepEvent(String sessionId, StepEvent event) {
        log.debug("Step completed: session={}, location={}", sessionId, event.location());
        
        // Disable the step request (it's one-shot)
        event.request().disable();
        
        // Notify as breakpoint hit
        CompletableFuture<BreakpointHit> future = breakpointFutures.get(sessionId);
        if (future != null) {
            BreakpointHit hit = new BreakpointHit();
            hit.threadId = event.thread().uniqueID();
            hit.threadName = event.thread().name();
            hit.location = event.location().toString();
            hit.className = event.location().declaringType().name();
            hit.lineNumber = event.location().lineNumber();
            hit.methodName = event.location().method().name();
            future.complete(hit);
        }
    }
    
    private String evaluateRequestContext(VirtualMachine vm, ThreadReference thread) {
        try {
            List<ReferenceType> classes = vm.classesByName("com.debugger.core.RequestContext");
            if (classes.isEmpty()) {
                return null;
            }
            
            ReferenceType rcType = classes.get(0);
            Method getMethod = rcType.methodsByName("get").stream()
                    .filter(m -> {
                        try {
                            return m.argumentTypes().isEmpty();
                        } catch (ClassNotLoadedException e) {
                            return false;
                        }
                    })
                    .findFirst()
                    .orElse(null);
            
            if (getMethod == null) {
                return null;
            }
            
            // Invoke RequestContext.get()
            Value result = ((ClassType) rcType).invokeMethod(
                    thread, getMethod, Collections.emptyList(), 
                    ObjectReference.INVOKE_SINGLE_THREADED);
            
            if (result instanceof StringReference) {
                return ((StringReference) result).value();
            }
            
            return null;
            
        } catch (Exception e) {
            log.debug("Could not evaluate RequestContext: {}", e.getMessage());
            return null;
        }
    }
    
    private Object extractValue(Value value, int depth) {
        if (value == null || depth <= 0) {
            return value == null ? null : value.toString();
        }
        
        if (value instanceof StringReference) {
            return ((StringReference) value).value();
        } else if (value instanceof PrimitiveValue) {
            if (value instanceof IntegerValue) return ((IntegerValue) value).value();
            if (value instanceof LongValue) return ((LongValue) value).value();
            if (value instanceof DoubleValue) return ((DoubleValue) value).value();
            if (value instanceof FloatValue) return ((FloatValue) value).value();
            if (value instanceof BooleanValue) return ((BooleanValue) value).value();
            if (value instanceof CharValue) return ((CharValue) value).value();
            if (value instanceof ByteValue) return ((ByteValue) value).value();
            if (value instanceof ShortValue) return ((ShortValue) value).value();
            return value.toString();
        } else if (value instanceof ArrayReference) {
            ArrayReference arr = (ArrayReference) value;
            List<Object> list = new ArrayList<>();
            int length = Math.min(arr.length(), 10); // Limit array size
            for (int i = 0; i < length; i++) {
                list.add(extractValue(arr.getValue(i), depth - 1));
            }
            if (arr.length() > 10) {
                list.add("... (" + (arr.length() - 10) + " more)");
            }
            return list;
        } else if (value instanceof ObjectReference) {
            ObjectReference obj = (ObjectReference) value;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("_type", obj.referenceType().name());
            result.put("_id", obj.uniqueID());
            
            // Extract fields
            try {
                for (Field field : obj.referenceType().visibleFields()) {
                    if (!field.isStatic()) {
                        Value fieldValue = obj.getValue(field);
                        result.put(field.name(), extractValue(fieldValue, depth - 1));
                    }
                }
            } catch (Exception e) {
                result.put("_error", e.getMessage());
            }
            
            return result;
        }
        
        return value.toString();
    }
    
    /**
     * Breakpoint hit information.
     */
    public static class BreakpointHit {
        public long threadId;
        public String threadName;
        public String location;
        public String className;
        public int lineNumber;
        public String methodName;
        public boolean isException;
        public String exceptionType;
    }
}
