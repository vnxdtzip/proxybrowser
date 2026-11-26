// Proxy HTTPS (forward) com autenticação Basic — endpoint do lab.
//
// Por que HTTPS (TLS) no proxy e não HTTP puro:
//   o navegador abre uma conexão TLS ATÉ o proxy e só então fala CONNECT host:443.
//   Resultado: o destino (o "CONNECT exemplo.com:443") viaja dentro do TLS,
//   então um DPI/firewall no meio NÃO lê o hostname em claro.
//
// Fluxo:
//   navegador --TLS--> [este proxy] --TCP--> destino real
//
// Uso:  node server/proxy-server.js
// Requer:  server/certs/proxy-cert.pem e server/certs/proxy-key.pem (ver gen-cert)

const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const P = CFG.proxy;
const CERT_DIR = path.join(__dirname, 'certs');
const CERT = path.join(CERT_DIR, 'proxy-cert.pem');
const KEY = path.join(CERT_DIR, 'proxy-key.pem');

for (const f of [CERT, KEY]) {
  if (!fs.existsSync(f)) {
    console.error(`\n[!] Falta ${path.relative(process.cwd(), f)}.`);
    console.error('    Gere o certificado primeiro:  node server/gen-cert.js\n');
    process.exit(1);
  }
}

const tlsOpts = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };

// --- Verificação de credenciais (Basic) ---
function authorized(req) {
  const h = req.headers['proxy-authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let user, pass;
  try {
    [user, pass] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  } catch { return false; }
  // Comparação em tempo constante para não vazar timing (bom hábito p/ ensinar).
  const ok = (a, b) => {
    const ba = Buffer.from(a || ''), bb = Buffer.from(b || '');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  return ok(user, P.username) && ok(pass, P.password);
}

function require407(socketOrRes) {
  const body =
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
    'Proxy-Authenticate: Basic realm="xpsec-lab"\r\n' +
    'Content-Length: 0\r\n' +
    'Connection: close\r\n\r\n';
  socketOrRes.write(body);
  socketOrRes.end();
}

const server = https.createServer(tlsOpts);

// HTTPS do site -> método CONNECT (túnel TCP cego).
server.on('connect', (req, clientSocket, head) => {
  if (!authorized(req)) { require407(clientSocket); return; }

  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    log('CONNECT', `${host}:${port}`);
  });

  const kill = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on('error', e => { log('ERR', `${host}:${port} ${e.code}`); kill(); });
  clientSocket.on('error', kill);
});

// HTTP puro do site (GET http://...) -> encaminha a requisição.
server.on('request', (req, res) => {
  if (!authorized(req)) { res.writeHead(407, {
    'Proxy-Authenticate': 'Basic realm="xpsec-lab"' }); res.end(); return; }

  let target;
  try { target = new URL(req.url); } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  const opts = {
    host: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: target.pathname + target.search,
    headers: { ...req.headers }
  };
  delete opts.headers['proxy-authorization'];

  const up = net.connect(opts.port, opts.host, () => {
    up.write(`${req.method} ${opts.path} HTTP/1.1\r\n`);
    for (const [k, v] of Object.entries(opts.headers)) up.write(`${k}: ${v}\r\n`);
    up.write('\r\n');
    req.pipe(up);
    up.pipe(res.socket);
    log('HTTP', `${opts.host}:${opts.port} ${req.method}`);
  });
  up.on('error', () => { try { res.writeHead(502); res.end('upstream error'); } catch {} });
});

function log(kind, msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${t}  ${kind.padEnd(7)} ${msg}`);
}

const PORT = P.port;
server.listen(PORT, () => {
  // Imprime o SPKI pin para colar em config.json (hardening.spkiPin),
  // assim o cliente confia SOMENTE neste certificado.
  const spki = spkiPin(fs.readFileSync(CERT));
  console.log('\n=== xpsec-lab proxy HTTPS ===');
  console.log(`  escutando   : https://0.0.0.0:${PORT}`);
  console.log(`  auth        : Basic (${P.username})`);
  console.log(`  SPKI pin    : ${spki}`);
  console.log('  (cole em config.json -> hardening.spkiPin para fixar o cert)\n');
});

// SHA-256 do SubjectPublicKeyInfo, base64 — formato do switch do Chromium.
function spkiPin(certPem) {
  const x = new crypto.X509Certificate(certPem);
  const der = x.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64');
}
