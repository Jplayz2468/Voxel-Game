// 3D Math utilities for the voxel game
// Handles matrix operations, transformations, and 3D math

/**
 * Creates a perspective projection matrix
 * Used to make distant objects appear smaller (3D perspective)
 */
export function createPerspectiveMatrix(fovy, aspect, near, far) {
    const out = new Float32Array(16);
    const f = 1.0 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    
    return out;
}

/**
 * Creates a "look at" matrix for the camera
 * Points the camera from 'eye' position toward 'center' position
 */
export function createLookAtMatrix(eye, center, up) {
    const out = new Float32Array(16);
    
    // Calculate the forward direction (from eye to center)
    let z0 = eye[0] - center[0];
    let z1 = eye[1] - center[1]; 
    let z2 = eye[2] - center[2];
    
    // Normalize the forward vector
    let len = 1 / Math.sqrt(z0*z0 + z1*z1 + z2*z2);
    z0 *= len; z1 *= len; z2 *= len;

    // Calculate the right direction (cross product of up and forward)
    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    
    len = Math.sqrt(x0*x0 + x1*x1 + x2*x2);
    if (len) { 
        len = 1 / len; 
        x0 *= len; x1 *= len; x2 *= len; 
    }

    // Calculate the actual up direction (cross product of forward and right)
    let y0 = z1 * x2 - z2 * x1;
    let y1 = z2 * x0 - z0 * x2;
    let y2 = z0 * x1 - z1 * x0;
    
    len = Math.sqrt(y0*y0 + y1*y1 + y2*y2);
    if (len) { 
        len = 1 / len; 
        y0 *= len; y1 *= len; y2 *= len; 
    }

    // Build the matrix
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    
    return out;
}

/**
 * Creates a normal matrix from a model-view matrix
 * Used for proper lighting calculations
 */
export function normalFromMat4(a) {
    const out = new Float32Array(9);
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[4], a11 = a[5], a12 = a[6];
    const a20 = a[8], a21 = a[9], a22 = a[10];

    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;

    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (!det) return out;
    det = 1.0 / det;

    out[0] = b01 * det;
    out[1] = (-a22 * a01 + a02 * a21) * det;
    out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = b11 * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[5] = (-a12 * a00 + a02 * a10) * det;
    out[6] = b21 * det;
    out[7] = (-a21 * a00 + a01 * a20) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;
    
    return out;
}

/**
 * Creates a 4x4 identity matrix (no transformation)
 */
export function createIdentityMatrix() {
    const out = new Float32Array(16);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
}

/**
 * Creates a 3x3 identity matrix (no transformation)
 */
export function createIdentityMatrix3() {
    const out = new Float32Array(9);
    out[0] = out[4] = out[8] = 1;
    return out;
}

/**
 * Transforms a 3D world position through view and projection matrices
 * Returns the position in clip space coordinates
 */
export function transformVec4(pos, viewMatrix, projMatrix) {
    // First transform by view matrix
    const viewPos = [
        viewMatrix[0] * pos[0] + viewMatrix[4] * pos[1] + viewMatrix[8] * pos[2] + viewMatrix[12],
        viewMatrix[1] * pos[0] + viewMatrix[5] * pos[1] + viewMatrix[9] * pos[2] + viewMatrix[13],
        viewMatrix[2] * pos[0] + viewMatrix[6] * pos[1] + viewMatrix[10] * pos[2] + viewMatrix[14],
        viewMatrix[3] * pos[0] + viewMatrix[7] * pos[1] + viewMatrix[11] * pos[2] + viewMatrix[15]
    ];

    // Then transform by projection matrix
    return [
        projMatrix[0] * viewPos[0] + projMatrix[4] * viewPos[1] + projMatrix[8] * viewPos[2] + projMatrix[12] * viewPos[3],
        projMatrix[1] * viewPos[0] + projMatrix[5] * viewPos[1] + projMatrix[9] * viewPos[2] + projMatrix[13] * viewPos[3],
        projMatrix[2] * viewPos[0] + projMatrix[6] * viewPos[1] + projMatrix[10] * viewPos[2] + projMatrix[14] * viewPos[3],
        projMatrix[3] * viewPos[0] + projMatrix[7] * viewPos[1] + projMatrix[11] * viewPos[2] + projMatrix[15] * viewPos[3]
    ];
}

/**
 * Converts 3D world coordinates to 2D screen coordinates
 * Returns null if the position is behind the camera or outside the screen
 */
export function worldToScreen(worldPos, viewMatrix, projMatrix, canvasWidth, canvasHeight) {
    const clipPos = transformVec4(worldPos, viewMatrix, projMatrix);
    
    // If behind camera, don't render
    if (clipPos[3] <= 0) return null;

    // Convert to normalized device coordinates (-1 to 1)
    const ndcX = clipPos[0] / clipPos[3];
    const ndcY = clipPos[1] / clipPos[3];

    // If outside screen bounds, don't render
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null;

    // Convert to screen coordinates (0 to canvas size)
    const screenX = (ndcX + 1) * 0.5 * canvasWidth;
    const screenY = (1 - ndcY) * 0.5 * canvasHeight; // Flip Y axis

    return [screenX, screenY];
}

/**
 * Calculates the camera direction vector from yaw and pitch angles
 */
export function getCameraDirection(yaw, pitch) {
    return [
        Math.cos(pitch) * Math.sin(yaw), // X component
        Math.sin(pitch),                 // Y component (up/down)
        Math.cos(pitch) * Math.cos(yaw)  // Z component
    ];
}

/**
 * Calculates the camera's right vector (for strafing left/right)
 */
export function getCameraRight(yaw, pitch) {
    const camDir = getCameraDirection(yaw, pitch);
    const worldUp = [0, 1, 0];
    
    // Cross product of camera direction and world up
    const camRight = [
        camDir[1] * worldUp[2] - camDir[2] * worldUp[1],
        camDir[2] * worldUp[0] - camDir[0] * worldUp[2],
        camDir[0] * worldUp[1] - camDir[1] * worldUp[0]
    ];

    // Normalize the result
    const rightLen = Math.sqrt(camRight[0] * camRight[0] + camRight[1] * camRight[1] + camRight[2] * camRight[2]);
    if (rightLen > 0) {
        camRight[0] /= rightLen;
        camRight[1] /= rightLen;
        camRight[2] /= rightLen;
    }

    return camRight;
}

/**
 * Interpolates between two 3D positions by factor t (0 = pos1, 1 = pos2)
 */
export function lerp3D(pos1, pos2, t) {
    return [
        pos1[0] + (pos2[0] - pos1[0]) * t,
        pos1[1] + (pos2[1] - pos1[1]) * t,
        pos1[2] + (pos2[2] - pos1[2]) * t
    ];
}

/**
 * Calculates distance between two 3D points
 */
export function distance3D(pos1, pos2) {
    const dx = pos2[0] - pos1[0];
    const dy = pos2[1] - pos1[1];
    const dz = pos2[2] - pos1[2];
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
}