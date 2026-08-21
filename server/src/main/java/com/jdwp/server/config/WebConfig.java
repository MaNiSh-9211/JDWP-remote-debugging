package com.jdwp.server.config;

import com.jdwp.server.debug.DebugRequestFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

@Configuration
public class WebConfig {

    @Bean
    public FilterRegistrationBean<DebugRequestFilter> debugRequestFilterRegistration() {
        FilterRegistrationBean<DebugRequestFilter> reg = new FilterRegistrationBean<>(new DebugRequestFilter());
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE);
        reg.addUrlPatterns("/*");
        return reg;
    }
}
