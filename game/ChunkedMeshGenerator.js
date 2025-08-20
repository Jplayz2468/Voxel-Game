// ChunkedMeshGenerator - Generates terrain meshes in small chunks for efficiency
// Only rebuilds chunks that actually changed, dramatically reducing mesh update time

import { WORLD_SIZE, COLORS, CHUNK_SIZE, CHUNKS_PER_AXIS } from './constants.js';

export class ChunkedMeshGenerator {
    constructor() {
        this.base = Math.floor(WORLD_SIZE / 4); // Terrain base height
        
        // Track which chunks need updating
        this.dirtyChunks = new Set();
        
        // Cache generated chunk meshes
        this.chunkMeshCache = new Map(); // chunkId -> mesh data
        this.isInitialized = false;
        
        console.log(`Chunked mesh generator initialized: ${CHUNKS_PER_AXIS}x${CHUNKS_PER_AXIS} chunks (${CHUNK_SIZE}x${CHUNK_SIZE} each)`);
    }

    /**
     * Pre-generates all chunks for initial loading
     */
    initializeAllChunks(world) {
        if (this.isInitialized) return;
        
        const startTime = performance.now();
        console.log(`Pre-generating all ${CHUNKS_PER_AXIS * CHUNKS_PER_AXIS} chunks...`);
        
        // Generate all chunks
        for (let chunkX = 0; chunkX < CHUNKS_PER_AXIS; chunkX++) {
            for (let chunkZ = 0; chunkZ < CHUNKS_PER_AXIS; chunkZ++) {
                const chunkId = `${chunkX}_${chunkZ}`;
                const chunkMesh = this.generateChunkMesh(world, chunkX, chunkZ);
                this.chunkMeshCache.set(chunkId, chunkMesh);
            }
        }
        
        this.isInitialized = true;
        const totalTime = performance.now() - startTime;
        console.log(`All chunks pre-generated in ${totalTime.toFixed(2)}ms (${(totalTime / (CHUNKS_PER_AXIS * CHUNKS_PER_AXIS)).toFixed(2)}ms per chunk)`);
    }

    /**
     * Marks a world position as dirty, requiring chunk regeneration
     * Also invalidates cached chunks to prevent reverting changes
     */
    markPositionDirty(x, z) {
        const chunkX = Math.floor(x / CHUNK_SIZE);
        const chunkZ = Math.floor(z / CHUNK_SIZE);
        
        if (chunkX >= 0 && chunkX < CHUNKS_PER_AXIS && chunkZ >= 0 && chunkZ < CHUNKS_PER_AXIS) {
            const chunkId = `${chunkX}_${chunkZ}`;
            this.dirtyChunks.add(chunkId);
            
            // IMPORTANT: Remove from cache to prevent reverting changes
            this.chunkMeshCache.delete(chunkId);
            
            // Also mark adjacent chunks as dirty if position is on edge
            // This ensures proper side face generation between chunks
            const localX = x % CHUNK_SIZE;
            const localZ = z % CHUNK_SIZE;
            
            if (localX === 0 && chunkX > 0) {
                const leftChunkId = `${chunkX - 1}_${chunkZ}`;
                this.dirtyChunks.add(leftChunkId);
                this.chunkMeshCache.delete(leftChunkId);
            }
            if (localX === CHUNK_SIZE - 1 && chunkX < CHUNKS_PER_AXIS - 1) {
                const rightChunkId = `${chunkX + 1}_${chunkZ}`;
                this.dirtyChunks.add(rightChunkId);
                this.chunkMeshCache.delete(rightChunkId);
            }
            if (localZ === 0 && chunkZ > 0) {
                const frontChunkId = `${chunkX}_${chunkZ - 1}`;
                this.dirtyChunks.add(frontChunkId);
                this.chunkMeshCache.delete(frontChunkId);
            }
            if (localZ === CHUNK_SIZE - 1 && chunkZ < CHUNKS_PER_AXIS - 1) {
                const backChunkId = `${chunkX}_${chunkZ + 1}`;
                this.dirtyChunks.add(backChunkId);
                this.chunkMeshCache.delete(backChunkId);
            }
            
            console.log(`Marked chunk ${chunkId} dirty and invalidated cache at position (${x}, ${z})`);
        }
    }

    /**
     * Generates mesh for all dirty chunks, leaving clean chunks unchanged
     * Returns either full mesh (first time) or delta chunks (subsequent updates)
     */
    generateMeshForClient(world, players, excludePlayerId, deltaMode = false) {
        const startTime = performance.now();
        
        // Ensure all chunks are initialized
        const initStartTime = performance.now();
        this.initializeAllChunks(world);
        const initTime = performance.now() - initStartTime;
        
        // Update only dirty chunks
        const updateStartTime = performance.now();
        const updatedChunkIds = this.updateDirtyChunks(world);
        const updateTime = performance.now() - updateStartTime;
        
        let meshData;
        let combineTime = 0;
        
        // In delta mode, only send changed chunks. In full mode, send everything.
        if (deltaMode && updatedChunkIds.length > 0) {
            // DELTA MODE: Send only the changed chunks
            const deltaStartTime = performance.now();
            meshData = this.generateDeltaChunks(updatedChunkIds);
            combineTime = performance.now() - deltaStartTime;
            console.log(`DELTA MODE: Sending only ${updatedChunkIds.length} updated chunks`);
        } else {
            // FULL MODE: Send the complete combined mesh
            const combineStartTime = performance.now();
            meshData = this.combineMeshes();
            combineTime = performance.now() - combineStartTime;
            console.log(`FULL MODE: Sending complete mesh with all ${this.chunkMeshCache.size} chunks`);
        }
        
        // Generate player templates (same as before)
        const playerStartTime = performance.now();
        const playerMeshes = this.generatePlayerTemplates(players, excludePlayerId);
        const playerTime = performance.now() - playerStartTime;
        
        const totalTime = performance.now() - startTime;
        
        // Detailed performance breakdown
        const updatedCount = updatedChunkIds.length;
        if (updatedCount > 0 || totalTime > 20) {
            const mode = updatedCount > 0 ? 'OPTIMIZED' : 'CACHED';
            console.log(`CHUNKED MESH PERFORMANCE BREAKDOWN (${mode}):`);
            console.log(`   Init: ${initTime.toFixed(2)}ms`);
            console.log(`   Update ${updatedCount} chunks: ${updateTime.toFixed(2)}ms`);
            console.log(`   Combine all chunks: ${combineTime.toFixed(2)}ms`);
            console.log(`   Players: ${playerTime.toFixed(2)}ms`);
            console.log(`   TOTAL: ${totalTime.toFixed(2)}ms`);
            console.log(`   Final mesh: ${meshData.vertices.length/3} vertices`);
            console.log(`   Cache usage: ${this.chunkMeshCache.size - updatedCount}/${this.chunkMeshCache.size} chunks from cache`);
        }
        
        const efficiency = this.chunkMeshCache.size > 0 ? 
            `${Math.round((this.chunkMeshCache.size - updatedCount) / this.chunkMeshCache.size * 100)}% cached` : '';
            
        const logMessage = updatedCount > 0 ? 
            `Chunked mesh: ${updatedCount} chunks regenerated, ${meshData.vertices.length/3} vertices total (${totalTime.toFixed(2)}ms) [${efficiency}]` :
            `Chunked mesh: all cached, ${meshData.vertices.length/3} vertices total (${totalTime.toFixed(2)}ms) [100% cached]`;
        console.log(logMessage);

        // For full mesh updates, also include all chunk data for client storage
        if (!deltaMode || updatedCount === 0) {
            meshData.deltaChunks = this.getAllChunksData();
        }
        
        return { 
            vertices: meshData.vertices, 
            normals: meshData.normals, 
            colors: meshData.colors, 
            indices: meshData.indices,
            playerMeshes: playerMeshes,
            deltaChunks: meshData.deltaChunks, // Include chunk data (all chunks for full updates, changed chunks for delta)
            chunkStats: {
                dirtyChunks: updatedCount,
                totalChunks: CHUNKS_PER_AXIS * CHUNKS_PER_AXIS,
                cacheSize: this.chunkMeshCache.size,
                deltaMode: deltaMode && updatedCount > 0
            }
        };
    }

    /**
     * Updates only chunks marked as dirty
     * Returns array of updated chunk IDs
     */
    updateDirtyChunks(world) {
        const updatedChunkIds = [];
        
        for (const chunkId of this.dirtyChunks) {
            const [chunkX, chunkZ] = chunkId.split('_').map(Number);
            
            console.log(`Regenerating dirty chunk ${chunkId} (was cached: ${this.chunkMeshCache.has(chunkId)})`);
            
            // Always regenerate mesh for dirty chunks (don't trust cache)
            const chunkMesh = this.generateChunkMesh(world, chunkX, chunkZ);
            
            // Update cache with fresh data
            this.chunkMeshCache.set(chunkId, chunkMesh);
            updatedChunkIds.push(chunkId);
            
            console.log(`Chunk ${chunkId} regenerated: ${chunkMesh.vertices.length/3} vertices`);
        }
        
        // Clear dirty chunks
        this.dirtyChunks.clear();
        
        return updatedChunkIds;
    }

    /**
     * Gets data for all cached chunks (for full mesh updates)
     */
    getAllChunksData() {
        const allChunks = [];
        
        for (const [chunkId, chunkMesh] of this.chunkMeshCache.entries()) {
            const [chunkX, chunkZ] = chunkId.split('_').map(Number);
            allChunks.push({
                chunkId,
                chunkX,
                chunkZ,
                vertices: chunkMesh.vertices,
                normals: chunkMesh.normals,
                colors: chunkMesh.colors,
                indices: chunkMesh.indices
            });
        }
        
        console.log(`Providing all ${allChunks.length} chunks for full update`);
        return allChunks;
    }

    /**
     * Generates mesh data for only the specified chunks (delta mode)
     */
    generateDeltaChunks(chunkIds) {
        const vertices = [], normals = [], colors = [], indices = [];
        const deltaChunks = [];
        
        for (const chunkId of chunkIds) {
            const chunkMesh = this.chunkMeshCache.get(chunkId);
            if (chunkMesh) {
                const [chunkX, chunkZ] = chunkId.split('_').map(Number);
                
                deltaChunks.push({
                    chunkId,
                    chunkX,
                    chunkZ,
                    vertices: chunkMesh.vertices,
                    normals: chunkMesh.normals,
                    colors: chunkMesh.colors,
                    indices: chunkMesh.indices
                });
                
                // Also add to combined mesh for backward compatibility
                const indexOffset = vertices.length / 3;
                vertices.push(...chunkMesh.vertices);
                normals.push(...chunkMesh.normals);
                colors.push(...chunkMesh.colors);
                
                for (const index of chunkMesh.indices) {
                    indices.push(index + indexOffset);
                }
            }
        }
        
        console.log(`Generated delta mesh: ${deltaChunks.length} chunks, ${vertices.length/3} vertices total`);
        
        return { 
            vertices, 
            normals, 
            colors, 
            indices,
            deltaChunks // Include individual chunk data
        };
    }

    /**
     * Generates mesh data for a single chunk
     */
    generateChunkMesh(world, chunkX, chunkZ) {
        const vertices = [], normals = [], colors = [], indices = [];
        
        // Calculate world bounds for this chunk
        const startX = chunkX * CHUNK_SIZE;
        const endX = Math.min(startX + CHUNK_SIZE, WORLD_SIZE);
        const startZ = chunkZ * CHUNK_SIZE;
        const endZ = Math.min(startZ + CHUNK_SIZE, WORLD_SIZE);
        
        // Generate terrain for this chunk
        for (let x = startX; x < endX; x++) {
            for (let z = startZ; z < endZ; z++) {
                const height = world.getHeight(x, z);
                if (height === 0) continue;

                const topY = this.base + height;
                const terrainColor = COLORS.TERRAIN;

                // Add top face (always visible)
                this.addFace(vertices, normals, colors, indices,
                    [x, topY, z], [x + 1, topY, z], [x + 1, topY, z + 1], [x, topY, z + 1],
                    [0, 1, 0], terrainColor);

                // Add side faces where neighboring terrain is lower
                this.addTerrainSideFaces(world, x, z, height, topY, vertices, normals, colors, indices, terrainColor);
            }
        }
        
        return { vertices, normals, colors, indices };
    }

    /**
     * Combines all cached chunk meshes into a single mesh
     */
    combineMeshes() {
        const startTime = performance.now();
        const vertices = [], normals = [], colors = [], indices = [];
        let chunksProcessed = 0;
        
        for (const chunkMesh of this.chunkMeshCache.values()) {
            const indexOffset = vertices.length / 3;
            
            // Add vertices, normals, colors
            vertices.push(...chunkMesh.vertices);
            normals.push(...chunkMesh.normals);
            colors.push(...chunkMesh.colors);
            
            // Add indices with offset
            for (const index of chunkMesh.indices) {
                indices.push(index + indexOffset);
            }
            chunksProcessed++;
        }
        
        const combineTime = performance.now() - startTime;
        
        // Log if combining is slow
        if (combineTime > 10) {
            console.log(`SLOW COMBINE: ${combineTime.toFixed(2)}ms to combine ${chunksProcessed} chunks into ${vertices.length/3} vertices`);
        }
        
        return { vertices, normals, colors, indices };
    }

    /**
     * Adds side faces for terrain where there are height differences
     * Same logic as original MeshGenerator but works within chunk bounds
     */
    addTerrainSideFaces(world, x, z, height, topY, vertices, normals, colors, indices, color) {
        const sides = [
            { dx: 1, dz: 0, norm: [1, 0, 0] },   // +X face
            { dx: -1, dz: 0, norm: [-1, 0, 0] }, // -X face
            { dx: 0, dz: 1, norm: [0, 0, 1] },   // +Z face
            { dx: 0, dz: -1, norm: [0, 0, -1] }  // -Z face
        ];

        for (const side of sides) {
            const neighborX = x + side.dx;
            const neighborZ = z + side.dz;
            const neighborHeight = (neighborX >= 0 && neighborX < WORLD_SIZE && 
                                  neighborZ >= 0 && neighborZ < WORLD_SIZE) ? 
                                  world.getHeight(neighborX, neighborZ) : 0;

            // If neighbor is lower, add a side face
            if (neighborHeight < height) {
                const neighborTopY = this.base + neighborHeight;
                
                if (side.dx === 1) { // +X face
                    this.addFace(vertices, normals, colors, indices,
                        [x + 1, neighborTopY, z], [x + 1, neighborTopY, z + 1],
                        [x + 1, topY, z + 1], [x + 1, topY, z], side.norm, color);
                } else if (side.dx === -1) { // -X face
                    this.addFace(vertices, normals, colors, indices,
                        [x, neighborTopY, z + 1], [x, neighborTopY, z],
                        [x, topY, z], [x, topY, z + 1], side.norm, color);
                } else if (side.dz === 1) { // +Z face
                    this.addFace(vertices, normals, colors, indices,
                        [x, neighborTopY, z + 1], [x + 1, neighborTopY, z + 1],
                        [x + 1, topY, z + 1], [x, topY, z + 1], side.norm, color);
                } else { // -Z face
                    this.addFace(vertices, normals, colors, indices,
                        [x + 1, neighborTopY, z], [x, neighborTopY, z],
                        [x, topY, z], [x + 1, topY, z], side.norm, color);
                }
            }
        }
    }

    /**
     * Generates player mesh templates (same as original)
     */
    generatePlayerTemplates(players, excludePlayerId) {
        const playerMeshes = [];
        
        for (const [playerId, player] of players.entries()) {
            if (playerId === excludePlayerId) {
                console.log(`EXCLUDING own player ${playerId} from template generation`);
                continue;
            }

            // Generate player mesh at origin (will be positioned by client)
            const playerMesh = this.generateGreedyPlayerMeshAtOrigin(player);
            
            if (playerMesh.vertices.length > 0) {
                playerMeshes.push({
                    playerId: playerId,
                    vertices: playerMesh.vertices,
                    normals: playerMesh.normals,
                    indices: playerMesh.indices,
                    voxelCount: player.bodyVoxels.length
                });
            }
        }
        
        return playerMeshes;
    }

    /**
     * Generates optimized player mesh (same as original MeshGenerator)
     */
    generateGreedyPlayerMeshAtOrigin(player) {
        if (player.bodyVoxels.length === 0) {
            return { vertices: [], normals: [], indices: [] };
        }

        // Calculate the center of mass of the player's voxels
        let sumX = 0, sumY = 0, sumZ = 0;
        for (const voxel of player.bodyVoxels) {
            sumX += voxel.pos[0];
            sumY += voxel.pos[1];
            sumZ += voxel.pos[2];
        }
        const centerX = sumX / player.bodyVoxels.length;
        const centerY = sumY / player.bodyVoxels.length;
        const centerZ = sumZ / player.bodyVoxels.length;
        
        const originPlayer = {
            bodyVoxels: player.bodyVoxels.map(voxel => ({
                pos: [
                    Math.floor(voxel.pos[0]) - Math.floor(centerX),
                    Math.floor(voxel.pos[1]) - Math.floor(centerY),
                    Math.floor(voxel.pos[2]) - Math.floor(centerZ)
                ]
            }))
        };
        
        // Generate mesh using existing greedy meshing logic
        const bounds = this.getPlayerBounds(originPlayer);
        const grid = this.createPlayerVoxelGrid(originPlayer, bounds);
        const mesh = this.greedyMeshPlayerGrid(grid, bounds);
        
        return mesh;
    }

    // Player mesh generation methods (copied from original MeshGenerator)
    getPlayerBounds(player) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const voxel of player.bodyVoxels) {
            const x = Math.floor(voxel.pos[0]);
            const y = Math.floor(voxel.pos[1]);
            const z = Math.floor(voxel.pos[2]);
            
            minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
        }

        return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    createPlayerVoxelGrid(player, bounds) {
        const sizeX = bounds.maxX - bounds.minX + 1;
        const sizeY = bounds.maxY - bounds.minY + 1;
        const sizeZ = bounds.maxZ - bounds.minZ + 1;
        const grid = new Array(sizeX * sizeY * sizeZ).fill(false);

        const getGridIndex = (x, y, z) => {
            const gx = x - bounds.minX;
            const gy = y - bounds.minY;
            const gz = z - bounds.minZ;
            if (gx < 0 || gx >= sizeX || gy < 0 || gy >= sizeY || gz < 0 || gz >= sizeZ) return -1;
            return gx + gy * sizeX + gz * sizeX * sizeY;
        };

        // Mark positions that have voxels
        for (const voxel of player.bodyVoxels) {
            const x = Math.floor(voxel.pos[0]);
            const y = Math.floor(voxel.pos[1]);
            const z = Math.floor(voxel.pos[2]);
            const index = getGridIndex(x, y, z);
            if (index >= 0) grid[index] = true;
        }

        return { grid, sizeX, sizeY, sizeZ, getGridIndex };
    }

    greedyMeshPlayerGrid(gridData, bounds) {
        const { grid, sizeX, sizeY, sizeZ, getGridIndex } = gridData;
        const vertices = [], normals = [], indices = [];

        // Check all six face directions
        const faces = [
            { dir: [1, 0, 0], norm: [1, 0, 0] },   // +X faces
            { dir: [-1, 0, 0], norm: [-1, 0, 0] }, // -X faces
            { dir: [0, 1, 0], norm: [0, 1, 0] },   // +Y faces
            { dir: [0, -1, 0], norm: [0, -1, 0] }, // -Y faces
            { dir: [0, 0, 1], norm: [0, 0, 1] },   // +Z faces
            { dir: [0, 0, -1], norm: [0, 0, -1] }  // -Z faces
        ];

        for (const face of faces) {
            const [dx, dy, dz] = face.dir;
            const norm = face.norm;

            // Generate faces for this direction
            for (let x = bounds.minX; x <= bounds.maxX; x++) {
                for (let y = bounds.minY; y <= bounds.maxY; y++) {
                    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
                        const currentIndex = getGridIndex(x, y, z);
                        if (currentIndex < 0 || !grid[currentIndex]) continue;

                        // Check if neighboring position in this direction is empty
                        const neighborX = x + dx;
                        const neighborY = y + dy;
                        const neighborZ = z + dz;
                        const neighborIndex = getGridIndex(neighborX, neighborY, neighborZ);
                        const hasNeighbor = (neighborIndex >= 0 && grid[neighborIndex]);

                        // If no neighbor in this direction, add a face
                        if (!hasNeighbor) {
                            this.addPlayerFace(vertices, normals, indices, x, y, z, norm);
                        }
                    }
                }
            }
        }

        return { vertices, normals, indices };
    }

    addPlayerFace(vertices, normals, indices, x, y, z, norm) {
        const [nx, ny, nz] = norm;
        let v0, v1, v2, v3;

        // Define face vertices based on normal direction
        if (nx === 1) { // +X face
            v0 = [x + 1, y, z];
            v1 = [x + 1, y, z + 1];
            v2 = [x + 1, y + 1, z + 1];
            v3 = [x + 1, y + 1, z];
        } else if (nx === -1) { // -X face
            v0 = [x, y, z + 1];
            v1 = [x, y, z];
            v2 = [x, y + 1, z];
            v3 = [x, y + 1, z + 1];
        } else if (ny === 1) { // +Y face
            v0 = [x, y + 1, z];
            v1 = [x + 1, y + 1, z];
            v2 = [x + 1, y + 1, z + 1];
            v3 = [x, y + 1, z + 1];
        } else if (ny === -1) { // -Y face
            v0 = [x, y, z + 1];
            v1 = [x + 1, y, z + 1];
            v2 = [x + 1, y, z];
            v3 = [x, y, z];
        } else if (nz === 1) { // +Z face
            v0 = [x, y, z + 1];
            v1 = [x, y + 1, z + 1];
            v2 = [x + 1, y + 1, z + 1];
            v3 = [x + 1, y, z + 1];
        } else { // -Z face
            v0 = [x + 1, y, z];
            v1 = [x + 1, y + 1, z];
            v2 = [x, y + 1, z];
            v3 = [x, y, z];
        }

        // Add vertices, normals, and indices
        const i0 = vertices.length / 3;
        [v0, v1, v2, v3].forEach(v => {
            vertices.push(v[0], v[1], v[2]);
            normals.push(nx, ny, nz);
        });

        // Add two triangles (quad = 2 triangles)
        indices.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }

    /**
     * Adds a face (quad) to the mesh
     */
    addFace(vertices, normals, colors, indices, v0, v1, v2, v3, normal, color) {
        const startIndex = vertices.length / 3;
        
        // Add vertices
        [v0, v1, v2, v3].forEach(vertex => {
            vertices.push(vertex[0], vertex[1], vertex[2]);
            normals.push(normal[0], normal[1], normal[2]);
            colors.push(color[0], color[1], color[2]);
        });

        // Add indices for two triangles (making a quad)
        indices.push(
            startIndex, startIndex + 1, startIndex + 2,     // First triangle
            startIndex, startIndex + 2, startIndex + 3      // Second triangle
        );
    }

    /**
     * Gets statistics about the chunked mesh system
     */
    getStats() {
        return {
            totalChunks: CHUNKS_PER_AXIS * CHUNKS_PER_AXIS,
            cachedChunks: this.chunkMeshCache.size,
            dirtyChunks: this.dirtyChunks.size,
            chunkSize: CHUNK_SIZE
        };
    }

    /**
     * Clears all cached chunks (for debugging)
     */
    clearCache() {
        this.chunkMeshCache.clear();
        this.dirtyChunks.clear();
        console.log('Chunk mesh cache cleared');
    }
}