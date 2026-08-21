package com.jdwp.client.controller;

import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/proxy")

public class ApiProxyController {
    
    private static final String DEBUG_SERVER_URL = "http://localhost:8081";
    private final RestTemplate restTemplate = new RestTemplate();
    
    @GetMapping("/endpoints")
    public ResponseEntity<Map<String, Object>> getAvailableEndpoints() {
        Map<String, Object> endpoints = new HashMap<>();
        endpoints.put("baseUrl", DEBUG_SERVER_URL);
        endpoints.put("endpoints", Map.of(
            "GET /api/users", "Get all users",
            "GET /api/users/{id}", "Get user by ID",
            "POST /api/users", "Create new user",
            "PUT /api/users/{id}", "Update user",
            "DELETE /api/users/{id}", "Delete user",
            "GET /health", "Health check"
        ));
        return ResponseEntity.ok(endpoints);
    }
    
    @GetMapping("/call/**")
    public ResponseEntity<Object> callGet(@RequestParam Map<String, String> params) {
        String path = extractPath("/api/proxy/call/");
        return proxyRequest(HttpMethod.GET, path, null, params);
    }
    
    @PostMapping("/call/**")
    public ResponseEntity<Object> callPost(@RequestBody(required = false) Object body) {
        String path = extractPath("/api/proxy/call/");
        return proxyRequest(HttpMethod.POST, path, body, null);
    }
    
    @PutMapping("/call/**")
    public ResponseEntity<Object> callPut(@RequestBody(required = false) Object body) {
        String path = extractPath("/api/proxy/call/");
        return proxyRequest(HttpMethod.PUT, path, body, null);
    }
    
    @DeleteMapping("/call/**")
    public ResponseEntity<Object> callDelete() {
        String path = extractPath("/api/proxy/call/");
        return proxyRequest(HttpMethod.DELETE, path, null, null);
    }
    
    private String extractPath(String prefix) {
        // This would need to be implemented based on how Spring extracts the path
        // For now, we'll use a simpler approach
        return "";
    }
    
    private ResponseEntity<Object> proxyRequest(HttpMethod method, String path, Object body, Map<String, String> params) {
        try {
            String url = DEBUG_SERVER_URL + path;
            if (params != null && !params.isEmpty()) {
                url += "?" + params.entrySet().stream()
                    .map(e -> e.getKey() + "=" + e.getValue())
                    .reduce((a, b) -> a + "&" + b)
                    .orElse("");
            }
            
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            HttpEntity<Object> entity = new HttpEntity<>(body, headers);
            
            ResponseEntity<Object> response = restTemplate.exchange(url, method, entity, Object.class);
            return response;
        } catch (Exception e) {
            Map<String, Object> error = new HashMap<>();
            error.put("error", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error);
        }
    }
}

