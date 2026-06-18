import DroneMap from './map.js';
import DroneTransport from './transport.js';
import { FORMATION_TYPES, calculateFormation, getFormationInfo } from './formation.js';

class DroneControlApp {
  constructor() {
    this.map = null;
    this.transport = null;
    this.drones = new Map();
    this.waypoints = [];
    this.selectedFormation = null;
    this.formationCenter = null;
    this.formationPreviewTargets = [];
    this.isPlanning = false;
    this.planningRequestId = null;
    this.trajectoryPoints = new Map();
    this.init();
  }

  async init() {
    const container = document.getElementById('canvas-container');
    this.map = new DroneMap(container);

    this.transport = new DroneTransport();
    this.transport.setStatusCallback((data) => this._handleStatus(data));
    this.transport.setConnectionCallback((connected) => this._handleConnection(connected));
    this.transport.setMessageCallback((data) => this._handleMessage(data));

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
    this.formationGrid = document.getElementById('formation-grid');
    this.formationBtn = document.getElementById('formation-btn');
    this.previewBtn = document.getElementById('preview-btn');
    this.planningStatusEl = document.getElementById('planning-status');

    this.sendBtn.addEventListener('click', () => this._sendMission());
    this.clearBtn.addEventListener('click', () => this._clearWaypoints());
    this.stopBtn.addEventListener('click', () => this._sendHoverAll());
    this.formationBtn.addEventListener('click', () => this._executeFormation());
    this.previewBtn.addEventListener('click', () => this._toggleFormationPreview());

    this.formationGrid.querySelectorAll('.formation-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const formation = btn.dataset.formation;
        this._selectFormation(formation);
      });
    });

    setInterval(() => {
      const latency = this.transport.getLatency();
      const latencyClass = latency < 50 ? 'latency-good' : latency < 100 ? '' : 'latency-bad';
      this.latencyEl.innerHTML = `延迟: <span class="${latencyClass}">${latency} ms</span>`;
    }, 1000);
  }

  _setupMapCallbacks() {
    this.map.setClickCallback((latLng) => {
      if (this.selectedFormation && !this.formationCenter) {
        this._setFormationCenter(latLng);
      } else {
        this._addWaypoint(latLng);
      }
    });
  }

  _selectFormation(formationType) {
    this.formationGrid.querySelectorAll('.formation-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.formation === formationType);
    });

    this.selectedFormation = formationType;
    this.formationCenter = null;
    this.formationPreviewTargets = [];
    this.map.clearFormationPreview();
    this._updateFormationButton();

    const info = getFormationInfo(formationType);
    console.log(`Selected formation: ${info.name}`);
  }

  _setFormationCenter(latLng) {
    this.formationCenter = latLng;
    this._updateFormationButton();
    this._showFormationPreview();
  }

  _showFormationPreview() {
    if (!this.selectedFormation || !this.formationCenter) return;

    const droneCount = this.drones.size;
    if (droneCount === 0) return;

    this.formationPreviewTargets = calculateFormation(
      droneCount,
      this.selectedFormation,
      this.formationCenter.lat,
      this.formationCenter.lng,
      100
    );

    this.map.showFormationPreview(this.formationPreviewTargets);
  }

  _toggleFormationPreview() {
    if (!this.selectedFormation) {
      alert('请先选择一种队形');
      return;
    }

    if (this.formationPreviewTargets.length > 0) {
      this.map.clearFormationPreview();
      this.formationPreviewTargets = [];
    } else if (this.formationCenter) {
      this._showFormationPreview();
    } else {
      alert('请在地图上点击选择队形中心位置');
    }
  }

  _updateFormationButton() {
    this.formationBtn.disabled = !this.selectedFormation || !this.formationCenter || this.isPlanning;
  }

  async _executeFormation() {
    if (!this.selectedFormation || !this.formationCenter || this.isPlanning) return;

    const droneCount = this.drones.size;
    if (droneCount === 0) {
      alert('没有可用的无人机');
      return;
    }

    const targets = calculateFormation(
      droneCount,
      this.selectedFormation,
      this.formationCenter.lat,
      this.formationCenter.lng,
      100
    );

    const command = {
      type: 'formation',
      formationType: this.selectedFormation,
      centerLat: this.formationCenter.lat,
      centerLng: this.formationCenter.lng,
      centerAlt: 100,
      targets: targets,
      speed: parseFloat(this.speedInput.value) || 5.0
    };

    const success = await this.transport.sendCommand(command);
    if (!success) {
      this._showPlanningStatus('error', '发送编队指令失败');
    }
  }

  _showPlanningStatus(type, message, progress = 0) {
    this.planningStatusEl.className = `planning-status planning-${type}`;

    let html = `<div>${message}</div>`;
    if (type === 'active' || progress > 0) {
      const progressPct = Math.round(progress * 100);
      html += `<div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%"></div></div>`;
    }
    this.planningStatusEl.innerHTML = html;
  }

  _handleMessage(data) {
    switch (data.type) {
      case 'formation_started':
        this.isPlanning = true;
        this.planningRequestId = data.requestId;
        this.trajectoryPoints.clear();
        this._showPlanningStatus('active', `正在规划 ${data.droneCount} 架无人机的航线...`, 0);
        this._updateFormationButton();
        break;

      case 'formation_progress':
        if (data.requestId === this.planningRequestId) {
          const progress = data.total > 0 ? data.completed / data.total : 0;
          this._showPlanningStatus('active', `规划中... ${data.completed}/${data.total} 架无人机已完成`, progress);
          this._updateTrajectoryPreview(data.points);
        }
        break;

      case 'formation_completed':
        if (data.requestId === this.planningRequestId) {
          this.isPlanning = false;
          this.planningRequestId = null;
          this._showPlanningStatus('done', `编队规划完成！共 ${data.totalPoints} 个轨迹点，耗时 ${data.duration}ms`);
          this._updateFormationButton();
          setTimeout(() => {
            this.map.clearTrajectoryPreview();
            this.trajectoryPoints.clear();
          }, 3000);
        }
        break;

      case 'formation_error':
        if (data.requestId === this.planningRequestId || !this.planningRequestId) {
          this.isPlanning = false;
          this.planningRequestId = null;
          this._showPlanningStatus('error', `规划失败: ${data.message}`);
          this._updateFormationButton();
        }
        break;
    }
  }

  _updateTrajectoryPreview(points) {
    for (const pt of points) {
      if (!this.trajectoryPoints.has(pt.drone_id)) {
        this.trajectoryPoints.set(pt.drone_id, []);
      }
      this.trajectoryPoints.get(pt.drone_id).push({
        lat: pt.lat,
        lng: pt.lng,
        alt: pt.alt
      });
    }
    this.map.updateTrajectoryPreview(this.trajectoryPoints);
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

    this.selectedFormation = null;
    this.formationCenter = null;
    this.formationPreviewTargets = [];
    this.map.clearFormationPreview();
    this.formationGrid.querySelectorAll('.formation-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    this._updateFormationButton();
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
