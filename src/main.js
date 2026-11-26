// ProxyBrowser — processo principal (Electron)
// Lab xpsec academy: navegador que força TODO o tráfego por um proxy HTTPS.
//
// Pontos de ensino implementados aqui:
//  - proxy HTTPS (TLS até o proxy) via session.setProxy  -> o CONNECT viaja cifrado
//  - autenticação de proxy (Basic) via evento 'login'
//  - fail-closed: se o proxy cai, a navegação ERRA em vez de sair direto (sem leak)
//  - QUIC/HTTP3 desligado para nada escapar por UDP:443
//  - (opcional) SPKI pin para confiar SOMENTE no cert do proxy do lab

const { app, BrowserWindow, session, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Onde procurar o config.json:
//  - empacotado (.exe): AO LADO do executável -> editável sem recompilar,
//    e a senha NÃO fica assada dentro do binário distribuído.
//  - dev (npm start): raiz do projeto.
function resolveConfigPath() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(path.dirname(process.execPath), 'config.json'));
  }
  candidates.push(path.join(__dirname, '..', 'config.json'));
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return candidates[0];
}

function loadConfig() {
  const p = resolveConfigPath();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    const msg = `Não foi possível ler o config.json.\n\nProcurado em:\n  ${p}\n\n` +
      `Coloque um config.json ao lado do ProxyBrowser.exe ` +
      `(use config.example.json como modelo).\n\nDetalhe: ${err.message}`;
    try { dialog.showErrorBox('ProxyBrowser — config ausente', msg); } catch (_) {}
    console.error(msg);
    app.exit(1);
    throw err;
  }
}

const CFG = loadConfig();
const P = CFG.proxy;
const H = CFG.hardening || {};

// Regra de proxy: "https://host:port" aplica o proxy HTTPS a TODOS os esquemas.
const PROXY_RULES = `${P.scheme}://${P.host}:${P.port}`;

// --- Switches de linha de comando (precisam vir ANTES do app ready) ---
if (H.disableQuic !== false) {
  // Sem QUIC/HTTP3: impede caminho alternativo por UDP que ignoraria o proxy.
  app.commandLine.appendSwitch('disable-quic');
}
if (H.spkiPin) {
  // Confia SOMENTE no certificado cujo SPKI casa (o do proxy do lab).
  // Muito melhor que --ignore-certificate-errors (que desliga tudo).
  app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', H.spkiPin);
}

let win;

async function applyProxy() {
  await session.defaultSession.setProxy({
    proxyRules: PROXY_RULES,
    // Só o loopback escapa do proxy (para o endpoint do lab em 127.0.0.1 funcionar).
    // Em um teste "puro" de leak, troque por "" para forçar ATÉ o loopback pelo proxy.
    proxyBypassRules: '<-loopback>'
  });

  if (H.failClosedDns) {
    // DNS fail-closed: qualquer resolução local falha (prova de não-leak de DNS).
    // EXCLUDE no host do proxy, senão o próprio proxy não resolve.
    await session.defaultSession.resolveHost; // no-op defensivo em versões antigas
    app.commandLine.appendSwitch(
      'host-resolver-rules',
      `MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE ${P.host}`
    );
  }
}

// Autenticação do proxy (Basic). Dispara quando o proxy responde 407.
app.on('login', (event, webContents, requestDetails, authInfo, callback) => {
  if (authInfo && authInfo.isProxy) {
    event.preventDefault();
    callback(P.username, P.password);
  }
  // Para auth de SERVIDOR (não-proxy) não fazemos nada: deixa o fluxo normal.
});

// WebRTC: não expor IPs locais (evita vazamento de IP real fora do proxy).
function hardenWebRTC(contents) {
  if (H.webrtcNoLeak === false) return;
  try {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch (_) { /* webview seta sozinho ao anexar */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#14161a',
    title: 'ProxyBrowser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // habilita <webview> para as abas
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Endurece o webview assim que ele anexa.
  win.webContents.on('did-attach-webview', (_e, wc) => hardenWebRTC(wc));
}

// Renderer pergunta a config para mostrar na UI.
ipcMain.handle('get-config', () => ({
  proxy: { scheme: P.scheme, host: P.host, port: P.port, username: P.username },
  homePage: CFG.homePage,
  hardening: H
}));

app.whenReady().then(async () => {
  await applyProxy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
