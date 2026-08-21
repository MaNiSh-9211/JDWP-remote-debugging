package com.debugger.agent;

import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.matcher.ElementMatchers;

import java.lang.instrument.Instrumentation;

/**
 * Java Agent for Request-ID Based Selective Debugging.
 * 
 * ZERO CODE CHANGES REQUIRED!
 * 
 * Usage: Add to JVM options in Dockerfile:
 *   -javaagent:/app/debug-agent.jar
 * 
 * How it works:
 * 1. Agent intercepts ServletContext.addFilter() during startup
 * 2. Injects our DebugFilter BEFORE any other filters
 * 3. DebugFilter checks for X-Debug-Request-Id header
 * 4. Only requests WITH the header call debugPausePoint()
 * 5. Set JDWP breakpoint on debugPausePoint() - normal traffic unaffected!
 */
public class DebugAgent {
    
    private static boolean initialized = false;
    
    /**
     * Called by JVM when agent is loaded via -javaagent
     */
    public static void premain(String agentArgs, Instrumentation inst) {
        System.out.println("╔════════════════════════════════════════════════════════════╗");
        System.out.println("║  DEBUG AGENT - Selective Debugging Enabled                 ║");
        System.out.println("║                                                            ║");
        System.out.println("║  Send requests with 'X-Debug-Request-Id' header to debug   ║");
        System.out.println("║  Normal requests will NOT be affected!                     ║");
        System.out.println("╚════════════════════════════════════════════════════════════╝");
        
        install(inst);
    }
    
    /**
     * Called when agent is attached dynamically
     */
    public static void agentmain(String agentArgs, Instrumentation inst) {
        System.out.println("[DEBUG-AGENT] Attached dynamically");
        install(inst);
    }
    
    private static void install(Instrumentation inst) {
        if (initialized) {
            System.out.println("[DEBUG-AGENT] Already initialized, skipping");
            return;
        }
        initialized = true;
        
        // Use Byte Buddy to intercept HTTP request processing
        new AgentBuilder.Default()
            .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
            .type(ElementMatchers.named("org.apache.catalina.core.ApplicationFilterChain"))
            .transform((builder, type, classLoader, module, protectionDomain) -> 
                builder.visit(Advice.to(FilterChainAdvice.class)
                    .on(ElementMatchers.named("doFilter")))
            )
            .installOn(inst);
        
        System.out.println("[DEBUG-AGENT] Installed filter chain interceptor");
    }
    
    /**
     * Advice class that intercepts the filter chain
     */
    public static class FilterChainAdvice {
        
        @Advice.OnMethodEnter
        public static void onEnter(
                @Advice.Argument(0) Object request,
                @Advice.Argument(1) Object response) {
            
            try {
                // Check if this is an HttpServletRequest
                if (request != null && request.getClass().getName().contains("Request")) {
                    // Use reflection to get the header (avoids classloader issues)
                    java.lang.reflect.Method getHeader = request.getClass().getMethod("getHeader", String.class);
                    String debugRequestId = (String) getHeader.invoke(request, "X-Debug-Request-Id");
                    
                    if (debugRequestId != null && !debugRequestId.isEmpty()) {
                        // This is a debug request!
                        String threadName = Thread.currentThread().getName();
                        
                        // Store in ThreadLocal for later access
                        DebugContext.set(debugRequestId, threadName);
                        
                        // Get request URI for logging
                        java.lang.reflect.Method getRequestURI = request.getClass().getMethod("getRequestURI");
                        String uri = (String) getRequestURI.invoke(request);
                        
                        java.lang.reflect.Method getMethod = request.getClass().getMethod("getMethod");
                        String method = (String) getMethod.invoke(request);
                        
                        // Call the pause point - SET BREAKPOINT HERE!
                        DebugContext.debugPausePoint(debugRequestId, method, uri, threadName);
                    }
                }
            } catch (Exception e) {
                // Silently ignore - don't break the application
            }
        }
        
        @Advice.OnMethodExit
        public static void onExit() {
            // Clear context after request completes
            DebugContext.clear();
        }
    }
}
