class DroneState {
  constructor(id) {
    this.id = id;
    this.lat = 0;
    this.lng = 0;
    this.alt = 0;
    this.battery = 0;
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.status = 0;
    this.lastUpdate = 0;
  }

  updateFrom(src) {
    this.lat = src.lat;
    this.lng = src.lng;
    this.alt = src.alt;
    this.battery = src.battery;
    this.roll = src.roll;
    this.pitch = src.pitch;
    this.yaw = src.yaw;
    this.status = src.status;
    this.lastUpdate = src.lastUpdate || Date.now();
  }
}

class StateManager {
  constructor() {
    this.drones = new Map();
    this.lastUpdate = 0;
    this.version = 0;
    this.listeners = new Set();
    this._snapshotCache = null;
    this._snapshotVersion = -1;
    this._encodedCache = null;
    this._encodedVersion = -1;
    this._updateQueue = [];
    this._processing = false;
  }

  update(drones) {
    for (const drone of drones) {
      let state = this.drones.get(drone.id);
      if (!state) {
        state = new DroneState(drone.id);
        this.drones.set(drone.id, state);
      }
      state.updateFrom(drone);
    }
    this.lastUpdate = Date.now();
    this.version++;
    this._snapshotCache = null;
    this._encodedCache = null;
    this._notify();
  }

  updateFromBuffer(buffer, offset, count) {
    const now = Date.now();
    let pos = offset;
    const droneSize = 36;

    for (let i = 0; i < count; i++) {
      const id = buffer.readUInt8(pos);
      let state = this.drones.get(id);
      if (!state) {
        state = new DroneState(id);
        this.drones.set(id, state);
      }
      state.lat = buffer.readDoubleBE(pos + 1);
      state.lng = buffer.readDoubleBE(pos + 9);
      state.alt = buffer.readFloatBE(pos + 17);
      state.battery = buffer.readUInt16BE(pos + 21);
      state.roll = buffer.readFloatBE(pos + 23);
      state.pitch = buffer.readFloatBE(pos + 27);
      state.yaw = buffer.readFloatBE(pos + 31);
      state.status = buffer.readUInt8(pos + 35);
      state.lastUpdate = now;
      pos += droneSize;
    }

    this.lastUpdate = now;
    this.version++;
    this._snapshotCache = null;
    this._encodedCache = null;
    this._notify();
  }

  getSnapshot() {
    if (this._snapshotCache && this._snapshotVersion === this.version) {
      return this._snapshotCache;
    }

    const drones = new Array(this.drones.size);
    let i = 0;
    for (const drone of this.drones.values()) {
      drones[i++] = drone;
    }

    this._snapshotCache = {
      timestamp: this.lastUpdate,
      version: this.version,
      drones: drones
    };
    this._snapshotVersion = this.version;
    return this._snapshotCache;
  }

  getDrone(id) {
    return this.drones.get(id);
  }

  getDroneCount() {
    return this.drones.size;
  }

  getVersion() {
    return this.version;
  }

  subscribe(callback) {
    this.listeners.add(callback);
    if (this.drones.size > 0) {
      try {
        callback(this.getSnapshot());
      } catch (e) {
        console.error('State listener error:', e);
      }
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error('State listener error:', e);
      }
    }
  }
}

export default StateManager;
