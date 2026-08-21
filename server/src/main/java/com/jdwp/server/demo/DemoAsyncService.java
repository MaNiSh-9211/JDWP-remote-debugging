package com.jdwp.server.demo;

import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class DemoAsyncService {

    /** Runs on the servlet thread — filter frame stays on stack (good for X-Debug-Request-Id demos). */
    public void runHeavySync(String label) {
        int bpDemoAsyncSync = 1;
        simulateWork(label);
        int bpDemoAsyncSync2 = 1;
    }

    @Async
    public void runHeavyAsync(String label) {
        int bpDemoAsyncWorker = 1;
        simulateWork(label);
        int bpDemoAsyncWorker2 = 1;
    }

    private void simulateWork(String label) {
        int bpDemoAsyncPrivate = 1;
        try {
            Thread.sleep(80);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
