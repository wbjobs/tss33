class StateManager {
  constructor() {
    this.drones = new Map();
    this.lastUpdate = 0;
    this.listeners = new Set();
  }

  update(drones) {
    for (const drone of drones) {
      this.drones.set(drone.id, {
        ...drone,
        lastUpdate: Date.now()
      });
    }
    this.lastUpdate = Date.now();
    this._notify();
  }

  getSnapshot() {
    return {
      timestamp: this.lastUpdate,
      drones: Array.from(this.drones.values())
    };
  }

  getDrone(id) {
    return this.drones.get(id);
  }

  subscribe(callback) {
    this.listeners.add(callback);
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
