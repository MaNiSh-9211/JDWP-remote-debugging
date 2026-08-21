#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { JdwpClient } from './jdwp-client.js';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';

const CLIENT_PORT = 8083; // Use different port to avoid conflicts
const CLIENT_API_BASE = `http://localhost:${CLIENT_PORT}/api/debug`;

class JdwpMcpServer {
  private server: Server;
  private jdwpClient: JdwpClient;
  private javaProcess: ChildProcess | null = null;
  private clientReady = false;

  constructor() {
    this.server = new Server(
      {
        name: 'jdwp-mcp-server',
        version: '1.0.0',
        description: 'Java Debugging MCP Server - Enables Cursor IDE to debug Java applications using JDWP. Provides breakpoint management, variable inspection, step execution, and more.',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.jdwpClient = new JdwpClient(CLIENT_API_BASE);

    this.setupHandlers();
    this.startJavaClient();
  }

  private async startJavaClient() {
    // First, check if client is already running
    try {
      const response = await axios.get(`${CLIENT_API_BASE}/status`, {
        timeout: 2000,
      });
      if (response.data.connected !== undefined) {
        this.clientReady = true;
        console.error('[MCP] Client already running, using existing instance');
        // Try to auto-connect to JDWP if not already connected
        if (!response.data.connected) {
          try {
            await axios.post(`${CLIENT_API_BASE}/connect`, null, {
              params: { host: 'localhost', port: 5005 },
              timeout: 5000,
            });
            console.error('[MCP] Auto-connected to JDWP on port 5005');
          } catch (error) {
            console.error('[MCP] Could not auto-connect to JDWP, but client is ready');
          }
        }
        return;
      }
    } catch (error: any) {
      // Client not running, start it
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        console.error('[MCP] Client not running, starting new instance...');
      } else {
        console.error(`[MCP] Error checking client status: ${error.message}`);
        // Still try to start
      }
    }
    
    // Find the client JAR file
    // Get the directory of the current file (ES module compatible)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    // Calculate paths: dist/index.js -> jdwp-mcp/dist -> jdwp-mcp -> parent -> client/target
    const jdwpMcpDir = path.resolve(__dirname, '..'); // dist -> jdwp-mcp
    const projectRoot = path.resolve(jdwpMcpDir, '..'); // jdwp-mcp -> repo root
    const clientJarPath = path.join(projectRoot, 'client', 'target', 'debug-client-1.0.0.jar');
    
    let finalJarPath = clientJarPath;
    
    // If not found, try alternative path resolution
    if (!fs.existsSync(finalJarPath)) {
      const alternativePath = path.resolve(__dirname, '../../client/target/debug-client-1.0.0.jar');
      if (fs.existsSync(alternativePath)) {
        finalJarPath = alternativePath;
      } else {
        // Last resort: try to find it anywhere in the project
        const searchPaths = [
          path.join(projectRoot, 'client', 'target', 'debug-client-1.0.0.jar'),
          path.join(jdwpMcpDir, '..', 'client', 'target', 'debug-client-1.0.0.jar'),
          path.resolve(process.cwd(), 'client', 'target', 'debug-client-1.0.0.jar'),
        ];
        for (const searchPath of searchPaths) {
          if (fs.existsSync(searchPath)) {
            finalJarPath = searchPath;
            break;
          }
        }
      }
    }

    // Check if JAR exists, if not, try to find it
    if (!fs.existsSync(finalJarPath)) {
      console.error(`[MCP] Client JAR not found at ${clientJarPath}`);
      console.error(`[MCP] Also tried: ${finalJarPath}`);
      console.error('[MCP] Please build the client first: cd client && mvn clean package');
      // Still try to use existing client if available on port 8083
      this.waitForClientReady();
      return;
    }

    console.error(`[MCP] Starting Java client from ${finalJarPath}`);

    // Start Java process with custom port
    const javaArgs = [
      '-jar',
      finalJarPath,
      '--server.port=' + CLIENT_PORT,
    ];

    this.javaProcess = spawn('java', javaArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(finalJarPath),
    });

    let startupDetected = false;
    
    this.javaProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      console.error(`[MCP Java] ${output.trim()}`);
      if (output.includes('Started JdwpDebugClientApplication') || output.includes('Tomcat started on port')) {
        if (!startupDetected) {
          startupDetected = true;
          console.error('[MCP] Java client startup detected, waiting for readiness...');
          this.waitForClientReady();
        }
      }
    });

    this.javaProcess.stderr?.on('data', (data) => {
      // Log Java errors but don't fail
      const output = data.toString();
      if (!output.includes('WARN') && !output.includes('INFO')) {
        console.error(`[MCP Java Error] ${data.toString().trim()}`);
      }
    });

    this.javaProcess.on('exit', (code) => {
      console.error(`[MCP] Java client process exited with code ${code}`);
      this.clientReady = false;
      this.javaProcess = null;
      // Try to restart if it exits unexpectedly
      if (code !== 0 && code !== null) {
        console.error('[MCP] Java client crashed, will retry on next tool call');
      }
    });

    // Also start waiting after a delay, in case startup message is missed
    setTimeout(() => {
      if (!this.clientReady && !startupDetected) {
        console.error('[MCP] Startup message not detected, checking client readiness anyway...');
        this.waitForClientReady();
      }
    }, 5000);
  }

  private async waitForClientReady() {
    // Wait for client to be ready with exponential backoff
    const maxAttempts = 60; // 60 seconds total
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get(`${CLIENT_API_BASE}/status`, {
          timeout: 2000,
        });
        if (response.data.connected !== undefined || response.status === 200) {
          this.clientReady = true;
          console.error(`[MCP] Client is ready (attempt ${i + 1}/${maxAttempts})`);
          // Try to auto-connect to JDWP if not already connected (optional, don't fail if it doesn't work)
          if (!response.data.connected) {
            try {
              await axios.post(`${CLIENT_API_BASE}/connect`, null, {
                params: { host: 'localhost', port: 5005 },
                timeout: 5000,
              });
              console.error('[MCP] Auto-connected to JDWP on port 5005');
            } catch (error) {
              // Auto-connect is optional, don't fail
              console.error('[MCP] Could not auto-connect to JDWP, but client is ready');
            }
          }
          return;
        }
      } catch (error: any) {
        // Not ready yet
        if (i % 5 === 0) { // Log every 5 seconds
          console.error(`[MCP] Waiting for client to be ready... (attempt ${i + 1}/${maxAttempts})`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    
    // Final check
    try {
      const finalCheck = await axios.get(`${CLIENT_API_BASE}/status`, {
        timeout: 3000,
      });
      if (finalCheck.data.connected !== undefined || finalCheck.status === 200) {
        this.clientReady = true;
        console.error('[MCP] Client is ready (found on final check)');
        return;
      }
    } catch (error) {
      console.error('[MCP] Client did not become ready after all attempts');
      console.error('[MCP] Please check:');
      console.error('[MCP]   1. Java is installed and in PATH');
      console.error('[MCP]   2. Client JAR exists at: client/target/debug-client-1.0.0.jar');
      console.error('[MCP]   3. Port 8083 is not in use by another application');
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'jdwp_connect',
            description: 'Connect to a JDWP server at the specified host and port. This is the first step to enable Java debugging. The target Java application must be running with JDWP enabled (VM option: -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005).',
            inputSchema: {
              type: 'object',
              properties: {
                host: {
                  type: 'string',
                  description: 'Hostname or IP address where the Java application is running (default: localhost)',
                  default: 'localhost',
                },
                port: {
                  type: 'number',
                  description: 'JDWP port number (default: 5005). Must match the port in the Java application VM options.',
                  default: 5005,
                },
              },
              required: [],
            },
          },
          {
            name: 'jdwp_disconnect',
            description: 'Disconnect from the JDWP server',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_status',
            description: 'Get JDWP connection status. Shows if connected to target JVM and number of threads. Use this to verify connection before debugging.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_set_breakpoint',
            description: `Set a breakpoint at a specific class and line number.

WHEN TO USE:
- After jdwp_smart_debug suggests specific classes
- When you know exactly where to debug
- To set MULTIPLE breakpoints for tracing data flow

STRATEGY FOR MULTIPLE BREAKPOINTS:
1. Set breakpoint at entry (controller method)
2. Trigger API → hits first breakpoint
3. Examine variables → if data looks correct, set next breakpoint
4. Continue → hits next breakpoint
5. Repeat until you find where data goes wrong

EXAMPLE:
- jdwp_set_breakpoint("com.example.UserController", 45) // Entry
- jdwp_set_breakpoint("com.example.UserService", 23)    // Service layer
- jdwp_set_breakpoint("com.example.UserRepository", 12) // DB layer`,
            inputSchema: {
              type: 'object',
              properties: {
                className: {
                  type: 'string',
                  description: 'Full qualified class name (e.g., com.example.MyClass). Must match the exact package and class name.',
                },
                lineNumber: {
                  type: 'number',
                  description: 'Line number where to set the breakpoint. Must be a valid executable line in the class (not a comment or blank line).',
                },
              },
              required: ['className', 'lineNumber'],
            },
          },
          {
            name: 'jdwp_remove_breakpoint',
            description: 'Remove a breakpoint by ID',
            inputSchema: {
              type: 'object',
              properties: {
                breakpointId: {
                  type: 'string',
                  description: 'Breakpoint ID (format: className:lineNumber)',
                },
              },
              required: ['breakpointId'],
            },
          },
          {
            name: 'jdwp_list_breakpoints',
            description: 'List all active breakpoints',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_get_threads',
            description: 'Get all threads (filtered to show only relevant application threads)',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_get_variables',
            description: `Get all scope variables from a suspended thread at the current execution point.

⚠️ PREREQUISITE: Thread must be SUSPENDED at a breakpoint first!
- Use jdwp_set_breakpoint or jdwp_set_exception_breakpoint before this
- Use jdwp_get_threads to find suspended threads

Returns variable names, types, and values including complex objects.
Use this to find null values, unexpected data, or wrong state.`,
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the suspended thread (e.g., "http-nio-8081-exec-7"). Get thread names using jdwp_get_threads.',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_get_location',
            description: 'Get current source location for a thread',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_step_over',
            description: 'Execute step over (execute current line, move to next)',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread to step',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_step_into',
            description: 'Execute step into (enter method call)',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread to step',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_step_out',
            description: 'Execute step out (exit current method)',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread to step',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_continue',
            description: 'Continue execution until next breakpoint',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_resume_thread',
            description: 'Resume a specific thread',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread to resume',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_suspend_thread',
            description: 'Suspend a specific thread',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread to suspend',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_evaluate_expression',
            description: 'Evaluate a Java expression in the context of a suspended thread. Can access variables, call methods, and compute values. Examples: "userId", "response.getResponse()", "response.getResponse().size()", "response.getResponse().get(0)". The thread must be suspended.',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the suspended thread. Get thread names using jdwp_get_threads.',
                },
                expression: {
                  type: 'string',
                  description: 'Java expression to evaluate. Can be: variable name (e.g., "userId"), field access (e.g., "response.response"), method call (e.g., "response.getResponse()"), or chained calls (e.g., "response.getResponse().size()").',
                },
              },
              required: ['threadName', 'expression'],
            },
          },
          {
            name: 'jdwp_get_stack_frames',
            description: 'Get all stack frames for a thread',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the thread',
                },
              },
              required: ['threadName'],
            },
          },
          {
            name: 'jdwp_get_all_classes',
            description: 'Get all loaded classes in the JVM',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_trigger_class_loading',
            description: 'Trigger class loading by making an HTTP API call to the target application. This ensures classes are loaded in the JVM before setting breakpoints. Use this before jdwp_set_breakpoint if you get "Class not found" errors. The API call helps load classes that are loaded lazily.',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'API URL to call (optional). If not provided, uses a default test endpoint. Should be an endpoint that uses the class you want to debug.',
                },
                headers: {
                  type: 'object',
                  description: 'HTTP headers to include in the request (optional). Default headers from the original curl command are used if not provided.',
                },
              },
            },
          },
          {
            name: 'jdwp_get_logs',
            description: `📋 Get live console logs from the target JVM.

Returns logs as simple strings: "[stream][type] message"
Automatically filters out JDWP agent internal logs.

USE THIS TO:
- See error messages and stack traces
- Understand what happened before an exception
- Find clues about what went wrong

TIP: Call this after triggering an API to see any errors that were logged.
Combine with breakpoints for full debugging picture.`,
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: 'Maximum number of recent logs to retrieve (default: 100)',
                },
                since: {
                  type: 'number',
                  description: 'Get logs since this timestamp (epoch milliseconds)',
                },
                thread: {
                  type: 'string',
                  description: 'Filter logs by thread name',
                },
                stream: {
                  type: 'string',
                  enum: ['stdout', 'stderr'],
                  description: 'Filter logs by stream (stdout or stderr)',
                },
                filter: {
                  type: 'boolean',
                  description: 'Filter out JDWP agent logs (default: true)',
                },
              },
            },
          },
          {
            name: 'jdwp_clear_logs',
            description: 'Clear all captured console logs from memory',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_get_log_status',
            description: 'Get the status of the log receiver service. Check if live log capture is running.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'jdwp_get_agent_logs',
            description: 'Get JDWP agent logs separately (ConsoleLogAgent initialization, connection status, etc.). These are filtered out from regular logs.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: 'Maximum number of agent logs to retrieve (default: 100)',
                },
              },
            },
          },
          {
            name: 'jdwp_set_exception_breakpoint',
            description: `🎯 CRITICAL TOOL for debugging API errors!

Sets a breakpoint that triggers when ANY exception is thrown.
When exception occurs, execution suspends at the EXACT line that caused it.

WORKFLOW:
1. Call this FIRST (before triggering the failing API)
2. Trigger the API
3. Use jdwp_wait_for_breakpoint to detect the exception
4. Use jdwp_get_location and jdwp_get_variables to see what happened

This is the BEST way to find the root cause of errors instead of guessing!`,
            inputSchema: {
              type: 'object',
              properties: {
                enabled: {
                  type: 'boolean',
                  description: 'Enable or disable exception breakpoint (default: true)',
                },
                exceptionClass: {
                  type: 'string',
                  description: 'Specific exception class name (e.g., "java.lang.NullPointerException"). If not provided, suspends on all exceptions.',
                },
              },
            },
          },
          {
            name: 'jdwp_wait_for_breakpoint',
            description: `Wait for a breakpoint or exception to be hit.

WORKFLOW:
1. Set breakpoint (jdwp_set_breakpoint) or exception breakpoint (jdwp_set_exception_breakpoint)
2. Trigger the API
3. Call THIS tool to wait for the breakpoint to hit
4. When hit=true, use jdwp_get_location and jdwp_get_variables to inspect

Returns: { hit: true/false, threadName: "..." }
If hit=true, the thread is suspended and ready for inspection.`,
            inputSchema: {
              type: 'object',
              properties: {
                timeout: {
                  type: 'number',
                  description: 'Maximum time to wait in milliseconds (default: 5000)',
                },
                pollInterval: {
                  type: 'number',
                  description: 'Polling interval in milliseconds (default: 100)',
                },
              },
            },
          },
          {
            name: 'jdwp_get_variables_enhanced',
            description: 'Get all variables from a suspended thread, including local variables, method parameters, and instance variables (this.fieldName). More comprehensive than jdwp_get_variables.',
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the suspended thread',
                },
                includeInstance: {
                  type: 'boolean',
                  description: 'Include instance variables from this object (default: true)',
                },
              },
              required: ['threadName'],
            },
          },
          // ============ WORKFLOW TOOLS ============
          // These tools guide proper debugging methodology
          {
            name: 'jdwp_debug_api_workflow',
            description: `🔴 USE THIS FIRST when debugging any API issue!

This is a WORKFLOW tool that sets up proper debugging. It:
1. Connects to JDWP (if not connected)
2. Sets an exception breakpoint to catch ALL exceptions
3. Clears old logs to start fresh
4. Returns instructions for next steps

AFTER calling this tool:
1. You (AI) should tell the USER to trigger the failing API
2. Then call jdwp_capture_debug_info to get exception details
3. Use the REAL runtime data to identify the bug - DO NOT GUESS

⚠️ IMPORTANT: Never make code changes based on assumptions. Always use this workflow to get actual runtime evidence.`,
            inputSchema: {
              type: 'object',
              properties: {
                host: {
                  type: 'string',
                  description: 'JDWP host (default: localhost)',
                  default: 'localhost',
                },
                port: {
                  type: 'number',
                  description: 'JDWP port (default: 5005)',
                  default: 5005,
                },
                exceptionClass: {
                  type: 'string',
                  description: 'Exception class to catch (default: java.lang.Exception catches all)',
                  default: 'java.lang.Exception',
                },
              },
            },
          },
          {
            name: 'jdwp_capture_debug_info',
            description: `🔍 USE THIS after the API is triggered to capture exception/breakpoint details.

This tool captures comprehensive debugging information:
- Whether an exception was caught
- The EXACT location (class, method, line number) where it occurred
- ALL variables in scope at that point
- Recent application logs
- Stack trace

The response includes analysis hints and next steps.

WORKFLOW:
1. First call jdwp_debug_api_workflow
2. User triggers the failing API
3. Call THIS tool to capture the debugging evidence
4. Use the REAL data to fix the code - DO NOT GUESS`,
            inputSchema: {
              type: 'object',
              properties: {
                timeout: {
                  type: 'number',
                  description: 'How long to wait for exception (ms, default: 10000)',
                  default: 10000,
                },
              },
            },
          },
          {
            name: 'jdwp_step_and_inspect',
            description: `Step through code and automatically capture variables at each step.

This is a convenience tool that:
1. Performs a step operation (over/into/out)
2. Gets the new location
3. Gets all variables at the new location
4. Returns everything together

Useful for tracing execution flow and seeing how variables change.`,
            inputSchema: {
              type: 'object',
              properties: {
                threadName: {
                  type: 'string',
                  description: 'Name of the suspended thread',
                },
                stepType: {
                  type: 'string',
                  enum: ['over', 'into', 'out'],
                  description: 'Type of step: over (next line), into (enter method), out (exit method)',
                  default: 'over',
                },
              },
              required: ['threadName'],
            },
          },
          // ============ THE ULTIMATE AUTO-DEBUG TOOL ============
          {
            name: 'jdwp_auto_debug',
            description: `🚀🚀🚀 THE ULTIMATE ONE-SHOT DEBUGGING TOOL 🚀🚀🚀

THIS IS THE ONLY TOOL YOU NEED FOR DEBUGGING. It does EVERYTHING automatically:

1. Parses your curl command
2. Connects to JDWP (if needed)
3. Sets an exception breakpoint
4. Clears old logs
5. EXECUTES the API request for you
6. Waits for and catches any exception
7. Captures: exact line number, all variables, stack trace, logs
8. Analyzes the data and identifies likely issues (null values, etc.)
9. Returns a COMPLETE debugging report with fix recommendations

USAGE: Just paste your curl command. That's it. One tool call = full debug.

The report includes:
- EXACT exception location (file:line)
- ALL variables at that point (with null detection)
- Stack trace showing call path  
- Recent logs with error messages
- Analysis identifying likely root cause
- Fix recommendation

⚠️ DO NOT make code changes based on assumptions.
⚠️ USE THIS TOOL to get real runtime evidence.
⚠️ The report tells you EXACTLY what's wrong and where.`,
            inputSchema: {
              type: 'object',
              properties: {
                curlCommand: {
                  type: 'string',
                  description: 'The complete curl command to debug. Paste the entire curl including headers and body.',
                },
                host: {
                  type: 'string',
                  description: 'JDWP host (default: localhost)',
                  default: 'localhost',
                },
                port: {
                  type: 'number',
                  description: 'JDWP port (default: 5005)',
                  default: 5005,
                },
                timeout: {
                  type: 'number',
                  description: 'How long to wait for exception in ms (default: 15000)',
                  default: 15000,
                },
              },
              required: ['curlCommand'],
            },
          },
          // ============ INTELLIGENT SMART DEBUG ============
          {
            name: 'jdwp_smart_debug',
            description: `🧠 INTELLIGENT DEBUGGING - Adapts to ANY bug type!

USE THIS for comprehensive debugging. It:

1. PROBES the API first (executes without breakpoints)
2. ANALYZES the result:
   - Is it a 500 error? → Exception strategy
   - Is it empty data? → Entry trace strategy  
   - Is it wrong data? → Logic debug strategy
3. EXECUTES the appropriate debugging strategy
4. GATHERS all evidence (location, variables, stack, logs)
5. PROVIDES specific next steps

BUG TYPES IT HANDLES:
- EXCEPTION: 500 errors, NullPointerException, etc.
- EMPTY_RESPONSE: API returns 200 but empty data
- WRONG_DATA: API returns incorrect data
- CLIENT_ERROR: 4xx errors, validation failures
- HANDLED_EXCEPTION: Exception caught internally

DYNAMIC FEATURES:
- Finds controller classes from URL patterns
- Suggests which classes to set breakpoints in
- Detects null values in variables automatically
- Provides step-by-step debugging guidance

WHEN TO USE EACH TOOL:
- jdwp_smart_debug: START HERE - it analyzes and guides you
- jdwp_set_breakpoint: When smart_debug tells you where to set breakpoints
- jdwp_step_over/into/out: When at a breakpoint and need to trace
- jdwp_get_variables: To inspect variables at current position

The response includes nextSteps array with SPECIFIC actions to take!`,
            inputSchema: {
              type: 'object',
              properties: {
                curlCommand: {
                  type: 'string',
                  description: 'The curl command to debug',
                },
                className: {
                  type: 'string',
                  description: 'Optional: specific class to focus on (e.g., "UserService")',
                },
                methodName: {
                  type: 'string', 
                  description: 'Optional: specific method to debug',
                },
                expectedBehavior: {
                  type: 'string',
                  description: 'Optional: what SHOULD happen (helps detect logic bugs)',
                },
                host: { type: 'string', default: 'localhost' },
                port: { type: 'number', default: 5005 },
              },
              required: ['curlCommand'],
            },
          },
          // ============ TARGET APP MANAGEMENT TOOLS ============
          {
            name: 'jdwp_stop_target_app',
            description: `🛑 STOP the target application (your Spring Boot app).

Finds and kills the Java process running on the specified port.
Use this before rebuilding or when you need to restart the app.

After stopping, you can:
- Restart from IntelliJ (click Run)
- Use jdwp_start_target_app to start via command line
- Use jdwp_restart_target_app for full rebuild + restart`,
            inputSchema: {
              type: 'object',
              properties: {
                port: {
                  type: 'number',
                  description: 'Application port (default: 8081)',
                  default: 8081,
                },
                jdwpPort: {
                  type: 'number',
                  description: 'JDWP port (default: 5005)',
                  default: 5005,
                },
              },
            },
          },
          {
            name: 'jdwp_start_target_app',
            description: `🚀 START the target application with JDWP enabled.

Starts your Spring Boot application via command line with JDWP debugging enabled.
The app will be accessible on the specified port with JDWP debugger attached.

This is an alternative to running from IntelliJ - useful for automated restart.`,
            inputSchema: {
              type: 'object',
              properties: {
                jarPath: {
                  type: 'string',
                  description: 'Path to the JAR file. If not specified, searches in target/ directory.',
                },
                appPort: {
                  type: 'number',
                  description: 'Application port (default: 8081)',
                  default: 8081,
                },
                jdwpPort: {
                  type: 'number',
                  description: 'JDWP debug port (default: 5005)',
                  default: 5005,
                },
                springProfiles: {
                  type: 'string',
                  description: 'Spring profiles to activate (e.g., "uat", "dev")',
                },
                jvmOptions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional JVM options',
                },
                waitForReady: {
                  type: 'boolean',
                  description: 'Wait for app to be ready (default: true)',
                  default: true,
                },
              },
            },
          },
          {
            name: 'jdwp_rebuild_target_app',
            description: `🔨 REBUILD the target application (mvn clean package).

Runs Maven to rebuild your application JAR.
Use this after making code changes to your application.`,
            inputSchema: {
              type: 'object',
              properties: {
                projectDir: {
                  type: 'string',
                  description: 'Project directory containing pom.xml',
                },
                skipTests: {
                  type: 'boolean',
                  description: 'Skip running tests (default: true for faster builds)',
                  default: true,
                },
              },
            },
          },
          {
            name: 'jdwp_restart_target_app',
            description: `🔄 FULL RESTART: Stop, rebuild, and start the target application.

Complete workflow:
1. Stops the running application
2. Rebuilds with Maven (optional, can skip)
3. Starts the application with JDWP enabled

This is the ONE tool to use after making code changes!

Example: After fixing a bug, call this to see if the fix works.`,
            inputSchema: {
              type: 'object',
              properties: {
                appPort: {
                  type: 'number',
                  description: 'Application port (default: 8081)',
                  default: 8081,
                },
                jdwpPort: {
                  type: 'number',
                  description: 'JDWP port (default: 5005)',
                  default: 5005,
                },
                springProfiles: {
                  type: 'string',
                  description: 'Spring profiles (e.g., "uat")',
                },
                skipTests: {
                  type: 'boolean',
                  description: 'Skip tests during build (default: true)',
                  default: true,
                },
                skipBuild: {
                  type: 'boolean',
                  description: 'Skip rebuild, just restart (default: false)',
                  default: false,
                },
                projectDir: {
                  type: 'string',
                  description: 'Project directory containing pom.xml',
                },
                jvmOptions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional JVM options',
                },
              },
            },
          },
          // ============ JDWP CLIENT SERVICE MANAGEMENT ============
          {
            name: 'jdwp_rebuild_client',
            description: `🔧 REBUILD the JDWP client service (maven clean install).

Use this after making code changes to the Java client.
Runs: mvn clean install in the client directory.

Options:
- skipTests: Skip running tests for faster build (default: false)

Returns:
- Build output and status
- JAR file path if successful
- Error details if failed

Example: After fixing a bug in the Java client, call this to rebuild.`,
            inputSchema: {
              type: 'object',
              properties: {
                skipTests: {
                  type: 'boolean',
                  description: 'Skip running tests for faster build',
                  default: false,
                },
              },
            },
          },
          {
            name: 'jdwp_restart_client',
            description: `🔄 RESTART the JDWP client service.

Use this after rebuilding to apply changes.
Automatically:
1. Finds the JAR file
2. Kills any existing process on the port
3. Starts the new service
4. Waits for it to be ready

Options:
- port: Service port (default: 8083)
- jvmOptions: Additional JVM options (array of strings)
- waitForReady: Wait for service to be ready (default: true)

Returns:
- Service status
- PID of new process
- Ready confirmation

Example workflow:
1. jdwp_rebuild_client(skipTests=true)  // Rebuild
2. jdwp_restart_client()                 // Restart
3. jdwp_smart_debug(...)                 // Debug with new code`,
            inputSchema: {
              type: 'object',
              properties: {
                port: {
                  type: 'number',
                  description: 'Service port (default: 8083)',
                  default: 8083,
                },
                jvmOptions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Additional JVM options (e.g., ["-Xmx512m", "-Ddebug=true"])',
                },
                waitForReady: {
                  type: 'boolean',
                  description: 'Wait for service to be ready before returning',
                  default: true,
                },
              },
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      // These tools work without the client being ready
      const noClientRequiredTools = [
        'jdwp_rebuild_client', 
        'jdwp_restart_client',
        'jdwp_stop_target_app',
        'jdwp_start_target_app',
        'jdwp_rebuild_target_app',
        'jdwp_restart_target_app',
      ];
      
      // If client is not ready and this tool requires it, try to ensure it's started
      if (!this.clientReady && !noClientRequiredTools.includes(name)) {
        // Check if Java process is running but not ready yet
        if (this.javaProcess && !this.javaProcess.killed) {
          // Process is running, wait a bit more
          console.error('[MCP] Client process running but not ready yet, waiting...');
          await this.waitForClientReady();
        } else {
          // No process running, try to start it
          console.error('[MCP] Client not ready, attempting to start...');
          await this.startJavaClient();
          // Wait for it to become ready
          await this.waitForClientReady();
        }
        
        // If still not ready after all attempts, return error
        if (!this.clientReady) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'JDWP client is not ready. The Java client service failed to start. Please check the logs and ensure Java is installed and the client JAR exists at client/target/debug-client-1.0.0.jar',
                  hint: 'You can rebuild and restart the client: jdwp_rebuild_client() then jdwp_restart_client()',
                }),
              },
            ],
            isError: true,
          };
        }
      }

      try {

        switch (name) {
          case 'jdwp_connect':
            return await this.jdwpClient.connect(
              (args as any).host || 'localhost',
              (args as any).port || 5005
            );

          case 'jdwp_disconnect':
            return await this.jdwpClient.disconnect();

          case 'jdwp_status':
            return await this.jdwpClient.getStatus();

          case 'jdwp_set_breakpoint':
            return await this.jdwpClient.setBreakpoint(
              (args as any).className,
              (args as any).lineNumber
            );

          case 'jdwp_remove_breakpoint':
            return await this.jdwpClient.removeBreakpoint((args as any).breakpointId);

          case 'jdwp_list_breakpoints':
            return await this.jdwpClient.listBreakpoints();

          case 'jdwp_get_threads':
            return await this.jdwpClient.getThreads();

          case 'jdwp_get_variables':
            return await this.jdwpClient.getVariables((args as any).threadName);

          case 'jdwp_get_location':
            return await this.jdwpClient.getLocation((args as any).threadName);

          case 'jdwp_step_over':
            return await this.jdwpClient.stepOver((args as any).threadName);

          case 'jdwp_step_into':
            return await this.jdwpClient.stepInto((args as any).threadName);

          case 'jdwp_step_out':
            return await this.jdwpClient.stepOut((args as any).threadName);

          case 'jdwp_continue':
            return await this.jdwpClient.continueExecution();

          case 'jdwp_resume_thread':
            return await this.jdwpClient.resumeThread((args as any).threadName);

          case 'jdwp_suspend_thread':
            return await this.jdwpClient.suspendThread((args as any).threadName);

          case 'jdwp_evaluate_expression':
            return await this.jdwpClient.evaluateExpression(
              (args as any).threadName,
              (args as any).expression
            );

          case 'jdwp_get_stack_frames':
            return await this.jdwpClient.getStackFrames((args as any).threadName);

          case 'jdwp_get_all_classes':
            return await this.jdwpClient.getAllClasses();

          case 'jdwp_trigger_class_loading':
            return await this.jdwpClient.triggerClassLoading(
              (args as any).url,
              (args as any).headers
            );

          case 'jdwp_get_logs':
            return await this.jdwpClient.getLogs(
              (args as any).limit,
              (args as any).since,
              (args as any).thread,
              (args as any).stream,
              (args as any).filter
            );

          case 'jdwp_clear_logs':
            return await this.jdwpClient.clearLogs();

          case 'jdwp_get_log_status':
            return await this.jdwpClient.getLogStatus();

          case 'jdwp_get_agent_logs':
            return await this.jdwpClient.getAgentLogs((args as any).limit);

          case 'jdwp_set_exception_breakpoint':
            return await this.jdwpClient.setExceptionBreakpoint(
              (args as any).enabled !== false,
              (args as any).exceptionClass
            );

          case 'jdwp_wait_for_breakpoint':
            return await this.jdwpClient.waitForBreakpoint(
              (args as any).timeout || 5000,
              (args as any).pollInterval || 100
            );

          case 'jdwp_get_variables_enhanced':
            return await this.jdwpClient.getVariablesEnhanced(
              (args as any).threadName,
              (args as any).includeInstance !== false
            );

          // ============ WORKFLOW TOOL HANDLERS ============
          case 'jdwp_debug_api_workflow': {
            const host = (args as any).host || 'localhost';
            const port = (args as any).port || 5005;
            const exceptionClass = (args as any).exceptionClass || 'java.lang.Exception';
            
            const results: any = {
              workflow: 'debug_api',
              steps: [],
            };
            
            try {
              // Step 1: Check/establish connection
              const statusResult = await this.jdwpClient.getStatus();
              const statusData = JSON.parse(statusResult.content[0].text);
              
              if (!statusData.connected) {
                const connectResult = await this.jdwpClient.connect(host, port);
                results.steps.push({ step: 'connect', result: 'connected', host, port });
              } else {
                results.steps.push({ step: 'connect', result: 'already_connected' });
              }
              
              // Step 2: Set exception breakpoint
              const exResult = await this.jdwpClient.setExceptionBreakpoint(true, exceptionClass);
              results.steps.push({ step: 'exception_breakpoint', result: 'set', exceptionClass });
              
              // Step 3: Clear old logs
              await this.jdwpClient.clearLogs();
              results.steps.push({ step: 'clear_logs', result: 'cleared' });
              
              results.success = true;
              results.status = 'READY_FOR_API_TRIGGER';
              results.nextSteps = [
                '1. NOW trigger the failing API (tell the user to make the request)',
                '2. After API fails, call jdwp_capture_debug_info to capture exception details',
                '3. Use the REAL runtime data to identify the bug - DO NOT GUESS',
                '4. Only after seeing the actual error location and variables, make code changes',
              ];
              results.importantReminder = '⚠️ DO NOT make assumptions about the bug. WAIT for real debugging data!';
              
            } catch (error: any) {
              results.success = false;
              results.error = error.message;
            }
            
            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
            };
          }

          case 'jdwp_capture_debug_info': {
            const timeout = (args as any).timeout || 10000;
            const results: any = {
              workflow: 'capture_debug_info',
            };
            
            try {
              // Wait for breakpoint/exception
              const waitResult = await this.jdwpClient.waitForBreakpoint(timeout, 200);
              const waitData = JSON.parse(waitResult.content[0].text);
              
              if (waitData.hit && waitData.threadName) {
                results.exceptionCaught = true;
                results.threadName = waitData.threadName;
                
                // Get location
                const locResult = await this.jdwpClient.getLocation(waitData.threadName);
                results.location = JSON.parse(locResult.content[0].text);
                
                // Get variables
                const varsResult = await this.jdwpClient.getVariablesEnhanced(waitData.threadName, true);
                results.variables = JSON.parse(varsResult.content[0].text);
                
                // Get stack frames
                const stackResult = await this.jdwpClient.getStackFrames(waitData.threadName);
                results.stackFrames = JSON.parse(stackResult.content[0].text);
                
                // Get recent logs
                const logsResult = await this.jdwpClient.getLogs(30, undefined, undefined, undefined, true);
                results.recentLogs = JSON.parse(logsResult.content[0].text);
                
                results.success = true;
                results.analysis = {
                  summary: `Exception caught at ${results.location?.className || 'unknown'}:${results.location?.lineNumber || '?'}`,
                  whatToDo: [
                    '1. LOOK at the "location" - this is the EXACT line where the exception occurred',
                    '2. CHECK the "variables" - look for null values or unexpected data',
                    '3. REVIEW the "stackFrames" - understand the call path',
                    '4. READ the "recentLogs" - look for error messages',
                    '5. NOW you have real evidence - fix the ACTUAL bug, not a guess!',
                  ],
                };
                results.nextSteps = [
                  'If you need more info: use jdwp_step_and_inspect to trace execution',
                  'To continue execution: use jdwp_continue',
                  'To evaluate expressions: use jdwp_evaluate_expression',
                ];
              } else {
                results.exceptionCaught = false;
                results.success = true;
                results.message = 'No exception caught within timeout. Possible reasons:';
                results.possibleReasons = [
                  '1. The API request has not been triggered yet',
                  '2. The API succeeded without throwing an exception',
                  '3. The exception was handled (try-catch) before reaching the breakpoint',
                  '4. The timeout was too short - try increasing it',
                ];
                results.suggestion = 'Ask the user if they have triggered the API request.';
              }
            } catch (error: any) {
              results.success = false;
              results.error = error.message;
            }
            
            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
            };
          }

          case 'jdwp_step_and_inspect': {
            const threadName = (args as any).threadName;
            const stepType = (args as any).stepType || 'over';
            const results: any = {
              workflow: 'step_and_inspect',
              threadName,
              stepType,
            };
            
            try {
              // Perform step
              let stepResult;
              switch (stepType) {
                case 'into':
                  stepResult = await this.jdwpClient.stepInto(threadName);
                  break;
                case 'out':
                  stepResult = await this.jdwpClient.stepOut(threadName);
                  break;
                default:
                  stepResult = await this.jdwpClient.stepOver(threadName);
              }
              results.stepResult = JSON.parse(stepResult.content[0].text);
              
              // Small delay for step to complete
              await new Promise(resolve => setTimeout(resolve, 100));
              
              // Get new location
              const locResult = await this.jdwpClient.getLocation(threadName);
              results.newLocation = JSON.parse(locResult.content[0].text);
              
              // Get variables at new location
              const varsResult = await this.jdwpClient.getVariables(threadName);
              results.variables = JSON.parse(varsResult.content[0].text);
              
              results.success = true;
              results.summary = `Stepped ${stepType} to ${results.newLocation?.className || 'unknown'}:${results.newLocation?.lineNumber || '?'}`;
              
            } catch (error: any) {
              results.success = false;
              results.error = error.message;
              if (error.message.includes('not suspended')) {
                results.hint = 'Thread must be suspended. Set a breakpoint first or use jdwp_suspend_thread.';
              }
            }
            
            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
            };
          }

          // ============ THE ULTIMATE AUTO-DEBUG TOOL ============
          case 'jdwp_auto_debug': {
            return await this.jdwpClient.autoDebug(
              (args as any).curlCommand,
              {
                host: (args as any).host || 'localhost',
                port: (args as any).port || 5005,
                timeout: (args as any).timeout || 15000,
              }
            );
          }

          // ============ INTELLIGENT SMART DEBUG ============
          case 'jdwp_smart_debug': {
            return await this.jdwpClient.smartDebug({
              curlCommand: (args as any).curlCommand,
              className: (args as any).className,
              methodName: (args as any).methodName,
              expectedBehavior: (args as any).expectedBehavior,
              host: (args as any).host || 'localhost',
              port: (args as any).port || 5005,
            });
          }

          // ============ TARGET APP MANAGEMENT TOOLS ============
          case 'jdwp_stop_target_app': {
            return await this.jdwpClient.stopTargetApp({
              port: (args as any).port || 8081,
              jdwpPort: (args as any).jdwpPort || 5005,
            });
          }

          case 'jdwp_start_target_app': {
            return await this.jdwpClient.startTargetApp({
              jarPath: (args as any).jarPath,
              appPort: (args as any).appPort || 8081,
              jdwpPort: (args as any).jdwpPort || 5005,
              springProfiles: (args as any).springProfiles,
              jvmOptions: (args as any).jvmOptions || [],
              waitForReady: (args as any).waitForReady !== false,
            });
          }

          case 'jdwp_rebuild_target_app': {
            return await this.jdwpClient.rebuildTargetApp({
              projectDir: (args as any).projectDir,
              skipTests: (args as any).skipTests !== false,
            });
          }

          case 'jdwp_restart_target_app': {
            return await this.jdwpClient.restartTargetApp({
              projectDir: (args as any).projectDir,
              jarPath: (args as any).jarPath,
              appPort: (args as any).appPort || 8081,
              jdwpPort: (args as any).jdwpPort || 5005,
              springProfiles: (args as any).springProfiles,
              skipTests: (args as any).skipTests !== false,
              skipBuild: (args as any).skipBuild || false,
              jvmOptions: (args as any).jvmOptions || [],
            });
          }

          // ============ JDWP CLIENT SERVICE MANAGEMENT ============
          case 'jdwp_rebuild_client': {
            return await this.jdwpClient.rebuildClient({
              skipTests: (args as any).skipTests || false,
            });
          }

          case 'jdwp_restart_client': {
            // Kill our own managed process first if exists
            if (this.javaProcess && !this.javaProcess.killed) {
              this.javaProcess.kill();
              this.javaProcess = null;
              this.clientReady = false;
            }
            
            const result = await this.jdwpClient.restartClient({
              port: (args as any).port || 8083,
              jvmOptions: (args as any).jvmOptions || [],
              waitForReady: (args as any).waitForReady !== false,
            });
            
            // Update our client ready state
            const resultData = JSON.parse(result.content[0].text);
            if (resultData.success) {
              this.clientReady = true;
            }
            
            return result;
          }

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                },
              ],
              isError: true,
            };
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error.message || 'Unknown error',
                details: error.toString(),
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[MCP] JDWP MCP Server running on stdio');
  }

  async shutdown() {
    if (this.javaProcess) {
      this.javaProcess.kill();
    }
    await this.server.close();
  }
}

// Start the server
const server = new JdwpMcpServer();
server.run().catch(console.error);

// Handle shutdown
process.on('SIGINT', async () => {
  await server.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.shutdown();
  process.exit(0);
});

