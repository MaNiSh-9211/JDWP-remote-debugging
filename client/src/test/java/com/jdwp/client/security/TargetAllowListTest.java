package com.jdwp.client.security;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class TargetAllowListTest {

    @Test
    void emptyListAllowsEverything() {
        assertTrue(TargetAllowList.parse("").allows("anything.example.com"));
        assertTrue(TargetAllowList.parse(null).allows("10.1.2.3"));
    }

    @Test
    void exactHostMatch() {
        TargetAllowList list = TargetAllowList.parse("localhost,prod.example.com");
        assertTrue(list.allows("localhost"));
        assertTrue(list.allows("prod.example.com"));
        assertFalse(list.allows("evil.internal"));
    }

    @Test
    void hostWithPortIsNormalized() {
        TargetAllowList list = TargetAllowList.parse("localhost");
        assertTrue(list.allows("localhost:5005"));
    }

    @Test
    void cidrRanges() {
        TargetAllowList list = TargetAllowList.parse("10.0.0.0/8,192.168.1.0/24");
        assertTrue(list.allows("10.5.20.9"));
        assertTrue(list.allows("192.168.1.77"));
        assertFalse(list.allows("192.168.2.77"));
        assertFalse(list.allows("11.0.0.1"));
    }

    @Test
    void wildcardEscapeHatch() {
        assertTrue(TargetAllowList.parse("*").allows("anything.at.all"));
    }
}
