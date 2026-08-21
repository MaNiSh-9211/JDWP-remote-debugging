package com.jdwp.client.service;

import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Records the timestamp of the last /api/debug request so the
 * {@link IdleSessionWatchdog} can auto-disconnect idle JDWP sessions.
 */
@Component
public class SessionActivityTracker implements HandlerInterceptor {

    private volatile long lastActivity = System.currentTimeMillis();

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request,
                             @NonNull HttpServletResponse response,
                             @NonNull Object handler) {
        lastActivity = System.currentTimeMillis();
        return true;
    }

    public long lastActivityMillis() {
        return lastActivity;
    }
}
