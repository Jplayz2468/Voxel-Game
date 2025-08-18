#!/usr/bin/env node
// Server entry point - starts the multiplayer voxel physics server
// Also serves static files over HTTP
// Run with: node server.js

import { WebSocketServer } from 'ws';
import { VoxelServer } from './VoxelServer.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Server configuration
const WS_PORT = 8765;  // WebSocket port
const HTTP_PORT = 8000; // HTTP port for serving files
const SERVER_HOST = '0.0.0.0';

// Get current directory for ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🚀 Multiplayer Voxel Physics Server Starting...');
console.log('=====================================');

// MIME types for different file extensions
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon'
};

/**
 * HTTP Server for serving static files
 */
const httpServer = http.createServer((req, res) => {
    // Parse URL and remove query string
    let filePath = req.url.split('?')[0];
    
    // Default to index.html for root requests
    if (filePath === '/') {
        filePath = '/client.html';
    }
    
    // Security: prevent directory traversal
    filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    
    // Build full file path
    const fullPath = path.join(__dirname, filePath);
    
    // Get file extension for MIME type
    const ext = path.extname(fullPath).toLowerCase();
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    
    // Check if file exists and serve it
    fs.readFile(fullPath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // File not found
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>404 - File Not Found</h1>
                    <p>The requested file "${filePath}" was not found.</p>
                    <a href="/">← Back to Game</a>
                `);
            } else {
                // Server error
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>500 - Server Error</h1>
                    <p>Error reading file: ${err.message}</p>
                `);
            }
            console.error(`❌ HTTP Error serving ${filePath}:`, err.message);
        } else {
            // Serve the file
            res.writeHead(200, { 
                'Content-Type': mimeType,
                'Cache-Control': 'no-cache' // Disable caching for development
            });
            res.end(data);
            console.log(`📄 Served: ${filePath} (${data.length} bytes)`);
        }
    });
});

// Start HTTP server
httpServer.listen(HTTP_PORT, SERVER_HOST, () => {
    console.log(`🌐 HTTP server listening on http://${SERVER_HOST}:${HTTP_PORT}`);
    console.log(`🎮 Open your browser to: http://localhost:${HTTP_PORT}`);
});

// Create the game server
const gameServer = new VoxelServer();

// Create WebSocket server
const wss = new WebSocketServer({ 
    port: WS_PORT, 
    host: SERVER_HOST 
});

console.log(`📡 WebSocket server listening on ws://${SERVER_HOST}:${WS_PORT}`);

// Handle new client connections
wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`🔌 New connection from ${clientIP}`);

    // Add player to game
    gameServer.addPlayer(ws);

    // Handle messages from this client
    ws.on('message', (message) => {
        gameServer.handleClientMessage(ws, message.toString());
    });

    // Handle client disconnect
    ws.on('close', () => {
        console.log(`👋 Client ${clientIP} disconnected`);
        gameServer.removePlayer(ws);
    });

    // Handle connection errors
    ws.on('error', (error) => {
        console.error(`❌ WebSocket error from ${clientIP}:`, error);
        gameServer.removePlayer(ws);
    });
});

// Handle server errors
wss.on('error', (error) => {
    console.error('❌ WebSocket server error:', error);
});

// Start the physics simulation
gameServer.startPhysicsLoop();

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT (Ctrl+C), shutting down gracefully...');
    
    gameServer.shutdown();
    
    // Close WebSocket server
    wss.close(() => {
        console.log('📡 WebSocket server closed');
        
        // Close HTTP server
        httpServer.close(() => {
            console.log('🌐 HTTP server closed');
            process.exit(0);
        });
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    
    gameServer.shutdown();
    
    // Close WebSocket server
    wss.close(() => {
        console.log('📡 WebSocket server closed');
        
        // Close HTTP server  
        httpServer.close(() => {
            console.log('🌐 HTTP server closed');
            process.exit(0);
        });
    });
});

// Log server status
console.log('');
console.log('🎯 GAME FEATURES:');
console.log('👥 Multiplayer: Each tab = unique voxel player');
console.log('⚡ Physics: 50 TPS with voxel-based players');
console.log('🧱 Players: Solid cube bodies (16x32x16 = 8192 voxels server-side)');
console.log('🎨 Rendering: Players as greedy-meshed hollow shells (OPTIMIZED)');
console.log('🚫 Network: Each client receives mesh WITHOUT their own player body');
console.log('📤 Optimization: Individual meshes per client (excluding own player)');
console.log('💥 Gameplay: Player voxels can be shot off');
console.log('👀 View: Perfect first-person view (own body invisible)');
console.log('');
console.log('🎮 HOW TO PLAY:');
console.log('1. Open your browser to: http://localhost:8000');
console.log('2. Open multiple tabs for more players');
console.log('3. WASD to move, Space to jump, Click to shoot');
console.log('4. T for smooth/raw mode, C for color mode');
console.log('');
console.log('✅ Server ready for connections!');

// Periodic server stats logging
setInterval(() => {
    const stats = gameServer.getServerStats();
    if (stats.connectedPlayers > 0) {
        console.log(`📊 Server stats: ${stats.connectedPlayers} players, ${stats.movingVoxels} moving voxels, ${stats.playerVoxels} player voxels, ${(stats.memoryUsage.heapUsed / 1024 / 1024).toFixed(1)}MB RAM`);
    }
}, 30000); // Log every 30 seconds