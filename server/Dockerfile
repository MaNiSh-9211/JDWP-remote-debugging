# Build stage: dependency layers are cached separately from sources,
# so rebuilds after code-only changes skip the Maven download entirely.
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -q -B -DskipTests dependency:go-offline
COPY src ./src
COPY data ./data
RUN mvn -q -B -DskipTests package

# Runtime stage: minimal JRE, non-root user, JVM defaults tuned for containers.
FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV DEMO_DATA_DIR=/app/data \
    JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
COPY --from=build /build/target/debug-server-1.0.0.jar /app/server-app.jar
COPY --from=build /build/data /app/data
USER app
EXPOSE 8081 5005
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar /app/server-app.jar"]
