import axios, { AxiosInstance } from 'axios';

/**
 * System thread patterns to filter out (same as frontend)
 */
const SYSTEM_THREAD_PATTERNS = [
  'Reference Handler',
  'Finalizer',
  'Signal Dispatcher',
  'Notification Thread',
  'Common-Cleaner',
  'Cleaner-',
  'Catalina-utility-',
  'container-',
  'Poller',
  'Acceptor',
  'DestroyJavaVM',
  'Attach Listener',
  'GC task thread',
  'VM Thread',
  'VM Periodic Task Thread',
  'C1 CompilerThread',
  'C2 CompilerThread',
];

/**
 * Check if a thread name matches system thread patterns
 */
function isSystemThread(threadName: string): boolean {
  return SYSTEM_THREAD_PATTERNS.some((pattern) => threadName.includes(pattern));
}

/**
 * Filter threads to show only relevant application threads (same logic as frontend)
 */
function filterThreads(threads: any[]): any[] {
  return threads.filter((thread) => {
    // Filter out system threads
    if (isSystemThread(thread.name)) {
      return false;
    }

    // Prefer HTTP threads (http-nio, exec-) when suspended
    if (thread.isSuspended) {
      return thread.name.includes('http-nio') || thread.name.includes('exec-');
    }

    // Show all non-system threads
    return true;
  });
}

export class JdwpClient {
  private apiBase: string;
  private axiosInstance: AxiosInstance;

  constructor(apiBase: string) {
    this.apiBase = apiBase;
    this.axiosInstance = axios.create({
      baseURL: apiBase,
      timeout: 30000,
    });
  }

  private formatResponse(data: any, isError = false) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
      isError,
    };
  }

  async connect(host: string, port: number) {
    try {
      const response = await this.axiosInstance.post('/connect', null, {
        params: { host, port },
      });

      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Connected successfully',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Connection failed',
        },
        true
      );
    }
  }

  async disconnect() {
    try {
      const response = await this.axiosInstance.post('/disconnect');
      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Disconnected successfully',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Disconnect failed',
        },
        true
      );
    }
  }

  async getStatus() {
    try {
      const response = await this.axiosInstance.get('/status');
      return this.formatResponse({
        connected: response.data.connected,
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Status check failed',
        },
        true
      );
    }
  }

  async setBreakpoint(className: string, lineNumber: number) {
    try {
      const response = await this.axiosInstance.post('/breakpoints', null, {
        params: { className, lineNumber },
      });

      return this.formatResponse({
        success: response.data.success,
        breakpointId: response.data.breakpointId,
        message: response.data.message || 'Breakpoint set successfully',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to set breakpoint',
        },
        true
      );
    }
  }

  async removeBreakpoint(breakpointId: string) {
    try {
      const response = await this.axiosInstance.delete(`/breakpoints/${encodeURIComponent(breakpointId)}`);
      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Breakpoint removed successfully',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to remove breakpoint',
        },
        true
      );
    }
  }

  async listBreakpoints() {
    try {
      const response = await this.axiosInstance.get('/breakpoints');
      return this.formatResponse({
        success: response.data.success,
        breakpoints: response.data.breakpoints || [],
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to list breakpoints',
        },
        true
      );
    }
  }

  async getThreads() {
    try {
      const response = await this.axiosInstance.get('/threads');
      if (response.data.success) {
        const allThreads = response.data.threads || [];
        // Filter threads to match frontend format (remove system threads)
        const filteredThreads = filterThreads(allThreads);

        return this.formatResponse({
          success: true,
          threads: filteredThreads,
          totalThreads: allThreads.length,
          filteredThreads: filteredThreads.length,
        });
      }
      return this.formatResponse(response.data);
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get threads',
        },
        true
      );
    }
  }

  async getVariables(threadName: string) {
    try {
      const response = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/variables-next-line`
      );

      if (response.data.success) {
        return this.formatResponse({
          success: true,
          threadName,
          variables: response.data.variables || {},
          variableCount: Object.keys(response.data.variables || {}).length,
        });
      }
      return this.formatResponse(response.data);
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get variables',
        },
        true
      );
    }
  }

  async getLocation(threadName: string) {
    try {
      const response = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/source-location`
      );

      if (response.data.success) {
        return this.formatResponse({
          success: true,
          threadName,
          location: response.data.location || {},
        });
      }
      return this.formatResponse(response.data);
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get location',
        },
        true
      );
    }
  }

  async stepOver(threadName: string) {
    try {
      const response = await this.axiosInstance.post(
        `/threads/${encodeURIComponent(threadName)}/step-over`
      );

      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Step over executed',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to step over',
        },
        true
      );
    }
  }

  async stepInto(threadName: string) {
    try {
      const response = await this.axiosInstance.post(
        `/threads/${encodeURIComponent(threadName)}/step-into`
      );

      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Step into executed',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to step into',
        },
        true
      );
    }
  }

  async stepOut(threadName: string) {
    try {
      const response = await this.axiosInstance.post(
        `/threads/${encodeURIComponent(threadName)}/step-out`
      );

      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Step out executed',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to step out',
        },
        true
      );
    }
  }

  async continueExecution() {
    try {
      const response = await this.axiosInstance.post('/continue');
      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Execution continuing',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to continue',
        },
        true
      );
    }
  }

  async resumeThread(threadName: string) {
    try {
      const response = await this.axiosInstance.post(
        `/threads/${encodeURIComponent(threadName)}/resume`
      );

      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Thread resumed',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to resume thread',
        },
        true
      );
    }
  }

  async suspendThread(threadName: string) {
    try {
      const response = await this.axiosInstance.post(
        `/threads/${encodeURIComponent(threadName)}/suspend`
      );

      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Thread suspended',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to suspend thread',
        },
        true
      );
    }
  }

  async evaluateExpression(threadName: string, expression: string) {
    try {
      const response = await this.axiosInstance.post(
        `/threads/${encodeURIComponent(threadName)}/evaluate`,
        null,
        {
          params: { expression },
        }
      );

      return this.formatResponse({
        success: response.data.success,
        result: response.data.result,
        expression: response.data.expression,
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to evaluate expression',
        },
        true
      );
    }
  }

  async getStackFrames(threadName: string) {
    try {
      const response = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/frames`
      );

      return this.formatResponse({
        success: response.data.success,
        threadName,
        frames: response.data.frames || [],
        frameCount: response.data.frames?.length || 0,
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get stack frames',
        },
        true
      );
    }
  }

  async getAllClasses() {
    try {
      const response = await this.axiosInstance.get('/classes');

      return this.formatResponse({
        success: response.data.success,
        classes: response.data.classes || [],
        classCount: response.data.classes?.length || 0,
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get classes',
        },
        true
      );
    }
  }

  async triggerClassLoading(url?: string, headers?: any) {
    try {
      // Optional: hit an endpoint of the target app so its classes get loaded,
      // making breakpoints settable before first use. Configure via env vars.
      const targetUrl = url || process.env.JDWP_TRIGGER_URL;

      if (!targetUrl) {
        return this.formatResponse({
          success: true,
          message: 'No trigger URL configured (set JDWP_TRIGGER_URL to enable).',
          note: 'Classes are usually loaded on first request anyway; this step is optional.',
        });
      }

      const defaultHeaders: Record<string, string> = {
        accept: 'application/json',
      };
      const envToken = process.env.JDWP_TRIGGER_TOKEN;
      if (envToken) {
        defaultHeaders['x-auth-token'] = envToken;
      }

      const requestHeaders = { ...defaultHeaders, ...headers };

      // Use axios to make the request (since we're in Node.js context)
      const axios = (await import('axios')).default;
      const response = await axios.get(targetUrl, {
        headers: requestHeaders,
        validateStatus: () => true, // Don't throw on any status
      });

      return this.formatResponse({
        success: true,
        message: 'Class loading triggered',
        statusCode: response.status,
        url: targetUrl,
        note: 'This may trigger class loading. Wait a moment before setting breakpoints.',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.message || 'Failed to trigger class loading',
          note: 'This is expected if the target application is not running. The API call helps load classes.',
        },
        false // Not a critical error
      );
    }
  }

  async getLogs(limit?: number, since?: number, thread?: string, stream?: string, filter?: boolean) {
    try {
      const params: any = {};
      if (limit) params.limit = limit;
      if (since) params.since = since;
      if (thread) params.thread = thread;
      if (stream) params.stream = stream;
      if (filter !== undefined) params.filter = filter;
      
      const response = await this.axiosInstance.get('/logs', { params });
      
      // Logs are now returned as simple string array: ["[stdout][console_log] message", ...]
      return this.formatResponse({
        success: response.data.success,
        logs: response.data.logs || [], // Array of strings
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get logs',
        },
        true
      );
    }
  }

  async clearLogs() {
    try {
      const response = await this.axiosInstance.post('/logs/clear');
      
      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Logs cleared',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to clear logs',
        },
        true
      );
    }
  }

  async getLogStatus() {
    try {
      const response = await this.axiosInstance.get('/logs/status');
      
      return this.formatResponse({
        success: response.data.success,
        running: response.data.running || false,
        message: response.data.message,
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get log status',
        },
        true
      );
    }
  }

  async getAgentLogs(limit?: number) {
    try {
      const params: any = {};
      if (limit) params.limit = limit;
      
      const response = await this.axiosInstance.get('/logs/agent', { params });
      
      return this.formatResponse({
        success: response.data.success,
        logs: response.data.logs || [], // Array of strings
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get agent logs',
        },
        true
      );
    }
  }

  async setExceptionBreakpoint(enabled: boolean, exceptionClass?: string) {
    try {
      const params: any = { enabled };
      if (exceptionClass) params.exceptionClass = exceptionClass;
      
      const response = await this.axiosInstance.post('/exception-breakpoint', null, { params });
      
      return this.formatResponse({
        success: response.data.success,
        message: response.data.message || 'Exception breakpoint configured',
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to set exception breakpoint',
        },
        true
      );
    }
  }

  async waitForBreakpoint(timeout: number = 5000, pollInterval: number = 100) {
    try {
      const response = await this.axiosInstance.post('/wait-for-breakpoint', null, {
        params: { timeout, pollInterval },
      });
      
      return this.formatResponse(response.data);
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to wait for breakpoint',
        },
        true
      );
    }
  }

  async getVariablesEnhanced(threadName: string, includeInstance: boolean = true) {
    try {
      const response = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/variables-enhanced`,
        { params: { includeInstance } }
      );
      
      return this.formatResponse({
        success: response.data.success,
        threadName,
        variables: response.data.variables || {},
      });
    } catch (error: any) {
      return this.formatResponse(
        {
          error: error.response?.data?.message || error.message || 'Failed to get enhanced variables',
        },
        true
      );
    }
  }

  /**
   * 🚀 AUTO DEBUG - The ultimate one-shot debugging tool
   * Does EVERYTHING automatically: connect, set breakpoint, execute API, capture exception
   */
  async autoDebug(curlCommand: string, options: {
    host?: string;
    port?: number;
    timeout?: number;
  } = {}) {
    const host = options.host || 'localhost';
    const port = options.port || 5005;
    const timeout = options.timeout || 15000;

    const report: any = {
      tool: 'AUTO_DEBUG',
      timestamp: new Date().toISOString(),
      steps: [],
      success: false,
    };

    try {
      // ========== STEP 1: Parse the curl command ==========
      report.steps.push({ step: 1, action: 'parse_curl', status: 'starting' });
      const parsed = this.parseCurlCommand(curlCommand);
      report.steps[0].status = 'completed';
      report.steps[0].parsed = {
        method: parsed.method,
        url: parsed.url,
        hasBody: !!parsed.body,
        headerCount: Object.keys(parsed.headers).length,
      };

      // ========== STEP 2: Ensure JDWP connection ==========
      report.steps.push({ step: 2, action: 'connect_jdwp', status: 'starting' });
      try {
        const statusResp = await this.axiosInstance.get('/status');
        if (!statusResp.data.connected) {
          await this.axiosInstance.post('/connect', null, { params: { host, port } });
          report.steps[1].status = 'connected';
        } else {
          report.steps[1].status = 'already_connected';
        }
      } catch (e: any) {
        report.steps[1].status = 'failed';
        report.steps[1].error = e.message;
        throw new Error(`JDWP connection failed: ${e.message}`);
      }

      // ========== STEP 3: Set exception breakpoint ==========
      report.steps.push({ step: 3, action: 'set_exception_breakpoint', status: 'starting' });
      try {
        await this.axiosInstance.post('/exception-breakpoint', null, {
          params: { enabled: true, exceptionClass: 'java.lang.Exception' },
        });
        report.steps[2].status = 'completed';
      } catch (e: any) {
        report.steps[2].status = 'warning';
        report.steps[2].note = 'Exception breakpoint may already be set';
      }

      // ========== STEP 4: Clear old logs ==========
      report.steps.push({ step: 4, action: 'clear_logs', status: 'starting' });
      try {
        await this.axiosInstance.post('/logs/clear');
        report.steps[3].status = 'completed';
      } catch (e) {
        report.steps[3].status = 'skipped';
      }

      // ========== STEP 5: Execute the API request ==========
      report.steps.push({ step: 5, action: 'execute_api', status: 'starting' });
      const axios = (await import('axios')).default;
      
      let apiResponse: any;
      let apiError: any;
      
      try {
        const axiosConfig: any = {
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          timeout: 30000,
          validateStatus: () => true, // Accept any status
        };
        if (parsed.body) {
          axiosConfig.data = parsed.body;
        }
        
        apiResponse = await axios(axiosConfig);
        report.steps[4].status = 'completed';
        report.steps[4].httpStatus = apiResponse.status;
        report.steps[4].statusText = apiResponse.statusText;
      } catch (e: any) {
        apiError = e;
        report.steps[4].status = 'error';
        report.steps[4].error = e.message;
      }

      // ========== STEP 6: Wait for exception breakpoint ==========
      report.steps.push({ step: 6, action: 'wait_for_exception', status: 'starting' });
      let breakpointData: any = null;
      
      try {
        const waitResp = await this.axiosInstance.post('/wait-for-breakpoint', null, {
          params: { timeout, pollInterval: 200 },
        });
        breakpointData = waitResp.data;
        report.steps[5].status = breakpointData.hit ? 'exception_caught' : 'no_exception';
        report.steps[5].threadName = breakpointData.threadName;
      } catch (e: any) {
        report.steps[5].status = 'timeout';
        report.steps[5].note = 'No exception within timeout';
      }

      // ========== STEP 7: Capture debugging info if exception was caught ==========
      if (breakpointData?.hit && breakpointData?.threadName) {
        const threadName = breakpointData.threadName;
        report.exceptionCaught = true;
        report.threadName = threadName;

        // Get location
        report.steps.push({ step: 7, action: 'get_location', status: 'starting' });
        try {
          const locResp = await this.axiosInstance.get(
            `/threads/${encodeURIComponent(threadName)}/source-location`
          );
          report.location = locResp.data.location || locResp.data;
          report.steps[6].status = 'completed';
        } catch (e: any) {
          report.steps[6].status = 'failed';
          report.steps[6].error = e.message;
        }

        // Get variables
        report.steps.push({ step: 8, action: 'get_variables', status: 'starting' });
        try {
          const varsResp = await this.axiosInstance.get(
            `/threads/${encodeURIComponent(threadName)}/variables-enhanced`,
            { params: { includeInstance: true } }
          );
          report.variables = varsResp.data.variables || varsResp.data;
          report.steps[7].status = 'completed';
          report.steps[7].variableCount = Object.keys(report.variables).length;
        } catch (e: any) {
          report.steps[7].status = 'failed';
          report.steps[7].error = e.message;
        }

        // Get stack frames
        report.steps.push({ step: 9, action: 'get_stack_frames', status: 'starting' });
        try {
          const framesResp = await this.axiosInstance.get(
            `/threads/${encodeURIComponent(threadName)}/frames`
          );
          report.stackFrames = (framesResp.data.frames || []).slice(0, 15); // Top 15 frames
          report.steps[8].status = 'completed';
          report.steps[8].frameCount = report.stackFrames.length;
        } catch (e: any) {
          report.steps[8].status = 'failed';
        }

        // Get logs
        report.steps.push({ step: 10, action: 'get_logs', status: 'starting' });
        try {
          const logsResp = await this.axiosInstance.get('/logs', {
            params: { limit: 50, filter: true },
          });
          report.logs = logsResp.data.logs || [];
          report.steps[9].status = 'completed';
          report.steps[9].logCount = report.logs.length;
        } catch (e: any) {
          report.steps[9].status = 'failed';
        }

        report.success = true;
        
        // ========== GENERATE ANALYSIS ==========
        report.analysis = this.generateAnalysis(report);
        
      } else {
        // No exception caught
        report.exceptionCaught = false;
        report.success = true;
        
        // Still get logs to see what happened
        try {
          const logsResp = await this.axiosInstance.get('/logs', {
            params: { limit: 50, filter: true },
          });
          report.logs = logsResp.data.logs || [];
        } catch (e) {}
        
        report.analysis = {
          conclusion: 'NO_EXCEPTION_CAUGHT',
          possibleReasons: [
            '1. The API request succeeded without throwing an exception',
            '2. Exceptions are being caught and handled internally (try-catch)',
            '3. The error is a 4xx/5xx HTTP error but not a Java exception',
            '4. The timeout was too short',
          ],
          httpStatus: apiResponse?.status,
          recommendation: apiResponse?.status >= 400 
            ? 'The API returned an error status. Check the response body and logs for details.'
            : 'The API succeeded. If you expected an error, check the response data.',
          responsePreview: typeof apiResponse?.data === 'string' 
            ? apiResponse.data.substring(0, 500)
            : JSON.stringify(apiResponse?.data || {}).substring(0, 500),
        };
      }

      return this.formatResponse(report);

    } catch (error: any) {
      report.success = false;
      report.error = error.message;
      report.analysis = {
        conclusion: 'DEBUG_FAILED',
        error: error.message,
        recommendation: 'Check that the JDWP client is running and the target application is accessible.',
      };
      return this.formatResponse(report);
    }
  }

  /**
   * Parse a curl command into method, url, headers, and body
   */
  private parseCurlCommand(curlCmd: string): {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  } {
    const result: any = {
      method: 'GET',
      url: '',
      headers: {},
    };

    // Clean up the command
    let cmd = curlCmd.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Remove 'curl' prefix
    cmd = cmd.replace(/^curl\s+/i, '');

    // Extract URL (first quoted string or unquoted URL)
    const urlMatch = cmd.match(/['"]?(https?:\/\/[^\s'"]+)['"]?/);
    if (urlMatch) {
      result.url = urlMatch[1];
    }

    // Extract method
    const methodMatch = cmd.match(/-X\s+['"]?(\w+)['"]?/i);
    if (methodMatch) {
      result.method = methodMatch[1].toUpperCase();
    } else if (cmd.includes('--data') || cmd.includes('-d ')) {
      result.method = 'POST';
    }

    // Extract headers
    const headerRegex = /-H\s+['"]([^'"]+)['"]/g;
    let headerMatch;
    while ((headerMatch = headerRegex.exec(cmd)) !== null) {
      const headerStr = headerMatch[1];
      const colonIndex = headerStr.indexOf(':');
      if (colonIndex > 0) {
        const key = headerStr.substring(0, colonIndex).trim();
        const value = headerStr.substring(colonIndex + 1).trim();
        result.headers[key] = value;
      }
    }

    // Extract body (--data-raw, --data, or -d)
    const bodyMatch = cmd.match(/(?:--data-raw|--data|-d)\s+['"](.+?)['"]\s*$/);
    if (bodyMatch) {
      let body = bodyMatch[1];
      // Unescape JSON
      body = body.replace(/\\"/g, '"');
      result.body = body;
    }

    return result;
  }

  /**
   * Generate human-readable analysis from debug data
   */
  private generateAnalysis(report: any): any {
    const analysis: any = {
      conclusion: 'EXCEPTION_FOUND',
    };

    // Extract exception info from location
    if (report.location) {
      const loc = report.location;
      analysis.exceptionLocation = {
        file: `${loc.className || loc.typeName || 'Unknown'}.java`,
        method: loc.methodName || 'unknown',
        line: loc.lineNumber || '?',
        fullPath: `${loc.className || ''}:${loc.lineNumber || '?'}`,
      };
      analysis.summary = `Exception at ${analysis.exceptionLocation.fullPath} in method ${analysis.exceptionLocation.method}()`;
    }

    // Find null values in variables
    const nullVars: string[] = [];
    const suspiciousVars: string[] = [];
    
    if (report.variables) {
      for (const [name, value] of Object.entries(report.variables)) {
        if (value === null || value === 'null') {
          nullVars.push(name);
        } else if (typeof value === 'string' && (value.includes('Exception') || value.includes('Error'))) {
          suspiciousVars.push(`${name}: ${value}`);
        }
      }
    }

    if (nullVars.length > 0) {
      analysis.nullVariables = nullVars;
      analysis.likelyIssue = `NULL value detected in: ${nullVars.join(', ')}. This is likely causing a NullPointerException.`;
    }

    if (suspiciousVars.length > 0) {
      analysis.suspiciousVariables = suspiciousVars;
    }

    // Extract exception type from stack frames
    if (report.stackFrames && report.stackFrames.length > 0) {
      const topFrames = report.stackFrames.slice(0, 5);
      analysis.callPath = topFrames.map((f: any) => 
        `${f.className || f.typeName || '?'}.${f.methodName || '?'}:${f.lineNumber || '?'}`
      );
    }

    // Extract error messages from logs
    if (report.logs && report.logs.length > 0) {
      const errorLogs = report.logs.filter((log: string) => 
        log.toLowerCase().includes('error') || 
        log.toLowerCase().includes('exception') ||
        log.includes('at ') // Stack trace lines
      );
      if (errorLogs.length > 0) {
        analysis.errorLogs = errorLogs.slice(0, 10);
      }
    }

    // Provide fix recommendation
    analysis.recommendation = this.generateRecommendation(analysis, report);

    return analysis;
  }

  /**
   * Generate fix recommendation based on analysis
   */
  private generateRecommendation(analysis: any, report: any): string {
    const recommendations: string[] = [];

    if (analysis.nullVariables && analysis.nullVariables.length > 0) {
      recommendations.push(
        `ADD NULL CHECK: The variable(s) ${analysis.nullVariables.join(', ')} are null. ` +
        `Add null checks before using these variables, or investigate why they are null.`
      );
    }

    if (analysis.exceptionLocation) {
      recommendations.push(
        `INVESTIGATE LINE ${analysis.exceptionLocation.line}: Open ${analysis.exceptionLocation.file} ` +
        `and look at line ${analysis.exceptionLocation.line} in method ${analysis.exceptionLocation.method}().`
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        'Review the stack frames and variables above to identify the root cause. ' +
        'Look for null values, invalid data, or unexpected state.'
      );
    }

    return recommendations.join('\n\n');
  }

  /**
   * 🧠 SMART DEBUG - Intelligent debugging that adapts to any bug type
   * 
   * Strategy:
   * 1. First PROBE the API to understand what's happening
   * 2. Analyze: Is it an exception? Wrong data? Empty response?
   * 3. Choose appropriate debugging strategy
   * 4. Execute that strategy and gather evidence
   * 5. Return comprehensive report with next steps
   */
  async smartDebug(params: {
    curlCommand: string;
    className?: string;      // Optional: specific class to debug
    methodName?: string;     // Optional: specific method to debug
    expectedBehavior?: string; // Optional: what SHOULD happen
    host?: string;
    port?: number;
  }) {
    const { curlCommand, className, methodName, expectedBehavior } = params;
    const host = params.host || 'localhost';
    const port = params.port || 5005;

    const report: any = {
      tool: 'SMART_DEBUG',
      timestamp: new Date().toISOString(),
      phases: [],
      success: false,
    };

    try {
      // ==================== PHASE 1: CONNECT ====================
      report.phases.push({ phase: 1, name: 'CONNECT', status: 'starting' });
      try {
        const statusResp = await this.axiosInstance.get('/status');
        if (!statusResp.data.connected) {
          await this.axiosInstance.post('/connect', null, { params: { host, port } });
        }
        report.phases[0].status = 'connected';
      } catch (e: any) {
        report.phases[0].status = 'failed';
        report.phases[0].error = e.message;
        throw new Error(`JDWP connection failed: ${e.message}`);
      }

      // ==================== PHASE 2: PROBE API ====================
      report.phases.push({ phase: 2, name: 'PROBE_API', status: 'starting' });
      const parsed = this.parseCurlCommand(curlCommand);
      
      // Clear old logs
      try { await this.axiosInstance.post('/logs/clear'); } catch (e) {}

      // Execute API WITHOUT any breakpoints first to see what happens
      const axios = (await import('axios')).default;
      let probeResponse: any;
      let probeError: any;
      const probeStart = Date.now();
      
      try {
        const axiosConfig: any = {
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          timeout: 30000,
          validateStatus: () => true,
        };
        if (parsed.body) axiosConfig.data = parsed.body;
        probeResponse = await axios(axiosConfig);
      } catch (e: any) {
        probeError = e;
      }
      const probeTime = Date.now() - probeStart;

      // Get logs from probe
      let probeLogs: string[] = [];
      try {
        const logsResp = await this.axiosInstance.get('/logs', { params: { limit: 100, filter: true } });
        probeLogs = logsResp.data.logs || [];
      } catch (e) {}

      report.phases[1].status = 'completed';
      report.phases[1].probe = {
        httpStatus: probeResponse?.status,
        responseTime: probeTime,
        hasError: probeError ? true : probeResponse?.status >= 400,
        responseDataPreview: this.truncate(JSON.stringify(probeResponse?.data || probeError?.message), 500),
        logCount: probeLogs.length,
      };

      // ==================== PHASE 3: ANALYZE & DECIDE STRATEGY ====================
      report.phases.push({ phase: 3, name: 'ANALYZE', status: 'starting' });
      
      const analysis = this.analyzeProbe(probeResponse, probeError, probeLogs, expectedBehavior);
      report.phases[2].status = 'completed';
      report.phases[2].analysis = analysis;
      report.bugType = analysis.bugType;
      report.strategy = analysis.strategy;

      // ==================== PHASE 4: EXECUTE STRATEGY ====================
      report.phases.push({ phase: 4, name: 'DEBUG', status: 'starting', strategy: analysis.strategy });

      if (analysis.strategy === 'EXCEPTION_BREAKPOINT') {
        // Exception debugging - set exception breakpoint and re-run
        await this.executeExceptionStrategy(report, parsed, analysis);
      } else if (analysis.strategy === 'LINE_BREAKPOINT' && className) {
        // Line breakpoint debugging - user specified where to look
        await this.executeLineBreakpointStrategy(report, parsed, className, methodName);
      } else if (analysis.strategy === 'ENTRY_TRACE') {
        // Entry tracing - find controller and trace from there
        await this.executeEntryTraceStrategy(report, parsed, analysis);
      } else {
        // No automatic strategy possible - return probe data and guidance
        report.phases[3].status = 'manual_intervention_needed';
        report.phases[3].reason = 'Could not determine automatic debugging strategy';
      }

      // ==================== PHASE 5: GENERATE FINAL REPORT ====================
      report.phases.push({ phase: 5, name: 'REPORT', status: 'completed' });
      report.success = true;
      
      // Generate actionable next steps
      report.nextSteps = this.generateSmartNextSteps(report, analysis);
      report.summary = this.generateSmartSummary(report);

      return this.formatResponse(report);

    } catch (error: any) {
      report.success = false;
      report.error = error.message;
      return this.formatResponse(report);
    }
  }

  /**
   * Analyze probe results to determine bug type and strategy
   */
  private analyzeProbe(response: any, error: any, logs: string[], expectedBehavior?: string): any {
    const analysis: any = {
      bugType: 'UNKNOWN',
      strategy: 'MANUAL',
      confidence: 0,
      evidence: [],
    };

    // Check logs for exceptions
    const exceptionInLogs = logs.some(log => 
      log.toLowerCase().includes('exception') || 
      log.toLowerCase().includes('error') ||
      log.includes('at ') // Stack trace pattern
    );

    // Check HTTP status
    const httpStatus = response?.status;
    const isServerError = httpStatus >= 500;
    const isClientError = httpStatus >= 400 && httpStatus < 500;
    const isSuccess = httpStatus >= 200 && httpStatus < 300;

    // Check response content
    const responseData = response?.data;
    const hasEmptyResponse = !responseData || 
      (Array.isArray(responseData) && responseData.length === 0) ||
      (typeof responseData === 'object' && Object.keys(responseData).length === 0);
    let hasNullInResponse = false;
    try {
      hasNullInResponse = JSON.stringify(responseData || {}).includes('null');
    } catch (e) {
      // Ignore stringify errors (circular refs, etc.)
    }

    // Determine bug type and strategy
    if (isServerError || (error && !response)) {
      // 500 error or connection error - likely exception
      analysis.bugType = 'EXCEPTION';
      analysis.strategy = 'EXCEPTION_BREAKPOINT';
      analysis.confidence = 90;
      analysis.evidence.push(`HTTP ${httpStatus || 'error'} indicates server-side exception`);
    } else if (exceptionInLogs) {
      // Exception in logs even without 500
      analysis.bugType = 'HANDLED_EXCEPTION';
      analysis.strategy = 'EXCEPTION_BREAKPOINT';
      analysis.confidence = 80;
      analysis.evidence.push('Exception patterns found in logs');
    } else if (isClientError) {
      // 4xx error - authentication, validation, etc.
      analysis.bugType = 'CLIENT_ERROR';
      analysis.strategy = 'ENTRY_TRACE';
      analysis.confidence = 70;
      analysis.evidence.push(`HTTP ${httpStatus} - likely validation or auth issue`);
    } else if (isSuccess && hasEmptyResponse) {
      // 200 but empty - logic error
      analysis.bugType = 'EMPTY_RESPONSE';
      analysis.strategy = 'ENTRY_TRACE';
      analysis.confidence = 75;
      analysis.evidence.push('Success response but empty data - logic error');
    } else if (isSuccess && expectedBehavior) {
      // 200 but user says it's wrong
      analysis.bugType = 'WRONG_DATA';
      analysis.strategy = 'ENTRY_TRACE';
      analysis.confidence = 60;
      analysis.evidence.push('User indicated expected behavior differs from actual');
    } else if (isSuccess) {
      // 200 with data - might be correct
      analysis.bugType = 'POSSIBLY_CORRECT';
      analysis.strategy = 'VERIFY';
      analysis.confidence = 50;
      analysis.evidence.push('API returned success with data');
    }

    analysis.httpStatus = httpStatus;
    analysis.hasExceptionInLogs = exceptionInLogs;
    analysis.relevantLogs = logs.filter(log => 
      log.toLowerCase().includes('error') || 
      log.toLowerCase().includes('exception') ||
      log.toLowerCase().includes('warn')
    ).slice(0, 10);

    return analysis;
  }

  /**
   * Execute exception breakpoint strategy
   */
  private async executeExceptionStrategy(report: any, parsed: any, analysis: any) {
    const phase = report.phases[3];
    
    try {
      // Set exception breakpoint
      await this.axiosInstance.post('/exception-breakpoint', null, {
        params: { enabled: true, exceptionClass: 'java.lang.Exception' },
      });
      phase.exceptionBreakpointSet = true;

      // Clear logs
      try { await this.axiosInstance.post('/logs/clear'); } catch (e) {}

      // Re-execute API
      const axios = (await import('axios')).default;
      const axiosConfig: any = {
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        timeout: 30000,
        validateStatus: () => true,
      };
      if (parsed.body) axiosConfig.data = parsed.body;
      
      // Execute in background (don't await fully)
      axios(axiosConfig).catch(() => {});
      
      // Wait for exception
      const waitResp = await this.axiosInstance.post('/wait-for-breakpoint', null, {
        params: { timeout: 15000, pollInterval: 200 },
      });
      
      if (waitResp.data.hit && waitResp.data.threadName) {
        phase.status = 'exception_caught';
        const threadName = waitResp.data.threadName;
        report.threadName = threadName;

        // Gather all debugging info
        await this.gatherDebugInfo(report, threadName);
        
      } else {
        phase.status = 'no_exception_caught';
        phase.note = 'Exception breakpoint did not trigger - exception may be caught internally';
        
        // Still get logs
        try {
          const logsResp = await this.axiosInstance.get('/logs', { params: { limit: 50, filter: true } });
          report.logs = logsResp.data.logs || [];
        } catch (e) {}
      }
    } catch (e: any) {
      phase.status = 'failed';
      phase.error = e.message;
    }
  }

  /**
   * Execute line breakpoint strategy
   */
  private async executeLineBreakpointStrategy(report: any, parsed: any, className: string, methodName?: string) {
    const phase = report.phases[3];
    
    try {
      // First, find the class and get its methods
      const classesResp = await this.axiosInstance.get('/classes');
      const classes = classesResp.data.classes || [];
      const targetClass = classes.find((c: any) => 
        c.name?.includes(className) || c.className?.includes(className)
      );

      if (!targetClass) {
        phase.status = 'class_not_found';
        phase.note = `Class containing "${className}" not found. It may not be loaded yet.`;
        phase.suggestedAction = 'Call the API first to load classes, then retry.';
        return;
      }

      phase.classFound = targetClass.name || targetClass.className;
      
      // For now, set breakpoint at line 1 of the method (user should specify line)
      phase.status = 'needs_line_number';
      phase.note = 'To set a line breakpoint, specify the exact line number.';
      phase.suggestedAction = `Use jdwp_set_breakpoint with className="${phase.classFound}" and the specific line number.`;
      
    } catch (e: any) {
      phase.status = 'failed';
      phase.error = e.message;
    }
  }

  /**
   * Execute entry trace strategy - find likely entry point and set breakpoint
   */
  private async executeEntryTraceStrategy(report: any, parsed: any, analysis: any) {
    const phase = report.phases[3];
    
    try {
      // Parse URL to guess controller class
      let urlPath = '/';
      try {
        urlPath = new URL(parsed.url).pathname;
      } catch (e) {
        // If URL parsing fails, try to extract path manually
        const match = parsed.url?.match(/https?:\/\/[^\/]+(\/.+?)(?:\?|$)/);
        urlPath = match ? match[1] : '/';
      }
      const pathParts = urlPath.split('/').filter((p: string) => p && !p.includes('api') && !p.includes('v1'));
      
      // Common patterns for controller class names
      const possibleControllerNames = [
        ...pathParts.map(p => this.toPascalCase(p) + 'Controller'),
        ...pathParts.map(p => this.toPascalCase(p) + 'Resource'),
        ...pathParts.map(p => this.toPascalCase(p) + 'Endpoint'),
      ];

      phase.urlPath = urlPath;
      phase.possibleControllers = possibleControllerNames;

      // Search for matching classes
      const classesResp = await this.axiosInstance.get('/classes');
      const classes = classesResp.data.classes || [];
      
      const matchingClasses = classes.filter((c: any) => {
        const name = c.name || c.className || '';
        return possibleControllerNames.some(pc => 
          name.toLowerCase().includes(pc.toLowerCase())
        ) || name.toLowerCase().includes('controller');
      }).slice(0, 10);

      if (matchingClasses.length > 0) {
        phase.status = 'controllers_found';
        phase.matchingClasses = matchingClasses.map((c: any) => c.name || c.className);
        phase.suggestedAction = 'Set breakpoint at the entry point of one of these controllers.';
        
        // Provide specific instructions
        phase.breakpointSuggestions = matchingClasses.slice(0, 3).map((c: any) => ({
          className: c.name || c.className,
          instruction: `jdwp_set_breakpoint(className="${c.name || c.className}", lineNumber=<first line of handler method>)`,
        }));
      } else {
        phase.status = 'no_controllers_found';
        phase.note = 'Could not identify controller class from URL pattern.';
        phase.suggestedAction = 'Manually specify the className using jdwp_set_breakpoint.';
      }
      
    } catch (e: any) {
      phase.status = 'failed';
      phase.error = e.message;
    }
  }

  /**
   * Gather all debugging info for a suspended thread
   */
  private async gatherDebugInfo(report: any, threadName: string) {
    // Location
    try {
      const locResp = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/source-location`
      );
      report.location = locResp.data.location || locResp.data;
    } catch (e) {}

    // Variables
    try {
      const varsResp = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/variables-enhanced`,
        { params: { includeInstance: true } }
      );
      report.variables = varsResp.data.variables || {};
    } catch (e) {}

    // Stack frames
    try {
      const framesResp = await this.axiosInstance.get(
        `/threads/${encodeURIComponent(threadName)}/frames`
      );
      report.stackFrames = (framesResp.data.frames || []).slice(0, 20);
    } catch (e) {}

    // Logs
    try {
      const logsResp = await this.axiosInstance.get('/logs', { params: { limit: 50, filter: true } });
      report.logs = logsResp.data.logs || [];
    } catch (e) {}

    // Analyze variables for issues
    report.variableAnalysis = this.analyzeVariables(report.variables);
  }

  /**
   * Analyze variables for common issues
   */
  private analyzeVariables(variables: any): any {
    const analysis: any = {
      nullValues: [],
      emptyCollections: [],
      suspiciousValues: [],
    };

    const checkValue = (name: string, value: any, path: string = '') => {
      const fullPath = path ? `${path}.${name}` : name;
      
      if (value === null || value === 'null') {
        analysis.nullValues.push(fullPath);
      } else if (Array.isArray(value) && value.length === 0) {
        analysis.emptyCollections.push(fullPath);
      } else if (typeof value === 'object' && value !== null) {
        if (Object.keys(value).length === 0) {
          analysis.emptyCollections.push(fullPath);
        } else {
          // Recurse into object (max depth 2)
          if (path.split('.').length < 2) {
            for (const [k, v] of Object.entries(value)) {
              checkValue(k, v, fullPath);
            }
          }
        }
      } else if (typeof value === 'string') {
        if (value.includes('Exception') || value.includes('Error')) {
          analysis.suspiciousValues.push({ path: fullPath, value });
        }
      }
    };

    for (const [name, value] of Object.entries(variables)) {
      checkValue(name, value);
    }

    return analysis;
  }

  /**
   * Generate smart next steps based on the entire debug session
   */
  private generateSmartNextSteps(report: any, analysis: any): string[] {
    const steps: string[] = [];
    const phase4 = report.phases[3];

    if (report.location) {
      steps.push(`📍 CURRENT LOCATION: ${report.location.className || report.location.typeName}:${report.location.lineNumber}`);
    }

    if (report.variableAnalysis?.nullValues?.length > 0) {
      steps.push(`⚠️ NULL VALUES FOUND: ${report.variableAnalysis.nullValues.join(', ')}`);
      steps.push(`   → Investigate why these are null. Check the code that sets these values.`);
    }

    if (phase4?.status === 'exception_caught') {
      steps.push(`✅ Exception caught! Review the location, variables, and stack trace above.`);
      steps.push(`   → The bug is at ${report.location?.className}:${report.location?.lineNumber}`);
      steps.push(`   → Fix the root cause, then call jdwp_continue to resume execution.`);
    } else if (phase4?.status === 'no_exception_caught') {
      steps.push(`⚠️ No exception caught. The error may be:`);
      steps.push(`   1. A caught exception (try-catch) - review logs for error messages`);
      steps.push(`   2. A logic error - set line breakpoint at suspected location`);
      steps.push(`   → Use: jdwp_set_breakpoint(className, lineNumber) to set specific breakpoint`);
    } else if (phase4?.status === 'controllers_found') {
      steps.push(`📋 Found possible controller classes. To debug:`);
      for (const suggestion of (phase4.breakpointSuggestions || []).slice(0, 2)) {
        steps.push(`   → Set breakpoint in ${suggestion.className}`);
      }
      steps.push(`   → Then re-run the API and use jdwp_wait_for_breakpoint`);
    }

    if (analysis.bugType === 'EMPTY_RESPONSE') {
      steps.push(`🔍 Empty response detected. Debug strategy:`);
      steps.push(`   1. Set breakpoint at the controller method`);
      steps.push(`   2. Step through to see where data becomes empty`);
      steps.push(`   3. Check service layer and repository calls`);
    }

    if (report.threadName) {
      steps.push(`\n🔧 Available actions for thread "${report.threadName}":`);
      steps.push(`   • jdwp_step_over("${report.threadName}") - Execute current line`);
      steps.push(`   • jdwp_step_into("${report.threadName}") - Enter method call`);
      steps.push(`   • jdwp_step_out("${report.threadName}") - Exit current method`);
      steps.push(`   • jdwp_get_variables("${report.threadName}") - Get updated variables`);
      steps.push(`   • jdwp_continue() - Resume execution`);
    }

    return steps;
  }

  /**
   * Generate a human-readable summary
   */
  private generateSmartSummary(report: any): string {
    const parts: string[] = [];
    
    parts.push(`=== SMART DEBUG REPORT ===`);
    parts.push(`Bug Type: ${report.bugType}`);
    parts.push(`Strategy Used: ${report.strategy}`);
    
    if (report.location) {
      parts.push(`Exception Location: ${report.location.className}:${report.location.lineNumber} in ${report.location.methodName}()`);
    }
    
    if (report.variableAnalysis?.nullValues?.length > 0) {
      parts.push(`⚠️ NULL VARIABLES: ${report.variableAnalysis.nullValues.join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Convert string to PascalCase
   */
  private toPascalCase(str: string): string {
    return str
      .split(/[-_]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
  }

  /**
   * Truncate string to max length
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  /**
   * 🛑 Stop the target application (kill process on port)
   */
  async stopTargetApp(options: {
    port?: number;
    jdwpPort?: number;
  } = {}): Promise<any> {
    const { exec } = await import('child_process');
    const appPort = options.port || 8081;
    const jdwpPort = options.jdwpPort || 5005;

    const result: any = {
      success: false,
      appPort,
      jdwpPort,
      steps: [],
    };

    const isWindows = process.platform === 'win32';

    // Try to kill by app port first, then JDWP port
    for (const port of [appPort, jdwpPort]) {
      result.steps.push({ action: `kill_process_on_port_${port}`, status: 'starting' });
      
      try {
        if (isWindows) {
          // Windows: Find PID and kill
          await new Promise<void>((resolve, reject) => {
            exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do @echo %a`, 
              { shell: 'cmd.exe' },
              (error, stdout) => {
                const pid = stdout.trim().split('\n')[0]?.trim();
                if (pid && /^\d+$/.test(pid)) {
                  exec(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }, (err) => {
                    if (!err) {
                      result.steps[result.steps.length - 1].status = 'killed';
                      result.steps[result.steps.length - 1].pid = pid;
                      result.success = true;
                    }
                    resolve();
                  });
                } else {
                  result.steps[result.steps.length - 1].status = 'no_process_found';
                  resolve();
                }
              }
            );
          });
        } else {
          // Unix
          await new Promise<void>((resolve) => {
            exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, (error, stdout) => {
              if (!error) {
                result.steps[result.steps.length - 1].status = 'killed';
                result.success = true;
              } else {
                result.steps[result.steps.length - 1].status = 'no_process_found';
              }
              resolve();
            });
          });
        }
      } catch (e: any) {
        result.steps[result.steps.length - 1].status = 'error';
        result.steps[result.steps.length - 1].error = e.message;
      }

      if (result.success) break;
    }

    if (result.success) {
      result.message = 'Application stopped. You can restart it from IntelliJ (Run) or use jdwp_start_target_app.';
    } else {
      result.message = 'No running application found on the specified ports.';
    }

    return this.formatResponse(result);
  }

  /**
   * 🚀 Start the target application with JDWP enabled
   */
  async startTargetApp(options: {
    jarPath?: string;
    appPort?: number;
    jdwpPort?: number;
    jvmOptions?: string[];
    springProfiles?: string;
    workingDir?: string;
    waitForReady?: boolean;
  } = {}): Promise<any> {
    const { spawn } = await import('child_process');
    const path = await import('path');
    const fs = await import('fs');

    const appPort = options.appPort || 8081;
    const jdwpPort = options.jdwpPort || 5005;
    const waitForReady = options.waitForReady !== false;
    const springProfiles = options.springProfiles || '';
    const userJvmOptions = options.jvmOptions || [];

    const result: any = {
      success: false,
      appPort,
      jdwpPort,
      steps: [],
    };

    // Step 1: Find JAR file
    result.steps.push({ step: 1, action: 'find_jar', status: 'starting' });
    
    let jarPath = options.jarPath;
    if (!jarPath) {
      // Try to find JAR in common locations
      const possiblePaths = [
        path.join(process.cwd(), 'target', '*.jar'),
        path.join(process.cwd(), '..', 'target', '*.jar'),
      ];
      
      // Look for JAR files
      for (const searchDir of [
        path.join(process.cwd(), 'target'),
        path.join(process.cwd(), '..', 'target'),
        options.workingDir ? path.join(options.workingDir, 'target') : '',
      ].filter(Boolean)) {
        if (fs.existsSync(searchDir)) {
          const files = fs.readdirSync(searchDir);
          const jar = files.find(f => f.endsWith('.jar') && !f.includes('sources') && !f.includes('javadoc'));
          if (jar) {
            jarPath = path.join(searchDir, jar);
            break;
          }
        }
      }
    }

    if (!jarPath || !fs.existsSync(jarPath)) {
      result.steps[0].status = 'failed';
      result.error = 'JAR file not found. Please specify jarPath or run mvn clean package first.';
      result.hint = 'Use jdwp_rebuild_target_app to build the application first.';
      return this.formatResponse(result, true);
    }

    result.steps[0].status = 'found';
    result.steps[0].jarPath = jarPath;

    // Step 2: Build Java command
    result.steps.push({ step: 2, action: 'build_command', status: 'starting' });

    const jvmOptions = [
      `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${jdwpPort}`,
      ...userJvmOptions,
    ];

    if (springProfiles) {
      jvmOptions.push(`-Dspring.profiles.active=${springProfiles}`);
    }

    const javaArgs = [
      ...jvmOptions,
      '-jar',
      jarPath,
      `--server.port=${appPort}`,
    ];

    result.command = `java ${javaArgs.join(' ')}`;
    result.steps[1].status = 'built';
    result.steps[1].command = result.command;

    // Step 3: Start the process
    result.steps.push({ step: 3, action: 'start_process', status: 'starting' });

    try {
      const workingDir = options.workingDir || path.dirname(jarPath);
      
      const javaProcess = spawn('java', javaArgs, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      });

      javaProcess.unref();
      
      result.steps[2].status = 'started';
      result.steps[2].pid = javaProcess.pid;

      // Capture startup output
      let startupOutput = '';
      javaProcess.stdout?.on('data', (data) => {
        startupOutput += data.toString();
      });
      javaProcess.stderr?.on('data', (data) => {
        startupOutput += data.toString();
      });

      // Step 4: Wait for ready
      if (waitForReady) {
        result.steps.push({ step: 4, action: 'wait_for_ready', status: 'starting' });
        
        const axios = (await import('axios')).default;
        const startTime = Date.now();
        const maxWait = 120000; // 2 minutes for app startup
        let ready = false;

        while (Date.now() - startTime < maxWait) {
          try {
            // Try to connect to the app
            const response = await axios.get(`http://localhost:${appPort}/actuator/health`, { 
              timeout: 2000,
              validateStatus: () => true,
            });
            if (response.status === 200 || response.status === 404) {
              ready = true;
              break;
            }
          } catch (e) {
            // Try a simple connection
            try {
              const response = await axios.get(`http://localhost:${appPort}`, { 
                timeout: 2000,
                validateStatus: () => true,
              });
              ready = true;
              break;
            } catch (e2) {
              // Not ready yet
            }
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (ready) {
          result.steps[3].status = 'ready';
          result.steps[3].waitTime = Date.now() - startTime;
          result.success = true;
          result.message = `Application started on port ${appPort} with JDWP on port ${jdwpPort}. Ready for debugging!`;
        } else {
          result.steps[3].status = 'timeout';
          result.steps[3].startupOutput = startupOutput.slice(-2000);
          result.success = true; // Process started, just not ready yet
          result.message = `Application started but health check timed out. It may still be starting. Check logs.`;
          result.hint = 'The application may take longer to start. Try jdwp_connect after a moment.';
        }
      } else {
        result.success = true;
        result.message = `Application starting on port ${appPort} with JDWP on port ${jdwpPort}.`;
      }

    } catch (e: any) {
      result.steps[2].status = 'failed';
      result.steps[2].error = e.message;
      result.error = `Failed to start application: ${e.message}`;
      return this.formatResponse(result, true);
    }

    return this.formatResponse(result);
  }

  /**
   * 🔨 Rebuild the target application (maven clean package)
   */
  async rebuildTargetApp(options: {
    projectDir?: string;
    skipTests?: boolean;
  } = {}): Promise<any> {
    const { spawn } = await import('child_process');
    const path = await import('path');
    const fs = await import('fs');

    // Find project directory with pom.xml
    let projectDir = options.projectDir;
    if (!projectDir) {
      const possiblePaths = [
        process.cwd(),
        path.join(process.cwd(), '..'),
      ];
      
      for (const p of possiblePaths) {
        if (fs.existsSync(path.join(p, 'pom.xml'))) {
          projectDir = p;
          break;
        }
      }
    }

    if (!projectDir || !fs.existsSync(path.join(projectDir, 'pom.xml'))) {
      return this.formatResponse({
        success: false,
        error: 'Could not find project directory with pom.xml',
        hint: 'Specify projectDir parameter or run from project root.',
      }, true);
    }

    const result: any = {
      success: false,
      projectDir,
      command: options.skipTests ? 'mvn clean package -DskipTests' : 'mvn clean package',
      output: [],
    };

    return new Promise((resolve) => {
      const args = ['clean', 'package'];
      if (options.skipTests) {
        args.push('-DskipTests');
      }

      const isWindows = process.platform === 'win32';
      const mvnCmd = isWindows ? 'mvn.cmd' : 'mvn';

      const mvnProcess = spawn(mvnCmd, args, {
        cwd: projectDir,
        shell: true,
      });

      let stdout = '';
      let stderr = '';

      mvnProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      mvnProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      mvnProcess.on('close', (code) => {
        result.exitCode = code;
        result.success = code === 0;
        
        const lines = stdout.split('\n');
        result.output = lines.filter(line => 
          line.includes('[INFO] BUILD') ||
          line.includes('[ERROR]') ||
          line.includes('Building ') ||
          line.includes('SUCCESS') ||
          line.includes('FAILURE')
        ).slice(-15);

        if (result.success) {
          result.message = 'Build successful!';
          // Find the built JAR
          const targetDir = path.join(projectDir!, 'target');
          if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            const jar = files.find(f => f.endsWith('.jar') && !f.includes('sources') && !f.includes('javadoc'));
            if (jar) {
              result.jarPath = path.join(targetDir, jar);
            }
          }
        } else {
          result.message = 'Build failed.';
          result.errors = stderr.split('\n').filter(l => l.trim()).slice(-10);
        }

        resolve(this.formatResponse(result));
      });

      // Timeout
      setTimeout(() => {
        mvnProcess.kill();
        result.error = 'Build timed out after 5 minutes';
        resolve(this.formatResponse(result, true));
      }, 300000);
    });
  }

  /**
   * 🔄 Full restart: Stop, rebuild, and start the target application
   */
  async restartTargetApp(options: {
    projectDir?: string;
    jarPath?: string;
    appPort?: number;
    jdwpPort?: number;
    springProfiles?: string;
    skipTests?: boolean;
    skipBuild?: boolean;
    jvmOptions?: string[];
  } = {}): Promise<any> {
    const result: any = {
      workflow: 'restart_target_app',
      steps: [],
      success: false,
    };

    const appPort = options.appPort || 8081;
    const jdwpPort = options.jdwpPort || 5005;

    // Step 1: Stop existing app
    result.steps.push({ step: 1, action: 'stop_app', status: 'starting' });
    try {
      const stopResult = await this.stopTargetApp({ port: appPort, jdwpPort });
      const stopData = JSON.parse(stopResult.content[0].text);
      result.steps[0].status = stopData.success ? 'stopped' : 'no_app_running';
    } catch (e: any) {
      result.steps[0].status = 'warning';
      result.steps[0].note = e.message;
    }

    // Wait for port to be released
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Rebuild (optional)
    if (!options.skipBuild) {
      result.steps.push({ step: 2, action: 'rebuild', status: 'starting' });
      try {
        const buildResult = await this.rebuildTargetApp({
          projectDir: options.projectDir,
          skipTests: options.skipTests !== false,
        });
        const buildData = JSON.parse(buildResult.content[0].text);
        result.steps[1].status = buildData.success ? 'built' : 'failed';
        if (!buildData.success) {
          result.error = 'Build failed';
          result.buildOutput = buildData.output;
          return this.formatResponse(result, true);
        }
        if (buildData.jarPath) {
          options.jarPath = buildData.jarPath;
        }
      } catch (e: any) {
        result.steps[1].status = 'failed';
        result.steps[1].error = e.message;
        return this.formatResponse(result, true);
      }
    }

    // Step 3: Start app
    const stepNum = options.skipBuild ? 2 : 3;
    result.steps.push({ step: stepNum, action: 'start_app', status: 'starting' });
    try {
      const startResult = await this.startTargetApp({
        jarPath: options.jarPath,
        appPort,
        jdwpPort,
        springProfiles: options.springProfiles,
        jvmOptions: options.jvmOptions,
        workingDir: options.projectDir,
      });
      const startData = JSON.parse(startResult.content[0].text);
      result.steps[stepNum - 1].status = startData.success ? 'started' : 'failed';
      
      if (startData.success) {
        result.success = true;
        result.message = `Application restarted! App: localhost:${appPort}, JDWP: localhost:${jdwpPort}`;
        result.command = startData.command;
        result.pid = startData.steps?.find((s: any) => s.pid)?.pid;
      } else {
        result.error = startData.error || 'Failed to start';
      }
    } catch (e: any) {
      result.steps[stepNum - 1].status = 'failed';
      result.steps[stepNum - 1].error = e.message;
    }

    return this.formatResponse(result);
  }

  /**
   * 🔧 Rebuild the JDWP client service (maven clean install)
   */
  async rebuildClient(options: {
    skipTests?: boolean;
    clientDir?: string;
  } = {}): Promise<any> {
    const { spawn } = await import('child_process');
    const path = await import('path');
    
    // Find client directory
    let clientDir = options.clientDir;
    if (!clientDir) {
      const possiblePaths = [
        path.join(process.cwd(), 'client'),
        path.join(process.cwd(), '..', 'client'),
        path.join(__dirname, '..', '..', 'client'),
        path.join(__dirname, '..', '..', '..', 'client'),
      ];
      
      const fs = await import('fs');
      for (const p of possiblePaths) {
        if (fs.existsSync(path.join(p, 'pom.xml'))) {
          clientDir = p;
          break;
        }
      }
    }

    if (!clientDir) {
      return this.formatResponse({
        success: false,
        error: 'Could not find client directory with pom.xml',
        searchedPaths: ['client/', '../client/'],
      }, true);
    }

    const result: any = {
      success: false,
      clientDir,
      command: options.skipTests ? 'mvn clean install -DskipTests' : 'mvn clean install',
      output: [],
      errors: [],
    };

    return new Promise((resolve) => {
      const args = ['clean', 'install'];
      if (options.skipTests) {
        args.push('-DskipTests');
      }

      // Use mvn.cmd on Windows, mvn on Unix
      const isWindows = process.platform === 'win32';
      const mvnCmd = isWindows ? 'mvn.cmd' : 'mvn';

      const mvnProcess = spawn(mvnCmd, args, {
        cwd: clientDir,
        shell: true,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      mvnProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      mvnProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      mvnProcess.on('error', (error) => {
        result.success = false;
        result.error = `Failed to start maven: ${error.message}`;
        resolve(this.formatResponse(result, true));
      });

      mvnProcess.on('close', (code) => {
        result.exitCode = code;
        result.success = code === 0;
        
        // Extract key info from output
        const lines = stdout.split('\n');
        result.output = lines.filter(line => 
          line.includes('[INFO] BUILD') ||
          line.includes('[ERROR]') ||
          line.includes('Building ') ||
          line.includes('SUCCESS') ||
          line.includes('FAILURE')
        ).slice(-20);
        
        if (stderr) {
          result.errors = stderr.split('\n').filter(l => l.trim()).slice(-10);
        }

        if (result.success) {
          result.message = 'Build successful! JAR file created.';
          result.jarPath = path.join(clientDir!, 'target', 'debug-client-1.0.0.jar');
        } else {
          result.message = 'Build failed. Check errors above.';
        }

        resolve(this.formatResponse(result));
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        mvnProcess.kill();
        result.success = false;
        result.error = 'Build timed out after 5 minutes';
        resolve(this.formatResponse(result, true));
      }, 300000);
    });
  }

  /**
   * 🔄 Restart the JDWP client service
   */
  async restartClient(options: {
    port?: number;
    jvmOptions?: string[];
    clientDir?: string;
    waitForReady?: boolean;
  } = {}): Promise<any> {
    const { spawn, exec } = await import('child_process');
    const path = await import('path');
    const fs = await import('fs');
    
    const port = options.port || 8083;
    const waitForReady = options.waitForReady !== false;
    const jvmOptions = options.jvmOptions || [];

    const result: any = {
      success: false,
      port,
      steps: [],
    };

    // Step 1: Find the JAR file
    result.steps.push({ step: 1, action: 'find_jar', status: 'starting' });
    
    let jarPath: string | null = null;
    const possiblePaths = [
      path.join(process.cwd(), 'client', 'target', 'debug-client-1.0.0.jar'),
      path.join(process.cwd(), '..', 'client', 'target', 'debug-client-1.0.0.jar'),
      path.join(__dirname, '..', '..', 'client', 'target', 'debug-client-1.0.0.jar'),
      path.join(__dirname, '..', '..', '..', 'client', 'target', 'debug-client-1.0.0.jar'),
    ];

    if (options.clientDir) {
      possiblePaths.unshift(path.join(options.clientDir, 'target', 'debug-client-1.0.0.jar'));
    }

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        jarPath = p;
        break;
      }
    }

    if (!jarPath) {
      result.steps[0].status = 'failed';
      result.steps[0].error = 'JAR file not found';
      result.error = 'Client JAR not found. Run jdwp_rebuild_client first.';
      return this.formatResponse(result, true);
    }

    result.steps[0].status = 'found';
    result.steps[0].jarPath = jarPath;

    // Step 2: Kill existing process on the port
    result.steps.push({ step: 2, action: 'kill_existing', status: 'starting' });
    
    try {
      const isWindows = process.platform === 'win32';
      
      if (isWindows) {
        // Windows: Find and kill process on port
        await new Promise<void>((resolve) => {
          exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, 
            { shell: 'cmd.exe' },
            (error) => {
              // Ignore errors - process might not exist
              resolve();
            }
          );
        });
      } else {
        // Unix: Kill process on port
        await new Promise<void>((resolve) => {
          exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, (error) => {
            resolve();
          });
        });
      }
      
      result.steps[1].status = 'completed';
      
      // Wait a moment for port to be released
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (e: any) {
      result.steps[1].status = 'warning';
      result.steps[1].note = 'Could not kill existing process (may not exist)';
    }

    // Step 3: Start new process
    result.steps.push({ step: 3, action: 'start_service', status: 'starting' });

    const javaArgs = [
      ...jvmOptions,
      '-jar',
      jarPath,
      `--server.port=${port}`,
    ];

    result.command = `java ${javaArgs.join(' ')}`;

    try {
      const javaProcess = spawn('java', javaArgs, {
        cwd: path.dirname(jarPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      });

      // Don't wait for the process - let it run in background
      javaProcess.unref();

      let startupOutput = '';
      
      // Capture initial output
      const outputPromise = new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve(startupOutput), 10000);
        
        javaProcess.stdout?.on('data', (data) => {
          startupOutput += data.toString();
          if (startupOutput.includes('Started') || startupOutput.includes('Tomcat started')) {
            clearTimeout(timeout);
            resolve(startupOutput);
          }
        });
        
        javaProcess.stderr?.on('data', (data) => {
          startupOutput += data.toString();
        });

        javaProcess.on('error', (error) => {
          clearTimeout(timeout);
          resolve(`Error: ${error.message}`);
        });
      });

      result.steps[2].status = 'launched';
      result.steps[2].pid = javaProcess.pid;

      // Step 4: Wait for service to be ready
      if (waitForReady) {
        result.steps.push({ step: 4, action: 'wait_for_ready', status: 'starting' });
        
        const startTime = Date.now();
        const maxWait = 60000; // 60 seconds
        let ready = false;

        while (Date.now() - startTime < maxWait) {
          try {
            const response = await this.axiosInstance.get('/status', { timeout: 2000 });
            if (response.status === 200) {
              ready = true;
              break;
            }
          } catch (e) {
            // Not ready yet
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (ready) {
          result.steps[3].status = 'ready';
          result.steps[3].waitTime = Date.now() - startTime;
          result.success = true;
          result.message = 'JDWP client service restarted and ready!';
        } else {
          result.steps[3].status = 'timeout';
          result.steps[3].startupOutput = startupOutput.slice(-1000);
          result.success = false;
          result.error = 'Service started but did not become ready within 60 seconds';
        }
      } else {
        result.success = true;
        result.message = 'JDWP client service started (not waiting for ready)';
      }

    } catch (e: any) {
      result.steps[2].status = 'failed';
      result.steps[2].error = e.message;
      result.error = `Failed to start service: ${e.message}`;
      return this.formatResponse(result, true);
    }

    return this.formatResponse(result);
  }
}

