import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import forge from 'node-forge';
import StateManager from './stateManager.js';
import GatewayClient from './gatewayClient.js';
import PathPlannerClient from './pathPlannerClient.js';
import { FLIGHT_MODE } from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const moduleBase = path.resolve(__dirname, '../../node_modules/@fails-components/webtransport/lib');
const { Http2WebTransportServer } = await import('file://' + path.join(moduleBase, 'http2/node/index.js').replace(/\\/g, '/'));
const { HttpWTSession } = await import('file://' + path.join(moduleBase, 'session.js').replace(/\\/g, '/'));

const PORT = 8080;
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 9000;

const MAX_SEND_RATE = 60;
const MIN_SEND_INTERVAL = 1000 / MAX_SEND_RATE;
const STATS_LOG_INTERVAL = 5000;

const pfxPath = path.resolve(__dirname, '../../certs/cert.pfx');

if (!fs.existsSync(pfxPath)) {
  console.error('Certificate files not found! Please run: node generate-certs.mjs');
  process.exit(1);
}

const stateManager = new StateManager();
const gatewayClient = new GatewayClient(GATEWAY_HOST, GATEWAY_PORT, stateManager);
const pathPlanner = new PathPlannerClient();

const sessions = new Set();
const activePlannings = new Map();

let _encodedCache = null;
let _encodedVersion = -1;
let _lastSendTime = 0;
let _sendTimer = null;
let _pendingSend = false;

let _totalSent = 0;
let _totalDropped = 0;
let _lastStatsTime = Date.now();
let _sentSinceStats = 0;
let _maxLatency = 0;

function encodeStatusSnapshot() {
  const version = stateManager.getVersion();
  if (_encodedCache && _encodedVersion === version) {
    return _encodedCache;
  }

  const snapshot = stateManager.getSnapshot();
  const jsonStr = JSON.stringify({ type: 'status', ...snapshot }) + '\n';
  _encodedCache = Buffer.from(jsonStr, 'utf8');
  _encodedVersion = version;
  return _encodedCache;
}

function scheduleStatusBroadcast() {
  if (_pendingSend) return;
  _pendingSend = true;

  const now = Date.now();
  const elapsed = now - _lastSendTime;

  if (elapsed >= MIN_SEND_INTERVAL) {
    broadcastStatus();
  } else {
    _sendTimer = setTimeout(() => {
      _sendTimer = null;
      broadcastStatus();
    }, MIN_SEND_INTERVAL - elapsed);
  }
}

function broadcastStatus() {
  _pendingSend = false;
  _lastSendTime = Date.now();

  const data = encodeStatusSnapshot();
  let sent = 0;
  let failed = 0;

  for (const session of sessions) {
    if (session._closed) continue;

    try {
      if (session._useDatagram && session._datagramWriter) {
        session._datagramWriter.write(data).catch(() => {
          session._useDatagram = false;
          console.log('Session falling back to streams');
        });
      } else if (session._streamWriter) {
        session._streamWriter.write(data).catch(() => {});
      }
      sent++;
    } catch (e) {
      failed++;
    }
  }

  _totalSent++;
  _sentSinceStats++;

  if (sent > 0 && _totalSent % 100 === 0) {
    const latency = Date.now() - stateManager.lastUpdate;
    _maxLatency = Math.max(_maxLatency, latency);
  }
}

function broadcastPlanningMessage(type, data) {
  const jsonStr = JSON.stringify({ type, ...data, timestamp: Date.now() }) + '\n';
  const buffer = Buffer.from(jsonStr, 'utf8');

  for (const session of sessions) {
    if (session._closed) continue;

    try {
      if (session._streamWriter) {
        session._streamWriter.write(buffer).catch(() => {});
      }
    } catch (e) {}
  }
}

async function readFromStream(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line);
          handleCommand(cmd);
        } catch (e) {
          console.error('Parse command error:', e.message);
        }
      }
    }
  } catch (e) {
  } finally {
    reader.releaseLock();
  }
}

function handleCommand(cmd) {
  switch (cmd.type) {
    case 'mission': {
      const { droneId, waypoints, speed, mode } = cmd;
      const flightMode = mode === 'waypoint' ? FLIGHT_MODE.WAYPOINT :
                         mode === 'return' ? FLIGHT_MODE.RETURN : FLIGHT_MODE.HOVER;

      gatewayClient.sendCommand(droneId, waypoints, speed || 5.0, flightMode);
      break;
    }
    case 'mission_all': {
      const { waypoints, speed, mode } = cmd;
      const flightMode = mode === 'waypoint' ? FLIGHT_MODE.WAYPOINT :
                         mode === 'return' ? FLIGHT_MODE.RETURN : FLIGHT_MODE.HOVER;

      const drones = stateManager.drones;
      for (const drone of drones.values()) {
        gatewayClient.sendCommand(drone.id, waypoints, speed || 5.0, flightMode);
      }
      break;
    }
    case 'formation': {
      handleFormationCommand(cmd);
      break;
    }
    case 'set_rate': {
      const { rate } = cmd;
      const clampedRate = Math.max(1, Math.min(120, rate));
      gatewayClient.setMinUpdateInterval(1000 / clampedRate);
      console.log(`Client requested rate: ${clampedRate}/s`);
      break;
    }
    default:
      console.log('Unknown command type:', cmd.type);
  }
}

async function handleFormationCommand(cmd) {
  const { formationType, centerLat, centerLng, centerAlt, targets, speed } = cmd;

  console.log(`Formation request: ${formationType}, ${targets?.length || 0} targets`);

  const drones = [];
  for (const drone of stateManager.drones.values()) {
    drones.push({
      id: drone.id,
      lat: drone.lat,
      lng: drone.lng,
      alt: drone.alt,
      roll: drone.roll,
      pitch: drone.pitch,
      yaw: drone.yaw
    });
  }

  if (drones.length === 0) {
    broadcastPlanningMessage('formation_error', { message: 'No drones available' });
    return;
  }

  const actualTargets = targets && targets.length > 0
    ? targets.slice(0, drones.length)
    : drones.map((d, i) => ({
        lat: centerLat + (Math.random() - 0.5) * 0.002,
        lng: centerLng + (Math.random() - 0.5) * 0.002,
        alt: centerAlt || 100
      }));

  const requestId = crypto.randomUUID();
  activePlannings.set(requestId, {
    formationType,
    droneCount: drones.length,
    startTime: Date.now()
  });

  broadcastPlanningMessage('formation_started', {
    requestId,
    formationType,
    droneCount: drones.length
  });

  try {
    const onProgress = (data) => {
      if (data.requestId === requestId) {
        broadcastPlanningMessage('formation_progress', {
          requestId,
          iteration: data.iteration,
          completed: data.completed,
          total: data.total,
          points: data.points
        });
      }
    };

    const onCompleted = (data) => {
      if (data.requestId === requestId) {
        cleanup();
      }
    };

    const onError = (data) => {
      if (data.requestId === requestId) {
        cleanup();
      }
    };

    const cleanup = () => {
      pathPlanner.removeListener('planning:progress', onProgress);
      pathPlanner.removeListener('planning:completed', onCompleted);
      pathPlanner.removeListener('planning:error', onError);
    };

    pathPlanner.on('planning:progress', onProgress);
    pathPlanner.on('planning:completed', onCompleted);
    pathPlanner.on('planning:error', onError);

    const result = await pathPlanner.planFormation(drones, actualTargets, speed || 5.0);
    cleanup();

    broadcastPlanningMessage('formation_completed', {
      requestId,
      formationType,
      totalPoints: result.points.length,
      duration: Date.now() - result.startTime
    });

    for (let i = 0; i < drones.length; i++) {
      const droneId = drones[i].id;
      const target = actualTargets[i] || actualTargets[actualTargets.length - 1];
      gatewayClient.sendCommand(droneId, [target], speed || 5.0, FLIGHT_MODE.WAYPOINT);
    }

    activePlannings.delete(requestId);

  } catch (err) {
    console.error('Formation planning failed:', err);
    broadcastPlanningMessage('formation_error', {
      requestId,
      message: err.message
    });
    activePlannings.delete(requestId);
  }
}

async function handleSession(session) {
  sessions.add(session);
  session._closed = false;
  session._useDatagram = true;
  session._datagramWriter = null;
  session._streamWriter = null;

  console.log('New WebTransport session connected, total:', sessions.size);

  try {
    try {
      session._datagramWriter = session.datagrams.writable.getWriter();
    } catch (e) {
      session._useDatagram = false;
    }

    if (!session._useDatagram) {
      const stream = await session.createUnidirectionalStream();
      session._streamWriter = stream.writable.getWriter();
    }

    if (stateManager.getDroneCount() > 0) {
      const data = encodeStatusSnapshot();
      try {
        if (session._useDatagram && session._datagramWriter) {
          session._datagramWriter.write(data).catch(() => {});
        } else if (session._streamWriter) {
          session._streamWriter.write(data).catch(() => {});
        }
      } catch (e) {}
    }

    try {
      for await (const stream of session.incomingBidirectionalStreams) {
        readFromStream(stream.readable);
      }
    } catch (e) {
    }
  } catch (e) {
    console.log('Session error:', e.message);
  } finally {
    session._closed = true;
    try {
      if (session._datagramWriter) session._datagramWriter.releaseLock();
      if (session._streamWriter) session._streamWriter.releaseLock();
    } catch (e) {}
    sessions.delete(session);
    console.log('WebTransport session disconnected, remaining:', sessions.size);
  }
}

async function main() {
  gatewayClient.connect();

  stateManager.subscribe(() => {
    scheduleStatusBroadcast();
  });

  const { ReadableStream } = await import('node:stream/web');

  const pfxData = fs.readFileSync(pfxPath);
  const p12Asn1 = forge.asn1.fromDer(pfxData.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, 'password');

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

  const certPem = forge.pki.certificateToPem(certBags[forge.pki.oids.certBag][0].cert);
  const keyPem = forge.pki.privateKeyToPem(keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key);

  const sessionController = {};
  const sessionStreams = {};

  const serverObj = {
    sessionStream(path) {
      if (sessionStreams[path]) return sessionStreams[path];
      sessionStreams[path] = new ReadableStream({
        start(controller) {
          sessionController[path] = controller;
        },
        cancel() {
          delete sessionController[path];
        }
      });
      return sessionStreams[path];
    },
    onHttpWTSessionVisitor(args) {
      const sesobj = new HttpWTSession({
        object: args.session,
        header: args.header,
        peerAddress: args.peerAddress,
        userData: args.userData ?? {},
        datagramsReadableMode: 'byob',
        parentobj: serverObj
      });
      args.session.jsobj = sesobj;
      if (sessionController[args.path]) {
        sessionController[args.path].enqueue(sesobj);
      }
    },
    onServerListening(evt) {
      console.log(`WebTransport server listening on port ${evt.port}`);
      console.log(`Cert fingerprint: ${getCertFingerprint()}`);
      console.log('Note: WebTransport over HTTP/2 does not support datagrams in all browsers');
    },
    onServerError(err) {
      console.error('Server error:', err);
    },
    onSessionRequest(args) {
      return Promise.resolve({ accept: true });
    },
    setRequestCallback() {},
    addPath(path) {
      if (!sessionStreams[path]) {
        serverObj.sessionStream(path);
      }
    }
  };

  const server = new Http2WebTransportServer({
    port: PORT,
    host: '0.0.0.0',
    cert: certPem,
    privKey: keyPem,
    secret: crypto.randomBytes(32),
    initialBidirectionalStreams: 100,
    initialUnidirectionalStreams: 100
  });

  server.jsobj = serverObj;
  server.addPath('/');
  server.setJSRequestHandler(true);
  server.startServer();

  console.log(`WebTransport server starting on port ${PORT}`);

  setInterval(logServerStats, STATS_LOG_INTERVAL);

  const sessionStream = serverObj.sessionStream('/');
  for await (const session of sessionStream) {
    handleSession(session);
  }
}

function logServerStats() {
  const now = Date.now();
  const elapsed = (now - _lastStatsTime) / 1000;
  const sendRate = Math.round(_sentSinceStats / elapsed);

  console.log(
    `[Server] sessions=${sessions.size} ` +
    `send_rate=${sendRate}/s ` +
    `drones=${stateManager.getDroneCount()} ` +
    `state_version=${stateManager.getVersion()} ` +
    `gateway_rate=${gatewayClient.getStatusRate()}/s ` +
    `throttled=${gatewayClient.isThrottled()}`
  );

  _sentSinceStats = 0;
  _maxLatency = 0;
  _lastStatsTime = now;
}

function getCertFingerprint() {
  const pfxData = fs.readFileSync(pfxPath);
  const p12Asn1 = forge.asn1.fromDer(pfxData.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, 'password');
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const cert = certBags[forge.pki.oids.certBag][0].cert;
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return crypto.createHash('sha256').update(Buffer.from(certDer, 'binary')).digest('base64');
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
