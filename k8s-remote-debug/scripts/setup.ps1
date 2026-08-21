# Setup Script for K8s Remote JDWP Debugging
# This script sets up the entire debugging infrastructure

param(
    [switch]$SkipPrerequisites,
    [switch]$SkipBuild,
    [string]$ValuationPath = "",
    [string]$VcpPath = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "K8s Remote JDWP Debugging Setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
function Check-Prerequisites {
    Write-Host "[1/7] Checking prerequisites..." -ForegroundColor Yellow
    
    $missing = @()
    
    # Check Docker
    try {
        docker --version | Out-Null
        Write-Host "  - Docker: OK" -ForegroundColor Green
    } catch {
        $missing += "Docker"
        Write-Host "  - Docker: MISSING" -ForegroundColor Red
    }
    
    # Check Kind
    try {
        kind --version | Out-Null
        Write-Host "  - Kind: OK" -ForegroundColor Green
    } catch {
        $missing += "Kind (install with: choco install kind)"
        Write-Host "  - Kind: MISSING" -ForegroundColor Red
    }
    
    # Check kubectl
    try {
        kubectl version --client | Out-Null
        Write-Host "  - kubectl: OK" -ForegroundColor Green
    } catch {
        $missing += "kubectl (install with: choco install kubernetes-cli)"
        Write-Host "  - kubectl: MISSING" -ForegroundColor Red
    }
    
    # Check Java
    try {
        java -version 2>&1 | Out-Null
        Write-Host "  - Java: OK" -ForegroundColor Green
    } catch {
        $missing += "Java 21+"
        Write-Host "  - Java: MISSING" -ForegroundColor Red
    }
    
    # Check Maven
    try {
        mvn --version | Out-Null
        Write-Host "  - Maven: OK" -ForegroundColor Green
    } catch {
        $missing += "Maven"
        Write-Host "  - Maven: MISSING" -ForegroundColor Red
    }
    
    # Check Node.js
    try {
        node --version | Out-Null
        Write-Host "  - Node.js: OK" -ForegroundColor Green
    } catch {
        $missing += "Node.js 18+"
        Write-Host "  - Node.js: MISSING" -ForegroundColor Red
    }
    
    if ($missing.Count -gt 0) {
        Write-Host ""
        Write-Host "Missing prerequisites:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "Please install the missing tools and try again." -ForegroundColor Red
        exit 1
    }
    
    Write-Host ""
}

# Build debug filter library
function Build-FilterLibrary {
    Write-Host "[2/7] Building debug filter library..." -ForegroundColor Yellow
    
    Push-Location "$ProjectRoot\debug-filter-lib"
    try {
        mvn clean package -DskipTests -q
        if ($LASTEXITCODE -ne 0) { throw "Maven build failed" }
        Write-Host "  - Filter library built successfully" -ForegroundColor Green
    } finally {
        Pop-Location
    }
    Write-Host ""
}

# Build service JARs (optional - pass -ValuationPath/-VcpPath to use real apps; mocks are used otherwise)
function Build-Services {
    Write-Host "[3/7] Building service images..." -ForegroundColor Yellow

    # Create build context directory
    $buildContext = "$ProjectRoot\docker\build-context"
    New-Item -ItemType Directory -Force -Path $buildContext | Out-Null

    # Copy filter library
    Copy-Item "$ProjectRoot\debug-filter-lib\target\debug-filter-lib-1.0.0.jar" "$buildContext\" -Force

    foreach ($svc in @(@{Name="Valuation"; Path=$ValuationPath; Jar="valuation-app.jar"}, @{Name="VCP"; Path=$VcpPath; Jar="vcp-app.jar"})) {
        if ([string]::IsNullOrWhiteSpace($svc.Path)) {
            Write-Host "  - $($svc.Name): no source path given, mock service will be used" -ForegroundColor Yellow
            continue
        }
        Write-Host "  - Building $($svc.Name) JAR from $($svc.Path)..." -ForegroundColor Cyan
        Push-Location $svc.Path
        try {
            mvn clean package -DskipTests -q 2>&1 | Out-Null
            $jar = Get-ChildItem -Path "target" -Filter "*.jar" | Where-Object { $_.Name -notlike "*sources*" -and $_.Name -notlike "*javadoc*" } | Select-Object -First 1
            if ($jar) {
                Copy-Item $jar.FullName "$buildContext\$($svc.Jar)" -Force
                Write-Host "    - JAR copied: $($jar.Name)" -ForegroundColor Green
            } else {
                Write-Host "    - Warning: No JAR found, using placeholder" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "    - Warning: Build failed, will use mock image" -ForegroundColor Yellow
        } finally {
            Pop-Location
        }
    }

    Write-Host ""
}

# Build Docker images
function Build-DockerImages {
    Write-Host "[4/7] Building Docker images..." -ForegroundColor Yellow
    
    $buildContext = "$ProjectRoot\docker\build-context"
    
    # Check if JARs exist, if not create mock services
    if (-not (Test-Path "$buildContext\valuation-app.jar")) {
        Write-Host "  - Creating mock Valuation service..." -ForegroundColor Yellow
        # We'll create a simple mock Spring Boot app
        Create-MockService -ServiceName "valuation" -Port 8807 -JdwpPort 5005
    }
    
    if (-not (Test-Path "$buildContext\vcp-app.jar")) {
        Write-Host "  - Creating mock VCP service..." -ForegroundColor Yellow
        Create-MockService -ServiceName "vcp" -Port 8081 -JdwpPort 5006
    }
    
    # Build Valuation image
    Write-Host "  - Building valuation-debug:latest..." -ForegroundColor Cyan
    Push-Location $buildContext
    try {
        $dockerfile = @"
FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache curl bash
WORKDIR /app
COPY valuation-app.jar app.jar
COPY debug-filter-lib-1.0.0.jar /app/libs/
ENV JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
ENV SERVER_PORT=8807
EXPOSE 8807 5005
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD curl -f http://localhost:8807/actuator/health || exit 1
ENTRYPOINT ["java", "-Dloader.path=/app/libs/", "-jar", "app.jar"]
"@
        $dockerfile | Out-File -FilePath "Dockerfile.valuation" -Encoding UTF8
        docker build -t valuation-debug:latest -f Dockerfile.valuation .
        if ($LASTEXITCODE -ne 0) { throw "Docker build failed for valuation" }
        Write-Host "    - Image built successfully" -ForegroundColor Green
    } finally {
        Pop-Location
    }
    
    # Build VCP image
    Write-Host "  - Building vcp-debug:latest..." -ForegroundColor Cyan
    Push-Location $buildContext
    try {
        $dockerfile = @"
FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache curl bash
WORKDIR /app
COPY vcp-app.jar app.jar
COPY debug-filter-lib-1.0.0.jar /app/libs/
ENV JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5006"
ENV SERVER_PORT=8081
EXPOSE 8081 5006
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD curl -f http://localhost:8081/actuator/health || exit 1
ENTRYPOINT ["java", "-Dloader.path=/app/libs/", "-jar", "app.jar"]
"@
        $dockerfile | Out-File -FilePath "Dockerfile.vcp" -Encoding UTF8
        docker build -t vcp-debug:latest -f Dockerfile.vcp .
        if ($LASTEXITCODE -ne 0) { throw "Docker build failed for vcp" }
        Write-Host "    - Image built successfully" -ForegroundColor Green
    } finally {
        Pop-Location
    }
    
    Write-Host ""
}

# Create mock service for testing
function Create-MockService {
    param(
        [string]$ServiceName,
        [int]$Port,
        [int]$JdwpPort
    )
    
    $mockDir = "$ProjectRoot\mock-services\$ServiceName"
    New-Item -ItemType Directory -Force -Path $mockDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$mockDir\src\main\java\com\mock" | Out-Null
    New-Item -ItemType Directory -Force -Path "$mockDir\src\main\resources" | Out-Null
    
    # pom.xml
    @"
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.4.4</version>
    </parent>
    <groupId>com.mock</groupId>
    <artifactId>$ServiceName-service</artifactId>
    <version>1.0.0</version>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>
        <dependency>
            <groupId>com.debugger</groupId>
            <artifactId>debug-filter-lib</artifactId>
            <version>1.0.0</version>
            <scope>system</scope>
            <systemPath>`${project.basedir}/../../debug-filter-lib/target/debug-filter-lib-1.0.0.jar</systemPath>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
"@ | Out-File -FilePath "$mockDir\pom.xml" -Encoding UTF8

    # Application.java
    @"
package com.mock;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import java.util.*;

@SpringBootApplication
@RestController
@RequestMapping("/api/v1")
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> result = new HashMap<>();
        result.put("status", "UP");
        result.put("service", "$ServiceName");
        return result;
    }

    @GetMapping("/test")
    public Map<String, Object> test(@RequestParam(required = false) String param) {
        Map<String, Object> result = new HashMap<>();
        result.put("service", "$ServiceName");
        result.put("param", param);
        result.put("timestamp", System.currentTimeMillis());
        // Good place for breakpoints
        String processed = processData(param);
        result.put("processed", processed);
        return result;
    }

    private String processData(String input) {
        if (input == null) {
            input = "default";
        }
        return input.toUpperCase() + "_PROCESSED";
    }

    @PostMapping("/data")
    public Map<String, Object> postData(@RequestBody Map<String, Object> data) {
        Map<String, Object> result = new HashMap<>();
        result.put("received", data);
        result.put("processed", true);
        return result;
    }
}
"@ | Out-File -FilePath "$mockDir\src\main\java\com\mock\Application.java" -Encoding UTF8

    # application.properties
    @"
server.port=$Port
spring.application.name=$ServiceName-service
management.endpoints.web.exposure.include=health,info
management.endpoint.health.probes.enabled=true
debug.filter.enabled=true
"@ | Out-File -FilePath "$mockDir\src\main\resources\application.properties" -Encoding UTF8

    # Build mock service
    Push-Location $mockDir
    try {
        mvn clean package -DskipTests -q 2>&1 | Out-Null
        $jar = Get-ChildItem -Path "target" -Filter "*.jar" | Where-Object { $_.Name -notlike "*sources*" } | Select-Object -First 1
        if ($jar) {
            Copy-Item $jar.FullName "$ProjectRoot\docker\build-context\$ServiceName-app.jar" -Force
        }
    } finally {
        Pop-Location
    }
}

# Create Kind cluster
function Create-KindCluster {
    Write-Host "[5/7] Creating Kind cluster..." -ForegroundColor Yellow
    
    # Check if cluster exists
    $existingClusters = kind get clusters 2>&1
    if ($existingClusters -contains "debug-cluster") {
        Write-Host "  - Cluster 'debug-cluster' already exists" -ForegroundColor Yellow
        $response = Read-Host "  - Do you want to delete and recreate it? (y/N)"
        if ($response -eq "y" -or $response -eq "Y") {
            Write-Host "  - Deleting existing cluster..." -ForegroundColor Cyan
            kind delete cluster --name debug-cluster
        } else {
            Write-Host "  - Using existing cluster" -ForegroundColor Green
            return
        }
    }
    
    Write-Host "  - Creating cluster with port mappings..." -ForegroundColor Cyan
    kind create cluster --config "$ProjectRoot\k8s\kind-config.yaml" --name debug-cluster
    if ($LASTEXITCODE -ne 0) { throw "Failed to create Kind cluster" }
    
    # Wait for cluster to be ready
    Write-Host "  - Waiting for cluster to be ready..." -ForegroundColor Cyan
    Start-Sleep -Seconds 10
    kubectl wait --for=condition=Ready nodes --all --timeout=120s
    
    Write-Host "  - Cluster created successfully" -ForegroundColor Green
    Write-Host ""
}

# Load images and deploy
function Deploy-Services {
    Write-Host "[6/7] Deploying services to cluster..." -ForegroundColor Yellow
    
    # Load images into Kind
    Write-Host "  - Loading images into Kind cluster..." -ForegroundColor Cyan
    kind load docker-image valuation-debug:latest --name debug-cluster
    kind load docker-image vcp-debug:latest --name debug-cluster
    
    # Apply Kubernetes manifests
    Write-Host "  - Applying Kubernetes manifests..." -ForegroundColor Cyan
    kubectl apply -f "$ProjectRoot\k8s\namespace.yaml"
    kubectl apply -f "$ProjectRoot\k8s\configmaps.yaml"
    kubectl apply -f "$ProjectRoot\k8s\rbac.yaml"
    kubectl apply -f "$ProjectRoot\k8s\valuation-deployment.yaml"
    kubectl apply -f "$ProjectRoot\k8s\vcp-deployment.yaml"
    
    # Wait for deployments
    Write-Host "  - Waiting for deployments to be ready..." -ForegroundColor Cyan
    kubectl wait --for=condition=Available deployment/valuation-service -n debug-services --timeout=180s 2>&1 | Out-Null
    kubectl wait --for=condition=Available deployment/vcp-service -n debug-services --timeout=180s 2>&1 | Out-Null
    
    Write-Host "  - Services deployed successfully" -ForegroundColor Green
    Write-Host ""
}

# Setup MCP server
function Setup-McpServer {
    Write-Host "[7/7] Setting up MCP server..." -ForegroundColor Yellow
    
    Push-Location "$ProjectRoot\mcp-server"
    try {
        Write-Host "  - Installing dependencies..." -ForegroundColor Cyan
        npm install 2>&1 | Out-Null
        
        Write-Host "  - Building TypeScript..." -ForegroundColor Cyan
        npm run build 2>&1 | Out-Null
        
        Write-Host "  - MCP server ready" -ForegroundColor Green
    } finally {
        Pop-Location
    }
    Write-Host ""
}

# Main execution
if (-not $SkipPrerequisites) {
    Check-Prerequisites
}

if (-not $SkipBuild) {
    Build-FilterLibrary
    Build-Services
}

Build-DockerImages
Create-KindCluster
Deploy-Services
Setup-McpServer

Write-Host "==========================================" -ForegroundColor Green
Write-Host "Setup Complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Services deployed:" -ForegroundColor Cyan
Write-Host "  - Valuation Service: http://localhost:8807" -ForegroundColor White
Write-Host "    JDWP: localhost:5005" -ForegroundColor Gray
Write-Host "  - VCP Service: http://localhost:8081" -ForegroundColor White
Write-Host "    JDWP: localhost:5006" -ForegroundColor Gray
Write-Host ""
Write-Host "To view pods:" -ForegroundColor Cyan
Write-Host "  kubectl get pods -n debug-services" -ForegroundColor White
Write-Host ""
Write-Host "To configure Cursor MCP, add to .cursor/mcp.json:" -ForegroundColor Cyan
Write-Host @"
{
  "mcpServers": {
    "jdwp-k8s": {
      "command": "node",
      "args": ["$($ProjectRoot -replace '\\','\\\\')\mcp-server\dist\index.js"]
    }
  }
}
"@ -ForegroundColor White
Write-Host ""
Write-Host "Run the test script to verify:" -ForegroundColor Cyan
Write-Host "  .\scripts\test.ps1" -ForegroundColor White
