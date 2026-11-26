// UI do Unleashed Browser: abas com favicon, navegação, painel de circuito (caminho
// do tráfego + IP de saída + proteções editáveis) e painel de identidade (UA).

const tabstrip = document.getElementById('tabstrip');
const newtabBtn = document.getElementById('newtab');
const views = document.getElementById('views');
const url = document.getElementById('url');
const lock = document.getElementById('lock');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const pageText = document.getElementById('pageText');
const progress = document.getElementById('progress');
const errOverlay = document.getElementById('errOverlay');
const eoMsg = document.getElementById('eoMsg');
const eoUrl = document.getElementById('eoUrl');
const circuitBtn = document.getElementById('circuitBtn');
const circuitPanel = document.getElementById('circuitPanel');
const idBtn = document.getElementById('idBtn');
const idPanel = document.getElementById('idPanel');
const privBtn = document.getElementById('privBtn');
const privPanel = document.getElementById('privPanel');

const ICON = {
  lockSec: '<svg class="ic" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  lockInsec: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3l9 16H3z"/><path d="M12 10v3.5M12 16.5v.3"/></svg>',
  neutral: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>',
  globe: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 4l8 15H4z"/><path d="M12 10v4M12 16.5v.3"/></svg>'
};

let cfg = { homePage: 'about:blank', proxy: {}, userAgent: '', spkiPinned: false };
let settings = { disableQuic: true, failClosedDns: false, webrtcNoLeak: true };
let currentUA = '';
let homeURL = 'about:blank';
let firstHome = true;   // só a 1ª aba da sessão roda a animação completa
const tabs = [];
let activeId = null;
let seq = 0;

const byId = id => tabs.find(t => t.id === id);
const active = () => byId(activeId);
const isActive = t => t && t.id === activeId;
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
// A página inicial é local (file://). Não mostramos a URL interna dela na barra.
const baseOf = u => (u || '').split('?')[0];
const isStart = u => !!(cfg.startPage && baseOf(u) === baseOf(cfg.startPage));
const displayUrl = u => (isStart(u) ? '' : (u || ''));
// URL da home com o flag de animação (completa só na primeira aba da sessão).
function homeTarget() {
  const anim = firstHome ? 1 : 0;
  firstHome = false;
  return cfg.startPage + (cfg.startPage.includes('?') ? '&' : '?') + 'anim=' + anim;
}

function normalize(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (/^[a-z]+:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|:)/i.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function mapErr(e) {
  const map = {
    '-130': 'ERR_PROXY_CONNECTION_FAILED — proxy inacessível (fail-closed OK)',
    '-137': 'ERR_NAME_NOT_RESOLVED',
    '-202': 'ERR_CERT_AUTHORITY_INVALID — cert do proxy não confiável (ver SPKI)',
    '-7':   'ERR_TIMED_OUT'
  };
  return map[String(e.errorCode)] || (e.errorDescription + ' (' + e.errorCode + ')');
}

// Mensagem amigável para a tela de erro.
function errHuman(e) {
  const map = {
    '-130': 'O proxy não respondeu. Verifique se o servidor na VPS está no ar e acessível na porta configurada.',
    '-202': 'O certificado do proxy não é confiável. Confira o SPKI pin no config.json.',
    '-137': 'Não foi possível resolver o endereço do destino.',
    '-105': 'Não foi possível resolver o endereço do destino.',
    '-7':   'A conexão expirou. O proxy ou o destino não respondeu a tempo.',
    '-21':  'A rede mudou durante a conexão. Tente novamente.',
    '-324': 'A conexão foi encerrada sem resposta.'
  };
  return map[String(e.errorCode)] ||
    `${e.errorDescription || 'Falha ao carregar'} (código ${e.errorCode}).`;
}

// Mostra/esconde a tela de erro conforme o estado da aba ativa.
function syncOverlay(t) {
  if (!isActive(t)) return;
  if (t && t.failed) {
    eoMsg.textContent = t.errMsg || '';
    eoUrl.textContent = t.errUrl || '';
    errOverlay.classList.add('show');
  } else {
    errOverlay.classList.remove('show');
  }
}

function setProgress(on) {
  if (on) { progress.classList.add('on'); progress.style.width = '70%'; }
  else { progress.style.width = '100%'; setTimeout(() => {
    progress.classList.remove('on'); progress.style.width = '0'; }, 220); }
}

function setLock(u) {
  if (/^https:/i.test(u)) { lock.innerHTML = ICON.lockSec; lock.className = 'sec';
    lock.title = 'TLS do site + túnel TLS ao proxy'; }
  else if (/^http:/i.test(u)) { lock.innerHTML = ICON.lockInsec; lock.className = 'insec';
    lock.title = 'site sem TLS (o túnel ao proxy continua cifrado)'; }
  else { lock.innerHTML = ICON.neutral; lock.className = ''; lock.title = ''; }
}

function setFav(t, kind, u) {
  const f = t.fav;
  if (kind === 'spin') { f.innerHTML = '<span class="spin"></span>'; return; }
  if (kind === 'img' && u) {
    f.innerHTML = '';
    const img = document.createElement('img');
    img.addEventListener('error', () => setFav(t, 'globe'));
    img.src = u;
    f.appendChild(img);
    return;
  }
  f.innerHTML = kind === 'warn' ? ICON.warn : ICON.globe;
}

function renderStatus(t) {
  const [cls, msg] = t.state || ['', ''];
  connDot.className = 'dot ' + cls;
  connText.textContent = cls === 'bad' ? msg : '';   // só mostra texto em erro
  pageText.textContent = displayUrl(t.pageUrl);
  setLock(isStart(t.pageUrl) ? '' : (t.pageUrl || ''));
}

function updateNav(t) {
  document.getElementById('back').disabled = !t.wv.canGoBack();
  document.getElementById('fwd').disabled  = !t.wv.canGoForward();
}

// --- abas ---
function createTab(target) {
  const id = ++seq;

  const wv = document.createElement('webview');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no');
  if (currentUA) wv.setAttribute('useragent', currentUA);
  const src0 = target || homeURL || 'about:blank';
  wv.src = isStart(src0) ? homeTarget() : src0;
  wv.style.display = 'none';
  views.appendChild(wv);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const fav = document.createElement('span'); fav.className = 'fav';
  const titleEl = document.createElement('span'); titleEl.className = 'tab-title'; titleEl.textContent = 'Nova aba';
  const closeEl = document.createElement('span'); closeEl.className = 'tab-close'; closeEl.innerHTML =
    '<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  tabEl.append(fav, titleEl, closeEl);
  tabstrip.insertBefore(tabEl, newtabBtn);

  const t = { id, wv, tabEl, titleEl, fav, state: ['warn', ''], pageUrl: '', favURL: '' };
  tabs.push(t);
  setFav(t, 'spin');

  tabEl.addEventListener('click', e => { if (e.target !== closeEl && !closeEl.contains(e.target)) activate(id); });
  closeEl.addEventListener('click', e => { e.stopPropagation(); closeTab(id); });
  wireWebview(t);

  activate(id);
  return t;
}

function activate(id) {
  activeId = id;
  for (const t of tabs) {
    const on = t.id === id;
    t.wv.style.display = on ? 'flex' : 'none';
    t.tabEl.classList.toggle('active', on);
  }
  const t = byId(id);
  if (!t) return;
  url.value = displayUrl(t.wv.getURL && t.wv.getURL());
  try { updateNav(t); } catch (_) {}
  renderStatus(t);
  syncOverlay(t);
  if (circuitPanel.classList.contains('open')) renderCircuit();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const [t] = tabs.splice(idx, 1);
  t.wv.remove();
  t.tabEl.remove();
  if (tabs.length === 0) { createTab(homeURL); return; }
  if (activeId === id) activate(tabs[Math.min(idx, tabs.length - 1)].id);
}

function wireWebview(t) {
  const wv = t.wv;

  wv.addEventListener('page-title-updated', e => {
    t.titleEl.textContent = e.title || 'Aba';
    t.titleEl.title = e.title || '';
  });
  wv.addEventListener('page-favicon-updated', e => {
    t.favURL = (e.favicons && e.favicons[0]) || '';
    if (t.favURL) setFav(t, 'img', t.favURL);
  });
  wv.addEventListener('did-start-loading', () => {
    setFav(t, 'spin');
    t.failed = false; t.state = ['warn', ''];
    if (isActive(t)) { renderStatus(t); setProgress(true); syncOverlay(t);
      if (circuitPanel.classList.contains('open')) renderCircuit(); }
  });
  wv.addEventListener('did-stop-loading', () => {
    setFav(t, t.failed ? 'warn' : (t.favURL ? 'img' : 'globe'), t.favURL);
    if (isActive(t)) { url.value = displayUrl(wv.getURL()); updateNav(t); setProgress(false); }
  });
  wv.addEventListener('did-navigate', e => {
    t.pageUrl = e.url; t.favURL = '';
    if (isActive(t)) { url.value = displayUrl(wv.getURL()); renderStatus(t);
      if (circuitPanel.classList.contains('open')) renderCircuit(); }
  });
  wv.addEventListener('did-navigate-in-page', e => {
    if (e.isMainFrame) { t.pageUrl = e.url; if (isActive(t)) renderStatus(t); }
  });
  wv.addEventListener('did-finish-load', () => {
    if (!t.failed) t.state = ['ok', ''];   // não vira "ok" se a carga falhou
    if (isActive(t)) { renderStatus(t); syncOverlay(t);
      if (circuitPanel.classList.contains('open')) renderCircuit(); }
  });
  wv.addEventListener('did-fail-load', e => {
    if (e.errorCode === -3 || !e.isMainFrame) return;   // aborted / subframe: ignora
    t.failed = true;
    t.state = ['bad', mapErr(e)];
    t.errMsg = errHuman(e);
    t.errUrl = e.validatedURL || t.pageUrl || '';
    setFav(t, 'warn');
    if (isActive(t)) { renderStatus(t); setProgress(false); syncOverlay(t);
      if (circuitPanel.classList.contains('open')) renderCircuit(); }
  });
  wv.addEventListener('new-window', e => { if (e.url) createTab(e.url); });
}

// --- navegação ---
function navigate() {
  const t = active();
  const target = normalize(url.value);
  if (t && target) t.wv.loadURL(target).catch(() => {});
}
url.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(); });
document.getElementById('back').onclick   = () => { const t = active(); if (t && t.wv.canGoBack()) t.wv.goBack(); };
document.getElementById('fwd').onclick     = () => { const t = active(); if (t && t.wv.canGoForward()) t.wv.goForward(); };
document.getElementById('reload').onclick  = () => { const t = active(); if (t) t.wv.reload(); };
newtabBtn.addEventListener('click', () => createTab(homeURL));

window.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); createTab(homeURL); }
  else if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
  else if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); url.focus(); url.select(); }
  else if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); const t = active(); if (t) t.wv.reload(); }
  else if (e.key === 'F5') { e.preventDefault(); const t = active(); if (t) t.wv.reload(); }
  else if (e.altKey && e.key === 'ArrowLeft') { const t = active(); if (t && t.wv.canGoBack()) t.wv.goBack(); }
  else if (e.altKey && e.key === 'ArrowRight') { const t = active(); if (t && t.wv.canGoForward()) t.wv.goForward(); }
});

// --- painéis ---
function openPanel(which) {
  for (const p of [circuitPanel, idPanel, privPanel]) p.classList.toggle('open', p === which && !p.classList.contains('open'));
  if (circuitPanel.classList.contains('open')) renderCircuit();
  if (privPanel.classList.contains('open')) paintPrivacy();
}
circuitBtn.addEventListener('click', e => { e.stopPropagation(); openPanel(circuitPanel); });
idBtn.addEventListener('click', e => { e.stopPropagation(); openPanel(idPanel); });
privBtn.addEventListener('click', e => { e.stopPropagation(); openPanel(privPanel); });
document.getElementById('cpClose').addEventListener('click', () => circuitPanel.classList.remove('open'));
document.getElementById('idClose').addEventListener('click', () => idPanel.classList.remove('open'));
document.getElementById('privClose').addEventListener('click', () => privPanel.classList.remove('open'));
document.addEventListener('click', e => {
  for (const [p, b] of [[circuitPanel, circuitBtn], [idPanel, idBtn], [privPanel, privBtn]]) {
    if (p.classList.contains('open') && !p.contains(e.target) && !b.contains(e.target))
      p.classList.remove('open');
  }
});

// --- circuito: info + proteções (toggles) ---
const swQuic = document.getElementById('swQuic');
const swWebrtc = document.getElementById('swWebrtc');
const swDns = document.getElementById('swDns');
const stSpki = document.getElementById('stSpki');
const restartBar = document.getElementById('restartBar');

const swCam = document.getElementById('swCam');
const swGeo = document.getElementById('swGeo');
const swNotif = document.getElementById('swNotif');
const swAds = document.getElementById('swAds');
const stWebrtc = document.getElementById('stWebrtc');

function paintSw(el, on) { el.classList.toggle('on', !!on); el.setAttribute('aria-checked', on ? 'true' : 'false'); }
function paintSettings() {
  paintSw(swQuic, settings.disableQuic);
  paintSw(swWebrtc, settings.webrtcNoLeak);
  paintSw(swDns, settings.failClosedDns);
}
function paintPrivacy() {
  paintSw(swCam, settings.blockCamMic);
  paintSw(swGeo, settings.blockGeo);
  paintSw(swNotif, settings.blockNotifications);
  paintSw(swAds, settings.blockAds);
  stWebrtc.textContent = settings.webrtcNoLeak ? 'protegido' : 'exposto';
  stWebrtc.className = 'state' + (settings.webrtcNoLeak ? ' on' : '');
}
async function toggleSetting(key) {
  settings[key] = !settings[key];
  paintSettings(); paintPrivacy();
  try {
    const r = await window.pb.setSettings({ [key]: settings[key] });
    if (r && r.settings) { settings = r.settings; paintSettings(); paintPrivacy(); }
    if (r && r.restartNeeded) restartBar.classList.add('show');
  } catch (_) {}
}
swQuic.addEventListener('click', () => toggleSetting('disableQuic'));
swWebrtc.addEventListener('click', () => toggleSetting('webrtcNoLeak'));
swDns.addEventListener('click', () => toggleSetting('failClosedDns'));
swCam.addEventListener('click', () => toggleSetting('blockCamMic'));
swGeo.addEventListener('click', () => toggleSetting('blockGeo'));
swNotif.addEventListener('click', () => toggleSetting('blockNotifications'));
swAds.addEventListener('click', () => toggleSetting('blockAds'));
document.getElementById('restartBtn').addEventListener('click', () => window.pb.relaunch());
document.getElementById('eoRetry').addEventListener('click', () => { const t = active(); if (t) t.wv.reload(); });

function renderCircuit() {
  const p = cfg.proxy || {};
  const t = active();
  const failed = !!(t && t.state && t.state[0] === 'bad');
  const dest = hostOf(t && t.pageUrl) || '—';
  document.getElementById('cpDest').textContent = dest;
  document.getElementById('cpDest2').textContent = dest;
  document.getElementById('cpProxy').textContent = `Proxy — ${p.host || '—'}:${p.port || ''}`;
  const geo = cfg._exitGeo ? ` · ${cfg._exitGeo}` : '';
  document.getElementById('cpProxyGeo').textContent =
    failed ? 'conexão falhou — proxy inacessível' : `${(p.scheme || 'https').toUpperCase()}${geo}`;
  document.getElementById('cpProxyNode').classList.toggle('fail', failed);
  stSpki.textContent = cfg.spkiPinned ? 'ativo' : 'não';
  stSpki.className = 'state' + (cfg.spkiPinned ? ' on' : '');
  paintSettings();
}
document.getElementById('cpCheck').addEventListener('click', async () => {
  const btn = document.getElementById('cpCheck');
  const out = document.getElementById('cpExit');
  btn.disabled = true; out.textContent = 'verificando...';
  try {
    const r = await window.pb.checkExit();
    if (r.ok) {
      out.textContent = r.ip + (r.country ? '  (' + r.country + ')' : '');
      cfg._exitGeo = [r.city, r.country].filter(Boolean).join(', ') || (r.org || '');
      const match = r.ip === (cfg.proxy && cfg.proxy.host);
      out.title = (match ? 'confere: é o IP da sua VPS. ' : '') + (r.org || '');
      renderCircuit();
    } else { out.textContent = 'falhou — ' + r.error; }
  } catch (err) { out.textContent = 'erro — ' + err.message; }
  finally { btn.disabled = false; }
});

// --- identidade / user-agent ---
let UA_PRESETS = [];
const uaPreset = document.getElementById('uaPreset');
const uaCustom = document.getElementById('uaCustom');
const uaNow = document.getElementById('uaNow');

function buildPresets(defaultUA) {
  UA_PRESETS = [
    { name: 'Chrome · Windows (padrão)', ua: defaultUA },
    { name: 'Chrome · Android', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36' },
    { name: 'Firefox · Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' },
    { name: 'Safari · macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' },
    { name: 'Safari · iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
    { name: 'Edge · Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0' },
    { name: 'Googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    { name: 'Personalizado...', ua: '__custom__' }
  ];
  uaPreset.innerHTML = '';
  UA_PRESETS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.name;
    uaPreset.appendChild(o);
  });
}
uaPreset.addEventListener('change', () => {
  const sel = UA_PRESETS[Number(uaPreset.value)];
  const custom = sel && sel.ua === '__custom__';
  uaCustom.classList.toggle('show', custom);
  if (custom) { uaCustom.value = uaCustom.value || currentUA; uaCustom.focus(); }
});
function applyUA(ua) {
  if (!ua) return;
  currentUA = ua;
  uaNow.textContent = ua;
  for (const t of tabs) { try { t.wv.setUserAgent(ua); t.wv.reload(); } catch (_) {} }
}
document.getElementById('uaApply').addEventListener('click', () => {
  const sel = UA_PRESETS[Number(uaPreset.value)];
  if (!sel) return;
  const ua = sel.ua === '__custom__' ? uaCustom.value.trim() : sel.ua;
  if (!ua) { uaCustom.focus(); return; }
  applyUA(ua);
  idPanel.classList.remove('open');
});

// --- boot ---
(async () => {
  try { cfg = await window.pb.getConfig(); } catch (_) {}
  try { settings = await window.pb.getSettings(); } catch (_) {}
  currentUA = cfg.userAgent || '';
  homeURL = cfg.startPage || cfg.homePage || 'about:blank';
  buildPresets(currentUA);
  uaNow.textContent = currentUA || '(padrão do Chromium)';
  paintSettings();
  paintPrivacy();
  createTab(homeURL);
})();
