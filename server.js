#!/usr/bin/env node
// Multiplayer Voxel Physics Server - Players as Voxel Arrays
// Run with: node server.js

const WebSocket = require('ws');
const { performance } = require('perf_hooks');

// ===== CONSTANTS =====
const WORLD_SIZE = 128;
const MOVE_SPD = 15.0;
const JUMP_SPEED = 18.0;
const HALF_W = 8;
const HALF_H = 16;
const GRAVITY = 40.0;
const STEP_HEIGHT = 6;
const SETTLE_SPEED_THRESHOLD = 3.0;

// ===== MOVING VOXEL CLASS =====
class MovingVoxel {
    constructor(pos, dir, isProjectile = true, throwerId = null, isPlayerVoxel = false, playerId = null) {
        this.pos = [pos[0], pos[1], pos[2]];
        this.vel = [dir[0] * 80, dir[1] * 80, dir[2] * 80];
        this.isProjectile = isProjectile;
        this.hasCollided = false;
        this.lastPos = [pos[0], pos[1], pos[2]];
        this.size = 0.45;
        this.id = `voxel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Player voxel properties
        this.isPlayerVoxel = isPlayerVoxel;
        this.playerId = playerId;

        // Projectile properties
        this.throwerId = throwerId;
        this.hasLeftThrowerHitbox = false;
        this.framesSinceLaunch = 0;
        this.throwerInitialPos = throwerId ? [...pos] : null;
    }

    isPositionValid(x, y, z, server) {
        const s = this.size;
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

        for (const point of checks) {
            const xi = Math.floor(point[0]);
            const yi = Math.floor(point[1]);
            const zi = Math.floor(point[2]);
            if (server.getWorld(xi, yi, zi)) return false;
        }
        return true;
    }

    findCollisionTime(startPos, endPos, dt, server) {
        if (this.isPositionValid(endPos[0], endPos[1], endPos[2], server)) return null;

        let minTime = 0, maxTime = dt, collisionTime = dt;
        for (let i = 0; i < 20; i++) {
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

    getCollisionInfo(x, y, z, server) {
        const s = this.size;
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

        const blockCenter = [collisionBlock[0] + 0.5, collisionBlock[1] + 0.5, collisionBlock[2] + 0.5];
        const dx = Math.abs(x - blockCenter[0]);
        const dy = Math.abs(y - blockCenter[1]);
        const dz = Math.abs(z - blockCenter[2]);

        let axis = 0;
        if (dy > dx && dy > dz) axis = 1;
        else if (dz > dx && dz > dy) axis = 2;

        return { block: collisionBlock, axis: axis };
    }

    checkVoxelToVoxelCollision(otherVoxel) {
        const dx = this.pos[0] - otherVoxel.pos[0];
        const dy = this.pos[1] - otherVoxel.pos[1];
        const dz = this.pos[2] - otherVoxel.pos[2];
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const minDistance = (this.size + otherVoxel.size) * 2;
        return distance < minDistance;
    }

    handleVoxelCollision(otherVoxel) {
        const dx = this.pos[0] - otherVoxel.pos[0];
        const dy = this.pos[1] - otherVoxel.pos[1];
        const dz = this.pos[2] - otherVoxel.pos[2];
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

        if (distance < 0.001) return;

        const nx = dx / distance, ny = dy / distance, nz = dz / distance;
        const overlap = (this.size + otherVoxel.size) * 2 - distance;
        const separation = overlap * 0.51;

        this.pos[0] += nx * separation;
        this.pos[1] += ny * separation;
        this.pos[2] += nz * separation;
        otherVoxel.pos[0] -= nx * separation;
        otherVoxel.pos[1] -= ny * separation;
        otherVoxel.pos[2] -= nz * separation;

        const relVelX = this.vel[0] - otherVoxel.vel[0];
        const relVelY = this.vel[1] - otherVoxel.vel[1];
        const relVelZ = this.vel[2] - otherVoxel.vel[2];
        const velAlongNormal = relVelX * nx + relVelY * ny + relVelZ * nz;

        if (velAlongNormal > 0) return;

        const restitution = 0.6;
        const impulseScalar = -(1 + restitution) * velAlongNormal / 2;
        const impulseX = impulseScalar * nx, impulseY = impulseScalar * ny, impulseZ = impulseScalar * nz;

        this.vel[0] += impulseX;
        this.vel[1] += impulseY;
        this.vel[2] += impulseZ;
        otherVoxel.vel[0] -= impulseX;
        otherVoxel.vel[1] -= impulseY;
        otherVoxel.vel[2] -= impulseZ;
    }

    checkPlayerVoxelCollision(playerVoxel) {
        return this.checkVoxelToVoxelCollision(playerVoxel);
    }

    handlePlayerVoxelCollision(playerVoxel, server) {
        const speed = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);

        if (speed > 10 && this.isProjectile && !this.hasCollided) {
            console.log(`💥 Projectile hit player voxel! Converting to debris.`);

            playerVoxel.isPlayerVoxel = false;
            playerVoxel.playerId = null;
            playerVoxel.vel = [
                (Math.random() - 0.5) * 20,
                Math.random() * 15 + 5,
                (Math.random() - 0.5) * 20
            ];

            server.movingVoxels.push(playerVoxel);
            this.hasCollided = true;
            this.vel[0] *= 0.2;
            this.vel[1] *= 0.2;
            this.vel[2] *= 0.2;

            return true;
        }

        this.handleVoxelCollision(playerVoxel);
        
        if (this.isProjectile) {
            this.hasCollided = true;
        }
        
        return false;
    }

    update(dt, allVoxels, server) {
        if (this.isPlayerVoxel) return 'continue';

        if (this.isProjectile) {
            this.framesSinceLaunch++;
        }

        this.vel[1] -= GRAVITY * dt;

        const startPos = [this.pos[0], this.pos[1], this.pos[2]];
        const endPos = [
            this.pos[0] + this.vel[0] * dt,
            this.pos[1] + this.vel[1] * dt,
            this.pos[2] + this.vel[2] * dt
        ];

        const collisionTime = this.findCollisionTime(startPos, endPos, dt, server);

        if (collisionTime !== null && collisionTime > 0) {
            const safeTime = Math.max(0, collisionTime - 0.001);
            this.pos[0] = startPos[0] + this.vel[0] * safeTime;
            this.pos[1] = startPos[1] + this.vel[1] * safeTime;
            this.pos[2] = startPos[2] + this.vel[2] * safeTime;

            const collision = this.getCollisionInfo(
                startPos[0] + this.vel[0] * collisionTime,
                startPos[1] + this.vel[1] * collisionTime,
                startPos[2] + this.vel[2] * collisionTime,
                server
            );

            if (collision) this.handleCollision(collision, server);
        } else {
            this.pos[0] = endPos[0];
            this.pos[1] = endPos[1];
            this.pos[2] = endPos[2];
        }

        if (this.pos[1] < this.size) {
            this.pos[1] = this.size;
            if (this.vel[1] < 0) {
                this.vel[1] *= -0.3;
                this.vel[0] *= 0.8;
                this.vel[2] *= 0.8;
            }
        }

        const margin = this.size;
        this.pos[0] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.pos[0]));
        this.pos[2] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.pos[2]));

        for (const otherVoxel of allVoxels) {
            if (otherVoxel !== this && this.checkVoxelToVoxelCollision(otherVoxel)) {
                this.handleVoxelCollision(otherVoxel);
            }
        }

        if (this.isProjectile && !this.hasCollided) {
            for (const [playerId, player] of server.players.entries()) {
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
                        continue;
                    }
                }

                for (let i = player.bodyVoxels.length - 1; i >= 0; i--) {
                    const playerVoxel = player.bodyVoxels[i];
                    if (this.checkPlayerVoxelCollision(playerVoxel)) {
                        const wasRemoved = this.handlePlayerVoxelCollision(playerVoxel, server);
                        if (wasRemoved) {
                            player.bodyVoxels.splice(i, 1);
                            return 'continue';
                        }
                        
                        if (this.isProjectile && this.hasCollided) {
                            return 'continue';
                        }
                    }
                }
            }
        }

        const speed = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);
        const posChange = Math.sqrt(
            (this.pos[0] - this.lastPos[0])**2 + 
            (this.pos[1] - this.lastPos[1])**2 + 
            (this.pos[2] - this.lastPos[2])**2
        );

        this.lastPos[0] = this.pos[0];
        this.lastPos[1] = this.pos[1];
        this.lastPos[2] = this.pos[2];

        if (speed < SETTLE_SPEED_THRESHOLD || posChange < 0.05) {
            return this.settleToGrid(server);
        }

        return 'continue';
    }

    handleCollision(collision, server) {
        const [xi, yi, zi] = collision.block;
        const axis = collision.axis;
        const restitution = this.isProjectile ? 0.4 : 0.2;
        const friction = this.isProjectile ? 0.8 : 0.9;

        if (Math.abs(this.vel[axis]) > 2) {
            this.vel[axis] *= -restitution;
            for (let i = 0; i < 3; i++) {
                if (i !== axis && i !== 1) this.vel[i] *= friction;
            }
        } else {
            this.vel[axis] = 0;
        }

        const speed = Math.sqrt(this.vel[0]**2 + this.vel[1]**2 + this.vel[2]**2);
        if (speed > 15 && !this.hasCollided && this.isProjectile) {
            this.createDestruction(xi, yi, zi, speed, server);
        }
    }

    createDestruction(xi, yi, zi, speed, server) {
        this.hasCollided = true;
        let dislodged = 0;
        const radius = 3;

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const blockPos = [xi + dx, yi + dy, zi + dz];
                    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

                    if (dist <= radius && server.getWorld(blockPos[0], blockPos[1], blockPos[2])) {
                        const forceRatio = Math.max(0, 1 - dist / radius);

                        if (dist > 0.5 && Math.random() < forceRatio * 0.7) {
                            const blockCenter = [blockPos[0] + 0.5, blockPos[1] + 0.5, blockPos[2] + 0.5];
                            const directionX = blockCenter[0] - (xi + 0.5);
                            const directionY = blockCenter[1] - (yi + 0.5);
                            const directionZ = blockCenter[2] - (zi + 0.5);
                            const dirLength = Math.sqrt(directionX**2 + directionY**2 + directionZ**2);

                            if (dirLength > 0) {
                                const normDirX = directionX / dirLength;
                                const normDirY = directionY / dirLength;
                                const normDirZ = directionZ / dirLength;
                                const velocityTransfer = speed * forceRatio * 0.8;
                                const newVelX = normDirX * velocityTransfer + this.vel[0] * 0.3;
                                const newVelY = normDirY * velocityTransfer + this.vel[1] * 0.3 + 8;
                                const newVelZ = normDirZ * velocityTransfer + this.vel[2] * 0.3;

                                const dislodgedVoxel = new MovingVoxel(blockCenter, [0, 0, 0], false, null);
                                dislodgedVoxel.vel[0] = newVelX;
                                dislodgedVoxel.vel[1] = newVelY;
                                dislodgedVoxel.vel[2] = newVelZ;

                                server.movingVoxels.push(dislodgedVoxel);
                                server.setWorld(blockPos[0], blockPos[1], blockPos[2], 0);
                                server.terrainNeedsRebuild = true;
                                dislodged++;
                            }
                        }
                    }
                }
            }
        }

        console.log(`💥 Impact: ${dislodged} blocks dislodged`);
    }

    settleToGrid(server) {
        const targetX = Math.round(this.pos[0] - 0.5);
        const targetY = Math.round(this.pos[1] - 0.5);
        const targetZ = Math.round(this.pos[2] - 0.5);

        const foundPos = this.findClosestEmptyPosition(targetX, targetY, targetZ, server);
        if (foundPos) {
            const [gridX, gridY, gridZ] = foundPos;
            server.setWorld(gridX, gridY, gridZ, 1);
            server.terrainNeedsRebuild = true;
            console.log(`🔄 Voxel settled at ${gridX},${gridY},${gridZ}`);
            return 'settled';
        }
        return 'continue';
    }

    findClosestEmptyPosition(targetX, targetY, targetZ, server, maxRadius = 4) {
        if (targetX >= 0 && targetX < WORLD_SIZE && targetY >= 0 && targetY < WORLD_SIZE && 
            targetZ >= 0 && targetZ < WORLD_SIZE && !server.getWorld(targetX, targetY, targetZ)) {
            return [targetX, targetY, targetZ];
        }

        for (let radius = 1; radius <= maxRadius; radius++) {
            const candidates = [];
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dz = -radius; dz <= radius; dz++) {
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

            if (candidates.length > 0) {
                candidates.sort((a, b) => a.distance - b.distance);
                return candidates[0].pos;
            }
        }

        return null;
    }
}

// ===== PLAYER CLASS =====
class Player {
    constructor(playerId) {
        const base = Math.floor(WORLD_SIZE / 4);
        const spawnY = base + 50;
        this.id = playerId;
        this.centerPos = [WORLD_SIZE / 2, spawnY, WORLD_SIZE / 2];
        this.velY = 0;
        this.grounded = false;
        this.yaw = 0;
        this.pitch = 0.3;
        this.keys = { w: false, s: false, a: false, d: false };

        this.bodyVoxels = [];
        this.createVoxelBody();

        console.log(`👤 Player ${this.id} spawned with ${this.bodyVoxels.length} voxels (solid 16x32x16 cube) at [${this.centerPos[0]}, ${this.centerPos[1]}, ${this.centerPos[2]}]`);
    }

    createVoxelBody() {
        const patterns = [];

        for (let x = -HALF_W; x < HALF_W; x++) {
            for (let y = -HALF_H; y < HALF_H; y++) {
                for (let z = -HALF_W; z < HALF_W; z++) {
                    patterns.push({ x: x, y: y, z: z });
                }
            }
        }

        for (const pattern of patterns) {
            const voxelPos = [
                this.centerPos[0] + pattern.x,
                this.centerPos[1] + pattern.y,
                this.centerPos[2] + pattern.z
            ];
            const voxel = new MovingVoxel(voxelPos, [0, 0, 0], false, null, true, this.id);
            this.bodyVoxels.push(voxel);
        }
    }

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

    updatePhysics(dt, server) {
        if (this.bodyVoxels.length === 0) return false;

        const oldCenter = [...this.centerPos];
        this.centerPos = this.getCenterPosition();

        if (!this.grounded) {
            this.velY -= GRAVITY * dt;
            const deltaY = this.velY * dt;

            for (const voxel of this.bodyVoxels) {
                voxel.pos[1] += deltaY;
            }
            this.centerPos[1] += deltaY;

            const cx_i = Math.floor(this.centerPos[0]);
            const cz_i = Math.floor(this.centerPos[2]);
            const g_y = Math.floor(WORLD_SIZE / 4) + ((cx_i >= 0 && cx_i < WORLD_SIZE && cz_i >= 0 && cz_i < WORLD_SIZE) ? 
                server.heights[cx_i + cz_i * WORLD_SIZE] : 0);

            if (this.centerPos[1] <= g_y + HALF_H) {
                const correction = g_y + HALF_H - this.centerPos[1];
                this.centerPos[1] = g_y + HALF_H;

                for (const voxel of this.bodyVoxels) {
                    voxel.pos[1] += correction;
                }

                this.grounded = true;
                this.velY = 0.0;
            }
        } else {
            const cx_i = Math.floor(this.centerPos[0]);
            const cz_i = Math.floor(this.centerPos[2]);
            const g_y = Math.floor(WORLD_SIZE / 4) + ((cx_i >= 0 && cx_i < WORLD_SIZE && cz_i >= 0 && cz_i < WORLD_SIZE) ? 
                server.heights[cx_i + cz_i * WORLD_SIZE] : 0);

            if (this.centerPos[1] > g_y + HALF_H + 1) {
                this.grounded = false;
            } else {
                const correction = g_y + HALF_H - this.centerPos[1];
                this.centerPos[1] = g_y + HALF_H;

                for (const voxel of this.bodyVoxels) {
                    voxel.pos[1] += correction;
                }
            }
        }

        const camDir = [
            Math.cos(this.pitch) * Math.sin(this.yaw),
            Math.sin(this.pitch),
            Math.cos(this.pitch) * Math.cos(this.yaw)
        ];

        const worldUp = [0, 1, 0];
        const camRight = [
            camDir[1] * worldUp[2] - camDir[2] * worldUp[1],
            camDir[2] * worldUp[0] - camDir[0] * worldUp[2],
            camDir[0] * worldUp[1] - camDir[1] * worldUp[0]
        ];

        const rightLen = Math.sqrt(camRight[0] * camRight[0] + camRight[1] * camRight[1] + camRight[2] * camRight[2]);
        if (rightLen > 0) {
            camRight[0] /= rightLen;
            camRight[1] /= rightLen;
            camRight[2] /= rightLen;
        }

        const v = [0, 0, 0];
        if (this.keys.w) { v[0] += camDir[0]; v[2] += camDir[2]; }
        if (this.keys.s) { v[0] -= camDir[0]; v[2] -= camDir[2]; }
        if (this.keys.a) { v[0] -= camRight[0]; v[2] -= camRight[2]; }
        if (this.keys.d) { v[0] += camRight[0]; v[2] += camRight[2]; }

        const len = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
        if (len > 0) {
            v[0] /= len;
            v[2] /= len;

            const deltaX = v[0] * MOVE_SPD * dt;
            const deltaZ = v[2] * MOVE_SPD * dt;
            const target_x = this.centerPos[0] + deltaX;
            const target_z = this.centerPos[2] + deltaZ;
            const tx = Math.floor(target_x), tz = Math.floor(target_z);
            const cxi = Math.floor(this.centerPos[0]), czi = Math.floor(this.centerPos[2]);

            if (tx >= 0 && tx < WORLD_SIZE && tz >= 0 && tz < WORLD_SIZE) {
                const h_diff = server.heights[tx + tz * WORLD_SIZE] - server.heights[cxi + czi * WORLD_SIZE];
                if (h_diff <= STEP_HEIGHT) {
                    this.centerPos[0] = target_x;
                    this.centerPos[2] = target_z;

                    for (const voxel of this.bodyVoxels) {
                        voxel.pos[0] += deltaX;
                        voxel.pos[2] += deltaZ;
                    }
                }
            }
        }

        const margin = HALF_W / 16;
        const oldX = this.centerPos[0], oldZ = this.centerPos[2];
        this.centerPos[0] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.centerPos[0]));
        this.centerPos[2] = Math.max(margin, Math.min(WORLD_SIZE - margin, this.centerPos[2]));

        const boundaryDeltaX = this.centerPos[0] - oldX;
        const boundaryDeltaZ = this.centerPos[2] - oldZ;
        if (boundaryDeltaX !== 0 || boundaryDeltaZ !== 0) {
            for (const voxel of this.bodyVoxels) {
                voxel.pos[0] += boundaryDeltaX;
                voxel.pos[2] += boundaryDeltaZ;
            }
        }

        return oldCenter[0] !== this.centerPos[0] || oldCenter[1] !== this.centerPos[1] || oldCenter[2] !== this.centerPos[2];
    }

    jump() {
        if (this.grounded) {
            this.velY = JUMP_SPEED;
            this.grounded = false;
            console.log(`🚀 Player ${this.id} jumped!`);
        }
    }

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
}

// ===== MULTIPLAYER VOXEL SERVER CLASS =====
class MultiplayerVoxelServer {
    constructor() {
        this.initializeWorld();
        this.lastUpdate = Date.now() / 1000;

        this.players = new Map();
        this.clients = new Map();
        this.nextPlayerId = 1;
        this.movingVoxels = [];

        this.debugInfo = {
            activeVoxels: 0,
            totalShots: 0,
            lastShot: 'Never',
            totalPlayers: 0,
            playerVoxels: 0
        };

        console.log('🖥️ Multiplayer Voxel Server initialized - PLAYERS EXCLUDED FROM OWN MESH');
    }

    initializeWorld() {
        this.world = new Uint8Array(WORLD_SIZE * WORLD_SIZE * WORLD_SIZE);
        this.heights = new Int32Array(WORLD_SIZE * WORLD_SIZE);

        const base = Math.floor(WORLD_SIZE / 4);
        for (let x = 0; x < WORLD_SIZE; x++) {
            for (let z = 0; z < WORLD_SIZE; z++) {
                const t = 16 + Math.floor((Math.random() - 0.5) * 4);
                for (let y = base; y < base + Math.max(1, t); y++) {
                    this.setWorld(x, y, z, 1);
                }

                let h = 0;
                for (let y = 0; y < WORLD_SIZE; y++) {
                    if (this.getWorld(x, y, z)) h++;
                }
                this.heights[x + z * WORLD_SIZE] = h;
            }
        }

        this.terrainNeedsRebuild = false;
        console.log('🌍 Multiplayer world generated');
    }

    getWorld(x, y, z) {
        if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) return 0;
        return this.world[x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE];
    }

    setWorld(x, y, z, value) {
        if (x < 0 || x >= WORLD_SIZE || y < 0 || y >= WORLD_SIZE || z < 0 || z >= WORLD_SIZE) return false;
        const oldValue = this.world[x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE];
        this.world[x + y * WORLD_SIZE + z * WORLD_SIZE * WORLD_SIZE] = value;
        return oldValue !== value;
    }

    addPlayer(ws) {
        const playerId = `player_${this.nextPlayerId++}`;
        const player = new Player(playerId);
        this.players.set(playerId, player);
        this.clients.set(ws, { playerId, player });

        console.log(`👥 Player ${playerId} connected (${this.players.size} total players)`);

        this.sendToClient(ws, 'playerAssigned', { playerId });
        this.sendInitialState(ws);

        return { playerId, player };
    }

    removePlayer(ws) {
        const clientData = this.clients.get(ws);
        if (clientData) {
            const { playerId } = clientData;
            this.players.delete(playerId);
            this.clients.delete(ws);
            console.log(`👥 Player ${playerId} disconnected (${this.players.size} total players)`);
        }
    }

    handleClientMessage(ws, message) {
        try {
            const { type, data } = JSON.parse(message);
            const clientData = this.clients.get(ws);

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

    handleInput(player, data) {
        switch (data.type) {
            case 'keydown':
                if (data.key === ' ') {
                    player.jump();
                }
                break;

            case 'camera':
                player.yaw = data.yaw;
                player.pitch = data.pitch;
                break;

            case 'shoot':
                this.spawnProjectile(data.cameraPos, data.cameraDir, player.id);
                break;
        }
    }

    handleInputState(player, data) {
        player.keys = { ...data.keys };
    }

    spawnProjectile(pos, dir, throwerId = null) {
        this.debugInfo.totalShots++;
        this.debugInfo.lastShot = new Date().toLocaleTimeString();

        const offset = 2.0;
        const spawnPos = [
            pos[0] + dir[0] * offset,
            pos[1] + dir[1] * offset,
            pos[2] + dir[2] * offset
        ];

        const projectile = new MovingVoxel(spawnPos, dir, true, throwerId);
        this.movingVoxels.push(projectile);

        console.log(`🎯 Projectile spawned by ${throwerId || 'unknown'}! ID: ${projectile.id}, Total: ${this.movingVoxels.length}`);
    }

    startPhysicsLoop() {
        const update = () => {
            const frameStartTime = performance.now();
            const currentTime = Date.now() / 1000;
            const dt = currentTime - this.lastUpdate;
            this.lastUpdate = currentTime;

            const physicsStartTime = performance.now();
            this.updatePhysics(dt);
            const physicsTime = performance.now() - physicsStartTime;

            const updateStartTime = performance.now();
            this.sendUpdates();
            const updateTime = performance.now() - updateStartTime;

            const totalFrameTime = performance.now() - frameStartTime;

            this.totalFrameCount = (this.totalFrameCount || 0) + 1;
            if (this.totalFrameCount % 100 === 0) {
                console.log(`🖥️ Frame timing: Total=${totalFrameTime.toFixed(2)}ms, Physics=${physicsTime.toFixed(2)}ms, Updates=${updateTime.toFixed(2)}ms, Clients=${this.clients.size}, PlayerVoxels=${this.debugInfo.playerVoxels}, MovingVoxels=${this.debugInfo.activeVoxels}`);
            }

            setTimeout(update, 1000 / 50);
        };
        update();

        console.log('🔄 Multiplayer physics loop started at 50Hz');
    }

    updatePhysics(dt) {
        const startTime = performance.now();
        let anyChanges = false;

        const playerStartTime = performance.now();
        for (const [playerId, player] of this.players.entries()) {
            const moved = player.updatePhysics(dt, this);
            if (moved) anyChanges = true;
        }
        const playerTime = performance.now() - playerStartTime;

        const voxelStartTime = performance.now();
        for (let i = this.movingVoxels.length - 1; i >= 0; i--) {
            const voxel = this.movingVoxels[i];
            const result = voxel.update(dt, this.movingVoxels, this);

            if (result === 'settled') {
                console.log(`🔄 Voxel settled and removed! ID: ${voxel.id}, Remaining: ${this.movingVoxels.length - 1}`);
                this.movingVoxels.splice(i, 1);
                anyChanges = true;
            } else if (result === 'continue') {
                anyChanges = true;
            }
        }
        const voxelTime = performance.now() - voxelStartTime;

        const terrainStartTime = performance.now();
        if (this.terrainNeedsRebuild) {
            this.rebuildTerrain();
            this.terrainNeedsRebuild = false;
            anyChanges = true;
        }
        const terrainTime = performance.now() - terrainStartTime;

        this.debugInfo.activeVoxels = this.movingVoxels.length;
        this.debugInfo.totalPlayers = this.players.size;
        this.debugInfo.playerVoxels = Array.from(this.players.values()).reduce((sum, player) => sum + player.bodyVoxels.length, 0);

        const totalTime = performance.now() - startTime;

        this.frameCount = (this.frameCount || 0) + 1;
        if (this.frameCount % 100 === 0) {
            console.log(`⏱️ Physics timing: Total=${totalTime.toFixed(2)}ms, Players=${playerTime.toFixed(2)}ms, Voxels=${voxelTime.toFixed(2)}ms, Terrain=${terrainTime.toFixed(2)}ms, PlayerVoxels=${this.debugInfo.playerVoxels}`);
        }

        if (anyChanges) {
            this.broadcastToClients('debugUpdate', this.debugInfo);
        }
    }

    rebuildTerrain() {
        for (let x = 0; x < WORLD_SIZE; x++) {
            for (let z = 0; z < WORLD_SIZE; z++) {
                let h = 0;
                for (let y = 0; y < WORLD_SIZE; y++) {
                    if (this.getWorld(x, y, z)) h++;
                }
                this.heights[x + z * WORLD_SIZE] = h;
            }
        }
    }

    // ===== MESH GENERATION WITH PLAYER EXCLUSION =====
    generateMeshForClient(excludePlayerId) {
        const vertices = [], normals = [], colors = [], indices = [];

        // ===== TERRAIN MESH =====
        const base = Math.floor(WORLD_SIZE / 4);
        for (let x = 0; x < WORLD_SIZE; x++) {
            for (let z = 0; z < WORLD_SIZE; z++) {
                const h = this.heights[x + z * WORLD_SIZE];
                if (h === 0) continue;

                const y1 = base + h;
                const c = [0.6, 0.6, 0.6];

                this.addFace(vertices, normals, colors, indices,
                    [x, y1, z], [x + 1, y1, z], [x + 1, y1, z + 1], [x, y1, z + 1],
                    [0, 1, 0], c);

                const sides = [
                    { dx: 1, dz: 0, norm: [1, 0, 0] },
                    { dx: -1, dz: 0, norm: [-1, 0, 0] },
                    { dx: 0, dz: 1, norm: [0, 0, 1] },
                    { dx: 0, dz: -1, norm: [0, 0, -1] }
                ];

                for (const side of sides) {
                    const nx = x + side.dx, nz = z + side.dz;
                    const h2 = (nx >= 0 && nx < WORLD_SIZE && nz >= 0 && nz < WORLD_SIZE) ? 
                        this.heights[nx + nz * WORLD_SIZE] : 0;

                    if (h2 < h) {
                        if (side.dx === 1) {
                            this.addFace(vertices, normals, colors, indices,
                                [x + 1, base + h2, z], [x + 1, base + h2, z + 1], 
                                [x + 1, y1, z + 1], [x + 1, y1, z], side.norm, c);
                        } else if (side.dx === -1) {
                            this.addFace(vertices, normals, colors, indices,
                                [x, base + h2, z + 1], [x, base + h2, z], 
                                [x, y1, z], [x, y1, z + 1], side.norm, c);
                        } else if (side.dz === 1) {
                            this.addFace(vertices, normals, colors, indices,
                                [x, base + h2, z + 1], [x + 1, base + h2, z + 1], 
                                [x + 1, y1, z + 1], [x, y1, z + 1], side.norm, c);
                        } else {
                            this.addFace(vertices, normals, colors, indices,
                                [x + 1, base + h2, z], [x, base + h2, z], 
                                [x, y1, z], [x + 1, y1, z], side.norm, c);
                        }
                    }
                }
            }
        }

        // ===== PLAYER VOXELS AS TERRAIN (EXCLUDE OWN PLAYER) =====
        console.log(`🧱 Adding ${this.players.size} players to terrain mesh with greedy meshing (excluding ${excludePlayerId})...`);
        let totalPlayerVoxelsAdded = 0;

        for (const [playerId, player] of this.players.entries()) {
            if (playerId === excludePlayerId) {
                console.log(`🚫 EXCLUDING own player ${playerId} from mesh generation`);
                continue;
            }

            const playerColor = [1.0, 0.5, 0.0]; // Orange
            
            console.log(`🎨 Greedy meshing player ${playerId} with ${player.bodyVoxels.length} voxels (color: orange)`);
            
            const playerMesh = this.generateGreedyPlayerMesh(player);
            
            for (let i = 0; i < playerMesh.vertices.length; i += 3) {
                vertices.push(playerMesh.vertices[i], playerMesh.vertices[i + 1], playerMesh.vertices[i + 2]);
                normals.push(playerMesh.normals[i], playerMesh.normals[i + 1], playerMesh.normals[i + 2]);
                colors.push(playerColor[0], playerColor[1], playerColor[2]);
            }
            
            const indexOffset = (vertices.length - playerMesh.vertices.length) / 3;
            for (const index of playerMesh.indices) {
                indices.push(index + indexOffset);
            }
            
            totalPlayerVoxelsAdded += playerMesh.vertices.length / 3;
        }

        console.log(`✅ Terrain mesh complete for ${excludePlayerId}: ${vertices.length/3} vertices, ${indices.length/3} triangles (${totalPlayerVoxelsAdded} player vertices with greedy meshing)`);

        return { vertices, normals, colors, indices };
    }

    generateGreedyPlayerMesh(player) {
        if (player.bodyVoxels.length === 0) {
            return { vertices: [], normals: [], indices: [] };
        }

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const voxel of player.bodyVoxels) {
            const x = Math.floor(voxel.pos[0]);
            const y = Math.floor(voxel.pos[1]);
            const z = Math.floor(voxel.pos[2]);
            minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
        }

        const sizeX = maxX - minX + 1;
        const sizeY = maxY - minY + 1;
        const sizeZ = maxZ - minZ + 1;
        const grid = new Array(sizeX * sizeY * sizeZ).fill(false);

        const getGridIndex = (x, y, z) => {
            const gx = x - minX, gy = y - minY, gz = z - minZ;
            if (gx < 0 || gx >= sizeX || gy < 0 || gy >= sizeY || gz < 0 || gz >= sizeZ) return -1;
            return gx + gy * sizeX + gz * sizeX * sizeY;
        };

        for (const voxel of player.bodyVoxels) {
            const x = Math.floor(voxel.pos[0]);
            const y = Math.floor(voxel.pos[1]);
            const z = Math.floor(voxel.pos[2]);
            const index = getGridIndex(x, y, z);
            if (index >= 0) grid[index] = true;
        }

        const vertices = [], normals = [], indices = [];

        const faces = [
            { dir: [1, 0, 0], norm: [1, 0, 0] },
            { dir: [-1, 0, 0], norm: [-1, 0, 0] },
            { dir: [0, 1, 0], norm: [0, 1, 0] },
            { dir: [0, -1, 0], norm: [0, -1, 0] },
            { dir: [0, 0, 1], norm: [0, 0, 1] },
            { dir: [0, 0, -1], norm: [0, 0, -1] }
        ];

        for (const face of faces) {
            const [dx, dy, dz] = face.dir;
            const norm = face.norm;

            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    for (let z = minZ; z <= maxZ; z++) {
                        const currentIndex = getGridIndex(x, y, z);
                        if (currentIndex < 0 || !grid[currentIndex]) continue;

                        const nx = x + dx, ny = y + dy, nz = z + dz;
                        const neighborIndex = getGridIndex(nx, ny, nz);
                        const hasNeighbor = (neighborIndex >= 0 && grid[neighborIndex]);

                        if (!hasNeighbor) {
                            this.addPlayerFace(vertices, normals, indices, x, y, z, norm);
                        }
                    }
                }
            }
        }

        console.log(`🏗️ Player mesh: ${player.bodyVoxels.length} voxels → ${vertices.length/3} vertices (${vertices.length/12} faces) - ${((1 - vertices.length/12/(player.bodyVoxels.length * 6)) * 100).toFixed(1)}% faces removed`);

        return { vertices, normals, indices };
    }

    addPlayerFace(vertices, normals, indices, x, y, z, norm) {
        const [nx, ny, nz] = norm;
        let v0, v1, v2, v3;

        if (nx === 1) {
            v0 = [x + 1, y, z];
            v1 = [x + 1, y, z + 1];
            v2 = [x + 1, y + 1, z + 1];
            v3 = [x + 1, y + 1, z];
        } else if (nx === -1) {
            v0 = [x, y, z + 1];
            v1 = [x, y, z];
            v2 = [x, y + 1, z];
            v3 = [x, y + 1, z + 1];
        } else if (ny === 1) {
            v0 = [x, y + 1, z];
            v1 = [x + 1, y + 1, z];
            v2 = [x + 1, y + 1, z + 1];
            v3 = [x, y + 1, z + 1];
        } else if (ny === -1) {
            v0 = [x, y, z + 1];
            v1 = [x + 1, y, z + 1];
            v2 = [x + 1, y, z];
            v3 = [x, y, z];
        } else if (nz === 1) {
            v0 = [x, y, z + 1];
            v1 = [x, y + 1, z + 1];
            v2 = [x + 1, y + 1, z + 1];
            v3 = [x + 1, y, z + 1];
        } else {
            v0 = [x + 1, y, z];
            v1 = [x + 1, y + 1, z];
            v2 = [x, y + 1, z];
            v3 = [x, y, z];
        }

        const i0 = vertices.length / 3;
        [v0, v1, v2, v3].forEach(v => {
            vertices.push(v[0], v[1], v[2]);
            normals.push(nx, ny, nz);
        });

        indices.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }

    addFace(vertices, normals, colors, indices, v0, v1, v2, v3, n, color) {
        const i0 = vertices.length / 3;
        [v0, v1, v2, v3].forEach(v => {
            vertices.push(v[0], v[1], v[2]);
            normals.push(n[0], n[1], n[2]);
            colors.push(color[0], color[1], color[2]);
        });

        indices.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }

    sendInitialState(ws) {
        const clientData = this.clients.get(ws);
        const excludePlayerId = clientData ? clientData.playerId : null;
        const meshData = this.generateMeshForClient(excludePlayerId);

        const allVoxels = [...this.movingVoxels];

        this.sendToClient(ws, 'renderUpdate', {
            ...meshData,
            allVoxels: allVoxels.map(v => ({
                pos: [...v.pos],
                isProjectile: v.isProjectile,
                isPlayerVoxel: v.isPlayerVoxel || false,
                playerId: v.playerId || null,
                id: v.id
            }))
        });

        const playersData = {};
        for (const [playerId, player] of this.players.entries()) {
            playersData[playerId] = player.getPositionData();
        }
        this.sendToClient(ws, 'playersUpdate', { players: playersData });

        if (clientData) {
            this.sendToClient(ws, 'cameraUpdate', { pos: clientData.player.centerPos });
        }

        this.sendToClient(ws, 'debugUpdate', this.debugInfo);

        console.log(`📤 Sent terrain+players mesh to ${excludePlayerId}: ${meshData.vertices.length/3} vertices (EXCLUDED OWN PLAYER)`);
    }

    sendUpdates() {
        if (this.clients.size === 0) return;

        const startTime = performance.now();

        const voxelStartTime = performance.now();
        const allVoxels = [...this.movingVoxels];
        const voxelTime = performance.now() - voxelStartTime;

        const serializeStartTime = performance.now();
        const voxelData = allVoxels.map(v => ({
            pos: [...v.pos],
            isProjectile: v.isProjectile,
            isPlayerVoxel: v.isPlayerVoxel || false,
            playerId: v.playerId || null,
            id: v.id
        }));
        const serializeTime = performance.now() - serializeStartTime;

        const meshStartTime = performance.now();
        for (const [ws, clientData] of this.clients.entries()) {
            const meshData = this.generateMeshForClient(clientData.playerId);
            this.sendToClient(ws, 'renderUpdate', { ...meshData, allVoxels: voxelData });
        }
        const meshTime = performance.now() - meshStartTime;

        const playersData = {};
        for (const [playerId, player] of this.players.entries()) {
            playersData[playerId] = player.getPositionData();
        }
        this.broadcastToClients('playersUpdate', { players: playersData });

        for (const [ws, clientData] of this.clients.entries()) {
            this.sendToClient(ws, 'cameraUpdate', { pos: clientData.player.centerPos });
        }

        const totalTime = performance.now() - startTime;

        this.sendFrameCount = (this.sendFrameCount || 0) + 1;
        if (this.sendFrameCount % 100 === 0) {
            console.log(`📡 Send timing: Total=${totalTime.toFixed(2)}ms, IndividualMesh=${meshTime.toFixed(2)}ms, VoxelCollect=${voxelTime.toFixed(2)}ms, Serialize=${serializeTime.toFixed(2)}ms, PlayerVoxels=${this.debugInfo.playerVoxels}, MovingVoxels=${allVoxels.length}`);
        }
    }

    sendToClient(ws, type, data) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, data, timestamp: Date.now() }));
        }
    }

    broadcastToClients(type, data) {
        const message = JSON.stringify({ type, data, timestamp: Date.now() });
        for (const [ws, clientData] of this.clients.entries()) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
}

// ===== WEBSOCKET SERVER SETUP =====
const server = new MultiplayerVoxelServer();
const wss = new WebSocket.Server({ port: 8765, host: '0.0.0.0' });

wss.on('connection', (ws, req) => {
    console.log(`🔌 New connection from ${req.socket.remoteAddress}`);

    ws.on('message', (message) => {
        server.handleClientMessage(ws, message.toString());
    });

    ws.on('close', () => {
        server.removePlayer(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        server.removePlayer(ws);
    });
});

server.startPhysicsLoop();

console.log('🚀 Multiplayer Voxel Physics Server Started!');
console.log('📡 WebSocket server listening on ws://localhost:8765');
console.log('👥 Multiplayer: Each tab = unique voxel player');
console.log('⚡ Physics: 50 TPS with voxel-based players');
console.log('🧱 Players: Solid cube bodies (16x32x16 = 8192 voxels server-side)');
console.log('🎨 FIXED: Players now render as greedy-meshed hollow shells (OPTIMIZED PIPELINE)');
console.log('🚫 FIXED: Each client receives mesh WITHOUT their own player body');
console.log('📤 Network: Individual meshes per client (excluding own player)');
console.log('💥 Impact: Player voxels can be shot off');
console.log('👀 Client: Perfect first-person view (own body DOES NOT EXIST in mesh)');
console.log('');
console.log('To run:');
console.log('1. npm install ws');
console.log('2. node server.js');
console.log('3. Open multiple tabs of client.html');
console.log('');