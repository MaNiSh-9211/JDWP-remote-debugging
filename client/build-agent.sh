#!/bin/bash
# Build script for console log agent JAR

echo "Building Console Log Agent JAR..."

# Create agent directory structure
mkdir -p agent-build/classes
mkdir -p agent-build/META-INF

# Compile agent class
javac -d agent-build/classes \
  -sourcepath src/main/java \
  src/main/java/com/jdwp/client/agent/ConsoleLogAgent.java

# Copy manifest
cp src/main/resources/META-INF/MANIFEST.MF agent-build/META-INF/

# Create JAR
cd agent-build
jar cfm ../console-log-agent.jar META-INF/MANIFEST.MF -C classes .

cd ..
echo "Agent JAR created: console-log-agent.jar"
ls -lh console-log-agent.jar
