package com.jdwp.client.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Central security configuration for the debug client.
 *
 * <p>CORS is locked down to explicit origins (comma separated) via
 * {@code jdwp.cors-allowed-origins} (env {@code JDWP_CORS_ALLOWED_ORIGINS}).
 * Defaults to the local Electron app and Vite dev server.</p>
 */
@Configuration
public class SecurityConfig {

    @Value("${jdwp.api-token:}")
    private String apiToken;

    @Value("${jdwp.cors-allowed-origins:http://localhost:5177,http://localhost:3000,http://localhost:8083}")
    private String corsAllowedOrigins;

    @Bean
    public FilterRegistrationBean<ApiTokenAuthFilter> apiTokenAuthFilter() {
        FilterRegistrationBean<ApiTokenAuthFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(new ApiTokenAuthFilter(apiToken));
        registration.addUrlPatterns("/api/*");
        registration.setOrder(1);
        return registration;
    }

    @Bean
    public WebMvcConfigurer corsConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/api/**")
                        .allowedOrigins(corsAllowedOrigins.split(","))
                        .allowedMethods("GET", "POST", "DELETE", "OPTIONS")
                        .allowedHeaders("*")
                        .maxAge(3600);
            }
        };
    }
}
