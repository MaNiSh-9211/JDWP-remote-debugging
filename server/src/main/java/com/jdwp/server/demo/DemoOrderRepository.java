package com.jdwp.server.demo;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * File-backed primary store with an in-memory overlay (simulates DB + cache).
 */
@Service
public class DemoOrderRepository {

    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${demo.data.dir:data}")
    private String dataDir;

    private final Map<String, Map<String, Object>> memory = new ConcurrentHashMap<>();

    @PostConstruct
    void loadFile() throws IOException {
        Path file = Paths.get(dataDir, "demo-orders.json");
        if (!Files.isRegularFile(file)) {
            return;
        }
        String json = Files.readString(file);
        List<Map<String, Object>> rows = mapper.readValue(json, new TypeReference<>() {});
        for (Map<String, Object> row : rows) {
            Object id = row.get("id");
            if (id != null) {
                memory.put(String.valueOf(id), row);
            }
        }
    }

    public Optional<Map<String, Object>> findById(String id) {
        int bpDemoRepoFind = 1;
        Map<String, Object> row = memory.get(id);
        if (row == null) {
            return Optional.empty();
        }
        int bpDemoRepoFind2 = 1;
        return Optional.of(new ConcurrentHashMap<>(row));
    }

    public List<Map<String, Object>> findAll() {
        int bpDemoRepoList = 1;
        return new ArrayList<>(memory.values());
    }

    public void save(Map<String, Object> row) {
        int bpDemoRepoSave = 1;
        Object id = row.get("id");
        if (id == null) {
            return;
        }
        memory.put(String.valueOf(id), new ConcurrentHashMap<>(row));
    }
}
