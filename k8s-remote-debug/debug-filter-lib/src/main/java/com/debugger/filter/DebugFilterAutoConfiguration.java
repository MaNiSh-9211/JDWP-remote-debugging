package com.debugger.filter;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.ComponentScan;

import jakarta.servlet.Filter;

/**
 * Spring Boot Auto-Configuration for the Debug Request Filter.
 * 
 * This class enables ZERO CODE CHANGES in your application:
 * - Just include the JAR as a dependency
 * - The filter auto-registers via component scanning
 * - No configuration needed in your app
 */
@AutoConfiguration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnClass(Filter.class)
@ComponentScan(basePackages = "com.debugger.filter")
public class DebugFilterAutoConfiguration {
    // Component scanning registers DebugRequestFilter and DebugEndpointController
    // via their @Component and @RestController annotations
}
