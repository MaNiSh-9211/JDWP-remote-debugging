package com.jdwp.client;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class JdwpDebugClientApplication {
    public static void main(String[] args) {
        SpringApplication.run(JdwpDebugClientApplication.class, args);
    }
}

