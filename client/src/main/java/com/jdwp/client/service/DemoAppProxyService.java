package com.jdwp.client.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Demo app HTTP base URL used by {@code /api/server/**} proxy; can be changed at runtime from the desktop app.
 */
@Service
public class DemoAppProxyService {

    private final AtomicReference<String> baseUrl;

    public DemoAppProxyService(@Value("${jdwp.demo-app-base-url:http://localhost:8081}") String initial) {
        this.baseUrl = new AtomicReference<>(normalize(initial));
    }

    public String getBaseUrl() {
        return baseUrl.get();
    }

    public void setBaseUrl(String raw) {
        baseUrl.set(normalize(validateLocalHttp(raw)));
    }

    private static String normalize(String u) {
        if (u == null || u.isBlank()) {
            return "http://localhost:8081";
        }
        String t = u.trim().replaceAll("/$", "");
        return t;
    }

    /** Only localhost / loopback — same policy as the Electron API base validator. */
    private static String validateLocalHttp(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("baseUrl is required");
        }
        URI uri;
        try {
            uri = URI.create(raw.trim());
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid URL: " + e.getMessage());
        }
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            throw new IllegalArgumentException("Only http/https allowed");
        }
        String host = uri.getHost();
        if (host == null) {
            throw new IllegalArgumentException("Host required");
        }
        String h = host.toLowerCase();
        if (!h.equals("localhost") && !h.equals("127.0.0.1") && !h.equals("[::1]")) {
            throw new IllegalArgumentException("Only localhost targets allowed");
        }
        return raw.trim();
    }
}
