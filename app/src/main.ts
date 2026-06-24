import './style.css';
import 'leaflet/dist/leaflet.css';

import { BleClient, ScanMode } from '@capacitor-community/bluetooth-le';
import type { BleDevice, ScanResult } from '@capacitor-community/bluetooth-le';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import type { Position } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import L from 'leaflet';
import { createIcons, icons } from 'lucide';
import { buildSmartTargets, hasCoordinates, TARGET_MIN_SIGHTINGS } from './smartTargets';
import type { SmartTarget, Spot } from './smartTargets';

const SERVICE_UUID = '7d1d0001-52a1-4b81-9fd2-fd7ec3f50100';
const NOTIFY_UUID = '7d1d0002-52a1-4b81-9fd2-fd7ec3f50100';
const COMMAND_UUID = '7d1d0003-52a1-4b81-9fd2-fd7ec3f50100';
const STORAGE_KEY = 'roadlens.spots.v1';
const APP_VERSION = __APP_VERSION__;
const UPDATE_REPO = __GITHUB_REPO__;
const APP_NAME = 'RoadLens Scout';
const SENSOR_NAME = 'RoadLensESP32';
const MAX_STORED_SPOTS = 2000;
const PHONE_FLASHER_URL = 'https://its-ze.github.io/roadlens-scout/flasher/';
const PHONE_BLE_SWEEP_MS = 15000;

const FLOCK_BLE_PREFIXES = new Set([
  '70:c9:4e', '3c:91:80', 'd8:f3:bc', '80:30:49', 'b8:35:32',
  '14:5a:fc', '74:4c:a1', '08:3a:88', '9c:2f:9d', 'c0:35:32',
  '94:08:53', 'e4:aa:ea', 'f4:6a:dd', '24:b2:b9', '00:f4:8d',
  'd0:39:57', 'e8:d0:fc', 'e0:4f:43', 'b8:1e:a4', '70:08:94',
  '58:8e:81', 'ec:1b:bd', '3c:71:bf', '58:00:e3', '90:35:ea',
  '5c:93:a2', '64:6e:69', '48:27:ea', 'a4:cf:12', '04:0d:84',
  'f0:82:c0', '1c:34:f1', '38:5b:44', '94:34:69', 'b4:e3:f9',
  'b4:1e:52', '14:b5:cd', '94:2a:6f', 'f4:e2:c6', 'd4:11:d6',
  'e0:0a:f6', '82:6b:f2',
]);
const FLOCK_BLE_NAME_PATTERNS = ['fs ext battery', 'penguin', 'flock', 'pigvision'];
const FLOCK_BLE_MANUFACTURER_IDS = new Set([0x09c8]);

type RoadLensUpdaterPlugin = {
  canInstallPackages(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  downloadAndInstall(options: { url: string; fileName: string }): Promise<{
    fileName: string;
    bytes: number;
  }>;
};

const RoadLensUpdater = registerPlugin<RoadLensUpdaterPlugin>('RoadLensUpdater');

type RoadLensUsbDevice = {
  deviceId: number;
  vendorId: number;
  productId: number;
  deviceName: string;
  label: string;
  driverHint: string;
  chipFamily?: string;
  manufacturerName?: string;
  productName?: string;
  serialNumber?: string;
  supported: boolean;
  permissionGranted: boolean;
};

type RoadLensUsbPlugin = {
  listDevices(): Promise<{ devices: RoadLensUsbDevice[] }>;
  requestPermission(options: { deviceId: number }): Promise<{
    granted: boolean;
    device?: RoadLensUsbDevice;
  }>;
  openFlasher(options: { url: string }): Promise<{ opened: boolean }>;
};

const RoadLensUsb = registerPlugin<RoadLensUsbPlugin>('RoadLensUsb');

type SensorStatus = {
  type: 'status';
  device?: string;
  reason?: string;
  uptime_ms?: number;
  channel?: number;
  detections?: number;
  signature_count?: number;
  ble_connected?: boolean;
  sniffer_active?: boolean;
  frames_seen?: number;
  mgmt_frames?: number;
  data_frames?: number;
  wildcard_probes?: number;
  candidate_frames?: number;
  queue_drops?: number;
};

type DetectionMessage = {
  type: 'detection';
  source: string;
  detector?: string;
  mac?: string;
  role?: string;
  label?: string;
  rssi?: number;
  channel?: number;
  frame_type?: number;
  frame_subtype?: number;
  wildcard_probe?: boolean;
  confidence?: number;
  uptime_ms?: number;
};

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  content_type?: string;
  size?: number;
};

type GitHubRelease = {
  tag_name: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: GitHubReleaseAsset[];
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

let map: L.Map;
let markerLayer: L.LayerGroup;
let targetLayer: L.LayerGroup;
let positionLayer: L.LayerGroup;
let spots: Spot[] = readStoredSpots();
let smartTargets: SmartTarget[] = [];
let notificationBuffer = '';
let connectedDevice: BleDevice | null = null;
let lastPosition: Position | null = null;
let watchId: string | null = null;
let usbDevices: RoadLensUsbDevice[] = [];
let selectedUsbDevice: RoadLensUsbDevice | null = null;
let phoneBleSweepActive = false;
let phoneBleSeen = new Map<string, number>();

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="shell" data-mobile-tab="map">
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/brand/roadlens-mark.svg" alt="" />
        <div>
          <span class="eyebrow">RoadLens Scout</span>
          <h1>Signal Map</h1>
        </div>
      </div>

      <div class="status-pill" id="statusPill" data-state="offline">
        <span class="status-dot"></span>
        <span id="statusText">Sensor offline</span>
      </div>

      <div class="actions">
        <button id="connectButton" class="primary"><i data-lucide="bluetooth"></i><span>Connect</span></button>
        <button id="manualButton"><i data-lucide="map-pin-plus"></i><span>Spot</span></button>
        <button id="updateButton"><i data-lucide="cloud-download"></i><span>Update</span></button>
        <button id="exportButton"><i data-lucide="download"></i><span>Export</span></button>
        <button id="clearButton" class="danger"><i data-lucide="trash-2"></i><span>Clear</span></button>
      </div>
    </header>

    <section class="workspace">
      <div class="map-wrap">
        <div id="map"></div>
        <div class="map-title">
          <span>Live field map</span>
          <strong id="mapFocusText">Ready for sightings</strong>
        </div>
        <div class="telemetry">
          <div>
            <span class="metric" id="spotCount">0</span>
            <span>signals</span>
          </div>
          <div>
            <span class="metric" id="targetCount">0</span>
            <span>likely points</span>
          </div>
          <div>
            <span class="metric" id="gpsText">No GPS</span>
            <span>fix</span>
          </div>
          <div>
            <span class="metric" id="signalText">Idle</span>
            <span>sensor</span>
          </div>
        </div>
        <div class="map-legend">
          <span><b class="legend-dot raw"></b>Signal</span>
          <span><b class="legend-dot target"></b>Estimate</span>
          <span><b class="legend-dot you"></b>You</span>
        </div>
      </div>

      <aside class="feed">
        <div class="feed-head">
          <div>
            <h2>Scout Board</h2>
            <p id="targetSummary">No repeat targets yet</p>
          </div>
          <button id="statusButton" class="ghost"><i data-lucide="refresh-cw"></i><span>Status</span></button>
        </div>

        <section class="panel-section setup-panel">
          <div class="section-title">
            <h3>USB Setup</h3>
            <span id="usbSummary">No device checked</span>
          </div>
          <div class="setup-card">
            <div id="usbDeviceCard" class="setup-device">
              <strong>Phone flasher ready</strong>
              <span>Plug in ESP32</span>
            </div>
            <div class="setup-actions">
              <button id="usbScanButton"><i data-lucide="usb"></i><span>Detect</span></button>
              <button id="usbFlashButton" class="primary"><i data-lucide="zap"></i><span>Flash</span></button>
              <button id="bleSweepButton"><i data-lucide="radar"></i><span>BLE Sweep</span></button>
            </div>
          </div>
        </section>

        <section class="panel-section targets-panel">
          <div class="section-title">
            <h3>Likely Points</h3>
            <span>estimated fixes</span>
          </div>
          <div id="targetList" class="target-list"></div>
        </section>

        <section class="panel-section compact signals-panel">
          <div class="section-title">
            <h3>Latest Signals</h3>
            <span>signal feed</span>
          </div>
          <div id="feedList" class="feed-list"></div>
        </section>
      </aside>
    </section>

    <nav class="bottom-tabs" aria-label="RoadLens mobile sections">
      <button class="active" data-mobile-tab-target="map" aria-selected="true">
        <i data-lucide="map"></i><span>Map</span>
      </button>
      <button data-mobile-tab-target="targets" aria-selected="false">
        <i data-lucide="crosshair"></i><span>Targets</span>
      </button>
      <button data-mobile-tab-target="signals" aria-selected="false">
        <i data-lucide="list"></i><span>Signals</span>
      </button>
      <button data-mobile-tab-target="actions" aria-selected="false">
        <i data-lucide="sliders-horizontal"></i><span>Actions</span>
      </button>
      <button data-mobile-tab-target="setup" aria-selected="false">
        <i data-lucide="usb"></i><span>Setup</span>
      </button>
    </nav>
  </main>
`;

createIcons({ icons });

const shell = document.querySelector<HTMLElement>('.shell')!;
const statusText = document.querySelector<HTMLSpanElement>('#statusText')!;
const statusPill = document.querySelector<HTMLDivElement>('#statusPill')!;
const mapFocusText = document.querySelector<HTMLElement>('#mapFocusText')!;
const spotCount = document.querySelector<HTMLSpanElement>('#spotCount')!;
const targetCount = document.querySelector<HTMLSpanElement>('#targetCount')!;
const gpsText = document.querySelector<HTMLSpanElement>('#gpsText')!;
const signalText = document.querySelector<HTMLSpanElement>('#signalText')!;
const targetSummary = document.querySelector<HTMLParagraphElement>('#targetSummary')!;
const targetList = document.querySelector<HTMLDivElement>('#targetList')!;
const feedList = document.querySelector<HTMLDivElement>('#feedList')!;
const connectButton = document.querySelector<HTMLButtonElement>('#connectButton')!;
const usbSummary = document.querySelector<HTMLSpanElement>('#usbSummary')!;
const usbDeviceCard = document.querySelector<HTMLDivElement>('#usbDeviceCard')!;
const usbScanButton = document.querySelector<HTMLButtonElement>('#usbScanButton')!;
const usbFlashButton = document.querySelector<HTMLButtonElement>('#usbFlashButton')!;
const bleSweepButton = document.querySelector<HTMLButtonElement>('#bleSweepButton')!;
const mobileTabButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-tab-target]'),
);

connectButton.addEventListener('click', () => {
  if (connectedDevice) {
    void disconnectSensor();
  } else {
    void connectSensor();
  }
});
document.querySelector<HTMLButtonElement>('#manualButton')!.addEventListener('click', saveManualSpot);
document.querySelector<HTMLButtonElement>('#updateButton')!.addEventListener('click', checkForUpdate);
document.querySelector<HTMLButtonElement>('#exportButton')!.addEventListener('click', exportGeoJson);
document.querySelector<HTMLButtonElement>('#clearButton')!.addEventListener('click', clearSpots);
document.querySelector<HTMLButtonElement>('#statusButton')!.addEventListener('click', () => sendCommand('status'));
usbScanButton.addEventListener('click', () => {
  void refreshUsbDevices();
});
usbFlashButton.addEventListener('click', () => {
  void openPhoneFlasher();
});
bleSweepButton.addEventListener('click', () => {
  void runPhoneBleSweep();
});
mobileTabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setMobileTab(button.dataset.mobileTabTarget ?? 'map');
  });
});

initMap();
renderUsbSetup();
render();
void startLocationWatch();

function setMobileTab(tab: string) {
  shell.dataset.mobileTab = tab;
  for (const button of mobileTabButtons) {
    const isActive = button.dataset.mobileTabTarget === tab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }

  if (tab === 'map') {
    window.setTimeout(() => map.invalidateSize(), 160);
  }
}

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
  }).setView([39.8283, -98.5795], 4);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  targetLayer = L.layerGroup().addTo(map);
  positionLayer = L.layerGroup().addTo(map);
}

async function connectSensor() {
  try {
    connectButton.disabled = true;
    setSensorState('busy', 'Preparing Bluetooth');
    await startLocationWatch();
    await BleClient.initialize({ androidNeverForLocation: false });

    const device = await findSensorDevice();

    setSensorState('busy', `Connecting to ${device.name ?? 'sensor'}`);
    await BleClient.connect(device.deviceId, () => {
      handleSensorDisconnect();
    });

    connectedDevice = device;
    await BleClient.startNotifications(
      device.deviceId,
      SERVICE_UUID,
      NOTIFY_UUID,
      handleNotification,
    );
    setSensorState('online', `${device.name ?? SENSOR_NAME} connected`);
    signalText.textContent = 'Linked';
    updateConnectionButton();
    await sendCommand('status');
  } catch (error) {
    setSensorState('error', error instanceof Error ? error.message : 'Connection failed');
    signalText.textContent = 'Error';
  } finally {
    connectButton.disabled = false;
    updateConnectionButton();
  }
}

async function disconnectSensor() {
  if (!connectedDevice) {
    handleSensorDisconnect();
    return;
  }

  const deviceId = connectedDevice.deviceId;
  connectButton.disabled = true;
  setSensorState('busy', 'Disconnecting sensor');

  try {
    await BleClient.stopNotifications(deviceId, SERVICE_UUID, NOTIFY_UUID).catch(() => undefined);
    await BleClient.disconnect(deviceId).catch(() => undefined);
  } finally {
    connectButton.disabled = false;
    handleSensorDisconnect();
  }
}

function handleSensorDisconnect() {
  connectedDevice = null;
  notificationBuffer = '';
  setSensorState('offline', 'Sensor disconnected');
  signalText.textContent = 'Offline';
  updateConnectionButton();
}

function updateConnectionButton() {
  const icon = connectedDevice ? 'bluetooth-off' : 'bluetooth';
  const label = connectedDevice ? 'Disconnect' : 'Connect';
  connectButton.classList.toggle('danger', Boolean(connectedDevice));
  connectButton.classList.toggle('primary', !connectedDevice);
  connectButton.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
  createIcons({ icons });
}

async function findSensorDevice(): Promise<BleDevice> {
  if (Capacitor.getPlatform() !== 'web') {
    const scannedDevice = await scanForSensorDevice();
    if (scannedDevice) {
      return scannedDevice;
    }
  }

  return requestSensorFromPicker();
}

async function scanForSensorDevice(): Promise<BleDevice | null> {
  let bestDevice: BleDevice | null = null;
  let bestRssi = Number.NEGATIVE_INFINITY;

  setSensorState('busy', 'Scanning for RoadLensESP32');

  try {
    await BleClient.requestLEScan(
      {
        allowDuplicates: true,
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
      },
      (result: ScanResult) => {
        const name = result.localName ?? result.device.name ?? '';
        const uuids = [
          ...(result.uuids ?? []),
          ...(result.device.uuids ?? []),
        ].map((uuid) => uuid.toLowerCase());
        const isRoadLens =
          name.startsWith('RoadLens') || uuids.includes(SERVICE_UUID);

        if (!isRoadLens) {
          return;
        }

        const rssi = result.rssi ?? Number.NEGATIVE_INFINITY;
        if (!bestDevice || rssi > bestRssi) {
          bestDevice = result.device;
          bestRssi = rssi;
          setSensorState('busy', `Found ${name || SENSOR_NAME}`);
        }
      },
    );

    await delay(6500);
  } catch {
    return null;
  } finally {
    await BleClient.stopLEScan().catch(() => undefined);
  }

  return bestDevice;
}

async function requestSensorFromPicker(): Promise<BleDevice> {
  const attempts = [
    {
      label: 'Opening RoadLens service picker',
      options: {
        services: [SERVICE_UUID],
        optionalServices: [SERVICE_UUID],
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
      },
    },
    {
      label: 'Opening RoadLens name picker',
      options: {
        namePrefix: 'RoadLens',
        optionalServices: [SERVICE_UUID],
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
      },
    },
    {
      label: 'Opening broad BLE picker',
      options: {
        optionalServices: [SERVICE_UUID],
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
      },
    },
  ];
  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      setSensorState('busy', attempt.label);
      return await BleClient.requestDevice(attempt.options);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('No BLE sensor selected');
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function sendCommand(command: string) {
  if (!connectedDevice) {
    setSensorState('offline', 'Sensor offline');
    return;
  }
  const bytes = encoder.encode(`${command}\n`);
  await BleClient.write(
    connectedDevice.deviceId,
    SERVICE_UUID,
    COMMAND_UUID,
    new DataView(bytes.buffer),
  );
}

async function refreshUsbDevices() {
  usbScanButton.disabled = true;
  setUsbState('Checking USB', 'Scanning phone USB');

  try {
    if (!Capacitor.isNativePlatform()) {
      usbDevices = [];
      selectedUsbDevice = null;
      setUsbState('Android app only', 'Use the APK on the phone');
      return;
    }

    const result = await RoadLensUsb.listDevices();
    usbDevices = result.devices ?? [];
    selectedUsbDevice =
      usbDevices.find((device) => device.supported) ?? usbDevices[0] ?? null;
    renderUsbSetup();

    if (selectedUsbDevice) {
      setUsbState(
        selectedUsbDevice.supported ? 'ESP32 USB found' : 'USB device found',
        selectedUsbDevice.label,
      );
    } else {
      setUsbState('No USB device', 'Plug in ESP32');
    }
  } catch (error) {
    usbDevices = [];
    selectedUsbDevice = null;
    setUsbState('USB check failed', error instanceof Error ? error.message : 'USB unavailable');
  } finally {
    usbScanButton.disabled = false;
  }
}

async function openPhoneFlasher() {
  if (!selectedUsbDevice) {
    await refreshUsbDevices();
  }

  let device = selectedUsbDevice;
  if (device && !device.permissionGranted && Capacitor.isNativePlatform()) {
    setUsbState('USB permission', device.label);
    try {
      const permission = await RoadLensUsb.requestPermission({ deviceId: device.deviceId });
      if (!permission.granted) {
        setUsbState('USB permission denied', device.label);
        return;
      }
      device = permission.device ?? device;
      selectedUsbDevice = device;
      usbDevices = usbDevices.map((item) =>
        item.deviceId === device?.deviceId ? { ...item, permissionGranted: true } : item,
      );
    } catch (error) {
      setUsbState('USB permission failed', error instanceof Error ? error.message : 'Permission failed');
      return;
    }
  }

  const flasherUrl = buildPhoneFlasherUrl(device);
  setUsbState('Opening flasher', device?.label ?? 'RoadLens flasher');

  try {
    if (Capacitor.isNativePlatform()) {
      await RoadLensUsb.openFlasher({ url: flasherUrl });
    } else {
      window.open(flasherUrl, '_blank', 'noopener');
    }
    setUsbState('Flasher opened', device?.label ?? 'RoadLens flasher');
  } catch (error) {
    setUsbState('Flasher blocked', error instanceof Error ? error.message : flasherUrl);
  }
}

function buildPhoneFlasherUrl(device: RoadLensUsbDevice | null) {
  const params = new URLSearchParams({
    source: 'roadlens-app',
    app: APP_VERSION,
  });

  if (device) {
    params.set('vendor', toHexId(device.vendorId));
    params.set('product', toHexId(device.productId));
    params.set('driver', device.driverHint);
    if (device.chipFamily) {
      params.set('chip', device.chipFamily);
    }
  }

  return `${PHONE_FLASHER_URL}?${params.toString()}`;
}

function renderUsbSetup() {
  const device = selectedUsbDevice;
  usbFlashButton.disabled = false;

  if (!Capacitor.isNativePlatform()) {
    usbSummary.textContent = 'Android app only';
    usbDeviceCard.innerHTML = `
      <strong>Phone USB setup</strong>
      <span>Install the APK on Android</span>
    `;
    return;
  }

  if (!device) {
    usbSummary.textContent = usbDevices.length ? `${usbDevices.length} unsupported` : 'No device checked';
    usbDeviceCard.innerHTML = `
      <strong>Phone flasher ready</strong>
      <span>Plug in ESP32</span>
    `;
    return;
  }

  usbSummary.textContent = device.supported
    ? `${device.driverHint.toUpperCase()} ${device.permissionGranted ? 'ready' : 'found'}`
    : 'Unsupported USB';
  usbDeviceCard.innerHTML = `
    <strong>${escapeHtml(device.label)}</strong>
    <span>${toHexId(device.vendorId)}:${toHexId(device.productId)} | ${
      device.permissionGranted ? 'permission ready' : 'permission needed'
    }</span>
  `;
}

function setUsbState(summary: string, detail: string) {
  usbSummary.textContent = summary;
  usbDeviceCard.innerHTML = `
    <strong>${escapeHtml(summary)}</strong>
    <span>${escapeHtml(detail)}</span>
  `;
}

function toHexId(value: number) {
  return `0x${value.toString(16).padStart(4, '0')}`;
}

function handleNotification(value: DataView) {
  const chunk = decoder.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  notificationBuffer += chunk;

  let newlineIndex = notificationBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = notificationBuffer.slice(0, newlineIndex).trim();
    notificationBuffer = notificationBuffer.slice(newlineIndex + 1);
    if (line) {
      handleSensorLine(line);
    }
    newlineIndex = notificationBuffer.indexOf('\n');
  }
}

function handleSensorLine(line: string) {
  try {
    const message = JSON.parse(line) as SensorStatus | DetectionMessage;
    if (message.type === 'status') {
      handleStatus(message);
    } else if (message.type === 'detection') {
      void saveDetection(message);
    }
  } catch {
    setSensorState('online', line.slice(0, 90));
  }
}

function handleStatus(status: SensorStatus) {
  const reason = status.reason ? ` ${status.reason}` : '';
  const channel = status.channel ? ` ch${status.channel}` : '';
  setSensorState(status.ble_connected === false ? 'offline' : 'online', `${status.device ?? SENSOR_NAME}${reason}${channel}`);

  if (typeof status.detections === 'number' && status.detections > 0) {
    signalText.textContent = `${status.detections}`;
  } else if (status.sniffer_active) {
    signalText.textContent = 'Scan';
  } else {
    signalText.textContent = 'Linked';
  }

  if (status.sniffer_active && status.detections === 0 && typeof status.frames_seen === 'number') {
    const candidates = status.candidate_frames ?? 0;
    const wildcards = status.wildcard_probes ?? 0;
    mapFocusText.textContent =
      status.frames_seen > 0
        ? `Scanning: ${status.frames_seen} frames, ${candidates} candidates, ${wildcards} wildcard probes`
        : 'Scanning: no 2.4 GHz frames seen yet';
  }
}

async function runPhoneBleSweep() {
  if (phoneBleSweepActive) {
    return;
  }

  phoneBleSweepActive = true;
  bleSweepButton.disabled = true;
  let adsSeen = 0;
  let matches = 0;

  try {
    await startLocationWatch();
    await BleClient.initialize({ androidNeverForLocation: false });
    setUsbState('BLE sweep running', 'Scanning phone BLE for 15 seconds');

    await BleClient.requestLEScan(
      {
        allowDuplicates: true,
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
      },
      (result: ScanResult) => {
        adsSeen++;
        const match = classifyPhoneBleResult(result);
        if (!match) {
          return;
        }

        const duplicateKey = `${match.mac}|${match.label}|${match.method}`;
        const now = Date.now();
        const lastSeen = phoneBleSeen.get(duplicateKey) ?? 0;
        if (now - lastSeen < 15000) {
          return;
        }

        phoneBleSeen.set(duplicateKey, now);
        matches++;
        void saveDetection({
          type: 'detection',
          source: 'phone-ble',
          detector: 'phone-ble',
          mac: match.mac,
          role: match.method,
          label: match.label,
          rssi: result.rssi ?? undefined,
          channel: undefined,
          frame_type: undefined,
          frame_subtype: undefined,
          wildcard_probe: false,
          confidence: match.confidence,
          uptime_ms: Math.round(performance.now()),
        });
      },
    );

    await delay(PHONE_BLE_SWEEP_MS);
  } catch (error) {
    setUsbState('BLE sweep failed', error instanceof Error ? error.message : 'BLE scan unavailable');
    return;
  } finally {
    await BleClient.stopLEScan().catch(() => undefined);
    phoneBleSweepActive = false;
    bleSweepButton.disabled = false;
  }

  setUsbState(
    matches > 0 ? 'BLE sweep found hits' : 'BLE sweep done',
    `${matches} matches from ${adsSeen} advertisements`,
  );
}

function classifyPhoneBleResult(result: ScanResult) {
  const name = (result.localName ?? result.device.name ?? '').trim();
  const lowerName = name.toLowerCase();
  const mac = normalizeMac(result.device.deviceId) ?? result.device.deviceId ?? 'unknown-ble';
  const prefix = mac.length >= 8 ? mac.slice(0, 8).toLowerCase() : '';
  const manufacturerId = firstManufacturerId(result);

  if (manufacturerId != null && FLOCK_BLE_MANUFACTURER_IDS.has(manufacturerId)) {
    return {
      mac,
      method: 'ble-mfr',
      label: 'flock-ble-manufacturer',
      confidence: 92,
    };
  }

  const namePattern = FLOCK_BLE_NAME_PATTERNS.find((pattern) => lowerName.includes(pattern));
  if (namePattern) {
    return {
      mac,
      method: 'ble-name',
      label: `flock-ble-${namePattern.replaceAll(' ', '-')}`,
      confidence: 90,
    };
  }

  if (prefix && FLOCK_BLE_PREFIXES.has(prefix)) {
    return {
      mac,
      method: 'ble-oui',
      label: 'flock-ble-prefix',
      confidence: prefix === '82:6b:f2' ? 88 : 80,
    };
  }

  return null;
}

function firstManufacturerId(result: ScanResult) {
  const maybeData = result as ScanResult & {
    manufacturerData?: Record<string, DataView | string | number[]>;
  };
  const manufacturerData = maybeData.manufacturerData;
  if (!manufacturerData) {
    return null;
  }

  for (const key of Object.keys(manufacturerData)) {
    const parsed = Number(key);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const hexParsed = Number.parseInt(key.replace(/^0x/i, ''), 16);
    if (Number.isFinite(hexParsed)) {
      return hexParsed;
    }
  }

  return null;
}

function normalizeMac(value: string | undefined) {
  if (!value) {
    return null;
  }
  const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length < 12) {
    return null;
  }
  return hex
    .slice(0, 12)
    .match(/.{1,2}/g)
    ?.join(':') ?? null;
}

async function saveDetection(detection: DetectionMessage) {
  const position = await getBestPosition();
  const coords = position?.coords;
  const spot: Spot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    lat: coords?.latitude ?? null,
    lon: coords?.longitude ?? null,
    accuracy: coords?.accuracy ?? null,
    source: detection.source ?? 'sensor',
    detector: detection.detector ?? SENSOR_NAME,
    label: detection.label ?? 'alpr-signal',
    mac: detection.mac ?? 'unknown',
    role: detection.role ?? 'unknown',
    rssi: detection.rssi ?? null,
    channel: detection.channel ?? null,
    confidence: detection.confidence ?? 50,
    wildcardProbe: detection.wildcard_probe ?? false,
  };

  spots = [spot, ...spots].slice(0, MAX_STORED_SPOTS);
  await persistSpots();
  render();

  const focusTarget = smartTargets.find((target) => target.spotIds.includes(spot.id));
  if (focusTarget) {
    mapFocusText.textContent =
      focusTarget.sightings >= TARGET_MIN_SIGHTINGS
        ? `Estimated point refined (${focusTarget.sightings} hits)`
        : 'New signal saved';
    map.setView([focusTarget.lat, focusTarget.lon], Math.max(map.getZoom(), 17), { animate: true });
  } else if (spot.lat != null && spot.lon != null) {
    mapFocusText.textContent = 'New signal saved';
    map.setView([spot.lat, spot.lon], Math.max(map.getZoom(), 17), { animate: true });
  }
}

async function saveManualSpot() {
  const position = await getBestPosition(true);
  const coords = position?.coords;
  if (!coords) {
    setSensorState('error', 'No GPS fix');
    return;
  }

  const spot: Spot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: coords.accuracy ?? null,
    source: 'manual',
    detector: 'phone',
    label: 'manual-spot',
    mac: 'manual',
    role: 'manual',
    rssi: null,
    channel: null,
    confidence: 100,
    wildcardProbe: false,
  };

  spots = [spot, ...spots].slice(0, MAX_STORED_SPOTS);
  await persistSpots();
  render();
  mapFocusText.textContent = 'Manual spot saved';
  map.setView([coords.latitude, coords.longitude], 18, { animate: true });
}

async function checkForUpdate() {
  const updateButton = document.querySelector<HTMLButtonElement>('#updateButton')!;
  updateButton.disabled = true;
  setSensorState('busy', 'Checking GitHub release');

  try {
    const release = await fetchLatestRelease();
    const apk = pickApkAsset(release.assets);
    const latestVersion = extractVersion(release.tag_name) ?? extractVersion(release.name ?? '');
    const hasNewerVersion = latestVersion ? compareVersions(latestVersion, APP_VERSION) > 0 : true;

    if (!apk) {
      setSensorState('error', 'Latest GitHub release has no APK asset');
      return;
    }

    if (!hasNewerVersion) {
      setSensorState('online', `${APP_NAME} ${APP_VERSION} is current`);
      return;
    }

    const label = latestVersion ? `${APP_NAME} ${latestVersion}` : release.name || release.tag_name;
    const ok = confirm(
      `Install ${label} from GitHub?\n\n${apk.name}` +
        `${apk.size ? ` (${formatBytes(apk.size)})` : ''}`,
    );
    if (!ok) {
      setSensorState('online', 'Update canceled');
      return;
    }

    if (!Capacitor.isNativePlatform()) {
      window.open(release.html_url ?? apk.browser_download_url, '_blank', 'noopener');
      setSensorState('online', 'Opened GitHub release');
      return;
    }

    const installPermission = await RoadLensUpdater.canInstallPackages();
    if (!installPermission.allowed) {
      setSensorState('busy', 'Allow installs, then tap Update again');
      await RoadLensUpdater.openInstallSettings();
      return;
    }

    setSensorState('busy', `Downloading ${apk.name}`);
    const result = await RoadLensUpdater.downloadAndInstall({
      url: apk.browser_download_url,
      fileName: apk.name,
    });
    setSensorState('online', `Installer opened (${formatBytes(result.bytes)})`);
  } catch (error) {
    setSensorState('error', error instanceof Error ? error.message : 'Update check failed');
  } finally {
    updateButton.disabled = false;
  }
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub update unavailable (${response.status})`);
  }
  return (await response.json()) as GitHubRelease;
}

function pickApkAsset(assets: GitHubReleaseAsset[]) {
  const apkAssets = assets.filter((asset) => asset.name.toLowerCase().endsWith('.apk'));
  return apkAssets.sort((a, b) => assetScore(b) - assetScore(a))[0] ?? null;
}

function assetScore(asset: GitHubReleaseAsset) {
  const name = asset.name.toLowerCase();
  let score = 0;
  if (name.includes('roadlens')) score += 10;
  if (name.includes('release')) score += 4;
  if (name.includes('debug')) score -= 2;
  return score;
}

function extractVersion(value: string) {
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?/)?.[0] ?? null;
}

function compareVersions(a: string, b: string) {
  const left = a.split(/[+-]/)[0].split('.').map((part) => Number(part));
  const right = b.split(/[+-]/)[0].split('.').map((part) => Number(part));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function startLocationWatch() {
  if (watchId) {
    return;
  }
  try {
    await Geolocation.requestPermissions({ permissions: ['location'] });
    watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 3000 },
      (position, error) => {
        if (position) {
          lastPosition = position;
          updateGpsText(position);
          renderPosition();
        } else if (error) {
          gpsText.textContent = 'Waiting';
        }
      },
    );
  } catch {
    gpsText.textContent = 'Blocked';
  }
}

async function getBestPosition(forceFresh = false): Promise<Position | null> {
  const lastAgeMs = lastPosition ? Date.now() - lastPosition.timestamp : Number.POSITIVE_INFINITY;
  if (!forceFresh && lastPosition && lastAgeMs < 15000) {
    return lastPosition;
  }

  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 3000,
    });
    lastPosition = position;
    updateGpsText(position);
    renderPosition();
    return position;
  } catch {
    return lastPosition;
  }
}

function updateGpsText(position: Position) {
  gpsText.textContent = `${Math.round(position.coords.accuracy ?? 0)}m`;
}

function render() {
  smartTargets = buildSmartTargets(spots);
  const visibleTargets = smartTargets.filter((target) => target.sightings >= TARGET_MIN_SIGHTINGS);
  const located = spots.filter(hasCoordinates);

  spotCount.textContent = String(spots.length);
  targetCount.textContent = String(visibleTargets.length);
  targetSummary.textContent =
    visibleTargets.length > 0
      ? `${visibleTargets.length} estimated ${visibleTargets.length === 1 ? 'point' : 'points'} from ${located.length} mapped signals`
      : 'No repeat targets yet';

  markerLayer.clearLayers();
  targetLayer.clearLayers();

  for (const spot of located) {
    const marker = L.circleMarker([spot.lat, spot.lon], {
      radius: spot.confidence >= 90 ? 7 : 5,
      color: '#ffd166',
      fillColor: spot.confidence >= 90 ? '#ffd166' : '#f77f5f',
      fillOpacity: spot.confidence >= 90 ? 0.82 : 0.68,
      opacity: 0.92,
      weight: 2,
    });
    marker.bindPopup(renderSpotPopup(spot));
    marker.addTo(markerLayer);
  }

  for (const target of visibleTargets) {
    L.circle([target.lat, target.lon], {
      radius: target.radius,
      color: '#20c997',
      fillColor: '#20c997',
      fillOpacity: 0.12,
      opacity: 0.55,
      weight: 2,
    }).addTo(targetLayer);

    const marker = L.circleMarker([target.lat, target.lon], {
      radius: Math.min(16, 10 + target.sightings),
      color: '#eafff6',
      fillColor: target.confidence >= 92 ? '#7cf8ce' : '#20c997',
      fillOpacity: 0.96,
      opacity: 1,
      weight: 3,
    });
    marker.bindPopup(renderTargetPopup(target));
    marker.addTo(targetLayer);
  }

  renderPosition();

  if (visibleTargets.length > 0 && map.getZoom() <= 4) {
    map.setView([visibleTargets[0].lat, visibleTargets[0].lon], 15);
  } else if (located.length > 0 && map.getZoom() <= 4) {
    map.setView([located[0].lat, located[0].lon], 15);
  }

  targetList.innerHTML = visibleTargets.length
    ? visibleTargets
        .slice(0, 12)
        .map(
          (target, index) => `
            <article class="target-item ${target.confidence >= 92 ? 'hot' : ''}">
              <div class="target-rank">${index + 1}</div>
              <div class="target-copy">
                <div>
                  <strong>${escapeHtml(prettyLabel(target.label))}</strong>
                  <span>${target.confidence}%</span>
                </div>
                <p>${target.sightings} hits | ${formatMeters(target.radius)} estimate | ${formatAgo(target.lastAt)}</p>
                <footer>
                  <span>${escapeHtml(formatRssi(target.bestRssi))}</span>
                  <span>${escapeHtml(target.macs.slice(0, 2).join(', ') || 'area match')}</span>
                </footer>
              </div>
            </article>
          `,
        )
        .join('')
    : `<div class="empty">Awaiting repeat signals</div>`;

  feedList.innerHTML = spots.length
    ? spots
        .slice(0, 40)
        .map(
          (spot) => `
            <article class="feed-item">
              <div>
                <strong>${escapeHtml(prettyLabel(spot.label))}</strong>
                <span>${new Date(spot.createdAt).toLocaleTimeString()}</span>
              </div>
              <p>${escapeHtml(spot.mac)} ${spot.channel ? `ch${spot.channel}` : ''} ${
                spot.rssi != null ? `${spot.rssi} dBm` : ''
              }</p>
              <footer>
                <span>${spot.confidence}%</span>
                <span>${spot.accuracy != null ? `${Math.round(spot.accuracy)}m` : 'no gps'}</span>
              </footer>
            </article>
          `,
        )
        .join('')
    : `<div class="empty">No signals saved</div>`;
}

function renderPosition() {
  if (!positionLayer) {
    return;
  }
  positionLayer.clearLayers();
  const coords = lastPosition?.coords;
  if (!coords) {
    return;
  }

  const latlng: L.LatLngExpression = [coords.latitude, coords.longitude];
  L.circle(latlng, {
    radius: Math.max(10, coords.accuracy ?? 20),
    color: '#5bbcff',
    fillColor: '#5bbcff',
    fillOpacity: 0.08,
    opacity: 0.45,
    weight: 2,
  }).addTo(positionLayer);
  L.circleMarker(latlng, {
    radius: 6,
    color: '#eaf7ff',
    fillColor: '#5bbcff',
    fillOpacity: 1,
    weight: 2,
  }).addTo(positionLayer);
}

function renderSpotPopup(spot: Spot) {
  return (
    `<strong>${escapeHtml(prettyLabel(spot.label))}</strong><br>` +
    `${escapeHtml(spot.mac)} ${spot.channel ? `ch${spot.channel}` : ''}<br>` +
    `${new Date(spot.createdAt).toLocaleString()}<br>` +
    `confidence ${spot.confidence}% ${spot.rssi != null ? `| ${spot.rssi} dBm` : ''}`
  );
}

function renderTargetPopup(target: SmartTarget) {
  return (
    `<strong>Likely ${escapeHtml(prettyLabel(target.label))}</strong><br>` +
    `${target.sightings} sightings | ${target.confidence}% confidence<br>` +
    `estimate radius ${formatMeters(target.radius)}<br>` +
    `${escapeHtml(formatRssi(target.bestRssi))}<br>` +
    `${escapeHtml(target.macs.slice(0, 3).join(', ') || 'area match')}`
  );
}

function prettyLabel(label: string) {
  return label
    .replace(/^flock-/i, 'Flock ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatRssi(rssi: number | null) {
  return rssi == null ? 'no rssi' : `${rssi} dBm`;
}

function formatMeters(value: number) {
  if (value < 1000) return `${Math.round(value)}m`;
  return `${(value / 1000).toFixed(1)}km`;
}

function formatAgo(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function exportGeoJson() {
  const targets = buildSmartTargets(spots).filter((target) => target.sightings >= TARGET_MIN_SIGHTINGS);
  const sightingFeatures = spots.filter(hasCoordinates).map((spot) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [spot.lon, spot.lat],
    },
    properties: {
      kind: 'sighting',
      id: spot.id,
      createdAt: spot.createdAt,
      accuracy: spot.accuracy,
      source: spot.source,
      detector: spot.detector,
      label: spot.label,
      mac: spot.mac,
      role: spot.role,
      rssi: spot.rssi,
      channel: spot.channel,
      confidence: spot.confidence,
      wildcardProbe: spot.wildcardProbe,
    },
  }));
  const targetFeatures = targets.map((target) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [target.lon, target.lat],
    },
    properties: {
      kind: 'smart-target',
      id: target.id,
      label: target.label,
      sightings: target.sightings,
      confidence: target.confidence,
      estimateRadiusMeters: target.radius,
      averageAccuracyMeters: Math.round(target.accuracy),
      bestRssi: target.bestRssi,
      macs: target.macs,
      channels: target.channels,
      firstAt: target.firstAt,
      lastAt: target.lastAt,
      strongestSpotId: target.strongestSpotId,
      spotIds: target.spotIds,
    },
  }));
  const geojson = {
    type: 'FeatureCollection',
    name: `${APP_NAME} map`,
    features: [...targetFeatures, ...sightingFeatures],
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `roadlens/roadlens-scout-map-${stamp}.geojson`;
  const result = await Filesystem.writeFile({
    path,
    data: JSON.stringify(geojson, null, 2),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  await Share.share({
    title: `${APP_NAME} export`,
    text: `${targets.length} likely points, ${sightingFeatures.length} raw sightings`,
    url: result.uri,
    dialogTitle: `Export ${APP_NAME} map`,
  });
}

async function clearSpots() {
  if (spots.length === 0) {
    return;
  }
  const ok = confirm(`Clear ${spots.length} saved signals?`);
  if (!ok) {
    return;
  }
  spots = [];
  await persistSpots();
  mapFocusText.textContent = 'Map cleared';
  render();
}

function readStoredSpots(): Spot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as Spot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistSpots() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(spots));
  try {
    await Filesystem.writeFile({
      path: 'roadlens/spots.json',
      data: JSON.stringify(spots, null, 2),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } catch {
    // localStorage remains the primary fast path for the live UI.
  }
}

function setSensorState(state: 'offline' | 'online' | 'busy' | 'error', text: string) {
  statusPill.dataset.state = state;
  statusText.textContent = text;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char] ?? char;
  });
}
