package com.mock.vcp;

import org.springframework.web.bind.annotation.*;
import java.util.*;

@RestController
@RequestMapping("/api/v1")
public class VcpController {

    @GetMapping("/funds")
    public Map<String, Object> getFunds(@RequestParam(required = false) String fundId) {
        Map<String, Object> result = new HashMap<>();
        result.put("service", "vcp-service");
        result.put("fundId", fundId);
        result.put("timestamp", System.currentTimeMillis());
        
        // Step 1: Load fund data
        Map<String, Object> fundData = loadFundData(fundId);
        result.put("fundData", fundData);
        
        // Step 2: Calculate metrics
        Map<String, Double> metrics = calculateMetrics(fundData);
        result.put("metrics", metrics);
        
        // Step 3: Generate report
        String report = generateReport(fundId, metrics);
        result.put("report", report);
        
        return result;
    }
    
    private Map<String, Object> loadFundData(String fundId) {
        // Good breakpoint location - data loading
        Map<String, Object> data = new HashMap<>();
        data.put("name", "Test Fund " + (fundId != null ? fundId : "DEFAULT"));
        data.put("aum", 50000000.0);
        data.put("vintage", 2020);
        data.put("status", "Active");
        return data;
    }
    
    private Map<String, Double> calculateMetrics(Map<String, Object> fundData) {
        // Good breakpoint location - calculations
        Map<String, Double> metrics = new HashMap<>();
        double aum = (Double) fundData.getOrDefault("aum", 0.0);
        metrics.put("irr", 15.5);
        metrics.put("moic", 1.8);
        metrics.put("dpi", 0.6);
        metrics.put("tvpi", 1.8);
        metrics.put("aumInMillions", aum / 1000000);
        return metrics;
    }
    
    private String generateReport(String fundId, Map<String, Double> metrics) {
        // Good breakpoint location - output generation
        return String.format("Fund %s: IRR=%.1f%%, MOIC=%.2fx", 
            fundId != null ? fundId : "DEFAULT", 
            metrics.get("irr"), 
            metrics.get("moic"));
    }
    
    @GetMapping("/health")
    public Map<String, String> health() {
        Map<String, String> result = new HashMap<>();
        result.put("status", "UP");
        result.put("service", "vcp-service");
        return result;
    }
    
    /**
     * Widget endpoint - matches real VCP API for E2E testing.
     * GET /api/v1/dd/widget?widgetKey=...&formId=...&selectedOrgId=...
     */
    @GetMapping("/dd/widget")
    public Map<String, Object> getWidget(
            @RequestParam(required = false) String widgetKey,
            @RequestParam String formId,
            @RequestParam(required = false) String selectedOrgId,
            @RequestParam(required = false) String parentId,
            @RequestHeader(value = "X-Debug-Request-Id", required = false) String debugRequestId) {
        // Breakpoint-friendly line - entry for widget API
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("message", "form fetched successfully");
        List<Map<String, Object>> data = new ArrayList<>();
        Map<String, Object> item = new HashMap<>();
        item.put("widgetKey", widgetKey != null ? widgetKey : "LAST_SEARCHED_COMPANIES");
        item.put("formId", formId);
        item.put("selectedOrgId", selectedOrgId);
        data.add(item);
        response.put("response", data);
        return response;
    }

    @GetMapping("/dd")
    public Map<String, Object> getDueDiligence(@RequestParam String companyId) {
        Map<String, Object> result = new HashMap<>();
        result.put("companyId", companyId);
        result.put("status", "In Progress");
        result.put("completionPercentage", 75);
        
        // Simulate some processing
        List<String> completedSteps = processSteps(companyId);
        result.put("completedSteps", completedSteps);
        
        return result;
    }
    
    private List<String> processSteps(String companyId) {
        // Good breakpoint location
        List<String> steps = new ArrayList<>();
        steps.add("Financial Review");
        steps.add("Legal Review");
        steps.add("Technical Assessment");
        return steps;
    }
    
    @PostMapping("/funds")
    public Map<String, Object> createFund(@RequestBody Map<String, Object> data) {
        Map<String, Object> result = new HashMap<>();
        result.put("received", data);
        result.put("created", true);
        result.put("fundId", UUID.randomUUID().toString());
        return result;
    }

    /**
     * Valuation Data endpoint - mimics the real VCP API
     * GET /api/v1/dd/valuation-data?widgetKey=xxx&formId=xxx&parentId=xxx
     */
    @GetMapping("/dd/valuation-data")
    public Map<String, Object> getValuationData(
            @RequestParam String widgetKey,
            @RequestParam String formId,
            @RequestParam String parentId,
            @RequestHeader(value = "context_id", required = false) String contextId,
            @RequestHeader(value = "object_id", required = false) String objectId,
            @RequestHeader(value = "x-auth-token", required = false) String authToken) {
        
        // Good breakpoint location - entry point for valuation data
        Map<String, Object> result = new HashMap<>();
        result.put("widgetKey", widgetKey);
        result.put("formId", formId);
        result.put("parentId", parentId);
        result.put("contextId", contextId);
        result.put("objectId", objectId);
        result.put("timestamp", System.currentTimeMillis());
        
        // Step 1: Validate request
        validateRequest(widgetKey, formId, parentId);
        
        // Step 2: Fetch valuation data
        Map<String, Object> valuationData = fetchValuationData(formId, parentId);
        result.put("valuationData", valuationData);
        
        // Step 3: Apply widget filtering
        List<Map<String, Object>> filteredData = applyWidgetFilter(widgetKey, valuationData);
        result.put("filteredData", filteredData);
        
        // Step 4: Build response
        Map<String, Object> response = buildValuationResponse(filteredData);
        result.put("response", response);
        
        return result;
    }
    
    private void validateRequest(String widgetKey, String formId, String parentId) {
        // Good breakpoint location - validation
        if (widgetKey == null || widgetKey.isEmpty()) {
            throw new IllegalArgumentException("widgetKey is required");
        }
        // Add more validation as needed
    }
    
    private Map<String, Object> fetchValuationData(String formId, String parentId) {
        // Good breakpoint location - data fetching
        Map<String, Object> data = new HashMap<>();
        data.put("formId", formId);
        data.put("parentId", parentId);
        data.put("valuationType", "DCF");
        data.put("currency", "USD");
        data.put("asOfDate", "2026-02-04");
        
        // Mock valuation metrics
        Map<String, Double> metrics = new HashMap<>();
        metrics.put("enterpriseValue", 150000000.0);
        metrics.put("equityValue", 120000000.0);
        metrics.put("netDebt", 30000000.0);
        metrics.put("revenueMultiple", 5.2);
        metrics.put("ebitdaMultiple", 12.5);
        data.put("metrics", metrics);
        
        return data;
    }
    
    private List<Map<String, Object>> applyWidgetFilter(String widgetKey, Map<String, Object> data) {
        // Good breakpoint location - filtering logic
        List<Map<String, Object>> filtered = new ArrayList<>();
        
        Map<String, Object> item = new HashMap<>();
        item.put("widgetKey", widgetKey);
        item.put("displayName", "CTM Filtering Results");
        item.put("data", data);
        item.put("rowCount", 10);
        filtered.add(item);
        
        return filtered;
    }
    
    private Map<String, Object> buildValuationResponse(List<Map<String, Object>> filteredData) {
        // Good breakpoint location - response building
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("totalRecords", filteredData.size());
        response.put("data", filteredData);
        response.put("generatedAt", System.currentTimeMillis());
        return response;
    }

    /**
     * Event Notification V2 endpoint - mimics the real VCP API
     * GET /api/v1/event_notification_v2/get_all_by_orgid_in_desc
     */
    @GetMapping("/event_notification_v2/get_all_by_orgid_in_desc")
    public Map<String, Object> findLatestAll(
            @RequestParam String userId,
            @RequestParam(required = false) String selectedOrgId,
            @RequestHeader(value = "context_id", required = false) String contextId,
            @RequestHeader(value = "object_id", required = false) String objectId,
            @RequestHeader(value = "x-auth-token", required = false) String authToken) {
        
        // Good breakpoint location - entry point for event notifications
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("message", "events fetched by orgId and sorted in descending order based on createdDate");
        
        // Step 1: Validate request
        validateEventRequest(userId);
        
        // Step 2: Fetch notifications
        List<Map<String, Object>> notifications = fetchNotifications(userId, selectedOrgId);
        response.put("response", notifications);
        
        return response;
    }
    
    private void validateEventRequest(String userId) {
        // Good breakpoint location - validation
        if (userId == null || userId.isEmpty()) {
            throw new IllegalArgumentException("userId is required");
        }
    }
    
    private List<Map<String, Object>> fetchNotifications(String userId, String orgId) {
        // Good breakpoint location - data fetching
        List<Map<String, Object>> notifications = new ArrayList<>();
        
        // Mock notification 1
        Map<String, Object> notification1 = new HashMap<>();
        notification1.put("id", UUID.randomUUID().toString());
        notification1.put("userId", userId);
        notification1.put("orgId", orgId);
        notification1.put("eventType", "VALUATION_UPDATED");
        notification1.put("message", "Valuation for Fund ABC has been updated");
        notification1.put("createdDate", System.currentTimeMillis());
        notification1.put("readStatus", false);
        notification1.put("eventStatus", "NEW");
        notifications.add(notification1);
        
        // Mock notification 2
        Map<String, Object> notification2 = new HashMap<>();
        notification2.put("id", UUID.randomUUID().toString());
        notification2.put("userId", userId);
        notification2.put("orgId", orgId);
        notification2.put("eventType", "FORM_SUBMITTED");
        notification2.put("message", "Due Diligence form submitted for Company XYZ");
        notification2.put("createdDate", System.currentTimeMillis() - 3600000);
        notification2.put("readStatus", true);
        notification2.put("eventStatus", "COMPLETED");
        notifications.add(notification2);
        
        // Mock notification 3
        Map<String, Object> notification3 = new HashMap<>();
        notification3.put("id", UUID.randomUUID().toString());
        notification3.put("userId", userId);
        notification3.put("orgId", orgId);
        notification3.put("eventType", "APPROVAL_REQUIRED");
        notification3.put("message", "Your approval is required for Investment Memo");
        notification3.put("createdDate", System.currentTimeMillis() - 7200000);
        notification3.put("readStatus", false);
        notification3.put("eventStatus", "PENDING");
        notifications.add(notification3);
        
        return notifications;
    }
}
