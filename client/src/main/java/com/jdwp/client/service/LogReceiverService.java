package com.jdwp.client.service;

import com.sun.jdi.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.io.*;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Service that receives console logs from the injected agent
 * and correlates them with JDWP thread/stack information.
 */
@Service
public class LogReceiverService {
    private static final Logger logger = LoggerFactory.getLogger(LogReceiverService.class);
    
    private ServerSocket serverSocket;
    private Thread receiverThread;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final BlockingQueue<LogEntry> logQueue = new LinkedBlockingQueue<>();
    private final List<LogEntry> recentLogs = new CopyOnWriteArrayList<>();
    private static final int MAX_RECENT_LOGS = 1000;
    
    private VirtualMachine vm; // Reference to JDWP VM for correlation
    
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Autowired(required = false)
    private LogStreamService logStreamService;
    
    public static class LogEntry {
        public String type;
        public String stream;
        public String thread;
        public long timestamp;
        public String message;
        public String className;
        public String methodName;
        public Integer lineNumber;
        
        public LogEntry() {}
        
        public LogEntry(String type, String stream, String thread, long timestamp, String message) {
            this.type = type;
            this.stream = stream;
            this.thread = thread;
            this.timestamp = timestamp;
            this.message = message;
        }
    }
    
    public void setVirtualMachine(VirtualMachine vm) {
        this.vm = vm;
    }
    
    public void start(int port) {
        if (running.compareAndSet(false, true)) {
            try {
                serverSocket = new ServerSocket(port);
                logger.info("[LOG RECEIVER] Started on port {}", port);
                
                receiverThread = new Thread(() -> {
                    while (running.get()) {
                        try {
                            Socket clientSocket = serverSocket.accept();
                            logger.info("[LOG RECEIVER] ✓✓✓ NEW CLIENT CONNECTION from {}", clientSocket.getRemoteSocketAddress());
                            logger.info("[LOG RECEIVER] This is likely the ConsoleLogAgent connecting!");
                            
                            // Handle each client in a separate thread
                            new Thread(() -> handleClient(clientSocket)).start();
                        } catch (IOException e) {
                            if (running.get()) {
                                logger.error("[LOG RECEIVER] Error accepting connection: {}", e.getMessage());
                            }
                        }
                    }
                }, "LogReceiver");
                receiverThread.setDaemon(true);
                receiverThread.start();
            } catch (IOException e) {
                logger.error("[LOG RECEIVER] Failed to start on port {}: {}", port, e.getMessage());
                running.set(false);
            }
        }
    }
    
    public void stop() {
        if (running.compareAndSet(true, false)) {
            try {
                if (serverSocket != null && !serverSocket.isClosed()) {
                    serverSocket.close();
                }
            } catch (IOException e) {
                logger.debug("[LOG RECEIVER] Error closing server socket: {}", e.getMessage());
            }
            logger.info("[LOG RECEIVER] Stopped");
        }
    }
    
    /**
     * Entry point for log events produced inside the client itself
     * (e.g. logpoints) so they land in the same store/stream as agent logs.
     */
    public void ingestExternal(LogEntry entry) {
        if (entry == null || entry.message == null || entry.message.isBlank()) return;
        logQueue.offer(entry);
        synchronized (recentLogs) {
            recentLogs.add(entry);
            if (recentLogs.size() > MAX_RECENT_LOGS) {
                recentLogs.remove(0);
            }
        }
        if (logStreamService != null) {
            logStreamService.broadcast(entry);
        }
    }

    private void handleClient(Socket clientSocket) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(clientSocket.getInputStream(), StandardCharsets.UTF_8))) {
            logger.info("[LOG RECEIVER] Started handling client from {}", clientSocket.getRemoteSocketAddress());
            
            String line;
            int lineCount = 0;
            while (running.get() && (line = reader.readLine()) != null) {
                lineCount++;
                try {
                    // Parse JSON log entry
                    Map<String, Object> logData = objectMapper.readValue(line, Map.class);
                    
                    LogEntry entry = new LogEntry();
                    entry.type = (String) logData.get("type");
                    entry.stream = (String) logData.get("stream");
                    entry.thread = (String) logData.get("thread");
                    entry.timestamp = ((Number) logData.get("timestamp")).longValue();
                    entry.message = com.jdwp.client.security.SecretRedactor.redact((String) logData.get("message"));
                    
                    // Log that we received it
                    String msgPreview = entry.message != null && entry.message.length() > 0 
                        ? entry.message.substring(0, Math.min(50, entry.message.length())) 
                        : "(empty message)";
                    logger.info("[LOG RECEIVER] ✓ Received log #{}: {}", lineCount, msgPreview);
                    
                    // Correlate with JDWP
                    correlateWithJDWP(entry);
                    
                    // Add to queue and recent logs
                    logQueue.offer(entry);
                    synchronized (recentLogs) {
                        recentLogs.add(entry);
                        if (recentLogs.size() > MAX_RECENT_LOGS) {
                            recentLogs.remove(0);
                        }
                    }
                    if (logStreamService != null) {
                        logStreamService.broadcast(entry);
                    }
                    
                    logger.debug("[LOG RECEIVER] Total logs stored: {}", recentLogs.size());
                    
                } catch (Exception e) {
                    logger.error("[LOG RECEIVER] Failed to parse log line #{}: {} - Line was: {}", lineCount, e.getMessage(), line);
                    e.printStackTrace();
                }
            }
            logger.info("[LOG RECEIVER] Client disconnected after {} lines", lineCount);
        } catch (IOException e) {
            if (running.get()) {
                logger.error("[LOG RECEIVER] Client connection error: {}", e.getMessage(), e);
            }
        }
    }
    
    private void correlateWithJDWP(LogEntry entry) {
        if (vm == null) {
            return;
        }
        
        try {
            // Find matching thread
            ThreadReference thread = vm.allThreads().stream()
                    .filter(t -> t.name().equals(entry.thread))
                    .findFirst()
                    .orElse(null);
            
            if (thread != null && !thread.isSuspended()) {
                // Get top stack frame
                try {
                    List<StackFrame> frames = thread.frames();
                    if (!frames.isEmpty()) {
                        StackFrame topFrame = frames.get(0);
                        Location location = topFrame.location();
                        entry.className = location.declaringType().name();
                        entry.methodName = location.method().name();
                        entry.lineNumber = location.lineNumber();
                    }
                } catch (Exception e) {
                    // Thread may not be suspended or accessible
                }
            }
        } catch (Exception e) {
            // Silently fail - correlation is optional
        }
    }
    
    // Patterns to exclude (JDWP agent logs, system threads)
    private static final String[] EXCLUDE_PATTERNS = {
        "ConsoleLogAgent",
        "Attach Listener",
        "WARNING: A Java agent has been loaded",
        "WARNING: If a serviceability tool",
        "WARNING: Dynamic loading of agents",
        "========================================",
        "[ConsoleLogAgent]",
        "Listening for transport dt_socket"
    };
    
    // Patterns to include (application logs)
    private static final String[] INCLUDE_PATTERNS = {
        "com.jdwp.server",
        "ERROR",
        "Exception",
        "Caused by:",
        "java.lang.",
        "org.springframework"
    };
    
    private boolean isAgentLog(LogEntry entry) {
        if (entry == null || entry.message == null || entry.message.trim().isEmpty()) {
            return false;
        }
        
        String message = entry.message;
        String thread = entry.thread != null ? entry.thread : "";
        
        // Check if this is an agent log - check patterns first
        for (String pattern : EXCLUDE_PATTERNS) {
            if (message.contains(pattern) || thread.contains(pattern)) {
                return true;
            }
        }
        
        // Check for agent-specific patterns
        if (thread.contains("Attach Listener") || 
            message.startsWith("[ConsoleLogAgent]") ||
            message.contains("ConsoleLogAgent") ||
            message.contains("AGENT AGENTMAIN") ||
            message.contains("Agent args:") ||
            message.contains("Instrumentation: OK")) {
            return true;
        }
        
        return false;
    }
    
    private boolean shouldIncludeLog(LogEntry entry) {
        if (entry.message == null || entry.message.trim().isEmpty()) {
            return false;
        }
        
        // Exclude agent logs (they're handled separately)
        if (isAgentLog(entry)) {
            return false;
        }
        
        String message = entry.message;
        String thread = entry.thread != null ? entry.thread : "";
        
        // Include application logs (errors, exceptions, or from application packages)
        for (String pattern : INCLUDE_PATTERNS) {
            if (message.contains(pattern)) {
                return true;
            }
        }
        
        // Include if thread is an HTTP thread (application request)
        if (thread.contains("http-nio") || thread.contains("exec-")) {
            return true;
        }
        
        // Exclude system threads unless they have application content
        if (thread.contains("Reference Handler") || 
            thread.contains("Finalizer") || thread.contains("Signal Dispatcher")) {
            return false;
        }
        
        // Default: include if it's not clearly a system log
        return !message.startsWith("WARNING:") && !message.startsWith("[ConsoleLogAgent]");
    }
    
    private List<LogEntry> filterAgentLogs(List<LogEntry> logs) {
        List<LogEntry> filtered = new ArrayList<>();
        for (LogEntry entry : logs) {
            if (isAgentLog(entry)) {
                filtered.add(entry);
            }
        }
        return filtered;
    }
    
    public List<LogEntry> getRecentLogs(int limit) {
        return getRecentLogs(limit, true);
    }
    
    public List<LogEntry> getRecentLogs(int limit, boolean filter) {
        synchronized (recentLogs) {
            List<LogEntry> filtered = filter ? filterLogs(recentLogs) : recentLogs;
            int size = filtered.size();
            int start = Math.max(0, size - limit);
            return new ArrayList<>(filtered.subList(start, size));
        }
    }
    
    private List<LogEntry> filterLogs(List<LogEntry> logs) {
        List<LogEntry> filtered = new ArrayList<>();
        if (logs == null) {
            return filtered;
        }
        for (LogEntry entry : logs) {
            if (entry != null && shouldIncludeLog(entry)) {
                filtered.add(entry);
            }
        }
        return filtered;
    }
    
    public List<LogEntry> getLogsSince(long timestamp) {
        return getLogsSince(timestamp, true);
    }
    
    public List<LogEntry> getLogsSince(long timestamp, boolean filter) {
        synchronized (recentLogs) {
            List<LogEntry> result = new ArrayList<>();
            List<LogEntry> source = filter ? filterLogs(recentLogs) : recentLogs;
            for (LogEntry entry : source) {
                if (entry.timestamp >= timestamp) {
                    result.add(entry);
                }
            }
            return result;
        }
    }

    /** Strictly after timestamp (for incremental polling without duplicates). */
    public List<LogEntry> getLogsAfter(long exclusiveTimestamp, boolean filter) {
        synchronized (recentLogs) {
            List<LogEntry> result = new ArrayList<>();
            List<LogEntry> source = filter ? filterLogs(recentLogs) : recentLogs;
            for (LogEntry entry : source) {
                if (entry.timestamp > exclusiveTimestamp) {
                    result.add(entry);
                }
            }
            return result;
        }
    }
    
    public List<LogEntry> getLogsByThread(String threadName) {
        return getLogsByThread(threadName, true);
    }
    
    public List<LogEntry> getLogsByThread(String threadName, boolean filter) {
        synchronized (recentLogs) {
            List<LogEntry> result = new ArrayList<>();
            List<LogEntry> source = filter ? filterLogs(recentLogs) : recentLogs;
            for (LogEntry entry : source) {
                if (threadName.equals(entry.thread)) {
                    result.add(entry);
                }
            }
            return result;
        }
    }
    
    public List<LogEntry> getLogsByStream(String stream) {
        return getLogsByStream(stream, true);
    }
    
    public List<LogEntry> getLogsByStream(String stream, boolean filter) {
        synchronized (recentLogs) {
            List<LogEntry> result = new ArrayList<>();
            List<LogEntry> source = filter ? filterLogs(recentLogs) : recentLogs;
            for (LogEntry entry : source) {
                if (stream.equals(entry.stream)) {
                    result.add(entry);
                }
            }
            return result;
        }
    }
    
    public List<String> getLogsAsSimpleStrings(int limit, boolean filter) {
        synchronized (recentLogs) {
            List<LogEntry> entries = getRecentLogs(limit, filter);
            List<String> result = new ArrayList<>();
            for (LogEntry entry : entries) {
                String formatted = String.format("[%s][%s] %s", 
                    entry.stream != null ? entry.stream : "unknown",
                    entry.type != null ? entry.type : "console_log",
                    entry.message != null ? entry.message : "");
                result.add(formatted);
            }
            return result;
        }
    }
    
    public List<String> getAgentLogsAsSimpleStrings(int limit) {
        synchronized (recentLogs) {
            try {
                if (recentLogs == null || recentLogs.isEmpty()) {
                    return new ArrayList<>();
                }
                
                List<LogEntry> agentLogs = filterAgentLogs(recentLogs);
                if (agentLogs.isEmpty()) {
                    return new ArrayList<>();
                }
                
                int size = agentLogs.size();
                int start = Math.max(0, size - limit);
                List<LogEntry> recentAgentLogs = new ArrayList<>(agentLogs.subList(start, size));
                
                List<String> result = new ArrayList<>();
                for (LogEntry entry : recentAgentLogs) {
                    if (entry != null) {
                        String formatted = String.format("[%s][%s] %s", 
                            entry.stream != null ? entry.stream : "unknown",
                            entry.type != null ? entry.type : "console_log",
                            entry.message != null ? entry.message : "");
                        result.add(formatted);
                    }
                }
                return result;
            } catch (Exception e) {
                logger.error("Error in getAgentLogsAsSimpleStrings: {}", e.getMessage(), e);
                return new ArrayList<>();
            }
        }
    }
    
    public void clearLogs() {
        synchronized (recentLogs) {
            recentLogs.clear();
        }
    }
    
    public boolean isRunning() {
        return running.get();
    }
}
