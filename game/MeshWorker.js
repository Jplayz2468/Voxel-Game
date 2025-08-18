// MeshWorker.js - Web Worker for processing mesh updates off the main thread
// Handles mesh filtering and optimization to prevent main thread blocking

importScripts('./constants.js');

class MeshWorkerProcessor {
    constructor() {
        this.meshUpdatesProcessed = 0;
        console.log('🔧 Mesh worker initialized');
    }

    /**
     * Filters out player voxels too close to the camera
     * This prevents seeing inside your own body in first-person view
     */
    filterNearbyPlayerVoxels(vertices, normals, colors, indices, cameraPos) {
        if (!vertices || vertices.length === 0) {
            return { vertices, normals, colors, indices };
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
                
                // Skip if too close (using constant from constants.js)
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
     * Processes a mesh update request
     */
    processMeshUpdate(data) {
        const startTime = performance.now();
        this.meshUpdatesProcessed++;
        
        const { meshData, cameraPos, updateId, previousMesh } = data;
        
        console.log(`🔄 Worker processing mesh update ${updateId}: ${meshData.vertices.length/3} vertices`);
        
        // Perform heavy mesh filtering
        const filterStartTime = performance.now();
        const filtered = this.filterNearbyPlayerVoxels(
            meshData.vertices || [],
            meshData.normals || [],
            meshData.colors || [],
            meshData.indices || [],
            cameraPos
        );
        const filterTime = performance.now() - filterStartTime;
        
        // Perform delta comparison if we have previous mesh
        let deltaResult = null;
        let deltaTime = 0;
        if (previousMesh && previousMesh.vertices.length > 0) {
            const deltaStartTime = performance.now();
            deltaResult = this.computeMeshDelta(previousMesh, filtered);
            deltaTime = performance.now() - deltaStartTime;
            console.log(`🔍 Worker delta comparison: ${deltaResult.vertexChanges.length} vertices changed (${deltaTime.toFixed(2)}ms)`);
        }
        
        // Calculate statistics
        const originalTriangles = (meshData.indices || []).length / 3;
        const filteredTriangles = filtered.indices.length / 3;
        const hiddenTriangles = originalTriangles - filteredTriangles;
        const hiddenPercent = originalTriangles > 0 ? (hiddenTriangles/originalTriangles*100) : 0;
        
        const totalTime = performance.now() - startTime;
        
        console.log(`⚡ Worker completed mesh update ${updateId}: Filter=${filterTime.toFixed(2)}ms, Delta=${deltaTime.toFixed(2)}ms, Total=${totalTime.toFixed(2)}ms, Hidden=${hiddenTriangles}/${originalTriangles} triangles (${hiddenPercent.toFixed(1)}%)`);
        
        // Return processed mesh data
        return {
            updateId,
            processedMesh: {
                vertices: filtered.vertices,
                normals: filtered.normals,
                colors: filtered.colors,
                indices: filtered.indices,
                indexCount: filtered.indices.length,
                indexType: filtered.indices.length > 65535 ? 'UNSIGNED_INT' : 'UNSIGNED_SHORT'
            },
            deltaResult,
            stats: {
                processingTime: totalTime,
                filterTime,
                deltaTime,
                originalTriangles,
                filteredTriangles,
                hiddenTriangles,
                hiddenPercent
            }
        };
    }

    /**
     * Computes differences between two meshes (same logic as renderer)
     */
    computeMeshDelta(oldMesh, newMesh) {
        const vertexChanges = [];
        
        // Compare vertices (and associated normals/colors)
        const minVertexCount = Math.min(oldMesh.vertices.length, newMesh.vertices.length);
        
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
        
        // Calculate change ratio
        const totalVertices = Math.max(oldMesh.vertices.length, newMesh.vertices.length);
        const changeRatio = vertexChanges.length / (totalVertices / 3);
        
        return {
            vertexChanges,
            indicesChanged,
            changeRatio,
            newSize: {
                vertices: newMesh.vertices.length,
                indices: newMesh.indices.length
            }
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
}

// Create processor instance
const processor = new MeshWorkerProcessor();

// Handle messages from main thread
self.addEventListener('message', function(event) {
    const { type, data } = event.data;
    
    try {
        if (type === 'processMesh') {
            const result = processor.processMeshUpdate(data);
            self.postMessage({
                type: 'meshProcessed',
                data: result
            });
        } else {
            console.warn(`⚠️ Unknown message type: ${type}`);
        }
    } catch (error) {
        console.error('❌ Worker error:', error);
        self.postMessage({
            type: 'meshError',
            data: {
                updateId: data.updateId,
                error: error.message
            }
        });
    }
});

console.log('🚀 Mesh worker ready');