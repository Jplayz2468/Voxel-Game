// InputHandler class - manages keyboard and mouse input for the voxel game
// Handles movement, camera controls, shooting, and special commands

import { MOUSE_SENSITIVITY } from './constants.js';
import { getCameraDirection } from './MathUtils.js';

export class InputHandler {
    constructor(canvas, networkClient, voxelClient) {
        this.canvas = canvas;
        this.networkClient = networkClient;
        this.voxelClient = voxelClient;
        
        // Input state
        this.keys = { w: false, s: false, a: false, d: false };
        this.pointerLocked = false;
        
        // Camera state
        this.camera = {
            yaw: 0,
            pitch: 0.3
        };
        
        // Timing for input updates
        this.lastInputSend = 0;
        
        // Settings
        this.smoothMode = true;
        this.colorMode = false;
        
        this.setupEventListeners();
        
        console.log('🎮 Input handler initialized');
    }

    /**
     * Sets up all input event listeners
     */
    setupEventListeners() {
        this.setupKeyboardEvents();
        this.setupMouseEvents();
        this.setupPointerLockEvents();
    }

    /**
     * Sets up keyboard event handlers
     */
    setupKeyboardEvents() {
        document.addEventListener('keydown', (e) => {
            this.handleKeyDown(e);
        });

        document.addEventListener('keyup', (e) => {
            this.handleKeyUp(e);
        });
    }

    /**
     * Sets up mouse event handlers
     */
    setupMouseEvents() {
        // Mouse movement for camera
        document.addEventListener('mousemove', (e) => {
            this.handleMouseMove(e);
        });

        // Mouse clicks for shooting and pointer lock
        this.canvas.addEventListener('click', (e) => {
            this.handleMouseClick(e);
        });

        // Prevent context menu
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
    }

    /**
     * Sets up pointer lock event handlers
     */
    setupPointerLockEvents() {
        document.addEventListener('pointerlockchange', () => {
            this.pointerLocked = document.pointerLockElement === this.canvas;
            console.log(`🖱️ Pointer lock: ${this.pointerLocked ? 'ON' : 'OFF'}`);
        });
    }

    /**
     * Handles key press events
     */
    handleKeyDown(e) {
        const key = e.key.toLowerCase();

        // Special keys
        if (key === 'escape') {
            this.exitPointerLock();
            return;
        }

        if (key === 't') {
            this.toggleSmoothMode();
            return;
        }

        if (key === 'c') {
            this.toggleColorMode();
            return;
        }

        // Movement keys
        if (key in this.keys && !this.keys[key]) {
            this.keys[key] = true;
            console.log(`🔑 Key pressed: ${key}`);
        }

        // Send input to server
        this.networkClient.sendInput({ type: 'keydown', key });

        // Prevent space bar from scrolling page
        if (key === ' ') {
            e.preventDefault();
        }
    }

    /**
     * Handles key release events
     */
    handleKeyUp(e) {
        const key = e.key.toLowerCase();

        // Movement keys
        if (key in this.keys && this.keys[key]) {
            this.keys[key] = false;
            console.log(`🔑 Key released: ${key}`);
        }

        // Send input to server
        this.networkClient.sendInput({ type: 'keyup', key });
    }

    /**
     * Handles mouse movement for camera control
     */
    handleMouseMove(e) {
        if (!this.pointerLocked) return;

        // Update camera angles
        this.camera.yaw -= e.movementX * MOUSE_SENSITIVITY;
        this.camera.pitch -= e.movementY * MOUSE_SENSITIVITY;
        
        // Clamp pitch to prevent over-rotation
        this.camera.pitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, this.camera.pitch));

        // Send camera update to server
        this.networkClient.sendInput({
            type: 'camera',
            yaw: this.camera.yaw,
            pitch: this.camera.pitch
        });
    }

    /**
     * Handles mouse clicks for shooting and pointer lock
     */
    handleMouseClick(e) {
        e.preventDefault();

        if (!this.pointerLocked) {
            // Request pointer lock if not already locked
            this.requestPointerLock();
        } else {
            // Shoot if pointer is locked
            this.shoot();
        }
    }

    /**
     * Shoots a projectile
     */
    shoot() {
        const cameraPos = this.voxelClient.getCameraPosition();
        const cameraDir = getCameraDirection(this.camera.yaw, this.camera.pitch);

        this.networkClient.sendInput({
            type: 'shoot',
            cameraPos: cameraPos,
            cameraDir: cameraDir
        });

        console.log('🔫 Shot fired!');
    }

    /**
     * Requests pointer lock for mouse control
     */
    requestPointerLock() {
        if (this.canvas.requestPointerLock) {
            this.canvas.requestPointerLock();
        }
    }

    /**
     * Exits pointer lock
     */
    exitPointerLock() {
        if (document.exitPointerLock) {
            document.exitPointerLock();
        }
    }

    /**
     * Toggles smooth interpolation mode
     */
    toggleSmoothMode() {
        this.smoothMode = !this.smoothMode;
        console.log(`🎬 Interpolation mode: ${this.smoothMode ? 'SMOOTH' : 'RAW'}`);
        
        // Notify other systems about the change
        if (this.onSettingsChange) {
            this.onSettingsChange({ smoothMode: this.smoothMode });
        }
    }

    /**
     * Toggles color mode for voxel rendering
     */
    toggleColorMode() {
        this.colorMode = !this.colorMode;
        console.log(`🎨 Color mode: ${this.colorMode ? 'COLORED + DOTS' : 'GRAY ONLY'}`);
        
        // Notify other systems about the change
        if (this.onSettingsChange) {
            this.onSettingsChange({ colorMode: this.colorMode });
        }
    }

    /**
     * Updates input state - called regularly to send movement state to server
     */
    update() {
        const now = performance.now();
        
        // Send input state at regular intervals (20Hz)
        if (now - this.lastInputSend > 50) {
            this.networkClient.sendInputState({ keys: this.keys });
            this.lastInputSend = now;
        }
    }

    /**
     * Gets current camera state
     */
    getCameraState() {
        return {
            yaw: this.camera.yaw,
            pitch: this.camera.pitch
        };
    }

    /**
     * Sets camera state (for external updates)
     */
    setCameraState(yaw, pitch) {
        this.camera.yaw = yaw;
        this.camera.pitch = pitch;
    }

    /**
     * Gets current movement state
     */
    getMovementState() {
        return { ...this.keys };
    }

    /**
     * Gets current settings
     */
    getSettings() {
        return {
            smoothMode: this.smoothMode,
            colorMode: this.colorMode
        };
    }

    /**
     * Sets a callback for when settings change
     */
    onSettingsChanged(callback) {
        this.onSettingsChange = callback;
    }

    /**
     * Checks if pointer is locked
     */
    isPointerLocked() {
        return this.pointerLocked;
    }

    /**
     * Gets input instructions for display
     */
    getInstructions() {
        return [
            'WASD: Move',
            'Mouse: Look around',
            'Space: Jump',
            'Left Click: Shoot voxels',
            'T: Toggle Smooth/Raw mode',
            'C: Toggle Color/Gray mode',
            'ESC: Exit mouse control'
        ];
    }

    /**
     * Handles special debug commands
     */
    handleDebugCommand(command) {
        switch (command.toLowerCase()) {
            case 'fps':
                console.log('📊 FPS counter toggled');
                break;
            case 'stats':
                console.log('📈 Performance stats toggled');
                break;
            case 'wireframe':
                console.log('🔗 Wireframe mode toggled');
                break;
            default:
                console.log(`❓ Unknown debug command: ${command}`);
        }
    }

    /**
     * Resets input state (useful for cleanup)
     */
    reset() {
        this.keys = { w: false, s: false, a: false, d: false };
        this.camera.yaw = 0;
        this.camera.pitch = 0.3;
        
        if (this.pointerLocked) {
            this.exitPointerLock();
        }
        
        console.log('🔄 Input state reset');
    }

    /**
     * Cleanup function
     */
    cleanup() {
        // Remove event listeners would go here if needed
        this.reset();
        console.log('🧹 Input handler cleaned up');
    }
}