@echo off
REM Build script for console log agent JAR (Windows)

echo Building Console Log Agent JAR with ASM...

REM Create agent directory structure
if not exist agent-build\classes mkdir agent-build\classes
if not exist agent-build\META-INF mkdir agent-build\META-INF

REM Check if ASM JAR exists
if not exist asm-9.6.jar (
    echo ERROR: asm-9.6.jar not found! Please download it first.
    echo Download from: https://repo1.maven.org/maven2/org/ow2/asm/asm/9.6/asm-9.6.jar
    exit /b 1
)

REM Compile agent classes (ASMTransformer removed - using reflection approach)
echo Compiling agent classes...
javac -d agent-build\classes -sourcepath src\main\java ^
    src\main\java\com\jdwp\client\agent\ConsoleLogAgent.java ^
    src\main\java\com\jdwp\client\agent\LoggingFrameworkInterceptor.java

if errorlevel 1 (
    echo Compilation failed!
    exit /b 1
)

REM Copy manifest
copy src\main\resources\META-INF\MANIFEST.MF agent-build\META-INF\ >nul

REM Extract ASM classes into agent-build
if not exist agent-build\asm mkdir agent-build\asm
cd agent-build\asm
jar xf ..\..\asm-9.6.jar
cd ..\..

REM Create JAR with ASM classes included
cd agent-build
jar cfm ..\console-log-agent.jar META-INF\MANIFEST.MF -C classes . -C asm .

cd ..
echo Agent JAR created: console-log-agent.jar
dir console-log-agent.jar
