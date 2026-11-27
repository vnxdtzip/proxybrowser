'use strict';
// Empacota o Unleashed Browser para Windows x64 de forma CONFIÁVEL.
//
// Por que este script existe (não é só `electron-packager` direto):
//   O prune do @electron/packager usa fs.cp do Node com um filtro ASSÍNCRONO. No
//   Node 20+/24 esse filtro assíncrono + o walk lento do galactus criam um race
//   que, de forma não-determinística, derruba subpastas (dist/, lib/) das
//   dependências de PRODUÇÃO no app.asar — o app empacotado então quebra com
//   "Cannot find module .../@ghostery/adblocker-electron/.../index.js".
//
//   Rodar com --no-prune evita o race, mas aí o próprio binário do Electron
//   (node_modules/electron, ~200 MB) é embutido no asar, inchando tudo.
//
// Solução: montar um diretório de STAGING contendo o app + apenas as
//   dependências de produção (cópia SÍNCRONA, sem o filtro async bugado), e
//   empacotar esse staging com --no-prune. Resultado: asar completo e enxuto.

const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJ = path.resolve(__dirname, '..');
const OUT = path.join(PROJ, 'dist');
const APP_NAME = 'Unleashed Browser';
const ELECTRON_VERSION = require(path.join(PROJ, 'node_modules', 'electron', 'package.json')).version;

// devDependencies que NÃO devem ir para o staging (nem na cópia nem no pacote).
const DEV_SKIP = new Set(['electron', '@electron', '.cache', '.bin']);

// Itens de topo do projeto que não entram no app (mesma intenção dos --ignore).
const TOP_SKIP = new Set(['dist', 'build', 'server', 'config.json', '.git', 'node_modules']);

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function log(msg) { process.stdout.write(msg + '\n'); }

function copyAppFiles(staging) {
  for (const entry of fs.readdirSync(PROJ)) {
    if (TOP_SKIP.has(entry)) continue;
    fs.cpSync(path.join(PROJ, entry), path.join(staging, entry), { recursive: true });
  }
}

// Copia node_modules com um filtro SÍNCRONO (seguro), resolvendo o fecho de
// dependências de produção a partir do package.json — evita arrastar devDeps.
function collectProdModules() {
  const seen = new Set();
  const root = require(path.join(PROJ, 'package.json'));
  const stack = Object.keys(root.dependencies || {});
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    const pkgDir = path.join(PROJ, 'node_modules', name);
    const pkgJson = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;      // hoisted em outro lugar? ignora
    seen.add(name);
    let meta = {};
    try { meta = require(pkgJson); } catch (_) {}
    for (const dep of Object.keys(meta.dependencies || {})) stack.push(dep);
    for (const dep of Object.keys(meta.optionalDependencies || {})) stack.push(dep);
  }
  return seen;
}

function copyProdNodeModules(staging) {
  const prod = collectProdModules();
  const destNM = path.join(staging, 'node_modules');
  fs.mkdirSync(destNM, { recursive: true });
  let count = 0;
  for (const name of prod) {
    if (DEV_SKIP.has(name.split('/')[0])) continue;
    const from = path.join(PROJ, 'node_modules', name);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(destNM, name), { recursive: true });
    count++;
  }
  return count;
}

async function main() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-stage-'));
  log(`staging: ${staging}`);
  try {
    log('copiando arquivos do app...');
    copyAppFiles(staging);
    log('copiando dependências de produção...');
    const n = copyProdNodeModules(staging);
    log(`  ${n} módulos de produção copiados`);

    log(`empacotando (electron ${ELECTRON_VERSION})...`);
    // API direta (sem CLI/shell): preserva o nome com espaço e já faz --no-prune,
    // pois o staging só tem dependências de produção.
    const { packager } = await import('@electron/packager');
    const appPaths = await packager({
      dir: staging,
      name: APP_NAME,
      platform: 'win32',
      arch: 'x64',
      out: OUT,
      overwrite: true,
      prune: false,
      icon: path.join(PROJ, 'src', 'assets', 'icon.ico'),
      electronVersion: ELECTRON_VERSION
    });
    log('OK -> ' + appPaths.join(', '));
  } finally {
    rmrf(staging);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
