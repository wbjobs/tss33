const SERVER_URL = 'https://localhost:8080';
const CERT_FINGERPRINT = 'NqABgngGIy6VwfKSJ17RHGwW7qQwMwT3miyTCBJaoMk=';

class DroneTransport {
  constructor() {
    this.transport = null;
    this.datagramWriter = null;
    this.commandStream = null;
    this.commandWriter = null;
    this.statusCallback = null;
    this.messageCallback = null;
    this.connectionCallback = null;
    this.connected = false;
    this.reconnectDelay = 2000;
    this.lastLatency = 0;
  }

  setStatusCallback(callback) {
    this.statusCallback = callback;
  }

  setMessageCallback(callback) {
    this.messageCallback = callback;
  }

  setConnectionCallback(callback) {
    this.connectionCallback = callback;
  }

  async connect() {
    try {
      console.log('Connecting to WebTransport server...');

      const hashBuffer = Uint8Array.from(atob(CERT_FINGERPRINT), c => c.charCodeAt(0));
      this.transport = new WebTransport(SERVER_URL, {
        serverCertificateHashes: [
          {
            algorithm: 'sha-256',
            value: hashBuffer
          }
        ]
      });

      this.transport.closed.then(() => {
        console.log('WebTransport session closed');
        this.connected = false;
        this._notifyConnection(false);
        setTimeout(() => this.connect(), this.reconnectDelay);
      }).catch(err => {
        console.error('Session error:', err);
        this.connected = false;
        this._notifyConnection(false);
        setTimeout(() => this.connect(), this.reconnectDelay);
      });

      await this.transport.ready;
      console.log('WebTransport connected');

      this.connected = true;
      this._notifyConnection(true);

      this._setupDatagrams();
      this._setupIncomingStreams();
      await this._setupCommandStream();

    } catch (err) {
      console.error('Failed to connect:', err);
      this.connected = false;
      this._notifyConnection(false);
      setTimeout(() => this.connect(), this.reconnectDelay);
    }
  }

  _parseStatusData(dataStr, startTime) {
    try {
      const data = JSON.parse(dataStr);
      if (data.type === 'status') {
        this.lastLatency = Math.round(performance.now() - startTime);
        if (this.statusCallback) {
          this.statusCallback(data);
        }
      } else if (data.type && data.type.startsWith('formation_')) {
        if (this.messageCallback) {
          this.messageCallback(data);
        }
      }
    } catch (e) {
      console.error('Parse status error:', e);
    }
  }

  async _setupDatagrams() {
    try {
      this.datagramWriter = this.transport.datagrams.writable.getWriter();

      const reader = this.transport.datagrams.readable.getReader();
      const decoder = new TextDecoder();

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const startTime = performance.now();
            this._parseStatusData(decoder.decode(value), startTime);
          }
        } catch (e) {
          console.log('Datagram reader closed');
        } finally {
          reader.releaseLock();
        }
      })();

      console.log('Datagrams enabled for status updates');
    } catch (e) {
      console.log('Datagrams not available, will use streams for status updates');
    }
  }

  async _setupIncomingStreams() {
    try {
      for await (const stream of this.transport.incomingUnidirectionalStreams) {
        this._readStreamStatus(stream);
      }
    } catch (e) {
      console.log('Incoming streams error:', e.message);
    }
  }

  async _readStreamStatus(stream) {
    const reader = stream.readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const startTime = performance.now();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          this._parseStatusData(line, startTime);
        }
      }
    } catch (e) {
      console.log('Status stream closed');
    } finally {
      reader.releaseLock();
    }
  }

  async _setupCommandStream() {
    try {
      this.commandStream = await this.transport.createBidirectionalStream();
      const encoder = new TextEncoder();

      this.commandWriter = this.commandStream.writable.getWriter();
      await this.commandWriter.ready;

      const reader = this.commandStream.readable.getReader();
      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch (e) {
          console.log('Command stream closed');
        } finally {
          reader.releaseLock();
        }
      })();

    } catch (e) {
      console.error('Failed to create command stream:', e);
    }
  }

  async sendCommand(command) {
    if (!this.commandWriter || !this.connected) {
      console.warn('Not connected, command queued');
      return false;
    }

    try {
      const data = JSON.stringify(command) + '\n';
      await this.commandWriter.write(new TextEncoder().encode(data));
      return true;
    } catch (e) {
      console.error('Send command error:', e);
      return false;
    }
  }

  _notifyConnection(connected) {
    if (this.connectionCallback) {
      this.connectionCallback(connected);
    }
  }

  getLatency() {
    return this.lastLatency;
  }

  close() {
    if (this.transport) {
      this.transport.close();
    }
  }
}

export default DroneTransport;
