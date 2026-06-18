import DroneMap from './map.js';
import DroneTransport from './transport.js';

class DroneControlApp {
  constructor() {
    this.map = null;
    this.transport = null;
    this.drones = new Map();
    this.waypoints = [];
    this.init();
  }

  async init() {
    const container = document.getElementById('canvas-container');
    this.map = new DroneMap(container);

    this.transport = new DroneTransport();
    this.transport.setStatusCallback((data) => this._handleStatus(data));
    this.transport.setConnectionCallback((connected) => this._handleConnection(connected));

    await this.transport.connect();

    this._setupUI();
    this._setupMapCallbacks();
  }

  _setupUI() {
    this.droneSelect = document.getElementById('drone-select');
    this.modeSelect = document.getElementById('mode-select');
    this.speedInput = document.getElementById('speed-input');
    this.sendBtn = document.getElementById('send-btn');
    this.clearBtn = document.getElementById('clear-btn');
    this.stopBtn = document.getElementById('stop-btn');
    this.droneList = document.getElementById('drone-list');
    this.waypointList = document.getElementById('waypoint-list');
    this.connStatus = document.getElementById('conn-status');
    this.latencyEl = document.getElementById('latency');

    this.sendBtn.addEventListener('click', () => this._sendMission());
    this.clearBtn.addEventListener('click', () => this._clearWaypoints());
    this.stopBtn.addEventListener('click', () => this._sendHoverAll());

    setInterval(() => {
      const latency = this.transport.getLatency();
      const latencyClass = latency < 50 ? 'latency-good' : latency < 100 ? '' : 'latency-bad';
      this.latencyEl.innerHTML = `延迟: <span class="${latencyClass}">${latency} ms</span>`;
    }, 1000);
  }

  _setupMapCallbacks() {
    this.map.setClickCallback((latLng) => {
      this._addWaypoint(latLng);
    });
  }

  _addWaypoint(latLng) {
    const waypoint = {
      lat: latLng.lat,
      lng: latLng.lng,
      alt: 100
    };
    this.waypoints.push(waypoint);
    this.map.addWaypoint(waypoint);
    this._updateWaypointUI();
    this._updateSendButton();
  }

  _clearWaypoints() {
    this.waypoints = [];
    this.map.clearWaypoints();
    this._updateWaypointUI();
    this._updateSendButton();
  }

  _updateWaypointUI() {
    if (this.waypoints.length === 0) {
      this.waypointList.innerHTML = '<div style="color: #666; text-align: center; padding: 10px;">点击地图添加航点</div>';
      return;
    }

    this.waypointList.innerHTML = this.waypoints.map((wp, i) => `
      <div class="waypoint-item">
        <span>#${i + 1}: ${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}</span>
        <span style="color: #00d4ff;">${wp.alt.toFixed(0)}m</span>
      </div>
    `).join('');
  }

  _updateSendButton() {
    this.sendBtn.disabled = this.waypoints.length === 0;
  }

  _handleStatus(data) {
    for (const drone of data.drones) {
      this.drones.set(drone.id, drone);
      this.map.updateDrone(drone);
    }
    this._updateDroneList();
    this._updateDroneSelect();
  }

  _handleConnection(connected) {
    this.connStatus.className = `connection-status ${connected ? 'connected' : 'disconnected'}`;
    this.connStatus.title = connected ? '已连接' : '已断开';
  }

  _updateDroneList() {
    const drones = Array.from(this.drones.values()).sort((a, b) => a.id - b.id);

    this.droneList.innerHTML = drones.map(drone => {
      const battery = Math.round(drone.battery);
      const batteryClass = battery < 20 ? 'battery-low' : '';
      const statusText = drone.status === 1 ? '悬停' : drone.status === 2 ? '飞行中' : '返航';

      return `
        <div class="drone-item">
          <span class="drone-id">无人机 #${drone.id}</span>
          <span class="drone-battery ${batteryClass}">${battery}%</span>
          <span style="color: #888;">${statusText}</span>
        </div>
      `;
    }).join('');
  }

  _updateDroneSelect() {
    const drones = Array.from(this.drones.values()).sort((a, b) => a.id - b.id);
    const currentValue = this.droneSelect.value;

    this.droneSelect.innerHTML = '<option value="all">全部无人机</option>' +
      drones.map(d => `<option value="${d.id}">无人机 #${d.id}</option>`).join('');

    if (drones.some(d => d.id.toString() === currentValue)) {
      this.droneSelect.value = currentValue;
    }
  }

  async _sendMission() {
    if (this.waypoints.length === 0) return;

    const target = this.droneSelect.value;
    const mode = this.modeSelect.value;
    const speed = parseFloat(this.speedInput.value);

    const command = {
      type: target === 'all' ? 'mission_all' : 'mission',
      droneId: parseInt(target),
      waypoints: this.waypoints,
      speed: speed,
      mode: mode
    };

    const success = await this.transport.sendCommand(command);
    if (success) {
      console.log('Mission sent successfully');
    } else {
      console.error('Failed to send mission');
    }
  }

  async _sendHoverAll() {
    const command = {
      type: 'mission_all',
      waypoints: [],
      speed: 0,
      mode: 'hover'
    };

    await this.transport.sendCommand(command);
  }
}

new DroneControlApp();
