package com.debugger.model;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.Map;

/**
 * Information about a Kubernetes pod.
 */
@Data
@Builder
public class PodInfo {
    private String name;
    private String namespace;
    private String podIp;
    private String hostIp;
    private String phase;          // Running, Pending, etc.
    private String nodeName;
    private Map<String, String> labels;
    private Map<String, String> annotations;
    private Instant creationTimestamp;
    private boolean ready;
    private int restartCount;
    private String containerStatus;
    
    // JDWP specific
    private int jdwpPort;
    private boolean jdwpEnabled;
    
    /**
     * Check if pod is debuggable (running and has JDWP enabled).
     */
    public boolean isDebuggable() {
        return "Running".equals(phase) && ready && jdwpEnabled;
    }
    
    /**
     * Get display name for UI/logging.
     */
    public String getDisplayName() {
        return String.format("%s/%s (%s)", namespace, name, podIp);
    }
}
