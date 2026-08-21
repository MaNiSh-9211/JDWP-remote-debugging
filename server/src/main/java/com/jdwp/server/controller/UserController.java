package com.jdwp.server.controller;

import com.jdwp.server.model.User;
import com.jdwp.server.service.UserService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {
    
    private static final Logger logger = LoggerFactory.getLogger(UserController.class);
    
    @Autowired
    private UserService userService;
    
    @GetMapping
    public ResponseEntity<List<User>> getAllUsers() {
        logger.info("========================================");
        logger.info("[REQUEST RECEIVED] GET /api/users");
        logger.info("========================================");
        logger.info("[CONTROL ENTERED] UserController.getAllUsers()");
        // BREAKPOINT TARGET: line 29 — set a breakpoint here and call GET /api/users
        int a = 20;
        logger.info("[DEBUG] About to call userService.getAllUsers()");
        List<User> users = userService.getAllUsers();
        logger.info("[DEBUG] Received users from service. Count: {}", users != null ? users.size() : 0);
        logger.info("[DEBUG] Users list: {}", users);
        
        logger.info("[RESPONSE SENT] GET /api/users - Status: 200 OK, Users count: {}", users != null ? users.size() : 0);
        logger.info("========================================");
        // JDWP: often lands on this "return" line; variablesEnhanced may walk the whole `users` list (slow).
        // JDWP Studio keeps Step/Resume enabled while variables load (toolbar uses debugCmdBusy, not session busy).
        return ResponseEntity.ok(users);
    }
    
    @GetMapping("/{id}")
    public ResponseEntity<User> getUserById(@PathVariable Long id) {
        logger.info("========================================");
        logger.info("[REQUEST RECEIVED] GET /api/users/{}", id);
        logger.info("========================================");
        logger.info("[CONTROL ENTERED] UserController.getUserById()");
        logger.info("[DEBUG] Parameter id = {}", id);
        
        // BREAKPOINT: Seed GET /api/users/{id} → line 50
        logger.info("[DEBUG] About to call userService.getUserById({})", id);
        User user = userService.getUserById(id);
        logger.info("[DEBUG] Received user from service: {}", user);
        
        if (user != null) {
            logger.info("[RESPONSE SENT] GET /api/users/{} - Status: 200 OK, User: {}", id, user);
            logger.info("========================================");
            return ResponseEntity.ok(user);
        }
        logger.info("[RESPONSE SENT] GET /api/users/{} - Status: 404 NOT FOUND", id);
        logger.info("========================================");
        return ResponseEntity.notFound().build();
    }
    
    @PostMapping
    public ResponseEntity<User> createUser(@RequestBody User user) {
        logger.info("========================================");
        logger.info("[REQUEST RECEIVED] POST /api/users");
        logger.info("========================================");
        logger.info("[CONTROL ENTERED] UserController.createUser()");
        logger.info("[DEBUG] Request body user = {}", user);
        logger.info("[DEBUG] User details - Name: {}, Email: {}, Age: {}", 
                   user != null ? user.getName() : "null",
                   user != null ? user.getEmail() : "null",
                   user != null ? user.getAge() : "null");
        
        // BREAKPOINT: Seed POST /api/users → line 77
        logger.info("[DEBUG] About to call userService.createUser({})", user);
        User createdUser = userService.createUser(user);
        logger.info("[DEBUG] Created user from service: {}", createdUser);
        logger.info("[DEBUG] Created user ID: {}", createdUser != null ? createdUser.getId() : "null");
        
        logger.info("[RESPONSE SENT] POST /api/users - Status: 200 OK, Created User: {}", createdUser);
        logger.info("========================================");
        return ResponseEntity.ok(createdUser);
    }
    
    @PutMapping("/{id}")
    public ResponseEntity<User> updateUser(@PathVariable Long id, @RequestBody User user) {
        logger.info("========================================");
        logger.info("[REQUEST RECEIVED] PUT /api/users/{}", id);
        logger.info("========================================");
        logger.info("[CONTROL ENTERED] UserController.updateUser()");
        logger.info("[DEBUG] Parameter id = {}", id);
        logger.info("[DEBUG] Request body user = {}", user);
        logger.info("[DEBUG] User details - Name: {}, Email: {}, Age: {}", 
                   user != null ? user.getName() : "null",
                   user != null ? user.getEmail() : "null",
                   user != null ? user.getAge() : "null");
        
        // BREAKPOINT: Seed PUT /api/users/{id} → line 101
        logger.info("[DEBUG] About to call userService.updateUser({}, {})", id, user);
        User updatedUser = userService.updateUser(id, user);
        logger.info("[DEBUG] Updated user from service: {}", updatedUser);
        
        if (updatedUser != null) {
            logger.info("[RESPONSE SENT] PUT /api/users/{} - Status: 200 OK, Updated User: {}", id, updatedUser);
            logger.info("========================================");
            return ResponseEntity.ok(updatedUser);
        }
        logger.info("[RESPONSE SENT] PUT /api/users/{} - Status: 404 NOT FOUND", id);
        logger.info("========================================");
        return ResponseEntity.notFound().build();
    }
    
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteUser(@PathVariable Long id) {
        logger.info("========================================");
        logger.info("[REQUEST RECEIVED] DELETE /api/users/{}", id);
        logger.info("========================================");
        logger.info("[CONTROL ENTERED] UserController.deleteUser()");
        logger.info("[DEBUG] Parameter id = {}", id);
        
        // BREAKPOINT: Seed DELETE /api/users/{id} → line 124
        logger.info("[DEBUG] About to call userService.deleteUser({})", id);
        boolean deleted = userService.deleteUser(id);
        logger.info("[DEBUG] Delete result from service: {}", deleted);
        
        if (deleted) {
            logger.info("[RESPONSE SENT] DELETE /api/users/{} - Status: 204 NO CONTENT", id);
            logger.info("========================================");
            return ResponseEntity.noContent().build();
        }
        logger.info("[RESPONSE SENT] DELETE /api/users/{} - Status: 404 NOT FOUND", id);
        logger.info("========================================");
        return ResponseEntity.notFound().build();
    }
}

