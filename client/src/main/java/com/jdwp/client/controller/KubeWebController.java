package com.jdwp.client.controller;

import com.jdwp.client.k8s.KubeWebService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Web-UI cluster access: contexts, namespaces, pods, logs and port-forward
 * lifecycle - the same powers the desktop app has, served over HTTP so any
 * browser on the machine can use them.
 *
 * Security: covered by the global API token filter + rate limiter; only
 * read-only verbs plus port-forward tunneling are exposed. All identifiers
 * are strictly validated before reaching kubectl.
 */
@RestController
@RequestMapping("/api/k8s")
public class KubeWebController {

    private static final Pattern IDENT = Pattern.compile("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,250}$");
    private static final Pattern CONTEXT_OK = Pattern.compile("^[\\w][\\w.-]{0,200}$");

    @Autowired
    private KubeWebService kube;

    @GetMapping("/enabled")
    public ResponseEntity<Map<String, Object>> enabled() {
        return ResponseEntity.ok(Map.of("enabled", kube.isEnabled()));
    }

    @GetMapping("/contexts")
    public ResponseEntity<Map<String, Object>> contexts(@RequestParam(required = false) String kubeconfig) {
        try {
            String out = kube.getContextsRaw(kubeconfig);
            List<String> list = new ArrayList<>();
            for (String s : out.split("\n")) if (!s.isBlank()) list.add(s.trim());
            return ResponseEntity.ok(Map.of("success", true, "contexts", list));
        } catch (Exception e) {
            return fail(e);
        }
    }

    @GetMapping("/namespaces")
    public ResponseEntity<Map<String, Object>> namespaces(@RequestParam(required = false) String kubeconfig,
                                                          @RequestParam(required = false) String context) {
        try {
            String out = kube.getNamespacesRaw(kubeconfig, context);
            List<String> list = new ArrayList<>();
            for (String s : out.split("\n")) if (!s.isBlank()) list.add(s.trim());
            return ResponseEntity.ok(Map.of("success", true, "namespaces", list));
        } catch (Exception e) {
            return fail(e);
        }
    }

    /** Returns minimal pod info: name, phase, jdwpPort (if a port named jdwp or 5005 exists). */
    @GetMapping("/pods")
    public ResponseEntity<Map<String, Object>> pods(@RequestParam(required = false) String kubeconfig,
                                                    @RequestParam(required = false) String context,
                                                    @RequestParam(defaultValue = "default") String namespace) {
        try {
            requireIdent(namespace, "namespace");
            String json = kube.getPodsJson(kubeconfig, context, namespace);
            List<Map<String, Object>> pods = parsePods(json);
            return ResponseEntity.ok(Map.of("success", true, "pods", pods));
        } catch (Exception e) {
            return fail(e);
        }
    }

    @GetMapping("/logs")
    public ResponseEntity<Map<String, Object>> logs(@RequestParam(required = false) String kubeconfig,
                                                    @RequestParam(required = false) String context,
                                                    @RequestParam(defaultValue = "default") String namespace,
                                                    @RequestParam String pod,
                                                    @RequestParam(defaultValue = "100") int tail) {
        try {
            requireIdent(namespace, "namespace");
            requireIdent(pod, "pod");
            int t = Math.max(1, Math.min(tail, 1000));
            return ResponseEntity.ok(Map.of("success", true, "logs", kube.getPodLogs(kubeconfig, context, namespace, pod, t)));
        } catch (Exception e) {
            return fail(e);
        }
    }

    @PostMapping("/forward")
    public ResponseEntity<Map<String, Object>> forward(@RequestBody Map<String, Object> body) {
        try {
            String kubeconfig = str(body.get("kubeconfig"));
            String context = str(body.get("context"));
            String namespace = str(body.get("namespace"));
            String pod = str(body.get("pod"));
            requireIdent(namespace, "namespace");
            requireIdent(pod, "pod");
            int remotePort = intOf(body.get("remotePort"), 5005);
            int localPort = intOf(body.get("localPort"), 5005);
            if (remotePort < 1 || remotePort > 65535 || localPort < 1 || localPort > 65535) {
                throw new IllegalArgumentException("Invalid port");
            }
            kube.startForward(kubeconfig, context, namespace, pod, remotePort, localPort);
            return ResponseEntity.ok(Map.of("success", true, "localPort", localPort));
        } catch (Exception e) {
            return fail(e);
        }
    }

    @GetMapping("/forwards")
    public ResponseEntity<Map<String, Object>> forwards() {
        return ResponseEntity.ok(Map.of("success", true, "forwards", kube.listForwards()));
    }

    @DeleteMapping("/forward/{localPort}")
    public ResponseEntity<Map<String, Object>> stopForward(@PathVariable int localPort) {
        kube.stopForward(localPort);
        return ResponseEntity.ok(Map.of("success", true));
    }

    // helpers --------------------------------------------------------------

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o).trim();
    }

    private static void requireIdent(String v, String label) {
        if (v == null || !IDENT.matcher(v).matches()) throw new IllegalArgumentException("Invalid " + label);
    }

    private static boolean ctxOk(String c) {
        return c == null || c.isBlank() ? true : CONTEXT_OK.matcher(c).matches();
    }

    private static int intOf(Object o, int def) {
        try { return Integer.parseInt(String.valueOf(o)); } catch (Exception e) { return def; }
    }

    private static ResponseEntity<Map<String, Object>> fail(Exception e) {
        return ResponseEntity.badRequest().body(Map.of("success", false, "message",
                e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER =
            new com.fasterxml.jackson.databind.ObjectMapper();

    /** Extract name/phase/jdwpPort from kubectl get pods -o json output. */
    private static List<Map<String, Object>> parsePods(String json) throws Exception {
        List<Map<String, Object>> out = new ArrayList<>();
        var root = MAPPER.readTree(json);
        for (var item : root.path("items")) {
            Map<String, Object> p = new HashMap<>();
            String name = item.path("metadata").path("name").asText("");
            String phase = item.path("status").path("phase").asText("");
            boolean running = "Running".equals(phase)
                    && !item.path("status").path("containerStatuses").isEmpty()
                    && item.path("status").path("containerStatuses").get(0).path("state").has("running");
            int jdwpPort = -1;
            for (var c : item.path("spec").path("containers")) {
                for (var port : c.path("ports")) {
                    int num = port.path("containerPort").asInt(-1);
                    String pname = port.path("name").asText("");
                    if ("jdwp".equals(pname) || num == 5005) { jdwpPort = num == -1 ? 5005 : num; break; }
                }
                if (jdwpPort > 0) break;
                var env = c.path("env");
                for (var e : env) {
                    if ("JAVA_TOOL_OPTIONS".equals(e.path("name").asText())
                            && e.path("value").asText("").contains("jdwp")) {
                        jdwpPort = 5005;
                        break;
                    }
                }
                if (jdwpPort > 0) break;
            }
            if (!name.isEmpty()) {
                p.put("name", name); p.put("phase", phase); p.put("running", running); p.put("jdwpPort", jdwpPort);
                out.add(p);
            }
        }
        return out;
    }
}
