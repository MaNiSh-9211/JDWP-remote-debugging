#!/usr/bin/env node
/**
 * MCP Server for Kubernetes Remote JDWP Debugging
 * 
 * This server provides tools for:
 * - Managing Kubernetes pods with JDWP debugging enabled
 * - Creating secure tunnels via kubectl port-forward
 * - Request-ID based selective debugging
 * - Full JDWP debugging operations
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { TunnelManager } from './tunnel-manager.js';
import { K8sClient } from './k8s-client.js';
import { JdwpClient } from './jdwp-client.js';
import { SessionManager } from './session-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const JDWP_CLIENT_PORT = 8083;
const NAMESPACE = process.env.K8S_NAMESPACE || 'debug-services';
const KUBECONFIG = process.env.KUBECONFIG;

// Global instances
let tunnelManager: TunnelManager;
let k8sClient: K8sClient;
let jdwpClient: JdwpClient;
let sessionManager: SessionManager;
let jdwpClientProcess: ChildProcess | null = null;

/**
 * Ensure the Java JDWP client is available.
 * If one is already running on the port (e.g. started by the user or by
 * jdwp-mcp), reuse it instead of spawning a duplicate that would fail to bind.
 */
async function startJdwpClient(): Promise<void> {
  // Reuse an already-running client if reachable.
  for (let i = 0; i < 3; i++) {
    if (await jdwpClient.isReady()) {
      console.error('[MCP] JDWP client already running on port ' + JDWP_CLIENT_PORT + ', reusing it');
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const jarPath = path.resolve(__dirname, '../../../client/target/debug-client-1.0.0.jar');

  console.error(`[MCP] Starting JDWP client from: ${jarPath}`);

  jdwpClientProcess = spawn('java', [
    '-jar', jarPath,
    '--server.port=' + JDWP_CLIENT_PORT
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  jdwpClientProcess.stdout?.on('data', (data) => {
    console.error(`[JDWP Client] ${data.toString()}`);
  });

  jdwpClientProcess.stderr?.on('data', (data) => {
    console.error(`[JDWP Client ERR] ${data.toString()}`);
  });

  jdwpClientProcess.on('exit', (code) => {
    console.error(`[MCP] JDWP client exited with code ${code}`);
  });

  // Wait for client to be ready
  const maxRetries = 30;
  for (let i = 0; i < maxRetries; i++) {
    if (await jdwpClient.isReady()) {
      console.error('[MCP] JDWP client is ready');
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error('JDWP client failed to start');
}

/**
 * Tool definitions
 */
const TOOLS = [
  // ============ Environment/Context Selection ============
  {
    name: 'k8s_list_environments',
    description: 'List all available Kubernetes environments (contexts). Use this first to see dev, staging, prod, etc.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'k8s_select_environment',
    description: 'Switch to a different Kubernetes environment (context)',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: 'Environment/context name (e.g., dev, staging, prod)' }
      },
      required: ['environment']
    }
  },
  {
    name: 'k8s_list_namespaces',
    description: 'List all namespaces in the current environment',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'k8s_select_namespace',
    description: 'Select a namespace to work in',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace name' }
      },
      required: ['namespace']
    }
  },

  // ============ Service Discovery ============
  {
    name: 'k8s_list_debug_services',
    description: 'List all debug-enabled services in the current namespace. Shows service name, pod count, and ports.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'k8s_connect_to_service',
    description: 'Connect to a service for debugging. Creates tunnel and connects JDWP. Returns session info.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceName: { type: 'string', description: 'Service name to connect to' },
        jdwpPort: { type: 'number', description: 'JDWP port (auto-detected if not specified)' }
      },
      required: ['serviceName']
    }
  },

  // ============ Kubernetes Pod Management ============
  {
    name: 'k8s_list_pods',
    description: 'List all debug-enabled pods in the Kubernetes cluster',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Kubernetes namespace (default: current namespace)'
        }
      }
    }
  },
  {
    name: 'k8s_list_service_pods',
    description: 'List all pods for a specific service. Use when you want to manually select a specific pod.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceName: { type: 'string', description: 'Service name (e.g., vcp-service)' }
      },
      required: ['serviceName']
    }
  },
  {
    name: 'k8s_connect_to_pod',
    description: 'Connect to a SPECIFIC pod for debugging. Creates tunnel and JDWP connection to the specified pod.',
    inputSchema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'Full pod name (e.g., vcp-service-xxx-abc123)' },
        jdwpPort: { type: 'number', description: 'JDWP port (default: 5005)' },
        httpPort: { type: 'number', description: 'HTTP port (default: 8081)' }
      },
      required: ['podName']
    }
  },
  {
    name: 'k8s_get_pod_status',
    description: 'Get detailed status of a specific pod',
    inputSchema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'Name of the pod' }
      },
      required: ['podName']
    }
  },
  {
    name: 'k8s_get_pod_logs',
    description: 'Get logs from a pod',
    inputSchema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'Name of the pod' },
        tailLines: { type: 'number', description: 'Number of lines to tail (default: 100)' },
        container: { type: 'string', description: 'Container name (optional)' }
      },
      required: ['podName']
    }
  },
  {
    name: 'k8s_restart_pod',
    description: 'Restart a pod (deletes it, K8s will recreate)',
    inputSchema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'Name of the pod' }
      },
      required: ['podName']
    }
  },
  
  // ============ Tunnel Management ============
  {
    name: 'k8s_create_tunnel',
    description: 'Create a secure tunnel to a pod via kubectl port-forward',
    inputSchema: {
      type: 'object',
      properties: {
        podName: { type: 'string', description: 'Name of the pod' },
        remotePort: { type: 'number', description: 'Remote port in the pod' },
        localPort: { type: 'number', description: 'Local port to bind (optional, auto-assigned if not provided)' },
        type: { type: 'string', enum: ['http', 'jdwp'], description: 'Tunnel type' }
      },
      required: ['podName', 'remotePort']
    }
  },
  {
    name: 'k8s_close_tunnel',
    description: 'Close a tunnel',
    inputSchema: {
      type: 'object',
      properties: {
        tunnelId: { type: 'string', description: 'ID of the tunnel to close' }
      },
      required: ['tunnelId']
    }
  },
  {
    name: 'k8s_list_tunnels',
    description: 'List all active tunnels',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'k8s_tunnel_health',
    description: 'Check health of a tunnel',
    inputSchema: {
      type: 'object',
      properties: {
        tunnelId: { type: 'string', description: 'ID of the tunnel' }
      },
      required: ['tunnelId']
    }
  },

  // ============ Debug Session Management ============
  {
    name: 'k8s_create_debug_session',
    description: 'Create a new debug session for a service. Use k8s_list_debug_services first to see available services.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { 
          type: 'string', 
          description: 'Service name to debug (use k8s_list_debug_services to see available)' 
        }
      },
      required: ['service']
    }
  },
  {
    name: 'k8s_close_debug_session',
    description: 'Close a debug session, cleaning up all resources',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to close' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'k8s_list_debug_sessions',
    description: 'List all active debug sessions',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'k8s_get_debug_curl',
    description: 'Get the curl command with debug headers for a session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        endpoint: { type: 'string', description: 'API endpoint to call' },
        method: { type: 'string', description: 'HTTP method (default: GET)' }
      },
      required: ['sessionId', 'endpoint']
    }
  },

  // ============ JDWP Debugging (Session-scoped) ============
  {
    name: 'k8s_set_breakpoint',
    description: 'Set a conditional breakpoint that only triggers for the debug request',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        className: { type: 'string', description: 'Fully qualified class name' },
        lineNumber: { type: 'number', description: 'Line number' }
      },
      required: ['sessionId', 'className', 'lineNumber']
    }
  },
  {
    name: 'k8s_remove_breakpoint',
    description: 'Remove a breakpoint',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        className: { type: 'string', description: 'Fully qualified class name' },
        lineNumber: { type: 'number', description: 'Line number' }
      },
      required: ['sessionId', 'className', 'lineNumber']
    }
  },
  {
    name: 'k8s_list_breakpoints',
    description: 'List all breakpoints in a session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'k8s_wait_for_breakpoint',
    description: 'Wait for breakpoint to be hit (after sending debug request)',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'k8s_get_variables',
    description: 'Get variables at current breakpoint',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        threadName: { type: 'string', description: 'Thread name' }
      },
      required: ['sessionId', 'threadName']
    }
  },
  {
    name: 'k8s_get_stack_frames',
    description: 'Get stack frames at current breakpoint',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        threadName: { type: 'string', description: 'Thread name' }
      },
      required: ['sessionId', 'threadName']
    }
  },
  {
    name: 'k8s_step_over',
    description: 'Step over to next line',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        threadName: { type: 'string', description: 'Thread name' }
      },
      required: ['sessionId', 'threadName']
    }
  },
  {
    name: 'k8s_step_into',
    description: 'Step into a method call',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        threadName: { type: 'string', description: 'Thread name' }
      },
      required: ['sessionId', 'threadName']
    }
  },
  {
    name: 'k8s_step_out',
    description: 'Step out of current method',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        threadName: { type: 'string', description: 'Thread name' }
      },
      required: ['sessionId', 'threadName']
    }
  },
  {
    name: 'k8s_continue',
    description: 'Continue execution',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'k8s_evaluate_expression',
    description: 'Evaluate a Java expression in the current context',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        threadName: { type: 'string', description: 'Thread name' },
        expression: { type: 'string', description: 'Java expression to evaluate' }
      },
      required: ['sessionId', 'threadName', 'expression']
    }
  },

  // ============ Smart Debugging ============
  {
    name: 'k8s_smart_debug',
    description: 'Intelligent debugging - analyzes the API call and chooses best debugging strategy',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Debug session ID' },
        curlCommand: { type: 'string', description: 'curl command to debug (will auto-inject request ID)' },
        expectedBehavior: { type: 'string', description: 'What the API should return (optional)' }
      },
      required: ['sessionId', 'curlCommand']
    }
  }
];

/**
 * Handle tool calls
 */
async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    // ============ Environment/Context Selection ============
    case 'k8s_list_environments': {
      const contexts = k8sClient.listContexts();
      const current = k8sClient.getCurrentContext();
      return {
        success: true,
        currentEnvironment: current,
        environments: contexts,
        hint: 'Use k8s_select_environment to switch environments'
      };
    }

    case 'k8s_select_environment': {
      k8sClient.setContext(args.environment);
      return {
        success: true,
        message: `Switched to environment: ${args.environment}`,
        currentEnvironment: args.environment,
        currentNamespace: k8sClient.getNamespace()
      };
    }

    case 'k8s_list_namespaces': {
      const namespaces = await k8sClient.listNamespaces();
      return {
        success: true,
        currentNamespace: k8sClient.getNamespace(),
        namespaces,
        hint: 'Use k8s_select_namespace to switch namespaces'
      };
    }

    case 'k8s_select_namespace': {
      k8sClient.setNamespace(args.namespace);
      return {
        success: true,
        message: `Switched to namespace: ${args.namespace}`,
        currentNamespace: args.namespace
      };
    }

    // ============ Service Discovery ============
    case 'k8s_list_debug_services': {
      const services = await k8sClient.listDebugEnabledServices();
      return {
        success: true,
        currentEnvironment: k8sClient.getCurrentContext(),
        currentNamespace: k8sClient.getNamespace(),
        services: services.map(s => ({
          name: s.name,
          podCount: s.podCount,
          jdwpPort: s.jdwpPort,
          httpPort: s.httpPort
        })),
        count: services.length,
        hint: 'Use k8s_connect_to_service to connect to a service for debugging'
      };
    }

    case 'k8s_connect_to_service': {
      // 1. Find the service's first pod
      const pod = await k8sClient.getFirstPodForService(args.serviceName);
      if (!pod) {
        throw new McpError(ErrorCode.InternalError, `No running pod found for service: ${args.serviceName}`);
      }

      // 2. Determine JDWP port (from args or auto-detect)
      const jdwpPort = args.jdwpPort || pod.jdwpPort || 5005;
      const httpPort = pod.httpPort || 8080;

      // 3. Create debug session
      const session = await sessionManager.createSession(
        pod.name,
        pod.namespace,
        jdwpPort,
        httpPort
      );

      return {
        success: true,
        session: {
          id: session.id,
          requestId: session.requestId,
          podName: session.podName,
          status: session.status
        },
        connection: {
          environment: k8sClient.getCurrentContext(),
          namespace: k8sClient.getNamespace(),
          service: args.serviceName,
          pod: pod.name,
          jdwpPort,
          httpPort
        },
        usage: {
          debugHeader: `X-Debug-Request-Id: ${session.requestId}`,
          curlExample: `curl -H "X-Debug-Request-Id: ${session.requestId}" http://localhost:${httpPort}/api/...`,
          breakpointClass: 'com.debugger.filter.RequestContext',
          breakpointLine: 135
        }
      };
    }

    // ============ Kubernetes Pod Management ============
    case 'k8s_list_pods': {
      if (args.namespace) {
        k8sClient.setNamespace(args.namespace);
      }
      const pods = await k8sClient.listDebuggablePods();
      return {
        success: true,
        currentNamespace: k8sClient.getNamespace(),
        pods: pods.map(p => ({
          name: p.name,
          service: p.labels?.['app'] || 'unknown',
          status: p.status,
          ip: p.ip,
          ready: p.containers?.[0]?.ready || false,
          jdwpPort: p.jdwpPort,
          httpPort: p.httpPort
        })),
        count: pods.length
      };
    }

    case 'k8s_list_service_pods': {
      const pods = await k8sClient.listPodsForService(args.serviceName);
      return {
        success: true,
        service: args.serviceName,
        namespace: k8sClient.getNamespace(),
        pods: pods.map((p, idx) => ({
          index: idx + 1,
          name: p.name,
          status: p.status,
          ip: p.ip,
          ready: p.containers?.[0]?.ready || false,
          jdwpPort: p.jdwpPort,
          httpPort: p.httpPort
        })),
        count: pods.length,
        hint: 'Use k8s_connect_to_pod with the pod name to connect to a specific pod'
      };
    }

    case 'k8s_connect_to_pod': {
      // Get pod info
      const pod = await k8sClient.getPod(args.podName);
      if (!pod) {
        throw new McpError(ErrorCode.InvalidParams, `Pod not found: ${args.podName}`);
      }

      const jdwpPort = args.jdwpPort || pod.jdwpPort || 5005;
      const httpPort = args.httpPort || pod.httpPort || 8081;

      // Create debug session for specific pod
      const session = await sessionManager.createSession(
        pod.name,
        pod.namespace,
        jdwpPort,
        httpPort
      );

      return {
        success: true,
        session: {
          id: session.id,
          requestId: session.requestId,
          podName: session.podName,
          status: session.status
        },
        connection: {
          environment: k8sClient.getCurrentContext(),
          namespace: k8sClient.getNamespace(),
          pod: pod.name,
          podIP: pod.ip,
          jdwpPort,
          httpPort
        },
        usage: {
          debugHeader: `X-Debug-Request-Id: ${session.requestId}`,
          curlExample: `curl -H "X-Debug-Request-Id: ${session.requestId}" http://localhost:${httpPort}/api/...`,
          breakpointClass: 'com.debugger.filter.RequestContext',
          breakpointLine: 135
        },
        note: `Connected to SPECIFIC pod: ${pod.name}. Only this pod will receive debug requests.`
      };
    }

    case 'k8s_get_pod_status': {
      const status = await k8sClient.getPodStatus(args.podName);
      return status || { error: 'Pod not found' };
    }

    case 'k8s_get_pod_logs': {
      const logs = await k8sClient.getPodLogs(args.podName, {
        tailLines: args.tailLines,
        container: args.container
      });
      return { logs };
    }

    case 'k8s_restart_pod': {
      await k8sClient.restartPod(args.podName);
      return { success: true, message: `Pod ${args.podName} restarted` };
    }

    // ============ Tunnel Management ============
    case 'k8s_create_tunnel': {
      const tunnel = await tunnelManager.createTunnel(
        args.podName,
        args.remotePort,
        args.localPort,
        args.type || 'jdwp'
      );
      return {
        success: true,
        tunnel: {
          id: tunnel.id,
          localPort: tunnel.localPort,
          remotePort: tunnel.remotePort,
          status: tunnel.status
        }
      };
    }

    case 'k8s_close_tunnel': {
      await tunnelManager.closeTunnel(args.tunnelId);
      return { success: true, message: 'Tunnel closed' };
    }

    case 'k8s_list_tunnels': {
      const tunnels = tunnelManager.listTunnels();
      return {
        tunnels: tunnels.map(t => ({
          id: t.id,
          podName: t.podName,
          localPort: t.localPort,
          remotePort: t.remotePort,
          type: t.type,
          status: t.status
        })),
        count: tunnels.length
      };
    }

    case 'k8s_tunnel_health': {
      const healthy = await tunnelManager.checkTunnelHealth(args.tunnelId);
      const tunnel = tunnelManager.getTunnel(args.tunnelId);
      return {
        tunnelId: args.tunnelId,
        healthy,
        status: tunnel?.status,
        lastHealthCheck: tunnel?.lastHealthCheck
      };
    }

    // ============ Debug Session Management ============
    case 'k8s_create_debug_session': {
      // Dynamic service discovery - no hardcoded config!
      const pod = await k8sClient.getFirstPodForService(args.service);
      if (!pod) {
        // List available services to help the user
        const services = await k8sClient.listDebugEnabledServices();
        const available = services.map(s => s.name).join(', ');
        throw new McpError(
          ErrorCode.InvalidParams, 
          `Service '${args.service}' not found or has no running pods. Available services: ${available || 'none'}`
        );
      }

      // Auto-detect ports from pod
      const jdwpPort = pod.jdwpPort || 5005;
      const httpPort = pod.httpPort || 8080;

      const session = await sessionManager.createSession(
        pod.name,
        pod.namespace,
        jdwpPort,
        httpPort
      );

      return {
        success: true,
        session: {
          id: session.id,
          requestId: session.requestId,
          podName: session.podName,
          status: session.status
        },
        connection: {
          service: args.service,
          pod: pod.name,
          jdwpPort,
          httpPort
        },
        instructions: [
          `Debug session created for ${args.service}`,
          `Request ID: ${session.requestId}`,
          `Use this request ID in your API calls to debug only that specific request`,
          `Other requests will continue normally without stopping`,
          '',
          `To trigger a debug request, add header:`,
          `  X-Debug-Request-Id: ${session.requestId}`,
          '',
          `Example curl:`,
          `  curl -H "X-Debug-Request-Id: ${session.requestId}" http://localhost:${httpPort}/api/...`
        ]
      };
    }

    case 'k8s_close_debug_session': {
      await sessionManager.closeSession(args.sessionId);
      return { success: true, message: 'Session closed' };
    }

    case 'k8s_list_debug_sessions': {
      const sessions = sessionManager.listSessions();
      return {
        sessions: sessions.map(s => ({
          id: s.id,
          requestId: s.requestId,
          podName: s.podName,
          status: s.status,
          breakpoints: s.breakpoints.length,
          createdAt: s.createdAt
        })),
        count: sessions.length
      };
    }

    case 'k8s_get_debug_curl': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) {
        throw new McpError(ErrorCode.InvalidParams, 'Session not found');
      }
      
      // Resolve the HTTP tunnel port for this session (if any)
      let httpPort = 8080;
      if (session.httpTunnelId) {
        const tunnel = tunnelManager.getTunnel(session.httpTunnelId);
        if (tunnel) {
          httpPort = tunnel.localPort;
        }
      }

      const curl = sessionManager.getCurlCommand(
        args.sessionId,
        `http://localhost:${httpPort}`,
        args.endpoint,
        args.method || 'GET'
      );

      return { curl, requestId: session.requestId };
    }

    // ============ JDWP Debugging ============
    case 'k8s_set_breakpoint': {
      const bp = await sessionManager.setBreakpoint(
        args.sessionId,
        args.className,
        args.lineNumber
      );
      return {
        success: true,
        breakpoint: bp,
        message: `Conditional breakpoint set at ${args.className}:${args.lineNumber}. Only requests with the debug request ID will stop here.`
      };
    }

    case 'k8s_remove_breakpoint': {
      await sessionManager.removeBreakpoint(args.sessionId, args.className, args.lineNumber);
      return { success: true, message: 'Breakpoint removed' };
    }

    case 'k8s_list_breakpoints': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) {
        throw new McpError(ErrorCode.InvalidParams, 'Session not found');
      }
      return { breakpoints: session.breakpoints };
    }

    case 'k8s_wait_for_breakpoint': {
      const result = await sessionManager.waitForBreakpoint(
        args.sessionId,
        args.timeout || 30000
      );
      return result;
    }

    case 'k8s_get_variables': {
      const variables = await sessionManager.getVariables(args.sessionId, args.threadName);
      return { variables };
    }

    case 'k8s_get_stack_frames': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) {
        throw new McpError(ErrorCode.InvalidParams, 'Session not found');
      }
      const frames = await jdwpClient.getStackFrames(args.threadName);
      return { frames };
    }

    case 'k8s_step_over': {
      await sessionManager.step(args.sessionId, args.threadName, 'over');
      return { success: true, message: 'Stepped over' };
    }

    case 'k8s_step_into': {
      await sessionManager.step(args.sessionId, args.threadName, 'into');
      return { success: true, message: 'Stepped into' };
    }

    case 'k8s_step_out': {
      await sessionManager.step(args.sessionId, args.threadName, 'out');
      return { success: true, message: 'Stepped out' };
    }

    case 'k8s_continue': {
      await sessionManager.continue(args.sessionId);
      return { success: true, message: 'Execution continued' };
    }

    case 'k8s_evaluate_expression': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) {
        throw new McpError(ErrorCode.InvalidParams, 'Session not found');
      }
      const result = await jdwpClient.evaluateExpression(args.threadName, args.expression);
      return { result };
    }

    case 'k8s_smart_debug': {
      const session = sessionManager.getSession(args.sessionId);
      if (!session) {
        throw new McpError(ErrorCode.InvalidParams, 'Session not found');
      }
      
      // Inject request ID into curl command
      let curl = args.curlCommand;
      if (!curl.includes('X-Debug-Request-Id')) {
        curl = curl.replace('curl ', `curl -H "X-Debug-Request-Id: ${session.requestId}" `);
      }

      const result = await jdwpClient.smartDebug(curl, args.expectedBehavior);
      return result;
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.error('[MCP] Starting K8s JDWP MCP Server...');

  // Initialize components
  tunnelManager = new TunnelManager({
    kubeconfig: KUBECONFIG,
    namespace: NAMESPACE
  });

  k8sClient = new K8sClient({
    kubeconfig: KUBECONFIG,
    namespace: NAMESPACE
  });

  jdwpClient = new JdwpClient(JDWP_CLIENT_PORT);

  sessionManager = new SessionManager(tunnelManager, jdwpClient);

  // Start JDWP client subprocess (optional - can also connect to existing)
  try {
    await startJdwpClient();
  } catch (error) {
    console.error('[MCP] Warning: Could not start JDWP client, will try to connect to existing instance');
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'jdwp-k8s-mcp',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await handleToolCall(request.params.name, request.params.arguments || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('[MCP] Shutting down...');
    await sessionManager.shutdown();
    await tunnelManager.shutdown();
    if (jdwpClientProcess) {
      jdwpClientProcess.kill();
    }
    process.exit(0);
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('[MCP] K8s JDWP MCP Server started');
}

main().catch(console.error);
