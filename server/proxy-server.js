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
const { Transform } = require('stream');

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
let connId = 0;

// Medidor que conta bytes e espia o 1º chunk (para SNI / status), sem perder dados.
function meter(onBytes, onFirst) {
  let first = true;
  return new Transform({
    transform(chunk, _e, cb) {
      onBytes(chunk.length);
      if (first && onFirst) { first = false; try { onFirst(chunk); } catch (_) {} }
      cb(null, chunk);
    }
  });
}
function fmtB(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
const clientIp = s => (s && s.remoteAddress || '?').replace('::ffff:', '');

// HTTPS do site -> método CONNECT (túnel cifrado). SEM MITM: vemos destino, SNI,
// volume e tempo; o conteúdo (GET/POST/headers/body) continua cifrado ponta a ponta.
server.on('connect', (req, clientSocket, head) => {
  if (!authorized(req)) { require407(clientSocket); return; }

  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;
  const id = ++connId;
  const t0 = Date.now();
  let up = 0, down = 0, sni = null, closed = false;
  log('OPEN', `#${id} ${host}:${port} client=${clientIp(clientSocket)}`);

  const done = () => {
    if (closed) return; closed = true;
    log('CLOSE', `#${id} ${host}:${port}` + (sni ? ` sni=${sni}` : '') +
        ` up=${fmtB(up)} down=${fmtB(down)} dur=${Date.now() - t0}ms`);
  };

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    clientSocket.pipe(meter(n => { up += n; }, c => { sni = parseSNI(c); })).pipe(upstream);
    upstream.pipe(meter(n => { down += n; }, null)).pipe(clientSocket);
  });

  const kill = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on('error', e => { log('ERR', `#${id} ${host}:${port} ${e.code || e.message}`); done(); kill(); });
  clientSocket.on('error', () => { done(); kill(); });
  upstream.on('close', done);
  clientSocket.on('close', done);
});

// HTTP puro (sem TLS): aqui SIM vemos tudo em claro — método, caminho e status.
server.on('request', (req, res) => {
  if (!authorized(req)) { res.writeHead(407, {
    'Proxy-Authenticate': 'Basic realm="xpsec-lab"' }); res.end(); return; }

  let target;
  try { target = new URL(req.url); } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  const id = ++connId;
  const t0 = Date.now();
  log('HTTP', `#${id} ${req.method} ${req.url} client=${clientIp(req.socket)}`);

  const opts = {
    host: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: target.pathname + target.search,
    headers: { ...req.headers }
  };
  delete opts.headers['proxy-authorization'];

  let down = 0, status = '';
  const up = net.connect(opts.port, opts.host, () => {
    up.write(`${req.method} ${opts.path} HTTP/1.1\r\n`);
    for (const [k, v] of Object.entries(opts.headers)) up.write(`${k}: ${v}\r\n`);
    up.write('\r\n');
    req.pipe(up);
    up.pipe(meter(n => { down += n; }, c => {
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(c.toString('latin1', 0, 64));
      if (m) status = m[1];
    })).pipe(res.socket);
  });
  up.on('error', () => { try { res.writeHead(502); res.end('upstream error'); } catch (_) {} });
  up.on('close', () => log('HTTPEND',
    `#${id} ${req.method} ${target.host}${target.pathname} -> ${status || '?'} down=${fmtB(down)} dur=${Date.now() - t0}ms`));
});

// Extrai o SNI (hostname) do ClientHello TLS — confirma o destino dentro do túnel.
function parseSNI(buf) {
  try {
    if (buf.length < 5 || buf[0] !== 0x16) return null;        // TLS handshake
    let p = 5;
    if (buf[p] !== 0x01) return null;                          // ClientHello
    p += 4 + 2 + 32;                                           // hdr + versão + random
    p += 1 + buf[p];                                           // session id
    p += 2 + buf.readUInt16BE(p);                              // cipher suites
    p += 1 + buf[p];                                           // compression
    if (p + 2 > buf.length) return null;
    const end = Math.min(buf.length, p + 2 + buf.readUInt16BE(p)); p += 2;
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
      if (type === 0x0000) {                                   // server_name
        let q = p + 2 + 1;                                     // lista(2) + tipo(1)
        const nameLen = buf.readUInt16BE(q); q += 2;
        if (q + nameLen <= buf.length) return buf.toString('utf8', q, q + nameLen);
        return null;
      }
      p += len;
    }
  } catch (_) {}
  return null;
}

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
  console.log('  (cole em config.json -> proxy.spkiPin para fixar o cert)');
  console.log('  log por conexao: destino, SNI, bytes e tempo.');
  console.log('  conteudo HTTPS fica cifrado (sem MITM); HTTP puro aparece em claro.\n');
});

// SHA-256 do SubjectPublicKeyInfo, base64 — formato do switch do Chromium.
function spkiPin(certPem) {
  const x = new crypto.X509Certificate(certPem);
  const der = x.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64');
}
