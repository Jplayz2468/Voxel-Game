// MovingVoxel class - handles physics for individual voxels
// These can be projectiles, debris, or parts of player bodies

import { WORLD_SIZE, GRAVITY, SETTLE_SPEED_THRESHOLD, VOXEL_SIZE } from './constants.js';

export class MovingVoxel {
    constructor(pos, dir, isProjectile = true, throwerId = null, isPlayerVoxel = false, playerId = null) {
        // Position and movement
        this.pos = [pos[0], pos[1], pos[2]];
        this.vel = [dir[0] * 80, dir[1] * 80, dir[2] * 80]; // Initial velocity
        this.lastPos = [pos[0], pos[1], pos[2]]; // For collision detection
        this.size = VOXEL_SIZE; // Size for collision calculations
        
        // Unique identifier
        this.id = `voxel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Type and ownership
        this.isProjectile = isProjectile;
        this.isPlayerVoxel = isPlayerVoxel;
        this.playerId = playerId;
        
        // Collision state
        this.hasCollided = false;
        
        // Projectile-specific properties
        this.throwerId = throwerId; // Who shot this projectile
        this.hasLeftThrowerHitbox = false; // Prevent hitting yourself immediately
        this.framesSinceLaunch = 0; // Track how long projectile has been flying
        this.throwerInitialPos = throwerId ? [...pos] : null;
    }

    /**
     * Checks if a position is valid (not inside solid blocks)
     * Tests multiple points around the voxel for collision
     */
    isPositionValid(x, y, z, server) {
        const s = this.size;
        
        // Check corners and center points of the voxel
        const checks = [
            [x - s, y - s, z - s], [x + s, y - s, z - s],
            [x - s, y + s, z - s], [x + s, y + s, z - s],
            [x - s, y - s, z + s], [x + s, y - s, z + s],
            [x - s, y + s, z + s], [x + s, y + s, z + s],
            [x, y, z - s], [x, y, z + s],
            [x, y - s, z], [x, y + s, z],
            [x - s, y, z], [x + s, y, z],
            [x, y, z]
        ];

        // If any check point is inside a solid block, position is invalid
        for (const point of checks) {
            const xi = Math.floor(point[0]);
            const yi = Math.floor(point[1]);
            const zi = Math.floor(point[2]);
            if (server.getWorld(xi, yi, zi)) return false;
        }
        
        return true;
    }

    /**
     * Finds the exact time when collision occurs during movement
     * Uses binary search for precision
     */
    findCollisionTime(startPos, endPos, dt, server) {
        // If end position is valid, no collision
        if (this.isPositionValid(endPos[0], endPos[1], endPos[2], server)) return null;

        // Binary search to find exact collision time
        let minTime = 0, maxTime = dt, collisionTime = dt;
        
        for (let i = 0; i < 20; i++) { // 20 iterations for precision
            const testTime = (minTime + maxTime) / 2;
            const testPos = [
                startPos[0] + this.vel[0] * testTime,
                startPos[1] + this.vel[1] * testTime,
                startPos[2] + this.vel[2] * testTime
            ];

            if (this.isPositionValid(testPos[0], testPos[1], testPos[2], server)) {
                minTime = testTime;
            } else {
                maxTime = testTime;
                collisionTime = testTime;
            }
        }
        
        return collisionTime;
    }

    /**
     * Gets information about what the voxel collided with
     * Returns the block position and which axis was hit
     */
    getCollisionInfo(x, y, z, server) {
        const s = this.size;
        
        // Check corner positions to find the closest solid block
        const checks = [
            [x - s, y - s, z - s], [x + s, y - s, z - s],
            [x - s, y + s, z - s], [x + s, y + s, z - s],
            [x - s, y - s, z + s], [x + s, y - s, z + s],
            [x - s, y + s, z + s], [x + s, y + s, z + s]
        ];

        let collisionBlock = null, minDistance = Infinity;
        
        for (const check of checks) {
            const xi = Math.floor(check[0]);
            const yi = Math.floor(check[1]);
            const zi = Math.floor(check[2]);
            
            if (server.getWorld(xi, yi, zi)) {
                const dist = Math.sqrt((xi - x)**2 + (yi - y)**2 + (zi - z)**2);
                if (dist < minDistance) {
                    minDistance = dist;
                    collisionBlock = [xi, yi, zi];
                }
            }
        }

        if (!collisionBlock) return null;

        // Determine which face was hit (X, Y, or Z axis)
        const blockCenter = [collisionBlock[0] + 0.5, collisionBlock[1] + 0.5, collisionBlock[2] + 0.5];
        const dx = Math.abs(x - blockCenter[0]);
        const dy = Math.abs(y - blockCenter[1]);
        const dz = Math.abs(z - blockCenter[2]);

        let axis = 0; // Default to X axis
        if (dy > dx && dy > dz) axis = 1; // Y axis
        else if (dz > dx && dz > dy) axis = 2; // Z axis

        return { block: collisionBlock, axis: axis };
    }

    /**
     * Checks if this voxel is colliding with another voxel
     */
    checkVoxelToVoxelCollision(otherVoxel) {
        const dx = this.pos[0] - otherVoxel.pos[0];
        const dy = this.pos[1] - otherVoxel.pos[1];
        const dz = this.pos[2] - otherVoxel.pos[2];
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
        
        // Fixed: Use proper collision distance (sum of radii, not diameters)
        // Each voxel has size 0.5, so radius is 0.5, collision distance should be 1.0
        const minDistance = this.size + otherVoxel.size; 
        
        return distance < minDistance;
    }

    /**
     * Handles collision between two voxels
     * Separates them and transfers momentum
     */
    handleVoxelCollision(otherVoxel) {
        const dx = this.pos[0] - otherVoxel.pos[0];
        const dy = this.pos[1] - otherVoxel.pos[1];
        const dz = this.pos[2] - otherVoxel.pos[2];
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

        if (distance < 0.001) return; // Avoid division by zero

        // Calculate collision normal (direction of separation)
        const nx = dx / distance, ny = dy / distance, nz = dz / distance;
        
        // Separate the voxels
        const overlap = (this.size + otherVoxel.size) * 2 - distance;
        const separation = overlap * 0.51; // Slightly more than half to prevent sticking

        this.pos[0] += nx * separation;
        this.pos[1] += ny * separation;
        this.pos[2] += nz * separation;
        otherVoxel.pos[0] -= nx * separation;
        otherVoxel.pos[1] -= ny * separation;
        otherVoxel.pos[2] -= nz * separation;

        // Calculate relative velocity
        const relVelX = this.vel[0] - otherVoxel.vel[0];
        const relVelY = this.vel[1] - otherVoxel.vel[1];
        const relVelZ = this.vel[2] - otherVoxel.vel[2];
        const velAlongNormal = relVelX * nx + relVelY * ny + relVelZ * nz;

        // Objects separating, don't apply impulse
        if (velAlongNormal > 0) return;

        // Apply collision impulse (momentum transfer)
        const restitution = 0.6; // Bounciness
        const impulseScalar = -(1 + restitution) * velAlongNormal / 2;
        const impulseX = impulseScalar * nx;
        const impulseY = impulseScalar * ny;
        const impulseZ = impulseScalar * nz;

        this.vel[0] += impulseX;
        this.vel[1] += impulseY;
        this.vel[2] += impulseZ;
        otherVoxel.vel[0] -= impulseX;
        otherVoxel.vel[1] -= impulseY;
        otherVoxel.vel[2] -= impulseZ;
    }

    /**
     * Handles collision with a player voxel (part of a player's body)
     * Can knock the voxel off the player if hit hard enough
     */
    handlePlayerVoxelCollision(playerVoxel, server) {
        const speed = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);

        // If this is a fast projectile, knock the player voxel off
        if (speed > 10 && this.isProjectile && !this.hasCollided) {
            console.log(`💥 Projectile hit player voxel! Speed=${speed.toFixed(1)}, ProjectilePos=[${this.pos[0].toFixed(1)}, ${this.pos[1].toFixed(1)}, ${this.pos[2].toFixed(1)}], PlayerVoxelPos=[${playerVoxel.pos[0].toFixed(1)}, ${playerVoxel.pos[1].toFixed(1)}, ${playerVoxel.pos[2].toFixed(1)}]`);

            // SMART EJECTION: Calculate safe exit point and realistic physics BEFORE removing from player
            const owningPlayer = this.findPlayerOwningVoxel(playerVoxel, server);
            const playerCenter = this.getPlayerCenterPosition(owningPlayer);
            
            // Convert player voxel to debris
            playerVoxel.isPlayerVoxel = false;
            playerVoxel.playerId = null;
            
            // Calculate ejection direction (from player center to voxel)
            const ejectionDir = [
                playerVoxel.pos[0] - playerCenter[0],
                playerVoxel.pos[1] - playerCenter[1], 
                playerVoxel.pos[2] - playerCenter[2]
            ];
            const ejectionLength = Math.sqrt(ejectionDir[0]**2 + ejectionDir[1]**2 + ejectionDir[2]**2);
            
            // Handle edge case: if voxel is exactly at center, use projectile direction
            if (ejectionLength < 0.1) {
                const projectileDir = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);
                ejectionDir[0] = this.vel[0] / projectileDir;
                ejectionDir[1] = this.vel[1] / projectileDir;
                ejectionDir[2] = this.vel[2] / projectileDir;
            } else {
                // Normalize ejection direction
                ejectionDir[0] /= ejectionLength;
                ejectionDir[1] /= ejectionLength;
                ejectionDir[2] /= ejectionLength;
            }
            
            // Move voxel outside player body to prevent phasing
            const safeDistance = 2.5; // Move it 2.5 units away from player center
            playerVoxel.pos[0] = playerCenter[0] + ejectionDir[0] * safeDistance;
            playerVoxel.pos[1] = playerCenter[1] + ejectionDir[1] * safeDistance;  
            playerVoxel.pos[2] = playerCenter[2] + ejectionDir[2] * safeDistance;
            
            // Give velocity in ejection direction + randomness for visual variety
            const baseEjectionSpeed = 15;
            const randomVariation = 8;
            playerVoxel.vel = [
                ejectionDir[0] * baseEjectionSpeed + (Math.random() - 0.5) * randomVariation,
                ejectionDir[1] * baseEjectionSpeed + Math.random() * 10 + 5, // Extra upward bias
                ejectionDir[2] * baseEjectionSpeed + (Math.random() - 0.5) * randomVariation
            ];
            
            console.log(`🚀 Smart ejection: PlayerCenter=[${playerCenter[0].toFixed(1)}, ${playerCenter[1].toFixed(1)}, ${playerCenter[2].toFixed(1)}], NewPos=[${playerVoxel.pos[0].toFixed(1)}, ${playerVoxel.pos[1].toFixed(1)}, ${playerVoxel.pos[2].toFixed(1)}], Vel=[${playerVoxel.vel[0].toFixed(1)}, ${playerVoxel.vel[1].toFixed(1)}, ${playerVoxel.vel[2].toFixed(1)}]`);

            // Add it to the moving voxels list
            server.movingVoxels.push(playerVoxel);
            this.hasCollided = true;
            
            // Mark mesh for update since player voxel was destroyed
            server.meshNeedsUpdate = true;
            
            // Slow down the projectile
            this.vel[0] *= 0.2;
            this.vel[1] *= 0.2;
            this.vel[2] *= 0.2;

            return true; // Voxel was removed from player
        }

        // Normal collision (bounce off)
        this.handleVoxelCollision(playerVoxel);
        
        if (this.isProjectile) {
            this.hasCollided = true;
        }
        
        return false; // Voxel stays on player
    }

    /**
     * Main update function - called every physics tick
     * Handles movement, collisions, and physics
     */
    update(dt, allVoxels, server) {
        // Player voxels don't move on their own (they move with the player)
        if (this.isPlayerVoxel) return 'continue';

        // Track projectile age
        if (this.isProjectile) {
            this.framesSinceLaunch++;
        }

        // Apply gravity
        this.vel[1] -= GRAVITY * dt;

        // Check collisions with players BEFORE movement to prevent overshooting
        if (this.isProjectile && !this.hasCollided) {
            const preMovementResult = this.handlePlayerCollisions(server);
            if (preMovementResult === 'continue') {
                return 'continue'; // Hit player before moving
            }
        }

        // Calculate movement
        const startPos = [this.pos[0], this.pos[1], this.pos[2]];
        const endPos = [
            this.pos[0] + this.vel[0] * dt,
            this.pos[1] + this.vel[1] * dt,
            this.pos[2] + this.vel[2] * dt
        ];

        // Check for collision with terrain
        const collisionTime = this.findCollisionTime(startPos, endPos, dt, server);

        if (collisionTime !== null && collisionTime > 0) {
            // Move to just before collision
            const safeTime = Math.max(0, collisionTime - 0.001);
            this.pos[0] = startPos[0] + this.vel[0] * safeTime;
            this.pos[1] = startPos[1] + this.vel[1] * safeTime;
            this.pos[2] = startPos[2] + this.vel[2] * safeTime;

            // Handle the collision
            const collision = this.getCollisionInfo(
                startPos[0] + this.vel[0] * collisionTime,
                startPos[1] + this.vel[1] * collisionTime,
                startPos[2] + this.vel[2] * collisionTime,
                server
            );

            if (collision) this.handleCollision(collision, server);
        } else {
            // No collision, move freely
            this.pos[0] = endPos[0];
            this.pos[1] = endPos[1];
            this.pos[2] = endPos[2];
        }

        // Check collisions with players EARLY - before terrain collision can slow us down
        if (this.isProjectile && !this.hasCollided) {
            const playerCollisionResult = this.handlePlayerCollisions(server);
            if (playerCollisionResult === 'continue') {
                return 'continue'; // Projectile hit a player, stop processing
            }
        }

        // Handle world boundaries (floor and walls)
        this.handleWorldBoundaries();

        // Check collisions with other moving voxels
        this.handleVoxelCollisions(allVoxels);

        // Check debris collisions with players (so debris bounces off instead of phasing through)
        if (!this.isProjectile) {
            this.handleDebrisPlayerCollisions(server);
        }

        // Check if voxel should settle into terrain
        return this.checkSettling(server);
    }

    /**
     * Handles collisions with world boundaries
     */
    handleWorldBoundaries() {
        // Floor collision
        if (this.pos[1] < this.size) {
            this.pos[1] = this.size;
            if (this.vel[1] < 0) {
                this.vel[1] *= -0.3; // Bounce with some energy loss
                this.vel[0] *= 0.8;  // Friction
                this.vel[2] *= 0.8;
            }
        }

        // Wall collisions
        const margin = this.size;
        this.pos[0] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.pos[0]));
        this.pos[2] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.pos[2]));
    }

    /**
     * Handles collisions with other moving voxels
     */
    handleVoxelCollisions(allVoxels) {
        for (const otherVoxel of allVoxels) {
            if (otherVoxel !== this && this.checkVoxelToVoxelCollision(otherVoxel)) {
                this.handleVoxelCollision(otherVoxel);
            }
        }
    }

    /**
     * Enhanced collision detection for debris vs player voxels
     */
    handleDebrisPlayerCollisions(server) {
        if (this.isProjectile) return; // Only for debris voxels
        
        for (const [playerId, player] of server.players.entries()) {
            // Check collision with each voxel in the player's body
            for (let i = player.bodyVoxels.length - 1; i >= 0; i--) {
                const playerVoxel = player.bodyVoxels[i];
                
                if (this.checkVoxelToVoxelCollision(playerVoxel)) {
                    // Debris hitting player - just bounce off, don't destroy
                    this.handleVoxelCollision(playerVoxel);
                    console.log(`🏀 Debris bounced off player voxel`);
                }
            }
        }
    }

    /**
     * Handles projectile collisions with players
     */
    handlePlayerCollisions(server) {
        for (const [playerId, player] of server.players.entries()) {
            // Don't hit the player who shot this projectile until it's far enough away
            if (playerId === this.throwerId && !this.hasLeftThrowerHitbox) {
                const throwerCenter = player.getCenterPosition();
                const dist = Math.sqrt(
                    (this.pos[0] - throwerCenter[0])**2 + 
                    (this.pos[1] - throwerCenter[1])**2 + 
                    (this.pos[2] - throwerCenter[2])**2
                );
                
                if (dist > 20 || this.framesSinceLaunch > 10) {
                    this.hasLeftThrowerHitbox = true;
                } else {
                    continue; // Skip this player
                }
            }

            // Check collision with each voxel in the player's body
            for (let i = player.bodyVoxels.length - 1; i >= 0; i--) {
                const playerVoxel = player.bodyVoxels[i];
                
                // Calculate distance for debugging
                const dx = this.pos[0] - playerVoxel.pos[0];
                const dy = this.pos[1] - playerVoxel.pos[1];
                const dz = this.pos[2] - playerVoxel.pos[2];
                const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
                const minDistance = this.size + playerVoxel.size;
                
                if (this.checkVoxelToVoxelCollision(playerVoxel)) {
                    console.log(`🎯 Collision detected! Distance=${distance.toFixed(2)}, MinDistance=${minDistance.toFixed(2)}, ProjectileSpeed=${Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2).toFixed(1)}`);
                    
                    const wasRemoved = this.handlePlayerVoxelCollision(playerVoxel, server);
                    if (wasRemoved) {
                        player.bodyVoxels.splice(i, 1); // Remove voxel from player
                        return 'continue';
                    }
                    
                    if (this.isProjectile && this.hasCollided) {
                        return 'continue';
                    }
                }
            }
        }
    }

    /**
     * Checks if the voxel should settle and become part of the terrain
     */
    checkSettling(server) {
        const speed = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);
        const posChange = Math.sqrt(
            (this.pos[0] - this.lastPos[0])**2 + 
            (this.pos[1] - this.lastPos[1])**2 + 
            (this.pos[2] - this.lastPos[2])**2
        );

        // Update last position
        this.lastPos[0] = this.pos[0];
        this.lastPos[1] = this.pos[1];
        this.lastPos[2] = this.pos[2];

        // If moving slowly, try to settle
        if (speed < SETTLE_SPEED_THRESHOLD || posChange < 0.05) {
            return this.settleToGrid(server);
        }

        return 'continue';
    }

    /**
     * Handles collision with terrain blocks
     */
    handleCollision(collision, server) {
        const [xi, yi, zi] = collision.block;
        const axis = collision.axis;
        const restitution = this.isProjectile ? 0.4 : 0.2; // Bounciness
        const friction = this.isProjectile ? 0.8 : 0.9;   // Energy loss

        // Bounce or stop based on speed
        if (Math.abs(this.vel[axis]) > 2) {
            this.vel[axis] *= -restitution; // Bounce
            // Apply friction to other axes
            for (let i = 0; i < 3; i++) {
                if (i !== axis && i !== 1) this.vel[i] *= friction;
            }
        } else {
            this.vel[axis] = 0; // Stop
        }

        // Create destruction if this is a fast projectile
        const speed = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);
        if (speed > 15 && !this.hasCollided && this.isProjectile) {
            this.createDestruction(xi, yi, zi, speed, server);
        }
    }

    /**
     * Creates destruction when a projectile hits terrain at high speed
     */
    createDestruction(xi, yi, zi, speed, server) {
        this.hasCollided = true;
        let dislodged = 0;
        const radius = 3;

        // Destroy blocks in a sphere around the impact point
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const blockPos = [xi + dx, yi + dy, zi + dz];
                    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

                    // Only affect blocks within the radius that exist
                    if (dist <= radius && server.getWorld(blockPos[0], blockPos[1], blockPos[2])) {
                        const forceRatio = Math.max(0, 1 - dist / radius);

                        // Randomly dislodge blocks based on force
                        if (dist > 0.5 && Math.random() < forceRatio * 0.7) {
                            const blockCenter = [blockPos[0] + 0.5, blockPos[1] + 0.5, blockPos[2] + 0.5];
                            
                            // Calculate direction from impact to block
                            const directionX = blockCenter[0] - (xi + 0.5);
                            const directionY = blockCenter[1] - (yi + 0.5);
                            const directionZ = blockCenter[2] - (zi + 0.5);
                            const dirLength = Math.sqrt(directionX**2 + directionY**2 + directionZ**2);

                            if (dirLength > 0) {
                                // Normalize direction and apply force
                                const normDirX = directionX / dirLength;
                                const normDirY = directionY / dirLength;
                                const normDirZ = directionZ / dirLength;
                                const velocityTransfer = speed * forceRatio * 0.8;
                                
                                // Create debris with velocity away from impact
                                const newVelX = normDirX * velocityTransfer + this.vel[0] * 0.3;
                                const newVelY = normDirY * velocityTransfer + this.vel[1] * 0.3 + 8; // Add upward velocity
                                const newVelZ = normDirZ * velocityTransfer + this.vel[2] * 0.3;

                                const dislodgedVoxel = new MovingVoxel(blockCenter, [0, 0, 0], false, null);
                                dislodgedVoxel.vel[0] = newVelX;
                                dislodgedVoxel.vel[1] = newVelY;
                                dislodgedVoxel.vel[2] = newVelZ;

                                server.movingVoxels.push(dislodgedVoxel);
                                server.setWorld(blockPos[0], blockPos[1], blockPos[2], 0); // Remove from terrain
                                server.terrainNeedsRebuild = true;
                                
                                // Mark chunk as dirty for chunked mesh system
                                if (server.useChunkedMesh && server.chunkedMeshGenerator) {
                                    console.log(`💥 Terrain destroyed at (${blockPos[0]}, ${blockPos[1]}, ${blockPos[2]}) - marking chunk dirty`);
                                    server.chunkedMeshGenerator.markPositionDirty(blockPos[0], blockPos[2]);
                                }
                                dislodged++;
                            }
                        }
                    }
                }
            }
        }

        console.log(`💥 Impact: ${dislodged} blocks dislodged`);
    }

    /**
     * Attempts to settle this voxel into the terrain grid
     */
    settleToGrid(server) {
        const targetX = Math.round(this.pos[0] - 0.5);
        const targetY = Math.round(this.pos[1] - 0.5);
        const targetZ = Math.round(this.pos[2] - 0.5);

        const foundPos = this.findClosestEmptyPosition(targetX, targetY, targetZ, server);
        if (foundPos) {
            const [gridX, gridY, gridZ] = foundPos;
            server.setWorld(gridX, gridY, gridZ, 1); // Add to terrain
            server.terrainNeedsRebuild = true;
            
            // Mark chunk as dirty for chunked mesh system
            if (server.useChunkedMesh && server.chunkedMeshGenerator) {
                console.log(`🏗️ Terrain settled at (${gridX}, ${gridY}, ${gridZ}) - marking chunk dirty`);
                server.chunkedMeshGenerator.markPositionDirty(gridX, gridZ);
            }
            console.log(`🔄 Voxel settled at ${gridX},${gridY},${gridZ}`);
            return 'settled';
        }
        return 'continue';
    }

    /**
     * Finds the closest empty position to settle the voxel
     */
    findClosestEmptyPosition(targetX, targetY, targetZ, server, maxRadius = 4) {
        // Check target position first
        if (targetX >= 0 && targetX < WORLD_SIZE && targetY >= 0 && targetY < WORLD_SIZE && 
            targetZ >= 0 && targetZ < WORLD_SIZE && !server.getWorld(targetX, targetY, targetZ)) {
            return [targetX, targetY, targetZ];
        }

        // Search in expanding spheres
        for (let radius = 1; radius <= maxRadius; radius++) {
            const candidates = [];
            
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dz = -radius; dz <= radius; dz++) {
                        // Only check positions on the current radius shell
                        if (Math.abs(dx) === radius || Math.abs(dy) === radius || Math.abs(dz) === radius) {
                            const x = targetX + dx, y = targetY + dy, z = targetZ + dz;
                            
                            if (x >= 0 && x < WORLD_SIZE && y >= 0 && y < WORLD_SIZE && 
                                z >= 0 && z < WORLD_SIZE && !server.getWorld(x, y, z)) {
                                const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
                                candidates.push({ pos: [x, y, z], distance: distance });
                            }
                        }
                    }
                }
            }

            // Return the closest position from this radius
            if (candidates.length > 0) {
                candidates.sort((a, b) => a.distance - b.distance);
                return candidates[0].pos;
            }
        }

        return null; // No position found
    }

    /**
     * Gets the center position of a player based on their body voxels
     */
    getPlayerCenterPosition(player) {
        if (!player || !player.bodyVoxels || player.bodyVoxels.length === 0) {
            // Fallback: use player's recorded center position if available
            return player?.getCenterPosition ? player.getCenterPosition() : [0, 0, 0];
        }
        
        // Calculate center of mass from body voxels
        let sumX = 0, sumY = 0, sumZ = 0;
        for (const voxel of player.bodyVoxels) {
            sumX += voxel.pos[0];
            sumY += voxel.pos[1];
            sumZ += voxel.pos[2];
        }
        
        return [
            sumX / player.bodyVoxels.length,
            sumY / player.bodyVoxels.length,
            sumZ / player.bodyVoxels.length
        ];
    }

    /**
     * Finds which player owns a specific voxel (fallback method)
     */
    findPlayerOwningVoxel(playerVoxel, server) {
        for (const [playerId, player] of server.players.entries()) {
            if (player.bodyVoxels && player.bodyVoxels.includes(playerVoxel)) {
                return player;
            }
        }
        return null; // Voxel not found in any player
    }
}