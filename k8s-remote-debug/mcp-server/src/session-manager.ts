/**
 * Debug Session Manager
 * Manages debug sessions with request-ID based filtering
 */

import { v4 as uuidv4 } from 'uuid';
import { DebugSession, BreakpointInfo } from './types.js';
import { TunnelManager } from './tunnel-manager.js';
import { JdwpClient } from './jdwp-client.js';
import { EventEmitter } from 'events';

export class SessionManager extends EventEmitter {
  private sessions: Map<string, DebugSession> = new Map();
  private requestIdToSession: Map<string, string> = new Map();
  private tunnelManager: TunnelManager;
  private jdwpClient: JdwpClient;
  private sessionTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    tunnelManager: TunnelManager,
    jdwpClient: JdwpClient,
    options: {
      sessionTimeoutMs?: number;
    } = {}
  ) {
    super();
    this.tunnelManager = tunnelManager;
    this.jdwpClient = jdwpClient;
    this.sessionTimeoutMs = options.sessionTimeoutMs || 300000; // 5 minutes default
    
    // Start cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Create a new debug session
   */
  async createSession(
    podName: string,
    namespace: string,
    jdwpPort: number,
    httpPort?: number
  ): Promise<DebugSession> {
    const sessionId = uuidv4();
    const requestId = `debug-${sessionId.slice(0, 8)}`;

    // Create JDWP tunnel
    const jdwpTunnel = await this.tunnelManager.createTunnel(
      podName,
      jdwpPort,
      undefined,
      'jdwp'
    );

    // Optionally create HTTP tunnel for triggering requests
    let httpTunnelId: string | undefined;
    if (httpPort) {
      const httpTunnel = await this.tunnelManager.createTunnel(
        podName,
        httpPort,
        undefined,
        'http'
      );
      httpTunnelId = httpTunnel.id;
    }

    // Connect JDWP client
    await this.jdwpClient.connect('localhost', jdwpTunnel.localPort);

    const session: DebugSession = {
      id: sessionId,
      requestId,
      podName,
      namespace,
      jdwpTunnelId: jdwpTunnel.id,
      httpTunnelId,
      status: 'ready',
      breakpoints: [],
      createdAt: new Date(),
      lastActivity: new Date()
    };

    this.sessions.set(sessionId, session);
    this.requestIdToSession.set(requestId, sessionId);

    this.emit('session-created', session);
    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): DebugSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get session by request ID
   */
  getSessionByRequestId(requestId: string): DebugSession | undefined {
    const sessionId = this.requestIdToSession.get(requestId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /**
   * List all sessions
   */
  listSessions(): DebugSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Set breakpoint for session
   */
  async setBreakpoint(
    sessionId: string,
    className: string,
    lineNumber: number
  ): Promise<BreakpointInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Set conditional breakpoint that only triggers for this request ID
    const breakpoint = await this.jdwpClient.setConditionalBreakpoint(
      className,
      lineNumber,
      session.requestId
    );

    // Track breakpoint in session
    const bpInfo: BreakpointInfo = {
      id: `${className}:${lineNumber}`,
      className,
      lineNumber,
      condition: `RequestContext.shouldSuspend("${session.requestId}")`,
      hitCount: 0,
      enabled: true
    };
    
    session.breakpoints.push(bpInfo);
    session.lastActivity = new Date();

    this.emit('breakpoint-set', session, bpInfo);
    return bpInfo;
  }

  /**
   * Remove breakpoint from session
   */
  async removeBreakpoint(
    sessionId: string,
    className: string,
    lineNumber: number
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    await this.jdwpClient.removeBreakpoint(className, lineNumber);
    
    session.breakpoints = session.breakpoints.filter(
      bp => !(bp.className === className && bp.lineNumber === lineNumber)
    );
    session.lastActivity = new Date();
  }

  /**
   * Wait for breakpoint hit on this session's request
   */
  async waitForBreakpoint(sessionId: string, timeoutMs: number = 30000): Promise<{
    hit: boolean;
    threadName?: string;
    location?: any;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = 'debugging';
    session.lastActivity = new Date();

    const result = await this.jdwpClient.waitForBreakpoint(timeoutMs);
    
    if (result.hit) {
      session.status = 'suspended';
    }

    return result;
  }

  /**
   * Get variables for session's suspended thread
   */
  async getVariables(sessionId: string, threadName: string): Promise<Record<string, any>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.lastActivity = new Date();
    return this.jdwpClient.getVariables(threadName);
  }

  /**
   * Step execution
   */
  async step(sessionId: string, threadName: string, type: 'over' | 'into' | 'out'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.lastActivity = new Date();

    switch (type) {
      case 'over':
        await this.jdwpClient.stepOver(threadName);
        break;
      case 'into':
        await this.jdwpClient.stepInto(threadName);
        break;
      case 'out':
        await this.jdwpClient.stepOut(threadName);
        break;
    }
  }

  /**
   * Continue execution
   */
  async continue(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = 'ready';
    session.lastActivity = new Date();
    await this.jdwpClient.continue();
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Remove all breakpoints
    for (const bp of session.breakpoints) {
      try {
        await this.jdwpClient.removeBreakpoint(bp.className, bp.lineNumber);
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Continue any suspended threads
    try {
      await this.jdwpClient.continue();
    } catch {
      // Ignore
    }

    // Disconnect JDWP
    try {
      await this.jdwpClient.disconnect();
    } catch {
      // Ignore
    }

    // Close tunnels
    if (session.jdwpTunnelId) {
      try {
        await this.tunnelManager.closeTunnel(session.jdwpTunnelId);
      } catch {
        // Ignore
      }
    }
    if (session.httpTunnelId) {
      try {
        await this.tunnelManager.closeTunnel(session.httpTunnelId);
      } catch {
        // Ignore
      }
    }

    // Remove session
    session.status = 'closed';
    this.sessions.delete(sessionId);
    this.requestIdToSession.delete(session.requestId);

    this.emit('session-closed', session);
  }

  /**
   * Get the request ID header to use for triggering debug
   */
  getRequestIdHeader(sessionId: string): { name: string; value: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      name: 'X-Debug-Request-Id',
      value: session.requestId
    };
  }

  /**
   * Get the curl command with request ID
   */
  getCurlCommand(sessionId: string, baseUrl: string, endpoint: string, method: string = 'GET'): string {
    const header = this.getRequestIdHeader(sessionId);
    if (!header) {
      return '';
    }

    return `curl -X ${method} -H "${header.name}: ${header.value}" "${baseUrl}${endpoint}"`;
  }

  /**
   * Start cleanup interval for expired sessions
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [sessionId, session] of this.sessions) {
        const elapsed = now - session.lastActivity.getTime();
        
        if (elapsed > this.sessionTimeoutMs) {
          console.error(`[SessionManager] Session ${sessionId} expired, cleaning up`);
          this.closeSession(sessionId).catch(console.error);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.closeSession(id)));
  }
}
