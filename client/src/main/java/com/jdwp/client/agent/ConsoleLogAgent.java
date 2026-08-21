package com.jdwp.client.agent;

import java.io.*;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.instrument.UnmodifiableClassException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.ProtectionDomain;
import java.util.concurrent.atomic.AtomicBoolean;
import java.io.StringWriter;

/**
 * Java Agent that intercepts System.out and System.err
 * and streams logs to the JDWP client via socket.
 * 
 * Safety: Never crashes JVM, never blocks output, no dependencies.
 */
public class ConsoleLogAgent {
    private static final AtomicBoolean initialized = new AtomicBoolean(false);
    private static volatile Socket logSocket;
    private static volatile PrintWriter logWriter;
    private static volatile Thread logThread;
    private static final AtomicBoolean running = new AtomicBoolean(false);
    /** Only log "logWriter is null" once to avoid flooding VCP console */
    private static volatile boolean loggedNullWarning;
    
    public static void premain(String agentArgs, Instrumentation inst) {
        agentmain(agentArgs, inst);
    }
    
    public static void agentmain(String agentArgs, Instrumentation inst) {
        // Log immediately to BOTH streams to ensure visibility - FORCE FLUSH
        try {
            System.out.flush();
            System.err.flush();
            System.out.println("========================================");
            System.out.println("[ConsoleLogAgent] ✓✓✓ AGENT AGENTMAIN CALLED ✓✓✓");
            System.out.println("[ConsoleLogAgent] Agent args: " + agentArgs);
            System.out.println("[ConsoleLogAgent] Instrumentation: " + (inst != null ? "OK" : "NULL"));
            System.out.println("[ConsoleLogAgent] Thread: " + Thread.currentThread().getName());
            System.out.println("========================================");
            System.out.flush();
            System.err.println("========================================");
            System.err.println("[ConsoleLogAgent] ✓✓✓ AGENT AGENTMAIN CALLED ✓✓✓");
            System.err.println("[ConsoleLogAgent] Agent args: " + agentArgs);
            System.err.println("[ConsoleLogAgent] Instrumentation: " + (inst != null ? "OK" : "NULL"));
            System.err.println("[ConsoleLogAgent] Thread: " + Thread.currentThread().getName());
            System.err.println("========================================");
            System.err.flush();
        } catch (Throwable t) {
            // If even logging fails, we're in trouble
            try {
                System.err.println("[ConsoleLogAgent] FATAL: Cannot even print to console!");
                t.printStackTrace(System.err);
            } catch (Exception e2) {
                // Give up
            }
        }
        
        // ALWAYS check connection status, even if already initialized
        // This allows reconnection if the first attempt failed
        boolean wasInitialized = initialized.get();
        if (initialized.compareAndSet(false, true)) {
            try {
                // Parse agent args: "host:port" or just port (default localhost)
                String host = "localhost";
                int port = 9999; // Default log receiver port
                
                if (agentArgs != null && !agentArgs.isEmpty()) {
                    if (agentArgs.contains(":")) {
                        String[] parts = agentArgs.split(":", 2);
                        host = parts[0];
                        port = Integer.parseInt(parts[1]);
                    } else {
                        port = Integer.parseInt(agentArgs);
                    }
                }
                
                System.out.println("[ConsoleLogAgent] ✓ Parsed: host=" + host + ", port=" + port);
                System.err.println("[ConsoleLogAgent] ✓ Parsed: host=" + host + ", port=" + port);
                System.out.flush();
                System.err.flush();
                
                System.out.println("[ConsoleLogAgent] ✓ Calling startLogCapture()...");
                System.err.println("[ConsoleLogAgent] ✓ Calling startLogCapture()...");
                System.out.flush();
                System.err.flush();
                
                // Start connection in background - don't wait
                startLogCapture(host, port);
                
                // Wait a moment for connection to establish before intercepting frameworks
                try {
                    Thread.sleep(5000); // Wait 5 seconds for connection
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
                
                // NOW intercept logging frameworks - connection should be ready
                interceptLoggingFrameworks(inst);
                
                System.out.println("[ConsoleLogAgent] ✓ startLogCapture() returned (thread started)");
                System.err.println("[ConsoleLogAgent] ✓ startLogCapture() returned (thread started)");
                System.out.flush();
                System.err.flush();
            } catch (Exception e) {
                // Log to both streams - never crash the JVM
                System.out.println("[ConsoleLogAgent] ❌❌❌ CRITICAL ERROR in agentmain: " + e.getMessage());
                System.err.println("[ConsoleLogAgent] ❌❌❌ CRITICAL ERROR in agentmain: " + e.getMessage());
                e.printStackTrace(System.out);
                e.printStackTrace(System.err);
                System.out.flush();
                System.err.flush();
            }
        } else {
            // Agent already initialized - ALWAYS check connection and retry if needed
            System.out.println("[ConsoleLogAgent] ⚠️⚠️⚠️ Agent already initialized, FORCING connection check...");
            System.err.println("[ConsoleLogAgent] ⚠️⚠️⚠️ Agent already initialized, FORCING connection check...");
            System.out.println("[ConsoleLogAgent] Connection status - logSocket: " + (logSocket != null ? "exists" : "null") + ", closed: " + (logSocket != null ? logSocket.isClosed() : "N/A"));
            System.err.println("[ConsoleLogAgent] Connection status - logSocket: " + (logSocket != null ? "exists" : "null") + ", closed: " + (logSocket != null ? logSocket.isClosed() : "N/A"));
            System.out.flush();
            System.err.flush();
            
            // ALWAYS retry connection if socket is null or closed (connection likely never succeeded)
            boolean needsReconnect = (logSocket == null || logSocket.isClosed() || logWriter == null || (logWriter != null && logWriter.checkError()));
            if (needsReconnect) {
                System.out.println("[ConsoleLogAgent] ⚠️ Connection is dead, attempting to reconnect...");
                System.err.println("[ConsoleLogAgent] ⚠️ Connection is dead, attempting to reconnect...");
                System.out.flush();
                System.err.flush();
                
                // Parse args again
                String host = "localhost";
                int port = 9999;
                if (agentArgs != null && !agentArgs.isEmpty()) {
                    if (agentArgs.contains(":")) {
                        String[] parts = agentArgs.split(":", 2);
                        host = parts[0];
                        port = Integer.parseInt(parts[1]);
                    } else {
                        port = Integer.parseInt(agentArgs);
                    }
                }
                
                // Reset running flag to allow reconnection
                running.set(false);
                // Close old connection if exists
                try {
                    if (logSocket != null && !logSocket.isClosed()) {
                        logSocket.close();
                    }
                } catch (Exception e) {
                    // Ignore
                }
                logSocket = null;
                logWriter = null;
                
                // Retry connection
                startLogCapture(host, port);
            } else {
                System.out.println("[ConsoleLogAgent] ✓ Connection is alive, no action needed");
                System.err.println("[ConsoleLogAgent] ✓ Connection is alive, no action needed");
                System.out.flush();
                System.err.flush();
            }
        }
    }
    
    private static void startLogCapture(String host, int port) {
        System.out.println("[ConsoleLogAgent] startLogCapture() called for " + host + ":" + port);
        System.err.println("[ConsoleLogAgent] startLogCapture() called for " + host + ":" + port);
        System.out.println("[ConsoleLogAgent] running.get() = " + running.get());
        System.err.println("[ConsoleLogAgent] running.get() = " + running.get());
        System.out.flush();
        System.err.flush();
        
        if (running.compareAndSet(false, true)) {
            // Log that we're starting
            System.out.println("[ConsoleLogAgent] ✓ Starting log capture thread for " + host + ":" + port);
            System.err.println("[ConsoleLogAgent] ✓ Starting log capture thread for " + host + ":" + port);
            System.out.flush();
            System.err.flush();
            
            logThread = new Thread(() -> {
                System.out.println("[ConsoleLogAgent] Connection thread STARTED");
                System.err.println("[ConsoleLogAgent] Connection thread STARTED");
                System.out.flush();
                System.err.flush();
                
                int retries = 0;
                int maxRetries = 60; // 60 retries = 30+ seconds total
                long retryDelay = 500; // Start with 500ms
                
                // Wait a bit for log receiver to be ready
                try {
                    System.out.println("[ConsoleLogAgent] Waiting 3 seconds for log receiver to be ready...");
                    System.err.println("[ConsoleLogAgent] Waiting 3 seconds for log receiver to be ready...");
                    System.out.flush();
                    System.err.flush();
                    Thread.sleep(3000); // Wait 3 seconds for receiver to start
                } catch (InterruptedException ie) {
                    System.out.println("[ConsoleLogAgent] Thread interrupted during wait");
                    System.err.println("[ConsoleLogAgent] Thread interrupted during wait");
                    Thread.currentThread().interrupt();
                    running.set(false);
                    return;
                }
                
                while (retries < maxRetries && running.get()) {
                    try {
                        // Log attempt to both streams
                        String attemptMsg = "[ConsoleLogAgent] Attempting to connect to log receiver at " + host + ":" + port + " (attempt " + (retries + 1) + "/" + maxRetries + ")";
                        System.out.println(attemptMsg);
                        System.err.println(attemptMsg);
                        
                        // Connect to log receiver
                        logSocket = new Socket(host, port);
                        logWriter = new PrintWriter(
                            new OutputStreamWriter(logSocket.getOutputStream(), StandardCharsets.UTF_8),
                            true
                        );
                        
                        String successMsg = "[ConsoleLogAgent] ✓✓✓ CONNECTED TO LOG RECEIVER at " + host + ":" + port + " ✓✓✓";
                        System.out.println(successMsg);
                        System.err.println(successMsg);
                        
                        // Send immediate test messages to verify connection works
                        for (int test = 0; test < 10; test++) {
                            sendLog("stdout", "ConsoleLogAgent-ConnectionTest", System.currentTimeMillis(), 
                                    "[ConsoleLogAgent] TEST MESSAGE #" + (test + 1) + " - Connection verified at " + new java.util.Date());
                            Thread.sleep(50);
                        }
                        logWriter.flush();
                        System.out.println("[ConsoleLogAgent] ✓✓✓ Sent 10 test messages to log receiver");
                        System.err.println("[ConsoleLogAgent] ✓✓✓ Sent 10 test messages to log receiver");
                        
                        // Send multiple test messages to verify connection
                        for (int i = 0; i < 3; i++) {
                            sendLog("stdout", Thread.currentThread().getName(), System.currentTimeMillis(), 
                                    "[ConsoleLogAgent] TEST MESSAGE " + (i + 1) + " - Agent connected!");
                            try {
                                Thread.sleep(100);
                            } catch (InterruptedException ie) {
                                Thread.currentThread().interrupt();
                                break;
                            }
                        }
                        
                        // Intercept System.out
                        PrintStream originalOut = System.out;
                        System.setOut(new InterceptingPrintStream(originalOut, "stdout"));

                        // Intercept System.err
                        PrintStream originalErr = System.err;
                        System.setErr(new InterceptingPrintStream(originalErr, "stderr"));
                        
                        String interceptMsg = "[ConsoleLogAgent] ✓ Stream interception active - logs will be captured";
                        // Use original streams since we just replaced them
                        originalOut.println(interceptMsg);
                        originalErr.println(interceptMsg);

                        // Success - break retry loop
                        break;
                    } catch (Exception e) {
                        retries++;
                        String errorMsg = "[ConsoleLogAgent] Connection attempt " + retries + " failed: " + e.getMessage();
                        System.out.println(errorMsg);
                        System.err.println(errorMsg);
                        if (retries < maxRetries) {
                            try {
                                Thread.sleep(retryDelay); // Wait before retry
                                retryDelay = Math.min(retryDelay * 2, 2000); // Exponential backoff, max 2s
                            } catch (InterruptedException ie) {
                                Thread.currentThread().interrupt();
                                break;
                            }
                        } else {
                            // Log to both streams (original, not intercepted) so it's visible
                            String finalError = "[ConsoleLogAgent] ✗ Failed to connect after " + maxRetries + " attempts: " + e.getMessage();
                            System.out.println(finalError);
                            System.err.println(finalError);
                            e.printStackTrace(System.out);
                            e.printStackTrace(System.err);
                            running.set(false);
                        }
                    }
                }
            }, "ConsoleLogAgent-Init");
            logThread.setDaemon(true);
            logThread.start();
        }
    }
    
    private static void sendLog(String stream, String threadName, long timestamp, String message) {
        if (logWriter != null && logSocket != null && !logSocket.isClosed()) {
            try {
                // Format: {"type":"console_log","stream":"stdout","thread":"main","timestamp":1234567890,"message":"text"}
                String json = String.format(
                    "{\"type\":\"console_log\",\"stream\":\"%s\",\"thread\":\"%s\",\"timestamp\":%d,\"message\":%s}",
                    stream,
                    escapeJson(threadName),
                    timestamp,
                    escapeJsonString(message)
                );
                // Use println to ensure newline is sent
                logWriter.println(json);
                logWriter.flush();
            } catch (Exception e) {
                // Log error to stderr so we can see it
                System.err.println("[ConsoleLogAgent] ERROR sending log: " + e.getMessage());
                e.printStackTrace(System.err);
            }
        } else {
            // Log once to avoid flooding; connection may not be ready yet (log receiver on JDWP client:9999).
            if (logWriter == null && !loggedNullWarning) {
                loggedNullWarning = true;
                System.err.println("[ConsoleLogAgent] Log receiver not connected yet (localhost:9999). Logs will buffer until connected or be skipped.");
            }
        }
    }
    
    private static String escapeJson(String str) {
        if (str == null) return "null";
        return str.replace("\\", "\\\\")
                  .replace("\"", "\\\"")
                  .replace("\n", "\\n")
                  .replace("\r", "\\r")
                  .replace("\t", "\\t");
    }
    
    private static String escapeJsonString(String str) {
        return "\"" + escapeJson(str) + "\"";
    }
    
    /**
     * Intercept logging frameworks (Logback/SLF4J) using reflection and bytecode instrumentation
     */
    private static void interceptLoggingFrameworks(Instrumentation inst) {
        if (inst == null) {
            return;
        }
        
        try {
            // Add transformer for bytecode instrumentation with retransform capability
            try {
                inst.addTransformer(new LoggingFrameworkInterceptor(), true);
                System.out.println("[ConsoleLogAgent] ✓ Added ClassFileTransformer (with retransform)");
                System.err.println("[ConsoleLogAgent] ✓ Added ClassFileTransformer (with retransform)");
                
                // Try to retransform Logger class if already loaded
                try {
                    Class<?> loggerClass = Class.forName("ch.qos.logback.classic.Logger");
                    if (inst.isModifiableClass(loggerClass)) {
                        inst.retransformClasses(loggerClass);
                        System.out.println("[ConsoleLogAgent] ✓ Retransformed Logback Logger class");
                        System.err.println("[ConsoleLogAgent] ✓ Retransformed Logback Logger class");
                    } else {
                        System.err.println("[ConsoleLogAgent] ⚠️ Logger class is not modifiable");
                    }
                } catch (Exception e) {
                    System.err.println("[ConsoleLogAgent] Retransform failed (class may not be loaded yet): " + e.getMessage());
                    // That's OK - transformer will catch it when it loads
                }
            } catch (Exception e) {
                System.err.println("[ConsoleLogAgent] Failed to add transformer: " + e.getMessage());
                e.printStackTrace(System.err);
                // Continue without transformer - reflection approach will work
            }
            
            // Try to intercept Logback
            interceptLogback();
            
            // Try to intercept SLF4J
            interceptSLF4J();
            
            // Try to intercept Log4j2
            interceptLog4j2();
            
            System.out.println("[ConsoleLogAgent] ✓ Logging framework interception setup complete");
            System.err.println("[ConsoleLogAgent] ✓ Logging framework interception setup complete");
        } catch (Throwable t) {
            // Never crash - just log and continue
            System.out.println("[ConsoleLogAgent] ⚠️ Logging framework interception failed: " + t.getMessage());
            System.err.println("[ConsoleLogAgent] ⚠️ Logging framework interception failed: " + t.getMessage());
            t.printStackTrace(System.err);
        }
    }
    
    private static void interceptLogback() {
        try {
            // Get SLF4J's ILoggerFactory first
            Class<?> loggerFactoryClass = Class.forName("org.slf4j.LoggerFactory");
            Object iLoggerFactory = loggerFactoryClass.getMethod("getILoggerFactory").invoke(null);
            
            if (iLoggerFactory == null) {
                System.err.println("[ConsoleLogAgent] ILoggerFactory is null");
                return;
            }
            
            // Check if it's a Logback LoggerContext
            Class<?> loggerContextClass = Class.forName("ch.qos.logback.classic.LoggerContext");
            if (!loggerContextClass.isInstance(iLoggerFactory)) {
                System.err.println("[ConsoleLogAgent] Not Logback - ILoggerFactory is: " + iLoggerFactory.getClass().getName());
                return;
            }
            
            Object loggerContext = iLoggerFactory;
            System.out.println("[ConsoleLogAgent] ✓ Found Logback LoggerContext");
            System.err.println("[ConsoleLogAgent] ✓ Found Logback LoggerContext");
            
            // Get root logger
            Object rootLogger = loggerContextClass.getMethod("getLogger", String.class).invoke(loggerContext, "ROOT");
            
            if (rootLogger == null) {
                System.err.println("[ConsoleLogAgent] Root logger is null");
                return;
            }
            
            System.out.println("[ConsoleLogAgent] ✓ Got root logger: " + rootLogger.getClass().getName());
            System.err.println("[ConsoleLogAgent] ✓ Got root logger: " + rootLogger.getClass().getName());
            
            // CRITICAL: Intercept at Logger.callAppenders() level - this is where ALL logs go
            try {
                interceptLoggerCallAppendersMethod(rootLogger);
            } catch (Exception e) {
                System.err.println("[ConsoleLogAgent] Failed to intercept callAppenders: " + e.getMessage());
                e.printStackTrace(System.err);
            }
            
            // Approach 1: Wrap ALL existing appenders - this is the most reliable
            try {
                wrapAllExistingAppenders(rootLogger);
            } catch (Exception e) {
                System.err.println("[ConsoleLogAgent] Failed to wrap appenders: " + e.getMessage());
                e.printStackTrace(System.err);
            }
            
            // Approach 2: Add our own appender
            try {
                Object appender = createRealLogbackAppender();
                if (appender != null) {
                    Class<?> loggerClass = rootLogger.getClass();
                    Class<?> appenderClass = Class.forName("ch.qos.logback.core.Appender");
                    
                    loggerClass.getMethod("addAppender", appenderClass).invoke(rootLogger, appender);
                    
                    // Start the appender
                    appender.getClass().getMethod("start").invoke(appender);
                    
                    System.out.println("[ConsoleLogAgent] ✓✓✓ Custom appender added!");
                    System.err.println("[ConsoleLogAgent] ✓✓✓ Custom appender added!");
                }
            } catch (Exception e) {
                System.err.println("[ConsoleLogAgent] Failed to add appender: " + e.getMessage());
                e.printStackTrace(System.err);
            }
            
            // Approach 3: Add TurboFilter
            try {
                addTurboFilter(loggerContext);
            } catch (Exception e) {
                System.err.println("[ConsoleLogAgent] Failed to add TurboFilter: " + e.getMessage());
                e.printStackTrace(System.err);
            }
            
            System.out.println("[ConsoleLogAgent] ✓✓✓ Logback interception setup complete!");
            System.err.println("[ConsoleLogAgent] ✓✓✓ Logback interception setup complete!");
        } catch (ClassNotFoundException e) {
            // Logback not present - that's OK
            System.out.println("[ConsoleLogAgent] Logback not found, skipping interception");
        } catch (Throwable t) {
            System.err.println("[ConsoleLogAgent] Logback interception error: " + t.getMessage());
            t.printStackTrace(System.err);
        }
    }
    
    private static Object createRealLogbackAppender() {
        try {
            // Use Unsafe to create an instance of AppenderBase
            java.lang.reflect.Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
            unsafeField.setAccessible(true);
            sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
            
            Class<?> appenderBaseClass = Class.forName("ch.qos.logback.core.AppenderBase");
            Object appender = unsafe.allocateInstance(appenderBaseClass);
            
            // Set name
            appenderBaseClass.getMethod("setName", String.class).invoke(appender, "ConsoleLogAgentAppender");
            
            // Create a wrapper that intercepts append calls
            return createAppenderWrapper(appender, appenderBaseClass);
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to create real appender: " + e.getMessage());
            // Fallback to proxy
            return createLogbackAppender();
        }
    }
    
    private static void wrapAllExistingAppenders(Object logger) {
        try {
            Class<?> loggerClass = logger.getClass();
            Class<?> appenderClass = Class.forName("ch.qos.logback.core.Appender");
            
            // Get all appenders
            java.util.Iterator<?> appenderIterator = (java.util.Iterator<?>) loggerClass.getMethod("iteratorForAppenders").invoke(logger);
            
            java.util.List<Object> originalAppenders = new java.util.ArrayList<>();
            while (appenderIterator.hasNext()) {
                originalAppenders.add(appenderIterator.next());
            }
            
            System.out.println("[ConsoleLogAgent] Found " + originalAppenders.size() + " existing appenders to wrap");
            System.err.println("[ConsoleLogAgent] Found " + originalAppenders.size() + " existing appenders to wrap");
            
            // CRITICAL: We need to actually replace the appenders, not just wrap them
            // Logback checks instanceof, so proxies won't work. We need to detach and re-add.
            for (Object originalAppender : originalAppenders) {
                try {
                    String appenderName = (String) originalAppender.getClass().getMethod("getName").invoke(originalAppender);
                    String appenderClassName = originalAppender.getClass().getName();
                    System.out.println("[ConsoleLogAgent] Processing appender: " + appenderName + " (class: " + appenderClassName + ")");
                    System.err.println("[ConsoleLogAgent] Processing appender: " + appenderName + " (class: " + appenderClassName + ")");
                    
                    // Detach the original appender
                    loggerClass.getMethod("detachAppender", appenderClass).invoke(logger, originalAppender);
                    System.out.println("[ConsoleLogAgent] Detached: " + appenderName);
                    System.err.println("[ConsoleLogAgent] Detached: " + appenderName);
                    
                    // Wrap the appender using proxy
                    Object wrappedAppender = wrapAppenderForInterception(originalAppender);
                    if (wrappedAppender != null) {
                        // Add the wrapped appender back
                        loggerClass.getMethod("addAppender", appenderClass).invoke(logger, wrappedAppender);
                        System.out.println("[ConsoleLogAgent] ✓✓✓ Added wrapped appender: " + appenderName);
                        System.err.println("[ConsoleLogAgent] ✓✓✓ Added wrapped appender: " + appenderName);
                    } else {
                        // If wrapping failed, add original back
                        loggerClass.getMethod("addAppender", appenderClass).invoke(logger, originalAppender);
                        System.err.println("[ConsoleLogAgent] ⚠️ Wrapping failed, added original back: " + appenderName);
                    }
                } catch (Exception e) {
                    System.err.println("[ConsoleLogAgent] Failed to wrap appender: " + e.getMessage());
                    e.printStackTrace(System.err);
                    // Try to add original back if we detached it
                    try {
                        loggerClass.getMethod("addAppender", appenderClass).invoke(logger, originalAppender);
                    } catch (Exception e2) {
                        // Ignore
                    }
                }
            }
            
            System.out.println("[ConsoleLogAgent] ✓✓✓ Appender wrapping complete!");
            System.err.println("[ConsoleLogAgent] ✓✓✓ Appender wrapping complete!");
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to wrap appenders: " + e.getMessage());
            e.printStackTrace(System.err);
        }
    }
    
    private static Object wrapAppenderForInterception(Object originalAppender) {
        try {
            Class<?> appenderInterface = Class.forName("ch.qos.logback.core.Appender");
            Class<?> originalClass = originalAppender.getClass();
            
            // Create a proxy that intercepts doAppend calls
            return java.lang.reflect.Proxy.newProxyInstance(
                originalClass.getClassLoader(),
                new Class[]{appenderInterface},
                new java.lang.reflect.InvocationHandler() {
                    @Override
                    public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) throws Throwable {
                        String methodName = method.getName();
                        
                        // Intercept doAppend - this is where logs are written
                        if ("doAppend".equals(methodName) && args != null && args.length > 0) {
                            // Capture the log event FIRST
                            captureLogbackEvent(args[0]);
                            
                            // Then call the original appender
                            try {
                                return method.invoke(originalAppender, args);
                            } catch (Exception e) {
                                return null;
                            }
                        }
                        
                        // For all other methods, delegate to original
                        try {
                            return method.invoke(originalAppender, args);
                        } catch (Exception e) {
                            // Return defaults if invocation fails
                            if (method.getReturnType() == boolean.class) return false;
                            if (method.getReturnType() == int.class) return 0;
                            return null;
                        }
                    }
                }
            );
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to create appender wrapper: " + e.getMessage());
            return null;
        }
    }
    
    private static void wrapExistingAppenders(Object logger) {
        try {
            // Get all appenders from the logger
            Class<?> loggerClass = logger.getClass();
            java.util.Iterator<?> appenders = (java.util.Iterator<?>) loggerClass.getMethod("iteratorForAppenders").invoke(logger);
            
            // Wrap each appender
            while (appenders.hasNext()) {
                Object appender = appenders.next();
                // Wrap the appender to intercept calls
                // This is complex, so we'll skip for now and rely on adding our own appender
            }
        } catch (Exception e) {
            // Ignore
        }
    }
    
    private static void addTurboFilter(Object loggerContext) {
        try {
            // Try to add a TurboFilter to intercept all log events
            Class<?> turboFilterClass = Class.forName("ch.qos.logback.classic.turbo.TurboFilter");
            Class<?> loggerContextClass = loggerContext.getClass();
            
            // Create a REAL TurboFilter instance using Unsafe (since TurboFilter is a class, not interface)
            java.lang.reflect.Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
            unsafeField.setAccessible(true);
            sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
            
            // Allocate instance without calling constructor
            Object turboFilter = unsafe.allocateInstance(turboFilterClass);
            
            // Set name using reflection
            turboFilterClass.getMethod("setName", String.class).invoke(turboFilter, "ConsoleLogAgentTurboFilter");
            
            // Now we need to override the decide method - we'll use a MethodHandle or reflection wrapper
            // Since we can't override methods on an existing instance, we'll intercept at Logger level instead
            // For now, let's try wrapping the Logger's callAppenders method
            
            System.out.println("[ConsoleLogAgent] Created TurboFilter instance (but can't override decide method)");
            System.err.println("[ConsoleLogAgent] Created TurboFilter instance (but can't override decide method)");
            
            // Instead, let's intercept at the Logger level by wrapping callAppenders
            // This will be done by adding appenders to all loggers
            interceptLoggerCallAppenders(loggerContext);
            
            // OLD APPROACH - Create a dynamic TurboFilter using proxy (won't work for class)
            // Commented out - using Logger interception instead
            /*
            java.lang.reflect.InvocationHandler filterHandler = new java.lang.reflect.InvocationHandler() {
                @Override
                public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) throws Throwable {
                    String methodName = method.getName();
                    
                    if ("decide".equals(methodName) && args != null && args.length >= 3) {
                        try {
                            // This is the decide method - capture the log event
                            // Signature: decide(Marker marker, Logger logger, Level level, String msg, Object[] params, Throwable t)
                            Object marker = args.length > 0 ? args[0] : null;
                            Object logger = args.length > 1 ? args[1] : null;
                            Object level = args.length > 2 ? args[2] : null;
                            Object msg = args.length > 3 ? args[3] : null;
                            Object paramArray = args.length > 4 ? args[4] : null;
                            Object throwable = args.length > 5 ? args[5] : null;
                            
                            // Extract logger name - it's a ch.qos.logback.classic.Logger
                            String loggerName = "unknown";
                            if (logger != null) {
                                try {
                                    loggerName = (String) logger.getClass().getMethod("getName").invoke(logger);
                                } catch (Exception e) {
                                    loggerName = logger.toString();
                                }
                            }
                            
                            // Extract level - it's a ch.qos.logback.classic.Level
                            String levelStr = "INFO";
                            if (level != null) {
                                try {
                                    levelStr = level.getClass().getMethod("toString").invoke(level).toString();
                                } catch (Exception e) {
                                    levelStr = level.toString();
                                }
                            }
                            
                            // Extract message
                            String message = "";
                            if (msg != null) {
                                message = msg.toString();
                            }
                            
                            // Format message with parameters if present
                            if (paramArray != null && paramArray instanceof Object[]) {
                                Object[] params = (Object[]) paramArray;
                                if (params.length > 0) {
                                    try {
                                        // Try to format the message with parameters
                                        message = String.format(message.replace("{}", "%s"), params);
                                    } catch (Exception e) {
                                        // If formatting fails, just use the message as-is
                                    }
                                }
                            }
                            
                            // Send to log receiver - ONLY if connection is established
                            if (logWriter != null && logSocket != null && !logSocket.isClosed()) {
                                sendFrameworkLog(levelStr, loggerName, message, throwable instanceof Throwable ? (Throwable) throwable : null);
                            } else {
                                // Connection not ready yet - log to console for debugging
                                System.err.println("[ConsoleLogAgent] TurboFilter: Connection not ready, cannot send log");
                            }
                            
                            // Return NEUTRAL to let other filters process
                            Class<?> filterReplyClass = Class.forName("ch.qos.logback.classic.turbo.TurboFilter$FilterReply");
                            Object neutralValue = filterReplyClass.getMethod("valueOf", String.class).invoke(null, "NEUTRAL");
                            return neutralValue;
                        } catch (Throwable t) {
                            // Never crash - just return NEUTRAL
                            System.err.println("[ConsoleLogAgent] Error in TurboFilter.decide: " + t.getMessage());
                            t.printStackTrace(System.err);
                            try {
                                Class<?> filterReplyClass = Class.forName("ch.qos.logback.classic.turbo.TurboFilter$FilterReply");
                                return filterReplyClass.getMethod("valueOf", String.class).invoke(null, "NEUTRAL");
                            } catch (Exception e) {
                                return null;
                            }
                        }
                    } else if ("getName".equals(methodName)) {
                        return "ConsoleLogAgentTurboFilter";
                    } else if ("setName".equals(methodName)) {
                        return null;
                    } else if ("start".equals(methodName)) {
                        return null;
                    } else if ("stop".equals(methodName)) {
                        return null;
                    }
                    
                    if (method.getReturnType() == boolean.class) return false;
                    if (method.getReturnType() == int.class) return 0;
                    return null;
                }
            };
            
            Object turboFilter = java.lang.reflect.Proxy.newProxyInstance(
                turboFilterClass.getClassLoader(),
                new Class[]{turboFilterClass},
                filterHandler
            );
            */
            
            System.out.println("[ConsoleLogAgent] ✓✓✓ Logger interception setup complete!");
            System.err.println("[ConsoleLogAgent] ✓✓✓ Logger interception setup complete!");
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] TurboFilter/Logger interception failed: " + e.getMessage());
            e.printStackTrace(System.err);
        }
    }
    
    private static void interceptLoggerCallAppenders(Object loggerContext) {
        try {
            // Get all loggers and add our appender to each one
            Class<?> loggerContextClass = loggerContext.getClass();
            
            // Add appender to root logger - this should capture all logs
            Object rootLogger = loggerContextClass.getMethod("getLogger", String.class).invoke(loggerContext, "ROOT");
            if (rootLogger != null) {
                wrapLoggerCallAppenders(rootLogger);
            }
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to intercept Logger.callAppenders: " + e.getMessage());
            e.printStackTrace(System.err);
        }
    }
    
    /**
     * Intercept Logger.callAppenders() method using reflection to wrap it
     * This is the method that Logback calls for EVERY log event
     */
    private static void interceptLoggerCallAppendersMethod(Object logger) {
        try {
            Class<?> loggerClass = logger.getClass();
            Class<?> loggingEventClass = Class.forName("ch.qos.logback.classic.spi.ILoggingEvent");
            
            // Get the callAppenders method
            java.lang.reflect.Method callAppendersMethod = loggerClass.getDeclaredMethod("callAppenders", loggingEventClass);
            callAppendersMethod.setAccessible(true);
            
            // We can't easily override the method, but we can wrap the logger in a proxy
            // Actually, we can't proxy a class. Let's try a different approach:
            // Intercept by wrapping the appender list
            
            System.out.println("[ConsoleLogAgent] Attempted to intercept callAppenders method");
            System.err.println("[ConsoleLogAgent] Attempted to intercept callAppenders method");
            
            // Instead, let's get all appenders and wrap them
            java.util.Iterator<?> appenders = (java.util.Iterator<?>) loggerClass.getMethod("iteratorForAppenders").invoke(logger);
            int appenderCount = 0;
            while (appenders.hasNext()) {
                Object appender = appenders.next();
                appenderCount++;
                String appenderName = (String) appender.getClass().getMethod("getName").invoke(appender);
                System.out.println("[ConsoleLogAgent] Found appender: " + appenderName + " (class: " + appender.getClass().getName() + ")");
                System.err.println("[ConsoleLogAgent] Found appender: " + appenderName + " (class: " + appender.getClass().getName() + ")");
            }
            
            System.out.println("[ConsoleLogAgent] Total appenders found: " + appenderCount);
            System.err.println("[ConsoleLogAgent] Total appenders found: " + appenderCount);
            
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to intercept callAppenders method: " + e.getMessage());
            e.printStackTrace(System.err);
        }
    }
    
    private static void wrapLoggerCallAppenders(Object logger) {
        try {
            Class<?> loggerClass = logger.getClass();
            String loggerName = (String) loggerClass.getMethod("getName").invoke(logger);
            
            // Check if our appender is already added
            java.util.Iterator<?> appenders = (java.util.Iterator<?>) loggerClass.getMethod("iteratorForAppenders").invoke(logger);
            boolean hasOurAppender = false;
            while (appenders.hasNext()) {
                Object appender = appenders.next();
                String appenderName = (String) appender.getClass().getMethod("getName").invoke(appender);
                if ("ConsoleLogAgentAppender".equals(appenderName)) {
                    hasOurAppender = true;
                    break;
                }
            }
            
            if (!hasOurAppender && logWriter != null && logSocket != null && !logSocket.isClosed()) {
                // Add our appender to this logger
                Object appender = createRealLogbackAppender();
                if (appender != null) {
                    Class<?> appenderClass = Class.forName("ch.qos.logback.core.Appender");
                    loggerClass.getMethod("addAppender", appenderClass).invoke(logger, appender);
                    appender.getClass().getMethod("start").invoke(appender);
                    System.out.println("[ConsoleLogAgent] Added appender to logger: " + loggerName);
                    System.err.println("[ConsoleLogAgent] Added appender to logger: " + loggerName);
                }
            }
        } catch (Exception e) {
            // Skip this logger
        }
    }
    
    private static Object createLogbackAppender() {
        try {
            // Create our custom appender class dynamically
            Class<?> appenderBaseClass = Class.forName("ch.qos.logback.core.AppenderBase");
            Class<?> loggingEventClass = Class.forName("ch.qos.logback.classic.spi.ILoggingEvent");
            
            // Use reflection to create an instance of our appender
            // Since we can't load our class directly (it's in the agent), we'll create it dynamically
            return createDynamicLogbackAppender(appenderBaseClass, loggingEventClass);
        } catch (Throwable t) {
            System.err.println("[ConsoleLogAgent] Failed to create Logback appender: " + t.getMessage());
            return null;
        }
    }
    
    private static Object createDynamicLogbackAppender(Class<?> appenderBaseClass, Class<?> loggingEventClass) {
        try {
            // Try to create an instance using Unsafe (works without constructor)
            try {
                java.lang.reflect.Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
                unsafeField.setAccessible(true);
                sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
                
                // Allocate instance without calling constructor
                Object appender = unsafe.allocateInstance(appenderBaseClass);
                
                // Set name using reflection
                appenderBaseClass.getMethod("setName", String.class).invoke(appender, "ConsoleLogAgentAppender");
                
                // Create a wrapper that intercepts append calls
                return createAppenderWrapper(appender, appenderBaseClass);
            } catch (Exception e) {
                // Unsafe approach failed, try proxy approach
                System.err.println("[ConsoleLogAgent] Unsafe approach failed, trying proxy: " + e.getMessage());
            }
            
            // Fallback: Use Proxy approach
            java.lang.reflect.InvocationHandler handler = new java.lang.reflect.InvocationHandler() {
                @Override
                public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) throws Throwable {
                    String methodName = method.getName();
                    
                    if ("doAppend".equals(methodName) && args != null && args.length > 0) {
                        // This is the doAppend method - capture the log event
                        Object event = args[0];
                        captureLogbackEvent(event);
                        return null;
                    } else if ("append".equals(methodName) && args != null && args.length > 0) {
                        // This is the append method - capture the log event
                        Object event = args[0];
                        captureLogbackEvent(event);
                        return null;
                    } else if ("start".equals(methodName)) {
                        // Start the appender - return true to indicate started
                        return true;
                    } else if ("isStarted".equals(methodName)) {
                        return true;
                    } else if ("stop".equals(methodName)) {
                        // Stop the appender
                        return null;
                    } else if ("getName".equals(methodName)) {
                        return "ConsoleLogAgentAppender";
                    } else if ("setName".equals(methodName)) {
                        return null;
                    } else if ("getContext".equals(methodName)) {
                        return null;
                    } else if ("setContext".equals(methodName)) {
                        return null;
                    }
                    
                    // For other methods, return default values
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    } else if (method.getReturnType() == int.class) {
                        return 0;
                    }
                    return null;
                }
            };
            
            // Create proxy for the appender interface
            Class<?> appenderInterface = Class.forName("ch.qos.logback.core.Appender");
            return java.lang.reflect.Proxy.newProxyInstance(
                appenderBaseClass.getClassLoader(),
                new Class[]{appenderInterface},
                handler
            );
        } catch (Throwable t) {
            System.err.println("[ConsoleLogAgent] Failed to create dynamic appender: " + t.getMessage());
            t.printStackTrace(System.err);
            return null;
        }
    }
    
    private static Object createAppenderWrapper(Object appender, Class<?> appenderBaseClass) {
        try {
            // Instead of using Proxy (which won't work well), let's create a real appender
            // that actually writes to the original appender AND captures logs
            return createRealLogbackAppender();
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to create appender wrapper: " + e.getMessage());
            return null;
        }
    }
    
    /**
     * Called from bytecode-instrumented Logback Logger.callAppenders() method
     * This is invoked BEFORE the log event goes to appenders
     */
    public static void captureLogbackEvent(Object event) {
        try {
            // Only capture if connection is ready
            if (logWriter == null || logSocket == null || logSocket.isClosed()) {
                return; // Connection not ready - skip silently
            }
            
            // Extract log information from the event
            Object levelObj = event.getClass().getMethod("getLevel").invoke(event);
            String level = "INFO";
            if (levelObj != null) {
                level = levelObj.getClass().getMethod("toString").invoke(levelObj).toString();
            }
            
            Object loggerNameObj = event.getClass().getMethod("getLoggerName").invoke(event);
            String loggerName = loggerNameObj != null ? loggerNameObj.toString() : "unknown";
            
            Object messageObj = event.getClass().getMethod("getFormattedMessage").invoke(event);
            String message = messageObj != null ? messageObj.toString() : "";
            
            // Get throwable if present
            Throwable throwable = null;
            try {
                Object throwableProxy = event.getClass().getMethod("getThrowableProxy").invoke(event);
                if (throwableProxy != null) {
                    Object throwableObj = throwableProxy.getClass().getMethod("getThrowable").invoke(throwableProxy);
                    if (throwableObj instanceof Throwable) {
                        throwable = (Throwable) throwableObj;
                    }
                }
            } catch (Exception e) {
                // No throwable - that's OK
            }
            
            // Send to log receiver
            sendFrameworkLog(level, loggerName, message, throwable);
        } catch (Throwable t) {
            // Never crash - silently drop
            System.err.println("[ConsoleLogAgent] Error in captureLogbackEvent: " + t.getMessage());
            t.printStackTrace(System.err);
        }
    }
    
    private static void interceptSLF4J() {
        try {
            // Intercept SLF4J by wrapping Logger instances
            Class<?> loggerFactoryClass = Class.forName("org.slf4j.LoggerFactory");
            Class<?> loggerInterface = Class.forName("org.slf4j.Logger");
            
            // Get the ILoggerFactory field
            java.lang.reflect.Field iLoggerFactoryField = loggerFactoryClass.getDeclaredField("iLoggerFactory");
            iLoggerFactoryField.setAccessible(true);
            Object originalFactory = iLoggerFactoryField.get(null);
            
            // Create a wrapper factory that returns wrapped loggers
            Object wrappedFactory = java.lang.reflect.Proxy.newProxyInstance(
                originalFactory.getClass().getClassLoader(),
                new Class[]{Class.forName("org.slf4j.ILoggerFactory")},
                new java.lang.reflect.InvocationHandler() {
                    @Override
                    public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) throws Throwable {
                        if ("getLogger".equals(method.getName()) && args != null && args.length > 0) {
                            // Get the original logger
                            Object originalLogger = method.invoke(originalFactory, args);
                            
                            // Wrap it to intercept all log calls
                            return wrapSLF4JLogger(originalLogger, loggerInterface);
                        }
                        // Delegate all other calls
                        return method.invoke(originalFactory, args);
                    }
                }
            );
            
            // Replace the factory
            iLoggerFactoryField.set(null, wrappedFactory);
            
            System.out.println("[ConsoleLogAgent] ✓✓✓ SLF4J LoggerFactory wrapped - ALL LOGS WILL BE CAPTURED!");
            System.err.println("[ConsoleLogAgent] ✓✓✓ SLF4J LoggerFactory wrapped - ALL LOGS WILL BE CAPTURED!");
        } catch (NoSuchFieldException e) {
            // Field might not exist in this SLF4J version - that's OK
            System.out.println("[ConsoleLogAgent] SLF4J found, but can't wrap factory (using Logback interception)");
        } catch (ClassNotFoundException e) {
            // SLF4J not present - that's OK
        } catch (Throwable t) {
            System.err.println("[ConsoleLogAgent] SLF4J interception error: " + t.getMessage());
            t.printStackTrace(System.err);
        }
    }
    
    private static Object wrapSLF4JLogger(Object originalLogger, Class<?> loggerInterface) {
        try {
            return java.lang.reflect.Proxy.newProxyInstance(
                originalLogger.getClass().getClassLoader(),
                new Class[]{loggerInterface},
                new java.lang.reflect.InvocationHandler() {
                    @Override
                    public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) throws Throwable {
                        String methodName = method.getName();
                        
                        // Intercept all log methods: trace, debug, info, warn, error
                        if (("trace".equals(methodName) || "debug".equals(methodName) || 
                             "info".equals(methodName) || "warn".equals(methodName) || 
                             "error".equals(methodName)) && args != null && args.length > 0) {
                            
                            // Extract message
                            String message = args[0] != null ? args[0].toString() : "";
                            
                            // Extract throwable if present
                            Throwable throwable = null;
                            if (args.length > 1 && args[args.length - 1] instanceof Throwable) {
                                throwable = (Throwable) args[args.length - 1];
                            }
                            
                            // Get logger name
                            String loggerName = (String) originalLogger.getClass().getMethod("getName").invoke(originalLogger);
                            
                            // Send to log receiver
                            sendFrameworkLog(methodName.toUpperCase(), loggerName, message, throwable);
                        }
                        
                        // Always call the original logger
                        return method.invoke(originalLogger, args);
                    }
                }
            );
        } catch (Exception e) {
            System.err.println("[ConsoleLogAgent] Failed to wrap SLF4J logger: " + e.getMessage());
            return originalLogger;
        }
    }
    
    private static void interceptLog4j2() {
        try {
            Class<?> logManagerClass = Class.forName("org.apache.logging.log4j.LogManager");
            // Try to intercept Log4j2
        } catch (ClassNotFoundException e) {
            // Log4j2 not present - that's OK
        } catch (Throwable t) {
            // Ignore
        }
    }
    
    /**
     * Send a log entry from any logging framework
     */
    public static void sendFrameworkLog(String level, String loggerName, String message, Throwable throwable) {
        String fullMessage = message;
        if (throwable != null) {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            throwable.printStackTrace(pw);
            fullMessage = message + "\n" + sw.toString();
        }
        
        // Determine stream based on level
        String stream = "stdout";
        if ("ERROR".equals(level) || "FATAL".equals(level) || "WARN".equals(level)) {
            stream = "stderr";
        }
        
        sendLog(stream, Thread.currentThread().getName(), System.currentTimeMillis(), 
                "[" + level + "] " + loggerName + " - " + fullMessage);
    }
    
    /**
     * Intercepting PrintStream that captures output and forwards to log receiver
     */
    private static class InterceptingPrintStream extends PrintStream {
        private final PrintStream original;
        private final String streamName;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        private final ThreadLocal<ByteArrayOutputStream> threadBuffer = ThreadLocal.withInitial(ByteArrayOutputStream::new);
        
        public InterceptingPrintStream(PrintStream original, String streamName) {
            super(original);
            this.original = original;
            this.streamName = streamName;
        }
        
        @Override
        public void write(int b) {
            original.write(b);
            ByteArrayOutputStream buf = threadBuffer.get();
            if (b == '\n') {
                flushBuffer(buf);
            } else {
                buf.write(b);
            }
        }
        
        @Override
        public void write(byte[] buf, int off, int len) {
            original.write(buf, off, len);
            ByteArrayOutputStream threadBuf = threadBuffer.get();
            for (int i = off; i < off + len; i++) {
                if (buf[i] == '\n') {
                    flushBuffer(threadBuf);
                } else {
                    threadBuf.write(buf[i]);
                }
            }
        }
        
        @Override
        public void println(String x) {
            original.println(x);
            if (x != null) {
                sendLog(streamName, Thread.currentThread().getName(), System.currentTimeMillis(), x);
            }
        }
        
        @Override
        public void print(String s) {
            original.print(s);
            // Buffer until newline
            ByteArrayOutputStream buf = threadBuffer.get();
            try {
                if (s != null) {
                    buf.write(s.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                // Ignore
            }
        }
        
        private void flushBuffer(ByteArrayOutputStream buf) {
            if (buf.size() > 0) {
                try {
                    String message = buf.toString(StandardCharsets.UTF_8);
                    sendLog(streamName, Thread.currentThread().getName(), System.currentTimeMillis(), message);
                    buf.reset();
                } catch (Exception e) {
                    // Drop log silently
                }
            }
        }
        
        @Override
        public void flush() {
            original.flush();
            ByteArrayOutputStream buf = threadBuffer.get();
            if (buf.size() > 0) {
                flushBuffer(buf);
            }
        }
    }
}
