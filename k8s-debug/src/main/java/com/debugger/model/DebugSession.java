package com.debugger.model;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Represents an active debug session.
 */
@Data
@Builder
public class DebugSession {
    
    public enum State {
        INITIALIZING,   // Session created, not yet connected
        CONNECTING,     // Port-forward establishing
        CONNECTED,      // JDWP connected, ready for breakpoints
        DEBUGGING,      // Breakpoint hit, thread suspended
        SUSPENDED,      // Session paused
        CLOSING,        // Cleanup in progress
        CLOSED,         // Session ended
        ERROR           // Session failed
    }
    
    private String sessionId;
    private String requestId;          // The request ID being debugged
    private PodInfo targetPod;
    private int localPort;             // Local port for port-forward
    private State state;
    private Instant createdAt;
    private Instant connectedAt;
    private Instant closedAt;
    private String errorMessage;
    
    // Breakpoint tracking
    @Builder.Default
    private List<BreakpointInfo> breakpoints = new ArrayList<>();
    
    // Thread tracking
    private Long suspendedThreadId;
    private String suspendedThreadName;
    private String suspendedLocation;
    
    // Timeout settings
    private int timeoutSeconds;
    
    // Audit trail
    private String createdBy;
    
    /**
     * Create a new debug session.
     */
    public static DebugSession create(PodInfo pod, String requestId, String createdBy) {
        return DebugSession.builder()
                .sessionId(UUID.randomUUID().toString())
                .requestId(requestId)
                .targetPod(pod)
                .state(State.INITIALIZING)
                .createdAt(Instant.now())
                .timeoutSeconds(300) // 5 minutes default
                .createdBy(createdBy)
                .breakpoints(new ArrayList<>())
                .build();
    }
    
    /**
     * Check if session is active.
     */
    public boolean isActive() {
        return state == State.CONNECTED || 
               state == State.DEBUGGING || 
               state == State.CONNECTING;
    }
    
    /**
     * Check if session has timed out.
     */
    public boolean isTimedOut() {
        if (createdAt == null) return false;
        long elapsedSeconds = Instant.now().getEpochSecond() - createdAt.getEpochSecond();
        return elapsedSeconds > timeoutSeconds;
    }
    
    /**
     * Get session duration in seconds.
     */
    public long getDurationSeconds() {
        Instant end = closedAt != null ? closedAt : Instant.now();
        return end.getEpochSecond() - createdAt.getEpochSecond();
    }
    
    /**
     * Add a breakpoint to the session.
     */
    public void addBreakpoint(BreakpointInfo breakpoint) {
        if (breakpoints == null) {
            breakpoints = new ArrayList<>();
        }
        breakpoints.add(breakpoint);
    }
    
    /**
     * Model for breakpoint information.
     */
    @Data
    @Builder
    public static class BreakpointInfo {
        private String className;
        private int lineNumber;
        private String condition;
        private boolean enabled;
        private int hitCount;
        private Instant createdAt;
        
        public String getLocation() {
            return className + ":" + lineNumber;
        }
    }
}
