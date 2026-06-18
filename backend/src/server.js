import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import forge from 'node-forge';
import StateManager from './stateManager.js';
import GatewayClient from './gatewayClient.js';
import { FLIGHT_MODE } from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const moduleBase = path.resolve(__dirname, '../../node_modules/@fails-components/webtransport/lib');
const { Http2WebTransportServer } = await import('file://' + path.join(moduleBase, 'http2/node/index.js').replace(/\\/g, '/'));
const { HttpWTSession } = await import('file://' + path.join(moduleBase, 'session.js').replace(/\\/g, '/'));

const PORT = 8080;
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 9000;

const pfxPath = path.resolve(__dirname, '../../certs/cert.pfx');

if (!fs.existsSync(pfxPath)) {
  console.error('Certificate files not found! Please run: node generate-certs.mjs');
  process.exit(1);
}

const stateManager = new StateManager();
const gatewayClient = new GatewayClient(GATEWAY_HOST, GATEWAY_PORT, stateManager);

const sessions = new Set();

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
          console.error('Parse command error:', e.message, line);
        }
      }
    }
  } catch (e) {
    console.log('Stream closed');
  } finally {
    reader.releaseLock();
  }
}

function handleCommand(cmd) {
  console.log('Received command:', cmd.type);

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

      const snapshot = stateManager.getSnapshot();
      for (const drone of snapshot.drones) {
        gatewayClient.sendCommand(drone.id, waypoints, speed || 5.0, flightMode);
      }
      break;
    }
    default:
      console.log('Unknown command type:', cmd.type);
  }
}

async function handleSession(session) {
  sessions.add(session);
  console.log('New WebTransport session connected');

  let datagramWriter;
  let streamWriter;
  let useDatagram = true;

  try {
    datagramWriter = session.datagrams.writable.getWriter();
    console.log('Using datagrams for status updates');
  } catch (e) {
    console.log('Datagrams not available, using streams for status updates');
    useDatagram = false;
  }

  const sendStatus = async (snapshot) => {
    try {
      const data = JSON.stringify({ type: 'status', ...snapshot }) + '\n';
      const encoded = new TextEncoder().encode(data);

      if (useDatagram && datagramWriter) {
        try {
          await datagramWriter.write(encoded);
        } catch (e) {
          useDatagram = false;
          console.log('Falling back to streams for status updates');
        }
      }

      if (!useDatagram) {
        if (!streamWriter) {
          const stream = await session.createUnidirectionalStream();
          streamWriter = stream.writable.getWriter();
        }
        streamWriter.write(encoded).catch(() => {});
      }
    } catch (e) {
      console.error('Send status error:', e.message);
    }
  };

  const unsubscribe = stateManager.subscribe(sendStatus);

  const initialSnapshot = stateManager.getSnapshot();
  if (initialSnapshot.drones.length > 0) {
    sendStatus(initialSnapshot);
  }

  try {
    for await (const stream of session.incomingBidirectionalStreams) {
      readFromStream(stream.readable);
    }
  } catch (e) {
    console.log('Session error:', e.message);
  } finally {
    unsubscribe();
    try {
      if (datagramWriter) datagramWriter.releaseLock();
      if (streamWriter) streamWriter.releaseLock();
    } catch (e) {}
    sessions.delete(session);
    console.log('WebTransport session disconnected');
  }
}

async function main() {
  gatewayClient.connect();

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
      console.log('Session request from:', args.header?.[':authority'] || 'unknown');
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

  const sessionStream = serverObj.sessionStream('/');
  for await (const session of sessionStream) {
    handleSession(session);
  }
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
