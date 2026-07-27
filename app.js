// MRD5 Web Bluetooth POC
//
// Re-implements the GATT flow from the RoboJackets apiary-mobile Android app
// (Mrd5Manager.kt / CardRead.kt) using the Web Bluetooth API.
//
// Protocol summary:
//   - Scan/filter on the MLDP service UUID.
//   - Connect -> discover -> get the MLDP data characteristic -> startNotifications().
//     startNotifications() writes the CCCD (0x0100) for us and, if the characteristic
//     requires encryption, the browser/OS raises the pairing dialog automatically.
//     There is no explicit "bond" API in Web Bluetooth.
//   - The device streams card reads as ASCII text chunks. We accumulate them and, after
//     an 80ms debounce, trim the buffer and display the resulting string verbatim (no
//     GTID / access-card interpretation — the raw string is the read).
//   - The reader may also periodically emit a battery status line like "BATT:99/136";
//     those are routed to the battery display instead of the card-reads list.
//   - Manufacturer / model / serial / firmware / hardware / software revisions are read
//     once after connecting from the standard Bluetooth Device Information Service (0x180A).
//   - Nothing is ever written *to* the device.

const MLDP_SERVICE = '00035b03-58e6-07dd-021a-08123a000300';
const MLDP_DATA    = '00035b03-58e6-07dd-021a-08123a000301';
const DEBOUNCE_MS  = 80;

// Standard Bluetooth SIG Device Information Service + characteristics (named aliases
// resolve to 0x180A / 0x2A29 / 0x2A24 / 0x2A25).
const DEVICE_INFO_SERVICE = 'device_information';
const DEVICE_INFO_CHARS = {
  manufacturer: 'manufacturer_name_string', // 0x2A29  e.g. "Blackboard"
  model:        'model_number_string',      // 0x2A24  e.g. "MRD5"
  // Serial Number String (0x2A25) is intentionally omitted: Chrome's Web Bluetooth GATT
  // blocklist forbids reading it (SecurityError), so it could never populate.
  firmware:     'firmware_revision_string', // 0x2A26  e.g. "1.23.5"
  hardware:     'hardware_revision_string', // 0x2A27  e.g. "4.1"
  software:     'software_revision_string', // 0x2A28  e.g. "V3.2"
};

// Battery status line, e.g. "BATT:99/136" — first group is charge percent.
const BATT_REGEX = /^BATT:(\d+)\/(\d+)$/;

// --- DOM references ---------------------------------------------------------
const els = {
  unsupported:   document.getElementById('unsupported'),
  connectBtn:    document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  clearReadsBtn: document.getElementById('clearReadsBtn'),
  clearLogBtn:   document.getElementById('clearLogBtn'),
  status:        document.getElementById('status'),
  deviceName:    document.getElementById('deviceName'),
  battery:       document.getElementById('battery'),
  manufacturer:  document.getElementById('manufacturer'),
  model:         document.getElementById('model'),
  firmware:      document.getElementById('firmware'),
  hardware:      document.getElementById('hardware'),
  software:      document.getElementById('software'),
  readsBody:     document.getElementById('readsBody'),
  log:           document.getElementById('log'),
};

// --- Connection state -------------------------------------------------------
let device = null;
let characteristic = null;
let rxBuffer = '';
let debounceTimer = null;
const decoder = new TextDecoder('ascii');

// --- UI helpers -------------------------------------------------------------
const STATUS_CLASS = {
  idle:       'pill pill--idle',
  working:    'pill pill--working',
  ready:      'pill pill--ready',
  error:      'pill pill--error',
};

function setStatus(text, kind = 'idle') {
  els.status.textContent = text;
  els.status.className = STATUS_CLASS[kind] || STATUS_CLASS.idle;
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.textContent += line + '\n';
  els.log.scrollTop = els.log.scrollHeight;
  // eslint-disable-next-line no-console
  console.log(line);
}

function setConnectedUi(connected) {
  els.connectBtn.disabled = connected;
  els.disconnectBtn.disabled = !connected;
}

// --- Battery + device info --------------------------------------------------
function setBattery(text) {
  els.battery.textContent = text;
}

function setDeviceInfo(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (els[key]) els[key].textContent = value;
  }
}

function resetInfo() {
  setBattery('Unknown');
  for (const key of Object.keys(DEVICE_INFO_CHARS)) {
    els[key].textContent = 'Unknown';
  }
}

// --- Reads rendering --------------------------------------------------------
function addReadRow(data) {
  const emptyRow = els.readsBody.querySelector('tr.empty');
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');

  const timeTd = document.createElement('td');
  timeTd.textContent = new Date().toLocaleTimeString();

  const dataTd = document.createElement('td');
  dataTd.textContent = data;
  dataTd.classList.add('mono');

  tr.appendChild(timeTd);
  tr.appendChild(dataTd);
  els.readsBody.insertBefore(tr, els.readsBody.firstChild);
}

// --- RX handling (mirrors Mrd5Manager.handleRx) -----------------------------
function onRx(event) {
  const value = event.target.value; // DataView
  const chunk = decoder.decode(value);
  rxBuffer += chunk;
  log(`RX chunk (buffer: '${rxBuffer.trim()}')`);

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBuffer, DEBOUNCE_MS);
}

function flushBuffer() {
  debounceTimer = null;
  const data = rxBuffer.trim();
  rxBuffer = '';
  if (data === '') return;

  // Battery status lines are routed to the battery display, not the card-reads list.
  const battMatch = data.match(BATT_REGEX);
  if (battMatch) {
    setBattery(`${battMatch[1]}%`);
    log(`Battery status: '${data}' -> ${battMatch[1]}%`);
    return;
  }

  log(`Card read: '${data}'`);
  addReadRow(data);
}

// --- Connect / disconnect ---------------------------------------------------
async function connect() {
  try {
    setStatus('Requesting device…', 'working');
    log('Requesting device (filtering on MLDP service)…');

    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MLDP_SERVICE] }],
      optionalServices: [MLDP_SERVICE, DEVICE_INFO_SERVICE],
    });

    // Fallback for first hardware bring-up: if the reader does NOT advertise the
    // MLDP service UUID, the filtered chooser above will be empty. Comment out the
    // requestDevice call above and use this instead:
    //
    // device = await navigator.bluetooth.requestDevice({
    //   acceptAllDevices: true,
    //   optionalServices: [MLDP_SERVICE, DEVICE_INFO_SERVICE],
    // });

    els.deviceName.textContent = device.name ? `— ${device.name}` : `— ${device.id}`;
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setStatus('Connecting…', 'working');
    log(`Connecting to ${device.name || device.id}…`);
    const server = await device.gatt.connect();

    log('Discovering MLDP service…');
    const service = await server.getPrimaryService(MLDP_SERVICE);
    characteristic = await service.getCharacteristic(MLDP_DATA);

    log('Enabling notifications (writes CCCD; may trigger OS pairing)…');
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', onRx);

    setConnectedUi(true);
    setStatus('Ready for card reads', 'ready');
    log('Ready. Tap a card on the reader.');

    // Read device identity from the standard Device Information Service. Best-effort: a
    // missing characteristic leaves it "Unknown"; one blocked by Chrome's GATT blocklist
    // (e.g. Serial Number String) shows "Blocked by browser".
    await readDeviceInfo(server);
  } catch (err) {
    // A user cancelling the chooser also lands here (NotFoundError) — treat gently.
    if (err && err.name === 'NotFoundError') {
      log('Device selection cancelled or no matching device found.');
      setStatus('Disconnected', 'idle');
    } else {
      log(`Error: ${err && err.message ? err.message : err}`);
      setStatus('Error', 'error');
    }
    cleanup();
  }
}

async function readDeviceInfo(server) {
  let service;
  try {
    service = await server.getPrimaryService(DEVICE_INFO_SERVICE);
  } catch {
    log('Device Information Service not available on this reader.');
    return;
  }

  for (const [key, uuid] of Object.entries(DEVICE_INFO_CHARS)) {
    try {
      const ch = await service.getCharacteristic(uuid);
      const value = decoder.decode(await ch.readValue()).replace(/\0+$/, '').trim();
      setDeviceInfo({ [key]: value || 'Unknown' });
      log(`Device info ${key}: '${value}'`);
    } catch (err) {
      const name = err && err.name ? err.name : 'Error';
      // Chrome's Web Bluetooth GATT blocklist forbids reading some characteristics as an
      // anti-tracking measure — notably Serial Number String (0x2A25), which surfaces as a
      // SecurityError on readValue(). This is a browser policy, not a device/code issue;
      // native tools (e.g. nRF Connect) can still read it. Show that state honestly.
      if (name === 'SecurityError') {
        setDeviceInfo({ [key]: 'Blocked by browser' });
        log(`Device info ${key} blocked by browser GATT blocklist (SecurityError: ${err.message}).`);
      } else {
        log(`Device info ${key} not available (${name}: ${err && err.message}).`);
      }
    }
  }
}

function disconnect() {
  log('Disconnecting…');
  if (device && device.gatt && device.gatt.connected) {
    device.gatt.disconnect(); // fires gattserverdisconnected -> onDisconnected
  } else {
    onDisconnected();
  }
}

function onDisconnected() {
  log('Device disconnected.');
  setStatus('Disconnected', 'idle');
  cleanup();
}

function cleanup() {
  if (characteristic) {
    characteristic.removeEventListener('characteristicvaluechanged', onRx);
    characteristic = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  rxBuffer = '';
  resetInfo();
  setConnectedUi(false);
}

// --- Wire up ----------------------------------------------------------------
function init() {
  if (!navigator.bluetooth) {
    els.unsupported.hidden = false;
    els.connectBtn.disabled = true;
    setStatus('Unsupported', 'error');
    log('navigator.bluetooth is not available in this browser.');
    return;
  }

  els.connectBtn.addEventListener('click', connect);
  els.disconnectBtn.addEventListener('click', disconnect);
  els.clearReadsBtn.addEventListener('click', () => {
    els.readsBody.innerHTML =
      '<tr class="empty"><td colspan="2">No card reads yet. Connect and tap a card.</td></tr>';
  });
  els.clearLogBtn.addEventListener('click', () => { els.log.textContent = ''; });

  log('Ready. Click Connect to choose an MRD5 reader.');
}

init();
