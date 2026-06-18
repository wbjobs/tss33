const MAGIC = 0xA55A;

const MSG_TYPE = {
  COMMAND: 0x01,
  STATUS: 0x02,
  ACK: 0x03
};

const FLIGHT_MODE = {
  HOVER: 0x00,
  WAYPOINT: 0x01,
  RETURN: 0x02
};

function encodeCommand(droneId, waypoints, speed, mode) {
  const headerSize = 5;
  const waypointSize = 20;
  const payloadSize = 2 + waypoints.length * waypointSize + 5;
  const buffer = Buffer.alloc(headerSize + payloadSize);

  buffer.writeUInt16BE(MAGIC, 0);
  buffer.writeUInt8(MSG_TYPE.COMMAND, 2);
  buffer.writeUInt16BE(payloadSize, 3);

  let offset = 5;
  buffer.writeUInt8(droneId, offset);
  offset += 1;
  buffer.writeUInt8(waypoints.length, offset);
  offset += 1;

  for (const wp of waypoints) {
    buffer.writeDoubleBE(wp.lat, offset);
    offset += 8;
    buffer.writeDoubleBE(wp.lng, offset);
    offset += 8;
    buffer.writeFloatBE(wp.alt, offset);
    offset += 4;
  }

  buffer.writeFloatBE(speed, offset);
  offset += 4;
  buffer.writeUInt8(mode, offset);

  return buffer;
}

function decodeStatus(buffer) {
  if (buffer.length < 4) return null;

  const magic = buffer.readUInt16BE(0);
  if (magic !== MAGIC) return null;

  const msgType = buffer.readUInt8(2);
  if (msgType !== MSG_TYPE.STATUS) return null;

  const count = buffer.readUInt8(3);
  const drones = [];
  let offset = 4;
  const droneSize = 1 + 8 + 8 + 4 + 2 + 4 + 4 + 4 + 1;

  for (let i = 0; i < count; i++) {
    if (offset + droneSize > buffer.length) break;

    drones.push({
      id: buffer.readUInt8(offset),
      lat: buffer.readDoubleBE(offset + 1),
      lng: buffer.readDoubleBE(offset + 9),
      alt: buffer.readFloatBE(offset + 17),
      battery: buffer.readUInt16BE(offset + 21),
      roll: buffer.readFloatBE(offset + 23),
      pitch: buffer.readFloatBE(offset + 27),
      yaw: buffer.readFloatBE(offset + 31),
      status: buffer.readUInt8(offset + 35)
    });
    offset += droneSize;
  }

  return { type: 'status', drones, timestamp: Date.now() };
}

function decodeAck(buffer) {
  if (buffer.length < 6) return null;
  const magic = buffer.readUInt16BE(0);
  if (magic !== MAGIC) return null;
  const msgType = buffer.readUInt8(2);
  if (msgType !== MSG_TYPE.ACK) return null;
  const success = buffer.readUInt8(5) === 1;
  return { type: 'ack', success };
}

function parseBuffer(buffer, bufferAccumulator) {
  bufferAccumulator = Buffer.concat([bufferAccumulator, buffer]);
  const messages = [];

  while (bufferAccumulator.length >= 5) {
    const magic = bufferAccumulator.readUInt16BE(0);
    if (magic !== MAGIC) {
      bufferAccumulator = bufferAccumulator.slice(1);
      continue;
    }

    const msgType = bufferAccumulator.readUInt8(2);

    if (msgType === MSG_TYPE.STATUS) {
      if (bufferAccumulator.length < 4) break;
      const count = bufferAccumulator.readUInt8(3);
      const totalLen = 4 + count * 36;

      if (bufferAccumulator.length < totalLen) break;

      const status = decodeStatus(bufferAccumulator.slice(0, totalLen));
      if (status) messages.push(status);
      bufferAccumulator = bufferAccumulator.slice(totalLen);
    } else if (msgType === MSG_TYPE.ACK) {
      const totalLen = 6;
      if (bufferAccumulator.length < totalLen) break;

      const ack = decodeAck(bufferAccumulator.slice(0, totalLen));
      if (ack) messages.push(ack);
      bufferAccumulator = bufferAccumulator.slice(totalLen);
    } else {
      const length = bufferAccumulator.readUInt16BE(3);
      const totalLen = 5 + length;

      if (bufferAccumulator.length < totalLen) break;
      bufferAccumulator = bufferAccumulator.slice(totalLen);
    }
  }

  return { messages, bufferAccumulator };
}

export {
  MAGIC,
  MSG_TYPE,
  FLIGHT_MODE,
  encodeCommand,
  decodeStatus,
  decodeAck,
  parseBuffer
};
