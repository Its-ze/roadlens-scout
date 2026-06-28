import './style.css';
import 'leaflet/dist/leaflet.css';

import { BleClient, ConnectionPriority, ScanMode } from '@capacitor-community/bluetooth-le';
import type { BleDevice, ScanResult } from '@capacitor-community/bluetooth-le';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
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
const FIELD_OBSERVATION_STORAGE_KEY = 'roadlens.field-observations.v1';
const MAP_LEARNING_STORAGE_KEY = 'roadlens.map-learning.v1';
const APP_VERSION = __APP_VERSION__;
const UPDATE_REPO = __GITHUB_REPO__;
const APP_NAME = 'RoadLens Scout';
const SENSOR_NAME = 'RoadLensESP32';
const MAX_STORED_SPOTS = 2000;
const PHONE_FLASHER_URL = 'https://its-ze.github.io/roadlens-scout/flasher/';
const SITE_META_URL = 'https://its-ze.github.io/roadlens-scout/site-meta.json';
const SIGNATURE_FEED_URL = 'https://its-ze.github.io/roadlens-scout/signatures.json';
const CAMERA_SEED_FEED_URL = 'https://its-ze.github.io/roadlens-scout/camera-seeds.json';
const SIGNATURE_CACHE_KEY = 'roadlens.signatures.v1';
const PHONE_BLE_SWEEP_MS = 15000;
const OTA_CREDENTIAL_CHUNK_BYTES = 6;
const OTA_HASH_CHUNK_CHARS = 12;
const OTA_COMMAND_DELAY_MS = 45;
const SIGNATURE_COMMAND_DELAY_MS = 35;
const MAX_SENSOR_SIGNATURE_PREFIXES = 96;
const COMMAND_WRITE_TIMEOUT_MS = 4500;
const COMMAND_WRITE_FALLBACK_TIMEOUT_MS = 7500;
const MAX_FIELD_OBSERVATIONS = 2000;
const CAMERA_SEED_RENDER_MIN_ZOOM = 11;
const CAMERA_SEED_RENDER_LIMIT = 450;
const CAMERA_SEED_NEAR_RADIUS_METERS = 260;
const CAMERA_SEED_VISIT_RADIUS_METERS = 160;
const CAMERA_SEED_VISIT_COOLDOWN_MS = 10 * 60 * 1000;
const CAMERA_SEED_GRID_DEGREES = 0.1;
const MAP_AUTO_CENTER_COOLDOWN_MS = 90 * 1000;
const MAP_AUTO_CENTER_INTERVAL_MS = 12 * 1000;
const MAP_AUTO_CENTER_DISTANCE_METERS = 35;

const DEFAULT_WIFI_PREFIXES = [
  '70:c9:4e', '3c:91:80', 'd8:f3:bc', '80:30:49', 'b8:35:32',
  '14:5a:fc', '74:4c:a1', '08:3a:88', '9c:2f:9d', 'c0:35:32',
  '94:08:53', 'e4:aa:ea', 'f4:6a:dd', '24:b2:b9', '00:f4:8d',
  'd0:39:57', 'e8:d0:fc', 'e0:4f:43', 'b8:1e:a4', '70:08:94',
  '58:8e:81', 'ec:1b:bd', '3c:71:bf', '58:00:e3', '90:35:ea',
  '5c:93:a2', '64:6e:69', '48:27:ea', 'a4:cf:12', '04:0d:84',
  'f0:82:c0', '1c:34:f1', '38:5b:44', '94:34:69', 'b4:e3:f9',
  'b4:1e:52', '14:b5:cd', '94:2a:6f', 'f4:e2:c6', 'd4:11:d6',
  'e0:0a:f6', '82:6b:f2',
];
const DEFAULT_BLE_NAME_PATTERNS = ['FS Ext Battery', 'Penguin', 'Flock', 'Pigvision'];
const DEFAULT_BLE_MANUFACTURER_IDS = [0x09c8];
const DEFAULT_WIFI_SSID_PATTERNS = [
  { pattern: '^Flock-[A-Z0-9]+$', label: 'flock-wifi-ssid', confidence: 88, match: 'regex' },
  { pattern: 'FS Ext Battery', label: 'flock-wifi-battery-ssid', confidence: 86, match: 'contains' },
  { pattern: 'Penguin', label: 'flock-wifi-penguin-ssid', confidence: 84, match: 'contains' },
  { pattern: 'Pigvision', label: 'flock-wifi-pigvision-ssid', confidence: 84, match: 'contains' },
] as const;
const DEFAULT_RAVEN_SERVICE_UUIDS = [
  '0000180a-0000-1000-8000-00805f9b34fb',
  '00003100-0000-1000-8000-00805f9b34fb',
  '00003200-0000-1000-8000-00805f9b34fb',
  '00003300-0000-1000-8000-00805f9b34fb',
  '00003400-0000-1000-8000-00805f9b34fb',
  '00003500-0000-1000-8000-00805f9b34fb',
  '00001809-0000-1000-8000-00805f9b34fb',
  '00001819-0000-1000-8000-00805f9b34fb',
];

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
  flashBundledFirmware(options: {
    deviceId: number;
    chipFamily?: string;
  }): Promise<{
    chipFamily: string;
    version: string;
    parts: number;
    bytes: number;
  }>;
  openFlasher(options: { url: string }): Promise<{ opened: boolean }>;
  addListener(
    eventName: 'usbFlashProgress',
    listenerFunc: (event: {
      stage?: string;
      detail?: string;
      progress?: number;
      bytes?: number;
      totalBytes?: number;
    }) => void,
  ): Promise<PluginListenerHandle>;
};

const RoadLensUsb = registerPlugin<RoadLensUsbPlugin>('RoadLensUsb');

type RoadLensNetworkPlugin = {
  getWifiInfo(): Promise<{
    connected: boolean;
    ssid?: string;
    locationPermission?: boolean;
  }>;
  openWifiSettings(): Promise<void>;
};

const RoadLensNetwork = registerPlugin<RoadLensNetworkPlugin>('RoadLensNetwork');

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
  firmware_version?: string;
  chip_family?: string;
  ota_supported?: boolean;
  ota_in_progress?: boolean;
  ota_version?: string;
  signature_version?: string;
  signature_source?: string;
  signature_sync_supported?: boolean;
};

type DetectionMessage = {
  type: 'detection';
  source: string;
  detector?: string;
  mac?: string;
  ssid?: string;
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

type OtaMessage = {
  type: 'ota';
  state: string;
  detail?: string;
  progress?: number;
  version?: string;
  chip_family?: string;
};

type SignatureMessage = {
  type: 'signatures';
  state: string;
  detail?: string;
  count?: number;
  version?: string;
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

type SiteMetaFirmwareBuild = {
  chipFamily: string;
  path: string;
  bytes: number;
  sha256: string;
};

type SiteMeta = {
  version: string;
  firmware: {
    builds: SiteMetaFirmwareBuild[];
  };
  signatures?: {
    path: string;
    version: string;
    bytes: number;
    sha256: string;
    wifiPrefixes: number;
    blePrefixes: number;
    bleNamePatterns: number;
    bleManufacturerIds: number;
    ravenServiceUuids?: number;
    wifiSsidPatterns?: number;
  };
  cameraSeeds?: {
    path: string;
    version: string;
    bytes: number;
    sha256: string;
    points: number;
    sources: number;
  };
};

type SignaturePrefix = {
  prefix: string;
  label?: string;
  allowLocalAdministered?: boolean;
  wildcardProbe?: boolean;
};

type WifiSsidPattern = {
  pattern: string;
  label: string;
  confidence: number;
  match: 'regex' | 'contains' | 'exact';
};

type SignatureSource = {
  name?: string;
  url?: string;
  ok?: boolean;
};

type SignatureFeed = {
  schema: number;
  name?: string;
  version: string;
  generatedAt?: string;
  sources?: SignatureSource[];
  wifiPrefixes: SignaturePrefix[];
  blePrefixes: string[];
  bleNamePatterns: string[];
  bleManufacturerIds: number[];
  ravenServiceUuids: string[];
  wifiSsidPatterns: WifiSsidPattern[];
};

type SignatureIndex = {
  blePrefixes: Set<string>;
  bleNamePatterns: string[];
  bleManufacturerIds: Set<number>;
  ravenServiceUuids: Set<string>;
  wifiSsidPatterns: WifiSsidPattern[];
};

type CameraSeedSource = {
  name?: string;
  url?: string;
  dataUrl?: string;
  sha256?: string;
  license?: string;
};

type CameraSeed = {
  id: string;
  lat: number;
  lon: number;
  brand?: string;
  operator?: string;
  source?: string;
  direction?: number;
  directionCardinal?: string;
  surveillanceZone?: string;
  mountType?: string;
  ref?: string;
  osmTimestamp?: string;
  osmVersion?: number;
};

type CameraSeedFeed = {
  schema: number;
  name?: string;
  version: string;
  generatedAt?: string;
  sources?: CameraSeedSource[];
  pointCount?: number;
  points: CameraSeed[];
};

type CameraSeedIndex = {
  gridSize: number;
  cells: Map<string, CameraSeed[]>;
};

type NearbyCameraSeed = {
  seed: CameraSeed;
  distanceMeters: number;
};

type MapLearningState = {
  version: 1;
  centerCount: number;
  preferredZoom: number;
  followMode: boolean;
  lastCenteredAt: number;
  lastLat?: number;
  lastLon?: number;
  lastAccuracy?: number;
};

type FieldObservation = {
  id: string;
  createdAt: string;
  source: 'seed-proximity';
  seedId: string;
  seedLabel: string;
  lat: number;
  lon: number;
  accuracy: number | null;
  distanceMeters: number;
  sensorConnected: boolean;
  firmwareVersion?: string;
  signalCount: number;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

let map: L.Map;
let seedLayer: L.LayerGroup;
let markerLayer: L.LayerGroup;
let targetLayer: L.LayerGroup;
let positionLayer: L.LayerGroup;
let spots: Spot[] = readStoredSpots();
let fieldObservations: FieldObservation[] = readStoredFieldObservations();
let seedObservationTimes = buildSeedObservationTimes(fieldObservations);
let smartTargets: SmartTarget[] = [];
let notificationBuffer = '';
let connectedDevice: BleDevice | null = null;
let lastPosition: Position | null = null;
let watchId: string | null = null;
let usbDevices: RoadLensUsbDevice[] = [];
let selectedUsbDevice: RoadLensUsbDevice | null = null;
let usbFlashBusy = false;
let phoneBleSweepActive = false;
let phoneBleSeen = new Map<string, number>();
let lastSensorStatus: SensorStatus | null = null;
let latestSiteMeta: SiteMeta | null = null;
let moduleUpdateBusy = false;
let moduleUpdatePromptedForVersion = '';
let activeSignatures: SignatureFeed = readCachedSignatureFeed() ?? buildDefaultSignatureFeed();
let signatureIndex: SignatureIndex = buildSignatureIndex(activeSignatures);
let signatureFetchPromise: Promise<SignatureFeed> | null = null;
let signatureSyncBusy = false;
let signatureSyncedForKey = '';
let activeCameraSeeds: CameraSeedFeed = buildEmptyCameraSeedFeed();
let cameraSeedIndex: CameraSeedIndex = buildCameraSeedIndex(activeCameraSeeds.points);
let cameraSeedFetchPromise: Promise<CameraSeedFeed> | null = null;
let nearestCameraSeed: NearbyCameraSeed | null = null;
let mapLearning: MapLearningState = readMapLearningState();
let programmaticMapMoveUntil = 0;
let lastUserMapInteractionAt = 0;
let lastAutoCenterAt = 0;

type WifiReadoutState = 'unknown' | 'connected' | 'limited' | 'offline' | 'error';

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
        <div class="map-tools">
          <button id="locateButton" class="map-tool" title="Center to my location" aria-label="Center to my location">
            <i data-lucide="locate-fixed"></i>
          </button>
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
        <div class="detector-strip" id="detectorStrip" aria-label="Active detector coverage">
          <div class="detector-chip hot">
            <i data-lucide="wifi"></i>
            <strong id="wifiDetectorCount">0</strong>
            <span>OUI</span>
          </div>
          <div class="detector-chip">
            <i data-lucide="scan-search"></i>
            <strong id="ssidDetectorCount">0</strong>
            <span>SSID</span>
          </div>
          <div class="detector-chip">
            <i data-lucide="radio-tower"></i>
            <strong>On</strong>
            <span>Probe</span>
          </div>
          <div class="detector-chip">
            <i data-lucide="bluetooth"></i>
            <strong id="bleDetectorCount">0</strong>
            <span>BLE</span>
          </div>
          <div class="detector-chip">
            <i data-lucide="radar"></i>
            <strong id="ravenDetectorCount">0</strong>
            <span>Raven</span>
          </div>
        </div>
        <div class="map-legend">
          <span><b class="legend-dot raw"></b>Signal</span>
          <span><b class="legend-dot target"></b>Estimate</span>
          <span><b class="legend-dot seed"></b>Known</span>
          <span><b class="legend-dot you"></b>You</span>
        </div>
      </div>

      <aside class="feed">
        <div class="feed-head">
          <div>
            <h2>Scout Board</h2>
            <p id="targetSummary">No repeat targets yet</p>
          </div>
          <div class="feed-tools">
            <button id="seedRefreshButton" class="ghost"><i data-lucide="database"></i><span>Seeds</span></button>
            <button id="reportButton" class="ghost"><i data-lucide="send"></i><span>Report</span></button>
            <button id="statusButton" class="ghost"><i data-lucide="refresh-cw"></i><span>Status</span></button>
          </div>
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
          <div class="module-card">
            <div id="moduleStatus" class="module-status">
              <strong>Sensor firmware</strong>
              <span>Connect RoadLensESP32</span>
            </div>
            <div id="wifiReadout" class="wifi-readout" data-state="unknown">
              <span class="wifi-readout-dot"></span>
              <div>
                <strong>Phone Wi-Fi</strong>
                <span>Not checked</span>
              </div>
            </div>
            <form id="wifiCredentialForm" class="module-fields">
              <label>
                <span>SSID</span>
                <input id="wifiSsidInput" type="text" autocomplete="off" inputmode="text" />
              </label>
              <label>
                <span>Password</span>
                <input id="wifiPasswordInput" type="password" autocomplete="current-password" />
              </label>
            </form>
            <div class="setup-actions module-actions">
              <button id="wifiFillButton"><i data-lucide="wifi"></i><span>Wi-Fi</span></button>
              <button id="moduleOtaButton" class="primary"><i data-lucide="upload-cloud"></i><span>Sensor OTA</span></button>
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
const locateButton = document.querySelector<HTMLButtonElement>('#locateButton')!;
const spotCount = document.querySelector<HTMLSpanElement>('#spotCount')!;
const targetCount = document.querySelector<HTMLSpanElement>('#targetCount')!;
const gpsText = document.querySelector<HTMLSpanElement>('#gpsText')!;
const signalText = document.querySelector<HTMLSpanElement>('#signalText')!;
const wifiDetectorCount = document.querySelector<HTMLElement>('#wifiDetectorCount')!;
const ssidDetectorCount = document.querySelector<HTMLElement>('#ssidDetectorCount')!;
const bleDetectorCount = document.querySelector<HTMLElement>('#bleDetectorCount')!;
const ravenDetectorCount = document.querySelector<HTMLElement>('#ravenDetectorCount')!;
const targetSummary = document.querySelector<HTMLParagraphElement>('#targetSummary')!;
const targetList = document.querySelector<HTMLDivElement>('#targetList')!;
const feedList = document.querySelector<HTMLDivElement>('#feedList')!;
const connectButton = document.querySelector<HTMLButtonElement>('#connectButton')!;
const usbSummary = document.querySelector<HTMLSpanElement>('#usbSummary')!;
const usbDeviceCard = document.querySelector<HTMLDivElement>('#usbDeviceCard')!;
const usbScanButton = document.querySelector<HTMLButtonElement>('#usbScanButton')!;
const usbFlashButton = document.querySelector<HTMLButtonElement>('#usbFlashButton')!;
const bleSweepButton = document.querySelector<HTMLButtonElement>('#bleSweepButton')!;
const moduleStatus = document.querySelector<HTMLDivElement>('#moduleStatus')!;
const wifiReadout = document.querySelector<HTMLDivElement>('#wifiReadout')!;
const wifiSsidInput = document.querySelector<HTMLInputElement>('#wifiSsidInput')!;
const wifiPasswordInput = document.querySelector<HTMLInputElement>('#wifiPasswordInput')!;
const wifiFillButton = document.querySelector<HTMLButtonElement>('#wifiFillButton')!;
const moduleOtaButton = document.querySelector<HTMLButtonElement>('#moduleOtaButton')!;
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
locateButton.addEventListener('click', () => {
  void centerToMyLocation({ forceFresh: true });
});
document.querySelector<HTMLButtonElement>('#statusButton')!.addEventListener('click', () => sendCommand('status'));
document.querySelector<HTMLFormElement>('#wifiCredentialForm')!.addEventListener('submit', (event) => {
  event.preventDefault();
});
document.querySelector<HTMLButtonElement>('#seedRefreshButton')!.addEventListener('click', () => {
  void refreshCameraSeedFeed({ quiet: false });
});
document.querySelector<HTMLButtonElement>('#reportButton')!.addEventListener('click', () => {
  void shareFieldReport();
});
usbScanButton.addEventListener('click', () => {
  void refreshUsbDevices();
});
usbFlashButton.addEventListener('click', () => {
  void openPhoneFlasher();
});
bleSweepButton.addEventListener('click', () => {
  void runPhoneBleSweep();
});
wifiFillButton.addEventListener('click', () => {
  void loadCurrentWifiSsid();
});
moduleOtaButton.addEventListener('click', () => {
  void runModuleOtaUpdate({ promptBeforeStart: true });
});
mobileTabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setMobileTab(button.dataset.mobileTabTarget ?? 'map');
  });
});
if (Capacitor.isNativePlatform()) {
  RoadLensUsb.addListener('usbFlashProgress', handleUsbFlashProgress).catch(() => undefined);
}

initMap();
renderUsbSetup();
render();
void startLocationWatch();
void refreshWifiReadout({ quiet: true });
void refreshSignatureFeed({ quiet: true });
void refreshCameraSeedFeed({ quiet: true });

function setMobileTab(tab: string) {
  shell.dataset.mobileTab = tab;
  for (const button of mobileTabButtons) {
    const isActive = button.dataset.mobileTabTarget === tab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }

  if (tab === 'map') {
    window.setTimeout(() => map.invalidateSize(), 160);
  } else if (tab === 'setup') {
    void refreshWifiReadout({ quiet: true });
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

  seedLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  targetLayer = L.layerGroup().addTo(map);
  positionLayer = L.layerGroup().addTo(map);
  map.on('movestart zoomstart', noteUserMapInteraction);
  map.on('moveend zoomend', () => {
    renderSeedMarkers();
    learnMapZoomFromUserMove();
  });
}

function readMapLearningState(): MapLearningState {
  try {
    const raw = localStorage.getItem(MAP_LEARNING_STORAGE_KEY);
    if (!raw) {
      return defaultMapLearningState();
    }
    const value = JSON.parse(raw) as Partial<MapLearningState> | null;
    if (!value || value.version !== 1) {
      return defaultMapLearningState();
    }
    const preferredZoom = clampNumber(Number(value.preferredZoom), 14, 19);
    return {
      version: 1,
      centerCount: clampNumber(Number(value.centerCount) || 0, 0, 999),
      preferredZoom: Number.isFinite(preferredZoom) ? preferredZoom : 17,
      followMode: Boolean(value.followMode),
      lastCenteredAt: Number(value.lastCenteredAt) || 0,
      lastLat: typeof value.lastLat === 'number' && Number.isFinite(value.lastLat) ? value.lastLat : undefined,
      lastLon: typeof value.lastLon === 'number' && Number.isFinite(value.lastLon) ? value.lastLon : undefined,
      lastAccuracy:
        typeof value.lastAccuracy === 'number' && Number.isFinite(value.lastAccuracy) ? value.lastAccuracy : undefined,
    };
  } catch {
    return defaultMapLearningState();
  }
}

function defaultMapLearningState(): MapLearningState {
  return {
    version: 1,
    centerCount: 0,
    preferredZoom: 17,
    followMode: false,
    lastCenteredAt: 0,
  };
}

function saveMapLearningState() {
  try {
    localStorage.setItem(MAP_LEARNING_STORAGE_KEY, JSON.stringify(mapLearning));
  } catch {
    // Learning is a local convenience; map operation does not depend on it.
  }
}

function noteUserMapInteraction() {
  if (Date.now() < programmaticMapMoveUntil) {
    return;
  }
  lastUserMapInteractionAt = Date.now();
  if (mapLearning.followMode) {
    mapLearning = { ...mapLearning, followMode: false };
    saveMapLearningState();
  }
}

function learnMapZoomFromUserMove() {
  if (Date.now() < programmaticMapMoveUntil || Date.now() - lastUserMapInteractionAt > 1600) {
    return;
  }
  const zoom = clampNumber(map.getZoom(), 14, 19);
  if (Math.abs(zoom - mapLearning.preferredZoom) >= 0.25) {
    mapLearning = { ...mapLearning, preferredZoom: zoom };
    saveMapLearningState();
  }
}

function setSmartMapView(lat: number, lon: number, zoom: number, options: L.ZoomPanOptions = {}) {
  programmaticMapMoveUntil = Date.now() + 1400;
  map.setView([lat, lon], zoom, options);
}

async function connectSensor() {
  let device: BleDevice | null = null;
  try {
    connectButton.disabled = true;
    setSensorState('busy', 'Preparing Bluetooth');
    await startLocationWatch();
    await BleClient.initialize({ androidNeverForLocation: false });

    device = await findSensorDevice();

    setSensorState('busy', `Connecting to ${device.name ?? 'sensor'}`);
    await BleClient.disconnect(device.deviceId).catch(() => undefined);
    await delay(250);
    await BleClient.connect(device.deviceId, () => {
      handleSensorDisconnect();
    }, { timeout: 15000 });

    connectedDevice = device;
    lastSensorStatus = null;
    moduleUpdatePromptedForVersion = '';
    signatureSyncedForKey = '';
    await BleClient.requestConnectionPriority(
      device.deviceId,
      ConnectionPriority.CONNECTION_PRIORITY_HIGH,
    ).catch(() => undefined);
    await BleClient.startNotifications(
      device.deviceId,
      SERVICE_UUID,
      NOTIFY_UUID,
      handleNotification,
      { timeout: 10000 },
    );
    setSensorState('online', `${device.name ?? SENSOR_NAME} connected`);
    signalText.textContent = 'Linked';
    updateConnectionButton();
    await sendCommandWithRetry('status', 2);
    await delay(150);
    await sendCommandWithRetry('start-scan', 2);
  } catch (error) {
    if (device) {
      await BleClient.disconnect(device.deviceId).catch(() => undefined);
    }
    connectedDevice = null;
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
    await sendCommand('stop-scan').catch(() => undefined);
    await delay(50);
    await BleClient.stopNotifications(deviceId, SERVICE_UUID, NOTIFY_UUID).catch(() => undefined);
    await BleClient.disconnect(deviceId).catch(() => undefined);
  } finally {
    connectButton.disabled = false;
    handleSensorDisconnect();
  }
}

function handleSensorDisconnect() {
  connectedDevice = null;
  lastSensorStatus = null;
  moduleUpdateBusy = false;
  signatureSyncBusy = false;
  signatureSyncedForKey = '';
  moduleOtaButton.disabled = false;
  notificationBuffer = '';
  setSensorState('offline', 'Sensor disconnected');
  setModuleState('Sensor firmware', 'Connect RoadLensESP32');
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
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    await BleClient.writeWithoutResponse(
      connectedDevice.deviceId,
      SERVICE_UUID,
      COMMAND_UUID,
      value,
      { timeout: COMMAND_WRITE_TIMEOUT_MS },
    );
  } catch (noResponseError) {
    try {
      await BleClient.write(
        connectedDevice.deviceId,
        SERVICE_UUID,
        COMMAND_UUID,
        value,
        { timeout: COMMAND_WRITE_FALLBACK_TIMEOUT_MS },
      );
    } catch (withResponseError) {
      throw new Error(commandWriteErrorMessage(command, noResponseError, withResponseError));
    }
  }
}

async function sendCommandWithRetry(command: string, attempts: number) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await sendCommand(command);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(250 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Command ${command} failed`);
}

function commandWriteErrorMessage(command: string, noResponseError: unknown, withResponseError: unknown) {
  const detail =
    withResponseError instanceof Error
      ? withResponseError.message
      : noResponseError instanceof Error
        ? noResponseError.message
        : 'BLE write failed';
  return `${command} write failed: ${detail}`;
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
  if (usbFlashBusy) {
    return;
  }

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

  if (Capacitor.isNativePlatform()) {
    await flashBundledSensorFirmware(device);
    return;
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

async function flashBundledSensorFirmware(device: RoadLensUsbDevice | null) {
  if (!device) {
    setUsbState('No USB device', 'Plug in ESP32 with USB-OTG');
    return;
  }
  if (!device.supported) {
    setUsbState('Unsupported USB device', `${toHexId(device.vendorId)}:${toHexId(device.productId)}`);
    return;
  }

  usbFlashBusy = true;
  usbFlashButton.disabled = true;
  usbScanButton.disabled = true;
  setUsbState('Preparing native flash', device.label);

  try {
    if (connectedDevice) {
      await disconnectSensor();
    }

    const result = await RoadLensUsb.flashBundledFirmware({
      deviceId: device.deviceId,
      chipFamily: device.chipFamily,
    });
    setUsbState(
      `Flash complete ${result.version}`,
      `${result.chipFamily} ${formatBytes(result.bytes)} written across ${result.parts} parts`,
    );
  } catch (error) {
    setUsbState(
      'Flash failed',
      error instanceof Error ? error.message : 'Hold BOOT, tap RESET, and try again',
    );
  } finally {
    usbFlashBusy = false;
    usbScanButton.disabled = false;
    usbFlashButton.disabled = false;
  }
}

function handleUsbFlashProgress(event: {
  stage?: string;
  detail?: string;
  progress?: number;
  bytes?: number;
  totalBytes?: number;
}) {
  if (!usbFlashBusy) {
    return;
  }
  const progress =
    typeof event.progress === 'number' && Number.isFinite(event.progress)
      ? ` ${Math.max(0, Math.min(100, Math.round(event.progress)))}%`
      : '';
  const detail =
    event.detail ??
    (typeof event.bytes === 'number' && typeof event.totalBytes === 'number'
      ? `${formatBytes(event.bytes)} / ${formatBytes(event.totalBytes)}`
      : 'Keep ESP32 plugged in');
  setUsbState(`${event.stage ?? 'Flashing'}${progress}`, detail);
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

function setModuleState(summary: string, detail: string) {
  moduleStatus.innerHTML = `
    <strong>${escapeHtml(summary)}</strong>
    <span>${escapeHtml(detail)}</span>
  `;
}

function setWifiReadout(state: WifiReadoutState, summary: string, detail: string) {
  wifiReadout.dataset.state = state;
  wifiReadout.innerHTML = `
    <span class="wifi-readout-dot"></span>
    <div>
      <strong>${escapeHtml(summary)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
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
    const message = JSON.parse(line) as SensorStatus | DetectionMessage | OtaMessage | SignatureMessage;
    if (message.type === 'status') {
      handleStatus(message);
    } else if (message.type === 'detection') {
      void saveDetection(message);
    } else if (message.type === 'ota') {
      handleOtaMessage(message);
    } else if (message.type === 'signatures') {
      handleSignatureMessage(message);
    }
  } catch {
    setSensorState('online', line.slice(0, 90));
  }
}

function handleStatus(status: SensorStatus) {
  lastSensorStatus = status;
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

  renderModuleStatus(status);
  void maybePromptForModuleUpdate(status);
  void maybeSyncSensorSignatures(status);
}

function handleSignatureMessage(message: SignatureMessage) {
  const count = typeof message.count === 'number' ? `${message.count} prefixes` : 'signature feed';
  const version = message.version ? ` ${message.version}` : '';
  setModuleState(`Signatures ${message.state}`, `${count}${version}`);
}

function handleOtaMessage(message: OtaMessage) {
  const progress =
    typeof message.progress === 'number' && message.progress >= 0
      ? ` ${Math.round(message.progress)}%`
      : '';
  const detail = `${message.detail ?? message.state}${progress}`;
  setModuleState(`OTA ${message.state}`, detail);
  setSensorState(message.state === 'error' ? 'error' : 'busy', detail);

  if (message.state === 'error' || message.state === 'rebooting') {
    moduleUpdateBusy = false;
    moduleOtaButton.disabled = false;
  }
}

function renderModuleStatus(status: SensorStatus) {
  const firmware = status.firmware_version ?? 'unknown';
  const chip = status.chip_family ?? 'unknown chip';
  const signatureDetail =
    typeof status.signature_count === 'number'
      ? `${status.signature_count} prefixes + ${activeSignatures.wifiSsidPatterns.length} SSID`
      : `${activeSignatures.wifiPrefixes.length} prefixes + ${activeSignatures.wifiSsidPatterns.length} SSID`;
  if (status.ota_in_progress) {
    setModuleState('Sensor OTA running', `${chip} firmware ${firmware}`);
    moduleOtaButton.disabled = true;
    return;
  }

  if (status.ota_supported) {
    const available = latestSiteMeta?.version;
    if (available && status.firmware_version && compareVersions(available, status.firmware_version) > 0) {
      setModuleState(`Firmware ${firmware} -> ${available}`, `${chip} | ${signatureDetail}`);
      return;
    }
    setModuleState(`Firmware ${firmware}`, `${chip} OTA ready | ${signatureDetail}`);
  } else {
    setModuleState(`Firmware ${firmware}`, `${chip} needs USB flash for OTA`);
  }
}

async function maybePromptForModuleUpdate(status: SensorStatus) {
  if (
    moduleUpdateBusy ||
    !connectedDevice ||
    !status.ota_supported ||
    !status.firmware_version ||
    !status.chip_family
  ) {
    return;
  }

  try {
    const meta = await fetchSiteMeta();
    const build = pickFirmwareBuild(meta, status.chip_family);
    if (!build || compareVersions(meta.version, status.firmware_version) <= 0) {
      renderModuleStatus(status);
      return;
    }

    renderModuleStatus(status);
    if (moduleUpdatePromptedForVersion === meta.version) {
      return;
    }
    moduleUpdatePromptedForVersion = meta.version;

    const ok = confirm(
      `Update ESP32 sensor firmware ${status.firmware_version} -> ${meta.version} over Wi-Fi?`,
    );
    if (ok) {
      await runModuleOtaUpdate({ meta, status, promptBeforeStart: false });
    }
  } catch (error) {
    setModuleState('Firmware check failed', error instanceof Error ? error.message : 'Update metadata unavailable');
  }
}

async function runModuleOtaUpdate(options: {
  meta?: SiteMeta;
  status?: SensorStatus;
  promptBeforeStart: boolean;
}) {
  if (moduleUpdateBusy) {
    return;
  }
  if (!connectedDevice) {
    setModuleState('Sensor offline', 'Connect RoadLensESP32 first');
    return;
  }

  const status = options.status ?? lastSensorStatus;
  if (!status?.ota_supported || !status.firmware_version || !status.chip_family) {
    setModuleState('USB flash needed', 'Connected firmware does not support OTA yet');
    return;
  }

  moduleUpdateBusy = true;
  moduleOtaButton.disabled = true;

  try {
    const meta = options.meta ?? (await fetchSiteMeta());
    const build = pickFirmwareBuild(meta, status.chip_family);
    if (!build) {
      throw new Error(`No firmware build for ${status.chip_family}`);
    }

    if (compareVersions(meta.version, status.firmware_version) <= 0) {
      setModuleState(`Firmware ${status.firmware_version}`, 'Sensor firmware is current');
      moduleUpdateBusy = false;
      moduleOtaButton.disabled = false;
      return;
    }

    if (options.promptBeforeStart) {
      const ok = confirm(
        `Install ESP32 sensor firmware ${meta.version} over Wi-Fi?\n\n${build.chipFamily} ${formatBytes(build.bytes)}`,
      );
      if (!ok) {
        setModuleState('Sensor OTA canceled', `Firmware ${status.firmware_version}`);
        moduleUpdateBusy = false;
        moduleOtaButton.disabled = false;
        return;
      }
    }

    const credentials = await getWifiCredentialsForOta();
    if (!credentials) {
      return;
    }

    setModuleState('Staging OTA', `${build.chipFamily} firmware ${meta.version}`);
    await sendOtaCommand('oc');
    await sendOtaCommand(`ov:${meta.version}`);
    await sendOtaCommand(`oz:${build.bytes}`);
    await sendChunkedHexCommand('os', credentials.ssid, OTA_CREDENTIAL_CHUNK_BYTES);
    await sendChunkedHexCommand('op', credentials.password, OTA_CREDENTIAL_CHUNK_BYTES);
    for (const chunk of chunkText(build.sha256.toLowerCase(), OTA_HASH_CHUNK_CHARS)) {
      await sendOtaCommand(`oh:${chunk}`);
    }
    await sendOtaCommand('ou');
    setModuleState('OTA queued', `${build.chipFamily} firmware ${meta.version}`);
  } catch (error) {
    moduleUpdateBusy = false;
    moduleOtaButton.disabled = false;
    setModuleState('Sensor OTA failed', error instanceof Error ? error.message : 'OTA failed');
  }
}

async function getWifiCredentialsForOta() {
  if (!wifiSsidInput.value.trim()) {
    await loadCurrentWifiSsid();
  }

  const ssid = wifiSsidInput.value.trim();
  const password = wifiPasswordInput.value;
  if (!ssid) {
    setMobileTab('setup');
    setModuleState('SSID needed', 'Enter the Wi-Fi name');
    wifiSsidInput.focus();
    moduleUpdateBusy = false;
    moduleOtaButton.disabled = false;
    return null;
  }

  const ssidBytes = encoder.encode(ssid);
  const passwordBytes = encoder.encode(password);
  if (ssidBytes.length > 32) {
    throw new Error('Wi-Fi SSID is too long for ESP32');
  }
  if (passwordBytes.length > 64) {
    throw new Error('Wi-Fi password is too long for ESP32');
  }
  if (!password && !confirm('Continue OTA with no Wi-Fi password?')) {
    setMobileTab('setup');
    wifiPasswordInput.focus();
    moduleUpdateBusy = false;
    moduleOtaButton.disabled = false;
    return null;
  }

  return { ssid, password };
}

async function loadCurrentWifiSsid() {
  setModuleState('Checking Wi-Fi', 'Reading current phone network');
  try {
    await startLocationWatch();
    if (!Capacitor.isNativePlatform()) {
      setModuleState('SSID unavailable', 'Enter Wi-Fi name manually');
      setWifiReadout('limited', 'Phone Wi-Fi', 'Android app required for Wi-Fi readout');
      return;
    }

    const info = await refreshWifiReadout({ prefillSsid: true });
    if (info.ssid) {
      setModuleState('Wi-Fi selected', info.ssid);
    } else if (info.connected) {
      setModuleState('SSID hidden', 'Enter Wi-Fi name manually');
    } else {
      setModuleState('Phone not on Wi-Fi', 'Connect phone to Wi-Fi first');
    }
  } catch (error) {
    setModuleState('Wi-Fi check failed', error instanceof Error ? error.message : 'Enter SSID manually');
    setWifiReadout('error', 'Wi-Fi check failed', error instanceof Error ? error.message : 'Try again');
  }
}

async function refreshWifiReadout(options: { quiet?: boolean; prefillSsid?: boolean } = {}) {
  if (!Capacitor.isNativePlatform()) {
    setWifiReadout('limited', 'Phone Wi-Fi', 'Android app required');
    return { connected: false, locationPermission: false };
  }

  if (!options.quiet) {
    setWifiReadout('unknown', 'Checking Wi-Fi', 'Reading phone network');
  }

  try {
    const info = await RoadLensNetwork.getWifiInfo();
    if (info.connected && info.ssid) {
      if (options.prefillSsid) {
        wifiSsidInput.value = info.ssid;
      }
      setWifiReadout('connected', 'Phone Wi-Fi connected', info.ssid);
    } else if (info.connected && info.locationPermission === false) {
      setWifiReadout('limited', 'Phone Wi-Fi connected', 'Location permission needed for SSID');
    } else if (info.connected) {
      setWifiReadout('limited', 'Phone Wi-Fi connected', 'SSID hidden by Android');
    } else {
      setWifiReadout('offline', 'Phone not on Wi-Fi', 'Connect phone to Wi-Fi before Sensor OTA');
    }
    return info;
  } catch (error) {
    setWifiReadout('error', 'Wi-Fi check failed', error instanceof Error ? error.message : 'Try again');
    throw error;
  }
}

async function sendOtaCommand(command: string) {
  await sendCommand(command);
  await delay(OTA_COMMAND_DELAY_MS);
}

async function sendChunkedHexCommand(prefix: string, value: string, chunkBytes: number) {
  const bytes = encoder.encode(value);
  for (let index = 0; index < bytes.length; index += chunkBytes) {
    const chunk = bytes.slice(index, index + chunkBytes);
    await sendOtaCommand(`${prefix}:${bytesToHex(chunk)}`);
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function chunkText(value: string, chunkSize: number) {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

async function fetchSiteMeta(): Promise<SiteMeta> {
  if (latestSiteMeta) {
    return latestSiteMeta;
  }

  const response = await fetch(`${SITE_META_URL}?t=${Date.now()}`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`RoadLens metadata unavailable (${response.status})`);
  }
  latestSiteMeta = (await response.json()) as SiteMeta;
  return latestSiteMeta;
}

function pickFirmwareBuild(meta: SiteMeta, chipFamily: string) {
  const normalized = normalizeChipFamily(chipFamily);
  return (
    meta.firmware.builds.find((build) => normalizeChipFamily(build.chipFamily) === normalized) ??
    null
  );
}

function normalizeChipFamily(value: string) {
  return value.trim().toUpperCase().replace(/_/g, '-');
}

function buildDefaultSignatureFeed(): SignatureFeed {
  return {
    schema: 1,
    name: 'RoadLens Scout Built-In Signatures',
    version: `builtin-${APP_VERSION}`,
    wifiPrefixes: DEFAULT_WIFI_PREFIXES.map((prefix) => ({
      prefix,
      label: prefix === '82:6b:f2' ? 'flock-wifi-wildcard' : 'flock-wifi',
      allowLocalAdministered: isLocalAdministeredPrefix(prefix),
      wildcardProbe: prefix === '82:6b:f2',
    })),
    blePrefixes: [...DEFAULT_WIFI_PREFIXES],
    bleNamePatterns: [...DEFAULT_BLE_NAME_PATTERNS],
    bleManufacturerIds: [...DEFAULT_BLE_MANUFACTURER_IDS],
    ravenServiceUuids: [...DEFAULT_RAVEN_SERVICE_UUIDS],
    wifiSsidPatterns: DEFAULT_WIFI_SSID_PATTERNS.map((item) => ({ ...item })),
  };
}

function readCachedSignatureFeed() {
  try {
    const raw = localStorage.getItem(SIGNATURE_CACHE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeSignatureFeed(JSON.parse(raw));
  } catch {
    return null;
  }
}

function activateSignatureFeed(feed: SignatureFeed, cache: boolean) {
  activeSignatures = feed;
  signatureIndex = buildSignatureIndex(feed);
  renderDetectorStrip();
  if (cache) {
    try {
      localStorage.setItem(SIGNATURE_CACHE_KEY, JSON.stringify(feed));
    } catch {
      // Cache is best effort; the bundled fallback still works offline.
    }
  }
}

function buildSignatureIndex(feed: SignatureFeed): SignatureIndex {
  return {
    blePrefixes: new Set(feed.blePrefixes.map((prefix) => normalizePrefix(prefix)).filter(Boolean) as string[]),
    bleNamePatterns: feed.bleNamePatterns.map((name) => name.toLowerCase()),
    bleManufacturerIds: new Set(feed.bleManufacturerIds),
    ravenServiceUuids: new Set(feed.ravenServiceUuids.map((uuid) => uuid.toLowerCase())),
    wifiSsidPatterns: feed.wifiSsidPatterns,
  };
}

async function refreshSignatureFeed(options: { quiet?: boolean } = {}): Promise<SignatureFeed> {
  if (signatureFetchPromise) {
    return signatureFetchPromise;
  }

  signatureFetchPromise = (async () => {
    const cacheBust = Date.now();
    const candidates = [
      `/signatures.json?t=${cacheBust}`,
      `${SIGNATURE_FEED_URL}?t=${cacheBust}`,
    ];

    let lastError: unknown = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const feed = normalizeSignatureFeed(await response.json());
        activateSignatureFeed(feed, true);
        if (!options.quiet) {
          setUsbState(
            'Signatures updated',
            `${feed.wifiPrefixes.length} Wi-Fi prefixes, ${feed.wifiSsidPatterns.length} SSID patterns`,
          );
        }
        return feed;
      } catch (error) {
        lastError = error;
      }
    }

    if (!options.quiet) {
      setUsbState('Signature refresh failed', lastError instanceof Error ? lastError.message : 'Using cached list');
    }
    return activeSignatures;
  })();

  try {
    return await signatureFetchPromise;
  } finally {
    signatureFetchPromise = null;
  }
}

function normalizeSignatureFeed(raw: unknown): SignatureFeed {
  const value = raw as Partial<SignatureFeed> | null;
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid signature feed');
  }

  const wifiPrefixes = normalizeWifiPrefixes(value.wifiPrefixes);
  if (wifiPrefixes.length < 30) {
    throw new Error('Signature feed has too few Wi-Fi prefixes');
  }

  const blePrefixValues =
    Array.isArray(value.blePrefixes) && value.blePrefixes.length
      ? value.blePrefixes
      : wifiPrefixes.map((item) => item.prefix);
  const blePrefixes = dedupeStrings(blePrefixValues.map((item) => normalizePrefix(String(item))).filter(Boolean) as string[]);
  const bleNamePatterns = dedupeStrings(
    (Array.isArray(value.bleNamePatterns) ? value.bleNamePatterns : DEFAULT_BLE_NAME_PATTERNS)
      .map((name) => String(name).trim())
      .filter(Boolean),
  );
  const bleManufacturerIds = dedupeNumbers(
    (Array.isArray(value.bleManufacturerIds) ? value.bleManufacturerIds : DEFAULT_BLE_MANUFACTURER_IDS)
      .map((item) => parseManufacturerId(item))
      .filter((item): item is number => item != null),
  );
  const ravenServiceUuids = dedupeStrings(
    (Array.isArray(value.ravenServiceUuids) ? value.ravenServiceUuids : DEFAULT_RAVEN_SERVICE_UUIDS)
      .map((uuid) => normalizeUuid(String(uuid)))
      .filter(Boolean) as string[],
  );
  const wifiSsidPatterns = normalizeWifiSsidPatterns(value.wifiSsidPatterns);

  return {
    schema: Number(value.schema) || 1,
    name: value.name,
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim() : 'unknown',
    generatedAt: value.generatedAt,
    sources: value.sources,
    wifiPrefixes,
    blePrefixes,
    bleNamePatterns,
    bleManufacturerIds,
    ravenServiceUuids,
    wifiSsidPatterns,
  };
}

function normalizeWifiPrefixes(raw: unknown): SignaturePrefix[] {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: SignaturePrefix[] = [];

  for (const item of source) {
    const candidate =
      typeof item === 'string'
        ? { prefix: item }
        : (item as Partial<SignaturePrefix> | null);
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const prefix = normalizePrefix(String(candidate.prefix ?? ''));
    if (!prefix || seen.has(prefix)) {
      continue;
    }
    seen.add(prefix);
    out.push({
      prefix,
      label: typeof candidate.label === 'string' ? candidate.label : 'flock-wifi',
      allowLocalAdministered:
        Boolean(candidate.allowLocalAdministered) || Boolean(candidate.wildcardProbe) || isLocalAdministeredPrefix(prefix),
      wildcardProbe: Boolean(candidate.wildcardProbe),
    });
  }

  return out;
}

function normalizeWifiSsidPatterns(raw: unknown): WifiSsidPattern[] {
  const source = Array.isArray(raw) && raw.length ? raw : DEFAULT_WIFI_SSID_PATTERNS;
  const seen = new Set<string>();
  const out: WifiSsidPattern[] = [];

  for (const item of source) {
    const candidate = item as Partial<WifiSsidPattern> | null;
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const pattern = String(candidate.pattern ?? '').trim();
    const match = candidate.match === 'exact' || candidate.match === 'contains' || candidate.match === 'regex'
      ? candidate.match
      : 'contains';
    const label = String(candidate.label ?? 'flock-wifi-ssid').trim() || 'flock-wifi-ssid';
    const confidence = clampNumber(Number(candidate.confidence) || 84, 50, 99);
    const key = `${match}:${pattern.toLowerCase()}`;
    if (!pattern || seen.has(key)) {
      continue;
    }
    if (match === 'regex') {
      try {
        new RegExp(pattern);
      } catch {
        continue;
      }
    }
    seen.add(key);
    out.push({ pattern, label, confidence, match });
  }

  return out.length ? out : DEFAULT_WIFI_SSID_PATTERNS.map((item) => ({ ...item }));
}

function normalizePrefix(value: string) {
  const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 6) {
    return null;
  }
  return hex.match(/.{1,2}/g)?.join(':') ?? null;
}

function normalizeUuid(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function parseManufacturerId(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = value.trim().toLowerCase().startsWith('0x')
      ? Number.parseInt(value.trim().slice(2), 16)
      : Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values));
}

function dedupeNumbers(values: number[]) {
  return Array.from(new Set(values));
}

function isLocalAdministeredPrefix(prefix: string) {
  const firstByte = Number.parseInt(prefix.slice(0, 2), 16);
  return Number.isFinite(firstByte) && (firstByte & 0x02) !== 0;
}

function buildEmptyCameraSeedFeed(): CameraSeedFeed {
  return {
    schema: 1,
    name: 'RoadLens Scout Camera Seeds',
    version: `empty-${APP_VERSION}`,
    points: [],
  };
}

function activateCameraSeedFeed(feed: CameraSeedFeed) {
  activeCameraSeeds = feed;
  cameraSeedIndex = buildCameraSeedIndex(feed.points);
  render();
  if (lastPosition) {
    void handlePositionUpdate(lastPosition);
  }
}

async function refreshCameraSeedFeed(options: { quiet?: boolean } = {}): Promise<CameraSeedFeed> {
  if (cameraSeedFetchPromise) {
    return cameraSeedFetchPromise;
  }

  cameraSeedFetchPromise = (async () => {
    const cacheBust = Date.now();
    const candidates = [
      `/camera-seeds.json?t=${cacheBust}`,
      `${CAMERA_SEED_FEED_URL}?t=${cacheBust}`,
    ];

    let lastError: unknown = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          cache: 'default',
          headers: {
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const feed = normalizeCameraSeedFeed(await response.json());
        activateCameraSeedFeed(feed);
        if (!options.quiet) {
          setSensorState('online', `${feed.points.length.toLocaleString()} camera seeds loaded`);
        }
        return feed;
      } catch (error) {
        lastError = error;
      }
    }

    if (!options.quiet) {
      setSensorState('error', lastError instanceof Error ? lastError.message : 'Camera seed refresh failed');
    }
    return activeCameraSeeds;
  })();

  try {
    return await cameraSeedFetchPromise;
  } finally {
    cameraSeedFetchPromise = null;
  }
}

function normalizeCameraSeedFeed(raw: unknown): CameraSeedFeed {
  const value = raw as Partial<CameraSeedFeed> | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.points)) {
    throw new Error('Invalid camera seed feed');
  }

  const points: CameraSeed[] = [];
  for (const item of value.points) {
    const seed = normalizeCameraSeed(item);
    if (seed) {
      points.push(seed);
    }
  }
  if (points.length < 1) {
    throw new Error('Camera seed feed is empty');
  }

  return {
    schema: Number(value.schema) || 1,
    name: value.name,
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim() : 'unknown',
    generatedAt: value.generatedAt,
    sources: Array.isArray(value.sources) ? value.sources : undefined,
    pointCount: Number(value.pointCount) || points.length,
    points,
  };
}

function normalizeCameraSeed(raw: unknown): CameraSeed | null {
  const value = raw as Partial<CameraSeed> | null;
  if (!value || typeof value !== 'object') {
    return null;
  }
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  const id = typeof value.id === 'string' && value.id.trim()
    ? value.id.trim()
    : `seed:${lat.toFixed(6)}:${lon.toFixed(6)}`;
  return {
    id,
    lat,
    lon,
    brand: cleanOptionalString(value.brand),
    operator: cleanOptionalString(value.operator),
    source: cleanOptionalString(value.source),
    direction: typeof value.direction === 'number' && Number.isFinite(value.direction) ? value.direction : undefined,
    directionCardinal: cleanOptionalString(value.directionCardinal),
    surveillanceZone: cleanOptionalString(value.surveillanceZone),
    mountType: cleanOptionalString(value.mountType),
    ref: cleanOptionalString(value.ref),
    osmTimestamp: cleanOptionalString(value.osmTimestamp),
    osmVersion: typeof value.osmVersion === 'number' && Number.isFinite(value.osmVersion) ? value.osmVersion : undefined,
  };
}

function cleanOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text || undefined;
}

function buildCameraSeedIndex(points: CameraSeed[]): CameraSeedIndex {
  const cells = new Map<string, CameraSeed[]>();
  for (const seed of points) {
    const key = cameraSeedGridKey(seed.lat, seed.lon, CAMERA_SEED_GRID_DEGREES);
    const cell = cells.get(key);
    if (cell) {
      cell.push(seed);
    } else {
      cells.set(key, [seed]);
    }
  }
  return { gridSize: CAMERA_SEED_GRID_DEGREES, cells };
}

function cameraSeedGridKey(lat: number, lon: number, gridSize: number) {
  return `${Math.floor(lat / gridSize)},${Math.floor(lon / gridSize)}`;
}

function queryCameraSeedsInBounds(bounds: L.LatLngBounds) {
  const results: CameraSeed[] = [];
  const grid = cameraSeedIndex.gridSize;
  const south = Math.floor(bounds.getSouth() / grid);
  const north = Math.floor(bounds.getNorth() / grid);
  const west = Math.floor(bounds.getWest() / grid);
  const east = Math.floor(bounds.getEast() / grid);

  for (let latCell = south; latCell <= north; latCell++) {
    for (let lonCell = west; lonCell <= east; lonCell++) {
      const cell = cameraSeedIndex.cells.get(`${latCell},${lonCell}`);
      if (!cell) {
        continue;
      }
      for (const seed of cell) {
        if (bounds.contains([seed.lat, seed.lon])) {
          results.push(seed);
        }
      }
    }
  }

  return results;
}

function findNearestCameraSeed(lat: number, lon: number, maxMeters: number): NearbyCameraSeed | null {
  if (!activeCameraSeeds.points.length) {
    return null;
  }
  const latDelta = maxMeters / 111320;
  const lonScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const lonDelta = maxMeters / (111320 * lonScale);
  const bounds = L.latLngBounds([lat - latDelta, lon - lonDelta], [lat + latDelta, lon + lonDelta]);
  let best: NearbyCameraSeed | null = null;
  for (const seed of queryCameraSeedsInBounds(bounds)) {
    const distance = geoDistanceMeters(lat, lon, seed.lat, seed.lon);
    if (distance <= maxMeters && (!best || distance < best.distanceMeters)) {
      best = { seed, distanceMeters: distance };
    }
  }
  return best;
}

async function maybeRecordSeedObservation(nearby: NearbyCameraSeed, position: Position) {
  if (nearby.distanceMeters > CAMERA_SEED_VISIT_RADIUS_METERS) {
    return;
  }

  const now = Date.now();
  const lastSeen = seedObservationTimes.get(nearby.seed.id) ?? 0;
  if (now - lastSeen < CAMERA_SEED_VISIT_COOLDOWN_MS) {
    return;
  }

  const coords = position.coords;
  const observation: FieldObservation = {
    id: crypto.randomUUID(),
    createdAt: new Date(now).toISOString(),
    source: 'seed-proximity',
    seedId: nearby.seed.id,
    seedLabel: cameraSeedLabel(nearby.seed),
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: coords.accuracy ?? null,
    distanceMeters: Math.round(nearby.distanceMeters),
    sensorConnected: Boolean(connectedDevice),
    firmwareVersion: lastSensorStatus?.firmware_version,
    signalCount: spots.length,
  };

  fieldObservations = [observation, ...fieldObservations].slice(0, MAX_FIELD_OBSERVATIONS);
  seedObservationTimes.set(nearby.seed.id, now);
  await persistFieldObservations();
  render();
}

function cameraSeedLabel(seed: CameraSeed) {
  return seed.operator || seed.brand || 'Known ALPR';
}

function geoDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radius = 6371000;
  const toRadians = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRadians;
  const dLon = (lon2 - lon1) * toRadians;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function maybeSyncSensorSignatures(status: SensorStatus) {
  if (
    signatureSyncBusy ||
    !connectedDevice ||
    !status.signature_sync_supported ||
    status.ota_in_progress
  ) {
    return;
  }

  const feed = await refreshSignatureFeed({ quiet: true });
  const targetVersion = compactSignatureVersion(feed.version);
  const targetCount = feed.wifiPrefixes.length;
  if (status.signature_version === targetVersion && status.signature_count === targetCount) {
    return;
  }

  const syncKey = `${connectedDevice.deviceId}:${targetVersion}:${targetCount}`;
  if (signatureSyncedForKey === syncKey) {
    return;
  }

  signatureSyncBusy = true;
  try {
    await syncSensorSignatures(feed, targetVersion);
    signatureSyncedForKey = syncKey;
  } catch (error) {
    setModuleState('Signature sync failed', error instanceof Error ? error.message : 'Using sensor list');
  } finally {
    signatureSyncBusy = false;
  }
}

async function syncSensorSignatures(feed: SignatureFeed, targetVersion: string) {
  if (feed.wifiPrefixes.length > MAX_SENSOR_SIGNATURE_PREFIXES) {
    throw new Error(`Signature feed has ${feed.wifiPrefixes.length} prefixes; firmware limit is ${MAX_SENSOR_SIGNATURE_PREFIXES}`);
  }

  setModuleState('Syncing signatures', `${feed.wifiPrefixes.length} Wi-Fi prefixes`);
  await sendSensorStagedCommand('sc');
  await sendSensorStagedCommand(`sv:${targetVersion}`);
  for (const item of feed.wifiPrefixes) {
    const compactPrefix = item.prefix.replace(/:/g, '');
    const allowLocal = item.allowLocalAdministered || item.wildcardProbe || isLocalAdministeredPrefix(item.prefix);
    await sendSensorStagedCommand(`sp:${compactPrefix}:${allowLocal ? 1 : 0}`);
  }
  await sendSensorStagedCommand('sf');
}

async function sendSensorStagedCommand(command: string) {
  await sendCommand(command);
  await delay(SIGNATURE_COMMAND_DELAY_MS);
}

function compactSignatureVersion(version: string) {
  const compact = version.replace(/[^0-9A-Za-z._-]/g, '').slice(0, 24);
  return compact || 'synced';
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
    await refreshSignatureFeed({ quiet: true });
    await BleClient.initialize({ androidNeverForLocation: false });
    setUsbState(
      'BLE sweep running',
      `${signatureIndex.blePrefixes.size} prefixes for 15 seconds`,
    );

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
  const advertisedUuid = scanResultUuids(result).find((uuid) => signatureIndex.ravenServiceUuids.has(uuid));

  if (manufacturerId != null && signatureIndex.bleManufacturerIds.has(manufacturerId)) {
    return {
      mac,
      method: 'ble-mfr',
      label: 'flock-ble-manufacturer',
      confidence: 92,
    };
  }

  if (advertisedUuid) {
    return {
      mac,
      method: 'ble-service',
      label: 'raven-ble-service',
      confidence: 94,
    };
  }

  const namePattern = signatureIndex.bleNamePatterns.find((pattern) => lowerName.includes(pattern));
  if (namePattern) {
    return {
      mac,
      method: 'ble-name',
      label: `flock-ble-${namePattern.replaceAll(' ', '-')}`,
      confidence: 90,
    };
  }

  if (prefix && signatureIndex.blePrefixes.has(prefix)) {
    return {
      mac,
      method: 'ble-oui',
      label: 'flock-ble-prefix',
      confidence: prefix === '82:6b:f2' ? 88 : 80,
    };
  }

  return null;
}

function scanResultUuids(result: ScanResult) {
  return [
    ...(result.uuids ?? []),
    ...(result.device.uuids ?? []),
  ]
    .map((uuid) => normalizeUuid(uuid))
    .filter((uuid): uuid is string => Boolean(uuid));
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
  const nearbySeed = coords
    ? findNearestCameraSeed(coords.latitude, coords.longitude, CAMERA_SEED_NEAR_RADIUS_METERS)
    : null;
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
    ssid: detection.ssid,
    role: detection.role ?? 'unknown',
    rssi: detection.rssi ?? null,
    channel: detection.channel ?? null,
    confidence: detection.confidence ?? 50,
    wildcardProbe: detection.wildcard_probe ?? false,
    seedId: nearbySeed?.seed.id,
    seedLabel: nearbySeed ? cameraSeedLabel(nearbySeed.seed) : undefined,
    seedDistanceMeters: nearbySeed ? Math.round(nearbySeed.distanceMeters) : null,
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
    setSmartMapView(focusTarget.lat, focusTarget.lon, Math.max(map.getZoom(), 17), { animate: true });
  } else if (spot.lat != null && spot.lon != null) {
    mapFocusText.textContent = nearbySeed
      ? `Signal saved near ${cameraSeedLabel(nearbySeed.seed)}`
      : 'New signal saved';
    setSmartMapView(spot.lat, spot.lon, Math.max(map.getZoom(), 17), { animate: true });
  }
}

async function saveManualSpot() {
  const position = await getBestPosition(true);
  const coords = position?.coords;
  if (!coords) {
    setSensorState('error', 'No GPS fix');
    return;
  }
  const nearbySeed = findNearestCameraSeed(coords.latitude, coords.longitude, CAMERA_SEED_NEAR_RADIUS_METERS);

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
    seedId: nearbySeed?.seed.id,
    seedLabel: nearbySeed ? cameraSeedLabel(nearbySeed.seed) : undefined,
    seedDistanceMeters: nearbySeed ? Math.round(nearbySeed.distanceMeters) : null,
  };

  spots = [spot, ...spots].slice(0, MAX_STORED_SPOTS);
  await persistSpots();
  render();
  mapFocusText.textContent = nearbySeed
    ? `Manual spot near ${cameraSeedLabel(nearbySeed.seed)}`
    : 'Manual spot saved';
  setSmartMapView(coords.latitude, coords.longitude, 18, { animate: true });
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
          void handlePositionUpdate(position);
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
    await handlePositionUpdate(position);
    return position;
  } catch {
    return lastPosition;
  }
}

async function centerToMyLocation(options: { forceFresh?: boolean } = {}) {
  locateButton.disabled = true;
  try {
    await startLocationWatch();
    const position = await getBestPosition(Boolean(options.forceFresh));
    const coords = position?.coords;
    if (!coords) {
      setSensorState('error', 'No GPS fix');
      return;
    }

    const focus = buildLocationFocus(position);
    const now = Date.now();
    const nextCount = mapLearning.centerCount + 1;
    mapLearning = {
      ...mapLearning,
      centerCount: nextCount,
      preferredZoom: focus.zoom,
      followMode: nextCount >= 3,
      lastCenteredAt: now,
      lastLat: coords.latitude,
      lastLon: coords.longitude,
      lastAccuracy: coords.accuracy ?? undefined,
    };
    saveMapLearningState();
    lastAutoCenterAt = now;
    mapFocusText.textContent = mapLearning.followMode ? `${focus.text} | follow on` : focus.text;
    setSmartMapView(focus.lat, focus.lon, focus.zoom, { animate: true });
  } finally {
    locateButton.disabled = false;
  }
}

function buildLocationFocus(position: Position) {
  const coords = position.coords;
  const accuracy = coords.accuracy ?? 60;
  const nearbySeed = findNearestCameraSeed(coords.latitude, coords.longitude, CAMERA_SEED_NEAR_RADIUS_METERS);
  const nearbyTarget = findNearestVisibleTarget(coords.latitude, coords.longitude, 360);
  const zoom = chooseLocationZoom(accuracy, nearbySeed, nearbyTarget);
  let text = accuracy > 80 ? `Centered with ${Math.round(accuracy)}m fix` : 'Centered on you';
  if (nearbySeed && nearbySeed.distanceMeters <= CAMERA_SEED_VISIT_RADIUS_METERS) {
    text = `Near known ${cameraSeedLabel(nearbySeed.seed)} (${formatMeters(nearbySeed.distanceMeters)})`;
  } else if (nearbyTarget) {
    text = `Near estimated ${prettyLabel(nearbyTarget.target.label)} (${formatMeters(nearbyTarget.distanceMeters)})`;
  }

  return {
    lat: coords.latitude,
    lon: coords.longitude,
    zoom,
    text,
  };
}

function chooseLocationZoom(
  accuracy: number,
  nearbySeed: NearbyCameraSeed | null,
  nearbyTarget: { target: SmartTarget; distanceMeters: number } | null,
) {
  let zoom = accuracy > 120 ? 15 : accuracy > 45 ? 16 : 17;
  if ((nearbySeed && nearbySeed.distanceMeters <= CAMERA_SEED_VISIT_RADIUS_METERS) || nearbyTarget) {
    zoom = Math.max(zoom, 18);
  }
  if (mapLearning.centerCount >= 2) {
    zoom = Math.round((zoom + mapLearning.preferredZoom) / 2);
  }
  return clampNumber(zoom, 14, 19);
}

function findNearestVisibleTarget(lat: number, lon: number, maxMeters: number) {
  let best: { target: SmartTarget; distanceMeters: number } | null = null;
  for (const target of smartTargets) {
    if (target.sightings < TARGET_MIN_SIGHTINGS) {
      continue;
    }
    const distance = geoDistanceMeters(lat, lon, target.lat, target.lon);
    if (distance <= maxMeters && (!best || distance < best.distanceMeters)) {
      best = { target, distanceMeters: distance };
    }
  }
  return best;
}

function maybeAutoCenterOnPosition(position: Position) {
  if (!mapLearning.followMode || Date.now() - lastUserMapInteractionAt < MAP_AUTO_CENTER_COOLDOWN_MS) {
    return;
  }
  const now = Date.now();
  if (now - lastAutoCenterAt < MAP_AUTO_CENTER_INTERVAL_MS) {
    return;
  }

  const coords = position.coords;
  const lastLat = mapLearning.lastLat;
  const lastLon = mapLearning.lastLon;
  const moved =
    typeof lastLat === 'number' && typeof lastLon === 'number'
      ? geoDistanceMeters(lastLat, lastLon, coords.latitude, coords.longitude)
      : Number.POSITIVE_INFINITY;
  if (moved < MAP_AUTO_CENTER_DISTANCE_METERS) {
    return;
  }

  const focus = buildLocationFocus(position);
  mapLearning = {
    ...mapLearning,
    lastCenteredAt: now,
    lastLat: coords.latitude,
    lastLon: coords.longitude,
    lastAccuracy: coords.accuracy ?? undefined,
  };
  saveMapLearningState();
  lastAutoCenterAt = now;
  mapFocusText.textContent = focus.text === 'Centered on you' ? 'Following your location' : focus.text;
  setSmartMapView(focus.lat, focus.lon, focus.zoom, { animate: true });
}

function updateGpsText(position: Position) {
  gpsText.textContent = `${Math.round(position.coords.accuracy ?? 0)}m`;
}

async function handlePositionUpdate(position: Position) {
  lastPosition = position;
  updateGpsText(position);
  renderPosition();
  renderSeedMarkers();

  const coords = position.coords;
  const nearby = findNearestCameraSeed(coords.latitude, coords.longitude, CAMERA_SEED_NEAR_RADIUS_METERS);
  nearestCameraSeed = nearby;
  if (nearby) {
    mapFocusText.textContent = `Near known ${cameraSeedLabel(nearby.seed)} (${formatMeters(nearby.distanceMeters)})`;
    await maybeRecordSeedObservation(nearby, position);
  }
  maybeAutoCenterOnPosition(position);
}

function render() {
  smartTargets = buildSmartTargets(spots);
  const visibleTargets = smartTargets.filter((target) => target.sightings >= TARGET_MIN_SIGHTINGS);
  const located = spots.filter(hasCoordinates);

  renderDetectorStrip();
  spotCount.textContent = String(spots.length);
  targetCount.textContent = String(visibleTargets.length);
  targetSummary.textContent =
    visibleTargets.length > 0
      ? `${visibleTargets.length} estimated ${visibleTargets.length === 1 ? 'point' : 'points'} from ${located.length} signals | ${fieldObservations.length} field checks`
      : `${activeCameraSeeds.points.length ? `${activeCameraSeeds.points.length.toLocaleString()} known seeds | ` : ''}${fieldObservations.length ? `${fieldObservations.length} field checks` : 'No repeat targets yet'}`;

  markerLayer.clearLayers();
  targetLayer.clearLayers();
  renderSeedMarkers();

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
    setSmartMapView(visibleTargets[0].lat, visibleTargets[0].lon, 15);
  } else if (located.length > 0 && map.getZoom() <= 4) {
    setSmartMapView(located[0].lat, located[0].lon, 15);
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
              }${spot.ssid ? ` ${escapeHtml(spot.ssid)}` : ''}</p>
              <footer>
                <span>${spot.confidence}%</span>
                <span>${
                  spot.seedLabel
                    ? `${escapeHtml(spot.seedLabel)} ${spot.seedDistanceMeters != null ? formatMeters(spot.seedDistanceMeters) : ''}`
                    : spot.accuracy != null ? `${Math.round(spot.accuracy)}m` : 'no gps'
                }</span>
              </footer>
            </article>
          `,
        )
        .join('')
    : `<div class="empty">No signals saved</div>`;
}

function renderDetectorStrip() {
  wifiDetectorCount.textContent = String(activeSignatures.wifiPrefixes.length);
  ssidDetectorCount.textContent = String(activeSignatures.wifiSsidPatterns.length);
  bleDetectorCount.textContent = String(
    activeSignatures.bleNamePatterns.length + activeSignatures.bleManufacturerIds.length,
  );
  ravenDetectorCount.textContent = String(activeSignatures.ravenServiceUuids.length);
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

function renderSeedMarkers() {
  if (!seedLayer || !map) {
    return;
  }

  seedLayer.clearLayers();
  if (!activeCameraSeeds.points.length || map.getZoom() < CAMERA_SEED_RENDER_MIN_ZOOM) {
    if (nearestCameraSeed) {
      renderSingleSeedMarker(nearestCameraSeed.seed, nearestCameraSeed.distanceMeters, true);
    }
    return;
  }

  const bounds = map.getBounds().pad(0.08);
  const seeds = queryCameraSeedsInBounds(bounds).slice(0, CAMERA_SEED_RENDER_LIMIT);
  for (const seed of seeds) {
    renderSingleSeedMarker(seed, nearestCameraSeed?.seed.id === seed.id ? nearestCameraSeed.distanceMeters : null, false);
  }
}

function renderSingleSeedMarker(seed: CameraSeed, distanceMeters: number | null, highlighted: boolean) {
  const marker = L.circleMarker([seed.lat, seed.lon], {
    radius: highlighted ? 8 : 5,
    color: highlighted ? '#eaf7ff' : '#9ba8ff',
    fillColor: highlighted ? '#ffd166' : '#9ba8ff',
    fillOpacity: highlighted ? 0.94 : 0.48,
    opacity: highlighted ? 1 : 0.72,
    weight: highlighted ? 3 : 2,
  });
  marker.bindPopup(renderCameraSeedPopup(seed, distanceMeters));
  marker.addTo(seedLayer);
}

function renderSpotPopup(spot: Spot) {
  return (
    `<strong>${escapeHtml(prettyLabel(spot.label))}</strong><br>` +
    `${escapeHtml(spot.mac)} ${spot.channel ? `ch${spot.channel}` : ''}<br>` +
    `${spot.ssid ? `SSID ${escapeHtml(spot.ssid)}<br>` : ''}` +
    `${new Date(spot.createdAt).toLocaleString()}<br>` +
    `confidence ${spot.confidence}% ${spot.rssi != null ? `| ${spot.rssi} dBm` : ''}` +
    `${spot.seedLabel ? `<br>near ${escapeHtml(spot.seedLabel)} ${spot.seedDistanceMeters != null ? `(${formatMeters(spot.seedDistanceMeters)})` : ''}` : ''}`
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

function renderCameraSeedPopup(seed: CameraSeed, distanceMeters: number | null) {
  const details = [
    seed.operator ? `operator ${escapeHtml(seed.operator)}` : '',
    seed.ref ? `ref ${escapeHtml(seed.ref)}` : '',
    seed.directionCardinal ? `facing ${escapeHtml(seed.directionCardinal)}` : '',
    seed.mountType ? escapeHtml(seed.mountType) : '',
  ].filter(Boolean);
  return (
    `<strong>${escapeHtml(cameraSeedLabel(seed))}</strong><br>` +
    `${details.join('<br>') || 'public seed point'}<br>` +
    `${distanceMeters != null ? `${formatMeters(distanceMeters)} from current GPS<br>` : ''}` +
    `${seed.osmTimestamp ? `updated ${escapeHtml(seed.osmTimestamp.slice(0, 10))}<br>` : ''}` +
    `source ${escapeHtml(seed.source ?? 'camera-seeds')}`
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
  const geojson = buildFieldReportGeoJson();
  const targets = buildSmartTargets(spots).filter((target) => target.sightings >= TARGET_MIN_SIGHTINGS);
  const sightingCount = spots.filter(hasCoordinates).length;
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
    text: `${targets.length} likely points, ${sightingCount} raw sightings, ${fieldObservations.length} field checks`,
    url: result.uri,
    dialogTitle: `Export ${APP_NAME} map`,
  });
}

async function shareFieldReport() {
  const geojson = buildFieldReportGeoJson();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `roadlens/roadlens-field-report-${stamp}.geojson`;
  const result = await Filesystem.writeFile({
    path,
    data: JSON.stringify(geojson, null, 2),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  const targets = buildSmartTargets(spots).filter((target) => target.sightings >= TARGET_MIN_SIGHTINGS);
  const referencedSeeds = referencedCameraSeeds();
  const reportText =
    `${APP_NAME} field report\n\n` +
    `- App version: ${APP_VERSION}\n` +
    `- Camera seed version: ${activeCameraSeeds.version}\n` +
    `- Local sightings: ${spots.length}\n` +
    `- Smart targets: ${targets.length}\n` +
    `- Field checks near seeds: ${fieldObservations.length}\n` +
    `- Referenced public seeds: ${referencedSeeds.length}\n\n` +
    `Attach the exported GeoJSON report from the phone share sheet if GitHub does not attach it automatically.`;

  await Share.share({
    title: `${APP_NAME} field report`,
    text: reportText,
    url: result.uri,
    dialogTitle: `Share ${APP_NAME} report`,
  });

  const openIssue = confirm('Open a GitHub issue draft for this field report? Attach the exported GeoJSON there.');
  if (openIssue) {
    const title = `${APP_NAME} field report ${new Date().toISOString().slice(0, 10)}`;
    const issueUrl =
      `https://github.com/${UPDATE_REPO}/issues/new?` +
      `title=${encodeURIComponent(title)}&body=${encodeURIComponent(reportText)}`;
    window.open(issueUrl, '_blank', 'noopener');
  }
}

function buildFieldReportGeoJson() {
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
      ssid: spot.ssid,
      role: spot.role,
      rssi: spot.rssi,
      channel: spot.channel,
      confidence: spot.confidence,
      wildcardProbe: spot.wildcardProbe,
      seedId: spot.seedId,
      seedLabel: spot.seedLabel,
      seedDistanceMeters: spot.seedDistanceMeters,
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
  const observationFeatures = fieldObservations.map((observation) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [observation.lon, observation.lat],
    },
    properties: {
      kind: 'field-observation',
      id: observation.id,
      createdAt: observation.createdAt,
      source: observation.source,
      seedId: observation.seedId,
      seedLabel: observation.seedLabel,
      accuracy: observation.accuracy,
      seedDistanceMeters: observation.distanceMeters,
      sensorConnected: observation.sensorConnected,
      firmwareVersion: observation.firmwareVersion,
      signalCount: observation.signalCount,
    },
  }));
  const seedFeatures = referencedCameraSeeds().map((seed) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [seed.lon, seed.lat],
    },
    properties: {
      kind: 'public-camera-seed',
      id: seed.id,
      label: cameraSeedLabel(seed),
      brand: seed.brand,
      operator: seed.operator,
      source: seed.source,
      ref: seed.ref,
      direction: seed.direction,
      directionCardinal: seed.directionCardinal,
      surveillanceZone: seed.surveillanceZone,
      mountType: seed.mountType,
      osmTimestamp: seed.osmTimestamp,
      osmVersion: seed.osmVersion,
    },
  }));
  const geojson = {
    type: 'FeatureCollection',
    name: `${APP_NAME} field report`,
    properties: {
      appName: APP_NAME,
      appVersion: APP_VERSION,
      generatedAt: new Date().toISOString(),
      cameraSeedVersion: activeCameraSeeds.version,
      cameraSeedPointCount: activeCameraSeeds.points.length,
      cameraSeedSources: activeCameraSeeds.sources,
    },
    features: [...targetFeatures, ...sightingFeatures, ...observationFeatures, ...seedFeatures],
  };
  return geojson;
}

function referencedCameraSeeds() {
  const ids = new Set<string>();
  for (const spot of spots) {
    if (spot.seedId) {
      ids.add(spot.seedId);
    }
  }
  for (const observation of fieldObservations) {
    ids.add(observation.seedId);
  }
  if (nearestCameraSeed) {
    ids.add(nearestCameraSeed.seed.id);
  }
  if (!ids.size) {
    return [];
  }
  return activeCameraSeeds.points.filter((seed) => ids.has(seed.id));
}

async function clearSpots() {
  if (spots.length === 0 && fieldObservations.length === 0) {
    return;
  }
  const ok = confirm(`Clear ${spots.length} saved signals and ${fieldObservations.length} field checks?`);
  if (!ok) {
    return;
  }
  spots = [];
  fieldObservations = [];
  seedObservationTimes = new Map();
  await persistSpots();
  await persistFieldObservations();
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

function readStoredFieldObservations(): FieldObservation[] {
  try {
    const raw = localStorage.getItem(FIELD_OBSERVATION_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as FieldObservation[];
    return Array.isArray(parsed) ? parsed.filter(isFieldObservation) : [];
  } catch {
    return [];
  }
}

function isFieldObservation(value: FieldObservation | null | undefined): value is FieldObservation {
  return Boolean(
    value &&
      typeof value.id === 'string' &&
      typeof value.seedId === 'string' &&
      typeof value.lat === 'number' &&
      typeof value.lon === 'number' &&
      value.source === 'seed-proximity',
  );
}

function buildSeedObservationTimes(observations: FieldObservation[]) {
  const map = new Map<string, number>();
  for (const observation of observations) {
    const timestamp = new Date(observation.createdAt).getTime();
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    map.set(observation.seedId, Math.max(map.get(observation.seedId) ?? 0, timestamp));
  }
  return map;
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

async function persistFieldObservations() {
  localStorage.setItem(FIELD_OBSERVATION_STORAGE_KEY, JSON.stringify(fieldObservations));
  try {
    await Filesystem.writeFile({
      path: 'roadlens/field-observations.json',
      data: JSON.stringify(fieldObservations, null, 2),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } catch {
    // Observations are also kept in localStorage for fast startup.
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
