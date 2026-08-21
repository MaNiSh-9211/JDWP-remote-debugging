package com.debugger.controller;

import com.debugger.audit.AuditLogger;
import com.debugger.core.DebugSessionManager;
import com.debugger.jdwp.JdwpDebugger;
import com.debugger.k8s.K8sClient;
import com.debugger.model.DebugSession;
import com.debugger.model.PodInfo;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * REST API for Kubernetes-native JDWP debugging.
 * This controller exposes debugging operations for Cursor/MCP integration.
 */
@RestController
@RequestMapping("/api/debug")
@CrossOrigin(origins = "*")
@Slf4j
public class DebugController {
    
    @Autowired
    private K8sClient k8sClient;
    
    @Autowired
    private DebugSessionManager sessionManager;
    
    @Autowired
    private AuditLogger auditLogger;
    
    // ==================== Pod Discovery ====================
    
    /**
     * List pods in a namespace, optionally filtered by label.
     * 
     * Example: GET /api/debug/pods?namespace=default&label=app=my-service
     */
    @GetMapping("/pods")
    public ResponseEntity<ApiResponse<List<PodInfo>>> listPods(
            @RequestParam(defaultValue = "default") String namespace,
            @RequestParam(required = false) String label) {
        
        try {
            List<PodInfo> pods = k8sClient.listPods(namespace, label);
            return ResponseEntity.ok(ApiResponse.success(pods));
        } catch (Exception e) {
            log.error("Failed to list pods", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * List pods by service name (app label).
     */
    @GetMapping("/pods/service/{serviceName}")
    public ResponseEntity<ApiResponse<List<PodInfo>>> listPodsByService(
            @RequestParam(defaultValue = "default") String namespace,
            @PathVariable String serviceName) {
        
        try {
            List<PodInfo> pods = k8sClient.listPodsByService(namespace, serviceName);
            return ResponseEntity.ok(ApiResponse.success(pods));
        } catch (Exception e) {
            log.error("Failed to list pods for service: {}", serviceName, e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Get details for a specific pod.
     */
    @GetMapping("/pods/{podName}")
    public ResponseEntity<ApiResponse<PodInfo>> getPod(
            @RequestParam(defaultValue = "default") String namespace,
            @PathVariable String podName) {
        
        try {
            PodInfo pod = k8sClient.getPod(namespace, podName);
            return ResponseEntity.ok(ApiResponse.success(pod));
        } catch (Exception e) {
            log.error("Failed to get pod: {}", podName, e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Get pod logs.
     */
    @GetMapping("/pods/{podName}/logs")
    public ResponseEntity<ApiResponse<String>> getPodLogs(
            @RequestParam(defaultValue = "default") String namespace,
            @PathVariable String podName,
            @RequestParam(defaultValue = "100") int lines) {
        
        try {
            String logs = k8sClient.getPodLogs(namespace, podName, lines);
            return ResponseEntity.ok(ApiResponse.success(logs));
        } catch (Exception e) {
            log.error("Failed to get logs for pod: {}", podName, e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    // ==================== Session Management ====================
    
    /**
     * Create a new debug session.
     * This establishes port-forward and JDWP connection.
     */
    @PostMapping("/sessions")
    public ResponseEntity<ApiResponse<DebugSession>> createSession(
            @RequestBody CreateSessionRequest request) {
        
        log.info("Create session request: {}", request);
        
        try {
            // Generate request ID if not provided
            String requestId = request.getRequestId();
            if (requestId == null || requestId.isEmpty()) {
                requestId = sessionManager.generateRequestId();
            }
            
            DebugSession session = sessionManager.createSession(
                    request.getNamespace(),
                    request.getPodName(),
                    requestId,
                    request.getCreatedBy() != null ? request.getCreatedBy() : "api"
            );
            
            return ResponseEntity.ok(ApiResponse.success(session));
            
        } catch (Exception e) {
            log.error("Failed to create session", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Get session details.
     */
    @GetMapping("/sessions/{sessionId}")
    public ResponseEntity<ApiResponse<DebugSession>> getSession(
            @PathVariable String sessionId) {
        
        try {
            DebugSession session = sessionManager.getSession(sessionId);
            return ResponseEntity.ok(ApiResponse.success(session));
        } catch (Exception e) {
            log.error("Failed to get session: {}", sessionId, e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * List all active sessions.
     */
    @GetMapping("/sessions")
    public ResponseEntity<ApiResponse<List<DebugSession>>> listSessions() {
        try {
            List<DebugSession> sessions = sessionManager.getActiveSessions();
            return ResponseEntity.ok(ApiResponse.success(sessions));
        } catch (Exception e) {
            log.error("Failed to list sessions", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Close a debug session.
     */
    @DeleteMapping("/sessions/{sessionId}")
    public ResponseEntity<ApiResponse<Void>> closeSession(
            @PathVariable String sessionId) {
        
        try {
            sessionManager.closeSession(sessionId);
            return ResponseEntity.ok(ApiResponse.success(null));
        } catch (Exception e) {
            log.error("Failed to close session: {}", sessionId, e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    // ==================== Breakpoints ====================
    
    /**
     * Set a conditional breakpoint.
     * The breakpoint will only trigger for requests matching the session's requestId.
     */
    @PostMapping("/sessions/{sessionId}/breakpoints")
    public ResponseEntity<ApiResponse<Void>> setBreakpoint(
            @PathVariable String sessionId,
            @RequestBody SetBreakpointRequest request) {
        
        log.info("Set breakpoint: sessionId={}, class={}, line={}", 
                sessionId, request.getClassName(), request.getLineNumber());
        
        try {
            sessionManager.setBreakpoint(sessionId, request.getClassName(), request.getLineNumber());
            return ResponseEntity.ok(ApiResponse.success(null));
        } catch (Exception e) {
            log.error("Failed to set breakpoint", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Set an exception breakpoint.
     */
    @PostMapping("/sessions/{sessionId}/breakpoints/exception")
    public ResponseEntity<ApiResponse<Void>> setExceptionBreakpoint(
            @PathVariable String sessionId,
            @RequestBody SetExceptionBreakpointRequest request) {
        
        log.info("Set exception breakpoint: sessionId={}, exception={}", 
                sessionId, request.getExceptionClass());
        
        try {
            sessionManager.setExceptionBreakpoint(
                    sessionId, 
                    request.getExceptionClass(),
                    request.isCaught(),
                    request.isUncaught()
            );
            return ResponseEntity.ok(ApiResponse.success(null));
        } catch (Exception e) {
            log.error("Failed to set exception breakpoint", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Wait for a breakpoint to hit.
     */
    @PostMapping("/sessions/{sessionId}/breakpoints/wait")
    public ResponseEntity<ApiResponse<JdwpDebugger.BreakpointHit>> waitForBreakpoint(
            @PathVariable String sessionId,
            @RequestParam(defaultValue = "30000") int timeoutMs) {
        
        log.info("Wait for breakpoint: sessionId={}, timeout={}ms", sessionId, timeoutMs);
        
        try {
            JdwpDebugger.BreakpointHit hit = sessionManager.waitForBreakpoint(sessionId, timeoutMs);
            if (hit != null) {
                return ResponseEntity.ok(ApiResponse.success(hit));
            } else {
                return ResponseEntity.ok(ApiResponse.error("Timeout waiting for breakpoint"));
            }
        } catch (Exception e) {
            log.error("Error waiting for breakpoint", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    // ==================== Debug Operations ====================
    
    /**
     * Get variables from the current stack frame.
     */
    @GetMapping("/sessions/{sessionId}/variables")
    public ResponseEntity<ApiResponse<Map<String, Object>>> getVariables(
            @PathVariable String sessionId) {
        
        try {
            Map<String, Object> variables = sessionManager.getVariables(sessionId);
            return ResponseEntity.ok(ApiResponse.success(variables));
        } catch (Exception e) {
            log.error("Failed to get variables", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Get the call stack.
     */
    @GetMapping("/sessions/{sessionId}/stack")
    public ResponseEntity<ApiResponse<List<Map<String, Object>>>> getStackTrace(
            @PathVariable String sessionId) {
        
        try {
            List<Map<String, Object>> stack = sessionManager.getStackTrace(sessionId);
            return ResponseEntity.ok(ApiResponse.success(stack));
        } catch (Exception e) {
            log.error("Failed to get stack trace", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Step over to the next line.
     */
    @PostMapping("/sessions/{sessionId}/step-over")
    public ResponseEntity<ApiResponse<Void>> stepOver(
            @PathVariable String sessionId) {
        
        try {
            sessionManager.stepOver(sessionId);
            return ResponseEntity.ok(ApiResponse.success(null));
        } catch (Exception e) {
            log.error("Failed to step over", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Resume the suspended thread.
     */
    @PostMapping("/sessions/{sessionId}/resume")
    public ResponseEntity<ApiResponse<Void>> resumeThread(
            @PathVariable String sessionId) {
        
        try {
            sessionManager.resumeThread(sessionId);
            return ResponseEntity.ok(ApiResponse.success(null));
        } catch (Exception e) {
            log.error("Failed to resume thread", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    // ==================== Audit ====================
    
    /**
     * Get audit log for a session.
     */
    @GetMapping("/sessions/{sessionId}/audit")
    public ResponseEntity<ApiResponse<List<AuditLogger.AuditEntry>>> getSessionAudit(
            @PathVariable String sessionId) {
        
        try {
            List<AuditLogger.AuditEntry> entries = auditLogger.getSessionAuditLog(sessionId);
            return ResponseEntity.ok(ApiResponse.success(entries));
        } catch (Exception e) {
            log.error("Failed to get audit log", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    /**
     * Get recent audit entries.
     */
    @GetMapping("/audit")
    public ResponseEntity<ApiResponse<List<AuditLogger.AuditEntry>>> getRecentAudit(
            @RequestParam(defaultValue = "100") int limit) {
        
        try {
            List<AuditLogger.AuditEntry> entries = auditLogger.getRecentAuditLog(limit);
            return ResponseEntity.ok(ApiResponse.success(entries));
        } catch (Exception e) {
            log.error("Failed to get audit log", e);
            return ResponseEntity.internalServerError()
                    .body(ApiResponse.error(e.getMessage()));
        }
    }
    
    // ==================== Health Check ====================
    
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> health = new HashMap<>();
        health.put("status", "UP");
        health.put("activeSessions", sessionManager.getActiveSessions().size());
        health.put("activePortForwards", k8sClient.getActivePortForwards().size());
        return ResponseEntity.ok(health);
    }
    
    // ==================== Request/Response DTOs ====================
    
    @Data
    public static class CreateSessionRequest {
        private String namespace = "default";
        private String podName;
        private String requestId;
        private String createdBy;
    }
    
    @Data
    public static class SetBreakpointRequest {
        private String className;
        private int lineNumber;
    }
    
    @Data
    public static class SetExceptionBreakpointRequest {
        private String exceptionClass;
        private boolean caught = true;
        private boolean uncaught = true;
    }
    
    @Data
    public static class ApiResponse<T> {
        private boolean success;
        private T data;
        private String error;
        
        public static <T> ApiResponse<T> success(T data) {
            ApiResponse<T> response = new ApiResponse<>();
            response.setSuccess(true);
            response.setData(data);
            return response;
        }
        
        public static <T> ApiResponse<T> error(String message) {
            ApiResponse<T> response = new ApiResponse<>();
            response.setSuccess(false);
            response.setError(message);
            return response;
        }
    }
}
