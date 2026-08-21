package com.debugger.filter;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * REST endpoints for debug session management.
 * These endpoints are used by the MCP server to manage debug sessions
 * and verify the filter is working correctly.
 */
@RestController
@RequestMapping("/api/debug")
public class DebugEndpointController {
    
    /**
     * Health check endpoint for debug filter.
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> response = new HashMap<>();
        response.put("status", "UP");
        response.put("filter", "DebugRequestFilter");
        response.put("timestamp", System.currentTimeMillis());
        return ResponseEntity.ok(response);
    }
    
    /**
     * Get current debug context for this thread.
     * Useful for verifying the filter is working.
     */
    @GetMapping("/context")
    public ResponseEntity<Map<String, Object>> getContext() {
        Map<String, Object> response = new HashMap<>();
        
        RequestContext.DebugContext ctx = RequestContext.getContext();
        if (ctx != null) {
            response.put("requestId", ctx.requestId);
            response.put("isDebugRequest", ctx.isDebugRequest);
            response.put("threadName", ctx.threadName);
            response.put("timestamp", ctx.timestamp);
        } else {
            response.put("requestId", null);
            response.put("isDebugRequest", false);
            response.put("message", "No context set");
        }
        
        return ResponseEntity.ok(response);
    }
    
    /**
     * Register a debug session.
     */
    @PostMapping("/session/register")
    public ResponseEntity<Map<String, Object>> registerSession(
            @RequestParam String requestId,
            @RequestParam String sessionId) {
        
        RequestContext.registerDebugSession(requestId, sessionId);
        
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("requestId", requestId);
        response.put("sessionId", sessionId);
        response.put("message", "Debug session registered");
        
        return ResponseEntity.ok(response);
    }
    
    /**
     * Unregister a debug session.
     */
    @PostMapping("/session/unregister")
    public ResponseEntity<Map<String, Object>> unregisterSession(
            @RequestParam String requestId) {
        
        RequestContext.unregisterDebugSession(requestId);
        
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("requestId", requestId);
        response.put("message", "Debug session unregistered");
        
        return ResponseEntity.ok(response);
    }
    
    /**
     * List all active debug sessions.
     */
    @GetMapping("/sessions")
    public ResponseEntity<Map<String, Object>> listSessions() {
        Map<String, Object> response = new HashMap<>();
        response.put("sessions", RequestContext.getActiveSessions());
        response.put("count", RequestContext.getActiveSessions().size());
        
        return ResponseEntity.ok(response);
    }
    
    /**
     * Check if a specific request ID has an active debug session.
     */
    @GetMapping("/session/check")
    public ResponseEntity<Map<String, Object>> checkSession(
            @RequestParam String requestId) {
        
        Map<String, Object> response = new HashMap<>();
        response.put("requestId", requestId);
        response.put("hasActiveSession", RequestContext.hasActiveDebugSession(requestId));
        
        return ResponseEntity.ok(response);
    }
    
    /**
     * Test endpoint that can be used to verify breakpoint suspension.
     * This endpoint intentionally has multiple steps for debugging.
     */
    @GetMapping("/test")
    public ResponseEntity<Map<String, Object>> testEndpoint(
            @RequestParam(required = false, defaultValue = "test") String param) {
        
        Map<String, Object> response = new HashMap<>();
        
        // Step 1: Get request context
        String requestId = RequestContext.get();
        response.put("step1_requestId", requestId);
        
        // Step 2: Check if debug request
        boolean isDebug = RequestContext.isDebugRequest();
        response.put("step2_isDebugRequest", isDebug);
        
        // Step 3: Process parameter
        String processed = processParameter(param);
        response.put("step3_processedParam", processed);
        
        // Step 4: Build result
        String result = buildResult(requestId, processed);
        response.put("step4_result", result);
        
        response.put("success", true);
        response.put("threadName", Thread.currentThread().getName());
        
        return ResponseEntity.ok(response);
    }
    
    private String processParameter(String param) {
        // Simple processing - good breakpoint target
        return param.toUpperCase() + "_PROCESSED";
    }
    
    private String buildResult(String requestId, String processed) {
        // Build result - another good breakpoint target
        return String.format("Result for %s: %s", requestId, processed);
    }
}
