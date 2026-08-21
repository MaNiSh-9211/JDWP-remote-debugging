package com.mock.valuation;

import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/v1")
public class ValuationController {

    @GetMapping("/valuation")
    public Map<String, Object> getValuation(@RequestParam(required = false) String id) {
        Map<String, Object> result = new HashMap<>();
        result.put("service", "valuation-service");
        result.put("id", id);
        result.put("timestamp", System.currentTimeMillis());
        
        // Step 1: Validate input
        String validatedId = validateInput(id);
        result.put("validatedId", validatedId);
        
        // Step 2: Calculate valuation
        double valuation = calculateValuation(validatedId);
        result.put("valuation", valuation);
        
        // Step 3: Build response
        String summary = buildSummary(validatedId, valuation);
        result.put("summary", summary);
        
        return result;
    }
    
    private String validateInput(String id) {
        // Good breakpoint location
        if (id == null || id.isEmpty()) {
            return "DEFAULT_001";
        }
        return id.toUpperCase();
    }
    
    private double calculateValuation(String id) {
        // Good breakpoint location - business logic
        double baseValue = 1000000.0;
        double multiplier = id.hashCode() % 10 / 10.0 + 0.5;
        return baseValue * multiplier;
    }
    
    private String buildSummary(String id, double valuation) {
        // Good breakpoint location
        return String.format("Valuation for %s: $%.2f", id, valuation);
    }
    
    @GetMapping("/health")
    public Map<String, String> health() {
        Map<String, String> result = new HashMap<>();
        result.put("status", "UP");
        result.put("service", "valuation-service");
        return result;
    }
    
    @PostMapping("/valuation")
    public Map<String, Object> createValuation(@RequestBody Map<String, Object> data) {
        Map<String, Object> result = new HashMap<>();
        result.put("received", data);
        result.put("created", true);
        result.put("timestamp", System.currentTimeMillis());
        return result;
    }
}
