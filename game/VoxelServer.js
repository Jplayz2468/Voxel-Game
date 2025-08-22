// VoxelServer class - main server logic for the multiplayer voxel game
// Handles players, physics simulation, and network communication

import { Player } from './Player.js';
import { MovingVoxel } from './MovingVoxel.js';
import { VoxelWorld } from './VoxelWorld.js';
import { MeshGenerator } from './MeshGenerator.js';
import { ChunkedMeshGenerator } from './ChunkedMeshGenerator.js';
import { 
    SERVER_TICK_RATE, 
    DEBUG, 
    MESH_UPDATE_INTERVAL,
    DEBRIS_SETTLE_TIME,
    MAX_DEBRIS_UPDATES
} from './constants.js';

export class VoxelServer {
    constructor() {
        // Core game systems
        this.world = new VoxelWorld();
        this.meshGenerator = new MeshGenerator(); // Legacy for fallback
        this.chunkedMeshGenerator = new ChunkedMeshGenerator(); // New chunked system
        this.useChunkedMesh = true; // Toggle between old and new system
        
        // Pre-initialize chunks for fast loading
        if (this.useChunkedMesh) {
            console.log(' Pre-initializing chunk system...');
            this.chunkedMeshGenerator.initializeAllChunks(this.world);
        }
        
        // Game state
        this.players = new Map(); // playerId -> Player object
        this.clients = new Map(); // WebSocket -> client data
        this.movingVoxels = []; // Array of MovingVoxel objects (projectiles, debris)
        
        // Server management
        this.nextPlayerId = 1;
        this.lastUpdate = Date.now() / 1000;
        
        // Performance tracking
        this.frameCount = 0;
        this.totalFrameCount = 0;
        this.sendFrameCount = 0;
        
        // Enhanced mesh update tracking and batching
        this.meshNeedsUpdate = false;
        this.lastPlayerCount = 0;
        this.lastMeshUpdate = 0;
        this.lastDebrisUpdate = 0;
        this.debrisUpdateCount = 0;
        this.pendingMeshUpdates = new Set(); // Track what needs updating
        this.debrisSettleTimer = null;
        this.clientsInitialized = new Set(); // Track which clients have received initial mesh
        
        // Debug information sent to clients
        this.debugInfo = {
            activeVoxels: 0,
            totalShots: 0,
            lastShot: 'Never',
            totalPlayers: 0,
            playerVoxels: 0
        };

        console.log(' Multiplayer Voxel Server initialized - PLAYERS EXCLUDED FROM OWN MESH');
    }

    /**
     * Adds a new player when they connect
     * Returns the new player data
     */
    addPlayer(ws) {
        const playerId = `player_${this.nextPlayerId++}`;
        const player = new Player(playerId);
        
        // Store player and client data
        this.players.set(playerId, player);
        this.clients.set(ws, { playerId, player });

        console.log(` Player ${playerId} connected (${this.players.size} total players)`);

        // Send player their ID and initial game state
        this.sendToClient(ws, 'playerAssigned', { playerId });
        this.sendInitialState(ws);
        
        // Mark mesh for update since a new player joined
        this.meshNeedsUpdate = true;
        // Don't mark as initialized yet - they need the initial full mesh

        return { playerId, player };
    }

    /**
     * Removes a player when they disconnect
     */
    removePlayer(ws) {
        const clientData = this.clients.get(ws);
        if (clientData) {
            const { playerId } = clientData;
            this.players.delete(playerId);
            this.clients.delete(ws);
            this.clientsInitialized.delete(playerId); // Clean up initialization tracking
            console.log(` Player ${playerId} disconnected (${this.players.size} total players)`);
            
            // Mark mesh for update since a player left
            this.meshNeedsUpdate = true;
        }
    }

    /**
     * Handles incoming messages from clients
     */
    handleClientMessage(ws, message) {
        try {
            const { type, data } = JSON.parse(message);
            const clientData = this.clients.get(ws);

            // Allow initial connection without client data
            if (!clientData && type !== 'requestInitialState') {
                console.warn('Message from unregistered client');
                return;
            }

            switch (type) {
                case 'requestInitialState':
                    if (!clientData) {
                        this.addPlayer(ws);
                    } else {
                        this.sendInitialState(ws);
                    }
                    break;

                case 'input':
                    this.handleInput(clientData.player, data);
                    break;

                case 'inputState':
                    this.handleInputState(clientData.player, data);
                    break;

                case 'ping':
                    this.sendToClient(ws, 'pong', { id: data.id });
                    break;
            }
        } catch (e) {
            console.error('Error handling client message:', e);
        }
    }

    /**
     * Handles individual input actions (jumps, shoots, camera)
     */
    handleInput(player, data) {
        switch (data.type) {
            case 'keydown':
                if (data.key === ' ') {
                    player.jump();
                }
                break;

            case 'camera':
                player.updateCamera(data.yaw, data.pitch);
                break;

            case 'shoot':
                this.spawnProjectile(data.cameraPos, data.cameraDir, player.id);
                break;
        }
    }

    /**
     * Handles continuous input state (movement keys)
     */
    handleInputState(player, data) {
        player.updateKeys(data.keys);
    }

    /**
     * Creates a new projectile when a player shoots
     */
    spawnProjectile(pos, dir, throwerId = null) {
        // Update debug stats
        this.debugInfo.totalShots++;
        this.debugInfo.lastShot = new Date().toLocaleTimeString();

        // Spawn projectile slightly in front of the camera
        const offset = 2.0;
        const spawnPos = [
            pos[0] + dir[0] * offset,
            pos[1] + dir[1] * offset,
            pos[2] + dir[2] * offset
        ];

        const projectile = new MovingVoxel(spawnPos, dir, true, throwerId);
        this.movingVoxels.push(projectile);

        console.log(` Projectile spawned by ${throwerId || 'unknown'}! ID: ${projectile.id}, Total: ${this.movingVoxels.length}`);
    }

    /**
     * Starts the main physics simulation loop
     */
    startPhysicsLoop() {
        const update = () => {
            const frameStartTime = performance.now();
            const currentTime = Date.now() / 1000;
            const dt = currentTime - this.lastUpdate;
            this.lastUpdate = currentTime;

            // Run physics simulation
            const physicsStartTime = performance.now();
            this.updatePhysics(dt);
            const physicsTime = performance.now() - physicsStartTime;

            // Send updates to all clients
            const updateStartTime = performance.now();
            this.sendUpdates();
            const updateTime = performance.now() - updateStartTime;

            // Performance logging
            const totalFrameTime = performance.now() - frameStartTime;
            this.logPerformance(totalFrameTime, physicsTime, updateTime);

            // Schedule next update
            setTimeout(update, 1000 / SERVER_TICK_RATE);
        };
        
        update();
        console.log(` Multiplayer physics loop started at ${SERVER_TICK_RATE}Hz`);
    }

    /**
     * Updates all physics simulation
     */
    updatePhysics(dt) {
        const startTime = performance.now();
        let anyChanges = false;

        // Update player physics
        const playerStartTime = performance.now();
        for (const [playerId, player] of this.players.entries()) {
            const moved = player.updatePhysics(dt, this);
            if (moved) anyChanges = true;
        }
        const playerTime = performance.now() - playerStartTime;

        // Update moving voxel physics
        const voxelStartTime = performance.now();
        this.updateMovingVoxels(dt);
        const voxelTime = performance.now() - voxelStartTime;

        // Rebuild terrain if needed
        const terrainStartTime = performance.now();
        if (this.world.terrainNeedsRebuild) {
            this.world.rebuildHeightMap();
            anyChanges = true;
        }
        const terrainTime = performance.now() - terrainStartTime;

        // Update debug info
        this.updateDebugInfo();

        // Log performance occasionally
        const totalTime = performance.now() - startTime;
        this.logPhysicsPerformance(totalTime, playerTime, voxelTime, terrainTime);

        // Broadcast debug info if anything changed
        if (anyChanges) {
            this.broadcastToClients('debugUpdate', this.debugInfo);
        }
    }

    /**
     * Updates all moving voxels (projectiles and debris)
     */
    updateMovingVoxels(dt) {
        for (let i = this.movingVoxels.length - 1; i >= 0; i--) {
            const voxel = this.movingVoxels[i];
            const result = voxel.update(dt, this.movingVoxels, this);

            if (result === 'settled') {
                console.log(` Voxel settled and removed! ID: ${voxel.id}, Remaining: ${this.movingVoxels.length - 1}`);
                this.movingVoxels.splice(i, 1);
            } else if (result === 'kill_projectile') {
                console.log(` Voxel killed by player collision! ID: ${voxel.id}, Remaining: ${this.movingVoxels.length - 1}`);
                this.movingVoxels.splice(i, 1);
            }
        }
    }

    /**
     * Updates debug information
     */
    updateDebugInfo() {
        this.debugInfo.activeVoxels = this.movingVoxels.length;
        this.debugInfo.totalPlayers = this.players.size;
        this.debugInfo.playerVoxels = Array.from(this.players.values())
            .reduce((sum, player) => sum + player.bodyVoxels.length, 0);
    }

    /**
     * Sends the complete initial game state to a client
     */
    sendInitialState(ws) {
        const clientData = this.clients.get(ws);
        const excludePlayerId = clientData ? clientData.playerId : null;
        
        // Generate mesh excluding this player's body
        const meshData = this.meshGenerator.generateMeshForClient(
            this.world, this.players, excludePlayerId
        );

        // Get all moving voxels
        const allVoxels = this.movingVoxels.map(v => ({
            pos: [...v.pos],
            isProjectile: v.isProjectile,
            isPlayerVoxel: v.isPlayerVoxel || false,
            playerId: v.playerId || null,
            id: v.id
        }));

        // Send rendering data
        this.sendToClient(ws, 'renderUpdate', {
            ...meshData,
            allVoxels: allVoxels
        });

        // Send player positions
        const playersData = {};
        for (const [playerId, player] of this.players.entries()) {
            playersData[playerId] = player.getPositionData();
        }
        this.sendToClient(ws, 'playersUpdate', { players: playersData });

        // Send camera position
        if (clientData) {
            this.sendToClient(ws, 'cameraUpdate', { pos: clientData.player.centerPos });
        }

        // Send debug info
        this.sendToClient(ws, 'debugUpdate', this.debugInfo);

        console.log(` Sent initial state to ${excludePlayerId}: ${meshData.vertices.length/3} vertices (EXCLUDED OWN PLAYER)`);
    }

    /**
     * Sends updates to all connected clients
     */
    sendUpdates() {
        if (this.clients.size === 0) return;

        const startTime = performance.now();
        let meshTime = 0;

        // Prepare moving voxel data
        const allVoxels = this.movingVoxels.map(v => ({
            pos: [...v.pos],
            isProjectile: v.isProjectile,
            isPlayerVoxel: v.isPlayerVoxel || false,
            playerId: v.playerId || null,
            id: v.id
        }));

        // Smart batching: group mesh updates and reduce debris spam
        const currentTime = Date.now();
        this.processSmartMeshUpdates(allVoxels, currentTime);

        // Always send moving voxels updates (projectiles, debris)
        if (allVoxels.length > 0) {
            console.log(` Sending ${allVoxels.length} moving voxels to clients`);
            this.broadcastToClients('voxelsUpdate', { allVoxels: allVoxels });
        }

        // Always send player positions to everyone
        const playersData = {};
        for (const [playerId, player] of this.players.entries()) {
            playersData[playerId] = player.getPositionData();
        }
        this.broadcastToClients('playersUpdate', { players: playersData });

        // Send individual camera updates
        for (const [ws, clientData] of this.clients.entries()) {
            this.sendToClient(ws, 'cameraUpdate', { pos: clientData.player.centerPos });
        }

        // Log performance
        const totalTime = performance.now() - startTime;
        this.logSendPerformance(totalTime, meshTime, allVoxels.length);
    }

    /**
     * Sends a message to a specific client
     */
    sendToClient(ws, type, data) {
        if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
        }
    }

    /**
     * Broadcasts a message to all connected clients
     */
    broadcastToClients(type, data) {
        const message = JSON.stringify({ type, data, timestamp: Date.now() });
        for (const [ws, clientData] of this.clients.entries()) {
            if (ws.readyState === 1) { // WebSocket.OPEN
                ws.send(message);
            }
        }
    }

    /**
     * World access methods for other systems
     */
    getWorld(x, y, z) {
        return this.world.getWorld(x, y, z);
    }

    setWorld(x, y, z, value) {
        const result = this.world.setWorld(x, y, z, value);
        if (result) {
            // Terrain changed, need to update mesh
            this.meshNeedsUpdate = true;
            
            // Mark chunk as dirty for chunked mesh system
            if (this.useChunkedMesh) {
                this.chunkedMeshGenerator.markPositionDirty(x, z);
            }
        }
        return result;
    }

    getHeight(x, z) {
        return this.world.getHeight(x, z);
    }

    /**
     * Performance logging methods
     */
    logPerformance(totalFrameTime, physicsTime, updateTime) {
        this.totalFrameCount = (this.totalFrameCount || 0) + 1;
        
        if (this.totalFrameCount % DEBUG.LOG_FRAME_TIMING === 0) {
            console.log(` Frame timing: Total=${totalFrameTime.toFixed(2)}ms, Physics=${physicsTime.toFixed(2)}ms, Updates=${updateTime.toFixed(2)}ms, Clients=${this.clients.size}, PlayerVoxels=${this.debugInfo.playerVoxels}, MovingVoxels=${this.debugInfo.activeVoxels}`);
        }
    }

    logPhysicsPerformance(totalTime, playerTime, voxelTime, terrainTime) {
        this.frameCount = (this.frameCount || 0) + 1;
        
        if (this.frameCount % DEBUG.LOG_FRAME_TIMING === 0) {
            console.log(` Physics timing: Total=${totalTime.toFixed(2)}ms, Players=${playerTime.toFixed(2)}ms, Voxels=${voxelTime.toFixed(2)}ms, Terrain=${terrainTime.toFixed(2)}ms, PlayerVoxels=${this.debugInfo.playerVoxels}`);
        }
    }

    logSendPerformance(totalTime, meshTime, voxelCount) {
        this.sendFrameCount = (this.sendFrameCount || 0) + 1;
        
        if (this.sendFrameCount % DEBUG.LOG_FRAME_TIMING === 0) {
            console.log(` Send timing: Total=${totalTime.toFixed(2)}ms, IndividualMesh=${meshTime.toFixed(2)}ms, PlayerVoxels=${this.debugInfo.playerVoxels}, MovingVoxels=${voxelCount}`);
        }
    }

    /**
     * Smart mesh update processing with improved batching
     */
    processSmartMeshUpdates(allVoxels, currentTime) {
        const timeSinceLastUpdate = currentTime - this.lastMeshUpdate;
        const playerCountChanged = this.players.size !== this.lastPlayerCount;
        const hasActiveDebris = allVoxels.some(v => !v.isProjectile);
        
        // Always send updates for player changes (join/leave)
        if (playerCountChanged) {
            console.log(`Player count changed: ${this.lastPlayerCount} -> ${this.players.size}, sending immediate mesh update`);
            this.sendMeshUpdatesAsync(allVoxels);
            this.meshNeedsUpdate = false;
            this.lastPlayerCount = this.players.size;
            this.lastMeshUpdate = currentTime;
            this.debrisUpdateCount = 0;
            return;
        }
        
        // Handle terrain changes (shooting, etc.)
        if (this.meshNeedsUpdate) {
            const shouldUpdate = this.shouldSendMeshUpdate(timeSinceLastUpdate, hasActiveDebris);
            
            if (shouldUpdate) {
                const reason = this.getUpdateReason(timeSinceLastUpdate, hasActiveDebris);
                console.log(` Sending mesh update: ${reason} (debris updates: ${this.debrisUpdateCount}/${MAX_DEBRIS_UPDATES})`);
                
                this.sendMeshUpdatesAsync(allVoxels);
                this.meshNeedsUpdate = false;
                this.lastMeshUpdate = currentTime;
                
                if (hasActiveDebris) {
                    this.debrisUpdateCount++;
                    this.lastDebrisUpdate = currentTime;
                    this.scheduleDebrisSettleUpdate(allVoxels);
                }
            }
        }
    }
    
    /**
     * Determines if a mesh update should be sent based on timing and debris state
     */
    shouldSendMeshUpdate(timeSinceLastUpdate, hasActiveDebris) {
        // Always respect minimum interval
        if (timeSinceLastUpdate < MESH_UPDATE_INTERVAL) {
            return false;
        }
        
        // If no active debris, send update
        if (!hasActiveDebris) {
            return true;
        }
        
        // Limit debris-triggered updates
        if (this.debrisUpdateCount >= MAX_DEBRIS_UPDATES) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Gets a human-readable reason for the mesh update
     */
    getUpdateReason(timeSinceLastUpdate, hasActiveDebris) {
        if (!hasActiveDebris) {
            return `terrain change, no debris (${timeSinceLastUpdate}ms since last)`;
        }
        
        if (this.debrisUpdateCount < MAX_DEBRIS_UPDATES) {
            return `terrain change with active debris (${timeSinceLastUpdate}ms since last)`;
        }
        
        return `forced update after debris settle time (${timeSinceLastUpdate}ms since last)`;
    }
    
    /**
     * Schedules a final update when debris settles
     */
    scheduleDebrisSettleUpdate(allVoxels) {
        // Clear existing timer
        if (this.debrisSettleTimer) {
            clearTimeout(this.debrisSettleTimer);
        }
        
        // Schedule final update when debris should be settled
        this.debrisSettleTimer = setTimeout(() => {
            const currentTime = Date.now();
            console.log(` Debris settle timer fired, sending final mesh update (${DEBRIS_SETTLE_TIME}ms after last debris activity)`);
            
            // Get current moving voxels
            const currentVoxels = this.movingVoxels.map(v => ({
                pos: v.pos,
                vel: v.vel,
                alpha: v.alpha || 1.0,
                isProjectile: v.isProjectile,
                playerId: v.playerId || null,
                id: v.id
            }));
            
            this.sendMeshUpdatesAsync(currentVoxels);
            this.meshNeedsUpdate = false;
            this.lastMeshUpdate = currentTime;
            this.debrisUpdateCount = 0;
            this.debrisSettleTimer = null;
        }, DEBRIS_SETTLE_TIME);
    }

    /**
     * Sends mesh updates to all clients asynchronously (parallel, non-blocking)
     */
    sendMeshUpdatesAsync(allVoxels) {
        console.log(` Sending batched mesh update to ${this.clients.size} clients`);
        
        // Send each client's mesh update in parallel using setImmediate
        for (const [ws, clientData] of this.clients.entries()) {
            setImmediate(() => {
                try {
                    const meshStartTime = performance.now();
                    
                    // Use chunked mesh generator for better performance
                    // Use delta mode for subsequent updates, full mode for initial/player changes
                    const isInitialMesh = !this.clientsInitialized.has(clientData.playerId);
                    const useDeltaMode = this.useChunkedMesh && !isInitialMesh && (this.players.size === this.lastPlayerCount);
                    
                    const meshData = this.useChunkedMesh ? 
                        this.chunkedMeshGenerator.generateMeshForClient(this.world, this.players, clientData.playerId, useDeltaMode) :
                        this.meshGenerator.generateMeshForClient(this.world, this.players, clientData.playerId);
                        
                    // Mark client as initialized after first mesh
                    if (isInitialMesh) {
                        this.clientsInitialized.add(clientData.playerId);
                    }
                        
                    const meshTime = performance.now() - meshStartTime;
                    
                    // Choose message type based on whether this is a delta update
                    const isDeltaUpdate = useDeltaMode && meshData.deltaChunks && meshData.deltaChunks.length > 0;
                    const messageType = isDeltaUpdate ? 'chunkUpdate' : 'meshUpdate';
                    
                    // Send mesh update without blocking other updates
                    this.sendToClient(ws, messageType, { ...meshData, allVoxels: allVoxels });
                    
                    const chunkInfo = meshData.chunkStats ? ` (${meshData.chunkStats.dirtyChunks}/${meshData.chunkStats.totalChunks} chunks updated${meshData.chunkStats.deltaMode ? ', DELTA' : ', FULL'})` : '';
                    const updateType = isDeltaUpdate ? 'CHUNK UPDATE' : 'FULL MESH';
                    console.log(` ${updateType} sent to ${clientData.playerId}: ${meshData.vertices.length/3} vertices (${meshTime.toFixed(1)}ms)${chunkInfo}`);
                } catch (error) {
                    console.error(` Error sending mesh to ${clientData.playerId}:`, error);
                }
            });
        }
    }

    /**
     * Gets server statistics for monitoring
     */
    getServerStats() {
        return {
            connectedPlayers: this.clients.size,
            totalPlayers: this.players.size,
            movingVoxels: this.movingVoxels.length,
            playerVoxels: this.debugInfo.playerVoxels,
            worldStats: this.world.getWorldStats(),
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
        };
    }

    /**
     * Gracefully shuts down the server
     */
    shutdown() {
        console.log(' Shutting down server...');
        
        // Notify all clients
        this.broadcastToClients('serverShutdown', { 
            message: 'Server is shutting down' 
        });

        // Close all connections
        for (const [ws, clientData] of this.clients.entries()) {
            ws.close();
        }

        console.log(' Server shutdown complete');
    }
}