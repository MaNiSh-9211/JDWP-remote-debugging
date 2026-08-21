package com.jdwp.server.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdwp.server.model.User;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class UserService {
    
    private static final Logger logger = LoggerFactory.getLogger(UserService.class);
    
    private static final String DB_DIR = "data";
    private static final String DB_FILE = "users.json";
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final AtomicLong nextId = new AtomicLong(1);
    
    public UserService() {
        // Initialize database directory and file
        try {
            Path dbPath = Paths.get(DB_DIR);
            if (!Files.exists(dbPath)) {
                Files.createDirectories(dbPath);
            }
            
            Path filePath = Paths.get(DB_DIR, DB_FILE);
            if (!Files.exists(filePath)) {
                // Create initial data file
                List<User> initialUsers = createInitialUsers();
                saveUsersToFile(initialUsers);
            } else {
                // Load existing data and find max ID
                List<User> users = loadUsersFromFile();
                if (!users.isEmpty()) {
                    long maxId = users.stream()
                            .mapToLong(User::getId)
                            .max()
                            .orElse(0);
                    nextId.set(maxId + 1);
                }
            }
        } catch (IOException e) {
            System.err.println("Error initializing database: " + e.getMessage());
        }
    }
    
    public List<User> getAllUsers() {
        logger.info("[SERVICE] UserService.getAllUsers() - Line 55 - CONTROL ENTERED");
        // BREAKPOINT: Set breakpoint here (line 55) to debug getAllUsers in service
        try {
            String name = "manish";
            logger.info("[SERVICE] Loading users from file...");
            List<User> users = loadUsersFromFile();
            logger.info("[SERVICE] Loaded {} users from file", users.size());
            logger.info("[SERVICE] Users: {}", users);
            logger.info("[SERVICE] UserService.getAllUsers() - RETURNING {} users", users.size());
            return users;
        } catch (Exception e) {
            logger.error("[SERVICE] Error loading users: {}", e.getMessage(), e);
            System.err.println("Error loading users: " + e.getMessage());
            return new ArrayList<>();
        }
    }
    
    public User getUserById(Long id) {
        logger.info("[SERVICE] UserService.getUserById() - Line 65 - CONTROL ENTERED");
        logger.info("[SERVICE] Parameter id = {}", id);
        // BREAKPOINT: Set breakpoint here to debug getUserById
        logger.info("[SERVICE] Calling getAllUsers() to get all users...");
        List<User> users = getAllUsers();
        logger.info("[SERVICE] Got {} users, searching for id = {}", users.size(), id);
        User foundUser = users.stream()
                .filter(user -> user.getId().equals(id))
                .findFirst()
                .orElse(null);
        logger.info("[SERVICE] Found user: {}", foundUser);
        logger.info("[SERVICE] UserService.getUserById({}) - RETURNING {}", id, foundUser);
        return foundUser;
    }
    
    public User createUser(User user) {
        logger.info("[SERVICE] UserService.createUser() - Line 74 - CONTROL ENTERED");
        logger.info("[SERVICE] Parameter user = {}", user);
        logger.info("[SERVICE] User details - Name: {}, Email: {}, Age: {}", 
                   user != null ? user.getName() : "null",
                   user != null ? user.getEmail() : "null",
                   user != null ? user.getAge() : "null");
        // BREAKPOINT: Set breakpoint here to debug createUser
        try {
            logger.info("[SERVICE] Getting all existing users...");
            List<User> users = getAllUsers();
            logger.info("[SERVICE] Current users count: {}", users.size());
            logger.info("[SERVICE] Next ID will be: {}", nextId.get());
            user.setId(nextId.getAndIncrement());
            logger.info("[SERVICE] Assigned ID {} to new user", user.getId());
            users.add(user);
            logger.info("[SERVICE] Added user to list. New count: {}", users.size());
            logger.info("[SERVICE] Saving users to file...");
            saveUsersToFile(users);
            logger.info("[SERVICE] Users saved to file successfully");
            logger.info("[SERVICE] UserService.createUser() - RETURNING {}", user);
            return user;
        } catch (Exception e) {
            logger.error("[SERVICE] Error creating user: {}", e.getMessage(), e);
            System.err.println("Error creating user: " + e.getMessage());
            throw new RuntimeException("Failed to create user", e);
        }
    }
    
    public User updateUser(Long id, User updatedUser) {
        logger.info("[SERVICE] UserService.updateUser() - Line 88 - CONTROL ENTERED");
        logger.info("[SERVICE] Parameter id = {}", id);
        logger.info("[SERVICE] Parameter updatedUser = {}", updatedUser);
        logger.info("[SERVICE] Updated user details - Name: {}, Email: {}, Age: {}", 
                   updatedUser != null ? updatedUser.getName() : "null",
                   updatedUser != null ? updatedUser.getEmail() : "null",
                   updatedUser != null ? updatedUser.getAge() : "null");
        // BREAKPOINT: Set breakpoint here to debug updateUser
        try {
            logger.info("[SERVICE] Getting all existing users...");
            List<User> users = getAllUsers();
            logger.info("[SERVICE] Current users count: {}", users.size());
            logger.info("[SERVICE] Searching for user with id = {}", id);
            Optional<User> userOpt = users.stream()
                    .filter(user -> user.getId().equals(id))
                    .findFirst();
            
            if (userOpt.isPresent()) {
                User existingUser = userOpt.get();
                logger.info("[SERVICE] Found existing user: {}", existingUser);
                logger.info("[SERVICE] Updating user fields...");
                existingUser.setName(updatedUser.getName());
                logger.info("[SERVICE] Updated name: {}", existingUser.getName());
                existingUser.setEmail(updatedUser.getEmail());
                logger.info("[SERVICE] Updated email: {}", existingUser.getEmail());
                existingUser.setAge(updatedUser.getAge());
                logger.info("[SERVICE] Updated age: {}", existingUser.getAge());
                logger.info("[SERVICE] Saving updated users to file...");
                saveUsersToFile(users);
                logger.info("[SERVICE] Users saved to file successfully");
                logger.info("[SERVICE] UserService.updateUser({}) - RETURNING {}", id, existingUser);
                return existingUser;
            }
            logger.info("[SERVICE] User with id {} not found", id);
            logger.info("[SERVICE] UserService.updateUser({}) - RETURNING null", id);
            return null;
        } catch (Exception e) {
            logger.error("[SERVICE] Error updating user: {}", e.getMessage(), e);
            System.err.println("Error updating user: " + e.getMessage());
            throw new RuntimeException("Failed to update user", e);
        }
    }
    
    public boolean deleteUser(Long id) {
        logger.info("[SERVICE] UserService.deleteUser() - Line 111 - CONTROL ENTERED");
        logger.info("[SERVICE] Parameter id = {}", id);
        // BREAKPOINT: Set breakpoint here to debug deleteUser
        try {
            logger.info("[SERVICE] Getting all existing users...");
            List<User> users = getAllUsers();
            logger.info("[SERVICE] Current users count: {}", users.size());
            logger.info("[SERVICE] Attempting to remove user with id = {}", id);
            boolean removed = users.removeIf(user -> user.getId().equals(id));
            logger.info("[SERVICE] Remove operation result: {}", removed);
            if (removed) {
                logger.info("[SERVICE] User removed. New count: {}", users.size());
                logger.info("[SERVICE] Saving updated users to file...");
                saveUsersToFile(users);
                logger.info("[SERVICE] Users saved to file successfully");
            } else {
                logger.info("[SERVICE] User with id {} was not found, nothing to remove", id);
            }
            logger.info("[SERVICE] UserService.deleteUser({}) - RETURNING {}", id, removed);
            return removed;
        } catch (Exception e) {
            logger.error("[SERVICE] Error deleting user: {}", e.getMessage(), e);
            System.err.println("Error deleting user: " + e.getMessage());
            return false;
        }
    }
    
    private List<User> loadUsersFromFile() throws IOException {
        File file = new File(DB_DIR, DB_FILE);
        if (!file.exists() || file.length() == 0) {
            return new ArrayList<>();
        }
        return objectMapper.readValue(file, new TypeReference<List<User>>() {});
    }
    
    private void saveUsersToFile(List<User> users) throws IOException {
        File file = new File(DB_DIR, DB_FILE);
        objectMapper.writerWithDefaultPrettyPrinter().writeValue(file, users);
    }
    
    private List<User> createInitialUsers() {
        List<User> users = new ArrayList<>();
        users.add(new User(1L, "John Doe", "john.doe@example.com", 30));
        users.add(new User(2L, "Jane Smith", "jane.smith@example.com", 25));
        users.add(new User(3L, "Bob Johnson", "bob.johnson@example.com", 35));
        users.add(new User(4L, "Alice Williams", "alice.williams@example.com", 28));
        users.add(new User(5L, "Charlie Brown", "charlie.brown@example.com", 32));
        nextId.set(6L);
        return users;
    }
}

