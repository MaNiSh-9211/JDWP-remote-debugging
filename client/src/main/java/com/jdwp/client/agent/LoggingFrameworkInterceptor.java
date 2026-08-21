package com.jdwp.client.agent;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.IllegalClassFormatException;
import java.security.ProtectionDomain;

/**
 * Bytecode transformer to intercept logging framework calls using ASM
 */
public class LoggingFrameworkInterceptor implements ClassFileTransformer {
    private static final LoggingFrameworkInterceptor instance = new LoggingFrameworkInterceptor();
    
    public static LoggingFrameworkInterceptor getInstance() {
        return instance;
    }
    
    @Override
    public byte[] transform(ClassLoader loader, String className, Class<?> classBeingRedefined,
                           ProtectionDomain protectionDomain, byte[] classfileBuffer)
            throws IllegalClassFormatException {
        try {
            // Intercept Logback Logger's callAppenders method
            if (className != null) {
                String normalizedName = className.replace('/', '.');
                
                // Intercept Logback's Logger.callAppenders() - this is where all logs go
                if (normalizedName.equals("ch.qos.logback.classic.Logger")) {
                    return transformLogbackLogger(classfileBuffer);
                }
            }
        } catch (Throwable t) {
            // Never crash - silently fail
            System.err.println("[LoggingFrameworkInterceptor] Error transforming: " + t.getMessage());
        }
        return null; // Return null means no transformation
    }
    
    private byte[] transformLogbackLogger(byte[] classfileBuffer) {
        // ASM transformation disabled - using reflection approach instead
        // ASMTransformer requires ASM at compile time, which conflicts with Maven build
        // The reflection-based appender wrapping in ConsoleLogAgent should work
        return null;
    }
}
