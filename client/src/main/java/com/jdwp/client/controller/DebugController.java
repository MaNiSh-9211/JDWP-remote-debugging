package com.jdwp.client.controller;

import com.jdwp.client.service.DemoAppProxyService;
import com.jdwp.client.service.JdwpService;
import com.jdwp.client.service.LogReceiverService;
import com.jdwp.client.service.LogStreamService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/debug")

public class DebugController {
    private static final org.slf4j.Logger logger = org.slf4j.LoggerFactory.getLogger(DebugController.class);
    
    @Autowired
    private JdwpService jdwpService;

    @Autowired
    private Environment environment;

    @Autowired
    private DemoAppProxyService demoAppProxyService;

    private final ObjectMapper objectMapper = new ObjectMapper();
    
    @PostMapping("/connect")
    public ResponseEntity<Map<String, Object>> connect(
            @RequestParam(defaultValue = "localhost") String host,
            @RequestParam(defaultValue = "5005") int port) {
        try {
            boolean connected = jdwpService.connect(host, port);
            Map<String, Object> response = new HashMap<>();
            response.put("success", connected);
            response.put("message", connected ? "Connected successfully" : "Connection failed");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            // Return 200 so frontend can read the message; 400 causes HttpClient to throw and hide body
            return ResponseEntity.ok(response);
        }
    }
    
    @PostMapping("/disconnect")
    public ResponseEntity<Map<String, Object>> disconnect() {
        try {
            jdwpService.disconnect();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Disconnected successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    /** Lightweight reachability check for the desktop app (no JDWP). */
    @GetMapping("/ping")
    public ResponseEntity<Map<String, Object>> ping() {
        Map<String, Object> m = new HashMap<>();
        m.put("ok", true);
        m.put("service", "jdwp-debug-client");
        return ResponseEntity.ok(m);
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> getStatus() {
        Map<String, Object> response = new HashMap<>();
        boolean vmOk = jdwpService.isConnected();
        response.put("connected", vmOk);
        response.put("targetVmConnected", vmOk);
        response.put("targetHost", jdwpService.getSessionTargetHost());
        response.put("targetPort", jdwpService.getSessionTargetPort());
        response.put("vmDescription", jdwpService.getVmDescriptionSafe());
        return ResponseEntity.ok(response);
    }

    @GetMapping("/client-config")
    public ResponseEntity<Map<String, Object>> getClientConfig() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("defaultTargetHost", environment.getProperty("jdwp.default-target-host", "localhost"));
        int port = 5005;
        try {
            port = Integer.parseInt(environment.getProperty("jdwp.default-target-port", "5005"));
        } catch (NumberFormatException ignored) {
            /* keep default */
        }
        response.put("defaultTargetPort", port);
        response.put("demoAppBaseUrl", demoAppProxyService.getBaseUrl());
        return ResponseEntity.ok(response);
    }

    @GetMapping("/demo-app-base")
    public ResponseEntity<Map<String, Object>> getDemoAppBase() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("baseUrl", demoAppProxyService.getBaseUrl());
        return ResponseEntity.ok(response);
    }

    @PostMapping("/demo-app-base")
    public ResponseEntity<Map<String, Object>> setDemoAppBase(@RequestBody Map<String, String> body) {
        Map<String, Object> response = new HashMap<>();
        try {
            String u = body != null ? body.get("baseUrl") : null;
            demoAppProxyService.setBaseUrl(u);
            response.put("success", true);
            response.put("baseUrl", demoAppProxyService.getBaseUrl());
            response.put("message", "Demo app proxy base updated");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.ok(response);
        }
    }

    /**
     * Classpath seed for demo breakpoints (same file ships in the debug client JAR).
     */
    @GetMapping("/breakpoints/seed-default")
    public ResponseEntity<Map<String, Object>> getDefaultBreakpointSeed() {
        Map<String, Object> response = new HashMap<>();
        try (InputStream is = getClass().getClassLoader().getResourceAsStream("breakpoints-seed.json")) {
            if (is == null) {
                response.put("success", false);
                response.put("message", "breakpoints-seed.json not on classpath");
                return ResponseEntity.ok(response);
            }
            String json = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> list = objectMapper.readValue(json, List.class);
            response.put("success", true);
            response.put("breakpoints", list);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.ok(response);
        }
    }
    
    @GetMapping("/threads")
    public ResponseEntity<Map<String, Object>> getAllThreads() {
        try {
            List<Map<String, Object>> threads = jdwpService.getAllThreads();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("threads", threads);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/threads/{threadName}/frames")
    public ResponseEntity<Map<String, Object>> getThreadFrames(@PathVariable String threadName) {
        try {
            List<Map<String, Object>> frames = jdwpService.getThreadStackFrames(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("frames", frames);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/breakpoints")
    public ResponseEntity<Map<String, Object>> setBreakpoint(
            @RequestParam String className,
            @RequestParam int lineNumber,
            @RequestParam(required = false) String triggerLoadUrl) {
        try {
            if (triggerLoadUrl != null && !triggerLoadUrl.isBlank()) {
                triggerClassLoad(triggerLoadUrl);
            }
            String bpId = jdwpService.setBreakpoint(className, lineNumber);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("breakpointId", bpId);
            response.put("message", "Breakpoint set successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.ok(response);
        }
    }
    
    /**
     * Set a CONDITIONAL breakpoint that only suspends threads with matching request ID.
     * Other requests to the same API endpoint will continue normally without being paused.
     * If triggerLoadUrl is provided, does a GET request first to load the class in the target VM.
     * 
     * @param className The fully qualified class name
     * @param lineNumber The line number for the breakpoint
     * @param targetRequestId The X-Debug-Request-Id that should trigger suspension
     * @param triggerLoadUrl Optional URL to GET before setting breakpoint (loads the controller class)
     */
    @PostMapping("/breakpoints/conditional")
    public ResponseEntity<Map<String, Object>> setConditionalBreakpoint(
            @RequestParam String className,
            @RequestParam int lineNumber,
            @RequestParam String targetRequestId,
            @RequestParam(required = false) String triggerLoadUrl) {
        try {
            if (triggerLoadUrl != null && !triggerLoadUrl.isBlank()) {
                triggerClassLoad(triggerLoadUrl);
            }
            String bpId = jdwpService.setConditionalBreakpoint(className, lineNumber, targetRequestId);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("breakpointId", bpId);
            response.put("targetRequestId", targetRequestId);
            response.put("message", "Conditional breakpoint set - only requests with X-Debug-Request-Id: " + targetRequestId + " will be suspended");
            response.put("note", "Other requests to this code will continue normally without pausing");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            // Return 200 so frontend can read the message (400 causes HttpClient to throw and hide body)
            return ResponseEntity.ok(response);
        }
    }
    
    @DeleteMapping("/breakpoints/{bpId}")
    public ResponseEntity<Map<String, Object>> removeBreakpoint(@PathVariable String bpId) {
        try {
            jdwpService.removeBreakpoint(bpId);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Breakpoint removed successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @DeleteMapping("/breakpoints")
    public ResponseEntity<Map<String, Object>> removeAllBreakpoints() {
        try {
            int count = jdwpService.removeAllBreakpoints();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "All breakpoints removed successfully");
            response.put("count", count);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/breakpoints/batch")
    public ResponseEntity<Map<String, Object>> setBreakpointsBatch(@RequestBody List<Map<String, Object>> breakpoints) {
        try {
            List<Map<String, Object>> results = new ArrayList<>();
            int successCount = 0;
            int failCount = 0;
            
            for (Map<String, Object> bp : breakpoints) {
                try {
                    String className = (String) bp.get("className");
                    Number lineNum = bp.get("lineNumber") instanceof Number
                            ? (Number) bp.get("lineNumber")
                            : null;
                    Integer lineNumber = lineNum != null ? lineNum.intValue() : null;
                    if (className != null && lineNumber != null) {
                        String bpId = jdwpService.setBreakpoint(className, lineNumber);
                        Map<String, Object> result = new HashMap<>();
                        result.put("success", true);
                        result.put("breakpointId", bpId);
                        result.put("className", className);
                        result.put("lineNumber", lineNumber);
                        results.add(result);
                        successCount++;
                    }
                } catch (Exception e) {
                    Map<String, Object> result = new HashMap<>();
                    result.put("success", false);
                    result.put("className", bp.get("className"));
                    result.put("lineNumber", bp.get("lineNumber"));
                    result.put("message", e.getMessage());
                    results.add(result);
                    failCount++;
                }
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("results", results);
            response.put("successCount", successCount);
            response.put("failCount", failCount);
            response.put("message", String.format("Set %d breakpoints successfully, %d failed", successCount, failCount));
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/api-breakpoints-config")
    public ResponseEntity<Map<String, Object>> getApiBreakpointsConfig() {
        try {
            // Read the config file
            java.io.InputStream is = getClass().getClassLoader().getResourceAsStream("api-breakpoints-config.json");
            if (is == null) {
                // Try reading from file system
                java.io.File file = new java.io.File("api-breakpoints-config.json");
                if (file.exists()) {
                    is = new java.io.FileInputStream(file);
                } else {
                    throw new RuntimeException("api-breakpoints-config.json not found");
                }
            }
            
            String content = new String(is.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            Map<String, Object> config = mapper.readValue(content, Map.class);
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("config", config);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/breakpoints")
    public ResponseEntity<Map<String, Object>> getAllBreakpoints() {
        try {
            List<Map<String, Object>> breakpoints = jdwpService.getAllBreakpoints();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("breakpoints", breakpoints);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/threads/{threadName}/resume")
    public ResponseEntity<Map<String, Object>> resumeThread(@PathVariable String threadName) {
        try {
            jdwpService.resumeThread(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Thread resumed");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/continue")
    public ResponseEntity<Map<String, Object>> continueExecution() {
        try {
            jdwpService.continueExecution();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "VM resumed - execution continuing");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/threads/{threadName}/suspend")
    public ResponseEntity<Map<String, Object>> suspendThread(@PathVariable String threadName) {
        try {
            jdwpService.suspendThread(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Thread suspended");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/classes")
    public ResponseEntity<Map<String, Object>> getAllClasses() {
        try {
            List<Map<String, Object>> classes = jdwpService.getAllClasses();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("classes", classes);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/threads/{threadName}/step-over")
    public ResponseEntity<Map<String, Object>> stepOver(@PathVariable String threadName) {
        try {
            jdwpService.stepOver(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Step over executed");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/threads/{threadName}/step-into")
    public ResponseEntity<Map<String, Object>> stepInto(@PathVariable String threadName) {
        try {
            jdwpService.stepInto(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Step into executed");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/threads/{threadName}/step-out")
    public ResponseEntity<Map<String, Object>> stepOut(@PathVariable String threadName) {
        try {
            jdwpService.stepOut(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Step out executed");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }

    /**
     * Drop frames from the top of the stack until the current location is under {@code applicationPackagePrefix}
     * (default {@code com.jdwp.server}), skipping JDK / framework frames — similar to IntelliJ drop frame through internals.
     */
    @PostMapping("/threads/{threadName}/reset-frame")
    public ResponseEntity<Map<String, Object>> resetFrame(
            @PathVariable String threadName,
            @RequestParam(required = false) String applicationPackagePrefix) {
        try {
            int popped = jdwpService.resetFrameToApplicationCode(threadName, applicationPackagePrefix);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("poppedFrames", popped);
            response.put("message", popped == 0 ? "Already at application frame" : ("Dropped " + popped + " frame(s)"));
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/threads/{threadName}/variables-next-line")
    public ResponseEntity<Map<String, Object>> getVariablesAtNextLine(@PathVariable String threadName) {
        try {
            Map<String, Object> variables = jdwpService.getVariablesAtNextLine(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("variables", variables);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/threads/{threadName}/evaluate")
    public ResponseEntity<Map<String, Object>> evaluateExpression(
            @PathVariable String threadName,
            @RequestParam String expression,
            @RequestParam(required = false) Integer frameIndex) {
        try {
            String result = jdwpService.evaluateExpression(threadName, frameIndex, expression);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("result", result);
            response.put("expression", expression);
            if (frameIndex != null) {
                response.put("frameIndex", frameIndex);
            }
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/thread-dump")
    public ResponseEntity<Map<String, Object>> threadDump() {
        try {
            return ResponseEntity.ok(jdwpService.captureThreadDump());
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/execution-radar")
    public ResponseEntity<Map<String, Object>> executionRadar() {
        try {
            return ResponseEntity.ok(jdwpService.getExecutionRadar());
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/breakpoints/method")
    public ResponseEntity<Map<String, Object>> setMethodBreakpoint(
            @RequestParam String className,
            @RequestParam String methodName,
            @RequestParam(required = false) String signature) {
        try {
            String bpId = jdwpService.setMethodBreakpoint(className, methodName, signature);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("breakpointId", bpId);
            response.put("message", "Method breakpoint set at first line of method");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/breakpoints/mute")
    public ResponseEntity<Map<String, Object>> muteBreakpoints(@RequestParam boolean muted) {
        try {
            jdwpService.setBreakpointsMuted(muted);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("muted", jdwpService.isBreakpointsMuted());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/breakpoints/mute")
    public ResponseEntity<Map<String, Object>> getMuteState() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("muted", jdwpService.isBreakpointsMuted());
        return ResponseEntity.ok(response);
    }
    
    @PostMapping("/watchpoints/field")
    public ResponseEntity<Map<String, Object>> addFieldWatchpoint(
            @RequestParam String className,
            @RequestParam String fieldName,
            @RequestParam(defaultValue = "true") boolean onRead,
            @RequestParam(defaultValue = "true") boolean onWrite) {
        try {
            Map<String, Object> body = jdwpService.addFieldWatchpoint(className, fieldName, onRead, onWrite);
            return ResponseEntity.ok(body);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @DeleteMapping("/watchpoints/{watchpointId}")
    public ResponseEntity<Map<String, Object>> removeFieldWatchpoint(@PathVariable String watchpointId) {
        try {
            jdwpService.removeFieldWatchpoint(watchpointId);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/watchpoints")
    public ResponseEntity<Map<String, Object>> listFieldWatchpoints() {
        try {
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("watchpoints", jdwpService.listFieldWatchpoints());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/threads/{threadName}/source-location")
    public ResponseEntity<Map<String, Object>> getCurrentSourceLocation(@PathVariable String threadName) {
        try {
            Map<String, Object> location = jdwpService.getCurrentSourceLocation(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("location", location);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @Autowired(required = false)
    private LogReceiverService logReceiverService;

    @Autowired(required = false)
    private LogStreamService logStreamService;

    @GetMapping("/threads/{threadName}/request-id")
    public ResponseEntity<Map<String, Object>> getRequestIdForThread(@PathVariable String threadName) {
        try {
            String rid = jdwpService.getRequestIdForThread(threadName);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("requestId", rid);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }

    @GetMapping("/breakpoints/hit-stats")
    public ResponseEntity<Map<String, Object>> getBreakpointHitStats() {
        try {
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("hits", jdwpService.getBreakpointHitCounts());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }

    @GetMapping("/logs/entries")
    public ResponseEntity<Map<String, Object>> getLogEntries(
            @RequestParam(defaultValue = "200") int limit,
            @RequestParam(required = false) Long after,
            @RequestParam(required = false) String thread,
            @RequestParam(defaultValue = "true") boolean filter) {
        try {
            if (logReceiverService == null) {
                Map<String, Object> response = new HashMap<>();
                response.put("success", false);
                response.put("message", "Log receiver service not available");
                return ResponseEntity.badRequest().body(response);
            }
            List<LogReceiverService.LogEntry> entries;
            if (after != null) {
                entries = logReceiverService.getLogsAfter(after, filter);
            } else if (thread != null) {
                entries = logReceiverService.getLogsByThread(thread, filter);
            } else {
                entries = logReceiverService.getRecentLogs(limit, filter);
            }
            List<Map<String, Object>> list = new ArrayList<>();
            for (LogReceiverService.LogEntry e : entries) {
                list.add(logEntryToMap(e));
            }
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("entries", list);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }

    @GetMapping(value = "/logs/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> logStream() {
        if (logStreamService == null) {
            return ResponseEntity.status(503).build();
        }
        return ResponseEntity.ok(logStreamService.subscribe());
    }

    private static Map<String, Object> logEntryToMap(LogReceiverService.LogEntry e) {
        Map<String, Object> m = new HashMap<>();
        m.put("timestamp", e.timestamp);
        m.put("thread", e.thread);
        m.put("stream", e.stream);
        m.put("type", e.type);
        m.put("message", e.message);
        m.put("className", e.className);
        m.put("methodName", e.methodName);
        m.put("lineNumber", e.lineNumber);
        return m;
    }

    @GetMapping("/logs")
    public ResponseEntity<Map<String, Object>> getLogs(
            @RequestParam(defaultValue = "100") int limit,
            @RequestParam(required = false) Long since,
            @RequestParam(required = false) String thread,
            @RequestParam(required = false) String stream,
            @RequestParam(defaultValue = "true") boolean filter) {
        try {
            if (logReceiverService == null) {
                Map<String, Object> response = new HashMap<>();
                response.put("success", false);
                response.put("message", "Log receiver service not available");
                return ResponseEntity.badRequest().body(response);
            }
            
            // Return simple string array format
            List<String> logStrings;
            if (since != null) {
                List<com.jdwp.client.service.LogReceiverService.LogEntry> entries = 
                    logReceiverService.getLogsSince(since, filter);
                logStrings = new ArrayList<>();
                for (com.jdwp.client.service.LogReceiverService.LogEntry entry : entries) {
                    String formatted = String.format("[%s][%s] %s", 
                        entry.stream != null ? entry.stream : "unknown",
                        entry.type != null ? entry.type : "console_log",
                        entry.message != null ? entry.message : "");
                    logStrings.add(formatted);
                }
            } else if (thread != null) {
                List<com.jdwp.client.service.LogReceiverService.LogEntry> entries = 
                    logReceiverService.getLogsByThread(thread, filter);
                logStrings = new ArrayList<>();
                for (com.jdwp.client.service.LogReceiverService.LogEntry entry : entries) {
                    String formatted = String.format("[%s][%s] %s", 
                        entry.stream != null ? entry.stream : "unknown",
                        entry.type != null ? entry.type : "console_log",
                        entry.message != null ? entry.message : "");
                    logStrings.add(formatted);
                }
            } else if (stream != null) {
                List<com.jdwp.client.service.LogReceiverService.LogEntry> entries = 
                    logReceiverService.getLogsByStream(stream, filter);
                logStrings = new ArrayList<>();
                for (com.jdwp.client.service.LogReceiverService.LogEntry entry : entries) {
                    String formatted = String.format("[%s][%s] %s", 
                        entry.stream != null ? entry.stream : "unknown",
                        entry.type != null ? entry.type : "console_log",
                        entry.message != null ? entry.message : "");
                    logStrings.add(formatted);
                }
            } else {
                logStrings = logReceiverService.getLogsAsSimpleStrings(limit, filter);
            }
            
            // Ensure all logs are strings, not objects
            if (logStrings == null) {
                logStrings = new ArrayList<>();
            }
            List<String> finalLogStrings = new ArrayList<>();
            for (Object log : logStrings) {
                if (log instanceof String) {
                    finalLogStrings.add((String) log);
                } else {
                    // Convert to string if somehow it's not
                    finalLogStrings.add(log != null ? log.toString() : "");
                }
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("logs", finalLogStrings);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/logs/clear")
    public ResponseEntity<Map<String, Object>> clearLogs() {
        try {
            if (logReceiverService == null) {
                Map<String, Object> response = new HashMap<>();
                response.put("success", false);
                response.put("message", "Log receiver service not available");
                return ResponseEntity.badRequest().body(response);
            }
            
            logReceiverService.clearLogs();
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Logs cleared");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/logs/status")
    public ResponseEntity<Map<String, Object>> getLogStatus() {
        Map<String, Object> response = new HashMap<>();
        if (logReceiverService != null) {
            response.put("running", logReceiverService.isRunning());
            response.put("success", true);
        } else {
            response.put("running", false);
            response.put("success", false);
            response.put("message", "Log receiver service not available");
        }
        return ResponseEntity.ok(response);
    }
    
    @GetMapping("/logs/agent")
    public ResponseEntity<Map<String, Object>> getAgentLogs(
            @RequestParam(defaultValue = "100") int limit) {
        try {
            if (logReceiverService == null) {
                Map<String, Object> response = new HashMap<>();
                response.put("success", false);
                response.put("message", "Log receiver service not available");
                response.put("logs", new ArrayList<>());
                return ResponseEntity.ok(response);
            }
            
            List<String> agentLogs = null;
            try {
                agentLogs = logReceiverService.getAgentLogsAsSimpleStrings(limit);
            } catch (Exception e) {
                logger.error("Error getting agent logs: {}", e.getMessage(), e);
                agentLogs = new ArrayList<>();
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("logs", agentLogs != null ? agentLogs : new ArrayList<>());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            logger.error("Error in getAgentLogs endpoint: {}", e.getMessage(), e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            response.put("logs", new ArrayList<>());
            return ResponseEntity.ok(response); // Return 200 with error message instead of 400
        }
    }
    
    @PostMapping("/exception-breakpoint")
    public ResponseEntity<Map<String, Object>> setExceptionBreakpoint(
            @RequestParam(defaultValue = "true") boolean enabled,
            @RequestParam(required = false) String exceptionClass) {
        try {
            jdwpService.setExceptionBreakpoint(enabled, exceptionClass);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", enabled ? "Exception breakpoint enabled" : "Exception breakpoint disabled");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @PostMapping("/wait-for-breakpoint")
    public ResponseEntity<Map<String, Object>> waitForBreakpoint(
            @RequestParam(defaultValue = "5000") long timeout,
            @RequestParam(defaultValue = "100") long pollInterval) {
        try {
            Map<String, Object> result = jdwpService.waitForBreakpointHit(timeout, pollInterval);
            return ResponseEntity.ok(result);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping("/threads/{threadName}/variables-enhanced")
    public ResponseEntity<Map<String, Object>> getVariablesEnhanced(
            @PathVariable String threadName,
            @RequestParam(defaultValue = "true") boolean includeInstance) {
        try {
            Map<String, Object> variables = jdwpService.getVariablesEnhanced(threadName, includeInstance);
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("variables", variables);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        }
    }
    
    @GetMapping(value = "/logs/text", produces = "text/plain;charset=UTF-8")
    public ResponseEntity<String> getLogsAsText(
            @RequestParam(defaultValue = "1000") int limit,
            @RequestParam(required = false) Long since,
            @RequestParam(required = false) String thread,
            @RequestParam(required = false) String stream) {
        try {
            if (logReceiverService == null) {
                return ResponseEntity.badRequest().body("Log receiver service not available");
            }
            
            List<com.jdwp.client.service.LogReceiverService.LogEntry> logs;
            if (since != null) {
                logs = logReceiverService.getLogsSince(since);
            } else if (thread != null) {
                logs = logReceiverService.getLogsByThread(thread);
            } else if (stream != null) {
                logs = logReceiverService.getLogsByStream(stream);
            } else {
                logs = logReceiverService.getRecentLogs(limit);
            }
            
            // Format logs as continuous text (like IntelliJ console)
            StringBuilder formatted = new StringBuilder();
            java.text.SimpleDateFormat dateFormat = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS");
            
            String lastThread = null;
            boolean inStackTrace = false;
            
            for (com.jdwp.client.service.LogReceiverService.LogEntry entry : logs) {
                // Clean message (remove \r, \n, \t at start)
                String message = entry.message != null ? entry.message : "";
                message = message.replace("\r", "").trim();
                
                // Skip empty messages
                if (message.isEmpty()) {
                    continue;
                }
                
                // Detect stack trace lines
                boolean isStackTraceLine = message.startsWith("\tat ") || message.startsWith("Caused by:") || 
                                          message.startsWith("\t... ") || message.contains("Exception") && message.contains("at ");
                
                // If we're starting a new log entry (not a stack trace continuation)
                if (!isStackTraceLine && inStackTrace) {
                    inStackTrace = false;
                    formatted.append("\n"); // Add blank line after stack trace
                }
                
                if (isStackTraceLine) {
                    inStackTrace = true;
                    // Stack trace line - just append as-is (already has \t)
                    formatted.append(message).append("\n");
                } else {
                    // Regular log line - format it
                    String timestamp = dateFormat.format(new java.util.Date(entry.timestamp));
                    
                    // If message already has full format (timestamp + thread + level), use as-is
                    if (message.matches("^\\d{4}-\\d{2}-\\d{2}.*\\[.*\\].*INFO.*|.*ERROR.*|.*WARN.*|.*DEBUG.*")) {
                        // Already fully formatted - use as-is
                        formatted.append(message).append("\n");
                    } else if (message.startsWith("[") && (message.contains("INFO]") || message.contains("ERROR]") || 
                              message.contains("WARN]") || message.contains("DEBUG]"))) {
                        // Has level but maybe missing timestamp - prepend timestamp
                        formatted.append(timestamp).append(" ").append(message).append("\n");
                    } else {
                        // Plain message - format it
                        String level = entry.stream.equals("stderr") ? "ERROR" : "INFO";
                        formatted.append(timestamp)
                                .append(" [").append(entry.thread).append("] ")
                                .append(level).append(" - ")
                                .append(message).append("\n");
                    }
                }
                
                lastThread = entry.thread;
            }
            
            return ResponseEntity.ok()
                    .header("Content-Type", "text/plain;charset=UTF-8")
                    .body(formatted.toString());
        } catch (Exception e) {
            return ResponseEntity.badRequest().body("Error formatting logs: " + e.getMessage());
        }
    }
    
    /**
     * Trigger class loading in the target VM by doing an HTTP GET to the given URL.
     * Use the target app's base URL + path that hits the controller (e.g. VCP widget endpoint).
     */
    private void triggerClassLoad(String url) {
        try {
            logger.info("[JDWP CLIENT] Triggering class load: GET {}", url);
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url.trim()))
                    .timeout(Duration.ofSeconds(10))
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            logger.info("[JDWP CLIENT] Trigger GET {} -> status {}", url, response.statusCode());
            Thread.sleep(1500);
        } catch (Exception e) {
            logger.warn("[JDWP CLIENT] Trigger GET failed (continuing anyway): {}", e.getMessage());
        }
    }
}

