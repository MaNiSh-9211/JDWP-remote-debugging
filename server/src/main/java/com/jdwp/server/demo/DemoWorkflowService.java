package com.jdwp.server.demo;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;

/** Multi-step domain flow for stepping / stack depth demos. */
@Service
public class DemoWorkflowService {

    @Autowired
    private DemoOrderRepository repository;

    @Autowired
    private DemoInventoryService inventory;

    public Map<String, Object> runCheckout(String orderId) {
        int bpDemoWorkflow = 1;
        return stepValidate(orderId);
    }

    private Map<String, Object> stepValidate(String orderId) {
        int bpDemoWorkflowValidate = 1;
        return stepPersist(orderId);
    }

    private Map<String, Object> stepPersist(String orderId) {
        int bpDemoWorkflowPersist = 1;
        var opt = repository.findById(orderId);
        boolean ok = inventory.reserve(orderId);
        Map<String, Object> body = new HashMap<>();
        body.put("orderId", orderId);
        body.put("found", opt.isPresent());
        body.put("inventoryOk", ok);
        int bpDemoWorkflowDone = 1;
        return body;
    }
}
