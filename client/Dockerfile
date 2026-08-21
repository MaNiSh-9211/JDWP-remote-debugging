# Stage 1: build the React web UI (served by the client at :8083)
FROM node:20-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
# Vite writes straight into the Maven resources dir mounted via --output
RUN mkdir -p /build-static && npx vite build --outDir /build-static --emptyOutDir

# Stage 2: dependency-cached Maven build of the Spring Boot client
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -q -B -DskipTests dependency:go-offline
COPY src ./src
COPY --from=ui /build-static ./src/main/resources/static
RUN mvn -q -B -DskipTests package

# Stage 3: minimal runtime, non-root
FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV SERVER_PORT=8083 \
    JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
COPY --from=build /build/target/debug-client-1.0.0.jar /app/app.jar
USER app
EXPOSE 8083 9999
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar /app/app.jar"]
