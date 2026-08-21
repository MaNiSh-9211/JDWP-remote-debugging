package com.debugger.filter;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration properties for the debug filter.
 */
@ConfigurationProperties(prefix = "debug.filter")
public class DebugFilterProperties {
    
    /**
     * Enable/disable the debug filter. Default: true
     */
    private boolean enabled = true;
    
    /**
     * Log all requests (not just debug requests). Default: false
     */
    private boolean logAllRequests = false;
    
    /**
     * Header name for debug request ID. Default: X-Debug-Request-Id
     */
    private String debugHeaderName = "X-Debug-Request-Id";
    
    /**
     * Header name for standard request ID. Default: X-Request-Id
     */
    private String requestIdHeaderName = "X-Request-Id";
    
    /**
     * Maximum number of active debug sessions. Default: 10
     */
    private int maxActiveSessions = 10;
    
    /**
     * Session timeout in milliseconds. Default: 300000 (5 minutes)
     */
    private long sessionTimeoutMs = 300000;
    
    // Getters and Setters
    
    public boolean isEnabled() {
        return enabled;
    }
    
    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }
    
    public boolean isLogAllRequests() {
        return logAllRequests;
    }
    
    public void setLogAllRequests(boolean logAllRequests) {
        this.logAllRequests = logAllRequests;
    }
    
    public String getDebugHeaderName() {
        return debugHeaderName;
    }
    
    public void setDebugHeaderName(String debugHeaderName) {
        this.debugHeaderName = debugHeaderName;
    }
    
    public String getRequestIdHeaderName() {
        return requestIdHeaderName;
    }
    
    public void setRequestIdHeaderName(String requestIdHeaderName) {
        this.requestIdHeaderName = requestIdHeaderName;
    }
    
    public int getMaxActiveSessions() {
        return maxActiveSessions;
    }
    
    public void setMaxActiveSessions(int maxActiveSessions) {
        this.maxActiveSessions = maxActiveSessions;
    }
    
    public long getSessionTimeoutMs() {
        return sessionTimeoutMs;
    }
    
    public void setSessionTimeoutMs(long sessionTimeoutMs) {
        this.sessionTimeoutMs = sessionTimeoutMs;
    }
}
