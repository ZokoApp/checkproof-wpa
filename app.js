// =======================
// PWA Install prompt
// =======================
let deferredPrompt;
const btnInstall = document.getElementById('btnInstall');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (btnInstall) btnInstall.hidden = false;
});
btnInstall?.addEventListener('click', async () => {
  btnInstall.hidden = true;
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
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

let lastCapture = null; // { id, blob, meta }
let currentAddress = { line1: '—', line2: '' }; // "Calle 123", "Ciudad – Provincia"
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
  if (params.get('wm') === '0') WM_ENABLED = false; // ?wm=0 para ocultar watermark
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
// Utilidades: tiempo, carga de scripts y geocoding
// =======================
function getNowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar: ' + src));
    document.head.appendChild(s);
  });
}

// Dirección exacta: "Calle 123" y "Ciudad – Provincia". Fallbacks si faltan datos.
async function getAddressFromCoords(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'es-AR' } });
    const data = await resp.json();
    const a = data.address || {};
    const calle = a.road || a.pedestrian || a.footway || a.path || a.residential || a.neighbourhood || '';
    const num = a.house_number || 's/n';
    const ciudad = a.city || a.town || a.village || a.hamlet || a.suburb || '';
    const provincia = a.state || '';
    const line1 = [calle, num].filter(Boolean).join(' ').trim() || data.display_name || `lat:${lat}, lon:${lon}`;
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
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    video.srcObject = stream;
    if (btnShot) btnShot.disabled = false;
    if (statusEl) statusEl.textContent = 'Cámara lista';

    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      currentCoords = { latitude, longitude };
      if (coordsEl) coordsEl.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      const addr = await getAddressFromCoords(latitude, longitude);
      currentAddress = addr;
      if (addrEl) addrEl.textContent = [addr.line1, addr.line2].filter(Boolean).join(' — ');
      if (tsEl) tsEl.textContent = getNowStr();
    }, () => {
      if (coordsEl) coordsEl.textContent = 'Permiso rechazado';
      currentAddress = { line1: '—', line2: '' };
      if (addrEl) addrEl.textContent = '—';
    }, { enableHighAccuracy: true, timeout: 10000 });
  } catch {
    if (statusEl) statusEl.textContent = 'Error al abrir cámara';
  }
});

// =======================
// Dibujo: helpers (wrap + watermark + QR)
// =======================
function measureLines(ctx, text, maxWidth) {
  const words = String(text || '').split(' ');
  let line = '';
  const lines = [];
  for (let n = 0; n < words.length; n++) {
    const test = line ? line + ' ' + words[n] : words[n];
    if (ctx.measureText(test).width > maxWidth && n > 0) {
      lines.push(line);
      line = words[n];
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function drawWatermarkSmall(ctx, canvas, text) {
  if (!WM_ENABLED) return;
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.font = `${Math.max(22, Math.floor(canvas.width/28))}px monospace`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const pad = 18;
  ctx.fillText(text, pad, canvas.height - pad);
  ctx.restore();
}

// =======================
// Tomar foto (dibujo completo + QR Maps)
// =======================
btnShot?.addEventListener('click', async () => {
  if (!video.videoWidth) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Foto
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Marca de agua pequeña (esquina inferior izquierda)
  drawWatermarkSmall(ctx, canvas, BRAND);

  // QR a Google Maps (si hay coords)
  let mapsUrl = null;
  if (currentCoords) {
    const lat = currentCoords.latitude;
    const lon = currentCoords.longitude;
    mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
    try {
      // Cargamos librería QR una única vez
      await loadScriptOnce('https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js');
      // Generamos QR a 110px
      const qrCanvas = document.createElement('canvas');
      await window.QRCode.toCanvas(qrCanvas, mapsUrl, { width: 110, margin: 0 });
      // Pegamos QR en la esquina inferior izquierda (encima del watermark)
      const outerPad = 18;
      ctx.drawImage(qrCanvas, outerPad, canvas.height - (110 + outerPad + 6));
    } catch {}
  }

  // ==== Sello compacto: esquina inferior derecha ====
  const addr1 = currentAddress?.line1 || 'Dirección no disponible';
  const addr2 = currentAddress?.line2 || '';
  const stampDate = getNowStr();
  if (tsEl) tsEl.textContent = stampDate;

  ctx.save();
  ctx.font = '28px monospace';
  ctx.textBaseline = 'alphabetic';
  const outerPad = 18;
  const innerPad = 16;
  const lineH = 32;

  // Permitimos hasta 80% del ancho para envolver texto
  const maxTextWidth = Math.floor(canvas.width * 0.80);
  // Generamos líneas envueltas
  const lines1 = measureLines(ctx, addr1, maxTextWidth);
  const lines2 = addr2 ? measureLines(ctx, addr2, maxTextWidth) : [];
  const lines3 = [stampDate];
  const allLines = [...lines1, ...lines2, ...lines3];

  // Dimensiones del panel según línea más larga
  const longest = allLines.reduce((m, t) => Math.max(m, ctx.measureText(t).width), 0);
  const boxW = Math.ceil(Math.min(maxTextWidth, longest)) + innerPad * 2;
  const boxH = innerPad * 2 + allLines.length * lineH;

  // Posición: esquina inferior derecha
  const x = canvas.width - boxW - outerPad;
  const y = canvas.height - boxH - outerPad;

  // Fondo
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, boxW, boxH);

  // Texto
  ctx.fillStyle = '#ffffff';
  let yy = y + innerPad + lineH;
  const startX = x + innerPad;
  for (const l of lines1) { ctx.fillText(l, startX, yy); yy += lineH; }
  for (const l of lines2) { ctx.fillText(l, startX, yy); yy += lineH; }
  ctx.fillText(stampDate, startX, yy);

  ctx.restore();

  // Exportar a JPEG (sin EXIF) y preparar para subir
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const blob = await (await fetch(dataUrl)).blob();

  lastCapture = {
    id: crypto.randomUUID(),
    blob,
    meta: {
      address: [addr1, addr2].filter(Boolean).join(' — '),
      coords: currentCoords || null,
      mapsUrl, // lo guardamos también en Firestore
      deviceTs: new Date().toISOString(),
      brand: BRAND
    }
  };
  if (statusEl) statusEl.textContent = 'Foto lista para subir';
  if (btnUpload) btnUpload.disabled = false;
});

// =======================
// Firebase (Auth anónima + Storage + Firestore + Analytics)
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

// Import ESM directo
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const app = initializeApp(firebaseConfig);
try { getAnalytics(app); } catch {}

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

let uid = null;
signInAnonymously(auth).catch(() => {
  if (statusEl) statusEl.textContent = 'Auth anónima falló';
});
onAuthStateChanged(auth, (user) => {
  uid = user?.uid || null;
});

// =======================
// Subida (online) + Cola (offline)
// =======================
async function uploadEvidence({ id, blob, meta }) {
  if (!uid) throw new Error('Sin UID (auth no lista)');

  const path = `evidences/${uid}/${Date.now()}_${id}.jpg`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });

  await addDoc(collection(db, 'evidences'), {
    owner: uid,
    path,
    address: meta.address || null,
    coords: meta.coords || null,
    mapsUrl: meta.mapsUrl || null,
    deviceTs: meta.deviceTs,
    serverTs: serverTimestamp(),
    brand: meta.brand || null,
    clientAgent: navigator.userAgent
  });
}

btnUpload?.addEventListener('click', async () => {
  if (!lastCapture) return;
  const item = lastCapture;
  btnUpload.disabled = true;
  try {
    if (navigator.onLine) {
      await uploadEvidence(item);
      if (statusEl) statusEl.textContent = 'Subido ✅';
    } else {
      await addToQueue(item);
      if (statusEl) statusEl.textContent = 'Sin conexión: agregado a la cola';
    }
    lastCapture = null;
  } catch (e) {
    await addToQueue(item);
    if (statusEl) statusEl.textContent = 'Error subiendo: ' + (e?.message || 'guardado en cola');
  } finally {
    await updateQueueCount();
  }
});

async function retryQueue() {
  const items = await getAllQueue();
  if (!items.length) { if (statusEl) statusEl.textContent = 'No hay pendientes'; return; }
  if (!navigator.onLine) { if (statusEl) statusEl.textContent = 'Sin conexión'; return; }
  if (statusEl) statusEl.textContent = `Reintentando ${items.length}…`;
  for (const item of items) {
    try {
      await uploadEvidence(item);
      await clearItem(item.id);
    } catch {
      // si falla, queda en cola
    }
  }
  if (statusEl) statusEl.textContent = 'Reintentos finalizados';
  await updateQueueCount();
}

btnRetry?.addEventListener('click', retryQueue);
window.addEventListener('online', retryQueue);
updateQueueCount();

