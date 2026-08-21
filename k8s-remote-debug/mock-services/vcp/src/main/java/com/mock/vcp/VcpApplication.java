package com.mock.vcp;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(scanBasePackages = {"com.mock.vcp", "com.debugger.filter"})
public class VcpApplication {
    public static void main(String[] args) {
        SpringApplication.run(VcpApplication.class, args);
    }
}
