package com.jdwp.client.controller;

import com.jdwp.client.service.DemoAppProxyService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.*;
import org.springframework.util.CollectionUtils;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;

import java.util.*;

@RestController
@RequestMapping("/api/server")

public class ServerApiController {

    @Autowired
    private DemoAppProxyService demoAppProxyService;

    /**
     * No read/connect timeout so proxy calls can outlast JDWP pauses (demo thread blocked at breakpoint for a long time).
     */
    private final RestTemplate restTemplate = createProxyRestTemplate();

    private static RestTemplate createProxyRestTemplate() {
        SimpleClientHttpRequestFactory f = new SimpleClientHttpRequestFactory();
        f.setConnectTimeout(120_000);
        f.setReadTimeout(0);
        return new RestTemplate(f);
    }

    @GetMapping("/endpoints")
    public ResponseEntity<Map<String, Object>> getAvailableEndpoints() {
        Map<String, Object> endpoints = new HashMap<>();
        endpoints.put("baseUrl", demoAppProxyService.getBaseUrl());
        Map<String, String> endpointMap = new LinkedHashMap<>();
        endpointMap.put("GET /health", "Health check");
        endpointMap.put("GET /api/users", "Get all users");
        endpointMap.put("GET /api/users/{id}", "Get user by ID");
        endpointMap.put("POST /api/users", "Create user");
        endpointMap.put("PUT /api/users/{id}", "Update user");
        endpointMap.put("DELETE /api/users/{id}", "Delete user");
        endpointMap.put("GET /api/demo/ping", "Demo ping (controller layer)");
        endpointMap.put("GET /api/demo/order/{id}", "Demo order flow (controller → service → repo + inventory)");
        endpointMap.put("POST /api/demo/workflow", "Demo multi-step workflow");
        endpointMap.put("POST /api/demo/async/run", "Demo async task (different thread; optional sync=1)");
        endpoints.put("endpoints", endpointMap);
        return ResponseEntity.ok(endpoints);
    }

    @RequestMapping(value = "/**", method = {RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.PATCH})
    public ResponseEntity<Object> proxyRequest(
            HttpServletRequest request,
            @RequestBody(required = false) Map<String, Object> body) {
        String path = request.getRequestURI().substring("/api/server".length());
        if (path.isEmpty()) {
            path = "/";
        }
        return callServerApi(request.getMethod(), path, body, request);
    }

    private ResponseEntity<Object> callServerApi(String method, String path, Object body, HttpServletRequest incoming) {
        try {
            String url = demoAppProxyService.getBaseUrl().replaceAll("/$", "") + path;
            HttpHeaders headers = buildForwardHeaders(incoming, body != null);
            HttpEntity<Object> entity = new HttpEntity<>(body, headers);

            HttpMethod httpMethod = HttpMethod.valueOf(method.toUpperCase(Locale.ROOT));
            if (body == null && (httpMethod == HttpMethod.GET || httpMethod == HttpMethod.DELETE)) {
                entity = new HttpEntity<>(headers);
            }

            ResponseEntity<Object> response = restTemplate.exchange(url, httpMethod, entity, Object.class);
            return response;
        } catch (Exception e) {
            Map<String, Object> error = new HashMap<>();
            error.put("error", e.getMessage());
            error.put("message", "Failed to call demo app: " + path + " (base: " + demoAppProxyService.getBaseUrl() + ")");
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
        }
    }

    private static HttpHeaders buildForwardHeaders(HttpServletRequest incoming, boolean hasJsonBody) {
        HttpHeaders headers = new HttpHeaders();
        if (incoming == null) {
            if (hasJsonBody) {
                headers.setContentType(MediaType.APPLICATION_JSON);
            }
            return headers;
        }
        copyHeader(incoming, headers, "X-Debug-Request-Id");
        copyHeader(incoming, headers, "Authorization");
        copyHeader(incoming, headers, "Accept");
        copyHeader(incoming, headers, "Accept-Language");
        if (hasJsonBody) {
            String ct = incoming.getHeader("Content-Type");
            if (ct != null && !ct.isBlank()) {
                try {
                    headers.setContentType(MediaType.parseMediaType(ct));
                } catch (Exception e) {
                    headers.setContentType(MediaType.APPLICATION_JSON);
                }
            } else {
                headers.setContentType(MediaType.APPLICATION_JSON);
            }
        }
        return headers;
    }

    private static void copyHeader(HttpServletRequest incoming, HttpHeaders out, String name) {
        List<String> values = Collections.list(incoming.getHeaders(name));
        if (!CollectionUtils.isEmpty(values)) {
            for (String v : values) {
                if (v != null && !v.isBlank()) {
                    out.add(name, v);
                }
            }
        }
    }
}
