package com.debugger.filter;

import com.debugger.core.RequestContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * HTTP Filter that captures X-Request-Id header and stores it in RequestContext.
 * This filter must be the FIRST filter in the chain to ensure requestId is available
 * throughout the entire request lifecycle.
 * 
 * Supports multiple header formats:
 * - X-Request-Id (standard)
 * - X-Correlation-Id (alternative)
 * - traceparent (OpenTelemetry W3C format)
 * - X-B3-TraceId (Zipkin B3 format)
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@Slf4j
public class RequestIdFilter extends OncePerRequestFilter {
    
    public static final String REQUEST_ID_HEADER = "X-Request-Id";
    public static final String CORRELATION_ID_HEADER = "X-Correlation-Id";
    public static final String TRACEPARENT_HEADER = "traceparent";
    public static final String B3_TRACE_HEADER = "X-B3-TraceId";
    
    public static final String RESPONSE_HEADER = "X-Request-Id";
    
    @Override
    protected void doFilterInternal(HttpServletRequest request, 
                                    HttpServletResponse response, 
                                    FilterChain filterChain) 
            throws ServletException, IOException {
        
        try {
            // Extract or generate request ID
            String requestId = extractRequestId(request);
            
            // Extract trace ID if present (OpenTelemetry)
            String traceId = extractTraceId(request);
            
            // Set in thread-local context
            RequestContext.set(requestId);
            if (traceId != null) {
                RequestContext.setTraceId(traceId);
            }
            
            // Add to response headers for tracing
            response.setHeader(RESPONSE_HEADER, requestId);
            
            // Log request start
            log.info("Request started: method={}, uri={}, requestId={}", 
                    request.getMethod(), 
                    request.getRequestURI(), 
                    requestId);
            
            // Continue filter chain
            filterChain.doFilter(request, response);
            
            // Log request completion
            log.info("Request completed: requestId={}, status={}, elapsed={}ms", 
                    requestId, 
                    response.getStatus(),
                    RequestContext.getElapsedMs());
            
        } finally {
            // Always clear context to prevent memory leaks
            RequestContext.clear();
        }
    }
    
    /**
     * Extract request ID from various headers, or generate a new one.
     */
    private String extractRequestId(HttpServletRequest request) {
        // Try X-Request-Id first
        String requestId = request.getHeader(REQUEST_ID_HEADER);
        if (isValidId(requestId)) {
            return requestId;
        }
        
        // Try X-Correlation-Id
        requestId = request.getHeader(CORRELATION_ID_HEADER);
        if (isValidId(requestId)) {
            return requestId;
        }
        
        // Try to extract from traceparent (W3C format: version-traceid-parentid-flags)
        String traceparent = request.getHeader(TRACEPARENT_HEADER);
        if (traceparent != null && traceparent.contains("-")) {
            String[] parts = traceparent.split("-");
            if (parts.length >= 2 && isValidId(parts[1])) {
                return parts[1];
            }
        }
        
        // Try B3 trace ID
        requestId = request.getHeader(B3_TRACE_HEADER);
        if (isValidId(requestId)) {
            return requestId;
        }
        
        // Generate new UUID if no header present
        return UUID.randomUUID().toString();
    }
    
    /**
     * Extract OpenTelemetry trace ID if present.
     */
    private String extractTraceId(HttpServletRequest request) {
        String traceparent = request.getHeader(TRACEPARENT_HEADER);
        if (traceparent != null && traceparent.contains("-")) {
            String[] parts = traceparent.split("-");
            if (parts.length >= 2) {
                return parts[1];
            }
        }
        return request.getHeader(B3_TRACE_HEADER);
    }
    
    private boolean isValidId(String id) {
        return id != null && !id.trim().isEmpty();
    }
    
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Don't filter actuator endpoints
        String path = request.getRequestURI();
        return path.startsWith("/actuator") || 
               path.startsWith("/health") || 
               path.equals("/favicon.ico");
    }
}
