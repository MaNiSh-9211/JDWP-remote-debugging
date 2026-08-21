package com.jdwp.client.security;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Brute-force protection for token-authenticated endpoints.
 *
 * Tracks failed authentication attempts per client IP. After
 * {@code maxFailures} within {@code windowMs}, the IP is locked out for
 * {@code lockoutMs}. Successful auth clears the counter.
 */
public class AuthRateLimitFilter implements Filter {

    private static final int MAX_FAILURES = Integer.getInteger("jdwp.auth.max-failures", 5);
    private static final long WINDOW_MS = Long.getLong("jdwp.auth.window-ms", 60_000L);
    private static final long LOCKOUT_MS = Long.getLong("jdwp.auth.lockout-ms", 300_000L);

    private record Failures(AtomicInteger count, long windowStart, long lockedUntil) {}

    private final Map<String, Failures> failuresByIp = new ConcurrentHashMap<>();
    private final ApiTokenAuthFilter tokenFilter;

    public AuthRateLimitFilter(ApiTokenAuthFilter tokenFilter) {
        this.tokenFilter = tokenFilter;
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (!tokenFilter.isEnabled()) {
            // No token configured — nothing to brute-force.
            chain.doFilter(request, response);
            return;
        }
        HttpServletRequest req = (HttpServletRequest) request;
        HttpServletResponse res = (HttpServletResponse) response;
        String ip = clientIp(req);

        // Enforce lockout even before checking credentials.
        if (isLockedOut(ip)) {
            res.setStatus(429);
            res.setContentType("application/json");
            res.getWriter().write("{\"success\":false,\"message\":\"Too many failed attempts — try again later\"}");
            return;
        }

        if (tokenFilter.requestAuthorized(req)) {
            failuresByIp.remove(ip); // successful auth resets the counter
            chain.doFilter(request, response);
            return;
        }

        recordFailure(ip);
        res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        res.setContentType("application/json");
        res.getWriter().write("{\"success\":false,\"message\":\"Unauthorized: missing or invalid X-Debug-Token\"}");
    }

    private boolean isLockedOut(String ip) {
        Failures f = failuresByIp.get(ip);
        if (f == null) return false;
        return System.currentTimeMillis() < f.lockedUntil();
    }

    private void recordFailure(String ip) {
        long now = System.currentTimeMillis();
        failuresByIp.compute(ip, (k, existing) -> {
            if (existing == null || now - existing.windowStart() > WINDOW_MS) {
                return new Failures(new AtomicInteger(1), now, 0L);
            }
            int n = existing.count().incrementAndGet();
            long lockedUntil = n >= MAX_FAILURES ? now + LOCKOUT_MS : existing.lockedUntil();
            return new Failures(existing.count(), existing.windowStart(), lockedUntil);
        });
        // Opportunistic cleanup so the map cannot grow unbounded.
        if (failuresByIp.size() > 10_000) {
            failuresByIp.entrySet().removeIf(e -> System.currentTimeMillis() > e.getValue().lockedUntil());
        }
    }

    /** Trust X-Forwarded-For only as a hint; rightmost untrusted entry wins otherwise. */
    private static String clientIp(HttpServletRequest req) {
        String fwd = req.getHeader("X-Forwarded-For");
        if (fwd != null && !fwd.isBlank()) {
            List<String> parts = List.of(fwd.split(","));
            return parts.get(parts.size() - 1).trim();
        }
        return req.getRemoteAddr();
    }
}
