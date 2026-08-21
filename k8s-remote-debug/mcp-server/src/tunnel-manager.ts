/**
 * Secure Tunnel Manager for kubectl port-forward
 * Manages secure tunnels to Kubernetes pods for JDWP debugging
 */

import { spawn, ChildProcess } from 'child_process';
import { TunnelInfo } from './types.js';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

export class TunnelManager extends EventEmitter {
  private tunnels: Map<string, TunnelInfo> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private kubectlPath: string;
  private kubeconfig?: string;
  private namespace: string;

  constructor(options: {
    kubectlPath?: string;
    kubeconfig?: string;
    namespace?: string;
  } = {}) {
    super();
    this.kubectlPath = options.kubectlPath || 'kubectl';
    this.kubeconfig = options.kubeconfig;
    this.namespace = options.namespace || 'debug-services';
    
    // Start health check loop
    this.startHealthCheck();
  }

  /**
   * Create a new tunnel to a pod
   */
  async createTunnel(
    podName: string,
    remotePort: number,
    localPort?: number,
    type: 'http' | 'jdwp' = 'jdwp'
  ): Promise<TunnelInfo> {
    const tunnelId = uuidv4();
    const effectiveLocalPort = localPort || await this.findAvailablePort(remotePort);
    
    const tunnelInfo: TunnelInfo = {
      id: tunnelId,
      podName,
      namespace: this.namespace,
      localPort: effectiveLocalPort,
      remotePort,
      status: 'connecting',
      type,
      createdAt: new Date()
    };

    this.tunnels.set(tunnelId, tunnelInfo);

    try {
      const process = await this.startPortForward(tunnelInfo);
      this.processes.set(tunnelId, process);

      // Wait for connection
      await this.waitForConnection(tunnelInfo);

      tunnelInfo.status = 'active';
      this.emit('tunnel-created', tunnelInfo);

      return tunnelInfo;
    } catch (error) {
      // Never leak a half-open kubectl process or a stale map entry.
      const proc = this.processes.get(tunnelId);
      if (proc) {
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        this.processes.delete(tunnelId);
      }
      this.tunnels.delete(tunnelId);
      tunnelInfo.status = 'error';
      tunnelInfo.error = error instanceof Error ? error.message : String(error);
      this.emit('tunnel-error', tunnelInfo, error);
      throw error;
    }
  }

  /**
   * Start kubectl port-forward process
   */
  private async startPortForward(tunnel: TunnelInfo): Promise<ChildProcess> {
    const args = [
      'port-forward',
      '-n', tunnel.namespace,
      `pod/${tunnel.podName}`,
      `${tunnel.localPort}:${tunnel.remotePort}`
    ];

    if (this.kubeconfig) {
      args.unshift('--kubeconfig', this.kubeconfig);
    }

    console.error(`[TunnelManager] Starting port-forward: ${this.kubectlPath} ${args.join(' ')}`);

    const process = spawn(this.kubectlPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    tunnel.pid = process.pid;

    process.stdout?.on('data', (data) => {
      const output = data.toString();
      console.error(`[TunnelManager] ${tunnel.id}: ${output}`);
      if (output.includes('Forwarding from')) {
        tunnel.status = 'active';
      }
    });

    process.stderr?.on('data', (data) => {
      const error = data.toString();
      console.error(`[TunnelManager] ${tunnel.id} ERROR: ${error}`);
      if (error.includes('error') || error.includes('Error')) {
        tunnel.status = 'error';
        tunnel.error = error;
      }
    });

    process.on('exit', (code) => {
      console.error(`[TunnelManager] ${tunnel.id} exited with code ${code}`);
      tunnel.status = 'disconnected';
      this.processes.delete(tunnel.id);
      this.tunnels.delete(tunnel.id);
      this.emit('tunnel-closed', tunnel);
    });

    process.on('error', (error) => {
      console.error(`[TunnelManager] ${tunnel.id} process error:`, error);
      tunnel.status = 'error';
      tunnel.error = error.message;
    });

    return process;
  }

  /**
   * Wait for tunnel connection to be established
   */
  private async waitForConnection(tunnel: TunnelInfo, timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      if (tunnel.status === 'active') {
        return;
      }
      if (tunnel.status === 'error') {
        throw new Error(tunnel.error || 'Tunnel connection failed');
      }
      await this.sleep(200);
    }
    
    throw new Error(`Tunnel connection timeout after ${timeoutMs}ms`);
  }

  /**
   * Close a tunnel
   */
  async closeTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      throw new Error(`Tunnel ${tunnelId} not found`);
    }

    const process = this.processes.get(tunnelId);
    if (process) {
      process.kill('SIGTERM');
      this.processes.delete(tunnelId);
    }

    tunnel.status = 'disconnected';
    this.tunnels.delete(tunnelId);
    this.emit('tunnel-closed', tunnel);
  }

  /**
   * Close all tunnels
   */
  async closeAllTunnels(): Promise<void> {
    const tunnelIds = Array.from(this.tunnels.keys());
    await Promise.all(tunnelIds.map(id => this.closeTunnel(id)));
  }

  /**
   * Get tunnel info
   */
  getTunnel(tunnelId: string): TunnelInfo | undefined {
    return this.tunnels.get(tunnelId);
  }

  /**
   * List all tunnels
   */
  listTunnels(): TunnelInfo[] {
    return Array.from(this.tunnels.values());
  }

  /**
   * Get tunnel by pod and port
   */
  getTunnelByPodPort(podName: string, remotePort: number): TunnelInfo | undefined {
    return Array.from(this.tunnels.values()).find(
      t => t.podName === podName && t.remotePort === remotePort && t.status === 'active'
    );
  }

  /**
   * Check tunnel health
   */
  async checkTunnelHealth(tunnelId: string): Promise<boolean> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.status !== 'active') {
      return false;
    }

    const process = this.processes.get(tunnelId);
    if (!process || process.killed || process.exitCode !== null) {
      tunnel.status = 'disconnected';
      return false;
    }

    tunnel.lastHealthCheck = new Date();
    return true;
  }

  /**
   * Start periodic health checks; prune dead tunnels so ports are reusable.
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      for (const [tunnelId, tunnel] of this.tunnels) {
        if (tunnel.status === 'active') {
          const healthy = await this.checkTunnelHealth(tunnelId);
          if (!healthy) {
            this.tunnels.delete(tunnelId);
            this.emit('tunnel-unhealthy', tunnel);
          }
        }
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Find an available port: prefer the requested one, verify with a real
   * socket bind, then scan upward. Avoids colliding with other apps too.
   */
  private async findAvailablePort(preferredPort: number): Promise<number> {
    const usedPorts = new Set(
      Array.from(this.tunnels.values()).map(t => t.localPort)
    );

    let port = preferredPort;
    while (port <= 65535) {
      if (!usedPorts.has(port) && await this.isPortFree(port)) {
        return port;
      }
      port++;
    }
    throw new Error('No available ports');
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net') as typeof import('net');
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    await this.closeAllTunnels();
  }
}
