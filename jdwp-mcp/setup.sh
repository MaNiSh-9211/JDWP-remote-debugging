#!/bin/bash

echo "Setting up JDWP MCP Server..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check if Java is installed
if ! command -v java &> /dev/null; then
    echo "Error: Java is not installed. Please install Java 21 JDK first."
    exit 1
fi

# Check if Maven is installed
if ! command -v mvn &> /dev/null; then
    echo "Error: Maven is not installed. Please install Maven 3.6+ first."
    exit 1
fi

echo "✓ Node.js found: $(node --version)"
echo "✓ Java found: $(java -version 2>&1 | head -n 1)"
echo "✓ Maven found: $(mvn --version | head -n 1)"
echo ""

# Build the JDWP client
echo "Building JDWP client..."
cd ../client
if mvn clean package -DskipTests; then
    echo "✓ JDWP client built successfully"
else
    echo "✗ Failed to build JDWP client"
    exit 1
fi

# Return to jdwp-mcp directory
cd ../jdwp-mcp

# Install npm dependencies
echo ""
echo "Installing npm dependencies..."
if npm install; then
    echo "✓ Dependencies installed successfully"
else
    echo "✗ Failed to install dependencies"
    exit 1
fi

# Build the MCP server
echo ""
echo "Building MCP server..."
if npm run build; then
    echo "✓ MCP server built successfully"
else
    echo "✗ Failed to build MCP server"
    exit 1
fi

echo ""
echo "=========================================="
echo "Setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Add the MCP server to your Cursor IDE configuration"
echo "2. See README.md for configuration instructions"
echo ""

