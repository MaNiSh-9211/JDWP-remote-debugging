package com.debugger.filter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * HTTP filter that extracts or generates a request ID and stores it in RequestContext.
 * This filter MUST have the highest precedence to ensure the request ID is available
 * before any application code executes.
 * 
 * The filter looks for request IDs in the following order:
 * 1. X-Debug-Request-Id header (for explicit debug requests)
 * 2. X-Request-Id header (standard request tracing)
 * 3. Generate a new UUID if none provided
 * 
 * For debugging to work:
 * 1. Send request with X-Debug-Request-Id header
 * 2. The MCP server uses this ID to set conditional breakpoints
 * 3. Only the thread handling this specific request will be suspended
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class DebugRequestFilter extends OncePerRequestFilter {
    
    private static final Logger log = LoggerFactory.getLogger(DebugRequestFilter.class);
    
    public static final String DEBUG_REQUEST_ID_HEADER = "X-Debug-Request-Id";
    public static final String REQUEST_ID_HEADER = "X-Request-Id";
    public static final String DEBUG_SESSION_HEADER = "X-Debug-Session-Id";
    
    // Response headers to echo back debug info
    public static final String RESPONSE_REQUEST_ID_HEADER = "X-Request-Id";
    public static final String RESPONSE_DEBUG_ACTIVE_HEADER = "X-Debug-Active";
    
    @Override
    protected void doFilterInternal(HttpServletRequest request, 
                                    HttpServletResponse response, 
                                    FilterChain filterChain) throws ServletException, IOException {
        
        String requestId = null;
        boolean isDebugRequest = false;
        
        // Check for explicit debug request ID first
        String debugRequestId = request.getHeader(DEBUG_REQUEST_ID_HEADER);
        if (debugRequestId != null && !debugRequestId.isBlank()) {
            requestId = debugRequestId;
            isDebugRequest = true;
            log.debug("Debug request received with ID: {}", requestId);
        }
        
        // Fall back to standard request ID header
        if (requestId == null) {
            requestId = request.getHeader(REQUEST_ID_HEADER);
        }
        
        // Generate UUID if no ID provided
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
        }
        
        // Check if there's an active debug session for this request ID
        if (!isDebugRequest && RequestContext.hasActiveDebugSession(requestId)) {
            isDebugRequest = true;
        }
        
        // Store in thread-local context
        RequestContext.set(requestId, isDebugRequest);
        
        // Add response headers
        response.setHeader(RESPONSE_REQUEST_ID_HEADER, requestId);
        if (isDebugRequest) {
            response.setHeader(RESPONSE_DEBUG_ACTIVE_HEADER, "true");
        }
        
        try {
            // Log for debug sessions
            if (isDebugRequest) {
                log.info("DEBUG REQUEST START: {} {} [requestId={}]", 
                        request.getMethod(), 
                        request.getRequestURI(), 
                        requestId);
                
                // ========================================================
                // SELECTIVE DEBUG PAUSE POINT
                // Set a JDWP breakpoint on this method to debug ONLY this request!
                // Other requests (without debug header) NEVER call this method.
                // ========================================================
                RequestContext.debugPausePoint(requestId, Thread.currentThread().getName());
            }
            
            // Continue with the filter chain
            filterChain.doFilter(request, response);
            
            if (isDebugRequest) {
                log.info("DEBUG REQUEST END: {} {} [requestId={}, status={}]", 
                        request.getMethod(), 
                        request.getRequestURI(), 
                        requestId,
                        response.getStatus());
            }
            
        } finally {
            // Always clear the context to prevent memory leaks
            RequestContext.clear();
        }
    }
    
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Skip static resources and health checks
        String path = request.getRequestURI();
        return path.startsWith("/actuator/health") ||
               path.startsWith("/favicon.ico") ||
               path.endsWith(".css") ||
               path.endsWith(".js") ||
               path.endsWith(".png") ||
               path.endsWith(".jpg") ||
               path.endsWith(".ico");
    }
}
