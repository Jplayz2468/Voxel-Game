// VoxelWorld class - handles world generation, terrain storage, and world management
// The world is a 3D grid of voxels that can be solid (1) or empty (0)

import { WORLD_SIZE } from './constants.js';

export class VoxelWorld {
    constructor() {
        // 3D array storing the world as a flat buffer for performance
        // 0 = empty space, 1 = solid block
        this.world = new Uint8Array(WORLD_SIZE * WORLD_SIZE * WORLD_SIZE);
        
        // Height map for quick ground collision detection
        // Stores the height of the terrain at each X,Z coordinate
        this.heights = new Int32Array(WORLD_SIZE * WORLD_SIZE);
        
        // Flag to track when terrain needs to be rebuilt for rendering
        this.terrainNeedsRebuild = false;
        
        this.generateWorld();
        
        console.log('🌍 Voxel world generated');
    }

    /**
     * Generates the initial world terrain
     * Creates a base layer with some random height variation
     */
    generateWorld() {
        const base = Math.floor(WORLD_SIZE / 4); // Start terrain at 1/4 world height
        
        // Generate terrain for each X,Z column
        for (let x = 0; x < WORLD_SIZE; x++) {
            for (let z = 0; z < WORLD_SIZE; z++) {
                // Random terrain height variation (±2 blocks)
                const terrainHeight = 16 + Math.floor((Math.random() - 0.5) * 4);
                
                // Fill column from base up to terrain height
                for (let y = base; y < base + Math.max(1, terrainHeight); y++) {
                    this.setWorld(x, y, z, 1);
                }

                // Calculate total height for this column (for height map)
                let totalHeight = 0;
                for (let y = 0; y < WORLD_SIZE; y++) {
                    if (this.getWorld(x, y, z)) {
                        totalHeight++;
                    }
                }
                this.heights[x + z * WORLD_SIZE] = totalHeight;
            }
        }
    }

    /**
     * Gets the voxel value at world coordinates
     * Returns 0 for empty space, 1 for solid block
     * Returns 0 for out-of-bounds coordinates
     */
    getWorld(x, y, z) {
        // Check bounds
        if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) {
            return 0;
        }
        
        // Convert 3D coordinates to 1D array index
        const index = x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE;
        return this.world[index];
    }

    /**
     * Sets the voxel value at world coordinates
     * Returns true if the value changed, false otherwise
     */
    setWorld(x, y, z, value) {
        // Check bounds
        if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) {
            return false;
        }
        
        // Convert 3D coordinates to 1D array index
        const index = x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE;
        const oldValue = this.world[index];
        this.world[index] = value;
        
        // Mark terrain for rebuilding if value changed
        if (oldValue !== value) {
            this.terrainNeedsRebuild = true;
            return true;
        }
        
        return false;
    }

    /**
     * Gets the terrain height at a specific X,Z coordinate
     * This is the number of solid blocks in that column
     */
    getHeight(x, z) {
        if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) {
            return 0;
        }
        return this.heights[x + z * WORLD_SIZE];
    }

    /**
     * Rebuilds the height map after terrain changes
     * This is expensive but necessary after voxels are added/removed
     */
    rebuildHeightMap() {
        for (let x = 0; x < WORLD_SIZE; x++) {
            for (let z = 0; z < WORLD_SIZE; z++) {
                let height = 0;
                
                // Count solid blocks in this column
                for (let y = 0; y < WORLD_SIZE; y++) {
                    if (this.getWorld(x, y, z)) {
                        height++;
                    }
                }
                
                this.heights[x + z * WORLD_SIZE] = height;
            }
        }
        
        this.terrainNeedsRebuild = false;
        console.log('🔄 Height map rebuilt');
    }

    /**
     * Gets the surface level (top solid block) at a given X,Z coordinate
     * Returns the Y coordinate of the highest solid block
     */
    getSurfaceLevel(x, z) {
        if (x < 0 || x >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) {
            return 0;
        }

        // Search from top down to find highest solid block
        for (let y = WORLD_SIZE - 1; y >= 0; y--) {
            if (this.getWorld(x, y, z)) {
                return y;
            }
        }
        
        return 0; // No solid blocks found
    }

    /**
     * Checks if a 3D region is completely empty
     * Useful for placing objects or checking spawn areas
     */
    isRegionEmpty(minX, minY, minZ, maxX, maxY, maxZ) {
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                for (let z = minZ; z <= maxZ; z++) {
                    if (this.getWorld(x, y, z)) {
                        return false; // Found a solid block
                    }
                }
            }
        }
        return true; // Region is empty
    }

    /**
     * Fills a 3D region with a specific value
     * Useful for creating structures or clearing areas
     */
    fillRegion(minX, minY, minZ, maxX, maxY, maxZ, value) {
        let blocksChanged = 0;
        
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                for (let z = minZ; z <= maxZ; z++) {
                    if (this.setWorld(x, y, z, value)) {
                        blocksChanged++;
                    }
                }
            }
        }
        
        if (blocksChanged > 0) {
            this.terrainNeedsRebuild = true;
        }
        
        return blocksChanged;
    }

    /**
     * Creates a sphere of blocks centered at the given position
     * Useful for creating rounded structures or craters
     */
    createSphere(centerX, centerY, centerZ, radius, value) {
        let blocksChanged = 0;
        const radiusSquared = radius * radius;
        
        // Check all blocks within bounding box of sphere
        for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x++) {
            for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y++) {
                for (let z = Math.floor(centerZ - radius); z <= Math.ceil(centerZ + radius); z++) {
                    // Calculate distance from center
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const dz = z - centerZ;
                    const distanceSquared = dx*dx + dy*dy + dz*dz;
                    
                    // If within sphere radius, set the block
                    if (distanceSquared <= radiusSquared) {
                        if (this.setWorld(x, y, z, value)) {
                            blocksChanged++;
                        }
                    }
                }
            }
        }
        
        if (blocksChanged > 0) {
            this.terrainNeedsRebuild = true;
        }
        
        return blocksChanged;
    }

    /**
     * Finds a safe spawn position above the terrain
     * Returns [x, y, z] coordinates or null if no safe position found
     */
    findSafeSpawnPosition(preferredX = null, preferredZ = null) {
        const attempts = 100;
        
        for (let attempt = 0; attempt < attempts; attempt++) {
            // Use preferred coordinates or pick random ones
            const x = preferredX !== null ? preferredX : Math.floor(Math.random() * WORLD_SIZE);
            const z = preferredZ !== null ? preferredZ : Math.floor(Math.random() * WORLD_SIZE);
            
            // Find surface level
            const surfaceY = this.getSurfaceLevel(x, z);
            const spawnY = surfaceY + 10; // Spawn 10 blocks above surface
            
            // Check if there's enough clear space above for a player
            if (this.isRegionEmpty(x - 10, spawnY, z - 10, x + 10, spawnY + 40, z + 10)) {
                return [x, spawnY, z];
            }
        }
        
        // Fallback to center of world if no safe position found
        const centerX = WORLD_SIZE / 2;
        const centerZ = WORLD_SIZE / 2;
        const centerSurfaceY = this.getSurfaceLevel(centerX, centerZ);
        
        return [centerX, centerSurfaceY + 50, centerZ];
    }

    /**
     * Gets world statistics for debugging
     */
    getWorldStats() {
        let solidBlocks = 0;
        let emptyBlocks = 0;
        
        for (let i = 0; i < this.world.length; i++) {
            if (this.world[i]) {
                solidBlocks++;
            } else {
                emptyBlocks++;
            }
        }
        
        return {
            totalBlocks: this.world.length,
            solidBlocks: solidBlocks,
            emptyBlocks: emptyBlocks,
            solidPercentage: (solidBlocks / this.world.length * 100).toFixed(2),
            worldSize: WORLD_SIZE,
            terrainNeedsRebuild: this.terrainNeedsRebuild
        };
    }

    /**
     * Exports world data for saving/loading
     * Returns a compressed representation of the world
     */
    exportWorld() {
        return {
            world: Array.from(this.world), // Convert to regular array for JSON
            heights: Array.from(this.heights),
            worldSize: WORLD_SIZE,
            generatedAt: Date.now()
        };
    }

    /**
     * Imports world data from a saved file
     * Replaces current world with loaded data
     */
    importWorld(worldData) {
        if (worldData.worldSize !== WORLD_SIZE) {
            throw new Error(`World size mismatch: expected ${WORLD_SIZE}, got ${worldData.worldSize}`);
        }
        
        this.world = new Uint8Array(worldData.world);
        this.heights = new Int32Array(worldData.heights);
        this.terrainNeedsRebuild = true;
        
        console.log(`🌍 World imported from ${new Date(worldData.generatedAt).toLocaleString()}`);
    }

    /**
     * Clears the entire world (makes everything empty)
     */
    clearWorld() {
        this.world.fill(0);
        this.heights.fill(0);
        this.terrainNeedsRebuild = true;
        console.log('🧹 World cleared');
    }

    /**
     * Regenerates the world with new random terrain
     */
    regenerateWorld() {
        this.clearWorld();
        this.generateWorld();
        console.log('🌍 World regenerated');
    }
}