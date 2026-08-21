package com.debugger.agent;

/**
 * Thread-local context for debug requests.
 * 
 * This class provides the DEBUG PAUSE POINT where you set JDWP breakpoints.
 * Only requests with X-Debug-Request-Id header will reach the pause point.
 * Normal requests NEVER call debugPausePoint() - they are NEVER paused!
 */
public class DebugContext {
    
    // ThreadLocal storage for request ID per thread
    private static final ThreadLocal<RequestInfo> CONTEXT = new ThreadLocal<>();
    
    /**
     * Store debug request info for current thread
     */
    public static void set(String requestId, String threadName) {
        CONTEXT.set(new RequestInfo(requestId, threadName, System.currentTimeMillis()));
    }
    
    /**
     * Get current request ID (or null if not a debug request)
     */
    public static String getRequestId() {
        RequestInfo info = CONTEXT.get();
        return info != null ? info.requestId : null;
    }
    
    /**
     * Check if current thread is handling a debug request
     */
    public static boolean isDebugRequest() {
        return CONTEXT.get() != null;
    }
    
    /**
     * Clear context (call after request completes)
     */
    public static void clear() {
        CONTEXT.remove();
    }
    
    /**
     * ══════════════════════════════════════════════════════════════════════
     * ║                    DEBUG PAUSE POINT                               ║
     * ║                                                                    ║
     * ║  SET YOUR JDWP BREAKPOINT HERE!                                    ║
     * ║                                                                    ║
     * ║  Class: com.debugger.agent.DebugContext                            ║
     * ║  Line:  (the System.out.println line below)                        ║
     * ║                                                                    ║
     * ║  Only requests with X-Debug-Request-Id header reach this method.  ║
     * ║  Normal requests NEVER call this - they continue unaffected!      ║
     * ══════════════════════════════════════════════════════════════════════
     * 
     * @param requestId  The debug request ID (from X-Debug-Request-Id header)
     * @param method     HTTP method (GET, POST, etc.)
     * @param uri        Request URI path
     * @param threadName Thread handling this request
     */
    public static void debugPausePoint(String requestId, String method, String uri, String threadName) {
        // ═══════════════════════════════════════════════════════════════════
        // SET JDWP BREAKPOINT ON THE LINE BELOW!
        // Variables available: requestId, method, uri, threadName
        // ═══════════════════════════════════════════════════════════════════
        System.out.println("[DEBUG-AGENT] ▶ Debug request: " + method + " " + uri + " [" + requestId + "] on " + threadName);
    }
    
    /**
     * Request information holder
     */
    public static class RequestInfo {
        public final String requestId;
        public final String threadName;
        public final long timestamp;
        
        public RequestInfo(String requestId, String threadName, long timestamp) {
            this.requestId = requestId;
            this.threadName = threadName;
            this.timestamp = timestamp;
        }
    }
}
