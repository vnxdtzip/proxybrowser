// Cifra do config embutido (AES-256-GCM).
//
// ATENÇÃO — isto é OFUSCAÇÃO, não sigilo. A passphrase abaixo vai embutida no
// binário; quem descompilar o .exe, abrir o app.asar ou inspecionar a memória
// recupera as credenciais. Serve só pra evitar leitura casual do config e
// elevar a barra. NUNCA trate como proteção forte de segredo.
//
// Usado tanto pelo build (build/encrypt-config.js) quanto pelo app (main.js).

const crypto = require('crypto');

// Troque por turma se quiser "chaves" diferentes por lote de .exe.
const PASSPHRASE = 'xpsec-lab::proxybrowser::v1';

function keyFrom(salt) {
  return crypto.scryptSync(PASSPHRASE, salt, 32);
}

// Layout do blob: [salt 16][iv 12][tag 16][ciphertext]
function encrypt(plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = keyFrom(salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([salt, iv, tag, ct]);
}

function decrypt(buf) {
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ct = buf.subarray(44);
  const key = keyFrom(salt);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
