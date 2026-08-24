package com.jdwp.client.controller;

import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Remote source browsing for the WEB UI (same powers as the desktop's
 * SourceCodeDrawer): point at a repo root, list directories, read files.
 *
 * Security: canonical-path containment under root, extension allow-list,
 * size caps. No writes ever.
 */
@RestController
@RequestMapping("/api/source")
public class SourceController {

    private static final long MAX_FILE = 2L * 1024 * 1024;
    private static final Pattern ALLOWED_EXT = Pattern.compile(
            "\\.(java|kt|xml|properties|yml|yaml|json|md|txt|gradle|sql|html|css|js|ts)$",
            Pattern.CASE_INSENSITIVE);
    private static final Set<String> SKIP_DIRS = Set.of(
            ".git", ".idea", "node_modules", "target", "build", "dist", ".gradle", "out");

    /** rootKey -> absolute root path (in-memory, re-added after upload/browse). */
    private static final Map<String, String> ROOTS = new HashMap<>();

    @PostMapping("/root")
    public synchronized Map<String, Object> setRoot(@RequestBody Map<String, Object> body) {
        Map<String, Object> out = new HashMap<>();
        try {
            String raw = String.valueOf(body.get("path") == null ? "" : body.get("path")).trim();
            Path p = Path.of(raw).toAbsolutePath().normalize();
            if (!Files.isDirectory(p)) throw new IllegalArgumentException("Not a directory: " + p);
            String key = Integer.toHexString(p.toString().hashCode());
            ROOTS.put(key, p.toString());
            out.put("success", true);
            out.put("rootKey", key);
            out.put("path", p.toString());
        } catch (Exception e) {
            out.put("success", false);
            out.put("message", e.getMessage());
        }
        return out;
    }

    @GetMapping("/list")
    public Map<String, Object> list(@RequestParam String rootKey,
                                    @RequestParam(required = false, defaultValue = "") String dir) {
        Map<String, Object> out = new HashMap<>();
        try {
            Path root = requireRoot(rootKey);
            Path target = safe(root, dir);
            List<Map<String, Object>> entries = new ArrayList<>();
            try (var stream = Files.list(target)) {
                stream.filter(f -> !SKIP_DIRS.contains(f.getFileName().toString()))
                      .filter(f -> !f.getFileName().toString().startsWith("."))
                      .sorted((a, b) -> {
                          boolean ad = Files.isDirectory(a), bd = Files.isDirectory(b);
                          if (ad != bd) return ad ? -1 : 1;
                          return a.getFileName().toString().compareToIgnoreCase(b.getFileName().toString());
                      })
                      .limit(500)
                      .forEach(f -> {
                          Map<String, Object> m = new HashMap<>();
                          m.put("name", f.getFileName().toString());
                          m.put("dir", Files.isDirectory(f));
                          entries.add(m);
                      });
            }
            out.put("success", true);
            out.put("entries", entries);
        } catch (Exception e) {
            out.put("success", false);
            out.put("message", e.getMessage());
        }
        return out;
    }

    @GetMapping("/file")
    public Map<String, Object> file(@RequestParam String rootKey,
                                    @RequestParam String path,
                                    @RequestParam(required = false) Integer line) {
        Map<String, Object> out = new HashMap<>();
        try {
            Path root = requireRoot(rootKey);
            Path target = safe(root, path);
            if (!ALLOWED_EXT.matcher(target.toString()).find()) throw new IllegalArgumentException("Extension not allowed");
            if (!Files.isRegularFile(target)) throw new IllegalArgumentException("Not a file");
            byte[] bytes = Files.readAllBytes(target);
            if (bytes.length > MAX_FILE) throw new IllegalArgumentException("File too large");
            String content = new String(bytes, StandardCharsets.UTF_8);
            if (line != null && line > 0) out.put("focusLine", line);
            out.put("success", true);
            out.put("content", content);
        } catch (Exception e) {
            out.put("success", false);
            out.put("message", e.getMessage());
        }
        return out;
    }

    private static Path requireRoot(String rootKey) throws IOException {
        String r = ROOTS.get(rootKey);
        if (r == null) throw new IllegalArgumentException("Unknown root - set it first");
        return Path.of(r);
    }

    private static Path safe(Path root, String rel) throws IOException {
        Path target = root.resolve(rel == null ? "" : rel).normalize();
        if (!target.startsWith(root)) throw new IllegalArgumentException("Path escapes root");
        return target;
    }
}
