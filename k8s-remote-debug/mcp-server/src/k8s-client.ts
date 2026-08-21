/**
 * Production-Ready Kubernetes Client for Remote Debugging
 * 
 * Features:
 * - Dynamic service discovery
 * - Environment/context selection
 * - Automatic JDWP port detection from pod labels
 * - Selects first pod of deployment (always available even with 0 traffic)
 */

import * as k8s from '@kubernetes/client-node';
import { PodInfo, ContainerInfo, ServiceInfo, ContextInfo } from './types.js';

export class K8sClient {
  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private namespace: string;
  private currentContext: string;

  constructor(options: {
    kubeconfig?: string;
    context?: string;
    namespace?: string;
  } = {}) {
    this.kc = new k8s.KubeConfig();
    
    // Load kubeconfig
    if (options.kubeconfig) {
      this.kc.loadFromFile(options.kubeconfig);
    } else {
      this.kc.loadFromDefault();
    }

    // Set context if specified
    if (options.context) {
      this.kc.setCurrentContext(options.context);
    }
    
    this.currentContext = this.kc.getCurrentContext() || 'default';
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.namespace = options.namespace || 'default';
  }

  // ==================== Context/Environment Management ====================

  /**
   * List all available Kubernetes contexts (environments)
   * Contexts typically map to: dev, staging, production, etc.
   */
  listContexts(): ContextInfo[] {
    return this.kc.getContexts().map(ctx => ({
      name: ctx.name,
      cluster: ctx.cluster,
      user: ctx.user,
      namespace: ctx.namespace,
      isCurrent: ctx.name === this.currentContext
    }));
  }

  /**
   * Switch to a different context (environment)
   */
  setContext(contextName: string): void {
    const contexts = this.kc.getContexts();
    if (!contexts.find(c => c.name === contextName)) {
      throw new Error(`Context '${contextName}' not found. Available: ${contexts.map(c => c.name).join(', ')}`);
    }
    
    this.kc.setCurrentContext(contextName);
    this.currentContext = contextName;
    
    // Recreate API clients with new context
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    
    console.error(`[K8sClient] Switched to context: ${contextName}`);
  }

  /**
   * Get current context
   */
  getCurrentContext(): string {
    return this.currentContext;
  }

  // ==================== Namespace Management ====================

  /**
   * List all namespaces
   */
  async listNamespaces(): Promise<string[]> {
    try {
      const response = await this.coreApi.listNamespace();
      return response.body.items.map(ns => ns.metadata?.name || '').filter(Boolean);
    } catch (error) {
      console.error('[K8sClient] Error listing namespaces:', error);
      throw error;
    }
  }

  /**
   * Set namespace
   */
  setNamespace(namespace: string): void {
    this.namespace = namespace;
    console.error(`[K8sClient] Set namespace to: ${namespace}`);
  }

  /**
   * Get current namespace
   */
  getNamespace(): string {
    return this.namespace;
  }

  // ==================== Service Discovery ====================

  /**
   * List all debug-enabled services in the namespace
   * Looks for pods with label: debug-enabled=true
   * Returns unique services (deployments) with their debug configuration
   */
  async listDebugEnabledServices(): Promise<ServiceInfo[]> {
    try {
      // Get all debug-enabled pods
      const response = await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'debug-enabled=true'
      );

      // Group by deployment/app label to get unique services
      const serviceMap = new Map<string, ServiceInfo>();
      
      for (const pod of response.body.items) {
        const appName = pod.metadata?.labels?.['app'] || 
                       pod.metadata?.labels?.['app.kubernetes.io/name'] ||
                       pod.metadata?.name?.split('-').slice(0, -2).join('-') || 
                       'unknown';
        
        if (!serviceMap.has(appName)) {
          // Detect JDWP port from container ports or annotations
          const jdwpPort = this.detectJdwpPort(pod);
          const httpPort = this.detectHttpPort(pod);
          
          serviceMap.set(appName, {
            name: appName,
            namespace: this.namespace,
            podCount: 1,
            jdwpPort,
            httpPort,
            debugEnabled: true,
            labels: pod.metadata?.labels || {}
          });
        } else {
          serviceMap.get(appName)!.podCount++;
        }
      }

      return Array.from(serviceMap.values());
    } catch (error) {
      console.error('[K8sClient] Error listing debug services:', error);
      throw error;
    }
  }

  /**
   * Detect JDWP port from pod spec
   * Checks: annotations, container ports, env vars
   */
  private detectJdwpPort(pod: k8s.V1Pod): number {
    // 1. Check annotation
    const annotationPort = pod.metadata?.annotations?.['debug.jdwp.port'];
    if (annotationPort) {
      return parseInt(annotationPort);
    }

    // 2. Check container ports named 'jdwp' or 'debug'
    for (const container of pod.spec?.containers || []) {
      for (const port of container.ports || []) {
        if (port.name === 'jdwp' || port.name === 'debug') {
          return port.containerPort;
        }
      }
    }

    // 3. Check JAVA_TOOL_OPTIONS env var for JDWP port
    for (const container of pod.spec?.containers || []) {
      for (const env of container.env || []) {
        if (env.name === 'JAVA_TOOL_OPTIONS' && env.value) {
          const match = env.value.match(/address=\*?:?(\d+)/);
          if (match) {
            return parseInt(match[1]);
          }
        }
      }
    }

    // 4. Default JDWP port
    return 5005;
  }

  /**
   * Detect HTTP port from pod spec
   */
  private detectHttpPort(pod: k8s.V1Pod): number {
    for (const container of pod.spec?.containers || []) {
      for (const port of container.ports || []) {
        if (port.name === 'http' || port.name === 'web' || port.containerPort === 8080 || port.containerPort === 8081) {
          return port.containerPort;
        }
      }
    }
    return 8080;
  }

  // ==================== Pod Management ====================

  /**
   * List all debug-enabled pods
   */
  async listDebuggablePods(): Promise<PodInfo[]> {
    try {
      const response = await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'debug-enabled=true'
      );

      return response.body.items.map((pod: k8s.V1Pod) => this.mapPodToInfo(pod));
    } catch (error) {
      console.error('[K8sClient] Error listing pods:', error);
      throw error;
    }
  }

  /**
   * Get a specific pod
   */
  async getPod(podName: string): Promise<PodInfo | null> {
    try {
      const response = await this.coreApi.readNamespacedPod(podName, this.namespace);
      return this.mapPodToInfo(response.body);
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get FIRST running pod for a service (deployment)
   * This pod is always available even with 0 traffic
   */
  async getFirstPodForService(serviceName: string): Promise<PodInfo | null> {
    try {
      const response = await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `app=${serviceName}`
      );

      if (response.body.items.length === 0) {
        // Try alternative label
        const altResponse = await this.coreApi.listNamespacedPod(
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `app.kubernetes.io/name=${serviceName}`
        );
        
        if (altResponse.body.items.length === 0) {
          return null;
        }
        
        return this.getFirstRunningPod(altResponse.body.items);
      }

      return this.getFirstRunningPod(response.body.items);
    } catch (error) {
      console.error('[K8sClient] Error getting pod for service:', error);
      throw error;
    }
  }

  /**
   * Get first running pod from list
   */
  private getFirstRunningPod(pods: k8s.V1Pod[]): PodInfo | null {
    // Prefer running pods
    const runningPod = pods.find(pod => pod.status?.phase === 'Running');
    if (runningPod) {
      return this.mapPodToInfo(runningPod);
    }
    
    // Fall back to first pod
    if (pods.length > 0) {
      return this.mapPodToInfo(pods[0]);
    }
    
    return null;
  }

  /**
   * Get pod by app label (alias for getFirstPodForService)
   */
  async getPodByApp(appName: string): Promise<PodInfo | null> {
    return this.getFirstPodForService(appName);
  }

  /**
   * List all pods for a specific service (deployment)
   * Returns ALL pods, not just the first one
   */
  async listPodsForService(serviceName: string): Promise<PodInfo[]> {
    try {
      const response = await this.coreApi.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `app=${serviceName}`
      );

      if (response.body.items.length === 0) {
        // Try alternative label
        const altResponse = await this.coreApi.listNamespacedPod(
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `app.kubernetes.io/name=${serviceName}`
        );
        
        return altResponse.body.items.map((pod: k8s.V1Pod) => this.mapPodToInfo(pod));
      }

      return response.body.items.map((pod: k8s.V1Pod) => this.mapPodToInfo(pod));
    } catch (error) {
      console.error('[K8sClient] Error listing pods for service:', error);
      throw error;
    }
  }

  /**
   * Get pod status
   */
  async getPodStatus(podName: string): Promise<{
    status: string;
    ready: boolean;
    restartCount: number;
    conditions: Array<{ type: string; status: string }>;
  } | null> {
    try {
      const response = await this.coreApi.readNamespacedPod(podName, this.namespace);

      const containerStatuses = response.body.status?.containerStatuses || [];
      const restartCount = containerStatuses.reduce(
        (sum: number, cs: k8s.V1ContainerStatus) => sum + (cs.restartCount || 0), 0
      );

      return {
        status: response.body.status?.phase || 'Unknown',
        ready: containerStatuses.every((cs: k8s.V1ContainerStatus) => cs.ready),
        restartCount,
        conditions: (response.body.status?.conditions || []).map((c: k8s.V1PodCondition) => ({
          type: c.type,
          status: c.status
        }))
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Restart a pod (by deleting it - K8s will recreate via deployment)
   */
  async restartPod(podName: string): Promise<boolean> {
    try {
      await this.coreApi.deleteNamespacedPod(podName, this.namespace);
      return true;
    } catch (error) {
      console.error('[K8sClient] Error restarting pod:', error);
      throw error;
    }
  }

  /**
   * Get pod logs
   */
  async getPodLogs(podName: string, options: {
    container?: string;
    tailLines?: number;
    sinceSeconds?: number;
  } = {}): Promise<string> {
    try {
      const response = await this.coreApi.readNamespacedPodLog(
        podName,
        this.namespace,
        options.container,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        options.sinceSeconds,
        options.tailLines || 100
      );
      return response.body;
    } catch (error) {
      console.error('[K8sClient] Error getting pod logs:', error);
      throw error;
    }
  }

  /**
   * Map K8s pod object to PodInfo
   */
  private mapPodToInfo(pod: k8s.V1Pod): PodInfo {
    const containers: ContainerInfo[] = (pod.spec?.containers || []).map((c: k8s.V1Container) => ({
      name: c.name,
      image: c.image || '',
      ready: (pod.status?.containerStatuses || []).find(
        (cs: k8s.V1ContainerStatus) => cs.name === c.name
      )?.ready || false,
      ports: (c.ports || []).map((p: k8s.V1ContainerPort) => ({
        name: p.name || '',
        containerPort: p.containerPort,
        protocol: p.protocol || 'TCP'
      }))
    }));

    return {
      name: pod.metadata?.name || '',
      namespace: pod.metadata?.namespace || this.namespace,
      status: pod.status?.phase || 'Unknown',
      ip: pod.status?.podIP,
      containers,
      labels: pod.metadata?.labels || {},
      createdAt: pod.metadata?.creationTimestamp?.toISOString() || '',
      debugEnabled: pod.metadata?.labels?.['debug-enabled'] === 'true',
      jdwpPort: this.detectJdwpPort(pod),
      httpPort: this.detectHttpPort(pod)
    };
  }
}
