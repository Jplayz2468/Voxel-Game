// Player class - handles player physics, movement, and voxel body management
// Each player is a collection of voxels forming a 3D body

import { MovingVoxel } from './MovingVoxel.js';
import { 
    WORLD_SIZE, 
    MOVE_SPEED, 
    JUMP_SPEED, 
    GRAVITY, 
    PLAYER_HALF_WIDTH, 
    PLAYER_HALF_HEIGHT, 
    STEP_HEIGHT 
} from './constants.js';
import { getCameraDirection, getCameraRight } from './MathUtils.js';

export class Player {
    constructor(playerId) {
        // Player identification
        this.id = playerId;
        
        // Spawn position (center of world, above terrain)
        const base = Math.floor(WORLD_SIZE / 4);
        const spawnY = base + 50;
        this.centerPos = [WORLD_SIZE / 2, spawnY, WORLD_SIZE / 2];
        
        // Physics state
        this.velY = 0; // Vertical velocity (gravity affects this)
        this.grounded = false; // Whether player is standing on ground
        
        // Camera/view state
        this.yaw = 0; // Horizontal rotation (left/right look)
        this.pitch = 0.3; // Vertical rotation (up/down look)
        
        // Input state (which keys are pressed)
        this.keys = { w: false, s: false, a: false, d: false };
        
        // Player body made of voxels
        this.bodyVoxels = [];
        this.createVoxelBody();

        console.log(`Player ${this.id} spawned with ${this.bodyVoxels.length} voxels (solid ${PLAYER_HALF_WIDTH*2}x${PLAYER_HALF_HEIGHT*2}x${PLAYER_HALF_WIDTH*2} cube) at [${this.centerPos[0]}, ${this.centerPos[1]}, ${this.centerPos[2]}]`);
    }

    /**
     * Creates the player's voxel body as a solid rectangular cube
     * This makes a 16x32x16 block of voxels (8,192 total voxels)
     */
    createVoxelBody() {
        const patterns = [];

        // Create a solid rectangular block
        for (let x = -PLAYER_HALF_WIDTH; x < PLAYER_HALF_WIDTH; x++) {
            for (let y = -PLAYER_HALF_HEIGHT; y < PLAYER_HALF_HEIGHT; y++) {
                for (let z = -PLAYER_HALF_WIDTH; z < PLAYER_HALF_WIDTH; z++) {
                    patterns.push({ x: x, y: y, z: z });
                }
            }
        }

        // Convert patterns to actual voxel objects
        for (const pattern of patterns) {
            const voxelPos = [
                this.centerPos[0] + pattern.x,
                this.centerPos[1] + pattern.y,
                this.centerPos[2] + pattern.z
            ];
            
            // Create voxel with zero initial velocity (moves with player)
            const voxel = new MovingVoxel(voxelPos, [0, 0, 0], false, null, true, this.id);
            this.bodyVoxels.push(voxel);
        }
    }

    /**
     * Calculates the center position of all remaining voxels
     * This changes as voxels get shot off the player
     */
    getCenterPosition() {
        if (this.bodyVoxels.length === 0) return this.centerPos;

        let sumX = 0, sumY = 0, sumZ = 0;
        
        for (const voxel of this.bodyVoxels) {
            sumX += voxel.pos[0];
            sumY += voxel.pos[1];
            sumZ += voxel.pos[2];
        }

        return [
            sumX / this.bodyVoxels.length,
            sumY / this.bodyVoxels.length,
            sumZ / this.bodyVoxels.length
        ];
    }

    /**
     * Main physics update - handles movement, gravity, and collision
     * Returns true if the player moved, false otherwise
     */
    updatePhysics(dt, server) {
        // If player has no voxels left, they can't move
        if (this.bodyVoxels.length === 0) return false;

        const oldCenter = [...this.centerPos];
        
        // Update center position based on remaining voxels - but smoothly to prevent bouncing
        const newCenter = this.getCenterPosition();
        const maxCenterShift = 2.0; // Maximum allowed center shift per frame
        
        // Calculate shift magnitude
        const dx = newCenter[0] - this.centerPos[0];
        const dy = newCenter[1] - this.centerPos[1];
        const dz = newCenter[2] - this.centerPos[2];
        const shiftMagnitude = Math.sqrt(dx*dx + dy*dy + dz*dz);
        
        if (shiftMagnitude <= maxCenterShift) {
            // Small shift - apply directly
            this.centerPos = newCenter;
        } else {
            // Large shift - apply gradually to prevent physics instability
            const smoothingFactor = maxCenterShift / shiftMagnitude;
            this.centerPos[0] += dx * smoothingFactor;
            this.centerPos[1] += dy * smoothingFactor;
            this.centerPos[2] += dz * smoothingFactor;
            
            console.log(`Stabilizing player physics: limited center shift from ${shiftMagnitude.toFixed(2)} to ${maxCenterShift} units`);
        }

        // Handle vertical physics (gravity and ground collision)
        this.updateVerticalPhysics(dt, server);
        
        // Handle horizontal movement based on input
        this.updateHorizontalMovement(dt, server);
        
        // Keep player within world boundaries
        this.enforceBoundaries();

        // Check if player actually moved
        return oldCenter[0] !== this.centerPos[0] || 
               oldCenter[1] !== this.centerPos[1] || 
               oldCenter[2] !== this.centerPos[2];
    }

    /**
     * Handles gravity, jumping, and ground collision
     */
    updateVerticalPhysics(dt, server) {
        if (!this.grounded) {
            // Apply gravity when not on ground
            this.velY -= GRAVITY * dt;
            const deltaY = this.velY * dt;

            // Move all voxels down
            for (const voxel of this.bodyVoxels) {
                voxel.pos[1] += deltaY;
            }
            this.centerPos[1] += deltaY;

            // Check for ground collision
            this.checkGroundCollision(server);
        } else {
            // When on ground, stick to terrain height
            this.stickToGround(server);
        }
    }

    /**
     * Checks if player should land on the ground
     */
    checkGroundCollision(server) {
        const cx_i = Math.floor(this.centerPos[0]);
        const cz_i = Math.floor(this.centerPos[2]);
        
        // Get terrain height at player position
        const groundY = Math.floor(WORLD_SIZE / 4) + 
            ((cx_i >= 0 && cx_i < WORLD_SIZE && cz_i >= 0 && cz_i < WORLD_SIZE) ? 
             server.world.heights[cx_i + cz_i * WORLD_SIZE] : 0);

        // Check if player has hit the ground
        if (this.centerPos[1] <= groundY + PLAYER_HALF_HEIGHT) {
            const correction = groundY + PLAYER_HALF_HEIGHT - this.centerPos[1];
            this.centerPos[1] = groundY + PLAYER_HALF_HEIGHT;

            // Move all voxels up to ground level
            for (const voxel of this.bodyVoxels) {
                voxel.pos[1] += correction;
            }

            this.grounded = true;
            this.velY = 0.0;
        }
    }

    /**
     * Keeps player stuck to ground when walking on uneven terrain
     */
    stickToGround(server) {
        const cx_i = Math.floor(this.centerPos[0]);
        const cz_i = Math.floor(this.centerPos[2]);
        
        // Get current terrain height
        const groundY = Math.floor(WORLD_SIZE / 4) + 
            ((cx_i >= 0 && cx_i < WORLD_SIZE && cz_i >= 0 && cz_i < WORLD_SIZE) ? 
             server.world.heights[cx_i + cz_i * WORLD_SIZE] : 0);

        // If too far above ground, start falling
        if (this.centerPos[1] > groundY + PLAYER_HALF_HEIGHT + 1) {
            this.grounded = false;
        } else {
            // Stick to ground level
            const correction = groundY + PLAYER_HALF_HEIGHT - this.centerPos[1];
            this.centerPos[1] = groundY + PLAYER_HALF_HEIGHT;

            for (const voxel of this.bodyVoxels) {
                voxel.pos[1] += correction;
            }
        }
    }

    /**
     * Handles horizontal movement based on WASD input
     */
    updateHorizontalMovement(dt, server) {
        // Calculate camera direction vectors
        const camDir = getCameraDirection(this.yaw, this.pitch);
        const camRight = getCameraRight(this.yaw, this.pitch);

        // Calculate movement vector based on input
        const movement = [0, 0, 0];
        if (this.keys.w) { movement[0] += camDir[0]; movement[2] += camDir[2]; }
        if (this.keys.s) { movement[0] -= camDir[0]; movement[2] -= camDir[2]; }
        if (this.keys.a) { movement[0] -= camRight[0]; movement[2] -= camRight[2]; }
        if (this.keys.d) { movement[0] += camRight[0]; movement[2] += camRight[2]; }

        // Normalize movement vector and apply speed
        const len = Math.sqrt(movement[0] * movement[0] + movement[2] * movement[2]);
        if (len > 0) {
            movement[0] /= len;
            movement[2] /= len;

            const deltaX = movement[0] * MOVE_SPEED * dt;
            const deltaZ = movement[2] * MOVE_SPEED * dt;
            
            // Check if movement is valid (not blocked by terrain height difference)
            if (this.canMoveTo(deltaX, deltaZ, server)) {
                // Move player and all voxels
                this.centerPos[0] += deltaX;
                this.centerPos[2] += deltaZ;

                for (const voxel of this.bodyVoxels) {
                    voxel.pos[0] += deltaX;
                    voxel.pos[2] += deltaZ;
                }
            }
        }
    }

    /**
     * Checks if player can move to a new position
     * Prevents climbing walls that are too high
     */
    canMoveTo(deltaX, deltaZ, server) {
        const target_x = this.centerPos[0] + deltaX;
        const target_z = this.centerPos[2] + deltaZ;
        const tx = Math.floor(target_x), tz = Math.floor(target_z);
        const cxi = Math.floor(this.centerPos[0]), czi = Math.floor(this.centerPos[2]);

        // Check if target position is within world bounds
        if (tx < 0 || tx >= WORLD_SIZE || tz < 0 || tz >= WORLD_SIZE) return false;

        // Check height difference (can't climb walls higher than STEP_HEIGHT)
        const currentHeight = server.world.heights[cxi + czi * WORLD_SIZE];
        const targetHeight = server.world.heights[tx + tz * WORLD_SIZE];
        const heightDiff = targetHeight - currentHeight;

        return heightDiff <= STEP_HEIGHT;
    }

    /**
     * Keeps player within world boundaries
     */
    enforceBoundaries() {
        const margin = PLAYER_HALF_WIDTH / 16; // Small margin from world edge
        const oldX = this.centerPos[0], oldZ = this.centerPos[2];
        
        // Clamp position to world bounds
        this.centerPos[0] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.centerPos[0]));
        this.centerPos[2] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.centerPos[2]));

        // Move voxels if position was clamped
        const boundaryDeltaX = this.centerPos[0] - oldX;
        const boundaryDeltaZ = this.centerPos[2] - oldZ;
        
        if (boundaryDeltaX !== 0 || boundaryDeltaZ !== 0) {
            for (const voxel of this.bodyVoxels) {
                voxel.pos[0] += boundaryDeltaX;
                voxel.pos[2] += boundaryDeltaZ;
            }
        }
    }

    /**
     * Makes the player jump (only works when on ground)
     */
    jump() {
        if (this.grounded) {
            this.velY = JUMP_SPEED;
            this.grounded = false;
            console.log(`Player ${this.id} jumped!`);
        }
    }

    /**
     * Updates the player's camera direction
     */
    updateCamera(yaw, pitch) {
        this.yaw = yaw;
        this.pitch = pitch;
    }

    /**
     * Updates which movement keys are pressed
     */
    updateKeys(keys) {
        this.keys = { ...keys };
    }

    /**
     * Gets data about the player's current state for network synchronization
     */
    getPositionData() {
        return {
            centerPos: [...this.centerPos],
            yaw: this.yaw,
            pitch: this.pitch,
            grounded: this.grounded,
            velY: this.velY,
            voxelCount: this.bodyVoxels.length
        };
    }

    /**
     * Removes a voxel from the player's body (when shot)
     * Returns the removed voxel
     */
    removeVoxel(index) {
        if (index >= 0 && index < this.bodyVoxels.length) {
            return this.bodyVoxels.splice(index, 1)[0];
        }
        return null;
    }

    /**
     * Checks how many voxels the player has left
     */
    getVoxelCount() {
        return this.bodyVoxels.length;
    }

    /**
     * Checks if the player is still "alive" (has voxels remaining)
     */
    isAlive() {
        return this.bodyVoxels.length > 0;
    }

    /**
     * Gets the bounds of the player's body (for collision detection)
     */
    getBounds() {
        if (this.bodyVoxels.length === 0) {
            return {
                minX: this.centerPos[0],
                maxX: this.centerPos[0],
                minY: this.centerPos[1], 
                maxY: this.centerPos[1],
                minZ: this.centerPos[2],
                maxZ: this.centerPos[2]
            };
        }

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const voxel of this.bodyVoxels) {
            minX = Math.min(minX, voxel.pos[0]);
            maxX = Math.max(maxX, voxel.pos[0]);
            minY = Math.min(minY, voxel.pos[1]);
            maxY = Math.max(maxY, voxel.pos[1]);
            minZ = Math.min(minZ, voxel.pos[2]);
            maxZ = Math.max(maxZ, voxel.pos[2]);
        }

        return { minX, maxX, minY, maxY, minZ, maxZ };
    }

    /**
     * Gets all voxel positions for rendering
     */
    getVoxelPositions() {
        return this.bodyVoxels.map(voxel => [...voxel.pos]);
    }
}