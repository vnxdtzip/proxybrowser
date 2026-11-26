'use strict';
// Página inicial do Unleashed Browser: globo 3D em canvas (sem dependências) com um
// arco "Você -> VPS", barra de progresso, mensagens teatrais de conexão e uma
// verificação REAL da saída pelo proxy (fetch ipinfo) que conclui em Conectado
// ou Falha. Carregada via file://, então abre mesmo com o proxy fora.

const qs = new URLSearchParams(location.search);
const VPS_HOST = qs.get('host') || '—';
const VPS_PORT = qs.get('port') || '';

// ---------- globo (canvas) ----------
const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');
const DPR = Math.min(window.devicePixelRatio || 1, 2);
let W, H, R, CX, CY;
function resize() {
  W = canvas.width = Math.floor(innerWidth * DPR);
  H = canvas.height = Math.floor(innerHeight * DPR);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  R = Math.min(W, H) * 0.30;
  CX = W / 2; CY = H * 0.40;
}
addEventListener('resize', resize); resize();

const TILT = 0.5;
let ang = 0, pulse = 0;
let state = 'connecting';               // 'connected' | 'failed'
const COL = { connecting: '#5a8dd6', connected: '#4ec073', failed: '#e5604f' };

const D2R = Math.PI / 180;
function unit(lat, lng) {
  const la = lat * D2R, lo = lng * D2R;
  return { x: Math.cos(la) * Math.cos(lo), y: Math.sin(la), z: Math.cos(la) * Math.sin(lo) };
}
function rot(p) {
  const x = p.x * Math.cos(ang) + p.z * Math.sin(ang);
  const z = -p.x * Math.sin(ang) + p.z * Math.cos(ang);
  const y2 = p.y * Math.cos(TILT) - z * Math.sin(TILT);
  const z2 = p.y * Math.sin(TILT) + z * Math.cos(TILT);
  return { x, y: y2, z: z2 };
}
function project(u, scale) {
  const p = rot(u);
  return { x: CX + p.x * R * scale, y: CY - p.y * R * scale, z: p.z };
}
function slerp(a, b, t) {
  let d = a.x * b.x + a.y * b.y + a.z * b.z;
  d = Math.max(-1, Math.min(1, d));
  const th = Math.acos(d);
  if (th < 1e-4) return a;
  const s = Math.sin(th), s1 = Math.sin((1 - t) * th) / s, s2 = Math.sin(t * th) / s;
  return { x: a.x * s1 + b.x * s2, y: a.y * s1 + b.y * s2, z: a.z * s1 + b.z * s2 };
}

// grade de pontos do globo
const dots = [];
for (let lat = -80; lat <= 80; lat += 8)
  for (let lng = -180; lng < 180; lng += 8) dots.push(unit(lat, lng));

// marcadores
const client = { lat: 12, lng: -(new Date().getTimezoneOffset() / 60) * 15 };
const vps = { lat: 18, lng: 0, ready: false };

function drawDots() {
  for (const d of dots) {
    const p = project(d, 1);
    const front = p.z > 0;
    const a = front ? 0.12 + 0.45 * p.z : 0.05;
    ctx.fillStyle = `rgba(150,168,196,${a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (front ? 1.5 : 1.0) * DPR, 0, 7);
    ctx.fill();
  }
}
function drawArc() {
  const cu = unit(client.lat, client.lng), vu = unit(vps.lat, vps.lng);
  const col = COL[state];
  ctx.lineWidth = 1.6 * DPR;
  ctx.strokeStyle = col;
  let started = false;
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const u = slerp(cu, vu, t);
    const alt = 1 + 0.34 * Math.sin(Math.PI * t);
    const p = project(u, alt);
    if (p.z > -0.1) {
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    } else { started = false; }
  }
  ctx.globalAlpha = state === 'connecting' ? 0.55 : 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (state === 'connecting') {           // pulso viajando pelo arco
    const u = slerp(cu, vu, pulse);
    const alt = 1 + 0.34 * Math.sin(Math.PI * pulse);
    const p = project(u, alt);
    if (p.z > -0.1) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3 * DPR, 0, 7); ctx.fill();
    }
  }
}
function drawMarker(lat, lng, color, label) {
  const p = project(unit(lat, lng), 1);
  if (p.z <= 0) return;                    // atrás do globo
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(p.x, p.y, 3.2 * DPR, 0, 7); ctx.fill();
  ctx.globalAlpha = 0.25;
  ctx.beginPath(); ctx.arc(p.x, p.y, 7 * DPR, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
  if (label) {
    ctx.fillStyle = 'rgba(231,233,238,.85)';
    ctx.font = `${11 * DPR}px "Segoe UI",sans-serif`;
    ctx.fillText(label, p.x + 9 * DPR, p.y + 4 * DPR);
  }
}
function frame() {
  ctx.clearRect(0, 0, W, H);
  drawDots();
  drawArc();
  drawMarker(client.lat, client.lng, '#e7e9ee', 'Você');
  drawMarker(vps.lat, vps.lng, COL[state] === COL.connecting ? '#5a8dd6' : COL[state], 'VPS');
  ang += 0.0015;
  pulse = (pulse + 0.007) % 1;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- sequência de conexão ----------
const statusEl = document.getElementById('status');
const msgEl = document.getElementById('msg');
const barWrap = document.getElementById('bar');
const barFill = barWrap.querySelector('i');
const detailEl = document.getElementById('detail');
const retryEl = document.getElementById('retry');
const epVps = document.getElementById('epVps');
const epVpsSub = document.getElementById('epVpsSub');
const epClient = document.getElementById('epClient');

epVps.textContent = VPS_HOST + (VPS_PORT ? ':' + VPS_PORT : '');

const STEPS = [
  ['Inicializando túnel...', 15],
  ['Mascarando tráfego...', 40],
  ['Criptografando túnel...', 70],
  ['Verificando saída...', 92]
];
const STEP_MS = 850;
function setBar(p) { barFill.style.width = p + '%'; }
let si = 0;
function step() {
  if (si < STEPS.length) {
    msgEl.textContent = STEPS[si][0];
    setBar(STEPS[si][1]);
    si++;
    setTimeout(step, STEP_MS);
  }
}

// anim=0 (abas depois da primeira): pula o teatro, só verifica rápido.
const ANIM = qs.get('anim') !== '0';
let minMs;
if (ANIM) {
  step();
  minMs = STEPS.length * STEP_MS + 250;
} else {
  msgEl.textContent = 'Verificando saída...';
  setBar(85);
  minMs = 200;
}

// verificação real: fetch pela saída do proxy (ipinfo). Sucesso => túnel de pé.
let data = null, err = null;
const probe = fetch('https://ipinfo.io/json', { cache: 'no-store' })
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(d => { data = d; })
  .catch(e => { err = e; });

const minTime = new Promise(r => setTimeout(r, minMs));

Promise.all([minTime, probe]).then(() => {
  if (data && data.ip) onConnected(data); else onFailed(err);
});

function onConnected(d) {
  state = 'connected';
  setBar(100);
  barWrap.classList.add('ok');
  statusEl.textContent = 'Conectado';
  statusEl.classList.add('ok');
  msgEl.textContent = 'Tráfego saindo pelo túnel.';
  const place = [d.city, d.country].filter(Boolean).join(', ');
  detailEl.innerHTML = `IP de saída <b>${d.ip}</b>` + (place ? ` · ${place}` : '') +
                       (d.org ? `<br>${d.org}` : '');
  epVpsSub.textContent = place || 'localizado';
  if (d.loc && d.loc.includes(',')) {
    const [la, lo] = d.loc.split(',').map(Number);
    if (!isNaN(la) && !isNaN(lo)) { vps.lat = la; vps.lng = lo; vps.ready = true; }
  }
}
function onFailed(e) {
  state = 'failed';
  setBar(100);
  barWrap.classList.add('fail');
  statusEl.textContent = 'Falha na conexão';
  statusEl.classList.add('fail');
  msgEl.textContent = 'O proxy não respondeu. Verifique se o servidor na VPS está no ar.';
  detailEl.textContent = e ? String(e.message || e) : '';
  epVpsSub.textContent = 'inacessível';
  retryEl.classList.add('show');
}
retryEl.addEventListener('click', () => location.reload());
