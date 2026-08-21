FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
COPY src ./src
COPY data ./data
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
ENV DEMO_DATA_DIR=/app/data
COPY --from=build /build/target/debug-server-1.0.0.jar /app/server-app.jar
COPY --from=build /build/data /app/data
EXPOSE 8081 5005
CMD ["java", "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005", "-jar", "/app/server-app.jar"]
