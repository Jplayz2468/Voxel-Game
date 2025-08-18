// MeshGenerator class - converts voxel data into optimized 3D meshes
// Uses "greedy meshing" to combine adjacent faces and reduce polygon count

import { WORLD_SIZE, COLORS } from './constants.js';

export class MeshGenerator {
    constructor() {
        this.base = Math.floor(WORLD_SIZE / 4); // Terrain base height
    }

    /**
     * Generates separate terrain and player mesh data for a client
     * Keeps terrain and players separate so positions can be updated independently
     */
    generateMeshForClient(world, players, excludePlayerId) {
        const terrainVertices = [], terrainNormals = [], terrainColors = [], terrainIndices = [];

        // Generate terrain mesh
        this.generateTerrainMesh(world, terrainVertices, terrainNormals, terrainColors, terrainIndices);

        // Generate player template meshes (at origin positions)
        const playerMeshes = this.generatePlayerTemplates(players, excludePlayerId);

        console.log(`✅ Mesh generated for ${excludePlayerId}: ${terrainVertices.length/3} terrain vertices, ${playerMeshes.length} players`);

        return { 
            vertices: terrainVertices, 
            normals: terrainNormals, 
            colors: terrainColors, 
            indices: terrainIndices,
            playerMeshes: playerMeshes
        };
    }

    /**
     * Generates the terrain mesh from the voxel world
     * Creates the landscape that players walk on
     */
    generateTerrainMesh(world, vertices, normals, colors, indices) {
        for (let x = 0; x < WORLD_SIZE; x++) {
            for (let z = 0; z < WORLD_SIZE; z++) {
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
    }

    /**
     * Adds side faces for terrain where there are height differences
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
     * Generates meshes for all players except the excluded one
     * Each player appears as an orange voxel structure
     */
    generatePlayerMeshes(players, excludePlayerId, vertices, normals, colors, indices) {
        console.log(`🧱 Adding ${players.size} players to mesh with greedy meshing (excluding ${excludePlayerId})...`);
        
        let totalPlayerVoxelsAdded = 0;

        for (const [playerId, player] of players.entries()) {
            if (playerId === excludePlayerId) {
                console.log(`🚫 EXCLUDING own player ${playerId} from mesh generation`);
                continue;
            }

            console.log(`🎨 Greedy meshing player ${playerId} with ${player.bodyVoxels.length} voxels`);
            
            const playerMesh = this.generateGreedyPlayerMesh(player);
            
            // Add player mesh to main mesh with orange color
            const indexOffset = vertices.length / 3;
            
            for (let i = 0; i < playerMesh.vertices.length; i += 3) {
                vertices.push(playerMesh.vertices[i], playerMesh.vertices[i + 1], playerMesh.vertices[i + 2]);
                normals.push(playerMesh.normals[i], playerMesh.normals[i + 1], playerMesh.normals[i + 2]);
                colors.push(COLORS.PLAYER[0], COLORS.PLAYER[1], COLORS.PLAYER[2]); // Orange
            }
            
            for (const index of playerMesh.indices) {
                indices.push(index + indexOffset);
            }
            
            totalPlayerVoxelsAdded += playerMesh.vertices.length / 3;
        }

        console.log(`✅ Added ${totalPlayerVoxelsAdded} player vertices with greedy meshing`);
    }

    /**
     * Generates player mesh templates at origin positions
     * Each player mesh includes the playerId for positioning on client
     */
    generatePlayerTemplates(players, excludePlayerId) {
        const playerMeshes = [];
        
        for (const [playerId, player] of players.entries()) {
            if (playerId === excludePlayerId) {
                console.log(`🚫 EXCLUDING own player ${playerId} from template generation`);
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
     * Generates an optimized mesh for a single player at origin position
     * Used for creating templates that can be positioned by client
     */
    generateGreedyPlayerMeshAtOrigin(player) {
        if (player.bodyVoxels.length === 0) {
            return { vertices: [], normals: [], indices: [] };
        }

        // Create a copy of player with voxels centered around origin
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

    /**
     * Generates an optimized mesh for a single player using greedy meshing
     * Only creates exterior faces, making a hollow shell
     */
    generateGreedyPlayerMesh(player) {
        if (player.bodyVoxels.length === 0) {
            return { vertices: [], normals: [], indices: [] };
        }

        // Find bounding box of player voxels
        const bounds = this.getPlayerBounds(player);
        
        // Create a 3D grid of the player's voxels
        const grid = this.createPlayerVoxelGrid(player, bounds);
        
        // Generate mesh using greedy meshing
        const mesh = this.greedyMeshPlayerGrid(grid, bounds);
        
        console.log(`🏗️ Player mesh: ${player.bodyVoxels.length} voxels → ${mesh.vertices.length/3} vertices (${mesh.vertices.length/12} faces) - ${((1 - mesh.vertices.length/12/(player.bodyVoxels.length * 6)) * 100).toFixed(1)}% faces removed`);
        
        return mesh;
    }

    /**
     * Calculates the bounding box of a player's voxels
     */
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

    /**
     * Creates a 3D boolean grid representing which positions have voxels
     */
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

    /**
     * Performs greedy meshing on the player voxel grid
     * Only generates faces that are on the exterior (hollow shell)
     */
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

    /**
     * Adds a single face for a player voxel
     */
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
     * A face is made of 4 vertices forming 2 triangles
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
     * Generates mesh data for moving voxels (projectiles and debris)
     * These are rendered separately from the main terrain mesh
     */
    generateMovingVoxelMesh(voxels) {
        const vertices = [], normals = [], colors = [], indices = [];

        for (const voxel of voxels) {
            let color;
            if (voxel.isProjectile) {
                color = COLORS.PROJECTILE; // Green
            } else {
                color = COLORS.DEBRIS; // Yellow
            }

            this.addVoxelCube(vertices, normals, colors, indices, voxel.pos, color);
        }

        return { vertices, normals, colors, indices };
    }

    /**
     * Adds a complete cube (6 faces) for a single voxel
     */
    addVoxelCube(vertices, normals, colors, indices, pos, color) {
        const [x, y, z] = pos;
        const s = 0.5; // Half size of voxel

        // Define all 6 faces of the cube
        const faces = [
            { verts: [[x-s,y-s,z+s], [x+s,y-s,z+s], [x+s,y+s,z+s], [x-s,y+s,z+s]], norm: [0,0,1] },  // Front
            { verts: [[x+s,y-s,z-s], [x-s,y-s,z-s], [x-s,y+s,z-s], [x+s,y+s,z-s]], norm: [0,0,-1] }, // Back
            { verts: [[x-s,y+s,z-s], [x-s,y+s,z+s], [x+s,y+s,z+s], [x+s,y+s,z-s]], norm: [0,1,0] },  // Top
            { verts: [[x-s,y-s,z+s], [x-s,y-s,z-s], [x+s,y-s,z-s], [x+s,y-s,z+s]], norm: [0,-1,0] }, // Bottom
            { verts: [[x+s,y-s,z+s], [x+s,y-s,z-s], [x+s,y+s,z-s], [x+s,y+s,z+s]], norm: [1,0,0] },  // Right
            { verts: [[x-s,y-s,z-s], [x-s,y-s,z+s], [x-s,y+s,z+s], [x-s,y+s,z-s]], norm: [-1,0,0] }  // Left
        ];

        for (const face of faces) {
            this.addFace(vertices, normals, colors, indices, 
                face.verts[0], face.verts[1], face.verts[2], face.verts[3], 
                face.norm, color);
        }
    }

    /**
     * Optimizes a mesh by removing duplicate vertices
     * This can significantly reduce mesh size
     */
    optimizeMesh(vertices, normals, colors, indices) {
        const vertexMap = new Map();
        const newVertices = [], newNormals = [], newColors = [];
        const newIndices = [];

        for (let i = 0; i < indices.length; i++) {
            const oldIndex = indices[i];
            const vertexKey = `${vertices[oldIndex*3]},${vertices[oldIndex*3+1]},${vertices[oldIndex*3+2]}`;
            
            if (vertexMap.has(vertexKey)) {
                // Reuse existing vertex
                newIndices.push(vertexMap.get(vertexKey));
            } else {
                // Add new vertex
                const newIndex = newVertices.length / 3;
                newVertices.push(vertices[oldIndex*3], vertices[oldIndex*3+1], vertices[oldIndex*3+2]);
                newNormals.push(normals[oldIndex*3], normals[oldIndex*3+1], normals[oldIndex*3+2]);
                newColors.push(colors[oldIndex*3], colors[oldIndex*3+1], colors[oldIndex*3+2]);
                vertexMap.set(vertexKey, newIndex);
                newIndices.push(newIndex);
            }
        }

        const originalCount = vertices.length / 3;
        const optimizedCount = newVertices.length / 3;
        console.log(`🔧 Mesh optimized: ${originalCount} → ${optimizedCount} vertices (${((1-optimizedCount/originalCount)*100).toFixed(1)}% reduction)`);

        return {
            vertices: newVertices,
            normals: newNormals, 
            colors: newColors,
            indices: newIndices
        };
    }
}