// VoxelClient class - main client application that coordinates all systems
// Brings together rendering, input, networking, and game logic

import { WebGLRenderer } from './WebGLRenderer.js';
import { InputHandler } from './InputHandler.js';
import { NetworkClient, InterpolationSystem } from './NetworkClient.js';
import { PerformanceDebugger } from './PerformanceDebugger.js';

export class VoxelClient {
    constructor(canvas) {
        this.canvas = canvas;
        
        // Core systems
        this.performanceDebugger = new PerformanceDebugger();
        this.renderer = new WebGLRenderer(canvas, this.performanceDebugger);
        this.networkClient = new NetworkClient();
        this.inputHandler = new InputHandler(canvas, this.networkClient, this);
        this.interpolation = new InterpolationSystem();
        
        // Game state
        this.myPlayerId = null;
        this.camera = {
            pos: [64, 80, 64],
            smoothPos: [64, 80, 64],
            yaw: 0,
            pitch: 0.3
        };
        
        // Player positions for other players
        this.playerPositions = new Map();
        this.playerMeshTemplates = new Map(); // Store player mesh templates
        
        // Debug and performance tracking
        this.debugInfo = {
            activeVoxels: 0,
            totalShots: 0,
            lastShot: 'Never',
            totalPlayers: 0,
            playerVoxels: 0
        };
        
        // Performance tracking
        this.frameCount = 0;
        this.lastFrameTime = performance.now() / 1000;
        this.lastFpsTime = this.lastFrameTime;
        this.lastFrameTiming = { total: 0 };
        this.timingFrameCount = 0;
        
        // Detailed network message timing
        this.lastNetworkTiming = {
            meshUpdate: { total: 0, meshUpdate: 0, templates: 0, voxels: 0 },
            chunkUpdate: { total: 0, chunkUpdate: 0, templates: 0, voxels: 0 },
            lastUpdateType: 'none',
            lastUpdateTime: 0
        };
        
        this.setupNetworkHandlers();
        this.setupInputHandlers();
        
        console.log('€ Voxel client initialized');
    }

    /**
     * Sets up network message handlers
     */
    setupNetworkHandlers() {
        // Player assignment
        this.networkClient.onMessage('playerAssigned', (data) => {
            this.myPlayerId = data.playerId;
            this.networkClient.setPlayerId(data.playerId);
            console.log(`¤ Assigned player ID: ${this.myPlayerId}`);
        });

        // Initial render update (terrain mesh + moving voxels) - sent once on connect
        this.networkClient.onMessage('renderUpdate', (data, timestamp) => {
            const now = performance.now();
            
            // Update terrain mesh
            this.renderer.updateTerrainMesh(data, this.camera.smoothPos);
            
            // Store player mesh templates
            this.updatePlayerMeshTemplates(data.playerMeshes || []);
            
            // Add moving voxels to interpolation system
            this.interpolation.addVoxelSnapshot(now, data.allVoxels || []);
            
            console.log(`¨ Received initial mesh: ${data.vertices.length/3} terrain vertices, ${(data.playerMeshes||[]).length} player templates, ${(data.allVoxels||[]).length} moving voxels`);
        });
        
        // Mesh updates (when players join/leave or voxels are destroyed)
        this.networkClient.onMessage('meshUpdate', (data, timestamp) => {
            const messageStartTime = performance.now();
            const now = performance.now();
            
            console.log(`¯ TERRAIN UPDATE TRIGGERED: ${data.vertices.length/3} vertices, ${(data.indices||[]).length/3} triangles`);
            
            // Update terrain mesh (this is where the lag likely occurs)
            const meshUpdateStartTime = performance.now();
            this.renderer.updateTerrainMesh(data, this.camera.smoothPos);
            const meshUpdateTime = performance.now() - meshUpdateStartTime;
            
            // Update player mesh templates
            const templateStartTime = performance.now();
            this.updatePlayerMeshTemplates(data.playerMeshes || []);
            const templateTime = performance.now() - templateStartTime;
            
            // Add moving voxels to interpolation system
            const voxelStartTime = performance.now();
            this.interpolation.addVoxelSnapshot(now, data.allVoxels || []);
            const voxelTime = performance.now() - voxelStartTime;
            
            const totalMessageTime = performance.now() - messageStartTime;
            
            console.log(`± Mesh update complete: MeshUpdate=${meshUpdateTime.toFixed(2)}ms, Templates=${templateTime.toFixed(2)}ms, Voxels=${voxelTime.toFixed(2)}ms, Total=${totalMessageTime.toFixed(2)}ms`);
            
            // Store timing for debug display
            this.lastNetworkTiming.meshUpdate = {
                total: totalMessageTime,
                meshUpdate: meshUpdateTime,
                templates: templateTime,
                voxels: voxelTime
            };
            this.lastNetworkTiming.lastUpdateType = 'meshUpdate';
            this.lastNetworkTiming.lastUpdateTime = performance.now();
            
            // Log warning if this was slow
            if (totalMessageTime > 16) { // More than one frame at 60fps
                console.warn(` SLOW TERRAIN UPDATE: ${totalMessageTime.toFixed(2)}ms (>16ms frame budget) - Check performance debugger!`);
            }
        });
        
        // Chunk updates (delta updates for specific chunks)
        this.networkClient.onMessage('chunkUpdate', (data, timestamp) => {
            const messageStartTime = performance.now();
            const now = performance.now();
            
            console.log(`„ CHUNK UPDATE TRIGGERED: ${data.deltaChunks ? data.deltaChunks.length : 0} chunks, ${data.vertices.length/3} vertices total`);
            
            // Update only the changed chunks, preserving existing terrain
            const chunkUpdateStartTime = performance.now();
            this.renderer.updateTerrainChunks(data, this.camera.smoothPos);
            const chunkUpdateTime = performance.now() - chunkUpdateStartTime;
            
            // Update player mesh templates
            const templateStartTime = performance.now();
            this.updatePlayerMeshTemplates(data.playerMeshes || []);
            const templateTime = performance.now() - templateStartTime;
            
            // Add moving voxels to interpolation system
            const voxelStartTime = performance.now();
            this.interpolation.addVoxelSnapshot(now, data.allVoxels || []);
            const voxelTime = performance.now() - voxelStartTime;
            
            const totalMessageTime = performance.now() - messageStartTime;
            
            console.log(`„ Chunk update complete: ChunkUpdate=${chunkUpdateTime.toFixed(2)}ms, Templates=${templateTime.toFixed(2)}ms, Voxels=${voxelTime.toFixed(2)}ms, Total=${totalMessageTime.toFixed(2)}ms`);
            
            // Get detailed renderer timing
            const rendererTiming = this.renderer.lastChunkUpdateTiming;
            
            // Store timing for debug display
            this.lastNetworkTiming.chunkUpdate = {
                total: totalMessageTime,
                chunkUpdate: chunkUpdateTime,
                templates: templateTime,
                voxels: voxelTime,
                rendererTiming: rendererTiming
            };
            this.lastNetworkTiming.lastUpdateType = 'chunkUpdate';
            this.lastNetworkTiming.lastUpdateTime = performance.now();
            
            // This should be much faster than full mesh updates
            if (totalMessageTime > 8) {
                console.warn(` SLOW CHUNK UPDATE: ${totalMessageTime.toFixed(2)}ms (should be <8ms)`);
            }
        });
        
        // Moving voxels updates (projectiles, debris)
        this.networkClient.onMessage('voxelsUpdate', (data, timestamp) => {
            const startTime = performance.now();
            const now = performance.now();
            
            console.log(`¥ Received ${(data.allVoxels || []).length} moving voxels`);
            
            // Add moving voxels to interpolation system
            this.interpolation.addVoxelSnapshot(now, data.allVoxels || []);
            
            const processingTime = performance.now() - startTime;
            console.log(` Voxel update processing: ${processingTime.toFixed(2)}ms`);
        });

        // Player position updates
        this.networkClient.onMessage('playersUpdate', (data) => {
            for (const [playerId, playerData] of Object.entries(data.players || {})) {
                this.playerPositions.set(playerId, {
                    pos: playerData.centerPos,
                    yaw: playerData.yaw,
                    pitch: playerData.pitch,
                    voxelCount: playerData.voxelCount
                });
            }
        });

        // Camera position updates (for my player)
        this.networkClient.onMessage('cameraUpdate', (data, timestamp) => {
            const now = performance.now();
            this.interpolation.addCameraSnapshot(now, data.pos);
        });

        // Debug information
        this.networkClient.onMessage('debugUpdate', (data) => {
            this.debugInfo = data;
            this.updateDebugDisplay();
        });

        // Pong responses for ping calculation
        this.networkClient.onMessage('pong', (data) => {
            this.networkClient.handlePong(data);
        });

        // Connection status updates
        this.networkClient.onConnectionChange((connected) => {
            this.updateConnectionStatus(connected);
        });

        // Ping updates
        this.networkClient.onPingChanged((ping) => {
            this.updatePingDisplay(ping);
        });
    }

    /**
     * Sets up input event handlers
     */
    setupInputHandlers() {
        // Settings changes from input handler
        this.inputHandler.onSettingsChanged((settings) => {
            if ('smoothMode' in settings) {
                this.interpolation.setSmoothMode(settings.smoothMode);
            }
            if ('colorMode' in settings) {
                // Color mode is handled in render loop
            }
        });
    }

    /**
     * Connects to the server
     */
    connect(serverUrl) {
        this.networkClient.connect(serverUrl);
        this.networkClient.startPingMonitoring();
    }

    /**
     * Starts the main game loop
     */
    start() {
        console.log('® Starting game loop...');
        this.gameLoop();
    }

    /**
     * Main game loop - runs every frame
     */
    gameLoop() {
        const frameStartTime = performance.now();
        const currentTime = frameStartTime / 1000;
        const dt = currentTime - this.lastFrameTime;
        this.lastFrameTime = currentTime;

        // Update input
        const inputStartTime = performance.now();
        this.inputHandler.update();
        const inputTime = performance.now() - inputStartTime;

        // Update camera from interpolation
        const cameraStartTime = performance.now();
        this.updateCamera(dt);
        const cameraTime = performance.now() - cameraStartTime;

        // Get interpolated voxels
        const voxelInterpolationStartTime = performance.now();
        const interpolatedVoxels = this.interpolation.getInterpolatedVoxels();
        const voxelInterpolationTime = performance.now() - voxelInterpolationStartTime;

        // Debug: Log when there are moving voxels
        if (interpolatedVoxels.length > 0) {
            console.log(`¯ Frame has ${interpolatedVoxels.length} moving voxels to render`);
        }

        // Render the scene
        const renderStartTime = performance.now();
        const settings = this.inputHandler.getSettings();
        const { viewMatrix, projMatrix, renderTiming } = this.renderer.render(this.camera, interpolatedVoxels, settings.colorMode, this.playerPositions, this.playerMeshTemplates);
        const renderTime = performance.now() - renderStartTime;

        // Debug: Log render performance when there are moving voxels
        if (interpolatedVoxels.length > 0) {
            console.log(`¨ Render time with ${interpolatedVoxels.length} voxels: ${renderTime.toFixed(2)}ms`);
        }

        // Render 2D dots if enabled
        const dotStartTime = performance.now();
        if (settings.colorMode) {
            this.renderer.render2DDots(interpolatedVoxels, viewMatrix, projMatrix, true);
        }
        const dotTime = performance.now() - dotStartTime;

        // Update FPS and performance stats
        const fpsStartTime = performance.now();
        this.updatePerformanceStats(currentTime);
        const fpsTime = performance.now() - fpsStartTime;

        // Store timing data
        const totalFrameTime = performance.now() - frameStartTime;
        this.lastFrameTiming = {
            total: totalFrameTime,
            input: inputTime,
            camera: cameraTime,
            voxelInterpolation: voxelInterpolationTime,
            render: renderTime,
            dots: dotTime,
            fps: fpsTime,
            voxelCount: interpolatedVoxels.length,
            renderBreakdown: renderTiming || null
        };

        // Log performance occasionally
        this.logPerformance();

        // Schedule next frame
        requestAnimationFrame(() => this.gameLoop());
    }

    /**
     * Updates camera position and orientation
     */
    updateCamera(dt) {
        // Get interpolated camera position from server
        const interpolatedPos = this.interpolation.getInterpolatedCamera();
        this.camera.pos = interpolatedPos;

        // Apply smoothing for buttery smooth movement
        const smoothing = 8.0;
        this.camera.smoothPos[0] += (interpolatedPos[0] - this.camera.smoothPos[0]) * smoothing * dt;
        this.camera.smoothPos[1] += (interpolatedPos[1] - this.camera.smoothPos[1]) * smoothing * dt;
        this.camera.smoothPos[2] += (interpolatedPos[2] - this.camera.smoothPos[2]) * smoothing * dt;

        // Get camera orientation from input handler
        const cameraState = this.inputHandler.getCameraState();
        this.camera.yaw = cameraState.yaw;
        this.camera.pitch = cameraState.pitch;
    }

    /**
     * Updates performance statistics and FPS display
     */
    updatePerformanceStats(currentTime) {
        this.frameCount++;
        
        if (currentTime - this.lastFpsTime >= 1.0) {
            const fps = this.frameCount / (currentTime - this.lastFpsTime);
            document.getElementById('info').textContent = `FPS: ${fps.toFixed(1)}`;
            this.frameCount = 0;
            this.lastFpsTime = currentTime;
        }
    }

    /**
     * Logs performance information
     */
    logPerformance() {
        this.timingFrameCount = (this.timingFrameCount || 0) + 1;
        
        if (this.timingFrameCount % 60 === 0) {
            const timing = this.lastFrameTiming;
            console.log(`¬ Client timing: Total=${timing.total.toFixed(2)}ms, Camera=${timing.camera.toFixed(2)}ms, VoxelInterp=${timing.voxelInterpolation.toFixed(2)}ms, Render=${timing.render.toFixed(2)}ms, MovingVoxels=${timing.voxelCount}`);
        }
    }

    /**
     * Updates the debug information display
     */
    updateDebugDisplay() {
        const debugDiv = document.getElementById('debug');
        if (!debugDiv) return;

        const interpolatedVoxels = this.interpolation.getInterpolatedVoxels();
        const settings = this.inputHandler.getSettings();
        const connectionStats = this.networkClient.getConnectionStats();
        const interpolationStats = this.interpolation.getStats();

        // Count different types of voxels
        const projectileCount = interpolatedVoxels.filter(v => v.isProjectile).length;
        const debrisCount = interpolatedVoxels.filter(v => !v.isProjectile).length;

        const mode = settings.smoothMode ? 'SMOOTH' : 'RAW';
        const colorMode = settings.colorMode ? 'COLORED' : 'GRAY';
        const serverStatus = connectionStats.connected ? '¢ CONNECTED' : '´ DISCONNECTED';

        // Find slowest process
        const timing = this.lastFrameTiming;
        const slowestProcess = this.findSlowestProcess(timing);

        // Network timing info
        const timeSinceLastUpdate = performance.now() - this.lastNetworkTiming.lastUpdateTime;
        const networkInfo = this.getNetworkTimingInfo(timeSinceLastUpdate);
        
        // Render breakdown info
        const renderInfo = this.getRenderBreakdownInfo(timing);

        debugDiv.innerHTML = `Server: ${this.debugInfo.playerVoxels} total player voxels (server-side), ${this.debugInfo.activeVoxels} moving, ${this.debugInfo.totalPlayers} players (50 TPS) ${serverStatus}<br>
Client: ${this.frameCount}fps ${mode} rendering (GREEDY MESHED PIPELINE)<br>
MyID: ${this.myPlayerId || 'unknown'}<br>
Players: ${this.playerPositions.size} with positions, HOLLOW ORANGE SHELLS (exterior faces only)<br>
Moving Objects: ${interpolatedVoxels.length} total (${projectileCount} projectiles, ${debrisCount} debris)<br>
Interpolation: ${interpolationStats.voxelSnapshots} voxel snapshots, ${interpolationStats.renderDelay}ms delay<br>
<span style="color: yellow;">Œ BOTTLENECK: ${slowestProcess.name} = ${slowestProcess.time.toFixed(2)}ms (${Math.round((slowestProcess.time/timing.total)*100)}% of frame)</span><br>
<span style="color: orange;">Š FRAME BREAKDOWN: Input=${timing.input.toFixed(1)}ms, Camera=${timing.camera.toFixed(1)}ms, VoxelInterp=${timing.voxelInterpolation.toFixed(1)}ms, Render=${timing.render.toFixed(1)}ms, Dots=${timing.dots.toFixed(1)}ms, FPS=${timing.fps.toFixed(1)}ms</span><br>
${renderInfo}<br>
${networkInfo}<br>
Visual: ${colorMode} mode, ${settings.colorMode ? 'dots ON' : 'dots OFF'}, first-person view<br>
Ping: ${connectionStats.ping.toFixed(0)}ms, Reconnects: ${connectionStats.reconnectAttempts}<br>
Cam: ${this.camera.smoothPos[0].toFixed(1)}, ${this.camera.smoothPos[1].toFixed(1)}, ${this.camera.smoothPos[2].toFixed(1)}<br>
<span style="color: cyan;">T: SMOOTH/RAW | C: COLORED/GRAY</span><br>
<span style="color: lime;"> GREEDY MESHED: Players are hollow shells = clean first-person view!</span>`;
    }

    /**
     * Gets formatted render breakdown information for debug display
     */
    getRenderBreakdownInfo(timing) {
        if (!timing.renderBreakdown) {
            return '<span style="color: gray;">¨ RENDER BREAKDOWN: No detailed timing available</span>';
        }
        
        const rb = timing.renderBreakdown;
        let color = 'lime';
        if (rb.total > 10) color = 'red';
        else if (rb.total > 5) color = 'yellow';
        
        return `<span style="color: ${color};">¨ RENDER BREAKDOWN: Clear=${rb.clear.toFixed(1)}ms, Camera=${rb.cameraSetup.toFixed(1)}ms, Light=${rb.lighting.toFixed(1)}ms, Terrain=${rb.terrain.toFixed(1)}ms, Players=${rb.players.toFixed(1)}ms, MovingVoxels=${rb.movingVoxels.toFixed(1)}ms (${rb.movingVoxelCount} voxels)</span>`;
    }

    /**
     * Gets formatted network timing information for debug display
     */
    getNetworkTimingInfo(timeSinceLastUpdate) {
        if (this.lastNetworkTiming.lastUpdateType === 'none') {
            return '<span style="color: gray;">¡ NETWORK: No recent terrain updates</span>';
        }
        
        const updateType = this.lastNetworkTiming.lastUpdateType;
        const timing = this.lastNetworkTiming[updateType];
        const age = timeSinceLastUpdate < 1000 ? `${timeSinceLastUpdate.toFixed(0)}ms ago` : `${(timeSinceLastUpdate/1000).toFixed(1)}s ago`;
        
        let color = 'lime';
        if (timing.total > 50) color = 'red';
        else if (timing.total > 16) color = 'yellow';
        
        if (updateType === 'meshUpdate') {
            return `<span style="color: ${color};">¡ MESH UPDATE (${age}): Total=${timing.total.toFixed(1)}ms | MeshUpdate=${timing.meshUpdate.toFixed(1)}ms, Templates=${timing.templates.toFixed(1)}ms, Voxels=${timing.voxels.toFixed(1)}ms</span>`;
        } else {
            // Show detailed chunk update breakdown
            let detailStr = `Total=${timing.total.toFixed(1)}ms | ChunkUpdate=${timing.chunkUpdate.toFixed(1)}ms, Templates=${timing.templates.toFixed(1)}ms, Voxels=${timing.voxels.toFixed(1)}ms`;
            
            if (timing.rendererTiming) {
                const rt = timing.rendererTiming;
                
                if (rt.efficientUpdate !== undefined) {
                    // New efficient chunk update system
                    detailStr += `<br><span style="color: lime;">    â†³ EFFICIENT: ChunkStore=${rt.chunkUpdate.toFixed(1)}ms, EfficientUpdate=${rt.efficientUpdate.toFixed(1)}ms (${rt.chunksUpdated}/${rt.totalChunks} chunks updated)</span>`;
                    
                    // Show efficient update breakdown if available
                    if (this.renderer.lastEfficientUpdateTiming) {
                        const et = this.renderer.lastEfficientUpdateTiming;
                        detailStr += `<br><span style="color: cyan;">      â†³ EFFICIENT BREAKDOWN: Filter=${et.filter.toFixed(1)}ms, Upload=${et.upload.toFixed(1)}ms (${et.chunksProcessed} chunks)</span>`;
                    }
                } else {
                    // Legacy rebuild system (fallback)
                    detailStr += `<br><span style="color: cyan;">    â†³ RENDERER: ChunkStore=${rt.chunkUpdate.toFixed(1)}ms, Rebuild=${rt.rebuild.toFixed(1)}ms</span>`;
                    
                    if (rt.rebuildBreakdown) {
                        const rb = rt.rebuildBreakdown;
                        detailStr += `<br><span style="color: magenta;">      â†³ REBUILD: Combine=${rb.combine.toFixed(1)}ms, Filter=${rb.filter.toFixed(1)}ms, Update=${rb.update.toFixed(1)}ms, Upload=${rb.upload.toFixed(1)}ms, Copy=${rb.copy.toFixed(1)}ms (${rb.chunkCount} chunks, ${rb.vertexCount} vertices)</span>`;
                    }
                }
            }
            
            return `<span style="color: ${color};">¡ CHUNK UPDATE (${age}): ${detailStr}</span>`;
        }
    }

    /**
     * Finds the slowest process for performance debugging
     */
    findSlowestProcess(timing) {
        const processes = [
            { name: 'Input', time: timing.input || 0 },
            { name: 'Camera', time: timing.camera || 0 },
            { name: 'VoxelInterpolation', time: timing.voxelInterpolation || 0 },
            { name: 'Render', time: timing.render || 0 },
            { name: 'Dots', time: timing.dots || 0 },
            { name: 'FPS', time: timing.fps || 0 }
        ];

        return processes.reduce((slowest, current) => 
            current.time > slowest.time ? current : slowest
        );
    }

    /**
     * Updates connection status display
     */
    updateConnectionStatus(connected) {
        const statusDiv = document.getElementById('connection-status');
        if (!statusDiv) return;

        if (connected) {
            statusDiv.innerHTML = '¢ Connected to server';
            statusDiv.style.color = 'lime';
        } else {
            statusDiv.innerHTML = '´ Disconnected from server';
            statusDiv.style.color = 'red';
        }
    }

    /**
     * Updates ping display
     */
    updatePingDisplay(ping) {
        const pingDiv = document.getElementById('ping-display');
        if (!pingDiv) return;

        const color = ping < 50 ? 'lime' : ping < 100 ? 'yellow' : 'red';
        pingDiv.innerHTML = `¡ Ping: ${ping.toFixed(0)}ms`;
        pingDiv.style.color = color;
    }

    /**
     * Gets camera position for other systems
     */
    getCameraPosition() {
        return [...this.camera.smoothPos];
    }

    /**
     * Handles window resize
     */
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.renderer.resize(window.innerWidth, window.innerHeight);
    }

    /**
     * Gets game statistics
     */
    getStats() {
        return {
            myPlayerId: this.myPlayerId,
            connectedPlayers: this.playerPositions.size,
            movingVoxels: this.interpolation.getInterpolatedVoxels().length,
            camera: this.camera,
            performance: this.lastFrameTiming,
            network: this.networkClient.getConnectionStats(),
            interpolation: this.interpolation.getStats()
        };
    }

    /**
     * Updates stored player mesh templates
     */
    updatePlayerMeshTemplates(playerMeshes) {
        // Clear existing templates
        this.playerMeshTemplates.clear();
        
        // Store new templates
        for (const playerMesh of playerMeshes) {
            this.playerMeshTemplates.set(playerMesh.playerId, {
                vertices: playerMesh.vertices,
                normals: playerMesh.normals,
                indices: playerMesh.indices,
                voxelCount: playerMesh.voxelCount
            });
        }
        
        console.log(`¾ Updated ${playerMeshes.length} player mesh templates`);
    }

    /**
     * Cleanup function
     */
    cleanup() {
        console.log('¹ Cleaning up voxel client...');
        
        this.networkClient.disconnect();
        this.renderer.cleanup();
        this.inputHandler.cleanup();
        this.interpolation.clear();
        this.performanceDebugger.cleanup();
        
        console.log(' Client cleanup complete');
    }
}