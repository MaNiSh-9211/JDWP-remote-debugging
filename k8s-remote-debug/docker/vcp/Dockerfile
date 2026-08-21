# Multi-stage Dockerfile for VCP Service with JDWP debugging support
# Stage 1: Build the debug filter library
FROM maven:3.9-eclipse-temurin-21 AS filter-builder

WORKDIR /filter-lib
COPY debug-filter-lib/ .
RUN mvn clean package -DskipTests

# Stage 2: Build the application
FROM maven:3.9-eclipse-temurin-21 AS app-builder

# Copy the debug filter library
COPY --from=filter-builder /filter-lib/target/debug-filter-lib-1.0.0.jar /libs/

# Install filter lib to local maven repo
RUN mvn install:install-file \
    -Dfile=/libs/debug-filter-lib-1.0.0.jar \
    -DgroupId=com.debugger \
    -DartifactId=debug-filter-lib \
    -Dversion=1.0.0 \
    -Dpackaging=jar

WORKDIR /app

# Copy pom.xml first for better caching
COPY source/pom.xml .

# Add debug filter dependency (will be done at runtime via patched pom)
RUN mvn dependency:go-offline -B || true

# Copy source code
COPY source/src ./src

# Build the application
RUN mvn clean package -DskipTests -B

# Stage 3: Runtime
FROM eclipse-temurin:21-jre-alpine

# Install debugging tools
RUN apk add --no-cache curl bash

# Create app user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy the built JAR
COPY --from=app-builder /app/target/*.jar app.jar

# Copy the debug filter library
COPY --from=filter-builder /filter-lib/target/debug-filter-lib-1.0.0.jar /app/libs/

# Environment variables for JDWP
ENV JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5006"
ENV SPRING_PROFILES_ACTIVE=debug
ENV SERVER_PORT=8081

# JDWP and HTTP ports
EXPOSE 8081 5006

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8081/actuator/health || exit 1

# Switch to non-root user
USER appuser

# Run the application with debug filter on classpath
ENTRYPOINT ["java", \
    "-Dloader.path=/app/libs/", \
    "-Dspring.profiles.active=${SPRING_PROFILES_ACTIVE}", \
    "-jar", "app.jar"]
