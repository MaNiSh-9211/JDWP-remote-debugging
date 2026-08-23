package com.jdwp.client.security;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SecretRedactorTest {

    @Test
    void jwtTokensAreMasked() {
        String in = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        String out = SecretRedactor.redact(in);
        assertFalse(out.contains("eyJhbGciOiJIUzI1NiJ9"));
        assertTrue(out.contains("***JWT***"));
    }

    @Test
    void awsKeysAreMasked() {
        assertEquals("key ***AWS_KEY*** here", SecretRedactor.redact("key AKIAIOSFODNN7EXAMPLE here"));
    }

    @Test
    void passwordFieldsAreMasked() {
        String out = SecretRedactor.redact("{\"password\":\"hunter2\"}");
        assertFalse(out.contains("hunter2"));
        assertTrue(out.contains("***REDACTED***"));
    }

    @Test
    void authHeadersAreMasked() {
        String out = SecretRedactor.redact("x-auth-token: abcdef123456");
        assertFalse(out.contains("abcdef123456"));
    }

    @Test
    void plainDataUntouched() {
        String plain = "UserController:31 user(id=42) value=3.14 status=ok";
        assertEquals(plain, SecretRedactor.redact(plain));
    }

    @Test
    void nullAndEmptySafe() {
        assertNull(SecretRedactor.redact(null));
        assertEquals("", SecretRedactor.redact(""));
    }
}
