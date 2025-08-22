// MovingVoxel class - handles physics for individual voxels
// These can be projectiles, debris, or parts of player bodies

import { WORLD_SIZE, GRAVITY, SETTLE_SPEED_THRESHOLD, VOXEL_SIZE, PLAYER_VOXEL_DESTRUCTION_THRESHOLD } from './constants.js';

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
        
        // No complex collision logic needed anymore
        
        // Velocity tracking for debugging
        this.velocityHistory = []; // Track velocity changes over time
        this.frameCount = 0;
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
     * Improved accuracy for edge collisions
     */
    getCollisionInfo(x, y, z, server) {
        const s = this.size;
        
        // First find which block the voxel center is actually inside or closest to
        let collisionBlock = null;
        
        // Check the block the voxel center is in first
        const centerBlockX = Math.floor(x);
        const centerBlockY = Math.floor(y);
        const centerBlockZ = Math.floor(z);
        
        if (server.getWorld(centerBlockX, centerBlockY, centerBlockZ)) {
            collisionBlock = [centerBlockX, centerBlockY, centerBlockZ];
        } else {
            // If center isn't in a block, check surrounding blocks that the voxel extends into
            const checks = [
                [Math.floor(x - s), Math.floor(y), Math.floor(z)],
                [Math.floor(x + s), Math.floor(y), Math.floor(z)],
                [Math.floor(x), Math.floor(y - s), Math.floor(z)],
                [Math.floor(x), Math.floor(y + s), Math.floor(z)],
                [Math.floor(x), Math.floor(y), Math.floor(z - s)],
                [Math.floor(x), Math.floor(y), Math.floor(z + s)]
            ];
            
            let minDistance = Infinity;
            for (const check of checks) {
                const [xi, yi, zi] = check;
                if (server.getWorld(xi, yi, zi)) {
                    // Calculate distance from voxel center to block center
                    const blockCenterX = xi + 0.5;
                    const blockCenterY = yi + 0.5;
                    const blockCenterZ = zi + 0.5;
                    const dist = Math.sqrt((x - blockCenterX)**2 + (y - blockCenterY)**2 + (z - blockCenterZ)**2);
                    
                    if (dist < minDistance) {
                        minDistance = dist;
                        collisionBlock = [xi, yi, zi];
                    }
                }
            }
        }

        if (!collisionBlock) return null;

        // Determine which face was hit based on which side the voxel is closest to
        const [bx, by, bz] = collisionBlock;
        const blockCenterX = bx + 0.5;
        const blockCenterY = by + 0.5;
        const blockCenterZ = bz + 0.5;
        
        // Calculate how far the voxel extends past each face of the block
        const leftOverlap = Math.max(0, (bx + 0.5) - (x - s));   // Left face (X-)
        const rightOverlap = Math.max(0, (x + s) - (bx + 0.5));  // Right face (X+)
        const bottomOverlap = Math.max(0, (by + 0.5) - (y - s)); // Bottom face (Y-)
        const topOverlap = Math.max(0, (y + s) - (by + 0.5));    // Top face (Y+)
        const backOverlap = Math.max(0, (bz + 0.5) - (z - s));   // Back face (Z-)
        const frontOverlap = Math.max(0, (z + s) - (bz + 0.5));  // Front face (Z+)
        
        // Find the face with maximum penetration (most likely collision surface)
        const maxOverlap = Math.max(leftOverlap, rightOverlap, bottomOverlap, topOverlap, backOverlap, frontOverlap);
        
        let axis = 0; // Default to X axis
        if (maxOverlap === topOverlap || maxOverlap === bottomOverlap) {
            axis = 1; // Y axis
        } else if (maxOverlap === frontOverlap || maxOverlap === backOverlap) {
            axis = 2; // Z axis
        }

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
     * New system: velocity-based destruction with complete deletion
     */
    handlePlayerVoxelCollision(playerVoxel, server, hitPlayerId) {
        console.log(`SIMPLE COLLISION: Projectile hits player voxel - both die!`);
        
        // Mark mesh for update since player voxel was destroyed
        server.meshNeedsUpdate = true;
        
        // Both the projectile AND the player voxel are destroyed
        return 'kill_both';
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
        
        // Track velocity for summary
        this.frameCount++;
        this.velocityHistory.push({
            frame: this.frameCount,
            vel: [this.vel[0], this.vel[1], this.vel[2]],
            speed: Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2)
        });

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

        // Check collisions with players using trajectory-based detection
        if (this.isProjectile) {
            // startPos is where we were before this movement
            // this.pos is where we are now after movement
            const actualStartPos = [
                this.pos[0] - this.vel[0] * dt,
                this.pos[1] - this.vel[1] * dt, 
                this.pos[2] - this.vel[2] * dt
            ];
            const actualEndPos = [this.pos[0], this.pos[1], this.pos[2]];
            
            const playerCollisionResult = this.handlePlayerCollisionsTrajectory(actualStartPos, actualEndPos, server);
            if (playerCollisionResult === 'kill_projectile') {
                this.printVelocitySummary("KILLED BY PLAYER");
                return 'kill_projectile';
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
                    console.log(`Debris bounced off player voxel`);
                }
            }
        }
    }

    /**
     * Handles projectile collisions with players using trajectory-based detection
     * Checks the path from startPos to endPos for any player voxel intersections
     */
    handlePlayerCollisionsTrajectory(startPos, endPos, server) {
        if (server.players.size === 0) {
            return;
        }

        // Calculate trajectory vector
        const trajectory = [
            endPos[0] - startPos[0],
            endPos[1] - startPos[1], 
            endPos[2] - startPos[2]
        ];
        const trajectoryLength = Math.sqrt(trajectory[0]**2 + trajectory[1]**2 + trajectory[2]**2);
        
        if (trajectoryLength < 0.001) return; // No movement

        let closestCollision = null;
        let closestT = Infinity;

        for (const [playerId, player] of server.players.entries()) {
            // Don't hit the player who shot this projectile until it's far enough away
            if (playerId === this.throwerId && !this.hasLeftThrowerHitbox) {
                const throwerCenter = player.getCenterPosition();
                const dist = Math.sqrt(
                    (startPos[0] - throwerCenter[0])**2 + 
                    (startPos[1] - throwerCenter[1])**2 + 
                    (startPos[2] - throwerCenter[2])**2
                );
                
                if (dist < 20 && this.framesSinceLaunch < 10) {
                    continue; // Skip thrower
                }
                this.hasLeftThrowerHitbox = true;
            }

            // Check each voxel in the player's body
            for (let i = player.bodyVoxels.length - 1; i >= 0; i--) {
                const playerVoxel = player.bodyVoxels[i];
                
                // Find intersection of trajectory with this player voxel
                const t = this.findTrajectoryVoxelIntersection(startPos, trajectory, trajectoryLength, playerVoxel);
                
                if (t !== null && t >= 0 && t <= 1 && t < closestT) {
                    closestCollision = {
                        t: t,
                        playerId: playerId,
                        playerVoxelIndex: i,
                        player: player,
                        playerVoxel: playerVoxel
                    };
                    closestT = t;
                }
            }
        }

        // If we found a collision, handle the FIRST one
        if (closestCollision) {
            const collisionPos = [
                startPos[0] + trajectory[0] * closestCollision.t,
                startPos[1] + trajectory[1] * closestCollision.t,
                startPos[2] + trajectory[2] * closestCollision.t
            ];
            
            console.log(`TRAJECTORY COLLISION at t=${closestCollision.t.toFixed(3)}, pos=[${collisionPos[0].toFixed(1)}, ${collisionPos[1].toFixed(1)}, ${collisionPos[2].toFixed(1)}]`);
            
            // Move projectile to exact collision point
            this.pos[0] = collisionPos[0];
            this.pos[1] = collisionPos[1]; 
            this.pos[2] = collisionPos[2];
            
            // Handle the collision
            const collisionResult = this.handlePlayerVoxelCollision(closestCollision.playerVoxel, server, closestCollision.playerId);
            if (collisionResult === 'kill_both') {
                closestCollision.player.bodyVoxels.splice(closestCollision.playerVoxelIndex, 1); // Remove player voxel
                return 'kill_projectile'; // Kill the projectile too
            }
        }

        return null;
    }

    /**
     * Old point-based collision detection (kept as fallback)
     */
    handlePlayerCollisions(server) {
        if (server.players.size === 0) {
            console.log(`[DEBUG] No players to check collision with`);
            return;
        }
        
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
            
            // No immunity logic - simple collision

            // Check collision with each voxel in the player's body
            console.log(`[DEBUG] Checking collision with player ${playerId}: ${player.bodyVoxels.length} voxels`);
            
            for (let i = player.bodyVoxels.length - 1; i >= 0; i--) {
                const playerVoxel = player.bodyVoxels[i];
                
                // Calculate distance for debugging
                const dx = this.pos[0] - playerVoxel.pos[0];
                const dy = this.pos[1] - playerVoxel.pos[1];
                const dz = this.pos[2] - playerVoxel.pos[2];
                const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
                const minDistance = this.size + playerVoxel.size;
                
                // Debug first few voxels
                if (i < 3) {
                    console.log(`[DEBUG] Voxel ${i}: projectile=[${this.pos[0].toFixed(1)}, ${this.pos[1].toFixed(1)}, ${this.pos[2].toFixed(1)}], playerVoxel=[${playerVoxel.pos[0].toFixed(1)}, ${playerVoxel.pos[1].toFixed(1)}, ${playerVoxel.pos[2].toFixed(1)}], distance=${distance.toFixed(2)}, minDist=${minDistance.toFixed(2)}`);
                }
                
                if (this.checkVoxelToVoxelCollision(playerVoxel)) {
                    console.log(`Collision detected! Distance=${distance.toFixed(2)}, MinDistance=${minDistance.toFixed(2)}, ProjectileSpeed=${Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2).toFixed(1)}`);
                    
                    const collisionResult = this.handlePlayerVoxelCollision(playerVoxel, server, playerId);
                    if (collisionResult === 'kill_both') {
                        player.bodyVoxels.splice(i, 1); // Remove player voxel
                        return 'kill_projectile'; // Kill the projectile too
                    }
                    
                    // Only process one collision per frame
                    return;
                }
            }
            
            console.log(`[DEBUG] No collisions found with player ${playerId}`);
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
            this.printVelocitySummary("SETTLING");
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
                                    console.log(`Terrain destroyed at (${blockPos[0]}, ${blockPos[1]}, ${blockPos[2]}) - marking chunk dirty`);
                                    server.chunkedMeshGenerator.markPositionDirty(blockPos[0], blockPos[2]);
                                }
                                dislodged++;
                            }
                        }
                    }
                }
            }
        }

        console.log(`Impact: ${dislodged} blocks dislodged`);
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
                console.log(`Terrain settled at (${gridX}, ${gridY}, ${gridZ}) - marking chunk dirty`);
                server.chunkedMeshGenerator.markPositionDirty(gridX, gridZ);
            }
            console.log(`Voxel settled at ${gridX},${gridY},${gridZ}`);
            this.printVelocitySummary("SETTLED");
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

    /**
     * Finds the intersection parameter t where the trajectory intersects a player voxel
     * Returns t value (0-1) where intersection occurs, or null if no intersection
     */
    findTrajectoryVoxelIntersection(startPos, trajectory, trajectoryLength, playerVoxel) {
        // Treat both projectile and player voxel as spheres for simplicity
        const projectileRadius = this.size;
        const playerVoxelRadius = playerVoxel.size;
        const combinedRadius = projectileRadius + playerVoxelRadius;
        
        // Vector from start position to player voxel center
        const toVoxel = [
            playerVoxel.pos[0] - startPos[0],
            playerVoxel.pos[1] - startPos[1],
            playerVoxel.pos[2] - startPos[2]
        ];
        
        // Project toVoxel onto trajectory to find closest approach point
        const trajectoryDot = trajectory[0]**2 + trajectory[1]**2 + trajectory[2]**2;
        if (trajectoryDot < 0.001) return null; // No movement
        
        const projectionLength = (toVoxel[0] * trajectory[0] + toVoxel[1] * trajectory[1] + toVoxel[2] * trajectory[2]) / trajectoryDot;
        
        // Clamp to trajectory bounds
        const clampedT = Math.max(0, Math.min(1, projectionLength));
        
        // Find closest point on trajectory
        const closestPoint = [
            startPos[0] + trajectory[0] * clampedT,
            startPos[1] + trajectory[1] * clampedT,
            startPos[2] + trajectory[2] * clampedT
        ];
        
        // Check distance from closest point to player voxel
        const dx = closestPoint[0] - playerVoxel.pos[0];
        const dy = closestPoint[1] - playerVoxel.pos[1];
        const dz = closestPoint[2] - playerVoxel.pos[2];
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
        
        // If within combined radius, we have an intersection
        if (distance <= combinedRadius) {
            // For more accuracy, calculate the actual intersection point
            // Use quadratic formula to solve for exact intersection
            const a = trajectoryDot;
            const b = 2 * (trajectory[0] * (startPos[0] - playerVoxel.pos[0]) + 
                           trajectory[1] * (startPos[1] - playerVoxel.pos[1]) + 
                           trajectory[2] * (startPos[2] - playerVoxel.pos[2]));
            const c = (startPos[0] - playerVoxel.pos[0])**2 + 
                      (startPos[1] - playerVoxel.pos[1])**2 + 
                      (startPos[2] - playerVoxel.pos[2])**2 - combinedRadius**2;
            
            const discriminant = b*b - 4*a*c;
            
            if (discriminant >= 0) {
                // Two solutions - we want the first intersection (smaller t)
                const sqrtDiscriminant = Math.sqrt(discriminant);
                const t1 = (-b - sqrtDiscriminant) / (2*a);
                const t2 = (-b + sqrtDiscriminant) / (2*a);
                
                // Return the first valid intersection
                if (t1 >= 0 && t1 <= 1) return t1;
                if (t2 >= 0 && t2 <= 1) return t2;
            }
            
            // Fallback to clamped approach point
            return clampedT;
        }
        
        return null; // No intersection
    }

    /**
     * Prints a summary of velocity changes over the voxel's lifetime
     */
    printVelocitySummary(reason) {
        if (this.velocityHistory.length === 0) return;
        
        // Find significant velocity changes (flips, reductions, etc.)
        const significantChanges = [];
        let prevVel = null;
        
        for (let i = 0; i < this.velocityHistory.length; i++) {
            const current = this.velocityHistory[i];
            
            if (prevVel) {
                // Check for velocity flip (opposite direction)
                const prevDir = [Math.sign(prevVel.vel[0]), Math.sign(prevVel.vel[1]), Math.sign(prevVel.vel[2])];
                const currDir = [Math.sign(current.vel[0]), Math.sign(current.vel[1]), Math.sign(current.vel[2])];
                
                const xFlip = prevDir[0] !== 0 && currDir[0] !== 0 && prevDir[0] !== currDir[0];
                const zFlip = prevDir[2] !== 0 && currDir[2] !== 0 && prevDir[2] !== currDir[2];
                
                if (xFlip || zFlip) {
                    significantChanges.push({
                        frame: current.frame,
                        type: 'FLIP',
                        from: prevVel.vel,
                        to: current.vel
                    });
                }
                
                // Check for large speed changes (>50% reduction or increase)
                const speedChange = Math.abs(current.speed - prevVel.speed) / prevVel.speed;
                if (speedChange > 0.5) {
                    significantChanges.push({
                        frame: current.frame,
                        type: speedChange > 0 ? 'SPEEDUP' : 'SLOWDOWN',
                        from: prevVel.speed.toFixed(1),
                        to: current.speed.toFixed(1)
                    });
                }
            }
            
            prevVel = current;
        }
        
        // Print summary
        const firstVel = this.velocityHistory[0];
        const lastVel = this.velocityHistory[this.velocityHistory.length - 1];
        
        console.log(`[VELOCITY SUMMARY] ${this.id.slice(-4)} ${reason} after ${this.frameCount} frames:`);
        console.log(`  Initial: [${firstVel.vel[0].toFixed(1)}, ${firstVel.vel[1].toFixed(1)}, ${firstVel.vel[2].toFixed(1)}] speed=${firstVel.speed.toFixed(1)}`);
        console.log(`  Final:   [${lastVel.vel[0].toFixed(1)}, ${lastVel.vel[1].toFixed(1)}, ${lastVel.vel[2].toFixed(1)}] speed=${lastVel.speed.toFixed(1)}`);
        
        if (significantChanges.length > 0) {
            console.log(`  Changes: ${significantChanges.map(c => `F${c.frame}:${c.type}`).join(', ')}`);
        } else {
            console.log(`  Changes: None (smooth trajectory)`);
        }
    }

}