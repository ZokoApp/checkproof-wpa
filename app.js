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
let currentAddress = '—';
let currentCoords = null;

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
// Geolocalización + Reverse Geocoding (Nominatim)
// =======================
function getNowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
async function getAddressFromCoords(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'es-AR' } });
    const data = await resp.json();
    const a = data.address || {};
    const line = [
      [a.road, a.house_number].filter(Boolean).join(' '),
      a.city || a.town || a.village || a.suburb,
      a.state
    ].filter(Boolean).join(' - ');
    return line || data.display_name || `lat:${lat}, lon:${lon}`;
  } catch {
    return `lat:${lat}, lon:${lon}`;
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
      currentAddress = await getAddressFromCoords(latitude, longitude);
      if (addrEl) addrEl.textContent = currentAddress;
      if (tsEl) tsEl.textContent = getNowStr();
    }, () => {
      if (coordsEl) coordsEl.textContent = 'Permiso rechazado';
      if (addrEl) addrEl.textContent = '—';
    }, { enableHighAccuracy: true, timeout: 10000 });
  } catch {
    if (statusEl) statusEl.textContent = 'Error al abrir cámara';
  }
});

btnShot?.addEventListener('click', async () => {
  if (!video.videoWidth) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const stamp1 = currentAddress || 'Dirección no disponible';
  const stamp2 = getNowStr();
  if (tsEl) tsEl.textContent = stamp2;

  const pad = 20;
  const lineH = 36;
  ctx.save();
  ctx.font = '28px monospace';
  ctx.textBaseline = 'bottom';
  const maxWidth = canvas.width - pad*2;
  const m1 = Math.min(ctx.measureText(stamp1).width, maxWidth);
  const m2 = Math.min(ctx.measureText(stamp2).width, maxWidth);
  const boxW = Math.max(m1, m2) + pad*2;
  const boxH = lineH*2 + pad*2;
  const x = pad;
  const y = canvas.height - boxH - pad;

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, boxW, boxH);

  ctx.fillStyle = '#ffffff';
  ctx.fillText(stamp1, x + pad, y + pad + lineH - 8);
  ctx.fillText(stamp2, x + pad, y + pad + lineH*2 - 8);
  ctx.restore();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const blob = await (await fetch(dataUrl)).blob();

  lastCapture = {
    id: crypto.randomUUID(),
    blob,
    meta: {
      address: currentAddress || null,
      coords: currentCoords || null,
      deviceTs: new Date().toISOString()
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
    deviceTs: meta.deviceTs,
    serverTs: serverTimestamp(),
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
  } catch {
    await addToQueue(item);
    if (statusEl) statusEl.textContent = 'Error subiendo: guardado en cola';
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
    } catch {}
  }
  if (statusEl) statusEl.textContent = 'Reintentos finalizados';
  await updateQueueCount();
}

btnRetry?.addEventListener('click', retryQueue);
window.addEventListener('online', retryQueue);
updateQueueCount();
