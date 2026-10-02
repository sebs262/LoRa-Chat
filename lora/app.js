// ---------- Constantes BLE de Meshtastic ----------
const SVC  = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const TO   = 'f75c76d2-129e-4dad-a1dd-7866124401e7'; // app -> radio (write)
const FROM = '2c55e69e-4993-11ed-b878-0242ac120002'; // radio -> app (read)
const NUM  = 'ed9da18c-a800-4f66-a670-aa7547e34453'; // aviso de datos nuevos (notify)
const BC   = 0xFFFFFFFF;                             // broadcast

const $ = id => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const nodes = new Map();
let dev, chTo, chFrom, myNum = 0, busy = false, again = false;

// ---------- Protobuf mínimo (solo lo necesario) ----------
const vi   = n => { const o = []; n >>>= 0; while (n > 127) { o.push(n & 127 | 128); n >>>= 7; } o.push(n); return o; };
const fVar = (f, v) => [f << 3, ...vi(v)];
const fFix = (f, v) => [f << 3 | 5, v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];
const fLen = (f, b) => [f << 3 | 2, ...vi(b.length), ...b];

function parse(b) {
  const o = {}; let i = 0;
  const rv = () => { let r = 0, s = 0, c; do { c = b[i++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128); return r; };
  while (i < b.length) {
    const t = rv(), f = t >>> 3, w = t & 7; let v;
    if (w === 0) v = rv();
    else if (w === 2) { const n = rv(); v = b.slice(i, i + n); i += n; }
    else if (w === 5) { v = (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0; i += 4; }
    else if (w === 1) { i += 8; continue; }
    else break;
    (o[f] ??= []).push(v);
  }
  return o;
}

// ---------- Cola GATT (Chrome no permite operaciones simultáneas) ----------
let q = Promise.resolve();
const gatt = f => { const r = q.then(f); q = r.catch(() => {}); return r; };
const write = bytes => gatt(() => chTo.writeValueWithResponse(new Uint8Array(bytes)));

// ---------- Nodos y mensajes ----------
const user = b => { const u = parse(b), s = k => u[k] ? dec.decode(u[k][0]) : ''; return { long: s(2), short: s(3) }; };
const name = n => nodes.get(n)?.short || nodes.get(n)?.long || '!' + n.toString(16).padStart(8, '0');

function renderNodes() {
  const sel = $('dest'), cur = sel.value;
  sel.innerHTML = '<option value="4294967295">Todos (canal)</option>';
  nodes.forEach((u, n) => {
    if (n !== myNum) sel.add(new Option(`${u.short || '?'} - ${u.long || n.toString(16)}`, n));
  });
  sel.value = cur;
  if (sel.value !== cur) sel.value = String(BC);
}

function addMsg(text, mine, who, direct) {
  $('msgs').querySelector('.empty')?.remove();
  const d = document.createElement('div');
  d.className = 'msg' + (mine ? ' mine' : '');
  d.innerHTML = '<small></small><span></span>';
  d.children[0].textContent = (mine ? 'Yo → ' : '') + who + (direct ? ' (directo)' : '');
  d.children[1].textContent = text;
  $('msgs').append(d);
  $('msgs').scrollTop = 1e9;
}

// ---------- Recepción ----------
function handle(bytes) {
  const r = parse(bytes);
  if (r[3]) myNum = parse(r[3][0])[1]?.[0] || 0;                       // MyNodeInfo
  if (r[4]) {                                                          // NodeInfo
    const n = parse(r[4][0]);
    if (n[1] && n[2]) { nodes.set(n[1][0], user(n[2][0])); renderNodes(); }
  }
  if (r[2]) {                                                          // MeshPacket
    const m = parse(r[2][0]), d = m[4] && parse(m[4][0]);
    if (d && d[2]) {
      const port = d[1]?.[0], from = m[1]?.[0] || 0;
      if (port === 1) addMsg(dec.decode(d[2][0]), false, name(from), m[2]?.[0] !== BC); // texto
      if (port === 4 && from) { nodes.set(from, user(d[2][0])); renderNodes(); }       // nodeinfo
    }
  }
  if (r[7]) { setStatus('Conectado: ' + name(myNum)); enable(true); renderNodes(); }  // config lista
}

async function drain() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      for (;;) {
        const v = await gatt(() => chFrom.readValue());
        if (!v.byteLength) break;
        handle(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      }
    } while (again);
  } catch (e) { console.error(e); }
  busy = false;
}

// ---------- Envío ----------
async function send() {
  const t = $('txt').value.trim();
  if (!t) return;
  const to = +$('dest').value;
  const data = [...fVar(1, 1), ...fLen(2, [...enc.encode(t)])];        // portnum=TEXT, payload
  const pkt = [
    ...fFix(2, to),
    ...fLen(4, data),
    ...fFix(6, Math.random() * 0xFFFFFFFF >>> 0 || 1),                 // id del paquete
    ...fVar(9, 3),                                                     // hop_limit
    ...(to === BC ? [] : fVar(10, 1))                                  // want_ack si es directo
  ];
  try {
    await write(fLen(1, pkt));                                         // ToRadio.packet
    addMsg(t, true, to === BC ? 'Todos' : name(to), to !== BC);
    $('txt').value = '';
  } catch (e) { setStatus('Error al enviar: ' + e.message); }
}

// ---------- Conexión ----------
const setStatus = s => $('status').textContent = s;
const enable = on => { $('txt').disabled = $('btnSend').disabled = !on; if (on) $('txt').focus(); };

const sleep = ms => new Promise(r => setTimeout(r, ms));
let linking = false;

// Abre la conexión GATT y arranca la sincronización con el nodo
async function link() {
  const srv = await dev.gatt.connect();
  await sleep(1000);
  const s = await srv.getPrimaryService(SVC);
  chTo = await s.getCharacteristic(TO);
  chFrom = await s.getCharacteristic(FROM);
  const cn = await s.getCharacteristic(NUM);
  // Esta lectura exige conexión cifrada: aquí se dispara el emparejamiento (PIN)
  setStatus('Emparejando… si pide PIN, es el que muestra la pantalla del Heltec');
  const first = await gatt(() => chFrom.readValue());
  if (first.byteLength) handle(new Uint8Array(first.buffer, first.byteOffset, first.byteLength));
  await cn.startNotifications();
  cn.addEventListener('characteristicvaluechanged', drain);
  nodes.clear(); myNum = 0;
  await write(fVar(3, 1234));                                          // want_config_id
  $('btnConn').textContent = 'Desconectar';
  setStatus('Sincronizando…');
  await drain();
}

async function connect() {
  try {
    dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SVC] });
  } catch (e) { setStatus('Desconectado'); return; }
  if (!dev.__listening) { dev.addEventListener('gattserverdisconnected', onDisc); dev.__listening = true; }

  // Al emparejar por primera vez el Heltec suele cortar una vez; el 2.º intento ya entra
  let last;
  linking = true;
  for (let i = 1; i <= 3; i++) {
    try {
      setStatus(`Conectando… (intento ${i}/3)`);
      await link();
      linking = false;
      return;
    } catch (e) {
      last = e;
      console.error(`Intento ${i}:`, e);
      if (dev.gatt.connected) dev.gatt.disconnect();
      await sleep(2500);
    }
  }
  linking = false;
  setStatus(`No se pudo conectar (${last?.name}: ${last?.message}). Revisa el emparejamiento.`);
}

function onDisc() {
  if (linking) return;
  setStatus('Desconectado');
  enable(false);
  $('btnConn').textContent = 'Conectar';
}

$('btnConn').onclick = () => dev?.gatt?.connected ? dev.gatt.disconnect() : connect();
$('btnSend').onclick = send;
$('txt').onkeydown = e => e.key === 'Enter' && send();

if (!navigator.bluetooth) setStatus('Este navegador no soporta Web Bluetooth. Usa Chrome o Chromium.');