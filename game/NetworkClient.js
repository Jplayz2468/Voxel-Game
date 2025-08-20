// NetworkClient class - handles communication with the multiplayer server
// Manages WebSocket connection, message handling, and ping monitoring

import { INTERPOLATION_DELAY, DEBUG } from './constants.js';

export class NetworkClient {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.myPlayerId = null;
        
        // Message handlers
        this.messageHandlers = new Map();
        
        // Ping monitoring
        this.ping = 0;
        this.pingRequests = new Map();
        this.lastPingTime = 0;
        
        // Connection state
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000; // 2 seconds
        
        console.log('Network client initialized');
    }

    /**
     * Connects to the server
     */
    connect(serverUrl = 'ws://localhost:8765') {
        console.log(`Connecting to server: ${serverUrl}`);
        
        try {
            this.ws = new WebSocket(serverUrl);
            this.setupWebSocketHandlers();
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            this.handleConnectionError();
        }
    }

    /**
     * Sets up WebSocket event handlers
     */
    setupWebSocketHandlers() {
        this.ws.onopen = () => {
            console.log('Connected to server!');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.requestInitialState();
            this.notifyConnectionChange(true);
        };

        this.ws.onclose = (event) => {
            console.log(`Disconnected from server (code: ${event.code})`);
            this.connected = false;
            this.notifyConnectionChange(false);
            this.handleDisconnection();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.handleConnectionError();
        };

        this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };
    }

    /**
     * Handles incoming messages from the server
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            const handler = this.messageHandlers.get(message.type);
            
            if (handler) {
                handler(message.data, message.timestamp);
            } else {
                console.warn(`Unhandled message type: ${message.type}`);
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    }

    /**
     * Sends a message to the server
     */
    sendMessage(type, data) {
        if (!this.connected || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(`Cannot send message '${type}': not connected`);
            return false;
        }

        try {
            const message = JSON.stringify({
                type,
                data,
                timestamp: performance.now()
            });
            
            this.ws.send(message);
            return true;
        } catch (error) {
            console.error('Error sending message:', error);
            return false;
        }
    }

    /**
     * Requests initial game state from server
     */
    requestInitialState() {
        this.sendMessage('requestInitialState', {});
    }

    /**
     * Sends input action to server
     */
    sendInput(inputData) {
        this.sendMessage('input', inputData);
    }

    /**
     * Sends input state to server
     */
    sendInputState(stateData) {
        this.sendMessage('inputState', stateData);
    }

    /**
     * Registers a handler for a specific message type
     */
    onMessage(type, handler) {
        this.messageHandlers.set(type, handler);
    }

    /**
     * Removes a message handler
     */
    offMessage(type) {
        this.messageHandlers.delete(type);
    }

    /**
     * Handles server disconnection
     */
    handleDisconnection() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            
            setTimeout(() => {
                this.connect();
            }, this.reconnectDelay);
        } else {
            console.error('Max reconnection attempts reached');
        }
    }

    /**
     * Handles connection errors
     */
    handleConnectionError() {
        this.connected = false;
        this.notifyConnectionChange(false);
    }

    /**
     * Starts ping monitoring
     */
    startPingMonitoring() {
        const pingInterval = setInterval(() => {
            if (!this.connected) {
                clearInterval(pingInterval);
                return;
            }
            
            const now = performance.now();
            if (now - this.lastPingTime > DEBUG.PING_INTERVAL) {
                this.sendPing();
                this.lastPingTime = now;
            }
        }, 1000);
    }

    /**
     * Sends a ping to measure latency
     */
    sendPing() {
        const id = Math.random().toString(36).substr(2, 9);
        this.pingRequests.set(id, performance.now());
        this.sendMessage('ping', { id });
    }

    /**
     * Handles pong response from server
     */
    handlePong(data) {
        const sendTime = this.pingRequests.get(data.id);
        if (sendTime) {
            this.ping = performance.now() - sendTime;
            this.pingRequests.delete(data.id);
            
            if (this.onPingUpdate) {
                this.onPingUpdate(this.ping);
            }
        }
    }

    /**
     * Gets current ping
     */
    getPing() {
        return this.ping;
    }

    /**
     * Gets connection status
     */
    isConnected() {
        return this.connected;
    }

    /**
     * Gets player ID assigned by server
     */
    getPlayerId() {
        return this.myPlayerId;
    }

    /**
     * Sets player ID (called when server assigns it)
     */
    setPlayerId(playerId) {
        this.myPlayerId = playerId;
        console.log(`Player ID assigned: ${playerId}`);
    }

    /**
     * Sets callback for connection status changes
     */
    onConnectionChange(callback) {
        this.connectionChangeCallback = callback;
    }

    /**
     * Sets callback for ping updates
     */
    onPingChanged(callback) {
        this.onPingUpdate = callback;
    }

    /**
     * Notifies about connection status changes
     */
    notifyConnectionChange(connected) {
        if (this.connectionChangeCallback) {
            this.connectionChangeCallback(connected);
        }
    }

    /**
     * Gets connection statistics
     */
    getConnectionStats() {
        return {
            connected: this.connected,
            ping: this.ping,
            playerId: this.myPlayerId,
            reconnectAttempts: this.reconnectAttempts,
            pendingPings: this.pingRequests.size
        };
    }

    /**
     * Cleanup and disconnect
     */
    disconnect() {
        if (this.ws) {
            console.log('Disconnecting from server...');
            this.connected = false;
            this.ws.close();
            this.ws = null;
        }
    }
}

/**
 * InterpolationSystem class - handles smooth movement interpolation
 * Stores snapshots of game state and interpolates between them
 */
export class InterpolationSystem {
    constructor() {
        this.voxelSnapshots = [];
        this.cameraSnapshots = [];
        this.playerSnapshots = [];
        
        this.renderDelay = INTERPOLATION_DELAY;
        this.maxSnapshots = 10;
        this.smoothMode = true;
        
        console.log('Interpolation system initialized');
    }

    /**
     * Adds a snapshot of moving voxels
     */
    addVoxelSnapshot(time, voxels) {
        this.voxelSnapshots.push({ time, voxels: [...voxels] });
        this.cleanupOldSnapshots(this.voxelSnapshots);
    }

    /**
     * Adds a snapshot of camera position
     */
    addCameraSnapshot(time, position) {
        this.cameraSnapshots.push({ time, pos: [...position] });
        this.cleanupOldSnapshots(this.cameraSnapshots);
    }

    /**
     * Adds a snapshot of player positions
     */
    addPlayerSnapshot(time, players) {
        this.playerSnapshots.push({ time, players: { ...players } });
        this.cleanupOldSnapshots(this.playerSnapshots);
    }

    /**
     * Removes old snapshots to prevent memory bloat
     */
    cleanupOldSnapshots(snapshots) {
        while (snapshots.length > this.maxSnapshots) {
            snapshots.shift();
        }
    }

    /**
     * Gets interpolated voxel positions
     */
    getInterpolatedVoxels() {
        if (!this.smoothMode || this.voxelSnapshots.length < 2) {
            return this.voxelSnapshots.length > 0 ? 
                this.voxelSnapshots[this.voxelSnapshots.length - 1].voxels : [];
        }

        const renderTime = performance.now() - this.renderDelay;
        const { before, after, t } = this.findInterpolationPoints(this.voxelSnapshots, renderTime);
        
        if (!before || !after) {
            return this.voxelSnapshots.length > 0 ? 
                this.voxelSnapshots[this.voxelSnapshots.length - 1].voxels : [];
        }

        return this.interpolateVoxelsByID(before.voxels, after.voxels, t);
    }

    /**
     * Gets interpolated camera position
     */
    getInterpolatedCamera() {
        if (!this.smoothMode || this.cameraSnapshots.length < 2) {
            return this.cameraSnapshots.length > 0 ? 
                this.cameraSnapshots[this.cameraSnapshots.length - 1].pos : [0, 0, 0];
        }

        const renderTime = performance.now() - this.renderDelay;
        const { before, after, t } = this.findInterpolationPoints(this.cameraSnapshots, renderTime);
        
        if (!before || !after) {
            return this.cameraSnapshots.length > 0 ? 
                this.cameraSnapshots[this.cameraSnapshots.length - 1].pos : [0, 0, 0];
        }

        return this.interpolatePosition(before.pos, after.pos, t);
    }

    /**
     * Finds the two snapshots to interpolate between
     */
    findInterpolationPoints(snapshots, renderTime) {
        let before = null, after = null;

        for (let i = 0; i < snapshots.length - 1; i++) {
            if (snapshots[i].time <= renderTime && snapshots[i + 1].time >= renderTime) {
                before = snapshots[i];
                after = snapshots[i + 1];
                break;
            }
        }

        if (!before || !after) {
            return { before: null, after: null, t: 0 };
        }

        const totalTime = after.time - before.time;
        const t = totalTime > 0 ? (renderTime - before.time) / totalTime : 0;

        return { before, after, t };
    }

    /**
     * Interpolates between two sets of voxels by matching IDs
     */
    interpolateVoxelsByID(voxelsA, voxelsB, t) {
        const result = [];
        const mapA = new Map();
        const mapB = new Map();

        // Create ID maps
        for (const voxel of voxelsA) {
            mapA.set(voxel.id, voxel);
        }
        for (const voxel of voxelsB) {
            mapB.set(voxel.id, voxel);
        }

        // Interpolate matching voxels
        const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

        for (const id of allIds) {
            const a = mapA.get(id);
            const b = mapB.get(id);

            if (a && b) {
                // Both snapshots have this voxel - interpolate position
                result.push({
                    ...b,
                    pos: this.interpolatePosition(a.pos, b.pos, t)
                });
            } else if (b) {
                // Voxel appeared - fade in
                result.push({
                    ...b,
                    alpha: t
                });
            } else if (a) {
                // Voxel disappeared - fade out
                result.push({
                    ...a,
                    alpha: 1 - t
                });
            }
        }

        return result;
    }

    /**
     * Interpolates between two 3D positions
     */
    interpolatePosition(posA, posB, t) {
        return [
            posA[0] + (posB[0] - posA[0]) * t,
            posA[1] + (posB[1] - posA[1]) * t,
            posA[2] + (posB[2] - posA[2]) * t
        ];
    }

    /**
     * Sets smooth mode on/off
     */
    setSmoothMode(enabled) {
        this.smoothMode = enabled;
        console.log(`Smooth interpolation: ${enabled ? 'ON' : 'OFF'}`);
    }

    /**
     * Sets render delay
     */
    setRenderDelay(delay) {
        this.renderDelay = delay;
        console.log(`Render delay set to ${delay}ms`);
    }

    /**
     * Gets interpolation statistics
     */
    getStats() {
        return {
            voxelSnapshots: this.voxelSnapshots.length,
            cameraSnapshots: this.cameraSnapshots.length,
            playerSnapshots: this.playerSnapshots.length,
            renderDelay: this.renderDelay,
            smoothMode: this.smoothMode
        };
    }

    /**
     * Clears all snapshots
     */
    clear() {
        this.voxelSnapshots = [];
        this.cameraSnapshots = [];
        this.playerSnapshots = [];
        console.log('Interpolation snapshots cleared');
    }
}