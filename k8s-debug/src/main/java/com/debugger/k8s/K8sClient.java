package com.debugger.k8s;

import com.debugger.model.PodInfo;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodList;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import io.fabric8.kubernetes.client.LocalPortForward;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Kubernetes client for pod discovery and port-forwarding.
 * Uses fabric8 Kubernetes client for programmatic access.
 * Falls back to kubectl for port-forwarding if needed.
 */
@Component
@Slf4j
public class K8sClient {
    
    @Value("${k8s.namespace:default}")
    private String defaultNamespace;
    
    @Value("${k8s.jdwp.port:5005}")
    private int defaultJdwpPort;
    
    @Value("${k8s.use-kubectl-portforward:false}")
    private boolean useKubectlPortForward;
    
    private KubernetesClient client;
    
    // Track active port-forwards
    private final Map<String, PortForwardSession> activePortForwards = new ConcurrentHashMap<>();
    
    @PostConstruct
    public void init() {
        try {
            client = new KubernetesClientBuilder().build();
            log.info("Kubernetes client initialized. Connected to: {}", 
                    client.getMasterUrl());
            
            // Verify connectivity
            String namespace = client.getNamespace();
            log.info("Current namespace: {}", namespace != null ? namespace : defaultNamespace);
        } catch (Exception e) {
            log.error("Failed to initialize Kubernetes client", e);
            throw new RuntimeException("Cannot connect to Kubernetes cluster", e);
        }
    }
    
    @PreDestroy
    public void cleanup() {
        // Close all active port-forwards
        activePortForwards.values().forEach(this::closePortForward);
        activePortForwards.clear();
        
        if (client != null) {
            client.close();
        }
    }
    
    /**
     * List all pods matching a label selector.
     * 
     * @param namespace Kubernetes namespace
     * @param labelSelector Label selector (e.g., "app=my-service")
     * @return List of PodInfo objects
     */
    public List<PodInfo> listPods(String namespace, String labelSelector) {
        String ns = namespace != null ? namespace : defaultNamespace;
        
        log.info("Listing pods: namespace={}, selector={}", ns, labelSelector);
        
        try {
            PodList podList;
            if (labelSelector != null && !labelSelector.isEmpty()) {
                podList = client.pods()
                        .inNamespace(ns)
                        .withLabelSelector(labelSelector)
                        .list();
            } else {
                podList = client.pods()
                        .inNamespace(ns)
                        .list();
            }
            
            List<PodInfo> pods = podList.getItems().stream()
                    .map(this::toPodInfo)
                    .collect(Collectors.toList());
            
            log.info("Found {} pods", pods.size());
            return pods;
            
        } catch (Exception e) {
            log.error("Failed to list pods", e);
            throw new RuntimeException("Failed to list pods: " + e.getMessage(), e);
        }
    }
    
    /**
     * List pods by service name (app label).
     */
    public List<PodInfo> listPodsByService(String namespace, String serviceName) {
        return listPods(namespace, "app=" + serviceName);
    }
    
    /**
     * Get a specific pod by name.
     */
    public PodInfo getPod(String namespace, String podName) {
        String ns = namespace != null ? namespace : defaultNamespace;
        
        try {
            Pod pod = client.pods()
                    .inNamespace(ns)
                    .withName(podName)
                    .get();
            
            if (pod == null) {
                throw new RuntimeException("Pod not found: " + podName);
            }
            
            return toPodInfo(pod);
            
        } catch (Exception e) {
            log.error("Failed to get pod: {}", podName, e);
            throw new RuntimeException("Failed to get pod: " + e.getMessage(), e);
        }
    }
    
    /**
     * Get pod logs.
     */
    public String getPodLogs(String namespace, String podName, int lines) {
        String ns = namespace != null ? namespace : defaultNamespace;
        
        try {
            return client.pods()
                    .inNamespace(ns)
                    .withName(podName)
                    .tailingLines(lines)
                    .getLog();
        } catch (Exception e) {
            log.error("Failed to get logs for pod: {}", podName, e);
            throw new RuntimeException("Failed to get logs: " + e.getMessage(), e);
        }
    }
    
    /**
     * Start port-forward to a pod's JDWP port.
     * Returns the local port number.
     */
    public int startPortForward(String namespace, String podName, int remotePort) {
        String ns = namespace != null ? namespace : defaultNamespace;
        String key = ns + "/" + podName;
        
        // Check if already forwarding
        if (activePortForwards.containsKey(key)) {
            PortForwardSession existing = activePortForwards.get(key);
            log.info("Port-forward already active for {}: localPort={}", key, existing.localPort);
            return existing.localPort;
        }
        
        log.info("Starting port-forward: {} -> pod:{}", key, remotePort);
        
        try {
            if (useKubectlPortForward) {
                return startKubectlPortForward(ns, podName, remotePort);
            } else {
                return startFabric8PortForward(ns, podName, remotePort);
            }
        } catch (Exception e) {
            log.error("Failed to start port-forward to {}", key, e);
            throw new RuntimeException("Failed to start port-forward: " + e.getMessage(), e);
        }
    }
    
    /**
     * Start port-forward using fabric8 client (programmatic).
     */
    private int startFabric8PortForward(String namespace, String podName, int remotePort) {
        String key = namespace + "/" + podName;
        
        // Find available local port
        int localPort = findAvailablePort();
        
        LocalPortForward portForward = client.pods()
                .inNamespace(namespace)
                .withName(podName)
                .portForward(remotePort, localPort);
        
        PortForwardSession session = new PortForwardSession();
        session.key = key;
        session.localPort = portForward.getLocalPort();
        session.remotePort = remotePort;
        session.fabric8PortForward = portForward;
        session.startTime = System.currentTimeMillis();
        
        activePortForwards.put(key, session);
        
        log.info("Port-forward started: localhost:{} -> {}:{}", 
                session.localPort, key, remotePort);
        
        return session.localPort;
    }
    
    /**
     * Start port-forward using kubectl command (fallback).
     */
    private int startKubectlPortForward(String namespace, String podName, int remotePort) {
        String key = namespace + "/" + podName;
        int localPort = findAvailablePort();
        
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    "kubectl", "port-forward",
                    "-n", namespace,
                    podName,
                    localPort + ":" + remotePort
            );
            pb.redirectErrorStream(true);
            Process process = pb.start();
            
            // Wait a bit for port-forward to establish
            Thread.sleep(2000);
            
            // Check if process is still running
            if (!process.isAlive()) {
                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream()));
                String output = reader.lines().collect(Collectors.joining("\n"));
                throw new RuntimeException("kubectl port-forward failed: " + output);
            }
            
            PortForwardSession session = new PortForwardSession();
            session.key = key;
            session.localPort = localPort;
            session.remotePort = remotePort;
            session.kubectlProcess = process;
            session.startTime = System.currentTimeMillis();
            
            activePortForwards.put(key, session);
            
            log.info("kubectl port-forward started: localhost:{} -> {}:{}", 
                    localPort, key, remotePort);
            
            return localPort;
            
        } catch (Exception e) {
            throw new RuntimeException("Failed to start kubectl port-forward", e);
        }
    }
    
    /**
     * Stop port-forward to a pod.
     */
    public void stopPortForward(String namespace, String podName) {
        String key = (namespace != null ? namespace : defaultNamespace) + "/" + podName;
        
        PortForwardSession session = activePortForwards.remove(key);
        if (session != null) {
            closePortForward(session);
            log.info("Port-forward stopped: {}", key);
        }
    }
    
    /**
     * Check if port-forward is active.
     */
    public boolean isPortForwardActive(String namespace, String podName) {
        String key = (namespace != null ? namespace : defaultNamespace) + "/" + podName;
        return activePortForwards.containsKey(key);
    }
    
    /**
     * Get local port for active port-forward.
     */
    public int getLocalPort(String namespace, String podName) {
        String key = (namespace != null ? namespace : defaultNamespace) + "/" + podName;
        PortForwardSession session = activePortForwards.get(key);
        return session != null ? session.localPort : -1;
    }
    
    /**
     * Get all active port-forward sessions.
     */
    public Map<String, Integer> getActivePortForwards() {
        Map<String, Integer> result = new HashMap<>();
        activePortForwards.forEach((key, session) -> result.put(key, session.localPort));
        return result;
    }
    
    // ========== Helper Methods ==========
    
    private PodInfo toPodInfo(Pod pod) {
        var metadata = pod.getMetadata();
        var status = pod.getStatus();
        var spec = pod.getSpec();
        
        // Check for JDWP by looking at container args/env
        boolean jdwpEnabled = false;
        int jdwpPort = defaultJdwpPort;
        
        if (spec.getContainers() != null && !spec.getContainers().isEmpty()) {
            var container = spec.getContainers().get(0);
            var args = container.getArgs();
            var env = container.getEnv();
            
            // Check args for JDWP
            if (args != null) {
                jdwpEnabled = args.stream()
                        .anyMatch(arg -> arg.contains("jdwp") || arg.contains("5005"));
            }
            
            // Check env for JAVA_TOOL_OPTIONS
            if (env != null) {
                jdwpEnabled = jdwpEnabled || env.stream()
                        .anyMatch(e -> "JAVA_TOOL_OPTIONS".equals(e.getName()) && 
                                      e.getValue() != null && 
                                      e.getValue().contains("jdwp"));
            }
            
            // Assume JDWP is enabled if not explicitly found (common in debug environments)
            // In production, this should be more strict
            if (!jdwpEnabled) {
                jdwpEnabled = true; // Optimistic assumption for development
            }
        }
        
        // Get container status
        String containerStatus = "Unknown";
        int restartCount = 0;
        if (status.getContainerStatuses() != null && !status.getContainerStatuses().isEmpty()) {
            var cs = status.getContainerStatuses().get(0);
            restartCount = cs.getRestartCount();
            if (cs.getState().getRunning() != null) {
                containerStatus = "Running";
            } else if (cs.getState().getWaiting() != null) {
                containerStatus = "Waiting: " + cs.getState().getWaiting().getReason();
            } else if (cs.getState().getTerminated() != null) {
                containerStatus = "Terminated: " + cs.getState().getTerminated().getReason();
            }
        }
        
        // Check if pod is ready
        boolean ready = status.getConditions() != null && 
                status.getConditions().stream()
                        .anyMatch(c -> "Ready".equals(c.getType()) && "True".equals(c.getStatus()));
        
        return PodInfo.builder()
                .name(metadata.getName())
                .namespace(metadata.getNamespace())
                .podIp(status.getPodIP())
                .hostIp(status.getHostIP())
                .phase(status.getPhase())
                .nodeName(spec.getNodeName())
                .labels(metadata.getLabels() != null ? metadata.getLabels() : new HashMap<>())
                .annotations(metadata.getAnnotations() != null ? metadata.getAnnotations() : new HashMap<>())
                .creationTimestamp(parseTimestamp(metadata.getCreationTimestamp()))
                .ready(ready)
                .restartCount(restartCount)
                .containerStatus(containerStatus)
                .jdwpPort(jdwpPort)
                .jdwpEnabled(jdwpEnabled)
                .build();
    }
    
    private void closePortForward(PortForwardSession session) {
        try {
            if (session.fabric8PortForward != null) {
                session.fabric8PortForward.close();
            }
            if (session.kubectlProcess != null) {
                session.kubectlProcess.destroyForcibly();
            }
            log.debug("Closed port-forward session: {}", session.key);
        } catch (Exception e) {
            log.warn("Error closing port-forward: {}", e.getMessage());
        }
    }
    
    private int findAvailablePort() {
        try (var socket = new java.net.ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception e) {
            // Fallback to random port in range
            return 10000 + new Random().nextInt(50000);
        }
    }
    
    private Instant parseTimestamp(String timestamp) {
        if (timestamp == null || timestamp.isEmpty()) {
            return null;
        }
        try {
            return Instant.parse(timestamp);
        } catch (Exception e) {
            log.debug("Could not parse timestamp: {}", timestamp);
            return null;
        }
    }
    
    /**
     * Internal class to track port-forward sessions.
     */
    private static class PortForwardSession {
        String key;
        int localPort;
        int remotePort;
        LocalPortForward fabric8PortForward;
        Process kubectlProcess;
        long startTime;
    }
}
