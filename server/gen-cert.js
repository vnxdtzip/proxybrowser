// Gera um certificado self-signed para o proxy do lab.
// Usa o openssl do sistema (confirmado: OpenSSL 3.5.x).
//
// O SAN inclui o host do proxy (config.json). O Chromium EXIGE SAN —
// cert sem SAN é rejeitado mesmo com SPKI; e para host IP precisa de "IP:",
// para hostname precisa de "DNS:".

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const host = CFG.proxy.host;
const dir = path.join(__dirname, 'certs');
fs.mkdirSync(dir, { recursive: true });

const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
const entries = new Set(['DNS:localhost', 'IP:127.0.0.1']);
entries.add(isIp ? `IP:${host}` : `DNS:${host}`);
const san = [...entries].join(',');

const cert = path.join(dir, 'proxy-cert.pem');
const key = path.join(dir, 'proxy-key.pem');

const args = [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', key, '-out', cert,
  '-days', '825',
  '-subj', '/CN=xpsec-lab-proxy',
  '-addext', `subjectAltName=${san}`
];

console.log(`Gerando cert para host "${host}"  (SAN: ${san})`);
const r = spawnSync('openssl', args, { stdio: 'inherit' });

if (r.error && r.error.code === 'ENOENT') {
  console.error('\n[!] openssl não encontrado no PATH.');
  console.error('    Rode o comando manualmente (Git Bash tem openssl):\n');
  console.error(`    openssl ${args.map(a => a.includes(' ') || a.includes('/') ? `"${a}"` : a).join(' ')}\n`);
  process.exit(1);
}
if (r.status !== 0) { process.exit(r.status || 1); }

console.log(`\nOK:\n  ${cert}\n  ${key}`);
console.log('\nAgora suba o proxy:  node server/proxy-server.js');
console.log('Ele vai imprimir o SPKI pin para colar em config.json.\n');
