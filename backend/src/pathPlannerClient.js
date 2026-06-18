import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_HOST = '127.0.0.1';
const REDIS_PORT = 6379;
const REQUEST_CHANNEL = 'path_planner:requests';
const RESPONSE_CHANNEL_PREFIX = 'path_planner:response:';

class PathPlannerClient extends EventEmitter {
  constructor() {
    super();
    this.redis = null;
    this.subscriber = null;
    this.connected = false;
    this.fallbackMode = false;
    this.fallbackProcess = null;
    this.activeRequests = new Map();
    this._connect();
  }

  async _connect() {
    try {
      this.redis = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });

      this.subscriber = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3
      });

      this.redis.on('connect', () => {
        console.log('[PathPlanner] Redis connected');
        this.connected = true;
      });

      this.redis.on('error', (err) => {
        console.log('[PathPlanner] Redis error, switching to fallback mode:', err.message);
        this._switchToFallback();
      });

      this.redis.on('close', () => {
        this.connected = false;
      });

      this.subscriber.on('message', (channel, message) => {
        this._handleResponse(channel, message);
      });

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[PathPlanner] Redis connection timeout, using fallback');
          this._switchToFallback();
          resolve();
        }, 2000);

        this.redis.once('ready', () => {
          clearTimeout(timeout);
          console.log('[PathPlanner] Redis ready');
          resolve();
        });
      });

    } catch (err) {
      console.log('[PathPlanner] Failed to connect Redis, using fallback:', err.message);
      this._switchToFallback();
    }
  }

  _switchToFallback() {
    if (this.fallbackMode) return;

    console.log('[PathPlanner] Switching to embedded fallback mode');
    this.fallbackMode = true;

    try {
      const scriptPath = path.resolve(__dirname, '../../path_planner/path_planner.py');
      console.log('[PathPlanner] Starting embedded path planner:', scriptPath);

      this.fallbackProcess = spawn('python', ['-u', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.fallbackProcess.stdout.on('data', (data) => {
        console.log('[Planner]', data.toString().trim());
      });

      this.fallbackProcess.stderr.on('data', (data) => {
        console.error('[Planner Err]', data.toString().trim());
      });

      this.fallbackProcess.on('close', (code) => {
        console.log(`[PathPlanner] Fallback process exited with code ${code}`);
        this.fallbackProcess = null;
      });

      setTimeout(() => {
        this.connected = true;
      }, 1000);

    } catch (err) {
      console.error('[PathPlanner] Failed to start fallback:', err);
    }
  }

  async planFormation(drones, targets, speed = 5.0) {
    const requestId = crypto.randomUUID();

    const request = {
      request_id: requestId,
      drones: drones.map(d => ({
        id: d.id,
        lat: d.lat,
        lng: d.lng,
        alt: d.alt,
        roll: d.roll || 0,
        pitch: d.pitch || 0,
        yaw: d.yaw || 0
      })),
      targets: targets.map(t => ({
        lat: t.lat,
        lng: t.lng,
        alt: t.alt
      })),
      speed
    };

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeRequests.delete(requestId);
        reject(new Error('Path planning timeout'));
      }, 60000);

      const result = {
        requestId,
        status: 'started',
        progress: 0,
        completed: false,
        points: [],
        droneCount: drones.length
      };

      this.activeRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        result,
        startTime: Date.now()
      });

      if (this.fallbackMode) {
        this._handleEmbeddedPlanning(request, requestId);
      } else {
        try {
          await this.subscriber.subscribe(RESPONSE_CHANNEL_PREFIX + requestId);
          await this.redis.publish(REQUEST_CHANNEL, JSON.stringify(request));
          console.log(`[PathPlanner] Sent request ${requestId} for ${drones.length} drones`);
        } catch (err) {
          clearTimeout(timeout);
          this.activeRequests.delete(requestId);
          reject(err);
        }
      }
    });
  }

  _handleResponse(channel, message) {
    try {
      const requestId = channel.replace(RESPONSE_CHANNEL_PREFIX, '');
      const data = JSON.parse(message);

      const req = this.activeRequests.get(requestId);
      if (!req) return;

      if (data.status === 'started') {
        req.result.status = 'planning';
        this.emit('planning:started', { requestId, ...data });
      } else if (data.status === 'progress') {
        req.result.points.push(...data.points);
        req.result.progress = data.completed / data.total;
        this.emit('planning:progress', { requestId, ...data });
      } else if (data.status === 'completed') {
        clearTimeout(req.timeout);
        req.result.completed = true;
        req.result.status = 'completed';
        this.emit('planning:completed', { requestId, ...data });
        this.subscriber.unsubscribe(channel).catch(() => {});
        this.activeRequests.delete(requestId);
        req.resolve(req.result);
      } else if (data.status === 'error') {
        clearTimeout(req.timeout);
        req.result.status = 'error';
        this.subscriber.unsubscribe(channel).catch(() => {});
        this.activeRequests.delete(requestId);
        req.reject(new Error(data.message || 'Planning error'));
      }
    } catch (err) {
      console.error('[PathPlanner] Error handling response:', err);
    }
  }

  async _handleEmbeddedPlanning(request, requestId) {
    const req = this.activeRequests.get(requestId);
    if (!req) return;

    try {
      await new Promise(resolve => setTimeout(resolve, 500));

      this._handleResponse(RESPONSE_CHANNEL_PREFIX + requestId, JSON.stringify({
        status: 'started',
        drone_count: request.drones.length,
        timestamp: Date.now() / 1000
      }));

      const drones = request.drones;
      const targets = request.targets;
      const speed = request.speed || 5.0;

      const dronePositions = {};
      const droneSpeeds = {};
      const completed = new Set();

      for (const d of drones) {
        dronePositions[d.id] = { lat: d.lat, lng: d.lng, alt: d.alt, yaw: d.yaw || 0 };
        droneSpeeds[d.id] = 0;
      }

      const MAX_ITER = 400;
      for (let iter = 0; iter < MAX_ITER && completed.size < drones.length; iter++) {
        const points = [];
        let allDone = true;

        for (let i = 0; i < drones.length; i++) {
          const drone = drones[i];
          if (completed.has(drone.id)) continue;

          const target = targets[i] || targets[targets.length - 1];
          const current = dronePositions[drone.id];

          const next = this._simulateStep(current, target, speed, droneSpeeds[drone.id]);

          if (next.done) {
            completed.add(drone.id);
            points.push({
              drone_id: drone.id,
              lat: target.lat,
              lng: target.lng,
              alt: target.alt,
              speed: 0,
              completed: true
            });
          } else {
            allDone = false;
            dronePositions[drone.id] = { lat: next.lat, lng: next.lng, alt: next.alt, yaw: next.yaw };
            droneSpeeds[drone.id] = next.speed;
            points.push({
              drone_id: drone.id,
              lat: next.lat,
              lng: next.lng,
              alt: next.alt,
              speed: next.speed,
              completed: false
            });
          }
        }

        if (iter % 8 === 0 && points.length > 0) {
          this._handleResponse(RESPONSE_CHANNEL_PREFIX + requestId, JSON.stringify({
            status: 'progress',
            iteration: iter,
            completed: completed.size,
            total: drones.length,
            points,
            timestamp: Date.now() / 1000
          }));

          await new Promise(resolve => setTimeout(resolve, 20));
        }

        if (allDone) break;
      }

      this._handleResponse(RESPONSE_CHANNEL_PREFIX + requestId, JSON.stringify({
        status: 'completed',
        trajectory_count: drones.length,
        total_points: 0,
        timestamp: Date.now() / 1000
      }));

    } catch (err) {
      this._handleResponse(RESPONSE_CHANNEL_PREFIX + requestId, JSON.stringify({
        status: 'error',
        message: err.message,
        timestamp: Date.now() / 1000
      }));
    }
  }

  _simulateStep(current, target, speed, currentSpeed) {
    const dlat = target.lat - current.lat;
    const dlng = target.lng - current.lng;
    const dalt = target.alt - current.alt;

    const dist2d = Math.sqrt(dlat * dlat + dlng * dlng);
    const dist = Math.sqrt(dist2d * dist2d + dalt * dalt);

    if (dist < 0.0001) {
      return { ...target, done: true, yaw: current.yaw, speed: 0 };
    }

    const step = Math.min(speed * 0.000012, dist);
    const ratio = step / dist;

    const newSpeed = Math.min(currentSpeed + 0.3, speed);
    const newYaw = Math.atan2(dlat, dlng);

    return {
      lat: current.lat + dlat * ratio,
      lng: current.lng + dlng * ratio,
      alt: current.alt + dalt * ratio,
      yaw: newYaw,
      speed: newSpeed,
      done: false
    };
  }

  cancel(requestId) {
    const req = this.activeRequests.get(requestId);
    if (req) {
      clearTimeout(req.timeout);
      this.activeRequests.delete(requestId);
      if (!this.fallbackMode) {
        this.subscriber.unsubscribe(RESPONSE_CHANNEL_PREFIX + requestId).catch(() => {});
      }
      req.reject(new Error('Cancelled'));
    }
  }

  close() {
    for (const [id, req] of this.activeRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error('Client closed'));
    }
    this.activeRequests.clear();

    if (this.subscriber) {
      this.subscriber.disconnect();
    }
    if (this.redis) {
      this.redis.disconnect();
    }
    if (this.fallbackProcess) {
      this.fallbackProcess.kill();
    }
  }
}

export default PathPlannerClient;
