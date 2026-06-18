import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generateCertificate() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const tbs = {
    version: 2,
    serialNumber: Buffer.from('01', 'hex'),
    signature: 'sha256WithRSAEncryption',
    issuer: [
      { countryName: 'CN' },
      { organizationName: 'DroneControl' },
      { commonName: 'localhost' }
    ],
    validity: {
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    },
    subject: [
      { countryName: 'CN' },
      { organizationName: 'DroneControl' },
      { commonName: 'localhost' }
    ],
    extensions: [
      {
        extnID: 'subjectAltName',
        extnValue: [
          { dNSName: 'localhost' },
          { iPAddress: '127.0.0.1' }
        ]
      },
      {
        extnID: 'keyUsage',
        critical: true,
        extnValue: ['digitalSignature', 'keyEncipherment', 'dataEncipherment']
      },
      {
        extnID: 'extendedKeyUsage',
        extnValue: ['serverAuth', 'clientAuth']
      }
    ]
  };

  const cert = createCertificate(tbs, privateKey);

  const keyPath = path.join(__dirname, 'certs', 'key.pem');
  const certPath = path.join(__dirname, 'certs', 'cert.pem');

  fs.writeFileSync(keyPath, privateKey);
  fs.writeFileSync(certPath, cert);

  console.log('Certificates generated:');
  console.log(`  Key: ${keyPath}`);
  console.log(`  Cert: ${certPath}`);
}

function createCertificate(tbs, privateKey) {
  const signer = crypto.createSign('RSA-SHA256');

  const derTbs = encodeTbsCertificate(tbs);
  signer.update(derTbs);

  const signature = signer.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING
  });

  const derCert = encodeCertificate(derTbs, signature);

  const pem = derToPem(derCert, 'CERTIFICATE');
  return pem;
}

function encodeTbsCertificate(tbs) {
  const parts = [];

  parts.push(encodeSequence([
    encodeInteger(tbs.version),
    encodeInteger(tbs.serialNumber),
    encodeOID([2, 16, 840, 1, 1, 11, 1, 2, 1]),
    encodeNull(),
    encodeName(tbs.issuer),
    encodeValidity(tbs.validity),
    encodeName(tbs.subject)
  ]));

  const spki = encodeSubjectPublicKeyInfo();
  parts.push(spki);

  const extensions = encodeExtensions(tbs.extensions);
  parts.push(encodeContextSpecific(3, extensions, true));

  return encodeSequence(parts);
}

function encodeSequence(parts) {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(content.length), content]);
}

function encodeInteger(value) {
  if (Buffer.isBuffer(value)) {
    if (value[0] & 0x80) {
      return Buffer.concat([Buffer.from([0x02, value.length + 1, 0x00]), value]);
    }
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  }
  if (typeof value === 'number') {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value, 0);
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0 && !(buf[i + 1] & 0x80)) i++;
    const trimmed = buf.slice(i);
    return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed]);
  }
  return Buffer.from([0x02, 0x01, 0x00]);
}

function encodeOID(oid) {
  const bytes = [];
  bytes.push(oid[0] * 40 + oid[1]);
  for (let i = 2; i < oid.length; i++) {
    let value = oid[i];
    const parts = [];
    do {
      parts.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let j = 0; j < parts.length - 1; j++) {
      parts[j] |= 0x80;
    }
    bytes.push(...parts);
  }
  return Buffer.concat([Buffer.from([0x06, bytes.length]), Buffer.from(bytes)]);
}

function encodeNull() {
  return Buffer.from([0x05, 0x00]);
}

function encodeName(name) {
  const parts = name.map(attr => {
    let type, value;
    if (attr.countryName) {
      type = [2, 5, 4, 6];
      value = attr.countryName;
    } else if (attr.organizationName) {
      type = [2, 5, 4, 10];
      value = attr.organizationName;
    } else if (attr.commonName) {
      type = [2, 5, 4, 3];
      value = attr.commonName;
    }
    return encodeSequence([
      encodeSequence([
        encodeOID(type),
        encodeUtf8String(value)
      ])
    ]);
  });
  return encodeSequence(parts);
}

function encodeUtf8String(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([0x0c, buf.length]), buf]);
}

function encodeValidity(validity) {
  return encodeSequence([
    encodeUTCTime(validity.notBefore),
    encodeUTCTime(validity.notAfter)
  ]);
}

function encodeUTCTime(date) {
  const year = date.getUTCFullYear() % 100;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const str = `${pad(year)}${pad(month)}${pad(day)}${pad(hours)}${pad(minutes)}${pad(seconds)}Z`;
  const buf = Buffer.from(str, 'ascii');
  return Buffer.concat([Buffer.from([0x17, buf.length]), buf]);
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

function encodeSubjectPublicKeyInfo() {
  return encodeSequence([
    encodeSequence([
      encodeOID([1, 2, 840, 113549, 1, 1, 1]),
      encodeNull()
    ]),
    encodeBitString(Buffer.from([
      0x30, 0x21, 0x02, 0x01, 0x01, 0x02, 0x1c, 0x00,
      0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]))
  ]);
}

function encodeBitString(buf) {
  const wrapped = Buffer.concat([Buffer.from([0x00]), buf]);
  return Buffer.concat([Buffer.from([0x03, wrapped.length]), wrapped]);
}

function encodeExtensions(extensions) {
  const parts = extensions.map(ext => {
    let extnValue;
    if (ext.extnID === 'subjectAltName') {
      const sanParts = ext.extnValue.map(v => {
        if (v.dNSName) {
          const buf = Buffer.from(v.dNSName, 'ascii');
          return Buffer.concat([Buffer.from([0x82, buf.length]), buf]);
        } else if (v.iPAddress) {
          const parts = v.iPAddress.split('.').map(Number);
          const buf = Buffer.from(parts);
          return Buffer.concat([Buffer.from([0x87, buf.length]), buf]);
        }
        return Buffer.alloc(0);
      });
      extnValue = encodeSequence(sanParts);
    } else if (ext.extnID === 'keyUsage') {
      extnValue = Buffer.from([0x03, 0x02, 0x01, 0xe0]);
    } else if (ext.extnID === 'extendedKeyUsage') {
      extnValue = encodeSequence([
        encodeOID([1, 3, 6, 1, 5, 5, 7, 3, 1]),
        encodeOID([1, 3, 6, 1, 5, 5, 7, 3, 2])
      ]);
    }

    let oid;
    if (ext.extnID === 'subjectAltName') oid = [2, 5, 29, 17];
    else if (ext.extnID === 'keyUsage') oid = [2, 5, 29, 15];
    else if (ext.extnID === 'extendedKeyUsage') oid = [2, 5, 29, 37];

    const seqParts = [encodeOID(oid)];
    if (ext.critical) {
      seqParts.push(Buffer.from([0x01, 0x01, 0xff]));
    }
    seqParts.push(encodeOctetString(extnValue));

    return encodeSequence(seqParts);
  });

  return encodeSequence(parts);
}

function encodeOctetString(buf) {
  return Buffer.concat([Buffer.from([0x04, buf.length]), buf]);
}

function encodeContextSpecific(tag, value, constructed) {
  const tagByte = 0x80 | (constructed ? 0x20 : 0x00) | tag;
  return Buffer.concat([Buffer.from([tagByte]), encodeLength(value.length), value]);
}

function encodeLength(length) {
  if (length < 128) {
    return Buffer.from([length]);
  }
  const bytes = [];
  let l = length;
  while (l > 0) {
    bytes.unshift(l & 0xff);
    l >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function encodeCertificate(tbsDer, signature) {
  return encodeSequence([
    tbsDer,
    encodeSequence([
      encodeOID([2, 16, 840, 1, 1, 11, 1, 2, 1]),
      encodeNull()
    ]),
    encodeBitString(signature)
  ]);
}

function derToPem(der, label) {
  const base64 = der.toString('base64');
  let pem = `-----BEGIN ${label}-----\n`;
  for (let i = 0; i < base64.length; i += 64) {
    pem += base64.slice(i, i + 64) + '\n';
  }
  pem += `-----END ${label}-----\n`;
  return pem;
}

generateCertificate();
