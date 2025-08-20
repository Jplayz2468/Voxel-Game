// PerformanceDebugger.js - Debug overlay for terrain update performance
// Shows real-time timing breakdown to identify performance bottlenecks

export class PerformanceDebugger {
    constructor() {
        this.isActive = false;
        this.currentUpdate = null;
        this.recentUpdates = [];
        this.maxHistorySize = 10;
        
        this.createOverlay();
        this.setupKeyboardHandler();
        
        console.log('Performance debugger initialized (Press P to toggle)');
    }

    /**
     * Creates the debug overlay UI
     */
    createOverlay() {
        // Create overlay container
        this.overlay = document.createElement('div');
        this.overlay.id = 'perf-debug-overlay';
        this.overlay.style.cssText = `
            position: fixed;
            top: 50px;
            right: 20px;
            width: 400px;
            max-height: 80vh;
            background: rgba(0, 0, 0, 0.9);
            color: #00ff00;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            padding: 15px;
            border: 2px solid #00ff00;
            border-radius: 8px;
            z-index: 10000;
            overflow-y: auto;
            display: none;
            box-shadow: 0 0 20px rgba(0, 255, 0, 0.3);
        `;

        // Create header
        const header = document.createElement('div');
        header.style.cssText = `
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 10px;
            color: #ffff00;
            text-align: center;
            border-bottom: 1px solid #00ff00;
            padding-bottom: 5px;
        `;
        header.textContent = 'TERRAIN UPDATE PERFORMANCE DEBUGGER';
        this.overlay.appendChild(header);

        // Create content area
        this.contentArea = document.createElement('div');
        this.overlay.appendChild(this.contentArea);

        // Add to document
        document.body.appendChild(this.overlay);
    }

    /**
     * Sets up keyboard handler for toggling overlay
     */
    setupKeyboardHandler() {
        document.addEventListener('keydown', (event) => {
            if (event.key === 'p' || event.key === 'P') {
                this.toggle();
            }
        });
    }

    /**
     * Toggles the debug overlay visibility
     */
    toggle() {
        this.isActive = !this.isActive;
        this.overlay.style.display = this.isActive ? 'block' : 'none';
        
        if (this.isActive) {
            console.log('Performance debugger ENABLED');
            this.updateDisplay();
        } else {
            console.log('Performance debugger DISABLED');
        }
    }

    /**
     * Starts timing a new terrain update
     */
    startTerrainUpdate() {
        if (!this.isActive) return null;

        const updateId = Date.now() + Math.random();
        this.currentUpdate = {
            id: updateId,
            startTime: performance.now(),
            steps: {},
            stepOrder: [],
            totalTime: 0,
            completed: false
        };

        console.log(`Starting terrain update timing ${updateId}`);
        this.updateDisplay();
        return updateId;
    }

    /**
     * Times a specific step in the terrain update
     */
    timeStep(updateId, stepName, fn) {
        if (!this.isActive || !this.currentUpdate || this.currentUpdate.id !== updateId) {
            return fn();
        }

        const stepStartTime = performance.now();
        console.log(`Starting step: ${stepName}`);
        
        try {
            const result = fn();
            
            // Handle promises
            if (result && typeof result.then === 'function') {
                return result.then((res) => {
                    this.recordStep(stepName, stepStartTime);
                    return res;
                }).catch((err) => {
                    this.recordStep(stepName, stepStartTime, true);
                    throw err;
                });
            } else {
                this.recordStep(stepName, stepStartTime);
                return result;
            }
        } catch (error) {
            this.recordStep(stepName, stepStartTime, true);
            throw error;
        }
    }

    /**
     * Records timing for a completed step
     */
    recordStep(stepName, stepStartTime, hadError = false) {
        if (!this.currentUpdate) return;

        const stepTime = performance.now() - stepStartTime;
        this.currentUpdate.steps[stepName] = {
            time: stepTime,
            error: hadError,
            timestamp: performance.now()
        };
        
        if (!this.currentUpdate.stepOrder.includes(stepName)) {
            this.currentUpdate.stepOrder.push(stepName);
        }

        console.log(`Completed step: ${stepName} (${stepTime.toFixed(2)}ms)`);
        this.updateDisplay();
    }

    /**
     * Completes the current terrain update
     */
    completeTerrainUpdate(updateId) {
        if (!this.isActive || !this.currentUpdate || this.currentUpdate.id !== updateId) {
            return;
        }

        this.currentUpdate.totalTime = performance.now() - this.currentUpdate.startTime;
        this.currentUpdate.completed = true;

        // Add to history
        this.recentUpdates.unshift({ ...this.currentUpdate });
        if (this.recentUpdates.length > this.maxHistorySize) {
            this.recentUpdates.pop();
        }

        console.log(`Terrain update ${updateId} completed in ${this.currentUpdate.totalTime.toFixed(2)}ms`);
        
        this.currentUpdate = null;
        this.updateDisplay();
    }

    /**
     * Updates the overlay display
     */
    updateDisplay() {
        if (!this.isActive) return;

        let html = '';

        // Current update section
        if (this.currentUpdate) {
            html += this.renderCurrentUpdate();
        } else {
            html += '<div style="color: #888; text-align: center; margin: 10px 0;">Waiting for terrain update...</div>';
        }

        // Recent updates summary
        if (this.recentUpdates.length > 0) {
            html += this.renderRecentUpdates();
        }

        // Instructions
        html += `
            <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #444; color: #888; font-size: 11px;">
                Press P to toggle this overlay<br>
                Shoot terrain to trigger updates<br>
                Times shown in milliseconds
            </div>
        `;

        this.contentArea.innerHTML = html;
    }

    /**
     * Renders the current update being timed
     */
    renderCurrentUpdate() {
        const update = this.currentUpdate;
        const elapsed = performance.now() - update.startTime;
        
        let html = `
            <div style="margin-bottom: 15px;">
                <div style="color: #ffff00; font-weight: bold;">CURRENT UPDATE (${elapsed.toFixed(0)}ms elapsed)</div>
        `;

        if (update.stepOrder.length > 0) {
            // Sort steps by time to show slowest first
            const sortedSteps = update.stepOrder
                .map(name => ({ name, ...update.steps[name] }))
                .sort((a, b) => b.time - a.time);

            html += '<div style="margin-top: 8px;">';
            sortedSteps.forEach((step, index) => {
                const color = step.error ? '#ff4444' : 
                            index === 0 ? '#ff6666' : // Slowest step in red
                            index === 1 ? '#ffaa44' : // Second slowest in orange
                            '#00ff00'; // Others in green
                
                const icon = step.error ? 'ERROR' : 
                           index === 0 ? 'SLOW' : // Slowest
                           index === 1 ? 'WARN' : 'OK'; // Second slowest
                
                // Special handling for delta updates
                let stepDisplay = step.name;
                if (step.name.includes('Delta')) {
                    stepDisplay += ' DELTA'; // Delta indicator
                } else if (step.name.includes('Full')) {
                    stepDisplay += ' FULL'; // Full upload indicator
                }
                
                html += `
                    <div style="color: ${color}; margin: 3px 0;">
                        ${icon} ${stepDisplay}: ${step.time.toFixed(2)}ms
                    </div>
                `;
            });
            html += '</div>';

            // Show percentage breakdown
            const totalStepTime = sortedSteps.reduce((sum, step) => sum + step.time, 0);
            if (totalStepTime > 0 && sortedSteps.length > 1) {
                html += '<div style="margin-top: 8px; font-size: 11px; color: #aaa;">';
                sortedSteps.slice(0, 3).forEach(step => {
                    const percentage = (step.time / totalStepTime * 100).toFixed(1);
                    html += `${step.name}: ${percentage}% | `;
                });
                html = html.slice(0, -3) + '</div>';
            }
        }

        html += '</div>';
        return html;
    }

    /**
     * Renders summary of recent updates
     */
    renderRecentUpdates() {
        let html = `
            <div style="margin-top: 15px; border-top: 1px solid #444; padding-top: 10px;">
                <div style="color: #ffff00; font-weight: bold; margin-bottom: 8px;">RECENT UPDATES</div>
        `;

        // Show average times
        const avgTotalTime = this.recentUpdates.reduce((sum, u) => sum + u.totalTime, 0) / this.recentUpdates.length;
        html += `<div style="color: #00aaff;">Average Total: ${avgTotalTime.toFixed(2)}ms</div>`;

        // Find most common bottleneck
        const bottlenecks = {};
        this.recentUpdates.forEach(update => {
            const slowestStep = update.stepOrder
                .map(name => ({ name, time: update.steps[name].time }))
                .sort((a, b) => b.time - a.time)[0];
            
            if (slowestStep) {
                bottlenecks[slowestStep.name] = (bottlenecks[slowestStep.name] || 0) + 1;
            }
        });

        const mostCommonBottleneck = Object.entries(bottlenecks)
            .sort((a, b) => b[1] - a[1])[0];

        if (mostCommonBottleneck) {
            html += `<div style="color: #ff6666; margin-top: 5px;">Main Bottleneck: ${mostCommonBottleneck[0]} (${mostCommonBottleneck[1]}/${this.recentUpdates.length} times)</div>`;
        }

        // Show recent update list
        html += '<div style="margin-top: 8px; font-size: 11px;">';
        this.recentUpdates.slice(0, 5).forEach((update, index) => {
            const slowestStep = update.stepOrder
                .map(name => ({ name, time: update.steps[name].time }))
                .sort((a, b) => b.time - a.time)[0];
            
            const color = update.totalTime > avgTotalTime * 1.5 ? '#ff6666' : '#888';
            html += `
                <div style="color: ${color}; margin: 2px 0;">
                    #${index + 1}: ${update.totalTime.toFixed(1)}ms 
                    ${slowestStep ? `(${slowestStep.name} ${slowestStep.time.toFixed(1)}ms)` : ''}
                </div>
            `;
        });
        html += '</div></div>';

        return html;
    }

    /**
     * Cleanup function
     */
    cleanup() {
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        console.log('Performance debugger cleaned up');
    }
}