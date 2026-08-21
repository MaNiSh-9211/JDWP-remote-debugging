/**
 * Type definitions for the K8s JDWP MCP server
 */

export interface K8sConfig {
  namespace: string;
  kubeconfig?: string;
  context?: string;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  ip?: string;
  containers: ContainerInfo[];
  labels: Record<string, string>;
  createdAt: string;
  debugEnabled: boolean;
  jdwpPort?: number;
  httpPort?: number;
}

export interface ServiceInfo {
  name: string;
  namespace: string;
  podCount: number;
  jdwpPort: number;
  httpPort: number;
  debugEnabled: boolean;
  labels: Record<string, string>;
}

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  isCurrent: boolean;
}

export interface ContainerInfo {
  name: string;
  image: string;
  ready: boolean;
  ports: PortInfo[];
}

export interface PortInfo {
  name: string;
  containerPort: number;
  protocol: string;
}

export interface TunnelInfo {
  id: string;
  podName: string;
  namespace: string;
  localPort: number;
  remotePort: number;
  status: 'active' | 'connecting' | 'disconnected' | 'error';
  type: 'http' | 'jdwp';
  createdAt: Date;
  lastHealthCheck?: Date;
  pid?: number;
  error?: string;
}

export interface DebugSession {
  id: string;
  requestId: string;
  podName: string;
  namespace: string;
  jdwpTunnelId: string;
  httpTunnelId?: string;
  status: 'initializing' | 'ready' | 'debugging' | 'suspended' | 'closed';
  breakpoints: BreakpointInfo[];
  createdAt: Date;
  lastActivity: Date;
}

export interface BreakpointInfo {
  id: string;
  className: string;
  lineNumber: number;
  condition?: string;
  hitCount: number;
  enabled: boolean;
}

export interface JdwpConnection {
  host: string;
  port: number;
  connected: boolean;
  vmName?: string;
  vmVersion?: string;
}

export interface VariableInfo {
  name: string;
  type: string;
  value: any;
  isNull: boolean;
}

export interface StackFrame {
  index: number;
  className: string;
  methodName: string;
  lineNumber: number;
  sourcePath?: string;
}

export interface ThreadInfo {
  id: number;
  name: string;
  status: string;
  isSuspended: boolean;
  requestId?: string;
}

export interface DebugResult {
  success: boolean;
  requestId: string;
  threadName?: string;
  location?: {
    className: string;
    methodName: string;
    lineNumber: number;
  };
  variables?: Record<string, VariableInfo>;
  stackFrames?: StackFrame[];
  error?: string;
}

export interface SmartDebugResult {
  bugType: 'EXCEPTION' | 'EMPTY_RESPONSE' | 'WRONG_DATA' | 'TIMEOUT' | 'UNKNOWN';
  strategy: string;
  phases: string[];
  location?: {
    className: string;
    lineNumber: number;
  };
  variables?: Record<string, any>;
  variableAnalysis?: {
    nullValues: string[];
    emptyCollections: string[];
  };
  stackFrames?: StackFrame[];
  logs?: string[];
  nextSteps: string[];
}
