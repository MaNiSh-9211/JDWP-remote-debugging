# Setup MCP Server for Cursor - Fixes build and configures for all folders
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "JDWP MCP Server Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$mcpDir = $PSScriptRoot
$distFile = Join-Path $mcpDir "dist\index.js"
$cursorConfigDir = "$env:USERPROFILE\.cursor"
$cursorConfig = Join-Path $cursorConfigDir "mcp.json"

# Step 1: Build MCP Server
Write-Host "Step 1: Building MCP server..." -ForegroundColor Yellow
Set-Location $mcpDir

# Install dependencies
Write-Host "  Installing dependencies..." -ForegroundColor Gray
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ npm install failed" -ForegroundColor Red
    exit 1
}

# Build
Write-Host "  Compiling TypeScript..." -ForegroundColor Gray
npm run build 2>&1 | Out-Null

# Wait a bit for file system
Start-Sleep -Seconds 2

# Verify build
if (Test-Path $distFile) {
    Write-Host "  ✓ Build successful! dist/index.js exists" -ForegroundColor Green
} else {
    Write-Host "  ✗ Build failed! dist/index.js not found" -ForegroundColor Red
    Write-Host "  Trying alternative build method..." -ForegroundColor Yellow
    
    # Try direct tsc
    if (Test-Path "node_modules\.bin\tsc.cmd") {
        & "node_modules\.bin\tsc.cmd"
        Start-Sleep -Seconds 2
    } elseif (Test-Path "node_modules\typescript\bin\tsc") {
        node "node_modules\typescript\bin\tsc"
        Start-Sleep -Seconds 2
    }
    
    if (Test-Path $distFile) {
        Write-Host "  ✓ Build successful with alternative method!" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Build still failed. Check for TypeScript errors above." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# Step 2: Configure Cursor
Write-Host "Step 2: Configuring Cursor for ALL folders..." -ForegroundColor Yellow

# Create .cursor directory
if (-not (Test-Path $cursorConfigDir)) {
    New-Item -ItemType Directory -Force -Path $cursorConfigDir | Out-Null
    Write-Host "  Created .cursor directory" -ForegroundColor Gray
}

# Convert path to Windows format with double backslashes
$distPath = $distFile -replace '\\', '\\'

# Create config
$config = @{
    mcpServers = @{
        jdwp = @{
            command = "node"
            args = @($distFile)
            env = @{}
        }
    }
} | ConvertTo-Json -Depth 10

# Save config
$config | Set-Content $cursorConfig -Encoding UTF8
Write-Host "  ✓ Config created at: $cursorConfig" -ForegroundColor Green
Write-Host ""

# Step 3: Verify
Write-Host "Step 3: Verification..." -ForegroundColor Yellow
Write-Host "  MCP Server file: $distFile" -ForegroundColor Gray
Write-Host "    Exists: $(if (Test-Path $distFile) { '✓ YES' } else { '✗ NO' })" -ForegroundColor $(if (Test-Path $distFile) { 'Green' } else { 'Red' })
Write-Host "  Cursor config: $cursorConfig" -ForegroundColor Gray
Write-Host "    Exists: $(if (Test-Path $cursorConfig) { '✓ YES' } else { '✗ NO' })" -ForegroundColor $(if (Test-Path $cursorConfig) { 'Green' } else { 'Red' })

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "1. RESTART Cursor completely (quit and reopen)" -ForegroundColor White
Write-Host "2. Open ANY folder/workspace" -ForegroundColor White
Write-Host "3. The MCP server will work in ALL folders!" -ForegroundColor White
Write-Host ""
Write-Host "To test, ask Cursor: Can you help me debug Java code?" -ForegroundColor Gray
Write-Host ""

