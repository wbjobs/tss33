import net from 'net';
import { parseBuffer, encodeCommand } from './protocol.js';

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
  }

  connect() {
    console.log(`Connecting to gateway at ${this.host}:${this.port}...`);

    this.socket = net.connect(this.port, this.host, () => {
      console.log('Connected to drone gateway');
      this.connected = true;
      this._flushCommandQueue();
    });

    this.socket.on('data', (data) => {
      const result = parseBuffer(data, this.bufferAccumulator);
      this.bufferAccumulator = result.bufferAccumulator;

      for (const msg of result.messages) {
        if (msg.type === 'status') {
          this.stateManager.update(msg.drones);
        } else if (msg.type === 'ack') {
          console.log('Command ACK:', msg.success);
        }
      }
    });

    this.socket.on('error', (err) => {
      console.error('Gateway socket error:', err.message);
    });

    this.socket.on('close', () => {
      console.log('Disconnected from gateway, reconnecting...');
      this.connected = false;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });
  }

  sendCommand(droneId, waypoints, speed, mode) {
    const buffer = encodeCommand(droneId, waypoints, speed, mode);

    if (this.connected && this.socket) {
      this.socket.write(buffer);
      console.log(`Sent command to drone ${droneId}: ${waypoints.length} waypoints`);
    } else {
      this.commandQueue.push(buffer);
      console.log(`Queued command for drone ${droneId} (not connected)`);
    }
  }

  _flushCommandQueue() {
    while (this.commandQueue.length > 0 && this.connected) {
      const buffer = this.commandQueue.shift();
      this.socket.write(buffer);
    }
  }
}

export default GatewayClient;
