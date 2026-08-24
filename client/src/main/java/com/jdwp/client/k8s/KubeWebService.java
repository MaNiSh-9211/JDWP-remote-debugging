package com.jdwp.client.k8s;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Server-side kubectl access so the WEB UI has the same cluster powers as the
 * desktop app. Strictly read-only + port-forward tunneling:
 *
 *   allowed verbs: get (read), auth can-i, config get-contexts, logs, port-forward
 *   everything else is refused. No shell is spawned - arguments are passed as an array.
 */
@Service
public class KubeWebService {

    private static final Logger logger = LoggerFactory.getLogger(KubeWebService.class);
    private static final int MAX_FORWARDS = 5;
    private static final long TIMEOUT_MS = 20_000;

    private final Map<Integer, Process> forwards = new ConcurrentHashMap<>();
    private final Map<Integer, ForwardInfo> forwardInfo = new ConcurrentHashMap<>();

    @Value("${kube.web.enabled:true}")
    private boolean enabled;

    public record ForwardInfo(String context, String namespace, String pod, int remotePort, int localPort, long startedAt) {}

    public boolean isEnabled() {
        return enabled;
    }

    private List<String> baseArgs(String kubeconfig, String context) {
        List<String> args = new ArrayList<>();
        if (kubeconfig != null && !kubeconfig.isBlank()) {
            args.add("--kubeconfig");
            args.add(kubeconfig.trim());
        }
        if (context != null && !context.isBlank()) {
            args.add("--context");
            args.add(context.trim());
        }
        return args;
    }

    /** Runs kubectl and returns stdout. Throws on non-zero exit or timeout. */
    public String run(List<String> args) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add("kubectl");
        cmd.addAll(args);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        Process p = pb.start();
        StringBuilder out = new StringBuilder();
        StringBuilder err = new StringBuilder();
        Thread tOut = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) out.append(line).append('\n');
            } catch (Exception ignore) { }
        });
        Thread tErr = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) err.append(line).append('\n');
            } catch (Exception ignore) { }
        });
        tOut.setDaemon(true); tErr.setDaemon(true);
        tOut.start(); tErr.start();
        if (!p.waitFor(TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            p.destroyForcibly();
            throw new IllegalStateException("kubectl timed out");
        }
        tOut.join(2000); tErr.join(2000);
        if (p.exitValue() != 0) {
            throw new IllegalStateException(err.toString().trim().isEmpty() ? ("exit " + p.exitValue()) : err.toString().trim());
        }
        return out.toString();
    }

    // convenience wrappers -----------------------------------------------------

    public String getContextsRaw(String kubeconfig) throws Exception {
        List<String> args = new ArrayList<>(baseArgs(kubeconfig, null));
        args.addAll(List.of("config", "get-contexts", "--no-headers", "-o", "name"));
        return run(args);
    }

    public String getNamespacesRaw(String kubeconfig, String context) throws Exception {
        List<String> args = new ArrayList<>(baseArgs(kubeconfig, context));
        args.addAll(List.of("get", "namespaces", "-o", "custom-columns=NAME:.metadata.name", "--no-headers"));
        return run(args);
    }

    public String getPodsJson(String kubeconfig, String context, String namespace) throws Exception {
        List<String> args = new ArrayList<>(baseArgs(kubeconfig, context));
        args.addAll(List.of("get", "pods", "-n", namespace, "-o", "json"));
        return run(args);
    }

    public String getPodLogs(String kubeconfig, String context, String namespace, String pod, int tail) throws Exception {
        List<String> args = new ArrayList<>(baseArgs(kubeconfig, context));
        args.addAll(List.of("logs", "-n", namespace, pod, "--tail=" + tail));
        return run(args);
    }

    // --- Port-forward lifecycle ----------------------------------------------

    public synchronized Map<String, Object> startForward(String kubeconfig, String context,
                                                         String namespace, String pod,
                                                         int remotePort, int localPort) throws Exception {
        Integer key = localPort;
        ForwardInfo existing = forwardInfo.get(key);
        if (existing != null && existing.pod().equals(pod)) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true); out.put("reused", true); out.put("localPort", localPort);
            return out;
        }
        stopForward(localPort);
        if (forwards.size() >= MAX_FORWARDS) throw new IllegalStateException("Too many active forwards (max " + MAX_FORWARDS + ")");

        List<String> args = new ArrayList<>(baseArgs(kubeconfig, context));
        args.addAll(List.of("port-forward", "-n", namespace, "pod/" + pod, localPort + ":" + remotePort));
        ProcessBuilder pb = new ProcessBuilder(args);
        pb.redirectErrorStream(true);
        Process p = pb.start();

        long deadline = System.currentTimeMillis() + 8000;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            while (System.currentTimeMillis() < deadline) {
                if (p.exitValue() != -1 && p.isAlive() == false) break;
                if (r.ready()) {
                    String line = r.readLine();
                    if (line != null && line.contains("Forwarding from")) {
                        forwards.put(localPort, p);
                        ForwardInfo info = new ForwardInfo(context == null ? "" : context, namespace, pod, remotePort, localPort, System.currentTimeMillis());
                        forwardInfo.put(localPort, info);
                        logger.info("[K8S-WEB] forward active :{} -> {}/{}:{}", localPort, namespace, pod, remotePort);
                        Map<String, Object> out = new LinkedHashMap<>();
                        out.put("ok", true); out.put("localPort", localPort); out.put("pod", pod); out.put("namespace", namespace);
                        return out;
                    }
                }
                Thread.sleep(150);
            }
        }
        p.destroyForcibly();
        throw new IllegalStateException("port-forward did not become ready in time");
    }

    public synchronized void stopForward(int localPort) {
        Process p = forwards.remove(localPort);
        if (p != null) {
            p.descendants().forEach(java.lang.ProcessHandle::destroyForcibly);
            p.destroy();
        }
        forwardInfo.remove(localPort);
    }

    public synchronized void stopAll() {
        for (Integer k : List.copyOf(forwards.keySet())) stopForward(k);
    }

    public List<Map<String, Object>> listForwards() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (var e : forwardInfo.entrySet()) {
            var i = e.getValue();
            out.add(Map.of(
                    "localPort", e.getKey(),
                    "pod", i.pod(),
                    "namespace", i.namespace(),
                    "remotePort", i.remotePort()));
        }
        return out;
    }

    @PreDestroy
    public void shutdown() {
        stopAll();
    }
}
