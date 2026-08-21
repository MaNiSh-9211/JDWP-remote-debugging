package com.debugger;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Kubernetes-native JDWP Debugger Application.
 * 
 * This application provides production-safe debugging capabilities for Java microservices
 * running in Kubernetes. It integrates with Cursor/MCP for AI-assisted debugging.
 * 
 * Key Features:
 * - Thread-only suspension (never VM-wide)
 * - Conditional breakpoints bound to requestId
 * - Kubernetes port-forward for secure JDWP access
 * - Full audit logging
 * - Session timeouts and automatic cleanup
 * 
 * Usage:
 * 1. Deploy this debugger in the Kubernetes cluster
 * 2. Connect MCP/Cursor to the debugger API
 * 3. List pods by service name
 * 4. Create a debug session for a specific pod
 * 5. Send HTTP request with the generated requestId
 * 6. Set conditional breakpoints
 * 7. Wait for breakpoint hit
 * 8. Inspect variables and stack
 * 9. Resume and close session
 */
@SpringBootApplication
@EnableScheduling
public class K8sDebuggerApplication {
    
    public static void main(String[] args) {
        SpringApplication.run(K8sDebuggerApplication.class, args);
    }
}
