package com.jdwp.client.security;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Lightweight API-token authentication for the debug client.
 *
 * <p>The debug client can attach to any reachable JVM, so when it is exposed
 * beyond localhost it MUST be protected. Set {@code jdwp.api-token} (env
 * {@code JDWP_API_TOKEN}) to enable: every /api request (except a small
 * health allow-list) must then carry the token in the {@code X-Debug-Token}
 * header or as {@code Authorization: Bearer <token>}.</p>
 *
 * <p>When no token is configured the filter is a no-op (local development).</p>
 */
public class ApiTokenAuthFilter implements Filter {

    /** Endpoints that are safe to expose unauthenticated (liveness only). */
    private static final Set<String> PUBLIC_PATHS = new HashSet<>(Arrays.asList(
            "/api/debug/ping"
    ));

    private final byte[] expectedToken;

    public ApiTokenAuthFilter(String expectedToken) {
        this.expectedToken = expectedToken == null ? null : expectedToken.getBytes(StandardCharsets.UTF_8);
    }

    public boolean isEnabled() {
        return expectedToken != null && expectedToken.length > 0;
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (!isEnabled()) {
            chain.doFilter(request, response);
            return;
        }

        HttpServletRequest req = (HttpServletRequest) request;
        HttpServletResponse res = (HttpServletResponse) response;
        String path = req.getRequestURI();

        if (PUBLIC_PATHS.contains(path)) {
            chain.doFilter(request, response);
            return;
        }

        if (requestAuthorized(req)) {
            chain.doFilter(request, response);
            return;
        }

        res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        res.setContentType("application/json");
        res.getWriter().write("{\"success\":false,\"message\":\"Unauthorized: missing or invalid X-Debug-Token\"}");
    }

    /** Extracts the presented token and compares it in constant time. Always true when auth is disabled. */
    public boolean requestAuthorized(HttpServletRequest req) {
        if (!isEnabled()) {
            return true;
        }
        String provided = req.getHeader("X-Debug-Token");
        if (provided == null || provided.isEmpty()) {
            String authorization = req.getHeader("Authorization");
            if (authorization != null && authorization.startsWith("Bearer ")) {
                provided = authorization.substring("Bearer ".length()).trim();
            }
        }
        return provided != null && constantTimeEquals(provided.getBytes(StandardCharsets.UTF_8), expectedToken);
    }

    /** Constant-time comparison to avoid timing attacks. */
    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        return MessageDigest.isEqual(a, b);
    }
}
