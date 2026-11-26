// UI do navegador: barra de navegação + webview + status de conexão/proxy.
const view = document.getElementById('view');
const url = document.getElementById('url');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const proxyText = document.getElementById('proxyText');
const pageText = document.getElementById('pageText');

function setConn(state, msg) {
  connDot.className = 'dot ' + (state || '');
  connText.textContent = msg;
}

function normalize(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^[a-z]+:\/\//i.test(s)) return s;         // já tem esquema
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|:)/i.test(s)) return 'https://' + s; // parece domínio
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);       // busca
}

function navigate() {
  const target = normalize(url.value);
  if (target) view.loadURL(target).catch(() => {});
}

document.getElementById('go').onclick = navigate;
url.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(); });
document.getElementById('back').onclick   = () => view.canGoBack()    && view.goBack();
document.getElementById('fwd').onclick     = () => view.canGoForward() && view.goForward();
document.getElementById('reload').onclick  = () => view.reload();

// --- Eventos do webview ---
view.addEventListener('did-start-loading', () => setConn('warn', 'carregando…'));

view.addEventListener('did-stop-loading', () => {
  url.value = view.getURL();
  document.getElementById('back').disabled = !view.canGoBack();
  document.getElementById('fwd').disabled  = !view.canGoForward();
});

view.addEventListener('did-navigate', e => { pageText.textContent = e.url; });

view.addEventListener('did-finish-load', () => {
  // Chegou até aqui => o tráfego passou pelo proxy com sucesso.
  setConn('ok', 'conectado via proxy');
});

// Fail-closed na prática: se o proxy cai ou recusa, o Chromium ERRA aqui.
// Nada de "sair direto" — é o comportamento que queremos demonstrar no lab.
view.addEventListener('did-fail-load', e => {
  if (e.errorCode === -3) return; // ERR_ABORTED (navegação substituída) — ignora
  const map = {
    '-130': 'ERR_PROXY_CONNECTION_FAILED — proxy inacessível (fail-closed OK)',
    '-137': 'ERR_NAME_NOT_RESOLVED',
    '-202': 'ERR_CERT_AUTHORITY_INVALID — cert do proxy não confiável (ver SPKI pin)',
    '-21':  'ERR_NETWORK_CHANGED',
    '-7':   'ERR_TIMED_OUT'
  };
  const label = map[String(e.errorCode)] || (e.errorDescription + ' (' + e.errorCode + ')');
  setConn('bad', label);
  pageText.textContent = e.validatedURL || '';
});

// Carrega config e home page.
(async () => {
  try {
    const cfg = await window.pb.getConfig();
    proxyText.textContent = `${cfg.proxy.scheme}://${cfg.proxy.host}:${cfg.proxy.port} (${cfg.proxy.username})`;
    if (cfg.homePage) { url.value = cfg.homePage; navigate(); }
  } catch (err) {
    setConn('bad', 'falha ao ler config: ' + err.message);
  }
})();
