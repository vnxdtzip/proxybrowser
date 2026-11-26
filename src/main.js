// Unleashed Browser — processo principal (Electron)
// Lab xpsec academy: navegador que força TODO o tráfego por um proxy HTTPS.
//
// Pontos de ensino implementados aqui:
//  - proxy HTTPS (TLS até o proxy) via session.setProxy  -> o CONNECT viaja cifrado
//  - autenticação de proxy (Basic) via evento 'login'
//  - fail-closed: se o proxy cai, a navegação ERRA em vez de sair direto (sem leak)
//  - QUIC/HTTP3 desligado para nada escapar por UDP:443
//  - (opcional) SPKI pin para confiar SOMENTE no cert do proxy do lab

const { app, BrowserWindow, session, ipcMain, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

// Ordem de busca do config:
//  1. config.json EXTERNO ao lado do exe (ou raiz do projeto em dev) -> override
//     editável, vence se existir.
//  2. config.enc EMBUTIDO (cifrado) ao lado do main.js -> o .exe self-contained.
// Assim o mesmo binário aceita tanto "exe + config ao lado" quanto "só o exe".
function readExternalConfig() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(path.dirname(process.execPath), 'config.json'));
  }
  candidates.push(path.join(__dirname, '..', 'config.json'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return { origin: c, text: fs.readFileSync(c, 'utf8') };
  }
  return null;
}

function readEmbeddedConfig() {
  const enc = path.join(__dirname, 'config.enc');
  if (!fs.existsSync(enc)) return null;
  const { decrypt } = require('./cfgcrypt');
  return { origin: enc + ' (embutido/cifrado)', text: decrypt(fs.readFileSync(enc)) };
}

function loadConfig() {
  let src = null;
  try {
    src = readExternalConfig() || readEmbeddedConfig();
  } catch (err) {
    fatalConfig(`Falha ao abrir o config embutido.\n\nDetalhe: ${err.message}`);
  }
  if (!src) {
    fatalConfig('Nenhum config encontrado.\n\nColoque um config.json ao lado do ' +
      'Unleashed Browser.exe, ou compile com config embutido (npm run build).');
  }
  try {
    return JSON.parse(src.text);
  } catch (err) {
    fatalConfig(`Config inválido (${src.origin}).\n\nDetalhe: ${err.message}`);
  }
}

function fatalConfig(msg) {
  try { dialog.showErrorBox('Unleashed Browser — config', msg); } catch (_) {}
  console.error(msg);
  app.exit(1);
  throw new Error(msg);
}

const CFG = loadConfig();
const P = CFG.proxy;
const H = CFG.hardening || {};

// User-Agent padrão (Chrome em Windows). Pode ser sobrescrito no config.json
// via "userAgent", e trocado em runtime pela UI.
const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const UA = CFG.userAgent || UA_DEFAULT;
app.userAgentFallback = UA;

// SPKI pin: aceito em proxy.spkiPin (schema novo) ou hardening.spkiPin (compat).
const SPKI = P.spkiPin || (CFG.hardening && CFG.hardening.spkiPin) || '';

// Ajustes editáveis pela UI (QUIC, DNS fail-closed, WebRTC). Persistem em
// settings.json no userData — NÃO no config.json, que o servidor nem usa.
// Sementes: valores antigos de hardening, se o config ainda os trouxer.
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
function defaultSettings() {
  const h = CFG.hardening || {};
  return {
    disableQuic:   h.disableQuic  !== false,  // padrão: ligado
    failClosedDns: !!h.failClosedDns,          // padrão: desligado
    webrtcNoLeak:  h.webrtcNoLeak !== false,    // padrão: ligado
    // Privacidade (padrão: tudo bloqueado)
    blockCamMic:        true,
    blockGeo:           true,
    blockNotifications: true,
    blockAds:           true    // bloqueador de anúncios/rastreadores
  };
}
function loadSettings() {
  try { return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return defaultSettings(); }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(SETTINGS, null, 2));
  } catch (e) { console.error('saveSettings:', e.message); }
}
const SETTINGS = loadSettings();

// Regra de proxy: "https://host:port" aplica o proxy HTTPS a TODOS os esquemas.
const PROXY_RULES = `${P.scheme}://${P.host}:${P.port}`;

// Página inicial própria (status de conexão). Local (file://), abre mesmo com o
// proxy fora; recebe host/porta por query para desenhar o arco e os rótulos.
const START_PAGE = pathToFileURL(path.join(__dirname, 'startpage', 'index.html')).href +
  `?host=${encodeURIComponent(P.host)}&port=${encodeURIComponent(P.port)}`;

// --- Switches de linha de comando (precisam vir ANTES do app ready) ---
if (SETTINGS.disableQuic) {
  app.commandLine.appendSwitch('disable-quic');            // sem HTTP/3 por UDP
}
if (SETTINGS.failClosedDns) {
  app.commandLine.appendSwitch('host-resolver-rules',       // DNS local falha (anti-leak)
    `MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE ${P.host}`);
}
if (SPKI) {
  app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', SPKI);
}

let win;

async function applyProxy() {
  await session.defaultSession.setProxy({
    proxyRules: PROXY_RULES,
    proxyBypassRules: '<-loopback>'   // só o loopback escapa (endpoint do lab)
  });
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
// Guarda os webContents anexados para poder re-aplicar a política em runtime.
const attachedContents = new Set();
const webrtcPolicy = () => SETTINGS.webrtcNoLeak ? 'disable_non_proxied_udp' : 'default';
function hardenWebRTC(contents) {
  attachedContents.add(contents);
  contents.once('destroyed', () => attachedContents.delete(contents));
  try { contents.setWebRTCIPHandlingPolicy(webrtcPolicy()); } catch (_) {}
}
function applyWebRTCAll() {
  for (const c of attachedContents) {
    try { c.setWebRTCIPHandlingPolicy(webrtcPolicy()); } catch (_) {}
  }
}

// --- Privacidade: controla as permissões que os sites pedem ---
// Por padrão o Chromium concederia várias. Aqui negamos tudo o que é sensível,
// com toggles para câmera/mic, geolocalização e notificações. Os handlers leem
// SETTINGS em tempo real, então mudanças valem na próxima requisição (sem reiniciar).
function permAllowed(permission) {
  switch (permission) {
    case 'media':         return !SETTINGS.blockCamMic;        // câmera + microfone
    case 'geolocation':   return !SETTINGS.blockGeo;
    case 'notifications': return !SETTINGS.blockNotifications;
    // Inofensivas para a navegação — liberadas:
    case 'fullscreen':
    case 'pointerLock':
    case 'keyboardLock':
    case 'clipboard-sanitized-write':
    case 'mediaKeySystem':                                     // DRM (streaming)
      return true;
    // Tudo o mais sensível (USB, HID, serial, bluetooth, MIDI, captura de tela,
    // leitura de clipboard, sensores, abrir apps externos, etc.): negado.
    default:
      return false;
  }
}
function setupPrivacy() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => permAllowed(permission));
  try { ses.setDevicePermissionHandler(() => false); } catch (_) {}
}

// --- Bloqueador de anúncios/rastreadores (engine embutido, offline) ---
let blocker = null, blockerActive = false;
function loadBlocker() {
  try {
    const bin = path.join(__dirname, 'assets', 'adblock-engine.bin');
    blocker = ElectronBlocker.deserialize(fs.readFileSync(bin));
  } catch (e) {
    console.error('adblock: engine não carregou:', e.message);
    blocker = null;
  }
}
function applyAdblock() {
  if (!blocker) return;
  const want = !!SETTINGS.blockAds;
  if (want === blockerActive) return;              // evita re-registrar
  try {
    if (want) blocker.enableBlockingInSession(session.defaultSession);
    else blocker.disableBlockingInSession(session.defaultSession);
    blockerActive = want;
  } catch (e) { console.error('adblock:', e.message); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#14161a',
    title: 'Unleashed Browser',
    icon: path.join(__dirname, 'assets', 'logo512.png'),
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
  startPage: START_PAGE,
  userAgent: UA,
  spkiPinned: !!SPKI
}));

// Ajustes de proteção editáveis pela UI.
ipcMain.handle('get-settings', () => ({ ...SETTINGS }));
ipcMain.handle('set-settings', (_e, patch) => {
  const before = { ...SETTINGS };
  if (patch && typeof patch === 'object') {
    for (const k of ['disableQuic', 'failClosedDns', 'webrtcNoLeak',
                     'blockCamMic', 'blockGeo', 'blockNotifications', 'blockAds']) {
      if (k in patch) SETTINGS[k] = !!patch[k];
    }
  }
  saveSettings();
  if (SETTINGS.webrtcNoLeak !== before.webrtcNoLeak) applyWebRTCAll();  // aplica na hora
  if (SETTINGS.blockAds !== before.blockAds) applyAdblock();            // liga/desliga na hora
  // QUIC e DNS são switches de boot -> só valem após reiniciar.
  const restartNeeded =
    SETTINGS.disableQuic !== before.disableQuic ||
    SETTINGS.failClosedDns !== before.failClosedDns;
  return { settings: { ...SETTINGS }, restartNeeded };
});
ipcMain.handle('relaunch-app', () => { app.relaunch(); app.exit(0); });

// Verifica o IP de SAÍDA: faz um GET por dentro do proxy (sessão proxificada) e
// vê qual IP o mundo enxerga. Prova que a saída é a VPS, não o IP real do aluno.
// Como passa pela defaultSession, usa o proxy + a auth do evento 'login'.
ipcMain.handle('check-exit', () => new Promise((resolve) => {
  let done = false;
  const finish = v => { if (!done) { done = true; resolve(v); } };
  let body = '';
  try {
    const req = net.request({
      method: 'GET',
      url: 'https://ipinfo.io/json',
      session: session.defaultSession
    });
    req.on('response', res => {
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          finish({ ok: true, ip: j.ip, city: j.city, region: j.region,
                   country: j.country, org: j.org });
        } catch (e) { finish({ ok: false, error: 'resposta inválida do serviço de IP' }); }
      });
    });
    req.on('error', e => finish({ ok: false, error: e.message }));
    setTimeout(() => finish({ ok: false, error: 'timeout (proxy inacessível?)' }), 12000);
    req.end();
  } catch (e) { finish({ ok: false, error: e.message }); }
}));

app.whenReady().then(async () => {
  await applyProxy();
  setupPrivacy();
  loadBlocker();
  applyAdblock();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
