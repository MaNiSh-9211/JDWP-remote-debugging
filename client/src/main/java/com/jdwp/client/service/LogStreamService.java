package com.jdwp.client.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Broadcasts log entries to connected SSE clients (live console in the desktop app).
 */
@Service
public class LogStreamService {
    private static final Logger logger = LoggerFactory.getLogger(LogStreamService.class);
    private final CopyOnWriteArrayList<SseEmitter> emitters = new CopyOnWriteArrayList<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(0L);
        emitters.add(emitter);
        emitter.onCompletion(() -> emitters.remove(emitter));
        emitter.onTimeout(() -> emitters.remove(emitter));
        emitter.onError(e -> emitters.remove(emitter));
        return emitter;
    }

    public void broadcast(LogReceiverService.LogEntry entry) {
        if (emitters.isEmpty() || entry == null) {
            return;
        }
        try {
            String json = objectMapper.writeValueAsString(toMap(entry));
            for (SseEmitter em : emitters) {
                try {
                    em.send(SseEmitter.event().data(json, MediaType.APPLICATION_JSON));
                } catch (Exception ex) {
                    emitters.remove(em);
                }
            }
        } catch (Exception e) {
            logger.debug("[LOG STREAM] broadcast skip: {}", e.getMessage());
        }
    }

    private static Map<String, Object> toMap(LogReceiverService.LogEntry e) {
        Map<String, Object> m = new HashMap<>();
        m.put("timestamp", e.timestamp);
        m.put("thread", e.thread);
        m.put("stream", e.stream);
        m.put("type", e.type);
        m.put("message", e.message);
        m.put("className", e.className);
        m.put("methodName", e.methodName);
        m.put("lineNumber", e.lineNumber);
        return m;
    }
}
