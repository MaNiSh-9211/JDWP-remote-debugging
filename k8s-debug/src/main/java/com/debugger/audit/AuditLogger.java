package com.debugger.audit;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Audit logger for all debugging operations.
 * Critical for production safety - tracks who debugged what and when.
 */
@Component
@Slf4j
public class AuditLogger {
    
    // Store audit entries (in production, this should go to a database/log aggregator)
    private final List<AuditEntry> auditLog = Collections.synchronizedList(new ArrayList<>());
    private final Map<String, List<AuditEntry>> sessionAuditLog = new ConcurrentHashMap<>();
    
    public void logConnection(String sessionId, String host, int port, boolean success) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("CONNECT")
                .details(String.format("host=%s, port=%d, success=%s", host, port, success))
                .success(success)
                .build();
        addEntry(entry);
        log.info("AUDIT [CONNECT] sessionId={}, host={}, port={}, success={}", 
                sessionId, host, port, success);
    }
    
    public void logDisconnection(String sessionId) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("DISCONNECT")
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [DISCONNECT] sessionId={}", sessionId);
    }
    
    public void logBreakpointSet(String sessionId, String className, int lineNumber, String requestId) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("BREAKPOINT_SET")
                .details(String.format("class=%s, line=%d, requestId=%s", className, lineNumber, requestId))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [BREAKPOINT_SET] sessionId={}, class={}, line={}, requestId={}", 
                sessionId, className, lineNumber, requestId);
    }
    
    public void logExceptionBreakpoint(String sessionId, String exceptionClass, String requestId) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("EXCEPTION_BREAKPOINT_SET")
                .details(String.format("exception=%s, requestId=%s", exceptionClass, requestId))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [EXCEPTION_BREAKPOINT] sessionId={}, exception={}, requestId={}", 
                sessionId, exceptionClass, requestId);
    }
    
    public void logBreakpointHit(String sessionId, String location, long threadId) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("BREAKPOINT_HIT")
                .details(String.format("location=%s, threadId=%d", location, threadId))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [BREAKPOINT_HIT] sessionId={}, location={}, threadId={}", 
                sessionId, location, threadId);
    }
    
    public void logExceptionCaught(String sessionId, String exceptionType, String location, long threadId) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("EXCEPTION_CAUGHT")
                .details(String.format("exception=%s, location=%s, threadId=%d", 
                        exceptionType, location, threadId))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [EXCEPTION_CAUGHT] sessionId={}, exception={}, location={}, threadId={}", 
                sessionId, exceptionType, location, threadId);
    }
    
    public void logThreadResume(String sessionId, long threadId) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("THREAD_RESUME")
                .details(String.format("threadId=%d", threadId))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [THREAD_RESUME] sessionId={}, threadId={}", sessionId, threadId);
    }
    
    public void logPortForward(String sessionId, String namespace, String podName, int localPort) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("PORT_FORWARD")
                .details(String.format("pod=%s/%s, localPort=%d", namespace, podName, localPort))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [PORT_FORWARD] sessionId={}, pod={}/{}, localPort={}", 
                sessionId, namespace, podName, localPort);
    }
    
    public void logSessionStart(String sessionId, String podName, String requestId, String createdBy) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("SESSION_START")
                .details(String.format("pod=%s, requestId=%s, createdBy=%s", podName, requestId, createdBy))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [SESSION_START] sessionId={}, pod={}, requestId={}, createdBy={}", 
                sessionId, podName, requestId, createdBy);
    }
    
    public void logSessionEnd(String sessionId, long durationSeconds) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action("SESSION_END")
                .details(String.format("duration=%ds", durationSeconds))
                .success(true)
                .build();
        addEntry(entry);
        log.info("AUDIT [SESSION_END] sessionId={}, duration={}s", sessionId, durationSeconds);
    }
    
    public void logError(String sessionId, String action, String error) {
        AuditEntry entry = AuditEntry.builder()
                .timestamp(Instant.now())
                .sessionId(sessionId)
                .action(action + "_ERROR")
                .details(error)
                .success(false)
                .build();
        addEntry(entry);
        log.error("AUDIT [{}] sessionId={}, error={}", action + "_ERROR", sessionId, error);
    }
    
    /**
     * Get all audit entries for a session.
     */
    public List<AuditEntry> getSessionAuditLog(String sessionId) {
        return sessionAuditLog.getOrDefault(sessionId, Collections.emptyList());
    }
    
    /**
     * Get recent audit entries.
     */
    public List<AuditEntry> getRecentAuditLog(int limit) {
        int size = auditLog.size();
        int start = Math.max(0, size - limit);
        return new ArrayList<>(auditLog.subList(start, size));
    }
    
    private void addEntry(AuditEntry entry) {
        auditLog.add(entry);
        sessionAuditLog.computeIfAbsent(entry.getSessionId(), k -> 
                Collections.synchronizedList(new ArrayList<>())).add(entry);
        
        // Keep audit log bounded (in production, persist to external storage)
        if (auditLog.size() > 10000) {
            auditLog.subList(0, 1000).clear();
        }
    }
    
    /**
     * Audit entry record.
     */
    @lombok.Data
    @lombok.Builder
    public static class AuditEntry {
        private Instant timestamp;
        private String sessionId;
        private String action;
        private String details;
        private boolean success;
    }
}
