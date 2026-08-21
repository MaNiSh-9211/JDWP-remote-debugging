package com.jdwp.server.debug;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Exposes {@code debugRequestId} as a local for the filter stack frame so the JDWP client can
 * correlate breakpoints with {@code X-Debug-Request-Id} and auto-resume other requests.
 */
public class DebugRequestFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(DebugRequestFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String raw = request.getHeader("X-Debug-Request-Id");
        String debugRequestId = raw != null ? raw.trim() : "";
        // Keep debugRequestId live across doFilter so it stays in this frame's local table for JDI.
        if (log.isTraceEnabled()) {
            log.trace("X-Debug-Request-Id len={}", debugRequestId.length());
        }
        filterChain.doFilter(request, response);
    }
}
