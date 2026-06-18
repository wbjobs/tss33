import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pfxPath = path.join(__dirname, 'certs', 'cert.pfx');
const pfx = fs.readFileSync(pfxPath);

const key = crypto.createPrivateKey({
  key: pfx,
  format: 'p12',
  passphrase: 'password'
});

const cert = crypto.createCertificate({
  key: pfx,
  format: 'p12',
  passphrase: 'password'
});

const keyPem = key.export({ type: 'pkcs8', format: 'pem' });
const certPem = cert.export({ type: 'pem' });

fs.writeFileSync(path.join(__dirname, 'certs', 'key.pem'), keyPem);
fs.writeFileSync(path.join(__dirname, 'certs', 'cert.pem'), certPem);

console.log('Certificates exported successfully:');
console.log('  certs/key.pem');
console.log('  certs/cert.pem');

const certInfo = cert.subject;
console.log('\nCertificate Info:');
console.log('  Subject:', certInfo);
console.log('  Valid from:', cert.validFrom);
console.log('  Valid to:', cert.validTo);
