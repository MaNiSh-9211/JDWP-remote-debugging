package com.jdwp.client.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Production safety: a JDWP attach left idle keeps debugger hooks and
 * (potentially) suspended threads alive on the target. When enabled, this
 * watchdog disconnects sessions that have seen no API activity for
 * {@code jdwp.session-idle-timeout-minutes} (default 30; 0 disables).
 *
 * Activity is tracked by {@link SessionActivityTracker} on every /api/debug call.
 */
@Component
public class IdleSessionWatchdog {

    private static final Logger logger = LoggerFactory.getLogger(IdleSessionWatchdog.class);

    private final JdwpService jdwpService;
    private final SessionActivityTracker activity;
    private final long idleTimeoutMinutes;

    public IdleSessionWatchdog(
            JdwpService jdwpService,
            SessionActivityTracker activity,
            @Value("${jdwp.session-idle-timeout-minutes:30}") long idleTimeoutMinutes) {
        this.jdwpService = jdwpService;
        this.activity = activity;
        this.idleTimeoutMinutes = idleTimeoutMinutes;
    }

    @Scheduled(fixedDelayString = "60000", initialDelayString = "120000")
    public void disconnectIfIdle() {
        if (idleTimeoutMinutes <= 0) {
            return;
        }
        if (!jdwpService.isConnected()) {
            return;
        }
        long idleMs = System.currentTimeMillis() - activity.lastActivityMillis();
        if (idleMs > idleTimeoutMinutes * 60_000L) {
            logger.warn("[JDWP CLIENT] Session idle for {} min (> {} min) — auto-disconnecting for production safety",
                    idleMs / 60_000, idleTimeoutMinutes);
            try {
                // Resume any suspended threads first so we don't leave traffic paused.
                jdwpService.continueExecution();
            } catch (Exception e) {
                logger.debug("Continue before idle-disconnect failed: {}", e.getMessage());
            }
            try {
                jdwpService.disconnect();
            } catch (Exception e) {
                logger.warn("Idle disconnect failed: {}", e.getMessage());
            }
        }
    }
}
