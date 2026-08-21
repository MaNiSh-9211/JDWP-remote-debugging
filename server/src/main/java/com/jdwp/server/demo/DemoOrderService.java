package com.jdwp.server.demo;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

@Service
public class DemoOrderService {

    @Autowired
    private DemoOrderRepository repository;

    @Autowired
    private DemoInventoryService inventory;

    public Map<String, Object> buildOrderView(String orderId) {
        int bpDemoOrderService = 1;
        Optional<Map<String, Object>> row = repository.findById(orderId);
        int bpDemoOrderService2 = 1;
        boolean reserved = inventory.reserve(orderId);
        Map<String, Object> out = new HashMap<>();
        out.put("orderId", orderId);
        out.put("row", row.orElse(null));
        out.put("inventoryReserved", reserved);
        int bpDemoOrderService3 = 1;
        return out;
    }
}
