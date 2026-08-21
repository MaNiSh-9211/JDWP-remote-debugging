package com.jdwp.server.demo;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/demo")
public class DemoLayeredController {

    @Autowired
    private DemoOrderService orderService;

    @Autowired
    private DemoWorkflowService workflowService;

    @Autowired
    private DemoAsyncService asyncService;

    @GetMapping("/ping")
    public Map<String, String> ping() {
        int bpDemoPing = 1;
        return Map.of("status", "ok", "layer", "controller");
    }

    @GetMapping("/order/{id}")
    public ResponseEntity<Map<String, Object>> order(@PathVariable String id) {
        int bpDemoOrderCtrl = 1;
        Map<String, Object> body = orderService.buildOrderView(id);
        int bpDemoOrderCtrl2 = 1;
        return ResponseEntity.ok(body);
    }

    @PostMapping("/workflow")
    public ResponseEntity<Map<String, Object>> workflow(@RequestBody(required = false) Map<String, String> req) {
        int bpDemoWorkflowCtrl = 1;
        String orderId = req != null ? req.getOrDefault("orderId", "100") : "100";
        Map<String, Object> body = workflowService.runCheckout(orderId);
        return ResponseEntity.ok(body);
    }

    @PostMapping("/async/run")
    public Map<String, String> asyncRun(
            @RequestParam(name = "sync", defaultValue = "0") String syncFlag,
            @RequestBody(required = false) Map<String, String> body) {
        int bpDemoAsyncCtrl = 1;
        String label = body != null ? body.getOrDefault("label", "demo-task") : "demo-task";
        boolean sync = "1".equals(syncFlag) || "true".equalsIgnoreCase(syncFlag);
        if (sync) {
            asyncService.runHeavySync(label);
        } else {
            asyncService.runHeavyAsync(label);
        }
        Map<String, String> res = new HashMap<>();
        res.put("status", sync ? "completed-sync" : "scheduled-async");
        res.put("label", label);
        int bpDemoAsyncCtrl2 = 1;
        return res;
    }
}
