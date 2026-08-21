package com.jdwp.client.security;

import java.util.List;

/**
 * Restricts which JDWP targets the client may attach to.
 *
 * When {@code jdwp.allowed-targets} (env {@code JDWP_ALLOWED_TARGETS}) is set,
 * every connect request is validated against a comma-separated list of entries:
 *
 *   hostname            exact host match
 *   10.0.0.0/8          IPv4 CIDR range
 *   *                   allow anything (explicit escape hatch)
 *
 * Empty/unset = unrestricted (local development). Production deployments
 * should always scope this, e.g. "localhost,127.0.0.1,10.0.0.0/8".
 */
public final class TargetAllowList {

    private final List<String> rules;
    private final boolean allowAll;

    private TargetAllowList(List<String> rules) {
        this.rules = rules;
        this.allowAll = rules.contains("*");
    }

    public static TargetAllowList parse(String csv) {
        if (csv == null || csv.isBlank()) {
            return new TargetAllowList(List.of());
        }
        List<String> parsed = List.of(csv.split(","))
                .stream()
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
        return new TargetAllowList(parsed);
    }

    public boolean isEmpty() {
        return rules.isEmpty() && !allowAll;
    }

    /** @return true when host:port may be attached to. */
    public boolean allows(String host) {
        if (allowAll || isEmpty()) {
            return true;
        }
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = normalize(host);
        for (String rule : rules) {
            String r = normalize(rule);
            if (r.equals("*")) return true;
            if (r.equals(h)) return true;
            if (r.startsWith("localhost") && h.startsWith("localhost")) return true; // covers localhost:*
            if (isCidr(r) && cidrMatches(r, h)) return true;
            // Allow subdomain-style matches for explicit wildcard prefix only.
            if (r.startsWith("*.") && h.endsWith(r.substring(1))) return true;
        }
        return false;
    }

    private static String normalize(String s) {
        return s.toLowerCase().trim().replaceFirst(":\\d+$", ""); // strip port if present
    }

    private static boolean isCidr(String r) {
        return r.contains("/");
    }

    /** Minimal IPv4 CIDR matcher — sufficient for ops-style allow lists. */
    private static boolean cidrMatches(String cidr, String host) {
        try {
            String[] parts = cidr.split("/", 2);
            byte[] net = ipv4ToBytes(parts[0]);
            int prefix = Integer.parseInt(parts[1]);
            if (prefix < 0 || prefix > 32) return false;
            byte[] ip = ipv4ToBytes(host);
            if (ip == null || net == null) return false;
            int fullBytes = prefix / 8;
            for (int i = 0; i < fullBytes; i++) {
                if (net[i] != ip[i]) return false;
            }
            int remBits = prefix % 8;
            if (remBits > 0) {
                int mask = 0xFF00 >> remBits & 0xFF;
                if ((net[fullBytes] & mask) != (ip[fullBytes] & mask)) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] ipv4ToBytes(String s) {
        String[] parts = s.split("\\.");
        if (parts.length != 4) return null;
        byte[] out = new byte[4];
        for (int i = 0; i < 4; i++) {
            int v = Integer.parseInt(parts[i]);
            if (v < 0 || v > 255) return null;
            out[i] = (byte) v;
        }
        return out;
    }
}
