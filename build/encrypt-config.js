// Build: cifra o config.json em src/config.enc, que será embutido no .exe.
// O config.json em claro NÃO entra no pacote (ver --ignore no package.json).
//
// Uso:  npm run encrypt-config     (ou é chamado por  npm run build)

const fs = require('fs');
const path = require('path');
const { encrypt } = require('../src/cfgcrypt');

const srcCfg = path.join(__dirname, '..', 'config.json');
const outEnc = path.join(__dirname, '..', 'src', 'config.enc');

if (!fs.existsSync(srcCfg)) {
  console.error(`[!] config.json não encontrado em ${srcCfg}`);
  console.error('    Crie a partir do config.example.json com os dados da VPS.');
  process.exit(1);
}

const plain = fs.readFileSync(srcCfg, 'utf8');
try { JSON.parse(plain); } catch (e) {
  console.error('[!] config.json inválido:', e.message); process.exit(1);
}

fs.writeFileSync(outEnc, encrypt(plain));
console.log(`config.enc gerado (${fs.statSync(outEnc).size} bytes) a partir do config.json atual.`);
console.log('Lembre: host/porta/senha/spkiPin embutidos têm que bater com a VPS.');
