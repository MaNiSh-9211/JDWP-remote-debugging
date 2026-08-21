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
 * - CORS locked to explicit origins ({@code jdwp.cors-allowed-origins})
 * - Optional API token auth ({@code jdwp.api-token}) with per-IP brute-force lockout
 * - Optional JDWP target allow-list ({@code jdwp.allowed-targets}) enforced in the controller
 */
@Configuration
public class SecurityConfig {

    @Value("${jdwp.api-token:}")
    private String apiToken;

    @Value("${jdwp.cors-allowed-origins:http://localhost:5177,http://localhost:3000,http://localhost:8083}")
    private String corsAllowedOrigins;

    @Value("${jdwp.allowed-targets:}")
    private String allowedTargets;

    @Bean
    public TargetAllowList targetAllowList() {
        return TargetAllowList.parse(allowedTargets);
    }

    @Bean
    public ApiTokenAuthFilter apiTokenAuthFilter() {
        return new ApiTokenAuthFilter(apiToken);
    }

    @Bean
    public FilterRegistrationBean<AuthRateLimitFilter> authRateLimitFilter(ApiTokenAuthFilter tokenFilter) {
        // Runs BEFORE the auth filter; when auth is disabled it is a pass-through.
        FilterRegistrationBean<AuthRateLimitFilter> reg = new FilterRegistrationBean<>();
        reg.setFilter(new AuthRateLimitFilter(tokenFilter));
        reg.addUrlPatterns("/api/*");
        reg.setOrder(0);
        return reg;
    }

    @Bean
    public FilterRegistrationBean<ApiTokenAuthFilter> registerApiTokenAuthFilter(ApiTokenAuthFilter tokenFilter) {
        FilterRegistrationBean<ApiTokenAuthFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(tokenFilter);
        registration.addUrlPatterns("/api/*");
        registration.setOrder(1);
        return registration;
    }

    @Bean
    public WebMvcConfigurer corsConfigurer(com.jdwp.client.service.SessionActivityTracker activityTracker) {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/api/**")
                        .allowedOrigins(corsAllowedOrigins.split(","))
                        .allowedMethods("GET", "POST", "DELETE", "OPTIONS")
                        .allowedHeaders("*")
                        .maxAge(3600);
            }

            @Override
            public void addInterceptors(org.springframework.web.servlet.config.annotation.InterceptorRegistry registry) {
                // Track API activity for the idle-session watchdog.
                registry.addInterceptor(activityTracker).addPathPatterns("/api/**");
            }
        };
    }
}
