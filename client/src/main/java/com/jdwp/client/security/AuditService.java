package com.jdwp.client.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Append-only JSONL audit trail for privileged debug actions
 * (attach, detach, breakpoints, agent loading, evaluation).
 *
 * One JSON object per line at {@code logs/audit.jsonl} (configurable via
 * {@code jdwp.audit.file}). Writes happen on a background thread so debug
 * operations are never blocked by disk I/O. Failures are logged, never thrown.
 */
@Service
public class AuditService {

    private static final Logger logger = LoggerFactory.getLogger(AuditService.class);
    private static final Logger auditLog = LoggerFactory.getLogger("AUDIT");

    private final Path filePath;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutorService writer = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "audit-writer");
        t.setDaemon(true);
        return t;
    });

    public AuditService(@Value("${jdwp.audit.file:logs/audit.jsonl}") String file) {
        this.filePath = Path.of(file);
        try {
            Files.createDirectories(filePath.toAbsolutePath().getParent());
        } catch (IOException e) {
            logger.warn("Could not create audit directory {}: {}", filePath.getParent(), e.getMessage());
        }
    }

    /** Fire-and-forget audit event. */
    public void log(String action, Map<String, ?> detail) {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("timestamp", Instant.now().toString());
        record.put("action", action);
        if (detail != null) {
            record.put("detail", detail);
        }
        writer.execute(() -> append(record));
    }

    private void append(Map<String, Object> record) {
        try {
            String line = mapper.writeValueAsString(record);
            // Also mirror into the application log so audits survive log shipping.
            auditLog.info(line);
            Files.writeString(filePath, line + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException | IllegalArgumentException e) {
            logger.warn("Audit write failed: {}", e.getMessage());
        }
    }

    @PreDestroy
    public void shutdown() {
        writer.shutdown();
        try {
            writer.awaitTermination(3, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
