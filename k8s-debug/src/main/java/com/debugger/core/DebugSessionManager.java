package com.debugger.core;

import com.debugger.audit.AuditLogger;
import com.debugger.jdwp.JdwpDebugger;
import com.debugger.k8s.K8sClient;
import com.debugger.model.DebugSession;
import com.debugger.model.PodInfo;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages debug sessions lifecycle.
 * Enforces production safety rules:
 * - One debugger per pod
 * - Session timeouts
 * - Thread-only suspension
 * - Full audit trail
 */
@Service
@Slf4j
public class DebugSessionManager {
    
    @Value("${debug.session.timeout-seconds:300}")
    private int sessionTimeoutSeconds;
    
    @Value("${debug.max-sessions:10}")
    private int maxActiveSessions;
    
    @Autowired
    private K8sClient k8sClient;
    
    @Autowired
    private JdwpDebugger jdwpDebugger;
    
    @Autowired
    private AuditLogger auditLogger;
    
    // Active sessions
    private final Map<String, DebugSession> activeSessions = new ConcurrentHashMap<>();
    
    // Track which pods are being debugged (one debugger per pod rule)
    private final Set<String> debuggedPods = ConcurrentHashMap.newKeySet();
    
    /**
     * Create a new debug session.
     * 
     * @param namespace Kubernetes namespace
     * @param podName Target pod name
     * @param requestId The request ID to debug
     * @param createdBy Who is creating this session (user/AI identifier)
     * @return Created debug session
     */
    public DebugSession createSession(String namespace, String podName, 
                                       String requestId, String createdBy) {
        log.info("Creating debug session: namespace={}, pod={}, requestId={}, createdBy={}", 
                namespace, podName, requestId, createdBy);
        
        // Validate request
        if (requestId == null || requestId.isEmpty()) {
            throw new IllegalArgumentException("requestId is required for conditional debugging");
        }
        
        // Check max sessions
        if (activeSessions.size() >= maxActiveSessions) {
            throw new RuntimeException("Maximum active sessions reached: " + maxActiveSessions);
        }
        
        // Check if pod is already being debugged
        String podKey = namespace + "/" + podName;
        if (debuggedPods.contains(podKey)) {
            throw new RuntimeException("Pod is already being debugged: " + podKey);
        }
        
        // Get pod info
        PodInfo pod = k8sClient.getPod(namespace, podName);
        if (!pod.isDebuggable()) {
            throw new RuntimeException("Pod is not debuggable: " + pod.getPhase() + 
                    ", ready=" + pod.isReady());
        }
        
        // Create session
        DebugSession session = DebugSession.create(pod, requestId, createdBy);
        session.setTimeoutSeconds(sessionTimeoutSeconds);
        
        try {
            // Start port-forward
            session.setState(DebugSession.State.CONNECTING);
            int localPort = k8sClient.startPortForward(namespace, podName, pod.getJdwpPort());
            session.setLocalPort(localPort);
            
            auditLogger.logPortForward(session.getSessionId(), namespace, podName, localPort);
            
            // Connect JDWP
            jdwpDebugger.connect(session.getSessionId(), "localhost", localPort);
            
            session.setState(DebugSession.State.CONNECTED);
            session.setConnectedAt(Instant.now());
            
            // Track session
            activeSessions.put(session.getSessionId(), session);
            debuggedPods.add(podKey);
            
            auditLogger.logSessionStart(session.getSessionId(), podName, requestId, createdBy);
            
            log.info("Debug session created: sessionId={}, localPort={}", 
                    session.getSessionId(), localPort);
            
            return session;
            
        } catch (Exception e) {
            // Cleanup on failure
            session.setState(DebugSession.State.ERROR);
            session.setErrorMessage(e.getMessage());
            
            k8sClient.stopPortForward(namespace, podName);
            
            auditLogger.logError(session.getSessionId(), "SESSION_CREATE", e.getMessage());
            
            throw new RuntimeException("Failed to create debug session: " + e.getMessage(), e);
        }
    }
    
    /**
     * Set a conditional breakpoint in an active session.
     */
    public void setBreakpoint(String sessionId, String className, int lineNumber) {
        DebugSession session = getSession(sessionId);
        
        if (session.getState() != DebugSession.State.CONNECTED && 
            session.getState() != DebugSession.State.DEBUGGING) {
            throw new RuntimeException("Session not ready for breakpoints: " + session.getState());
        }
        
        // Set conditional breakpoint using session's requestId
        jdwpDebugger.setConditionalBreakpoint(
                sessionId, className, lineNumber, session.getRequestId());
        
        // Track breakpoint
        session.addBreakpoint(DebugSession.BreakpointInfo.builder()
                .className(className)
                .lineNumber(lineNumber)
                .condition("RequestContext.get().equals(\"" + session.getRequestId() + "\")")
                .enabled(true)
                .createdAt(Instant.now())
                .build());
    }
    
    /**
     * Set an exception breakpoint.
     */
    public void setExceptionBreakpoint(String sessionId, String exceptionClass, 
                                        boolean caught, boolean uncaught) {
        DebugSession session = getSession(sessionId);
        
        jdwpDebugger.setExceptionBreakpoint(
                sessionId, exceptionClass, caught, uncaught, session.getRequestId());
    }
    
    /**
     * Wait for a breakpoint to hit.
     */
    public JdwpDebugger.BreakpointHit waitForBreakpoint(String sessionId, int timeoutMs) {
        DebugSession session = getSession(sessionId);
        
        JdwpDebugger.BreakpointHit hit = jdwpDebugger.waitForBreakpoint(
                sessionId, timeoutMs > 0 ? timeoutMs : sessionTimeoutSeconds * 1000);
        
        if (hit != null) {
            session.setState(DebugSession.State.DEBUGGING);
            session.setSuspendedThreadId(hit.threadId);
            session.setSuspendedThreadName(hit.threadName);
            session.setSuspendedLocation(hit.location);
        }
        
        return hit;
    }
    
    /**
     * Get variables from a suspended thread.
     */
    public Map<String, Object> getVariables(String sessionId) {
        DebugSession session = getSession(sessionId);
        
        if (session.getSuspendedThreadId() == null) {
            throw new RuntimeException("No thread is suspended");
        }
        
        return jdwpDebugger.getVariables(sessionId, session.getSuspendedThreadId());
    }
    
    /**
     * Get stack trace from a suspended thread.
     */
    public List<Map<String, Object>> getStackTrace(String sessionId) {
        DebugSession session = getSession(sessionId);
        
        if (session.getSuspendedThreadId() == null) {
            throw new RuntimeException("No thread is suspended");
        }
        
        return jdwpDebugger.getStackTrace(sessionId, session.getSuspendedThreadId());
    }
    
    /**
     * Step over to next line.
     */
    public void stepOver(String sessionId) {
        DebugSession session = getSession(sessionId);
        
        if (session.getSuspendedThreadId() == null) {
            throw new RuntimeException("No thread is suspended");
        }
        
        jdwpDebugger.stepOver(sessionId, session.getSuspendedThreadId());
    }
    
    /**
     * Resume the suspended thread.
     */
    public void resumeThread(String sessionId) {
        DebugSession session = getSession(sessionId);
        
        if (session.getSuspendedThreadId() != null) {
            jdwpDebugger.resumeThread(sessionId, session.getSuspendedThreadId());
            session.setSuspendedThreadId(null);
            session.setSuspendedThreadName(null);
            session.setSuspendedLocation(null);
            session.setState(DebugSession.State.CONNECTED);
        }
    }
    
    /**
     * Close a debug session.
     */
    public void closeSession(String sessionId) {
        DebugSession session = activeSessions.remove(sessionId);
        if (session == null) {
            log.warn("Session not found: {}", sessionId);
            return;
        }
        
        log.info("Closing debug session: sessionId={}", sessionId);
        
        session.setState(DebugSession.State.CLOSING);
        
        try {
            // Clear breakpoints
            jdwpDebugger.clearAllBreakpoints(sessionId);
            
            // Disconnect JDWP
            jdwpDebugger.disconnect(sessionId);
            
            // Stop port-forward
            PodInfo pod = session.getTargetPod();
            k8sClient.stopPortForward(pod.getNamespace(), pod.getName());
            
            // Remove from debugged pods
            debuggedPods.remove(pod.getNamespace() + "/" + pod.getName());
            
            session.setState(DebugSession.State.CLOSED);
            session.setClosedAt(Instant.now());
            
            auditLogger.logSessionEnd(sessionId, session.getDurationSeconds());
            
            log.info("Debug session closed: sessionId={}, duration={}s", 
                    sessionId, session.getDurationSeconds());
            
        } catch (Exception e) {
            log.error("Error closing session: {}", e.getMessage(), e);
            auditLogger.logError(sessionId, "SESSION_CLOSE", e.getMessage());
        }
    }
    
    /**
     * Get an active session.
     */
    public DebugSession getSession(String sessionId) {
        DebugSession session = activeSessions.get(sessionId);
        if (session == null) {
            throw new RuntimeException("Session not found: " + sessionId);
        }
        return session;
    }
    
    /**
     * Get all active sessions.
     */
    public List<DebugSession> getActiveSessions() {
        return new ArrayList<>(activeSessions.values());
    }
    
    /**
     * Check if a pod is being debugged.
     */
    public boolean isPodBeingDebugged(String namespace, String podName) {
        return debuggedPods.contains(namespace + "/" + podName);
    }
    
    /**
     * Scheduled task to cleanup timed-out sessions.
     */
    @Scheduled(fixedRate = 30000) // Every 30 seconds
    public void cleanupTimedOutSessions() {
        List<String> timedOut = new ArrayList<>();
        
        for (DebugSession session : activeSessions.values()) {
            if (session.isTimedOut()) {
                log.warn("Session timed out: sessionId={}, duration={}s", 
                        session.getSessionId(), session.getDurationSeconds());
                timedOut.add(session.getSessionId());
            }
        }
        
        timedOut.forEach(this::closeSession);
    }
    
    /**
     * Cleanup all sessions on shutdown.
     */
    @PreDestroy
    public void cleanup() {
        log.info("Cleaning up all debug sessions...");
        List<String> sessionIds = new ArrayList<>(activeSessions.keySet());
        sessionIds.forEach(this::closeSession);
    }
    
    /**
     * Generate a unique request ID for debugging.
     */
    public String generateRequestId() {
        return "debug-" + UUID.randomUUID().toString();
    }
}
