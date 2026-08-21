package com.debugger.core;

import lombok.extern.slf4j.Slf4j;

/**
 * Thread-local storage for request context.
 * This makes the requestId visible to JDWP conditional breakpoints.
 * 
 * Usage in conditional breakpoint:
 *   com.debugger.core.RequestContext.get().equals("target-request-id")
 */
@Slf4j
public class RequestContext {
    
    private static final ThreadLocal<String> REQUEST_ID = new ThreadLocal<>();
    private static final ThreadLocal<String> TRACE_ID = new ThreadLocal<>();
    private static final ThreadLocal<Long> START_TIME = new ThreadLocal<>();
    
    /**
     * Set the request ID for the current thread.
     * Called by RequestIdFilter at the start of each request.
     */
    public static void set(String requestId) {
        REQUEST_ID.set(requestId);
        START_TIME.set(System.currentTimeMillis());
        log.debug("RequestContext set: requestId={}", requestId);
    }
    
    /**
     * Get the request ID for the current thread.
     * This method is called by JDWP conditional breakpoints.
     */
    public static String get() {
        String id = REQUEST_ID.get();
        return id != null ? id : "";
    }
    
    /**
     * Set OpenTelemetry trace ID (optional, for distributed tracing).
     */
    public static void setTraceId(String traceId) {
        TRACE_ID.set(traceId);
    }
    
    /**
     * Get the trace ID for the current thread.
     */
    public static String getTraceId() {
        String id = TRACE_ID.get();
        return id != null ? id : "";
    }
    
    /**
     * Get elapsed time since request started.
     */
    public static long getElapsedMs() {
        Long start = START_TIME.get();
        return start != null ? System.currentTimeMillis() - start : 0;
    }
    
    /**
     * Clear all context for the current thread.
     * Called by RequestIdFilter at the end of each request.
     */
    public static void clear() {
        String requestId = REQUEST_ID.get();
        REQUEST_ID.remove();
        TRACE_ID.remove();
        START_TIME.remove();
        log.debug("RequestContext cleared: requestId={}", requestId);
    }
    
    /**
     * Check if current thread has a request context.
     */
    public static boolean isPresent() {
        return REQUEST_ID.get() != null;
    }
    
    /**
     * Check if current request matches a specific request ID.
     * Convenience method for conditional breakpoints.
     */
    public static boolean matches(String targetRequestId) {
        String current = get();
        return current != null && current.equals(targetRequestId);
    }
}
