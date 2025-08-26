// =======================
// CONFIG: URL del Panel (cambia esto si deployás el panel)
// =======================
// En desarrollo local (Next dev): 
// const BASE_API = 'http://localhost:3000';
// Si ya lo publicaste (ej. Vercel): 
// const BASE_API = 'https://TU-DOMINIO-DEL-PANEL.com';
const BASE_API = 'http://localhost:3000';

// =======================
// PWA Install prompt
// =======================
let deferredPrompt;
const btnInstall = document.getElementById('btnInstall');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e; if (btnInstall) btnInstall.hidden = false;
});
btnInstall?.addEventListener('click', async () => {
  btnInstall.hidden = true; if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; }
});

// =======================
// Service Worker
// =======================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}

// =======================
// UI elements
// =======================
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const btnOpenCam = document.getElementById('btnOpenCam');
const btnShot = document.getElementById('btnShot');
const btnUpload = document.getElementById('btnUpload');
const btnRetry = document.getElementById('btnRetry');
const addrEl = document.getElementById('addr');
const tsEl = document.getElementById('ts');
const coordsEl = document.getElementById('coords');
const statusEl = document.getElementById('status');
const queueCountEl = document.getElementById('queueCount');

const codeGate = document.getElementById('codeGate');
const whenLocked = document.getElementById('whenLocked');
const whenUnlocked = document.getElementById('whenUnlocked');
const codeInput = document.getElementById('codeInput');
const btnCodeEnter = document.getElementById('btnCodeEnter');
const btnCodeLogout = document.getElementById('btnCodeLogout');
const operatorLabelEl = document.getElementById('operatorLabel');
const tenantOutEl = document.getElementById('tenantOut');

const captureRoot = document.querySelector('main');

let lastCapture = null;
let currentAddress = { line1: '—', line2: '' };
let currentCoords = null;

// =======================
// Branding / Marca de agua
// =======================
const BRAND_KEY = 'cpBrand';
const DEFAULT_BRAND = 'CheckProof';
let BRAND = localStorage.getItem(BRAND_KEY) || DEFAULT_BRAND;
let WM_ENABLED = true;
try {
  const params = new URLSearchParams(location.search);
  const b = params.get('brand');
  if (b) { BRAND = b; localStorage.setItem(BRAND_KEY, b); }
  if (params.get('wm') === '0') WM_ENABLED = false;
} catch {}

// =======================
// IndexedDB (cola offline)
// =======================
const DB_NAME = 'checkproof-db';
const STORE = 'queue';
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function addToQueue(item) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  await updateQueueCount();
}
async function getAllQueue() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function clearItem(id) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  await updateQueueCount();
}
async function updateQueueCount() {
  const items = await getAllQueue();
  if (queueCountEl) queueCountEl.textContent = `Pendientes: ${items.length}`;
}

// =======================
// Utils (hora, script, geocoding)
// =======================
function getNowStr() {
  const d = new Date(); const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('No se pudo cargar: ' + src));
    document.head.appendChild(s);
  });
}
async function getAddressFromCoords(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'es-AR' } });
    const data = await resp.json();
    const a = data.address || {};
    const calle = a.road || a.pedestrian || a.residential || '';
    const num = a.house_number || 's/n';
    const ciudad = a.city || a.town || a.village || '';
    const provincia = a.state || '';
    const line1 = [calle, num].filter(Boolean).join(' ') || `lat:${lat}, lon:${lon}`;
    const line2 = [ciudad, provincia].filter(Boolean).join(' – ');
    return { line1, line2 };
  } catch {
    return { line1: `lat:${lat}, lon:${lon}`, line2: '' };
  }
}

// =======================
// Cámara
// =======================
let stream;
btnOpenCam?.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    video.srcObject = stream; btnShot.disabled = false; statusEl.textContent = 'Cámara lista';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      currentCoords = { latitude, longitude };
      coordsEl.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      currentAddress = await getAddressFromCoords(latitude, longitude);
      addrEl.textContent = `${currentAddress.line1} — ${currentAddress.line2}`;
      tsEl.textContent = getNowStr();
    }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
  } catch { statusEl.textContent = 'Error al abrir cámara'; }
});

// =======================
// Dibujo (wrap, watermark TOP-LEFT, QR bottom-left, sello bottom-right)
// =======================
function measureLines(ctx, text, maxWidth) {
  const words = String(text || '').split(' '); let line = ''; const lines = [];
  for (let n = 0; n < words.length; n++) {
    const test = line ? line + ' ' + words[n] : words[n];
    if (ctx.measureText(test).width > maxWidth && n > 0) { lines.push(line); line = words[n]; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
function drawWatermarkTopLeft(ctx, canvas, text) {
  if (!WM_ENABLED) return;
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.font = `${Math.max(22, Math.floor(canvas.width/28))}px monospace`;
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const pad = 18; ctx.fillText(text, pad, pad);
  ctx.restore();
}

btnShot?.addEventListener('click', async () => {
  if (!video.videoWidth) return;

  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Foto
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Watermark arriba izquierda
  drawWatermarkTopLeft(ctx, canvas, BRAND);

  // QR Maps abajo izquierda
  let mapsUrl = null;
  if (currentCoords) {
    const { latitude: lat, longitude: lon } = currentCoords;
    mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
    try {
      await loadScriptOnce('https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js');
      const qrCanvas = document.createElement('canvas');
      await window.QRCode.toCanvas(qrCanvas, mapsUrl, { width: 110, margin: 0 });
      const outerPad = 18;
      ctx.drawImage(qrCanvas, outerPad, canvas.height - (110 + outerPad));
    } catch {}
  }

  // Sello abajo derecha (addr + fecha)
  const addr1 = currentAddress.line1 || 'Dirección no disponible';
  const addr2 = currentAddress.line2 || '';
  const stampDate = getNowStr(); tsEl.textContent = stampDate;

  ctx.save();
  ctx.font = '28px monospace';
  const outerPad = 18, innerPad = 16, lineH = 32;
  const maxTextWidth = Math.floor(canvas.width * 0.80);
  const lines1 = measureLines(ctx, addr1, maxTextWidth);
  const lines2 = addr2 ? measureLines(ctx, addr2, maxTextWidth) : [];
  const allLines = [...lines1, ...lines2, stampDate];
  const longest = allLines.reduce((m, t) => Math.max(m, ctx.measureText(t).width), 0);
  const boxW = Math.ceil(Math.min(maxTextWidth, longest)) + innerPad * 2;
  const boxH = innerPad * 2 + allLines.length * lineH;
  const x = canvas.width - boxW - outerPad;
  const y = canvas.height - boxH - outerPad;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  let yy = y + innerPad + lineH; const startX = x + innerPad;
  [...lines1, ...lines2, stampDate].forEach(l => { ctx.fillText(l, startX, yy); yy += lineH; });
  ctx.restore();

  // Exportar
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const blob = await (await fetch(dataUrl)).blob();

  const sess = getSessionInfo(); // { tenantId, operatorId, label }
  lastCapture = {
    id: crypto.randomUUID(),
    blob,
    meta: {
      address: `${addr1} — ${addr2}`,
      coords: currentCoords || null,
      mapsUrl,
      deviceTs: new Date().toISOString(),
      brand: BRAND,
      tenantId: sess?.tenantId || null,
      ownerUid: sess?.operatorId || null,
      operatorLabel: sess?.label || null
    }
  };
  statusEl.textContent = 'Foto lista para subir';
  btnUpload.disabled = false;
});

// =======================
// Firebase (Auth con Custom Token + Storage + Firestore)
// =======================
const firebaseConfig = {
  apiKey: "AIzaSyCphpvQZbzwxvKYHAhi-fIRzeNqtWBdeBY",
  authDomain: "hobby-app-4a267.firebaseapp.com",
  databaseURL: "https://hobby-app-4a267.firebaseio.com",
  projectId: "hobby-app-4a267",
  storageBucket: "hobby-app-4a267.appspot.com",
  messagingSenderId: "994212173425",
  appId: "1:994212173425:web:0274c739e2d2eb778cadd0",
  measurementId: "G-5Y90FXVH42"
};

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js';
import { getAuth, signInWithCustomToken, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const app = initializeApp(firebaseConfig);
try { getAnalytics(app); } catch {}
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
await setPersistence(auth, browserLocalPersistence);

let uid = null;
let sessionCache = null; // { tenantId, operatorId, label }

function setLockedUI(locked, info = '') {
  if (locked) {
    whenLocked.style.display = 'block';
    whenUnlocked.style.display = 'none';
    captureRoot.style.pointerEvents = 'none';
    captureRoot.style.filter = 'grayscale(100%)';
  } else {
    whenLocked.style.display = 'none';
    whenUnlocked.style.display = 'block';
    captureRoot.style.pointerEvents = 'auto';
    captureRoot.style.filter = 'none';
  }
  if (statusEl && info) statusEl.textContent = info;
}

function saveSessionInfo(obj) {
  sessionCache = obj;
  localStorage.setItem('cpSession', JSON.stringify(obj));
  operatorLabelEl.textContent = obj.label || '—';
  tenantOutEl.textContent = obj.tenantId || '—';
}
function getSessionInfo() {
  if (sessionCache) return sessionCache;
  try { sessionCache = JSON.parse(localStorage.getItem('cpSession') || 'null'); } catch {}
  return sessionCache;
}
function clearSessionInfo() {
  sessionCache = null; localStorage.removeItem('cpSession');
  operatorLabelEl.textContent = '—'; tenantOutEl.textContent = '—';
}

onAuthStateChanged(auth, (user) => {
  uid = user?.uid || null;
  const sess = getSessionInfo();
  const locked = !(user && sess && sess.operatorId === user.uid);
  setLockedUI(locked, locked ? 'Ingresá un código para continuar' : 'Sesión activa');
});

// ---- Ingreso por CÓDIGO (canje en el Panel) ----
btnCodeEnter?.addEventListener('click', async () => {
  const code = (codeInput.value || '').trim();
  if (!code) { statusEl.textContent = 'Ingresá un código'; return; }
  btnCodeEnter.disabled = true; statusEl.textContent = 'Validando código…';
  try {
    const r = await fetch(`${BASE_API}/api/code/exchange`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const j = await r.json();
    if (!r.ok) { statusEl.textContent = 'Código inválido o vencido'; btnCodeEnter.disabled = false; return; }

    // j = { customToken, tenantId, operatorId, label }
    await signInWithCustomToken(auth, j.customToken);
    saveSessionInfo({ tenantId: j.tenantId, operatorId: j.operatorId, label: j.label });
    statusEl.textContent = 'Autorizado';
    codeInput.value = '';
  } catch (e) {
    statusEl.textContent = 'Error de red al validar el código';
  } finally {
    btnCodeEnter.disabled = false;
  }
});

// Cerrar sesión
btnCodeLogout?.addEventListener('click', async () => {
  await signOut(auth); clearSessionInfo(); setLockedUI(true, 'Sesión cerrada');
});

// =======================
// Subida (online) + Cola (offline)
// =======================
async function uploadEvidence({ id, blob, meta }) {
  const sess = getSessionInfo();
  if (!uid || !sess?.tenantId) throw new Error('Sesión no válida');

  const path = `evidences/${sess.tenantId}/${uid}/${Date.now()}_${id}.jpg`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });

  await addDoc(collection(db, 'evidences'), {
    tenantId: sess.tenantId,
    ownerUid: uid,
    operatorLabel: meta.operatorLabel || null,
    path,
    address: meta.address || null,
    coords: meta.coords || null,
    mapsUrl: meta.mapsUrl || null,
    brand: meta.brand || null,
    deviceTs: meta.deviceTs,
    serverTs: serverTimestamp(),
    clientAgent: navigator.userAgent
  });
}

btnUpload?.addEventListener('click', async () => {
  if (!lastCapture) return;
  const item = lastCapture; btnUpload.disabled = true;
  try {
    if (navigator.onLine) { await uploadEvidence(item); statusEl.textContent = 'Subido ✅'; }
    else { await addToQueue(item); statusEl.textContent = 'Sin conexión: agregado a la cola'; }
    lastCapture = null;
  } catch (e) {
    await addToQueue(item); statusEl.textContent = 'Error subiendo: guardado en cola';
  } finally { await updateQueueCount(); btnUpload.disabled = false; }
});

btnRetry?.addEventListener('click', async () => {
  const items = await getAllQueue();
  if (!items.length) { statusEl.textContent = 'No hay pendientes'; return; }
  if (!navigator.onLine) { statusEl.textContent = 'Sin conexión'; return; }
  statusEl.textContent = `Reintentando ${items.length}…`;
  for (const it of items) {
    try { await uploadEvidence(it); await clearItem(it.id); } catch {}
  }
  statusEl.textContent = 'Reintentos finalizados'; await updateQueueCount();
});
window.addEventListener('online', () => btnRetry?.click());
updateQueueCount();



