// Shared constants for both client and server
// These values control the core game mechanics

// === WORLD SETTINGS ===
export const WORLD_SIZE = 128; // World is 128x128x128 voxels
export const WORLD_BASE_HEIGHT = Math.floor(WORLD_SIZE / 4); // Terrain starts at height 32

// === PLAYER PHYSICS ===
export const MOVE_SPEED = 15.0; // How fast players move
export const JUMP_SPEED = 18.0; // Initial velocity when jumping
export const GRAVITY = 40.0; // How fast things fall

// === PLAYER BODY DIMENSIONS ===
export const PLAYER_HALF_WIDTH = 8; // Player is 16 voxels wide
export const PLAYER_HALF_HEIGHT = 16; // Player is 32 voxels tall
export const STEP_HEIGHT = 6; // Max height player can step up

// === PHYSICS ===
export const SETTLE_SPEED_THRESHOLD = 3.0; // When moving voxels stop and become terrain
export const VOXEL_SIZE = 0.45; // Size of individual voxels for collision
export const PLAYER_VOXEL_DESTRUCTION_THRESHOLD = 15; // Minimum velocity to destroy player voxels

// === NETWORK ===
export const SERVER_TICK_RATE = 50; // Server physics runs at 50 TPS
export const CLIENT_INPUT_RATE = 20; // Send input to server at 20 Hz
export const INTERPOLATION_DELAY = 60; // Render 60ms behind server for smooth interpolation

// === RENDERING ===
export const MOUSE_SENSITIVITY = 0.002; // Mouse look sensitivity
export const MAX_RENDER_DISTANCE = 200; // Don't render voxels beyond this distance
export const FIRST_PERSON_FILTER_DISTANCE = 3.0; // Hide voxels within this distance of camera

// === COLORS ===
export const COLORS = {
    TERRAIN: [0.6, 0.6, 0.6], // Gray terrain
    PLAYER: [1.0, 0.5, 0.0], // Orange players
    PROJECTILE: [0, 1, 0], // Green projectiles  
    DEBRIS: [1, 1, 0], // Yellow debris
    LIGHT: [1.0, 1.0, 1.0], // White light
    AMBIENT: [0.4, 0.4, 0.4], // Ambient lighting
    SKY: [0.5, 0.7, 1.0] // Light blue sky
};

// === TERRAIN CHUNKING ===
export const CHUNK_SIZE = 16; // 16x16 chunks (128/16 = 8x8 chunks total)
export const CHUNKS_PER_AXIS = Math.ceil(WORLD_SIZE / CHUNK_SIZE);

// === SERVER BATCHING ===
export const MESH_UPDATE_INTERVAL = 300; // Minimum 300ms between updates
export const DEBRIS_SETTLE_TIME = 1200; // Wait 1.2s for debris to settle before final update
export const MAX_DEBRIS_UPDATES = 3; // Max debris-triggered updates before waiting for settle

// === DEBUGGING ===
export const DEBUG = {
    LOG_FRAME_TIMING: 100, // Log performance every N frames
    LOG_SLOW_OPERATIONS: 5, // Log operations slower than N milliseconds
    PING_INTERVAL: 2000 // Send ping every 2 seconds
};