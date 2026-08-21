package com.jdwp.server.demo;

import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Simulated inventory / secondary service layer. */
@Service
public class DemoInventoryService {

    private final Map<String, Integer> stock = new ConcurrentHashMap<>();

    public DemoInventoryService() {
        stock.put("100", 5);
        stock.put("200", 0);
    }

    public boolean reserve(String orderId) {
        int bpDemoInventory = 1;
        if (orderId == null) {
            return false;
        }
        int bpDemoInventory2 = 1;
        int units = stock.getOrDefault(orderId, 1);
        return units > 0;
    }
}
