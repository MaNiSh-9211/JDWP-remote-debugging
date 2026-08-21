package com.mock.valuation;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(scanBasePackages = {"com.mock.valuation", "com.debugger.filter"})
public class ValuationApplication {
    public static void main(String[] args) {
        SpringApplication.run(ValuationApplication.class, args);
    }
}
