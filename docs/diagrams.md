# Diagrams

Every major subsystem visualised. All diagrams are [Mermaid](https://mermaid.js.org) and render natively on GitHub.

---

## 1. System overview

```mermaid
graph TB
    subgraph Developer["Developer Machine"]
        subgraph DesktopApp["JDWP Studio (Electron)"]
            UI["React Renderer"]
            MAINPROC["Electron Main"]
            UI -->|"IPC"| MAINPROC
        end
        subgraph BrowserTab["Web Browser"]
            WEBUI["Web UI :8083"]
        end
        subgraph AIAgent["AI IDE"]
            CURSOR["Cursor / Claude"]
        end
        subgraph SpringClient["Debug Client (Spring Boot :8083)"]
            direction TB
            RESTAPI["REST API + SSE"]
            PUMP["Event Pump"]
            WORKER["BP Worker<br/>(serialized JDI)"]
            WATCHDOG["Idle Watchdog"]
            AUDIT["Audit Service"]
            KUBEWEB["KubeWebService"]
            LOGRECV["Log Receiver :9999"]
        end
    end

    subgraph Kubernetes["Kubernetes Cluster"]
        subgraph PodA["Pod A"]
            JVM_A["JVM 21<br/>JDWP :5005"]
        end
        subgraph PodB["Pod B"]
            JVM_B["JVM 21<br/>JDWP :5005"]
        end
        PF["kubectl port-forward"]
    end

    STUDIO -->|"attach"| CLIENT
    WEBUI -->|"HTTP/SSE"| CLIENT
    CURSOR -->|"MCP"| MCPLOCAL["MCP Local<br/>37 tools"]
    MCPLOCAL -->|"HTTP"| CLIENT
    CURSOR -->|"MCP"| MCPK8S["MCP K8s<br/>32 tools"]
    MCPK8S -->|"fabric8"| PF

    CLIENT <-->|"JDWP via tunnel"| PF
    PF --> JVM_A
```

---

## 2. Breakpoint hit: complete event pipeline

```mermaid
sequenceDiagram
    participant T as Target Thread
    participant Q as EventQueue
    participant P as Event Pump
    participant W as BP Worker
    participant CR as Conditional-Resume Pass
    participant U as User / AI IDE

    T->>T: Executes line with BP
    T->>Q: BreakpointEvent queued
    Note over T: NOT yet suspended

    P->>Q: remove() — suspension NOW applied
    P->>W: dispatch to serialized worker

    alt Disabled breakpoint
        W->>T: resume()
    else Hit count < minHits
        W->>T: resume()
    else Condition evaluates FALSE
        W->>T: evaluateExpression(condition)
        W->>T: resume() — traffic flows
    else Logpoint
        W->>W: captureFrameLocals() + redact()
        W-->>U: SSE log entry (never pauses)
        W->>T: resume()
    else Request-scoped + matching ID
        Note over T: Thread stays SUSPENDED
        U->>C: GET frames / variables / evaluate
        C->>T: JDWP reads (thread paused)
    else Plain BP + untagged request
        CR->>T: resume within 25ms (non-blocking)
    end
```

---

## 3. Non-blocking decision tree

```mermaid
flowchart TD
    REQ["Incoming HTTP request"] --> HEADER{"X-Debug-Request-Id header?"}
    HEADER -->|"absent"| FLOW["Normal processing<br/>⚡ never paused"]
    HEADER -->|present| MATCH{"Matches active session ID?"}
    MATCH -->|no| FLOW
    MATCH -->|yes| CODE["Request executes normally..."]
    CODE --> BPHIT{"Crosses a breakpoint line?"}
    BPHIT -->|no| DONE[Request completes]
    BPHIT -->|yes| COND{Condition set?}
    COND -->|evaluates false| RESUME_NOW[Resume instantly]
    COND -->|true or none| MINHITS{Hit count >= N?}
    MINHITS -->|no| RESUME_NOW
    MINHITS -->|yes or none| SUSPEND["⏸ Thread suspends<br/>for inspection"]
    SUSPEND --> VARS[Variables readable]
    SUSPEND --> STEP[Step over/into/out]
    SUSPEND --> DROP[Drop frame rewind]
    USER[User clicks Resume] --> DONE
    RESUME_NOW --> DONE
```

---

## 4. TimeLens recording pipeline

```mermaid
sequenceDiagram
    participant U as User
    participant C as Debug Client
    participant T as Target Pod

    U->>C: POST /recorder/start {locations}
    loop For each Class:line probe
        C->>T: JDWP SetBreakpoint (record mode)
    end
    C-->>U: installed = 3 probes

    Note over T: Request arrives with X-Debug-Request-Id
    T->>C: BP hit at line 29
    C->>C: Capture locals (redacted)
    C->>T: Auto-resume (zero pause)
    T->>C: BP hit at line 31 (+7ms)
    C->>C: Capture locals (a=20 visible)
    C->>T: Auto-resume
    T->>C: BP hit at line 33 (+4ms)
    C->>C: Capture locals
    C->>T: Auto-resume

    U->>C: GET /recorder/session-key
    C->>U: Timeline: 3 steps, Δ=19ms total, full state per step
```

---

## 5. Panic stop: clean-exit guarantee

```mermaid
sequenceDiagram
    participant U as User
    participant C as Debug Client
    participant T as Target VM

    U->>C: POST /panic
    activate C
    C->>T: Resume ALL suspended threads
    C->>C: Remove ALL breakpoints
    C->>C: Remove ALL watchpoints
    C->>T: Detach (dispose VM)
    C->>C: Write audit entry
    deactivate C
    C-->>U: {threadsResumed, breakpointsRemoved, detached}

    Note over T: Zero residual instrumentation.<br/>Zero paused threads.<br/>Target serves traffic normally.
```

---

## 6. Security defence layers

```mermaid
graph TD
    REQ["Incoming request"] --> L1
    subgraph L1["Layer 1: Network"]
        GW["API Gateway: TLS termination<br/>distributed rate limiting"]
    end
    GW --> L2
    subgraph L2["Layer 2: Auth"]
        TOKEN["X-Debug-Token<br/>constant-time compare"]
        RL2["Per-IP lockout<br/>5 fails → 5min 429"]
    end
    TOKEN --> L3
    RL2 --> L3
    subgraph L3["Layer 3: Authorization"]
        ALLOWLIST["Target allow-list<br/>(CIDR/hostname)"]
        RBAC["K8s RBAC<br/>no exec · no write verbs"]
    end
    ALLOWLIST --> API["Debug operations"]
    RBAC --> PF["Port-forward only"]

    API --> AUDIT["Audit trail JSONL"]
    API --> REDACT["SecretRedactor masks output"]
    API --> WD["Idle watchdog auto-disconnect"]
```

---

## 7. Deployment topology: Docker Compose (local)

```mermaid
graph LR
    subgraph "Docker Host"
        subgraph "compose network"
            DEMO["jdwp-debug-server<br/>:8081 API · :5005 JDWP"]
        end
        CLIENT_JAR["debug-client JAR<br/>:8083 API · :9999 logs"]
        BROWSER["Browser / Studio<br/>localhost:8083"]
    end
    BROWSER -->|"HTTP"| CLIENT_JAR
    CLIENT_JAR -->|"JDWP attach"| DEMO
    DEMO -->|"NDJSON logs :9999"| CLIENT_JAR
    CLIENT_JAR -->|"HTTP proxy"| DEMO
```

---

## 8. Deployment topology: Kubernetes production

```mermaid
graph TB
    subgraph "Developer Laptop"
        STUDIO["JDWP Studio<br/>(Electron desktop app)"]
        WEBUI2["Web UI<br/>(browser tab)"]
        KUBECFG["~/.kube/config<br/>(prod context)"]
    end

    subgraph "Company Cluster"
        subgraph "Namespace: orders"
            POD1["orders-pod-abc123<br/>JVM + JDWP :5005<br/>(NOT exposed via Service)"]
        end
        subgraph "RBAC"
            SA["ServiceAccount:<br/>pods get/list/watch<br/>portforward create<br/>pods/log get<br/>NO exec · NO write"]
        end
    end

    STUDIO -->|"kubectl port-forward<br/>(via kubeconfig auth)"| POD1
    WEBUI2 -->|"/api/k8s/pods"| KUBECTL_SVC["Debug Client<br/>runs kubectl locally"]
    KUBECTL_SVC --> POD1
```

---

## 9. MCP integration: AI-driven debugging

```mermaid
sequenceDiagram
    participant AI as AI IDE (Cursor)
    participant MCP as MCP Server
    participant DC as Debug Client
    participant T as Target JVM

    AI->>MCP: jdwp_set_breakpoint("UserController", 29)
    MCP->>DC: POST /breakpoints?className=...&lineNumber=29
    DC->>T: JDWP SetBreakpoint
    DC-->>MCP: {"success": true, "breakpointId": "..."}
    MCP-->>AI: Breakpoint armed

    AI->>MCP: jdwp_wait_for_breakpoint(timeout=30000)
    Note over T: Tagged request arrives and hits BP

    DC-->>MCP: {"hit": true, "threadName": "http-nio-8081-exec-3"}
    MCP-->>AI: Breakpoint hit!

    AI->>MCP: jdwp_get_variables("http-nio-8081-exec-3")
    MCP->>DC: GET /threads/{t}/variables-enhanced
    DC->>T: JDWP Variable read
    DC-->>MCP: Variables JSON
    MCP-->>AI: Full variable state

    AI->>MCP: jdwp_evaluate("a > 100")
    MCP->>DC: POST evaluate
    DC-->>MCP: "false"
    MCP-->>AI: Expression result: false

    AI->>MCP: jdwp_continue()
    MCP->>DC: POST /continue
    DC->>T: JDWP VM.Resume
    MCP-->>AI: Resumed
```

---

## 10. Component interaction map

```mermaid
graph LR
    subgraph "Spring Boot Context"
        CTRL["DebugController"] --> SVC["JdwpService"]
        CTRL --> KUBE["KubeWebService"]
        CTRL --> SRC["SourceController"]
        KCTRL["KubeWebController"] --> KUBE
        SCTRL["SourceController"] -.-> ROOTS["In-memory root registry"]
    end

    subgraph "JdwpService internals"
        SVC --> VM["VirtualMachine (JDI)"]
        SVC --> PUMP_T["jdwp-event-pump thread"]
        SVC --> PASS_T["conditional-resume thread"]
        SVC --> WD_T["idle-watchdog task"]
        SVC --> BPW["bp-worker executor"]
        SVC --> REC["Recorder timelines"]
        SVC --> REDACT["SecretRedactor"]
        SVC --> AUDIT_SVC["AuditService"]
    end

    PUMP_T -->|events| BPW
    BPW -->|synchronized| SVC
    PASS_T -->|polls vm.allThreads| VM
    WD_T -->|checks idle| SVC
```
