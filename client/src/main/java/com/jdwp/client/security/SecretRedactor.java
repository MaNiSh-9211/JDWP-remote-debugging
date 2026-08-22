package com.jdwp.client.security;

import java.util.regex.Pattern;

/**
 * Masks credential-looking substrings before they reach the UI or logs.
 *
 * Conservative by design: only high-confidence patterns are redacted
 * (JWT/JWE, AWS keys, explicit auth/credential headers and fields), so real
 * debug data stays readable.
 */
public final class SecretRedactor {

    private static final Pattern JWT = Pattern.compile(
            "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*");

    private static final Pattern AWS_KEY = Pattern.compile("\\bAKIA[0-9A-Z]{16}\\b");

    /** authorization/bearer/x-auth-token/x-api-key followed by a value. */
    private static final Pattern AUTH_HEADER = Pattern.compile(
            "(?i)((?:authorization|bearer|x-auth-token|x-api-key|api[_-]?key)\\s*[\"']?\\s*[:=]\\s*[\"']?)([^\\s\"',}&]{6,})");

    /** password/passwd/pwd/secret/token fields with a value. */
    private static final Pattern CREDENTIAL_FIELD = Pattern.compile(
            "(?i)((?:password|passwd|pwd|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret)\\s*[\"']?\\s*[:=]\\s*[\"']?)([^\\s\"',}&]{4,})");

    private SecretRedactor() {
    }

    public static String redact(String input) {
        if (input == null || input.isEmpty()) {
            return input;
        }
        String out = input;
        if (out.indexOf("eyJ") >= 0) {
            out = JWT.matcher(out).replaceAll("***JWT***");
        }
        if (out.contains("AKIA")) {
            out = AWS_KEY.matcher(out).replaceAll("***AWS_KEY***");
        }
        out = AUTH_HEADER.matcher(out).replaceAll("$1***REDACTED***");
        out = CREDENTIAL_FIELD.matcher(out).replaceAll("$1***REDACTED***");
        return out;
    }
}
