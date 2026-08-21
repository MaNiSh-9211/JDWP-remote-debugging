package com.jdwp.server.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

@RestController
public class HealthController {

    @Value("${demo.instance:}")
    private String demoInstance;

    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        Map<String, String> response = new HashMap<>();
        response.put("status", "UP");
        response.put("message", "Debug server is running");
        if (demoInstance != null && !demoInstance.isBlank()) {
            response.put("instance", demoInstance.trim());
        }
        return ResponseEntity.ok(response);
    }
}

