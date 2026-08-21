@echo off
echo Setting up JDWP MCP Server...
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js is not installed. Please install Node.js 18+ first.
    exit /b 1
)

REM Check if Java is installed
where java >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Java is not installed. Please install Java 21 JDK first.
    exit /b 1
)

REM Check if Maven is installed
where mvn >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Maven is not installed. Please install Maven 3.6+ first.
    exit /b 1
)

echo [OK] Node.js found
node --version
echo [OK] Java found
java -version 2>&1 | findstr /C:"version"
echo [OK] Maven found
mvn --version | findstr /C:"Apache Maven"
echo.

REM Build the JDWP client
echo Building JDWP client...
cd ..\client
call mvn clean package -DskipTests
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to build JDWP client
    exit /b 1
)
echo [OK] JDWP client built successfully

REM Return to jdwp-mcp directory
cd ..\jdwp-mcp

REM Install npm dependencies
echo.
echo Installing npm dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install dependencies
    exit /b 1
)
echo [OK] Dependencies installed successfully

REM Build the MCP server
echo.
echo Building MCP server...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to build MCP server
    exit /b 1
)
echo [OK] MCP server built successfully

echo.
echo ==========================================
echo Setup complete!
echo ==========================================
echo.
echo Next steps:
echo 1. Add the MCP server to your Cursor IDE configuration
echo 2. See README.md for configuration instructions
echo.

pause

