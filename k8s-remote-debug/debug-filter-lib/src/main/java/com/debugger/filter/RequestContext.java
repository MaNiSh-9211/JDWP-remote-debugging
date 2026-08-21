package com.debugger.filter;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Thread-local storage for request debugging context.
 * This allows the JDWP debugger to identify which thread is handling
 * the debug request and only suspend that specific thread.
 */
public final class RequestContext {
    
    private static final ThreadLocal<DebugContext> CONTEXT = new ThreadLocal<>();
    
    // Global registry of active debug sessions (request ID -> debug info)
    private static final Map<String, DebugSession> ACTIVE_SESSIONS = new ConcurrentHashMap<>();
    
    private RequestContext() {
        // Utility class
    }
    
    /**
     * Set the request ID for the current thread.
     */
    public static void set(String requestId) {
        set(requestId, false);
    }
    
    /**
     * Set the request ID and debug flag for the current thread.
     * @param requestId The unique request identifier
     * @param isDebugRequest Whether this request should be debugged
     */
    public static void set(String requestId, boolean isDebugRequest) {
        CONTEXT.set(new DebugContext(requestId, isDebugRequest));
    }
    
    /**
     * Get the current request ID for this thread.
     * @return The request ID or null if not set
     */
    public static String get() {
        DebugContext ctx = CONTEXT.get();
        return ctx != null ? ctx.requestId : null;
    }
    
    /**
     * Check if the current request is marked for debugging.
     * @return true if this is a debug request
     */
    public static boolean isDebugRequest() {
        DebugContext ctx = CONTEXT.get();
        return ctx != null && ctx.isDebugRequest;
    }
    
    /**
     * Get the full debug context for the current thread.
     * This method is called by JDWP to evaluate conditional breakpoints.
     * @return The debug context or null
     */
    public static DebugContext getContext() {
        return CONTEXT.get();
    }
    
    /**
     * Clear the context for the current thread.
     * Should be called in a finally block after request processing.
     */
    public static void clear() {
        CONTEXT.remove();
    }
    
    /**
     * Register a debug session. Called when debugging starts.
     */
    public static void registerDebugSession(String requestId, String sessionId) {
        ACTIVE_SESSIONS.put(requestId, new DebugSession(requestId, sessionId, System.currentTimeMillis()));
    }
    
    /**
     * Unregister a debug session. Called when debugging ends.
     */
    public static void unregisterDebugSession(String requestId) {
        ACTIVE_SESSIONS.remove(requestId);
    }
    
    /**
     * Check if a request ID has an active debug session.
     */
    public static boolean hasActiveDebugSession(String requestId) {
        return ACTIVE_SESSIONS.containsKey(requestId);
    }
    
    /**
     * Get all active debug sessions.
     */
    public static Map<String, DebugSession> getActiveSessions() {
        return Map.copyOf(ACTIVE_SESSIONS);
    }
    
    /**
     * Evaluate if the current thread should be suspended.
     * This is the key method called by JDWP conditional breakpoints.
     * 
     * @param targetRequestId The request ID we want to debug
     * @return true if the current thread matches the target request
     */
    public static boolean shouldSuspend(String targetRequestId) {
        if (targetRequestId == null) {
            return false;
        }
        String currentRequestId = get();
        return targetRequestId.equals(currentRequestId);
    }
    
    /**
     * DEBUG PAUSE POINT - Set JDWP breakpoints HERE for selective debugging!
     * 
     * This method is called ONLY for requests with X-Debug-Request-Id header.
     * Normal requests NEVER call this method, so they are NEVER paused.
     * 
     * To debug a specific request:
     * 1. Set a breakpoint at line X in this method (the "// BREAKPOINT HERE" line)
     * 2. Send your request with: X-Debug-Request-Id: your-unique-id
     * 3. Only YOUR request will pause here - all other traffic continues normally!
     * 
     * @param requestId The debug request ID (visible in debugger variables)
     * @param threadName The thread handling this request
     */
    public static void debugPausePoint(String requestId, String threadName) {
        // =====================================================
        // BREAKPOINT HERE - Only debug requests reach this point!
        // Variables visible: requestId, threadName
        // =====================================================
        if (requestId != null) {
            // This line exists so there's executable code to break on
            System.out.println("[DEBUG] Request " + requestId + " paused on thread " + threadName);
        }
    }
    
    /**
     * Debug context holder for a single request.
     */
    public static class DebugContext {
        public final String requestId;
        public final boolean isDebugRequest;
        public final long timestamp;
        public final String threadName;
        
        public DebugContext(String requestId, boolean isDebugRequest) {
            this.requestId = requestId;
            this.isDebugRequest = isDebugRequest;
            this.timestamp = System.currentTimeMillis();
            this.threadName = Thread.currentThread().getName();
        }
        
        @Override
        public String toString() {
            return "DebugContext{" +
                    "requestId='" + requestId + '\'' +
                    ", isDebugRequest=" + isDebugRequest +
                    ", threadName='" + threadName + '\'' +
                    '}';
        }
    }
    
    /**
     * Debug session information.
     */
    public static class DebugSession {
        public final String requestId;
        public final String sessionId;
        public final long startTime;
        
        public DebugSession(String requestId, String sessionId, long startTime) {
            this.requestId = requestId;
            this.sessionId = sessionId;
            this.startTime = startTime;
        }
    }
}
