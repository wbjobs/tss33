import net from 'net';
import { fastParseStatus, encodeCommand, encodeSetRate } from './protocol.js';

const STATS_INTERVAL = 1000;
const MAX_QUEUED_UPDATES = 5;

class GatewayClient {
  constructor(host, port, stateManager) {
    this.host = host;
    this.port = port;
    this.stateManager = stateManager;
    this.socket = null;
    this.bufferAccumulator = Buffer.alloc(0);
    this.reconnectDelay = 1000;
    this.connected = false;
    this.commandQueue = [];

    this._statusCount = 0;
    this._lastStatsTime = Date.now();
    this._statusRate = 0;
    this._droppedUpdates = 0;
    this._processingTime = 0;
    this._processingCount = 0;

    this._throttled = false;
    this._pendingData = null;
    this._updateTimer = null;
    this._minUpdateInterval = 0;
    this._maxUpdateInterval = 200;
    this._currentInterval = 0;
    this._lastUpdateTime = 0;

    this._gatewayInterval = 200;
    this._minGatewayInterval = 20;
    this._maxGatewayInterval = 2000;
    this._gatewayRateDirty = false;
  }

  connect() {
    console.log(`Connecting to gateway at ${this.host}:${this.port}...`);

    this.socket = net.connect(this.port, this.host, () => {
      console.log('Connected to drone gateway');
      this.connected = true;
      this._flushCommandQueue();
    });

    this.socket.on('data', (data) => {
      const startTime = process.hrtime.bigint();

      if (this._throttled) {
        if (!this._pendingData) {
          this._pendingData = data;
        } else {
          this._pendingData = Buffer.concat([this._pendingData, data]);
        }
        return;
      }

      this._processData(data);

      const endTime = process.hrtime.bigint();
      this._processingTime += Number(endTime - startTime) / 1e6;
      this._processingCount++;

      this._maybeThrottle();
    });

    this.socket.on('error', (err) => {
      console.error('Gateway socket error:', err.message);
    });

    this.socket.on('close', () => {
      console.log('Disconnected from gateway, reconnecting...');
      this.connected = false;
      if (this._updateTimer) {
        clearTimeout(this._updateTimer);
        this._updateTimer = null;
      }
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    setInterval(() => this._logStats(), STATS_INTERVAL);
  }

  _processData(data) {
    const result = fastParseStatus(data, this.bufferAccumulator, this.stateManager);
    this.bufferAccumulator = result.bufferAccumulator;
    this._statusCount++;
    this._lastUpdateTime = Date.now();
  }

  _maybeThrottle() {
    const now = Date.now();
    if (now - this._lastStatsTime < 100) return;

    const avgProcessingTime = this._processingCount > 0
      ? this._processingTime / this._processingCount
      : 0;

    if (avgProcessingTime > 8 && this._statusRate > 20) {
      this._currentInterval = Math.min(
        this._currentInterval + 25,
        this._maxUpdateInterval
      );
      if (this._currentInterval > 0 && !this._throttled) {
        this._enableThrottle();
      }

      if (avgProcessingTime > 15) {
        this.sendSetRate(this._gatewayInterval * 1.5);
      }
    } else if (avgProcessingTime < 2 && this._statusRate < 10) {
      this._currentInterval = Math.max(0, this._currentInterval - 10);
      if (this._currentInterval === 0 && this._throttled) {
        this._disableThrottle();
      }

      if (avgProcessingTime < 1 && this._gatewayInterval > this._minGatewayInterval) {
        this.sendSetRate(Math.max(this._minGatewayInterval, this._gatewayInterval * 0.8));
      }
    }
  }

  _enableThrottle() {
    this._throttled = true;
    this._scheduleNextUpdate();
    console.log(`Throttling enabled: interval=${this._currentInterval}ms`);
  }

  _disableThrottle() {
    this._throttled = false;
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
    if (this._pendingData && this._pendingData.length > 0) {
      this._processData(this._pendingData);
      this._pendingData = null;
    }
    console.log('Throttling disabled');
  }

  _scheduleNextUpdate() {
    if (this._updateTimer) return;

    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      if (!this._throttled) return;

      if (this._pendingData && this._pendingData.length > 0) {
        const startTime = process.hrtime.bigint();
        this._processData(this._pendingData);
        this._pendingData = null;
        const endTime = process.hrtime.bigint();
        this._processingTime += Number(endTime - startTime) / 1e6;
        this._processingCount++;
      }

      if (this._throttled) {
        this._scheduleNextUpdate();
      }
    }, this._currentInterval);
  }

  sendCommand(droneId, waypoints, speed, mode) {
    const buffer = encodeCommand(droneId, waypoints, speed, mode);

    if (this.connected && this.socket) {
      this.socket.write(buffer);
    } else {
      this.commandQueue.push(buffer);
    }
  }

  sendSetRate(intervalMs) {
    if (!this.connected || !this.socket) return;

    const clamped = Math.max(this._minGatewayInterval, Math.min(this._maxGatewayInterval, intervalMs));

    if (Math.abs(clamped - this._gatewayInterval) < 10) return;

    this._gatewayInterval = clamped;
    const buffer = encodeSetRate(clamped);
    this.socket.write(buffer);
    console.log(`Sent set_rate: ${(1000 / clamped).toFixed(1)}/s (${clamped}ms)`);
  }

  _flushCommandQueue() {
    while (this.commandQueue.length > 0 && this.connected) {
      const buffer = this.commandQueue.shift();
      this.socket.write(buffer);
    }
  }

  _logStats() {
    const now = Date.now();
    const elapsed = Math.max(0.001, (now - this._lastStatsTime) / 1000);
    this._statusRate = Math.round(this._statusCount / elapsed);
    const avgProcessing = this._processingCount > 0
      ? (this._processingTime / this._processingCount).toFixed(2)
      : '0.00';

    console.log(
      `[Gateway] rate=${this._statusRate}/s ` +
      `avg_process=${avgProcessing}ms ` +
      `throttled=${this._throttled} ` +
      `interval=${this._currentInterval}ms ` +
      `drones=${this.stateManager.getDroneCount()}`
    );

    this._statusCount = 0;
    this._processingTime = 0;
    this._processingCount = 0;
    this._lastStatsTime = now;
  }

  getStatusRate() {
    return this._statusRate;
  }

  isThrottled() {
    return this._throttled;
  }

  setMinUpdateInterval(ms) {
    this._minUpdateInterval = ms;
    if (this._currentInterval < ms) {
      this._currentInterval = ms;
      if (!this._throttled && ms > 0) {
        this._enableThrottle();
      }
    }
  }

  setMaxUpdateInterval(ms) {
    this._maxUpdateInterval = ms;
    if (this._currentInterval > ms) {
      this._currentInterval = ms;
    }
  }
}

export default GatewayClient;
