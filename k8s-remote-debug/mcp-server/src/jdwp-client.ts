/**
 * JDWP Client - Communicates with the Java debug client
 */

import axios, { AxiosInstance } from 'axios';
import { 
  JdwpConnection, 
  VariableInfo, 
  StackFrame, 
  ThreadInfo,
  BreakpointInfo,
  DebugResult,
  SmartDebugResult
} from './types.js';

export class JdwpClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private connected: boolean = false;

  constructor(port: number = 8083) {
    this.baseUrl = `http://localhost:${port}`;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Check if the JDWP client service is ready
   */
  async isReady(): Promise<boolean> {
    try {
      const response = await this.client.get('/api/debug/status');
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Connect to JDWP server
   */
  async connect(host: string, port: number): Promise<JdwpConnection> {
    const response = await this.client.post('/api/debug/connect', null, {
      params: { host, port }
    });
    this.connected = response.data.success;
    return response.data;
  }

  /**
   * Disconnect from JDWP server
   */
  async disconnect(): Promise<void> {
    await this.client.post('/api/debug/disconnect');
    this.connected = false;
  }

  /**
   * Get connection status
   */
  async getStatus(): Promise<{ connected: boolean; vmInfo?: any }> {
    const response = await this.client.get('/api/debug/status');
    return response.data;
  }

  /**
   * Set a breakpoint
   */
  async setBreakpoint(className: string, lineNumber: number): Promise<BreakpointInfo> {
    const response = await this.client.post('/api/debug/breakpoints', null, {
      params: { className, lineNumber }
    });
    return response.data;
  }

  /**
   * Set a conditional breakpoint with request ID
   * Note: Currently sets a regular breakpoint - conditional filtering is done at breakpoint hit time
   * by checking RequestContext.shouldSuspend() via evaluate
   */
  async setConditionalBreakpoint(
    className: string, 
    lineNumber: number, 
    requestId: string
  ): Promise<BreakpointInfo> {
    // Set a regular breakpoint - conditional logic is handled at hit time
    const response = await this.client.post('/api/debug/breakpoints', null, {
      params: { className, lineNumber }
    });
    return {
      ...response.data,
      condition: `RequestContext.shouldSuspend("${requestId}")`,
      requestId
    };
  }

  /**
   * Remove a breakpoint
   */
  async removeBreakpoint(className: string, lineNumber: number): Promise<void> {
    // Get breakpoint ID first
    const breakpoints = await this.listBreakpoints();
    const bp = breakpoints.find(b => 
      b.className === className && b.lineNumber === lineNumber
    );
    if (bp && bp.id) {
      await this.client.delete(`/api/debug/breakpoints/${bp.id}`);
    }
  }

  /**
   * List all breakpoints
   */
  async listBreakpoints(): Promise<BreakpointInfo[]> {
    const response = await this.client.get('/api/debug/breakpoints');
    return response.data.breakpoints || response.data;
  }

  /**
   * Set exception breakpoint
   */
  async setExceptionBreakpoint(exceptionClass?: string): Promise<any> {
    const response = await this.client.post('/api/debug/exception-breakpoint', null, {
      params: { exceptionClass }
    });
    return response.data;
  }

  /**
   * Wait for breakpoint hit
   */
  async waitForBreakpoint(timeoutMs: number = 30000): Promise<{
    hit: boolean;
    threadName?: string;
    location?: any;
  }> {
    const response = await this.client.post('/api/debug/wait-for-breakpoint', null, {
      params: { timeout: timeoutMs, pollInterval: 100 },
      timeout: timeoutMs + 5000
    });
    return response.data;
  }

  /**
   * Get all threads
   */
  async getThreads(): Promise<ThreadInfo[]> {
    const response = await this.client.get('/api/debug/threads');
    return response.data;
  }

  /**
   * Get thread by request ID
   */
  async getThreadByRequestId(requestId: string): Promise<ThreadInfo | null> {
    const threads = await this.getThreads();
    // This would need integration with the RequestContext evaluation
    // For now, look for suspended threads
    return threads.find(t => t.isSuspended) || null;
  }

  /**
   * Suspend a thread
   */
  async suspendThread(threadName: string): Promise<void> {
    await this.client.post('/api/debug/thread/suspend', null, {
      params: { threadName }
    });
  }

  /**
   * Resume a thread
   */
  async resumeThread(threadName: string): Promise<void> {
    await this.client.post('/api/debug/thread/resume', null, {
      params: { threadName }
    });
  }

  /**
   * Get variables for a thread
   */
  async getVariables(threadName: string): Promise<Record<string, VariableInfo>> {
    const response = await this.client.get(`/api/debug/threads/${encodeURIComponent(threadName)}/variables-next-line`);
    return response.data.variables || response.data;
  }

  /**
   * Get enhanced variables (with object fields)
   */
  async getVariablesEnhanced(threadName: string): Promise<Record<string, any>> {
    const response = await this.client.get(`/api/debug/threads/${encodeURIComponent(threadName)}/variables-enhanced`);
    return response.data.variables || response.data;
  }

  /**
   * Get stack frames
   */
  async getStackFrames(threadName: string): Promise<StackFrame[]> {
    const response = await this.client.get(`/api/debug/threads/${encodeURIComponent(threadName)}/frames`);
    return response.data.frames || response.data;
  }

  /**
   * Get current location
   */
  async getLocation(threadName: string): Promise<{
    className: string;
    methodName: string;
    lineNumber: number;
  }> {
    const response = await this.client.get(`/api/debug/threads/${encodeURIComponent(threadName)}/source-location`);
    return response.data.location || response.data;
  }

  /**
   * Step over
   */
  async stepOver(threadName: string): Promise<void> {
    await this.client.post(`/api/debug/threads/${encodeURIComponent(threadName)}/step-over`);
  }

  /**
   * Step into
   */
  async stepInto(threadName: string): Promise<void> {
    await this.client.post(`/api/debug/threads/${encodeURIComponent(threadName)}/step-into`);
  }

  /**
   * Step out
   */
  async stepOut(threadName: string): Promise<void> {
    await this.client.post(`/api/debug/threads/${encodeURIComponent(threadName)}/step-out`);
  }

  /**
   * Continue execution (all threads)
   */
  async continue(): Promise<void> {
    await this.client.post('/api/debug/continue');
  }

  /**
   * Evaluate expression
   */
  async evaluateExpression(threadName: string, expression: string): Promise<any> {
    const response = await this.client.post(`/api/debug/threads/${encodeURIComponent(threadName)}/evaluate`, null, {
      params: { expression }
    });
    return response.data;
  }

  /**
   * Get logs
   */
  async getLogs(lines?: number, filter?: string): Promise<string[]> {
    const response = await this.client.get('/api/debug/logs', {
      params: { lines, filter }
    });
    return response.data.logs || response.data;
  }

  /**
   * Clear logs
   */
  async clearLogs(): Promise<void> {
    await this.client.post('/api/debug/logs/clear');
  }

  /**
   * Smart debug - intelligent debugging workflow
   */
  async smartDebug(curlCommand: string, expectedBehavior?: string): Promise<SmartDebugResult> {
    const response = await this.client.post('/api/debug/smart-debug', null, {
      params: { curlCommand, expectedBehavior }
    });
    return response.data;
  }

  /**
   * Auto debug - one-shot debugging
   */
  async autoDebug(curlCommand: string): Promise<DebugResult> {
    const response = await this.client.post('/api/debug/auto-debug', null, {
      params: { curlCommand }
    });
    return response.data;
  }
}
