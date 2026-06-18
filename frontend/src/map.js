import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const CENTER_LAT = 31.2304;
const CENTER_LNG = 121.4737;
const SCALE = 100000;
const ALT_SCALE = 0.1;

class DroneMap {
  constructor(container) {
    this.container = container;
    this.drones = new Map();
    this.waypoints = [];
    this.waypointMarkers = [];
    this.waypointLines = null;
    this.formationMarkers = [];
    this.trajectoryLines = new Map();
    this.clickCallback = null;

    this._init();
  }

  _init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a1a);
    this.scene.fog = new THREE.Fog(0x0a0a1a, 500, 2000);

    this.camera = new THREE.PerspectiveCamera(
      60,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      5000
    );
    this.camera.position.set(200, 300, 400);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 1500;
    this.controls.maxPolarAngle = Math.PI / 2.1;

    this._createLights();
    this._createGround();
    this._createGrid();

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.renderer.domElement.addEventListener('click', (e) => this._onClick(e));
    window.addEventListener('resize', () => this._onResize());

    this._animate();
  }

  _createLights() {
    const ambientLight = new THREE.AmbientLight(0x404060, 0.5);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(200, 400, 200);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 1500;
    directionalLight.shadow.camera.left = -500;
    directionalLight.shadow.camera.right = 500;
    directionalLight.shadow.camera.top = 500;
    directionalLight.shadow.camera.bottom = -500;
    this.scene.add(directionalLight);

    const hemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0x2d5a27, 0.3);
    this.scene.add(hemisphereLight);
  }

  _createGround() {
    const groundGeometry = new THREE.PlaneGeometry(2000, 2000, 100, 100);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a3d1a,
      roughness: 0.9,
      metalness: 0.1
    });

    const positions = groundGeometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const noise = Math.sin(x * 0.01) * Math.cos(y * 0.01) * 3;
      positions.setZ(i, noise);
    }
    groundGeometry.computeVertexNormals();

    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.scene.add(ground);
  }

  _createGrid() {
    const gridHelper = new THREE.GridHelper(2000, 100, 0x004466, 0x002233);
    gridHelper.position.y = 0.1;
    this.scene.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(50);
    this.scene.add(axesHelper);
  }

  _createDroneMesh(id) {
    const group = new THREE.Group();

    const bodyGeometry = new THREE.CylinderGeometry(2, 3, 1, 8);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(id / 5, 0.8, 0.5),
      metalness: 0.8,
      roughness: 0.2,
      emissive: new THREE.Color().setHSL(id / 5, 0.8, 0.3)
    });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.castShadow = true;
    group.add(body);

    const armGeometry = new THREE.BoxGeometry(12, 0.5, 0.5);
    const armMaterial = new THREE.MeshStandardMaterial({
      color: 0x333333,
      metalness: 0.9,
      roughness: 0.1
    });

    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Mesh(armGeometry, armMaterial);
      arm.rotation.y = (i * Math.PI) / 2;
      group.add(arm);

      const propeller = this._createPropeller();
      const angle = (i * Math.PI) / 2;
      propeller.position.set(Math.cos(angle) * 6, 1, Math.sin(angle) * 6);
      propeller.userData.isPropeller = true;
      group.add(propeller);
    }

    const lightGeometry = new THREE.SphereGeometry(0.8, 16, 16);
    const lightMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0.8
    });
    const light = new THREE.Mesh(lightGeometry, lightMaterial);
    light.position.set(0, 1.5, 0);
    group.add(light);

    group.userData.id = id;
    group.userData.body = body;
    group.userData.light = light;

    return group;
  }

  _createPropeller() {
    const geometry = new THREE.BoxGeometry(4, 0.1, 0.3);
    const material = new THREE.MeshStandardMaterial({
      color: 0x222222,
      metalness: 0.9,
      roughness: 0.1
    });
    return new THREE.Mesh(geometry, material);
  }

  _latLngToPosition(lat, lng, alt) {
    const x = (lng - CENTER_LNG) * SCALE;
    const z = (CENTER_LAT - lat) * SCALE;
    const y = alt * ALT_SCALE;
    return new THREE.Vector3(x, y, z);
  }

  _positionToLatLng(position) {
    const lat = CENTER_LAT - position.z / SCALE;
    const lng = CENTER_LNG + position.x / SCALE;
    const alt = position.y / ALT_SCALE;
    return { lat, lng, alt };
  }

  _onClick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    const intersectPoint = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.groundPlane, intersectPoint);

    if (intersectPoint) {
      const latLng = this._positionToLatLng(intersectPoint);
      if (this.clickCallback) {
        this.clickCallback(latLng);
      }
    }
  }

  _onResize() {
    this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    const time = Date.now() * 0.001;

    for (const [id, drone] of this.drones) {
      for (const child of drone.children) {
        if (child.userData && child.userData.isPropeller) {
          child.rotation.y += 0.5;
        }
      }

      if (drone.userData.light) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 5 + id);
        drone.userData.light.material.opacity = pulse;
      }
    }

    for (const marker of this.formationMarkers) {
      if (marker.userData && marker.userData.pulsePhase !== undefined) {
        const pulse = 0.8 + 0.2 * Math.sin(time * 2 + marker.userData.pulsePhase);
        marker.scale.setScalar(pulse);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setClickCallback(callback) {
    this.clickCallback = callback;
  }

  updateDrone(droneData) {
    const pos = this._latLngToPosition(droneData.lat, droneData.lng, droneData.alt);

    if (!this.drones.has(droneData.id)) {
      const mesh = this._createDroneMesh(droneData.id);
      this.drones.set(droneData.id, mesh);
      this.scene.add(mesh);
    }

    const drone = this.drones.get(droneData.id);
    drone.position.copy(pos);

    const targetQuat = new THREE.Quaternion();
    const euler = new THREE.Euler(droneData.roll, droneData.yaw, droneData.pitch, 'YXZ');
    targetQuat.setFromEuler(euler);
    drone.quaternion.slerp(targetQuat, 0.2);

    if (drone.userData.light) {
      if (droneData.battery < 20) {
        drone.userData.light.material.color.setHex(0xff0000);
      } else if (droneData.status === 2) {
        drone.userData.light.material.color.setHex(0x00ff00);
      } else {
        drone.userData.light.material.color.setHex(0x00ffff);
      }
    }
  }

  addWaypoint(waypoint) {
    this.waypoints.push(waypoint);
    this._updateWaypointVisuals();
  }

  clearWaypoints() {
    this.waypoints = [];
    this._updateWaypointVisuals();
  }

  _updateWaypointVisuals() {
    for (const marker of this.waypointMarkers) {
      this.scene.remove(marker);
    }
    this.waypointMarkers = [];

    if (this.waypointLines) {
      this.scene.remove(this.waypointLines);
      this.waypointLines = null;
    }

    for (let i = 0; i < this.waypoints.length; i++) {
      const wp = this.waypoints[i];
      const pos = this._latLngToPosition(wp.lat, wp.lng, wp.alt);

      const markerGroup = new THREE.Group();

      const ringGeometry = new THREE.TorusGeometry(5, 0.5, 8, 16);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0x00d4ff,
        transparent: true,
        opacity: 0.8
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = pos.y;
      markerGroup.add(ring);

      const poleGeometry = new THREE.CylinderGeometry(0.2, 0.2, pos.y, 8);
      const poleMaterial = new THREE.MeshBasicMaterial({
        color: 0x00d4ff,
        transparent: true,
        opacity: 0.5
      });
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = pos.y / 2;
      markerGroup.add(pole);

      markerGroup.position.x = pos.x;
      markerGroup.position.z = pos.z;

      const spriteMaterial = new THREE.SpriteMaterial({
        map: this._createTextTexture(`#${i + 1}`),
        transparent: true
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(0, pos.y + 10, 0);
      sprite.scale.set(20, 20, 1);
      markerGroup.add(sprite);

      markerGroup.userData.originalY = pos.y;
      this.waypointMarkers.push(markerGroup);
      this.scene.add(markerGroup);
    }

    if (this.waypoints.length > 1) {
      const points = this.waypoints.map(wp => {
        const pos = this._latLngToPosition(wp.lat, wp.lng, wp.alt);
        return pos;
      });

      const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const lineMaterial = new THREE.LineDashedMaterial({
        color: 0x00d4ff,
        linewidth: 2,
        dashSize: 5,
        gapSize: 3,
        transparent: true,
        opacity: 0.7
      });
      this.waypointLines = new THREE.Line(lineGeometry, lineMaterial);
      this.waypointLines.computeLineDistances();
      this.scene.add(this.waypointLines);
    }
  }

  _createTextTexture(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.beginPath();
    ctx.roundRect(10, 10, 108, 44, 8);
    ctx.fill();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 32px Arial';
    ctx.fillStyle = '#00d4ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 64, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  getWaypoints() {
    return [...this.waypoints];
  }

  showFormationPreview(targets) {
    this.clearFormationPreview();

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const pos = this._latLngToPosition(target.lat, target.lng, target.alt);

      const markerGroup = new THREE.Group();

      const ringGeometry = new THREE.TorusGeometry(6, 0.8, 8, 16);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.7
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = pos.y;
      markerGroup.add(ring);

      const poleGeometry = new THREE.CylinderGeometry(0.3, 0.3, pos.y, 8);
      const poleMaterial = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.4
      });
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = pos.y / 2;
      markerGroup.add(pole);

      const spriteMaterial = new THREE.SpriteMaterial({
        map: this._createTextTexture(`#${i + 1}`),
        transparent: true
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(0, pos.y + 15, 0);
      sprite.scale.set(20, 20, 1);
      markerGroup.add(sprite);

      markerGroup.position.x = pos.x;
      markerGroup.position.z = pos.z;
      markerGroup.userData.pulsePhase = Math.random() * Math.PI * 2;
      this.formationMarkers.push(markerGroup);
      this.scene.add(markerGroup);
    }

    if (targets.length > 1) {
      const points = targets.map(t => this._latLngToPosition(t.lat, t.lng, t.alt));
      const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
      const lineMaterial = new THREE.LineDashedMaterial({
        color: 0xffaa00,
        linewidth: 2,
        dashSize: 6,
        gapSize: 4,
        transparent: true,
        opacity: 0.5
      });
      const lines = new THREE.Line(lineGeometry, lineMaterial);
      lines.computeLineDistances();
      this.formationMarkers.push(lines);
      this.scene.add(lines);
    }
  }

  clearFormationPreview() {
    for (const marker of this.formationMarkers) {
      this.scene.remove(marker);
    }
    this.formationMarkers = [];
  }

  updateTrajectoryPreview(trajectories) {
    this.clearTrajectoryPreview();

    for (const [droneId, points] of trajectories) {
      if (points.length < 2) continue;

      const linePoints = points.map(p => this._latLngToPosition(p.lat, p.lng, p.alt));
      const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);

      const hue = droneId / 20;
      const lineMaterial = new THREE.LineBasicMaterial({
        color: new THREE.Color().setHSL(hue, 1, 0.6),
        transparent: true,
        opacity: 0.6
      });

      const line = new THREE.Line(lineGeometry, lineMaterial);
      this.trajectoryLines.set(droneId, line);
      this.scene.add(line);
    }
  }

  clearTrajectoryPreview() {
    for (const line of this.trajectoryLines.values()) {
      this.scene.remove(line);
    }
    this.trajectoryLines.clear();
  }
}

export default DroneMap;
