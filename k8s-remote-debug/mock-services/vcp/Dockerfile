# Simple Dockerfile for VCP mock service with JDWP
FROM eclipse-temurin:21-jre

WORKDIR /app

# Copy the pre-built JAR
COPY target/vcp-service-1.0.0.jar app.jar

# JDWP debugging enabled
ENV JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
ENV SERVER_PORT=8081

EXPOSE 8081 5005

ENTRYPOINT ["java", "-jar", "app.jar"]
