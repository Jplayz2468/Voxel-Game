// WebGLRenderer class - handles all 3D graphics rendering using WebGL
// Renders terrain, players, moving voxels, and applies lighting

import { 
    createPerspectiveMatrix, 
    createLookAtMatrix, 
    normalFromMat4, 
    createIdentityMatrix, 
    createIdentityMatrix3,
    transformVec4,
    worldToScreen
} from './MathUtils.js';
import { COLORS, FIRST_PERSON_FILTER_DISTANCE } from './constants.js';

export class WebGLRenderer {
    constructor(canvas, performanceDebugger = null) {
        this.canvas = canvas;
        this.perfDebugger = performanceDebugger;
        this.setupWebGL();
        this.setupShaders();
        this.setupBuffers();
        
        // Mesh data
        this.terrainMesh = {
            vertices: [],
            normals: [],
            colors: [],
            indices: [],
            indexCount: 0,
            indexType: null
        };
        
        // Previous mesh data for delta comparison
        this.previousMesh = {
            vertices: [],
            normals: [],
            colors: [],
            indices: []
        };
        
        // Chunk-based terrain storage
        this.terrainChunks = new Map(); // chunkId -> chunk mesh data
        this.chunkBuffers = new Map(); // chunkId -> WebGL buffers for each chunk
        this.hasReceivedFullTerrain = false; // Track if we've received initial full terrain
        
        // Tracking
        this.meshUpdatesReceived = 0;
        
        // Threaded mesh processing
        this.setupMeshWorker();
        this.pendingMeshUpdates = new Map(); // Track pending mesh updates
        this.nextUpdateId = 1;
        this.workerBusyCount = 0; // Track how many updates are queued in worker
        this.maxWorkerQueue = 2; // Max updates to queue before falling back to main thread
        
        console.log('🎨 WebGL renderer initialized');
    }

    /**
     * Initializes WebGL context and settings
     */
    setupWebGL() {
        this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        // Enable extensions we need
        this.gl.getExtension('OES_element_index_uint');

        // Set up basic WebGL state
        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.clearColor(COLORS.SKY[0], COLORS.SKY[1], COLORS.SKY[2], 1.0);
    }

    /**
     * Creates and compiles shader program
     */
    setupShaders() {
        // Vertex shader - transforms vertices and passes data to fragment shader
        const vertexShaderSource = `
            attribute vec3 a_position;
            attribute vec3 a_normal;
            attribute vec3 a_color;
            
            uniform mat4 u_modelViewMatrix;
            uniform mat4 u_projectionMatrix;
            uniform mat3 u_normalMatrix;
            
            varying vec3 v_normal;
            varying vec3 v_color;
            
            void main() {
                gl_Position = u_projectionMatrix * u_modelViewMatrix * vec4(a_position, 1.0);
                v_normal = normalize(u_normalMatrix * a_normal);
                v_color = a_color;
            }
        `;

        // Fragment shader - calculates lighting and final pixel colors
        const fragmentShaderSource = `
            precision mediump float;
            
            varying vec3 v_normal;
            varying vec3 v_color;
            
            uniform vec3 u_lightDirection;
            uniform vec3 u_lightColor;
            uniform vec3 u_ambientColor;
            
            void main() {
                float lightFactor = max(dot(v_normal, u_lightDirection), 0.0);
                vec3 color = v_color * (u_ambientColor + u_lightColor * lightFactor);
                gl_FragColor = vec4(color, 1.0);
            }
        `;

        // Compile shaders and create program
        const vertexShader = this.createShader(this.gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, fragmentShaderSource);
        this.program = this.createProgram(vertexShader, fragmentShader);

        // Get attribute and uniform locations
        this.programInfo = {
            attribLocations: {
                position: this.gl.getAttribLocation(this.program, 'a_position'),
                normal: this.gl.getAttribLocation(this.program, 'a_normal'),
                color: this.gl.getAttribLocation(this.program, 'a_color'),
            },
            uniformLocations: {
                modelViewMatrix: this.gl.getUniformLocation(this.program, 'u_modelViewMatrix'),
                projectionMatrix: this.gl.getUniformLocation(this.program, 'u_projectionMatrix'),
                normalMatrix: this.gl.getUniformLocation(this.program, 'u_normalMatrix'),
                lightDirection: this.gl.getUniformLocation(this.program, 'u_lightDirection'),
                lightColor: this.gl.getUniformLocation(this.program, 'u_lightColor'),
                ambientColor: this.gl.getUniformLocation(this.program, 'u_ambientColor'),
            },
        };
    }

    /**
     * Creates WebGL buffers for storing mesh data
     */
    setupBuffers() {
        this.buffers = {
            position: this.gl.createBuffer(),
            normal: this.gl.createBuffer(),
            color: this.gl.createBuffer(),
            indices: this.gl.createBuffer()
        };
    }

    /**
     * Sets up the web worker for threaded mesh processing
     */
    setupMeshWorker() {
        try {
            this.meshWorker = new Worker('./MeshWorker.js');
            
            this.meshWorker.addEventListener('message', (event) => {
                this.handleWorkerMessage(event.data);
            });
            
            this.meshWorker.addEventListener('error', (error) => {
                console.error('❌ Mesh worker error:', error);
                this.meshWorker = null; // Fall back to main thread processing
            });
            
            console.log('🧵 Mesh worker initialized');
        } catch (error) {
            console.warn('⚠️ Failed to create mesh worker, falling back to main thread:', error);
            this.meshWorker = null;
        }
    }

    /**
     * Handles messages from the mesh worker
     */
    handleWorkerMessage(message) {
        const { type, data } = message;
        
        if (type === 'meshProcessed') {
            const { updateId, processedMesh, deltaResult, stats } = data;
            
            if (this.pendingMeshUpdates.has(updateId)) {
                const { originalMeshData, cameraPos, debugUpdateId } = this.pendingMeshUpdates.get(updateId);
                
                // Time the worker processing step (just for logging, work already done)
                this.perfDebugger?.timeStep(debugUpdateId, 'Worker Processing', () => {
                    // Record the worker time breakdown
                    console.log(`🧵 Worker breakdown: Filter=${stats.filterTime.toFixed(2)}ms, Delta=${stats.deltaTime.toFixed(2)}ms, Total=${stats.processingTime.toFixed(2)}ms`);
                });
                
                // Apply the processed mesh with delta optimization
                this.perfDebugger?.timeStep(debugUpdateId, 'Apply Worker Delta Result', () => {
                    this.applyWorkerResult(processedMesh, deltaResult, stats, debugUpdateId);
                });
                
                // Cleanup
                this.pendingMeshUpdates.delete(updateId);
                this.workerBusyCount = Math.max(0, this.workerBusyCount - 1);
                
                const deltaInfo = deltaResult ? `, ${deltaResult.vertexChanges.length} vertices changed (${(deltaResult.changeRatio * 100).toFixed(1)}%)` : '';
                console.log(`✅ Applied threaded mesh update ${updateId}: ${processedMesh.vertices.length/3} vertices (${stats.processingTime.toFixed(2)}ms worker time${deltaInfo}) (queue: ${this.workerBusyCount})`);
            }
        } else if (type === 'meshError') {
            const { updateId, error } = data;
            console.error(`❌ Mesh worker error for update ${updateId}:`, error);
            
            if (this.pendingMeshUpdates.has(updateId)) {
                const { originalMeshData, cameraPos, debugUpdateId } = this.pendingMeshUpdates.get(updateId);
                
                // Fall back to main thread processing
                console.warn('⚠️ Falling back to main thread mesh processing');
                this.processMeshOnMainThread(originalMeshData, cameraPos, debugUpdateId);
                
                this.pendingMeshUpdates.delete(updateId);
                this.workerBusyCount = Math.max(0, this.workerBusyCount - 1);
            }
        }
    }

    /**
     * Applies a processed mesh result from the worker with delta optimization
     */
    applyWorkerResult(processedMesh, deltaResult, stats, debugUpdateId = null) {
        // If we have delta results and changes are small enough, use delta update
        const changeThreshold = 0.3; // Same as main thread logic
        
        if (deltaResult && deltaResult.changeRatio <= changeThreshold) {
            // Use the pre-computed delta for efficient update
            console.log(`🔄 Using worker delta result: ${deltaResult.vertexChanges.length} vertices changed (${(deltaResult.changeRatio * 100).toFixed(1)}%)`);
            this.applyWorkerDelta(processedMesh, deltaResult);
        } else {
            // Full upload (either no delta or too many changes)
            const reason = deltaResult ? `${(deltaResult.changeRatio * 100).toFixed(1)}% changed` : 'no previous mesh';
            console.log(`📦 Using full upload: ${reason}`);
            
            this.terrainMesh = {
                vertices: processedMesh.vertices,
                normals: processedMesh.normals,
                colors: processedMesh.colors,
                indices: processedMesh.indices,
                indexCount: processedMesh.indices.length,
                indexType: processedMesh.indexType === 'UNSIGNED_INT' ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT
            };
            this.uploadTerrainMeshToGPU();
        }
        
        // Update previous mesh for next comparison
        this.previousMesh = {
            vertices: [...processedMesh.vertices],
            normals: [...processedMesh.normals],
            colors: [...processedMesh.colors],
            indices: [...processedMesh.indices]
        };
        
        // Log statistics occasionally
        if (this.meshUpdatesReceived % 60 === 0) {
            console.log(`👁️ Threaded filtering: ${stats.hiddenTriangles}/${stats.originalTriangles} triangles hidden (${stats.hiddenPercent.toFixed(1)}%) in ${stats.filterTime.toFixed(2)}ms`);
        }
        
        // Complete debugging
        this.perfDebugger?.completeTerrainUpdate(debugUpdateId);
    }

    /**
     * Applies pre-computed delta changes from worker
     */
    applyWorkerDelta(newMesh, deltaResult) {
        const gl = this.gl;
        const uploadStartTime = performance.now();
        
        // Handle vertex buffer changes
        if (deltaResult.vertexChanges.length > 0) {
            // Check if buffer needs to be resized
            if (newMesh.vertices.length > this.terrainMesh.vertices.length) {
                // Buffer needs to grow - reallocate all buffers
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(newMesh.vertices), gl.DYNAMIC_DRAW);
                
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.normal);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(newMesh.normals), gl.DYNAMIC_DRAW);
                
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(newMesh.colors), gl.DYNAMIC_DRAW);
                
                console.log(`📈 Buffers resized: ${this.terrainMesh.vertices.length} → ${newMesh.vertices.length} vertices`);
            } else {
                // Update individual vertex changes with bufferSubData
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
                for (const change of deltaResult.vertexChanges) {
                    if (!change.added) {
                        const offset = change.offset * 4; // 4 bytes per float
                        gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Float32Array(change.vertex));
                    }
                }
                
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.normal);
                for (const change of deltaResult.vertexChanges) {
                    if (!change.added) {
                        const offset = change.offset * 4;
                        gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Float32Array(change.normal));
                    }
                }
                
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
                for (const change of deltaResult.vertexChanges) {
                    if (!change.added) {
                        const offset = change.offset * 4;
                        gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Float32Array(change.color));
                    }
                }
                
                console.log(`🎯 Delta GPU update: ${deltaResult.vertexChanges.length} vertices updated with bufferSubData`);
            }
        }
        
        // Handle index buffer changes
        if (deltaResult.indicesChanged) {
            const indexArray = newMesh.indices.length > 65535 ? 
                new Uint32Array(newMesh.indices) : 
                new Uint16Array(newMesh.indices);
            
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.DYNAMIC_DRAW);
        }
        
        // Update mesh data
        this.terrainMesh = {
            vertices: newMesh.vertices,
            normals: newMesh.normals,
            colors: newMesh.colors,
            indices: newMesh.indices,
            indexCount: newMesh.indices.length,
            indexType: newMesh.indices.length > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
        };
        
        const uploadTime = performance.now() - uploadStartTime;
        console.log(`⚡ Worker delta applied: ${uploadTime.toFixed(2)}ms GPU time`);
    }

    /**
     * Legacy method - applies a processed mesh from the worker (fallback)
     */
    applyProcessedMesh(processedMesh, stats, debugUpdateId = null) {
        // Store mesh data
        this.terrainMesh.vertices = processedMesh.vertices;
        this.terrainMesh.normals = processedMesh.normals;
        this.terrainMesh.colors = processedMesh.colors;
        this.terrainMesh.indices = processedMesh.indices;
        
        // Upload to GPU (this is fast, just a buffer transfer)
        this.uploadTerrainMeshToGPU();
        
        // Log statistics occasionally
        if (this.meshUpdatesReceived % 60 === 0) {
            console.log(`👁️ Threaded filtering: ${stats.hiddenTriangles}/${stats.originalTriangles} triangles hidden (${stats.hiddenPercent.toFixed(1)}%) in ${stats.filterTime.toFixed(2)}ms`);
        }
        
        // Complete debugging
        this.perfDebugger?.completeTerrainUpdate(debugUpdateId);
    }

    /**
     * Compiles a shader from source code
     */
    createShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', this.gl.getShaderInfoLog(shader));
            this.gl.deleteShader(shader);
            throw new Error('Failed to compile shader');
        }
        
        return shader;
    }

    /**
     * Links vertex and fragment shaders into a program
     */
    createProgram(vertexShader, fragmentShader) {
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);

        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            console.error('Program link error:', this.gl.getProgramInfoLog(program));
            this.gl.deleteProgram(program);
            throw new Error('Failed to link shader program');
        }
        
        return program;
    }

    /**
     * Updates the main terrain mesh data
     * This includes terrain and other players
     */
    updateTerrainMesh(meshData, cameraPos) {
        this.meshUpdatesReceived++;
        
        // Start performance debugging
        const debugUpdateId = this.perfDebugger ? this.perfDebugger.startTerrainUpdate() : null;
        
        const startTime = performance.now();
        
        // If worker is available, not too busy, and camera position is provided, use threaded processing
        if (this.meshWorker && cameraPos && this.workerBusyCount < this.maxWorkerQueue) {
            this.perfDebugger?.timeStep(debugUpdateId, 'Worker Queue Setup', () => {
                const updateId = this.nextUpdateId++;
                
                // Store pending update for when worker completes
                this.pendingMeshUpdates.set(updateId, {
                    originalMeshData: meshData,
                    cameraPos: [...cameraPos], // Copy array
                    debugUpdateId: debugUpdateId
                });
                
                // Send to worker for processing (including previous mesh for delta comparison)
                this.meshWorker.postMessage({
                    type: 'processMesh',
                    data: {
                        updateId,
                        meshData: {
                            vertices: meshData.vertices || [],
                            normals: meshData.normals || [],
                            colors: meshData.colors || [],
                            indices: meshData.indices || []
                        },
                        previousMesh: {
                            vertices: this.previousMesh.vertices || [],
                            normals: this.previousMesh.normals || [],
                            colors: this.previousMesh.colors || [],
                            indices: this.previousMesh.indices || []
                        },
                        cameraPos: [...cameraPos] // Copy array
                    }
                });
                
                // Track that worker is busy
                this.workerBusyCount++;
                
                const queueTime = performance.now() - startTime;
                console.log(`🚀 Queued mesh update ${updateId} to worker: ${(meshData.vertices || []).length/3} vertices (${queueTime.toFixed(2)}ms queue time, ${this.workerBusyCount}/${this.maxWorkerQueue} queued)`);
            });
            
        } else {
            // Fall back to main thread processing
            const reason = !this.meshWorker ? 'no worker' : 
                         !cameraPos ? 'no camera pos' : 
                         'worker busy';
            console.log(`⚠️ Using main thread processing: ${reason} (worker queue: ${this.workerBusyCount}/${this.maxWorkerQueue})`);
            this.processMeshOnMainThread(meshData, cameraPos, debugUpdateId);
        }
    }

    /**
     * Processes mesh on main thread (fallback method)
     */
    processMeshOnMainThread(meshData, cameraPos, debugUpdateId = null) {
        const startTime = performance.now();
        
        // Store new mesh data
        const newMesh = {
            vertices: meshData.vertices || [],
            normals: meshData.normals || [],
            colors: meshData.colors || [],
            indices: meshData.indices || []
        };
        
        // Apply first-person filtering to new mesh
        let filteredMesh = newMesh;
        if (cameraPos) {
            filteredMesh = this.perfDebugger?.timeStep(debugUpdateId, 'First-Person Filtering', () => {
                return this.filterMeshForFirstPerson(newMesh, cameraPos);
            }) || this.filterMeshForFirstPerson(newMesh, cameraPos);
        }
        
        // Check if this is the first mesh or if we should do delta update
        const shouldDoDelta = this.previousMesh.vertices.length > 0 && filteredMesh.vertices.length > 0;
        
        if (shouldDoDelta) {
            // Perform delta update
            this.perfDebugger?.timeStep(debugUpdateId, 'Delta Comparison & Upload', () => {
                this.performDeltaUpdate(filteredMesh);
            });
        } else {
            // First mesh or empty mesh - do full upload
            this.perfDebugger?.timeStep(debugUpdateId, 'Full GPU Upload', () => {
                this.terrainMesh = {
                    vertices: filteredMesh.vertices,
                    normals: filteredMesh.normals,
                    colors: filteredMesh.colors,
                    indices: filteredMesh.indices,
                    indexCount: filteredMesh.indices.length,
                    indexType: filteredMesh.indices.length > 65535 ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT
                };
                this.uploadTerrainMeshToGPU();
            });
        }
        
        // Store current mesh as previous for next comparison
        this.previousMesh = {
            vertices: [...filteredMesh.vertices],
            normals: [...filteredMesh.normals],
            colors: [...filteredMesh.colors],
            indices: [...filteredMesh.indices]
        };
        
        // If this is a full mesh update, mark that we've received full terrain
        // and store chunk data if available
        if (!this.hasReceivedFullTerrain) {
            this.hasReceivedFullTerrain = true;
            
            // Store chunk data if provided (for future selective updates)
            if (meshData.deltaChunks) {
                this.terrainChunks.clear();
                for (const chunk of meshData.deltaChunks) {
                    this.terrainChunks.set(chunk.chunkId, {
                        vertices: chunk.vertices,
                        normals: chunk.normals,
                        colors: chunk.colors,
                        indices: chunk.indices,
                        chunkX: chunk.chunkX,
                        chunkZ: chunk.chunkZ
                    });
                }
                console.log(`📦 Stored ${meshData.deltaChunks.length} chunks from full mesh update`);
            }
        }
        
        const totalTime = performance.now() - startTime;
        console.log(`🎨 Updated terrain mesh (main thread): ${this.terrainMesh.vertices.length/3} vertices (${totalTime.toFixed(2)}ms)`);
        
        // Complete debugging
        this.perfDebugger?.completeTerrainUpdate(debugUpdateId);
    }

    /**
     * Updates specific terrain chunks instead of the full mesh
     * This allows for delta updates while preserving existing terrain
     */
    updateTerrainChunks(meshData, cameraPos) {
        this.meshUpdatesReceived++;
        
        // Start performance debugging
        const debugUpdateId = this.perfDebugger ? this.perfDebugger.startTerrainUpdate() : null;
        const startTime = performance.now();
        
        // If this is the first chunk update but we haven't received full terrain yet,
        // treat it as a full terrain update
        if (!this.hasReceivedFullTerrain) {
            console.log(`🔄 First terrain load: Treating chunk update as full terrain`);
            this.updateTerrainMesh(meshData, cameraPos);
            this.hasReceivedFullTerrain = true;
            
            // Store all chunks if deltaChunks data is available
            if (meshData.deltaChunks) {
                for (const chunk of meshData.deltaChunks) {
                    this.terrainChunks.set(chunk.chunkId, {
                        vertices: chunk.vertices,
                        normals: chunk.normals,
                        colors: chunk.colors,
                        indices: chunk.indices,
                        chunkX: chunk.chunkX,
                        chunkZ: chunk.chunkZ
                    });
                }
                console.log(`📦 Stored ${meshData.deltaChunks.length} initial chunks`);
            }
            
            this.perfDebugger?.completeTerrainUpdate(debugUpdateId);
            return;
        }
        
        // Handle selective chunk updates
        if (meshData.deltaChunks && meshData.deltaChunks.length > 0) {
            console.log(`🔄 Selective chunk update: ${meshData.deltaChunks.length} chunks`);
            
            // Update only the specified chunks in memory
            const chunkUpdateStartTime = performance.now();
            const updatedChunkIds = [];
            for (const chunk of meshData.deltaChunks) {
                this.terrainChunks.set(chunk.chunkId, {
                    vertices: chunk.vertices,
                    normals: chunk.normals,
                    colors: chunk.colors,
                    indices: chunk.indices,
                    chunkX: chunk.chunkX,
                    chunkZ: chunk.chunkZ
                });
                updatedChunkIds.push(chunk.chunkId);
                console.log(`📦 Updated chunk ${chunk.chunkId} (${chunk.chunkX}, ${chunk.chunkZ}): ${chunk.vertices.length/3} vertices`);
            }
            const chunkUpdateTime = performance.now() - chunkUpdateStartTime;
            
            // EFFICIENT: Update only the changed chunks instead of rebuilding everything
            console.log(`🚀 EFFICIENT CHUNK UPDATE: Only updating ${updatedChunkIds.length} changed chunks (preserving ${this.terrainChunks.size - updatedChunkIds.length} unchanged)`);
            const efficientUpdateStartTime = performance.now();
            this.updateOnlyChangedChunks(updatedChunkIds, cameraPos);
            const efficientUpdateTime = performance.now() - efficientUpdateStartTime;
            
            // Store detailed chunk update timing
            this.lastChunkUpdateTiming = {
                chunkUpdate: chunkUpdateTime,
                efficientUpdate: efficientUpdateTime,
                chunksUpdated: updatedChunkIds.length,
                totalChunks: this.terrainChunks.size
            };
        } else {
            // No delta chunks, fall back to full update
            console.log(`🔄 No delta chunks provided, falling back to full update`);
            this.updateTerrainMesh(meshData, cameraPos);
        }
        
        const totalTime = performance.now() - startTime;
        console.log(`🔄 Chunk update completed: ${totalTime.toFixed(2)}ms`);
        
        // Complete debugging
        this.perfDebugger?.completeTerrainUpdate(debugUpdateId);
    }
    
    /**
     * EFFICIENT: Updates only the changed chunks without touching unchanged ones
     * This is 10-100x faster than rebuilding everything
     */
    updateOnlyChangedChunks(updatedChunkIds, cameraPos) {
        const startTime = performance.now();
        let totalFilterTime = 0;
        let totalUploadTime = 0;
        
        // Update each changed chunk individually
        for (const chunkId of updatedChunkIds) {
            const chunk = this.terrainChunks.get(chunkId);
            if (!chunk) continue;
            
            // Apply first-person filtering to this chunk only
            const filterStartTime = performance.now();
            const filteredChunk = this.filterChunkForFirstPerson(chunk, cameraPos);
            totalFilterTime += performance.now() - filterStartTime;
            
            // Update or create GPU buffers for this chunk
            const uploadStartTime = performance.now();
            this.updateChunkBuffers(chunkId, filteredChunk);
            totalUploadTime += performance.now() - uploadStartTime;
        }
        
        const totalTime = performance.now() - startTime;
        
        // Store breakdown for debug display
        this.lastEfficientUpdateTiming = {
            total: totalTime,
            filter: totalFilterTime,
            upload: totalUploadTime,
            chunksProcessed: updatedChunkIds.length
        };
        
        console.log(`🚀 EFFICIENT UPDATE: ${updatedChunkIds.length} chunks in ${totalTime.toFixed(2)}ms (Filter=${totalFilterTime.toFixed(2)}ms, Upload=${totalUploadTime.toFixed(2)}ms)`);
    }

    /**
     * Updates only specific chunks on the GPU without rebuilding the entire mesh
     * This is much faster than rebuilding everything from scratch
     */
    updateSelectiveChunksOnGPU(updatedChunkIds, cameraPos) {
        const startTime = performance.now();
        
        if (!this.terrainChunks || this.terrainChunks.size === 0) {
            console.log(`⚠️ No terrain chunks available, falling back to full rebuild`);
            this.rebuildTerrainFromChunks(cameraPos);
            return;
        }
        
        // For now, we'll use a smart approach: if only a few chunks changed, rebuild
        // the entire mesh from chunks (fast) but skip the GPU allocation overhead.
        // In the future, we can implement true selective updates with chunk offsets.
        const numChangedChunks = updatedChunkIds.length;
        const totalChunks = this.terrainChunks.size;
        const changeRatio = numChangedChunks / totalChunks;
        
        console.log(`🔄 Selective update: ${numChangedChunks}/${totalChunks} chunks changed (${(changeRatio * 100).toFixed(1)}%)`);
        
        // If only a small portion changed, we can still benefit from the chunk system
        // by avoiding mesh generation for unchanged chunks (already done by server)
        // and just doing a fast rebuild from the stored chunk data
        this.rebuildTerrainFromChunks(cameraPos);
        
        const updateTime = performance.now() - startTime;
        console.log(`🎯 Smart chunk update: rebuilt from ${totalChunks} cached chunks (${updateTime.toFixed(2)}ms)`);
    }
    
    /**
     * Rebuilds the terrain mesh from stored chunks
     */
    rebuildTerrainFromChunks(cameraPos) {
        const startTime = performance.now();
        
        // Combine all chunks into a single mesh
        const combineStartTime = performance.now();
        const vertices = [], normals = [], colors = [], indices = [];
        let chunkCount = 0;
        
        for (const [chunkId, chunk] of this.terrainChunks.entries()) {
            const indexOffset = vertices.length / 3;
            
            // Add chunk vertices, normals, colors
            vertices.push(...chunk.vertices);
            normals.push(...chunk.normals);
            colors.push(...chunk.colors);
            
            // Add indices with offset
            for (const index of chunk.indices) {
                indices.push(index + indexOffset);
            }
            chunkCount++;
        }
        const combineTime = performance.now() - combineStartTime;
        
        // Create combined mesh data
        const combinedMesh = { vertices, normals, colors, indices };
        
        // Apply first-person filtering if camera position is available
        const filterStartTime = performance.now();
        let filteredMesh = combinedMesh;
        if (cameraPos) {
            filteredMesh = this.filterMeshForFirstPerson(combinedMesh, cameraPos);
        }
        const filterTime = performance.now() - filterStartTime;
        
        // Update the terrain mesh
        const updateStartTime = performance.now();
        this.terrainMesh = {
            vertices: filteredMesh.vertices,
            normals: filteredMesh.normals,
            colors: filteredMesh.colors,
            indices: filteredMesh.indices,
            indexCount: filteredMesh.indices.length,
            indexType: filteredMesh.indices.length > 65535 ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT
        };
        const updateTime = performance.now() - updateStartTime;
        
        // Upload to GPU
        const uploadStartTime = performance.now();
        this.uploadTerrainMeshToGPU();
        const uploadTime = performance.now() - uploadStartTime;
        
        // Store as previous mesh for delta comparison
        const copyStartTime = performance.now();
        this.previousMesh = {
            vertices: [...filteredMesh.vertices],
            normals: [...filteredMesh.normals],
            colors: [...filteredMesh.colors],
            indices: [...filteredMesh.indices]
        };
        const copyTime = performance.now() - copyStartTime;
        
        const rebuildTime = performance.now() - startTime;
        
        // Store detailed rebuild timing for debug display
        this.lastRebuildTiming = {
            total: rebuildTime,
            combine: combineTime,
            filter: filterTime,
            update: updateTime,
            upload: uploadTime,
            copy: copyTime,
            chunkCount: chunkCount,
            vertexCount: filteredMesh.vertices.length / 3
        };
        
        console.log(`🔧 Rebuilt terrain from ${chunkCount} chunks: ${filteredMesh.vertices.length/3} vertices (${rebuildTime.toFixed(2)}ms)`);
        console.log(`🔧 REBUILD BREAKDOWN: Combine=${combineTime.toFixed(2)}ms, Filter=${filterTime.toFixed(2)}ms, Update=${updateTime.toFixed(2)}ms, Upload=${uploadTime.toFixed(2)}ms, Copy=${copyTime.toFixed(2)}ms`);
    }

    /**
     * Filters a single chunk for first-person view (much faster than filtering everything)
     */
    filterChunkForFirstPerson(chunk, cameraPos) {
        if (!cameraPos || !chunk.vertices || chunk.vertices.length === 0) {
            return chunk; // Return unfiltered if no camera position or empty chunk
        }
        
        // Use the same filtering logic but only on this chunk's triangles
        const mockMesh = {
            vertices: chunk.vertices,
            normals: chunk.normals,
            colors: chunk.colors,
            indices: chunk.indices
        };
        
        const filtered = this.filterMeshForFirstPerson(mockMesh, cameraPos);
        
        return {
            vertices: filtered.vertices,
            normals: filtered.normals,
            colors: filtered.colors,
            indices: filtered.indices,
            chunkX: chunk.chunkX,
            chunkZ: chunk.chunkZ
        };
    }

    /**
     * Updates or creates GPU buffers for a single chunk
     */
    updateChunkBuffers(chunkId, filteredChunk) {
        const gl = this.gl;
        
        // Get or create buffers for this chunk
        let chunkBuffers = this.chunkBuffers.get(chunkId);
        if (!chunkBuffers) {
            chunkBuffers = {
                position: gl.createBuffer(),
                normal: gl.createBuffer(),
                color: gl.createBuffer(),
                indices: gl.createBuffer(),
                indexCount: 0,
                indexType: null
            };
            this.chunkBuffers.set(chunkId, chunkBuffers);
        }
        
        // Upload vertex data
        gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffers.position);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(filteredChunk.vertices), gl.STATIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffers.normal);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(filteredChunk.normals), gl.STATIC_DRAW);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffers.color);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(filteredChunk.colors), gl.STATIC_DRAW);
        
        // Upload index data
        const indexArray = filteredChunk.indices.length > 65535 ? 
            new Uint32Array(filteredChunk.indices) : 
            new Uint16Array(filteredChunk.indices);
        
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunkBuffers.indices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);
        
        // Store rendering info
        chunkBuffers.indexCount = filteredChunk.indices.length;
        chunkBuffers.indexType = filteredChunk.indices.length > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }

    /**
     * Creates a filtered version of the mesh for first-person view
     * Returns a new mesh object without modifying the input
     */
    filterMeshForFirstPerson(mesh, cameraPos) {
        const vertices = mesh.vertices;
        const normals = mesh.normals;
        const colors = mesh.colors;
        const indices = mesh.indices;
        
        if (!vertices || vertices.length === 0) {
            return mesh;
        }
        
        const filteredVertices = [];
        const filteredNormals = [];
        const filteredColors = [];
        const filteredIndices = [];
        
        const oldToNewVertexMap = new Map();
        let newVertexIndex = 0;
        
        // Process triangles
        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];
            
            // Get triangle vertices and colors
            const v0 = [vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]];
            const v1 = [vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]];
            const v2 = [vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]];
            const c0 = [colors[i0 * 3], colors[i0 * 3 + 1], colors[i0 * 3 + 2]];
            
            // Check if this is an orange player voxel
            const isPlayerVoxel = (c0[0] > 0.8 && c0[1] > 0.4 && c0[1] < 0.6 && c0[2] < 0.2);
            
            if (isPlayerVoxel) {
                // Calculate triangle center
                const centerX = (v0[0] + v1[0] + v2[0]) / 3;
                const centerY = (v0[1] + v1[1] + v2[1]) / 3;
                const centerZ = (v0[2] + v1[2] + v2[2]) / 3;
                
                // Check distance from camera
                const dx = centerX - cameraPos[0];
                const dy = centerY - cameraPos[1];
                const dz = centerZ - cameraPos[2];
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                
                // Skip if too close
                if (distance < FIRST_PERSON_FILTER_DISTANCE) {
                    continue;
                }
            }
            
            // Add vertices if not already added
            const vertexIndices = [i0, i1, i2];
            const newIndices = [];
            
            for (const oldIndex of vertexIndices) {
                if (!oldToNewVertexMap.has(oldIndex)) {
                    // Add new vertex
                    const vertexOffset = oldIndex * 3;
                    filteredVertices.push(
                        vertices[vertexOffset],
                        vertices[vertexOffset + 1],
                        vertices[vertexOffset + 2]
                    );
                    filteredNormals.push(
                        normals[vertexOffset],
                        normals[vertexOffset + 1],
                        normals[vertexOffset + 2]
                    );
                    filteredColors.push(
                        colors[vertexOffset],
                        colors[vertexOffset + 1],
                        colors[vertexOffset + 2]
                    );
                    
                    oldToNewVertexMap.set(oldIndex, newVertexIndex);
                    newIndices.push(newVertexIndex);
                    newVertexIndex++;
                } else {
                    newIndices.push(oldToNewVertexMap.get(oldIndex));
                }
            }
            
            // Add triangle indices
            filteredIndices.push(newIndices[0], newIndices[1], newIndices[2]);
        }
        
        return {
            vertices: filteredVertices,
            normals: filteredNormals,
            colors: filteredColors,
            indices: filteredIndices
        };
    }

    /**
     * Performs a delta update between previous and new mesh
     */
    performDeltaUpdate(newMesh) {
        const deltaStartTime = performance.now();
        
        // Find differences between meshes
        const delta = this.computeMeshDelta(this.previousMesh, newMesh);
        
        const comparisonTime = performance.now() - deltaStartTime;
        
        // If changes are too extensive, do a full update
        const changeThreshold = 0.3; // If >30% of data changed, do full update
        const totalVertices = Math.max(this.previousMesh.vertices.length, newMesh.vertices.length);
        const changedVertices = delta.vertexChanges.length;
        const changeRatio = changedVertices / (totalVertices / 3);
        
        if (changeRatio > changeThreshold) {
            console.log(`📊 Delta update: ${(changeRatio * 100).toFixed(1)}% changed, using full update`);
            this.terrainMesh = {
                vertices: newMesh.vertices,
                normals: newMesh.normals,
                colors: newMesh.colors,
                indices: newMesh.indices,
                indexCount: newMesh.indices.length,
                indexType: newMesh.indices.length > 65535 ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT
            };
            this.uploadTerrainMeshToGPU();
            return;
        }
        
        // Apply delta changes
        const updateStartTime = performance.now();
        this.applyMeshDelta(delta, newMesh);
        const updateTime = performance.now() - updateStartTime;
        
        const totalDeltaTime = performance.now() - deltaStartTime;
        
        console.log(`🔄 Delta update: ${changedVertices} vertices changed (${(changeRatio * 100).toFixed(1)}%), Comparison=${comparisonTime.toFixed(2)}ms, Upload=${updateTime.toFixed(2)}ms, Total=${totalDeltaTime.toFixed(2)}ms`);
    }

    /**
     * Computes differences between two meshes
     */
    computeMeshDelta(oldMesh, newMesh) {
        const vertexChanges = [];
        const indexChanges = [];
        
        // Compare vertices (and associated normals/colors)
        const minVertexCount = Math.min(oldMesh.vertices.length, newMesh.vertices.length);
        const maxVertexCount = Math.max(oldMesh.vertices.length, newMesh.vertices.length);
        
        // Check existing vertices for changes
        for (let i = 0; i < minVertexCount; i += 3) {
            const oldVertex = [oldMesh.vertices[i], oldMesh.vertices[i + 1], oldMesh.vertices[i + 2]];
            const newVertex = [newMesh.vertices[i], newMesh.vertices[i + 1], newMesh.vertices[i + 2]];
            const oldNormal = [oldMesh.normals[i], oldMesh.normals[i + 1], oldMesh.normals[i + 2]];
            const newNormal = [newMesh.normals[i], newMesh.normals[i + 1], newMesh.normals[i + 2]];
            const oldColor = [oldMesh.colors[i], oldMesh.colors[i + 1], oldMesh.colors[i + 2]];
            const newColor = [newMesh.colors[i], newMesh.colors[i + 1], newMesh.colors[i + 2]];
            
            // Check if vertex, normal, or color changed
            const vertexChanged = !this.arraysEqual(oldVertex, newVertex);
            const normalChanged = !this.arraysEqual(oldNormal, newNormal);
            const colorChanged = !this.arraysEqual(oldColor, newColor);
            
            if (vertexChanged || normalChanged || colorChanged) {
                vertexChanges.push({
                    index: i / 3,
                    offset: i,
                    vertex: newVertex,
                    normal: newNormal,
                    color: newColor
                });
            }
        }
        
        // Handle size changes (vertices added or removed)
        if (newMesh.vertices.length > oldMesh.vertices.length) {
            // Vertices added
            for (let i = minVertexCount; i < newMesh.vertices.length; i += 3) {
                vertexChanges.push({
                    index: i / 3,
                    offset: i,
                    vertex: [newMesh.vertices[i], newMesh.vertices[i + 1], newMesh.vertices[i + 2]],
                    normal: [newMesh.normals[i], newMesh.normals[i + 1], newMesh.normals[i + 2]],
                    color: [newMesh.colors[i], newMesh.colors[i + 1], newMesh.colors[i + 2]],
                    added: true
                });
            }
        }
        
        // Check if indices changed
        const indicesChanged = !this.arraysEqual(oldMesh.indices, newMesh.indices);
        
        return {
            vertexChanges,
            indicesChanged,
            newSize: {
                vertices: newMesh.vertices.length,
                indices: newMesh.indices.length
            }
        };
    }

    /**
     * Applies delta changes to GPU buffers
     */
    applyMeshDelta(delta, newMesh) {
        const gl = this.gl;
        
        // Handle vertex buffer changes
        if (delta.vertexChanges.length > 0) {
            // Bind vertex buffer
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
            
            // Check if buffer needs to be resized
            if (newMesh.vertices.length > this.terrainMesh.vertices.length) {
                // Buffer needs to grow - reallocate
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(newMesh.vertices), gl.DYNAMIC_DRAW);
                console.log(`📈 Vertex buffer resized: ${this.terrainMesh.vertices.length} → ${newMesh.vertices.length}`);
            } else {
                // Update individual vertex changes
                for (const change of delta.vertexChanges) {
                    if (!change.added) {
                        const offset = change.offset * 4; // 4 bytes per float
                        gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Float32Array(change.vertex));
                    }
                }
            }
            
            // Update normals buffer
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.normal);
            if (newMesh.normals.length > this.terrainMesh.normals.length) {
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(newMesh.normals), gl.DYNAMIC_DRAW);
            } else {
                for (const change of delta.vertexChanges) {
                    if (!change.added) {
                        const offset = change.offset * 4;
                        gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Float32Array(change.normal));
                    }
                }
            }
            
            // Update colors buffer
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
            if (newMesh.colors.length > this.terrainMesh.colors.length) {
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(newMesh.colors), gl.DYNAMIC_DRAW);
            } else {
                for (const change of delta.vertexChanges) {
                    if (!change.added) {
                        const offset = change.offset * 4;
                        gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Float32Array(change.color));
                    }
                }
            }
        }
        
        // Handle index buffer changes
        if (delta.indicesChanged) {
            const indexArray = newMesh.indices.length > 65535 ? 
                new Uint32Array(newMesh.indices) : 
                new Uint16Array(newMesh.indices);
            
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.DYNAMIC_DRAW);
        }
        
        // Update mesh data
        this.terrainMesh = {
            vertices: newMesh.vertices,
            normals: newMesh.normals,
            colors: newMesh.colors,
            indices: newMesh.indices,
            indexCount: newMesh.indices.length,
            indexType: newMesh.indices.length > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
        };
    }

    /**
     * Utility function to compare arrays for equality
     */
    arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (Math.abs(a[i] - b[i]) > 0.0001) return false; // Small tolerance for floating point
        }
        return true;
    }

    /**
     * Legacy method - kept for compatibility but now unused
     * Filters out player voxels too close to the camera
     * This prevents seeing inside your own body in first-person view
     */
    filterNearbyPlayerVoxels(cameraPos) {
        const vertices = this.terrainMesh.vertices;
        const normals = this.terrainMesh.normals;
        const colors = this.terrainMesh.colors;
        const indices = this.terrainMesh.indices;
        
        if (!vertices || vertices.length === 0) return;
        
        const filteredVertices = [];
        const filteredNormals = [];
        const filteredColors = [];
        const filteredIndices = [];
        
        const oldToNewVertexMap = new Map();
        let newVertexIndex = 0;
        
        // Process triangles
        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];
            
            // Get triangle vertices and colors
            const v0 = [vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]];
            const v1 = [vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]];
            const v2 = [vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]];
            const c0 = [colors[i0 * 3], colors[i0 * 3 + 1], colors[i0 * 3 + 2]];
            
            // Check if this is an orange player voxel
            const isPlayerVoxel = (c0[0] > 0.8 && c0[1] > 0.4 && c0[1] < 0.6 && c0[2] < 0.2);
            
            if (isPlayerVoxel) {
                // Calculate triangle center
                const centerX = (v0[0] + v1[0] + v2[0]) / 3;
                const centerY = (v0[1] + v1[1] + v2[1]) / 3;
                const centerZ = (v0[2] + v1[2] + v2[2]) / 3;
                
                // Check distance from camera
                const dx = centerX - cameraPos[0];
                const dy = centerY - cameraPos[1];
                const dz = centerZ - cameraPos[2];
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                
                // Skip if too close
                if (distance < FIRST_PERSON_FILTER_DISTANCE) {
                    continue;
                }
            }
            
            // Add vertices if not already added
            const vertexIndices = [i0, i1, i2];
            const newIndices = [];
            
            for (const oldIndex of vertexIndices) {
                if (!oldToNewVertexMap.has(oldIndex)) {
                    // Add new vertex
                    const vertexOffset = oldIndex * 3;
                    filteredVertices.push(
                        vertices[vertexOffset],
                        vertices[vertexOffset + 1],
                        vertices[vertexOffset + 2]
                    );
                    filteredNormals.push(
                        normals[vertexOffset],
                        normals[vertexOffset + 1],
                        normals[vertexOffset + 2]
                    );
                    filteredColors.push(
                        colors[vertexOffset],
                        colors[vertexOffset + 1],
                        colors[vertexOffset + 2]
                    );
                    
                    oldToNewVertexMap.set(oldIndex, newVertexIndex);
                    newIndices.push(newVertexIndex);
                    newVertexIndex++;
                } else {
                    newIndices.push(oldToNewVertexMap.get(oldIndex));
                }
            }
            
            // Add triangle indices
            filteredIndices.push(newIndices[0], newIndices[1], newIndices[2]);
        }
        
        // Update mesh data
        this.terrainMesh.vertices = filteredVertices;
        this.terrainMesh.normals = filteredNormals;
        this.terrainMesh.colors = filteredColors;
        this.terrainMesh.indices = filteredIndices;
        
        // Log filtering occasionally
        if (this.meshUpdatesReceived % 60 === 0) {
            const originalTriangles = indices.length / 3;
            const filteredTriangles = filteredIndices.length / 3;
            const hiddenTriangles = originalTriangles - filteredTriangles;
            console.log(`👁️ Filtered ${hiddenTriangles}/${originalTriangles} triangles (${(hiddenTriangles/originalTriangles*100).toFixed(1)}% hidden for first-person view)`);
        }
    }

    /**
     * Uploads terrain mesh data to GPU buffers
     */
    uploadTerrainMeshToGPU() {
        const gl = this.gl;
        const startTime = performance.now();

        // Upload vertices
        const vertexStartTime = performance.now();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.terrainMesh.vertices), gl.DYNAMIC_DRAW);
        const vertexTime = performance.now() - vertexStartTime;

        // Upload normals
        const normalStartTime = performance.now();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.normal);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.terrainMesh.normals), gl.DYNAMIC_DRAW);
        const normalTime = performance.now() - normalStartTime;

        // Upload colors
        const colorStartTime = performance.now();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.terrainMesh.colors), gl.DYNAMIC_DRAW);
        const colorTime = performance.now() - colorStartTime;

        // Upload indices
        const indexStartTime = performance.now();
        const indexArray = this.terrainMesh.indices.length > 65535 ? 
            new Uint32Array(this.terrainMesh.indices) : 
            new Uint16Array(this.terrainMesh.indices);
        
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.DYNAMIC_DRAW);
        const indexTime = performance.now() - indexStartTime;
        
        this.terrainMesh.indexCount = this.terrainMesh.indices.length;
        this.terrainMesh.indexType = this.terrainMesh.indices.length > 65535 ? 
            gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

        const totalUploadTime = performance.now() - startTime;
        
        // Log detailed GPU upload timing occasionally
        if (this.meshUpdatesReceived % 30 === 0) {
            console.log(`📊 GPU Upload breakdown: Vertices=${vertexTime.toFixed(2)}ms, Normals=${normalTime.toFixed(2)}ms, Colors=${colorTime.toFixed(2)}ms, Indices=${indexTime.toFixed(2)}ms, Total=${totalUploadTime.toFixed(2)}ms`);
        }
    }

    /**
     * Main render function - draws the entire scene
     */
    render(camera, movingVoxels, enableColorMode = false, playerPositions = new Map(), playerMeshTemplates = new Map()) {
        const renderStartTime = performance.now();
        const gl = this.gl;
        
        // Clear screen
        const clearStartTime = performance.now();
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const clearTime = performance.now() - clearStartTime;
        
        // Use our shader program
        gl.useProgram(this.program);
        
        // Set up camera matrices
        const cameraStartTime = performance.now();
        const { viewMatrix, projMatrix } = this.setupCamera(camera);
        const cameraSetupTime = performance.now() - cameraStartTime;
        
        // Set up lighting
        const lightingStartTime = performance.now();
        this.setupLighting();
        const lightingTime = performance.now() - lightingStartTime;
        
        // Render terrain
        const terrainStartTime = performance.now();
        this.renderTerrainMesh();
        const terrainTime = performance.now() - terrainStartTime;
        
        // Render players using position data and templates
        const playersStartTime = performance.now();
        this.renderPlayers(playerPositions, playerMeshTemplates, viewMatrix, projMatrix);
        const playersTime = performance.now() - playersStartTime;
        
        // Render moving voxels
        const voxelsStartTime = performance.now();
        this.renderMovingVoxels(movingVoxels, viewMatrix, projMatrix, enableColorMode);
        const voxelsTime = performance.now() - voxelsStartTime;
        
        const totalRenderTime = performance.now() - renderStartTime;
        
        // Store detailed render timing
        this.lastRenderTiming = {
            total: totalRenderTime,
            clear: clearTime,
            cameraSetup: cameraSetupTime,
            lighting: lightingTime,
            terrain: terrainTime,
            players: playersTime,
            movingVoxels: voxelsTime,
            movingVoxelCount: movingVoxels.length
        };
        
        return { viewMatrix, projMatrix, renderTiming: this.lastRenderTiming };
    }

    /**
     * Sets up camera matrices and uniforms
     */
    setupCamera(camera) {
        // Create projection matrix
        const projMatrix = createPerspectiveMatrix(
            Math.PI / 3,  // 60 degree field of view
            this.canvas.width / this.canvas.height,
            0.1,     // Near plane
            128 * 8  // Far plane
        );

        // Create view matrix
        const cameraDir = [
            Math.cos(camera.pitch) * Math.sin(camera.yaw),
            Math.sin(camera.pitch),
            Math.cos(camera.pitch) * Math.cos(camera.yaw)
        ];
        
        const eye = [camera.smoothPos[0], camera.smoothPos[1], camera.smoothPos[2]];
        const center = [eye[0] + cameraDir[0], eye[1] + cameraDir[1], eye[2] + cameraDir[2]];
        const viewMatrix = createLookAtMatrix(eye, center, [0, 1, 0]);
        
        // Create normal matrix for lighting
        const normalMatrix = normalFromMat4(viewMatrix);

        // Upload matrices to GPU
        this.gl.uniformMatrix4fv(this.programInfo.uniformLocations.projectionMatrix, false, projMatrix);
        this.gl.uniformMatrix4fv(this.programInfo.uniformLocations.modelViewMatrix, false, viewMatrix);
        this.gl.uniformMatrix3fv(this.programInfo.uniformLocations.normalMatrix, false, normalMatrix);
        
        return { viewMatrix, projMatrix };
    }

    /**
     * Sets up lighting uniforms
     */
    setupLighting() {
        // Light direction (normalized, pointing down and forward)
        this.gl.uniform3f(this.programInfo.uniformLocations.lightDirection, 0.4, 0.8, 0.4);
        
        // Light colors
        this.gl.uniform3f(this.programInfo.uniformLocations.lightColor, 
            COLORS.LIGHT[0], COLORS.LIGHT[1], COLORS.LIGHT[2]);
        this.gl.uniform3f(this.programInfo.uniformLocations.ambientColor, 
            COLORS.AMBIENT[0], COLORS.AMBIENT[1], COLORS.AMBIENT[2]);
    }

    /**
     * Renders the main terrain mesh (terrain + other players)
     * Now uses efficient per-chunk rendering
     */
    renderTerrainMesh() {
        const gl = this.gl;
        
        // If we have chunk buffers, use efficient per-chunk rendering
        if (this.chunkBuffers.size > 0) {
            this.renderTerrainChunks();
            return;
        }
        
        // Fallback to legacy single-mesh rendering
        if (this.terrainMesh.indexCount === 0) return;

        // Bind vertex attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
        gl.enableVertexAttribArray(this.programInfo.attribLocations.position);
        gl.vertexAttribPointer(this.programInfo.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.normal);
        gl.enableVertexAttribArray(this.programInfo.attribLocations.normal);
        gl.vertexAttribPointer(this.programInfo.attribLocations.normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
        gl.enableVertexAttribArray(this.programInfo.attribLocations.color);
        gl.vertexAttribPointer(this.programInfo.attribLocations.color, 3, gl.FLOAT, false, 0, 0);

        // Draw the mesh
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
        gl.drawElements(gl.TRIANGLES, this.terrainMesh.indexCount, this.terrainMesh.indexType, 0);
    }

    /**
     * Efficient per-chunk terrain rendering
     */
    renderTerrainChunks() {
        const gl = this.gl;
        
        // Render each chunk individually
        for (const [chunkId, chunkBuffers] of this.chunkBuffers.entries()) {
            if (chunkBuffers.indexCount === 0) continue;
            
            // Bind this chunk's vertex attributes
            gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffers.position);
            gl.enableVertexAttribArray(this.programInfo.attribLocations.position);
            gl.vertexAttribPointer(this.programInfo.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffers.normal);
            gl.enableVertexAttribArray(this.programInfo.attribLocations.normal);
            gl.vertexAttribPointer(this.programInfo.attribLocations.normal, 3, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, chunkBuffers.color);
            gl.enableVertexAttribArray(this.programInfo.attribLocations.color);
            gl.vertexAttribPointer(this.programInfo.attribLocations.color, 3, gl.FLOAT, false, 0, 0);

            // Draw this chunk
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunkBuffers.indices);
            gl.drawElements(gl.TRIANGLES, chunkBuffers.indexCount, chunkBuffers.indexType, 0);
        }
    }

    /**
     * Renders player meshes using position data and templates
     */
    renderPlayers(playerPositions, playerMeshTemplates, viewMatrix, projMatrix) {
        const gl = this.gl;
        
        for (const [playerId, position] of playerPositions.entries()) {
            const template = playerMeshTemplates.get(playerId);
            if (!template || template.vertices.length === 0) continue;
            
            // Create position-transformed vertices
            const transformedVertices = new Float32Array(template.vertices.length);
            for (let i = 0; i < template.vertices.length; i += 3) {
                transformedVertices[i] = template.vertices[i] + position.pos[0];
                transformedVertices[i + 1] = template.vertices[i + 1] + position.pos[1];
                transformedVertices[i + 2] = template.vertices[i + 2] + position.pos[2];
            }
            
            // Create orange colors for player
            const colors = new Float32Array(template.vertices.length);
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = COLORS.PLAYER[0];     // R
                colors[i + 1] = COLORS.PLAYER[1]; // G
                colors[i + 2] = COLORS.PLAYER[2]; // B
            }
            
            // Render this player mesh
            this.renderVoxelMesh(transformedVertices, template.normals, colors, template.indices);
        }
    }


    /**
     * Renders moving voxels (projectiles and debris)
     */
    renderMovingVoxels(voxels, viewMatrix, projMatrix, enableColorMode) {
        if (voxels.length === 0) return;
        
        const renderStartTime = performance.now();
        console.log(`🎮 Rendering ${voxels.length} moving voxels`);

        // TEMP: Disable culling for moving voxels to test visibility
        const cullingStartTime = performance.now();
        const culledVoxels = voxels; // Skip culling entirely
        const cullingTime = performance.now() - cullingStartTime;
        
        console.log(`🔍 Culling disabled: ${culledVoxels.length}/${voxels.length} voxels will render (${cullingTime.toFixed(2)}ms)`);
        
        if (culledVoxels.length === 0) return;

        // Generate mesh for visible voxels
        const meshStartTime = performance.now();
        const { vertices, normals, colors, indices } = this.generateVoxelMesh(culledVoxels, enableColorMode);
        const meshTime = performance.now() - meshStartTime;
        
        console.log(`🏗️ Generated mesh: ${vertices.length/3} vertices, ${indices.length/3} triangles (${meshTime.toFixed(2)}ms)`);
        
        // Render the mesh
        const drawStartTime = performance.now();
        this.renderVoxelMesh(vertices, normals, colors, indices);
        const drawTime = performance.now() - drawStartTime;
        
        const totalTime = performance.now() - renderStartTime;
        console.log(`🖥️ Moving voxel render complete: Mesh=${meshTime.toFixed(2)}ms, Draw=${drawTime.toFixed(2)}ms, Total=${totalTime.toFixed(2)}ms`);
    }

    /**
     * Culls voxels that are outside the view frustum or too far away
     */
    cullVoxels(voxels, viewMatrix, projMatrix, maxDistance = 150) {
        const cameraPos = [viewMatrix[12], viewMatrix[13], viewMatrix[14]]; // Extract camera position
        const culledVoxels = [];

        for (const voxel of voxels) {
            // Distance culling
            const dx = voxel.pos[0] - cameraPos[0];
            const dy = voxel.pos[1] - cameraPos[1];
            const dz = voxel.pos[2] - cameraPos[2];
            const distanceSquared = dx*dx + dy*dy + dz*dz;
            
            if (distanceSquared > maxDistance * maxDistance) continue;

            // Frustum culling
            if (this.isVoxelInFrustum(voxel.pos, viewMatrix, projMatrix)) {
                culledVoxels.push(voxel);
            }
        }

        return culledVoxels;
    }

    /**
     * Checks if a voxel is within the camera's view frustum
     */
    isVoxelInFrustum(voxelPos, viewMatrix, projMatrix) {
        const clipPos = transformVec4(voxelPos, viewMatrix, projMatrix);

        // Behind camera
        if (clipPos[3] <= 0) return false;

        // Convert to normalized device coordinates
        const ndcX = clipPos[0] / clipPos[3];
        const ndcY = clipPos[1] / clipPos[3];
        const ndcZ = clipPos[2] / clipPos[3];

        // Check bounds with small margin
        const margin = 0.1;
        return (
            ndcX >= -1 - margin && ndcX <= 1 + margin &&
            ndcY >= -1 - margin && ndcY <= 1 + margin &&
            ndcZ >= -1 && ndcZ <= 1
        );
    }

    /**
     * Generates mesh data for a set of voxels
     */
    generateVoxelMesh(voxels, enableColorMode) {
        const vertices = [], normals = [], colors = [], indices = [];

        for (const voxel of voxels) {
            const alpha = voxel.alpha || 1.0;
            let color;

            if (enableColorMode) {
                if (voxel.isProjectile) {
                    color = COLORS.PROJECTILE; // Green
                } else {
                    color = COLORS.DEBRIS; // Yellow
                }
            } else {
                color = COLORS.TERRAIN; // Gray
            }

            const finalColor = [color[0] * alpha, color[1] * alpha, color[2] * alpha];
            this.addVoxelCube(vertices, normals, colors, indices, voxel.pos, finalColor);
        }

        return { vertices, normals, colors, indices };
    }

    /**
     * Adds a cube mesh for a single voxel
     */
    addVoxelCube(vertices, normals, colors, indices, pos, color) {
        const [x, y, z] = pos;
        const s = 0.5; // Half size

        // Define all 6 faces of the cube
        const faces = [
            { verts: [[x-s,y-s,z+s], [x+s,y-s,z+s], [x+s,y+s,z+s], [x-s,y+s,z+s]], norm: [0,0,1] },
            { verts: [[x+s,y-s,z-s], [x-s,y-s,z-s], [x-s,y+s,z-s], [x+s,y+s,z-s]], norm: [0,0,-1] },
            { verts: [[x-s,y+s,z-s], [x-s,y+s,z+s], [x+s,y+s,z+s], [x+s,y+s,z-s]], norm: [0,1,0] },
            { verts: [[x-s,y-s,z+s], [x-s,y-s,z-s], [x+s,y-s,z-s], [x+s,y-s,z+s]], norm: [0,-1,0] },
            { verts: [[x+s,y-s,z+s], [x+s,y-s,z-s], [x+s,y+s,z-s], [x+s,y+s,z+s]], norm: [1,0,0] },
            { verts: [[x-s,y-s,z-s], [x-s,y-s,z+s], [x-s,y+s,z+s], [x-s,y+s,z-s]], norm: [-1,0,0] }
        ];

        for (const face of faces) {
            this.addQuad(vertices, normals, colors, indices, 
                face.verts[0], face.verts[1], face.verts[2], face.verts[3], 
                face.norm, color);
        }
    }

    /**
     * Adds a quad (4 vertices, 2 triangles) to the mesh
     */
    addQuad(vertices, normals, colors, indices, v0, v1, v2, v3, normal, color) {
        const startIndex = vertices.length / 3;
        
        // Add vertices
        [v0, v1, v2, v3].forEach(vertex => {
            vertices.push(vertex[0], vertex[1], vertex[2]);
            normals.push(normal[0], normal[1], normal[2]);
            colors.push(color[0], color[1], color[2]);
        });

        // Add indices for two triangles
        indices.push(
            startIndex, startIndex + 1, startIndex + 2,
            startIndex, startIndex + 2, startIndex + 3
        );
    }

    /**
     * Renders a voxel mesh using temporary buffers
     */
    renderVoxelMesh(vertices, normals, colors, indices) {
        if (vertices.length === 0) return;

        const gl = this.gl;

        // Use persistent buffers to avoid create/destroy overhead
        if (!this.movingVoxelBuffers) {
            this.movingVoxelBuffers = {
                vertex: gl.createBuffer(),
                normal: gl.createBuffer(),
                color: gl.createBuffer(),
                index: gl.createBuffer()
            };
        }

        const buffers = this.movingVoxelBuffers;

        // Upload data to persistent buffers
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.vertex);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.programInfo.attribLocations.position);
        gl.vertexAttribPointer(this.programInfo.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.programInfo.attribLocations.normal);
        gl.vertexAttribPointer(this.programInfo.attribLocations.normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.programInfo.attribLocations.color);
        gl.vertexAttribPointer(this.programInfo.attribLocations.color, 3, gl.FLOAT, false, 0, 0);

        // Upload and draw indices
        const indexArray = indices.length > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
        const indexType = indices.length > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.DYNAMIC_DRAW);
        gl.drawElements(gl.TRIANGLES, indices.length, indexType, 0);
    }

    /**
     * Renders 2D dots on screen for debugging
     */
    render2DDots(voxels, viewMatrix, projMatrix, enableColorMode) {
        if (!enableColorMode) return;

        const gl = this.gl;
        gl.disable(gl.DEPTH_TEST);

        // Create orthographic projection for 2D rendering
        const orthoMatrix = new Float32Array(16);
        orthoMatrix[0] = 2 / this.canvas.width;
        orthoMatrix[5] = -2 / this.canvas.height;
        orthoMatrix[10] = -1;
        orthoMatrix[12] = -1;
        orthoMatrix[13] = 1;
        orthoMatrix[15] = 1;

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.programInfo.uniformLocations.projectionMatrix, false, orthoMatrix);
        gl.uniformMatrix4fv(this.programInfo.uniformLocations.modelViewMatrix, false, createIdentityMatrix());
        gl.uniformMatrix3fv(this.programInfo.uniformLocations.normalMatrix, false, createIdentityMatrix3());

        // Draw dots for each voxel
        for (const voxel of voxels) {
            const screenPos = worldToScreen(voxel.pos, viewMatrix, projMatrix, this.canvas.width, this.canvas.height);
            if (screenPos) {
                let color, size;
                if (voxel.isProjectile) {
                    color = 'lime';
                    size = 12;
                } else {
                    color = 'yellow';
                    size = 6;
                }

                const alpha = voxel.alpha || 1.0;
                this.draw2DDot(screenPos[0], screenPos[1], color, size * alpha);
            }
        }

        gl.enable(gl.DEPTH_TEST);
    }

    /**
     * Draws a single 2D dot on screen
     */
    draw2DDot(x, y, color, size) {
        const gl = this.gl;
        const half = size / 2;
        
        // Create quad vertices
        const dotVerts = new Float32Array([
            x - half, y - half, 0,
            x + half, y - half, 0,
            x + half, y + half, 0,
            x - half, y + half, 0
        ]);
        
        const dotNormals = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
        const dotIndices = new Uint16Array([0,1,2, 0,2,3]);

        // Create temporary buffers
        const tempBuffer = gl.createBuffer();
        const tempNormalBuffer = gl.createBuffer();
        const tempIndexBuffer = gl.createBuffer();

        try {
            // Upload vertex data
            gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, dotVerts, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(this.programInfo.attribLocations.position);
            gl.vertexAttribPointer(this.programInfo.attribLocations.position, 3, gl.FLOAT, false, 0, 0);

            // Upload normal data
            gl.bindBuffer(gl.ARRAY_BUFFER, tempNormalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, dotNormals, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(this.programInfo.attribLocations.normal);
            gl.vertexAttribPointer(this.programInfo.attribLocations.normal, 3, gl.FLOAT, false, 0, 0);

            // Set color
            gl.disableVertexAttribArray(this.programInfo.attribLocations.color);
            if (color === 'lime') gl.vertexAttrib3f(this.programInfo.attribLocations.color, 0, 1, 0);
            else if (color === 'yellow') gl.vertexAttrib3f(this.programInfo.attribLocations.color, 1, 1, 0);
            else if (color === 'cyan') gl.vertexAttrib3f(this.programInfo.attribLocations.color, 0, 1, 1);
            else if (color === 'orange') gl.vertexAttrib3f(this.programInfo.attribLocations.color, 1, 0.5, 0);
            else gl.vertexAttrib3f(this.programInfo.attribLocations.color, 1, 1, 1);

            // Draw
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tempIndexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, dotIndices, gl.DYNAMIC_DRAW);
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        } finally {
            // Clean up
            gl.deleteBuffer(tempBuffer);
            gl.deleteBuffer(tempNormalBuffer);
            gl.deleteBuffer(tempIndexBuffer);
        }
    }

    /**
     * Resizes the rendering viewport
     */
    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.gl.viewport(0, 0, width, height);
    }

    /**
     * Cleans up WebGL resources
     */
    cleanup() {
        const gl = this.gl;
        
        // Delete buffers
        Object.values(this.buffers).forEach(buffer => gl.deleteBuffer(buffer));
        
        // Delete moving voxel buffers if they exist
        if (this.movingVoxelBuffers) {
            Object.values(this.movingVoxelBuffers).forEach(buffer => gl.deleteBuffer(buffer));
        }
        
        // Delete chunk buffers if they exist
        if (this.chunkBuffers) {
            for (const chunkBuffers of this.chunkBuffers.values()) {
                gl.deleteBuffer(chunkBuffers.position);
                gl.deleteBuffer(chunkBuffers.normal);
                gl.deleteBuffer(chunkBuffers.color);
                gl.deleteBuffer(chunkBuffers.indices);
            }
        }
        
        // Delete program
        gl.deleteProgram(this.program);
        
        // Cleanup mesh worker
        if (this.meshWorker) {
            this.meshWorker.terminate();
            this.meshWorker = null;
            console.log('🧵 Mesh worker terminated');
        }
        
        console.log('🧹 WebGL renderer cleaned up');
    }
}