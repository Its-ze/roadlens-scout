#include <Arduino.h>
#include <HTTPClient.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ctype.h>
#include <esp_idf_version.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/sha256.h>

#include "signatures.h"

#ifndef ROADLENS_FIRMWARE_VERSION
#define ROADLENS_FIRMWARE_VERSION "0.1.20"
#endif

#ifndef ROADLENS_CHIP_FAMILY
#define ROADLENS_CHIP_FAMILY "ESP32"
#endif

#ifndef ROADLENS_OTA_URL
#define ROADLENS_OTA_URL "https://its-ze.github.io/roadlens-scout/flasher/firmware/esp32/firmware.bin"
#endif

static char deviceName[24] = "RoadLens";
static constexpr char SERVICE_UUID[] = "7d1d0001-52a1-4b81-9fd2-fd7ec3f50100";
static constexpr char NOTIFY_UUID[] = "7d1d0002-52a1-4b81-9fd2-fd7ec3f50100";
static constexpr char COMMAND_UUID[] = "7d1d0003-52a1-4b81-9fd2-fd7ec3f50100";

static constexpr uint8_t LED_PIN = 2;
static constexpr uint32_t CHANNEL_DWELL_MS = 180;
static constexpr uint32_t DUPLICATE_SUPPRESS_MS = 15000;
static constexpr uint32_t STATUS_INTERVAL_MS = 5000;
static constexpr uint8_t CLUSTER_CONTROL_CHANNEL = 6;
static constexpr uint8_t CLUSTER_SCAN_LANES = 4;
static constexpr uint32_t CLUSTER_CYCLE_MS = 1800;
static constexpr uint32_t CLUSTER_CONTROL_WINDOW_MS = 320;
static constexpr uint32_t CLUSTER_BEACON_INTERVAL_MS = 90;
static constexpr uint32_t CLUSTER_HELLO_INTERVAL_MS = 900;
static constexpr uint32_t CLUSTER_LEADER_TIMEOUT_MS = 6500;
static constexpr uint32_t CLUSTER_NODE_TIMEOUT_MS = 9000;
static constexpr size_t MAX_CLUSTER_NODES = 8;
static constexpr size_t BLE_NOTIFY_CHUNK_BYTES = 220;
static constexpr uint32_t BLE_NOTIFY_INTERVAL_MS = 100;
static constexpr size_t BLE_MESSAGE_MAX_BYTES = 384;
static constexpr UBaseType_t BLE_MESSAGE_QUEUE_LENGTH = 24;
static constexpr uint32_t OTA_WIFI_TIMEOUT_MS = 25000;
static constexpr uint32_t OTA_HTTP_IDLE_TIMEOUT_MS = 45000;
static constexpr size_t MAX_DYNAMIC_SIGNATURES = 96;
static const uint8_t CHANNELS[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};

struct DetectionEvent {
  char mac[18];
  char role[10];
  char label[32];
  char ssid[33];
  int8_t rssi;
  uint8_t channel;
  uint8_t frameType;
  uint8_t frameSubtype;
  uint8_t confidence;
  bool wildcardProbe;
  uint32_t uptimeMs;
};

struct SeenEntry {
  uint8_t mac[6];
  char role[10];
  uint32_t lastSeenMs;
  bool used;
};

struct BleMessage {
  uint16_t length;
  uint8_t bytes[BLE_MESSAGE_MAX_BYTES];
};

enum ClusterPacketKind : uint8_t {
  CLUSTER_BEACON = 1,
  CLUSTER_HELLO = 2,
  CLUSTER_DETECTION = 3,
  CLUSTER_STOP = 4,
};

struct __attribute__((packed)) ClusterPacket {
  uint32_t magic;
  uint8_t protocolVersion;
  uint8_t kind;
  uint8_t sourceMac[6];
  uint32_t sequence;
  uint32_t uptimeMs;
  uint8_t scanActive;
  uint8_t lane;
  int8_t rssi;
  uint8_t channel;
  uint8_t frameType;
  uint8_t frameSubtype;
  uint8_t confidence;
  uint8_t wildcardProbe;
  char mac[18];
  char role[10];
  char label[32];
  char ssid[33];
};

static_assert(sizeof(ClusterPacket) <= ESP_NOW_MAX_DATA_LEN,
              "RoadLens cluster packet exceeds ESP-NOW payload size");

struct ClusterNode {
  uint8_t mac[6];
  uint8_t lane;
  uint32_t lastSeenMs;
  bool used;
};

static QueueHandle_t detectionQueue = nullptr;
static QueueHandle_t bleMessageQueue = nullptr;
static QueueHandle_t clusterRxQueue = nullptr;
static NimBLECharacteristic *notifyCharacteristic = nullptr;
static BleMessage currentBleMessage = {};
static size_t currentBleMessageOffset = 0;
static bool currentBleMessageActive = false;
static uint32_t lastBleNotifyMs = 0;
static bool bleConnected = false;
static bool wifiSnifferActive = false;
static bool snifferStartRequested = false;
static uint32_t snifferStartAtMs = 0;
static uint8_t channelIndex = 0;
static uint8_t currentRadioChannel = CLUSTER_CONTROL_CHANNEL;
static uint32_t lastChannelHopMs = 0;
static uint32_t lastStatusMs = 0;
static uint32_t detectionCount = 0;
static volatile uint32_t wifiFramesSeen = 0;
static volatile uint32_t mgmtFramesSeen = 0;
static volatile uint32_t dataFramesSeen = 0;
static volatile uint32_t wildcardProbesSeen = 0;
static volatile uint32_t candidateFramesSeen = 0;
static volatile uint32_t queueDrops = 0;
static SeenEntry seenEntries[24] = {};
static String otaSsid;
static String otaPassword;
static String otaExpectedSha256;
static String otaTargetVersion;
static uint32_t otaExpectedBytes = 0;
static bool otaStartRequested = false;
static bool otaInProgress = false;
static bool restartPending = false;
static uint32_t restartAtMs = 0;
static OuiSignature dynamicSignatures[MAX_DYNAMIC_SIGNATURES] = {};
static OuiSignature stagedSignatures[MAX_DYNAMIC_SIGNATURES] = {};
static size_t dynamicSignatureCount = 0;
static size_t stagedSignatureCount = 0;
static char dynamicSignatureVersion[25] = "";
static char stagedSignatureVersion[25] = "";
static bool signatureApplyRequested = false;
static constexpr uint32_t CLUSTER_MAGIC = 0x524C5343;  // RLSC
static const uint8_t CLUSTER_BROADCAST_MAC[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static uint8_t selfMac[6] = {};
static char clusterNodeId[7] = "000000";
static uint8_t clusterLane = 0;
static uint8_t clusterLeaderMac[6] = {};
static bool clusterRadioReady = false;
static bool clusterGateway = false;
static bool clusterControlWindow = true;
static bool clusterScanActive = false;
static uint32_t clusterSequence = 0;
static uint32_t clusterWindowStartedMs = 0;
static uint32_t clusterNextWindowMs = 0;
static uint32_t clusterLeaderLastSeenMs = 0;
static uint32_t lastClusterBeaconMs = 0;
static uint32_t lastClusterHelloMs = 0;
static ClusterNode clusterNodes[MAX_CLUSTER_NODES] = {};

static void setupSniffer();
static void stopSniffer();
static void performOtaUpdate();
static void applyStagedSignatures();
static void setupClusterRadio();
static void serviceCluster(uint32_t nowMs);
static void emitRemoteDetection(const ClusterPacket &packet);
static void emitStatus(const char *reason);

static void setRadioChannel(uint8_t channel) {
  if (!clusterRadioReady || channel < 1 || channel > 11) {
    return;
  }
  esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
  currentRadioChannel = channel;
}

static void fillClusterPacket(ClusterPacket &packet, ClusterPacketKind kind) {
  memset(&packet, 0, sizeof(packet));
  packet.magic = CLUSTER_MAGIC;
  packet.protocolVersion = 1;
  packet.kind = kind;
  memcpy(packet.sourceMac, selfMac, sizeof(packet.sourceMac));
  packet.sequence = ++clusterSequence;
  packet.uptimeMs = millis();
  packet.scanActive = clusterScanActive ? 1U : 0U;
  packet.lane = clusterLane;
}

static bool sendClusterPacket(const ClusterPacket &packet) {
  if (!clusterRadioReady || !clusterControlWindow) {
    return false;
  }
  return esp_now_send(CLUSTER_BROADCAST_MAC,
                      reinterpret_cast<const uint8_t *>(&packet),
                      sizeof(packet)) == ESP_OK;
}

static void queueClusterPacket(const uint8_t *data, int length) {
  if (data == nullptr || length != static_cast<int>(sizeof(ClusterPacket)) ||
      clusterRxQueue == nullptr) {
    return;
  }
  ClusterPacket packet = {};
  memcpy(&packet, data, sizeof(packet));
  packet.mac[sizeof(packet.mac) - 1] = '\0';
  packet.role[sizeof(packet.role) - 1] = '\0';
  packet.label[sizeof(packet.label) - 1] = '\0';
  packet.ssid[sizeof(packet.ssid) - 1] = '\0';
  if (packet.magic != CLUSTER_MAGIC || packet.protocolVersion != 1 ||
      memcmp(packet.sourceMac, selfMac, sizeof(selfMac)) == 0) {
    return;
  }
  xQueueSend(clusterRxQueue, &packet, 0);
}

#if ESP_IDF_VERSION_MAJOR >= 5
static void onClusterReceive(const esp_now_recv_info_t *, const uint8_t *data,
                             int length) {
  queueClusterPacket(data, length);
}
#else
static void onClusterReceive(const uint8_t *, const uint8_t *data, int length) {
  queueClusterPacket(data, length);
}
#endif

static void setupClusterRadio() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  esp_wifi_get_mac(WIFI_IF_STA, selfMac);
  snprintf(clusterNodeId, sizeof(clusterNodeId), "%02X%02X%02X", selfMac[3],
           selfMac[4], selfMac[5]);
  clusterLane = selfMac[5] % CLUSTER_SCAN_LANES;
  esp_wifi_set_channel(CLUSTER_CONTROL_CHANNEL, WIFI_SECOND_CHAN_NONE);
  currentRadioChannel = CLUSTER_CONTROL_CHANNEL;

  if (esp_now_init() != ESP_OK) {
    Serial.println("RoadLens cluster: ESP-NOW initialization failed");
    return;
  }
  esp_now_register_recv_cb(onClusterReceive);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, CLUSTER_BROADCAST_MAC, sizeof(peer.peer_addr));
  peer.channel = 0;
  peer.encrypt = false;
  if (!esp_now_is_peer_exist(CLUSTER_BROADCAST_MAC) &&
      esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("RoadLens cluster: broadcast peer setup failed");
    esp_now_deinit();
    return;
  }

  clusterRadioReady = true;
  clusterControlWindow = true;
  clusterWindowStartedMs = millis();
  clusterNextWindowMs = clusterWindowStartedMs + CLUSTER_CYCLE_MS;
}

static void formatMac(const uint8_t *mac, char *out, size_t outLen) {
  snprintf(out, outLen, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1],
           mac[2], mac[3], mac[4], mac[5]);
}

static uint16_t taggedParameterOffset(uint8_t frameType, uint8_t frameSubtype) {
  if (frameType != 0) {
    return 0;
  }

  switch (frameSubtype) {
    case 0:  // Association request.
      return 28;
    case 2:  // Reassociation request.
      return 34;
    case 4:  // Probe request.
      return 24;
    case 5:  // Probe response.
    case 8:  // Beacon.
      return 36;
    default:
      return 0;
  }
}

static bool extractSsidFromFrame(const uint8_t *payload, uint16_t len,
                                 uint8_t frameType, uint8_t frameSubtype,
                                 char *out, size_t outLen) {
  if (outLen == 0) {
    return false;
  }
  out[0] = '\0';

  uint16_t pos = taggedParameterOffset(frameType, frameSubtype);
  if (pos == 0 || len < pos + 2) {
    return false;
  }

  while (pos + 2 <= len) {
    const uint8_t tag = payload[pos];
    const uint8_t tagLen = payload[pos + 1];
    if (pos + 2 + tagLen > len) {
      return false;
    }
    if (tag == 0) {
      const size_t copyLen = min(static_cast<size_t>(tagLen), outLen - 1);
      for (size_t i = 0; i < copyLen; i++) {
        const char c = static_cast<char>(payload[pos + 2 + i]);
        out[i] = isprint(static_cast<unsigned char>(c)) ? c : '?';
      }
      out[copyLen] = '\0';
      return true;
    }
    pos += 2 + tagLen;
  }

  return false;
}

static bool startsWithIgnoreCase(const char *value, const char *prefix) {
  for (size_t i = 0; prefix[i] != '\0'; i++) {
    if (value[i] == '\0' ||
        tolower(static_cast<unsigned char>(value[i])) !=
            tolower(static_cast<unsigned char>(prefix[i]))) {
      return false;
    }
  }
  return true;
}

static bool containsIgnoreCase(const char *value, const char *needle) {
  const size_t needleLen = strlen(needle);
  if (needleLen == 0) {
    return true;
  }
  for (size_t i = 0; value[i] != '\0'; i++) {
    size_t j = 0;
    while (j < needleLen && value[i + j] != '\0' &&
           tolower(static_cast<unsigned char>(value[i + j])) ==
               tolower(static_cast<unsigned char>(needle[j]))) {
      j++;
    }
    if (j == needleLen) {
      return true;
    }
  }
  return false;
}

static bool matchesFlockSsid(const char *ssid, char *label, size_t labelLen,
                             uint8_t *confidence) {
  if (ssid == nullptr || ssid[0] == '\0') {
    return false;
  }

  if (startsWithIgnoreCase(ssid, "Flock-")) {
    bool validSuffix = false;
    for (size_t i = 6; ssid[i] != '\0'; i++) {
      if (!isalnum(static_cast<unsigned char>(ssid[i]))) {
        validSuffix = false;
        break;
      }
      validSuffix = true;
    }
    if (validSuffix) {
      strlcpy(label, "flock-wifi-ssid", labelLen);
      *confidence = 88;
      return true;
    }
  }

  if (containsIgnoreCase(ssid, "FS Ext Battery")) {
    strlcpy(label, "flock-wifi-battery-ssid", labelLen);
    *confidence = 86;
    return true;
  }
  if (containsIgnoreCase(ssid, "Penguin")) {
    strlcpy(label, "flock-wifi-penguin-ssid", labelLen);
    *confidence = 84;
    return true;
  }
  if (containsIgnoreCase(ssid, "Pigvision")) {
    strlcpy(label, "flock-wifi-pigvision-ssid", labelLen);
    *confidence = 84;
    return true;
  }

  return false;
}

static bool wildcardSsidProbe(const uint8_t *payload, uint16_t len,
                              uint8_t frameType, uint8_t frameSubtype) {
  if (frameType != 0 || frameSubtype != 4 || len < 26) {
    return false;
  }

  uint16_t pos = 24;
  while (pos + 2 <= len) {
    const uint8_t tag = payload[pos];
    const uint8_t tagLen = payload[pos + 1];
    if (pos + 2 + tagLen > len) {
      return false;
    }
    if (tag == 0) {
      return tagLen == 0;
    }
    pos += 2 + tagLen;
  }

  return false;
}

static String jsonEscape(const String &value) {
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i++) {
    const char c = value[i];
    switch (c) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (static_cast<uint8_t>(c) < 0x20) {
          char escaped[7];
          snprintf(escaped, sizeof(escaped), "\\u%04x", c);
          out += escaped;
        } else {
          out += c;
        }
        break;
    }
  }
  return out;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

static bool appendHexBytes(String &target, const String &hexChunk,
                           size_t maxBytes) {
  if ((hexChunk.length() % 2) != 0 ||
      target.length() + (hexChunk.length() / 2) > maxBytes) {
    return false;
  }

  for (size_t i = 0; i < hexChunk.length(); i += 2) {
    const int hi = hexNibble(hexChunk[i]);
    const int lo = hexNibble(hexChunk[i + 1]);
    if (hi < 0 || lo < 0) {
      return false;
    }
    target += static_cast<char>((hi << 4) | lo);
  }
  return true;
}

static bool appendHexText(String &target, const String &chunk,
                          size_t maxChars) {
  if (target.length() + chunk.length() > maxChars) {
    return false;
  }

  for (size_t i = 0; i < chunk.length(); i++) {
    if (hexNibble(chunk[i]) < 0) {
      return false;
    }
    target += static_cast<char>(tolower(chunk[i]));
  }
  return true;
}

static String sha256Hex(const uint8_t *hash) {
  static const char hex[] = "0123456789abcdef";
  String out;
  out.reserve(64);
  for (size_t i = 0; i < 32; i++) {
    out += hex[(hash[i] >> 4) & 0x0f];
    out += hex[hash[i] & 0x0f];
  }
  return out;
}

static void resetOtaConfig() {
  otaSsid = "";
  otaPassword = "";
  otaExpectedSha256 = "";
  otaTargetVersion = "";
  otaExpectedBytes = 0;
  otaStartRequested = false;
}

static bool parseCompactPrefix(const String &value, uint8_t *out) {
  if (value.length() != 6) {
    return false;
  }

  for (size_t i = 0; i < 3; i++) {
    const int hi = hexNibble(value[i * 2]);
    const int lo = hexNibble(value[i * 2 + 1]);
    if (hi < 0 || lo < 0) {
      return false;
    }
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}

static bool signatureEntryEquals(const OuiSignature &signature, const uint8_t *prefix) {
  return signature.bytes[0] == prefix[0] && signature.bytes[1] == prefix[1] &&
         signature.bytes[2] == prefix[2];
}

static void resetStagedSignatures() {
  stagedSignatureCount = 0;
  stagedSignatureVersion[0] = '\0';
  memset(stagedSignatures, 0, sizeof(stagedSignatures));
}

static size_t activeSignatureCount() {
  return dynamicSignatureCount > 0 ? dynamicSignatureCount : FLOCK_WIFI_OUI_COUNT;
}

static const char *activeSignatureVersion() {
  return dynamicSignatureCount > 0 && dynamicSignatureVersion[0] != '\0'
             ? dynamicSignatureVersion
             : "builtin";
}

static const char *activeSignatureSource() {
  return dynamicSignatureCount > 0 ? "synced" : "builtin";
}

static String encodeDynamicSignatureSet() {
  static const char hex[] = "0123456789abcdef";
  String encoded;
  encoded.reserve(dynamicSignatureCount * 8);
  for (size_t i = 0; i < dynamicSignatureCount; i++) {
    if (i > 0) {
      encoded += ",";
    }
    const OuiSignature &signature = dynamicSignatures[i];
    for (size_t j = 0; j < 3; j++) {
      encoded += hex[(signature.bytes[j] >> 4) & 0x0f];
      encoded += hex[signature.bytes[j] & 0x0f];
    }
    encoded += signature.allowLocalAdministered ? "1" : "0";
  }
  return encoded;
}

static void saveDynamicSignatures() {
  Preferences prefs;
  if (!prefs.begin("roadlens", false)) {
    return;
  }
  prefs.putString("sigver", dynamicSignatureVersion);
  prefs.putString("sigset", encodeDynamicSignatureSet());
  prefs.end();
}

static void loadDynamicSignatures() {
  Preferences prefs;
  if (!prefs.begin("roadlens", true)) {
    return;
  }

  const String version = prefs.getString("sigver", "");
  const String encoded = prefs.getString("sigset", "");
  prefs.end();

  if (encoded.length() == 0) {
    return;
  }

  size_t count = 0;
  int start = 0;
  while (start < static_cast<int>(encoded.length()) && count < MAX_DYNAMIC_SIGNATURES) {
    int comma = encoded.indexOf(',', start);
    if (comma < 0) {
      comma = encoded.length();
    }
    String token = encoded.substring(start, comma);
    token.trim();
    if (token.length() == 7) {
      uint8_t prefix[3] = {};
      if (parseCompactPrefix(token.substring(0, 6), prefix)) {
        OuiSignature &slot = dynamicSignatures[count++];
        memcpy(slot.bytes, prefix, sizeof(slot.bytes));
        slot.allowLocalAdministered = token[6] == '1';
        slot.label = slot.allowLocalAdministered ? "flock-wifi-wildcard" : "flock-wifi";
      }
    }
    start = comma + 1;
  }

  if (count > 0) {
    dynamicSignatureCount = count;
    strlcpy(dynamicSignatureVersion, version.c_str(), sizeof(dynamicSignatureVersion));
  }
}

static const OuiSignature *matchActiveFlockOui(const uint8_t *mac) {
  if (isMulticastMac(mac)) {
    return nullptr;
  }

  if (dynamicSignatureCount > 0) {
    for (size_t i = 0; i < dynamicSignatureCount; i++) {
      const OuiSignature *signature = &dynamicSignatures[i];
      if (mac[0] == signature->bytes[0] && mac[1] == signature->bytes[1] &&
          mac[2] == signature->bytes[2]) {
        if (isLocalAdministeredMac(mac) && !signature->allowLocalAdministered) {
          return nullptr;
        }
        return signature;
      }
    }
    return nullptr;
  }

  return matchStaticFlockOui(mac);
}

static bool shouldSuppress(const uint8_t *mac, const char *role,
                           uint32_t nowMs) {
  int oldestIndex = 0;
  uint32_t oldestAge = 0;

  for (size_t i = 0; i < sizeof(seenEntries) / sizeof(seenEntries[0]); i++) {
    SeenEntry &entry = seenEntries[i];
    if (entry.used && memcmp(entry.mac, mac, 6) == 0 &&
        strncmp(entry.role, role, sizeof(entry.role)) == 0) {
      if (nowMs - entry.lastSeenMs < DUPLICATE_SUPPRESS_MS) {
        return true;
      }
      entry.lastSeenMs = nowMs;
      return false;
    }

    const uint32_t age = entry.used ? nowMs - entry.lastSeenMs : UINT32_MAX;
    if (age >= oldestAge) {
      oldestAge = age;
      oldestIndex = static_cast<int>(i);
    }
  }

  SeenEntry &slot = seenEntries[oldestIndex];
  memcpy(slot.mac, mac, 6);
  strlcpy(slot.role, role, sizeof(slot.role));
  slot.lastSeenMs = nowMs;
  slot.used = true;
  return false;
}

static void queueDetection(const uint8_t *mac, const char *role,
                           const OuiSignature *signature, int8_t rssi,
                           uint8_t channel, uint8_t frameType,
                           uint8_t frameSubtype, bool wildcardProbe,
                           const char *ssid = "",
                           const char *labelOverride = nullptr,
                           uint8_t confidenceOverride = 0) {
  const uint32_t nowMs = millis();
  if ((!signature && labelOverride == nullptr) || shouldSuppress(mac, role, nowMs) ||
      detectionQueue == nullptr) {
    return;
  }

  DetectionEvent event = {};
  formatMac(mac, event.mac, sizeof(event.mac));
  strlcpy(event.role, role, sizeof(event.role));
  strlcpy(event.label, labelOverride != nullptr ? labelOverride : signature->label,
          sizeof(event.label));
  strlcpy(event.ssid, ssid != nullptr ? ssid : "", sizeof(event.ssid));
  event.rssi = rssi;
  event.channel = channel;
  event.frameType = frameType;
  event.frameSubtype = frameSubtype;
  event.wildcardProbe = wildcardProbe;
  event.uptimeMs = nowMs;

  if (confidenceOverride > 0) {
    event.confidence = confidenceOverride;
  } else if (wildcardProbe && strcmp(role, "addr2") == 0) {
    event.confidence = 96;
  } else if (mac[0] == 0xb4 && mac[1] == 0x1e && mac[2] == 0x52 &&
             strcmp(role, "addr2") == 0) {
    event.confidence = 90;
  } else if (strcmp(role, "addr2") == 0) {
    event.confidence = 82;
  } else if (strcmp(role, "addr1") == 0) {
    event.confidence = 70;
  } else {
    event.confidence = 62;
  }

  if (xQueueSend(detectionQueue, &event, 0) != pdTRUE) {
    queueDrops++;
  }
}

static void snifferCallback(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT && type != WIFI_PKT_DATA) {
    return;
  }

  const wifi_promiscuous_pkt_t *packet =
      reinterpret_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *payload = packet->payload;
  const uint16_t len = packet->rx_ctrl.sig_len;
  if (len < 24) {
    return;
  }

  const uint16_t frameControl = payload[0] | (payload[1] << 8);
  const uint8_t frameType = (frameControl >> 2) & 0x03;
  const uint8_t frameSubtype = (frameControl >> 4) & 0x0f;
  if (frameType != 0 && frameType != 2) {
    return;
  }

  wifiFramesSeen++;
  if (frameType == 0) {
    mgmtFramesSeen++;
  } else if (frameType == 2) {
    dataFramesSeen++;
  }

  const bool wildcardProbe =
      wildcardSsidProbe(payload, len, frameType, frameSubtype);
  if (wildcardProbe) {
    wildcardProbesSeen++;
  }

  char ssid[33] = "";
  char ssidLabel[32] = "";
  uint8_t ssidConfidence = 0;
  const bool hasSsid =
      extractSsidFromFrame(payload, len, frameType, frameSubtype, ssid, sizeof(ssid));
  const bool flockSsid =
      hasSsid && matchesFlockSsid(ssid, ssidLabel, sizeof(ssidLabel),
                                  &ssidConfidence);

  const uint8_t *addr1 = payload + 4;
  const uint8_t *addr2 = payload + 10;
  const uint8_t *addr3 = payload + 16;
  const int8_t rssi = packet->rx_ctrl.rssi;
  const uint8_t channel = packet->rx_ctrl.channel;

  auto inspectAddress = [&](const uint8_t *addr, const char *role,
                            bool wildcardForRole) {
    const OuiSignature *signature = matchActiveFlockOui(addr);
    if (signature) {
      candidateFramesSeen++;
    }
    queueDetection(addr, role, signature, rssi, channel, frameType,
                   frameSubtype, wildcardForRole, ssid);
  };

  if (flockSsid) {
    candidateFramesSeen++;
    queueDetection(addr2, "ssid", nullptr, rssi, channel, frameType,
                   frameSubtype, wildcardProbe, ssid, ssidLabel,
                   ssidConfidence);
  }

  inspectAddress(addr2, "addr2", wildcardProbe);
  inspectAddress(addr1, "addr1", false);
  inspectAddress(addr3, "addr3", false);

  const bool toDs = (frameControl & 0x0100) != 0;
  const bool fromDs = (frameControl & 0x0200) != 0;
  if (frameType == 2 && toDs && fromDs && len >= 30) {
    inspectAddress(payload + 24, "addr4", false);
  }
}

static void emitLine(const String &line) {
  Serial.print(line);
  if (!bleConnected || bleMessageQueue == nullptr || line.isEmpty() ||
      line.length() > BLE_MESSAGE_MAX_BYTES) {
    return;
  }

  BleMessage message = {};
  message.length = static_cast<uint16_t>(line.length());
  memcpy(message.bytes, line.c_str(), message.length);
  if (xQueueSend(bleMessageQueue, &message, 0) != pdTRUE) {
    BleMessage discarded = {};
    xQueueReceive(bleMessageQueue, &discarded, 0);
    xQueueSend(bleMessageQueue, &message, 0);
  }
}

static void drainBleNotifications(uint32_t nowMs) {
  if (!bleConnected || notifyCharacteristic == nullptr || bleMessageQueue == nullptr) {
    currentBleMessageActive = false;
    currentBleMessageOffset = 0;
    return;
  }

  if (nowMs - lastBleNotifyMs < BLE_NOTIFY_INTERVAL_MS) {
    return;
  }

  if (!currentBleMessageActive) {
    if (xQueueReceive(bleMessageQueue, &currentBleMessage, 0) != pdTRUE) {
      return;
    }
    currentBleMessageOffset = 0;
    currentBleMessageActive = true;
  }

  const size_t remaining = currentBleMessage.length - currentBleMessageOffset;
  const size_t chunkLength = min(BLE_NOTIFY_CHUNK_BYTES, remaining);
  notifyCharacteristic->setValue(currentBleMessage.bytes + currentBleMessageOffset, chunkLength);
  notifyCharacteristic->notify();
  currentBleMessageOffset += chunkLength;
  lastBleNotifyMs = nowMs;

  if (currentBleMessageOffset >= currentBleMessage.length) {
    currentBleMessageActive = false;
    currentBleMessageOffset = 0;
  }
}

static void emitOtaStatus(const char *state, const String &detail,
                          int progress = -1) {
  const String escapedDetail = jsonEscape(detail);
  char json[384];
  snprintf(json, sizeof(json),
           "{\"t\":\"o\",\"s\":\"%s\",\"d\":\"%s\",\"p\":%d,\"v\":\"%s\",\"c\":\"%s\"}\n",
           state, escapedDetail.c_str(), progress, ROADLENS_FIRMWARE_VERSION,
           ROADLENS_CHIP_FAMILY);
  emitLine(String(json));
}

static void emitSignatureStatus(const char *state, const String &detail,
                                size_t count) {
  const String escapedDetail = jsonEscape(detail);
  char json[384];
  snprintf(json, sizeof(json),
           "{\"t\":\"g\",\"s\":\"%s\",\"d\":\"%s\",\"n\":%u,\"v\":\"%s\"}\n",
           state, escapedDetail.c_str(), static_cast<unsigned>(count),
           activeSignatureVersion());
  emitLine(String(json));
}

static void emitStatus(const char *reason) {
  size_t activeClusterNodes = 1;
  const uint32_t nowMs = millis();
  if (clusterGateway) {
    for (const ClusterNode &node : clusterNodes) {
      if (node.used && nowMs - node.lastSeenMs <= CLUSTER_NODE_TIMEOUT_MS) {
        activeClusterNodes++;
      }
    }
  }
  const char *clusterRole = clusterGateway
                                ? "gateway"
                                : (clusterLeaderLastSeenMs > 0 &&
                                           nowMs - clusterLeaderLastSeenMs <= CLUSTER_LEADER_TIMEOUT_MS
                                       ? "worker"
                                       : "idle");
  char core[384];
  snprintf(core, sizeof(core),
           "{\"t\":\"s\",\"d\":\"%s\",\"r\":\"%s\",\"u\":%lu,\"c\":%u," 
           "\"b\":%u,\"a\":%u,\"v\":\"%s\",\"h\":\"%s\",\"o\":1,\"i\":%u," 
           "\"ov\":\"%s\",\"g\":%u,\"sv\":\"%s\",\"ss\":\"%s\",\"sy\":1," 
           "\"cr\":\"%s\",\"cn\":%u,\"ci\":\"%s\",\"cl\":%u}\n",
           deviceName, reason, static_cast<unsigned long>(nowMs), currentRadioChannel,
           bleConnected ? 1U : 0U, wifiSnifferActive ? 1U : 0U,
           ROADLENS_FIRMWARE_VERSION, ROADLENS_CHIP_FAMILY, otaInProgress ? 1U : 0U,
           otaTargetVersion.c_str(), static_cast<unsigned>(activeSignatureCount()),
           activeSignatureVersion(), activeSignatureSource(), clusterRole,
           static_cast<unsigned>(activeClusterNodes), clusterNodeId,
           static_cast<unsigned>(clusterLane));
  emitLine(String(core));

  char metrics[256];
  snprintf(metrics, sizeof(metrics),
           "{\"t\":\"m\",\"n\":%lu,\"f\":%lu,\"m\":%lu,\"x\":%lu," 
           "\"w\":%lu,\"k\":%lu,\"q\":%lu}\n",
           static_cast<unsigned long>(detectionCount), static_cast<unsigned long>(wifiFramesSeen),
           static_cast<unsigned long>(mgmtFramesSeen), static_cast<unsigned long>(dataFramesSeen),
           static_cast<unsigned long>(wildcardProbesSeen),
           static_cast<unsigned long>(candidateFramesSeen), static_cast<unsigned long>(queueDrops));
  emitLine(String(metrics));
}

static void emitDetection(const DetectionEvent &event) {
  detectionCount++;

  const String escapedLabel = jsonEscape(String(event.label));
  const String escapedSsid = jsonEscape(String(event.ssid));
  char json[384];
  snprintf(json, sizeof(json),
           "{\"t\":\"d\",\"m\":\"%s\",\"s\":\"%s\",\"r\":\"%s\",\"l\":\"%s\"," 
           "\"p\":%d,\"c\":%u,\"ft\":%u,\"fs\":%u,\"w\":%u,\"q\":%u,\"u\":%lu," 
           "\"n\":\"%s\"}\n",
           event.mac, escapedSsid.c_str(), event.role,
           escapedLabel.c_str(), event.rssi,
           event.channel, event.frameType, event.frameSubtype,
           event.wildcardProbe ? 1U : 0U, event.confidence,
           static_cast<unsigned long>(event.uptimeMs), clusterNodeId);
  emitLine(String(json));
}

static void emitRemoteDetection(const ClusterPacket &packet) {
  detectionCount++;
  char remoteNodeId[7];
  snprintf(remoteNodeId, sizeof(remoteNodeId), "%02X%02X%02X", packet.sourceMac[3],
           packet.sourceMac[4], packet.sourceMac[5]);
  const String escapedLabel = jsonEscape(String(packet.label));
  const String escapedSsid = jsonEscape(String(packet.ssid));
  char json[384];
  snprintf(json, sizeof(json),
           "{\"t\":\"d\",\"m\":\"%s\",\"s\":\"%s\",\"r\":\"%s\",\"l\":\"%s\"," 
           "\"p\":%d,\"c\":%u,\"ft\":%u,\"fs\":%u,\"w\":%u,\"q\":%u,\"u\":%lu," 
           "\"n\":\"%s\"}\n",
           packet.mac, escapedSsid.c_str(), packet.role, escapedLabel.c_str(),
           packet.rssi, packet.channel, packet.frameType, packet.frameSubtype,
           packet.wildcardProbe, packet.confidence,
           static_cast<unsigned long>(packet.uptimeMs), remoteNodeId);
  emitLine(String(json));
}

static void noteClusterNode(const ClusterPacket &packet, uint32_t nowMs) {
  ClusterNode *available = nullptr;
  ClusterNode *oldest = &clusterNodes[0];
  for (ClusterNode &node : clusterNodes) {
    if (node.used && memcmp(node.mac, packet.sourceMac, sizeof(node.mac)) == 0) {
      node.lastSeenMs = nowMs;
      node.lane = packet.lane;
      return;
    }
    if (!node.used && available == nullptr) {
      available = &node;
    }
    if (node.lastSeenMs < oldest->lastSeenMs) {
      oldest = &node;
    }
  }
  ClusterNode *node = available != nullptr ? available : oldest;
  memcpy(node->mac, packet.sourceMac, sizeof(node->mac));
  node->lane = packet.lane;
  node->lastSeenMs = nowMs;
  node->used = true;
}

static void broadcastClusterState(ClusterPacketKind kind) {
  ClusterPacket packet = {};
  fillClusterPacket(packet, kind);
  sendClusterPacket(packet);
}

static void sendClusterDetection(const DetectionEvent &event) {
  ClusterPacket packet = {};
  fillClusterPacket(packet, CLUSTER_DETECTION);
  packet.rssi = event.rssi;
  packet.channel = event.channel;
  packet.frameType = event.frameType;
  packet.frameSubtype = event.frameSubtype;
  packet.confidence = event.confidence;
  packet.wildcardProbe = event.wildcardProbe ? 1U : 0U;
  strlcpy(packet.mac, event.mac, sizeof(packet.mac));
  strlcpy(packet.role, event.role, sizeof(packet.role));
  strlcpy(packet.label, event.label, sizeof(packet.label));
  strlcpy(packet.ssid, event.ssid, sizeof(packet.ssid));
  sendClusterPacket(packet);
}

static void enterClusterControlWindow(uint32_t nowMs) {
  clusterControlWindow = true;
  clusterWindowStartedMs = nowMs;
  clusterNextWindowMs = nowMs + CLUSTER_CYCLE_MS;
  setRadioChannel(CLUSTER_CONTROL_CHANNEL);
  if (clusterGateway) {
    broadcastClusterState(clusterScanActive ? CLUSTER_BEACON : CLUSTER_STOP);
    lastClusterBeaconMs = nowMs;
  } else {
    broadcastClusterState(CLUSTER_HELLO);
    lastClusterHelloMs = nowMs;
  }
}

static void leaveClusterControlWindow(uint32_t nowMs) {
  clusterControlWindow = false;
  channelIndex = clusterLane % (sizeof(CHANNELS) / sizeof(CHANNELS[0]));
  setRadioChannel(CHANNELS[channelIndex]);
  lastChannelHopMs = nowMs;
}

static void processClusterPackets(uint32_t nowMs) {
  ClusterPacket packet = {};
  while (clusterRxQueue != nullptr &&
         xQueueReceive(clusterRxQueue, &packet, 0) == pdTRUE) {
    if (clusterGateway) {
      if (packet.kind == CLUSTER_HELLO || packet.kind == CLUSTER_DETECTION) {
        noteClusterNode(packet, nowMs);
      }
      if (packet.kind == CLUSTER_DETECTION && clusterScanActive) {
        emitRemoteDetection(packet);
      }
      continue;
    }

    if (packet.kind == CLUSTER_BEACON || packet.kind == CLUSTER_STOP) {
      memcpy(clusterLeaderMac, packet.sourceMac, sizeof(clusterLeaderMac));
      clusterLeaderLastSeenMs = nowMs;
      clusterScanActive = packet.kind == CLUSTER_BEACON && packet.scanActive != 0;
      snifferStartRequested = clusterScanActive;
      clusterControlWindow = true;
      clusterWindowStartedMs = nowMs;
      clusterNextWindowMs = nowMs + CLUSTER_CYCLE_MS;
      setRadioChannel(CLUSTER_CONTROL_CHANNEL);
      if (clusterScanActive && !wifiSnifferActive && !otaInProgress) {
        setupSniffer();
      } else if (!clusterScanActive) {
        stopSniffer();
      }
      broadcastClusterState(CLUSTER_HELLO);
      lastClusterHelloMs = nowMs;
    }
  }
}

static void serviceCluster(uint32_t nowMs) {
  if (!clusterRadioReady || otaInProgress) {
    return;
  }
  processClusterPackets(nowMs);

  if (!clusterGateway && clusterLeaderLastSeenMs > 0 &&
      nowMs - clusterLeaderLastSeenMs > CLUSTER_LEADER_TIMEOUT_MS) {
    clusterLeaderLastSeenMs = 0;
    clusterScanActive = false;
    snifferStartRequested = false;
    stopSniffer();
    enterClusterControlWindow(nowMs);
  }

  if (clusterScanActive && !clusterControlWindow &&
      static_cast<int32_t>(nowMs - clusterNextWindowMs) >= 0) {
    enterClusterControlWindow(nowMs);
  }

  if (clusterControlWindow) {
    if (clusterGateway && nowMs - lastClusterBeaconMs >= CLUSTER_BEACON_INTERVAL_MS) {
      broadcastClusterState(clusterScanActive ? CLUSTER_BEACON : CLUSTER_STOP);
      lastClusterBeaconMs = nowMs;
    } else if (!clusterGateway && clusterLeaderLastSeenMs > 0 &&
               nowMs - lastClusterHelloMs >= CLUSTER_HELLO_INTERVAL_MS) {
      broadcastClusterState(CLUSTER_HELLO);
      lastClusterHelloMs = nowMs;
    }

    if (clusterScanActive &&
        nowMs - clusterWindowStartedMs >= CLUSTER_CONTROL_WINDOW_MS) {
      leaveClusterControlWindow(nowMs);
    }
  }
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *, NimBLEConnInfo &) override {
    bleConnected = true;
    clusterGateway = true;
    clusterScanActive = false;
    enterClusterControlWindow(millis());
    if (bleMessageQueue != nullptr) {
      xQueueReset(bleMessageQueue);
    }
    currentBleMessageActive = false;
    currentBleMessageOffset = 0;
    snifferStartRequested = false;
    snifferStartAtMs = 0;
  }

  void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override {
    bleConnected = false;
    if (bleMessageQueue != nullptr) {
      xQueueReset(bleMessageQueue);
    }
    currentBleMessageActive = false;
    currentBleMessageOffset = 0;
    snifferStartRequested = false;
    snifferStartAtMs = 0;
    stopSniffer();
    clusterScanActive = false;
    enterClusterControlWindow(millis());
    broadcastClusterState(CLUSTER_STOP);
    clusterGateway = false;
  }
};

static bool processOtaCommand(const String &command, const String &lowerCommand) {
  if (lowerCommand == "oc" || lowerCommand == "ota-clear") {
    resetOtaConfig();
    emitOtaStatus("ready", "OTA fields cleared");
    return true;
  }

  if (lowerCommand.startsWith("os:")) {
    if (!appendHexBytes(otaSsid, command.substring(3), 32)) {
      emitOtaStatus("error", "Invalid SSID chunk");
    } else {
      emitOtaStatus("staging", "SSID received");
    }
    return true;
  }

  if (lowerCommand.startsWith("op:")) {
    if (!appendHexBytes(otaPassword, command.substring(3), 64)) {
      emitOtaStatus("error", "Invalid password chunk");
    } else {
      emitOtaStatus("staging", "Password received");
    }
    return true;
  }

  if (lowerCommand.startsWith("oh:")) {
    if (!appendHexText(otaExpectedSha256, command.substring(3), 64)) {
      emitOtaStatus("error", "Invalid SHA-256 chunk");
    } else {
      emitOtaStatus("staging", "Hash received");
    }
    return true;
  }

  if (lowerCommand.startsWith("ov:")) {
    otaTargetVersion = command.substring(3);
    otaTargetVersion.trim();
    if (otaTargetVersion.length() > 24) {
      otaTargetVersion = otaTargetVersion.substring(0, 24);
    }
    emitOtaStatus("staging", "Target version received");
    return true;
  }

  if (lowerCommand.startsWith("oz:")) {
    otaExpectedBytes = static_cast<uint32_t>(command.substring(3).toInt());
    emitOtaStatus("staging", "Size received");
    return true;
  }

  if (lowerCommand == "ou" || lowerCommand == "ota-start") {
    if (otaSsid.length() == 0) {
      emitOtaStatus("error", "Missing Wi-Fi SSID");
      return true;
    }
    if (otaExpectedSha256.length() != 64) {
      emitOtaStatus("error", "Missing firmware SHA-256");
      return true;
    }
    if (otaExpectedBytes == 0) {
      emitOtaStatus("error", "Missing firmware size");
      return true;
    }
    if (otaInProgress) {
      emitOtaStatus("busy", "OTA already running");
      return true;
    }

    otaStartRequested = true;
    emitOtaStatus("queued", "OTA queued");
    return true;
  }

  return false;
}

static bool processSignatureCommand(const String &command,
                                    const String &lowerCommand) {
  if (lowerCommand == "sc" || lowerCommand == "signatures-clear") {
    resetStagedSignatures();
    emitSignatureStatus("ready", "Signature staging cleared", stagedSignatureCount);
    return true;
  }

  if (lowerCommand.startsWith("sv:")) {
    String version = command.substring(3);
    version.trim();
    if (version.length() > 24) {
      version = version.substring(0, 24);
    }
    strlcpy(stagedSignatureVersion, version.c_str(), sizeof(stagedSignatureVersion));
    emitSignatureStatus("staging", "Signature version received",
                        stagedSignatureCount);
    return true;
  }

  if (lowerCommand.startsWith("sp:")) {
    if (stagedSignatureCount >= MAX_DYNAMIC_SIGNATURES) {
      emitSignatureStatus("error", "Signature staging table full",
                          stagedSignatureCount);
      return true;
    }

    const String payload = lowerCommand.substring(3);
    const int separator = payload.indexOf(':');
    if (separator != 6) {
      emitSignatureStatus("error", "Invalid signature prefix",
                          stagedSignatureCount);
      return true;
    }

    uint8_t prefix[3] = {};
    if (!parseCompactPrefix(payload.substring(0, 6), prefix)) {
      emitSignatureStatus("error", "Invalid signature hex",
                          stagedSignatureCount);
      return true;
    }

    for (size_t i = 0; i < stagedSignatureCount; i++) {
      if (signatureEntryEquals(stagedSignatures[i], prefix)) {
        emitSignatureStatus("staging", "Duplicate prefix ignored",
                            stagedSignatureCount);
        return true;
      }
    }

    const bool allowLocalAdministered = payload.substring(separator + 1).toInt() == 1;
    OuiSignature &slot = stagedSignatures[stagedSignatureCount++];
    memcpy(slot.bytes, prefix, sizeof(slot.bytes));
    slot.allowLocalAdministered = allowLocalAdministered;
    slot.label = allowLocalAdministered ? "flock-wifi-wildcard" : "flock-wifi";
    emitSignatureStatus("staging", "Prefix received", stagedSignatureCount);
    return true;
  }

  if (lowerCommand == "sf" || lowerCommand == "signatures-apply") {
    if (stagedSignatureCount == 0) {
      emitSignatureStatus("error", "No staged signatures", stagedSignatureCount);
      return true;
    }
    signatureApplyRequested = true;
    emitSignatureStatus("queued", "Signature set queued", stagedSignatureCount);
    return true;
  }

  return false;
}

static void applyStagedSignatures() {
  signatureApplyRequested = false;
  if (stagedSignatureCount == 0) {
    emitSignatureStatus("error", "No staged signatures", activeSignatureCount());
    return;
  }

  const bool resumeSniffer = wifiSnifferActive && bleConnected;
  if (resumeSniffer) {
    stopSniffer();
  }

  memcpy(dynamicSignatures, stagedSignatures,
         stagedSignatureCount * sizeof(stagedSignatures[0]));
  dynamicSignatureCount = stagedSignatureCount;
  if (stagedSignatureVersion[0] == '\0') {
    strlcpy(dynamicSignatureVersion, "synced", sizeof(dynamicSignatureVersion));
  } else {
    strlcpy(dynamicSignatureVersion, stagedSignatureVersion,
            sizeof(dynamicSignatureVersion));
  }

  saveDynamicSignatures();
  resetStagedSignatures();
  if (resumeSniffer) {
    setupSniffer();
  }
  emitSignatureStatus("active", "Signature set updated", dynamicSignatureCount);
  emitStatus("signatures-updated");
}

static void performOtaUpdate() {
  otaStartRequested = false;
  otaInProgress = true;
  stopSniffer();
  if (clusterRadioReady) {
    esp_now_deinit();
    clusterRadioReady = false;
  }
  emitOtaStatus("wifi", "Joining Wi-Fi", 2);

  HTTPClient http;
  WiFiClientSecure client;
  mbedtls_sha256_context shaContext;
  bool shaInitialized = false;
  bool shaStarted = false;
  String failure;
  size_t written = 0;
  int lastProgress = -1;
  uint32_t lastReadMs = millis();
  uint8_t hash[32] = {};

  if (!String(ROADLENS_OTA_URL).startsWith("https://its-ze.github.io/roadlens-scout/")) {
    failure = "Firmware URL is not RoadLens Pages";
    goto ota_cleanup;
  }

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, false);
  delay(150);
  WiFi.begin(otaSsid.c_str(), otaPassword.c_str());

  {
    const uint32_t startedMs = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - startedMs < OTA_WIFI_TIMEOUT_MS) {
      delay(250);
    }
  }

  if (WiFi.status() != WL_CONNECTED) {
    failure = "Wi-Fi join timed out";
    goto ota_cleanup;
  }

  emitOtaStatus("download", "Downloading firmware", 8);
  client.setInsecure();
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(15000);
  if (!http.begin(client, ROADLENS_OTA_URL)) {
    failure = "Could not open firmware URL";
    goto ota_cleanup;
  }

  {
    const int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
      failure = "Firmware download HTTP " + String(httpCode);
      goto ota_cleanup;
    }
  }

  {
    const int contentLength = http.getSize();
    if (contentLength <= 0) {
      failure = "Firmware size is unknown";
      goto ota_cleanup;
    }
    if (static_cast<uint32_t>(contentLength) != otaExpectedBytes) {
      failure = "Firmware size mismatch";
      goto ota_cleanup;
    }
    if (!Update.begin(contentLength)) {
      failure = "OTA partition is not ready";
      goto ota_cleanup;
    }

    mbedtls_sha256_init(&shaContext);
    shaInitialized = true;
    if (mbedtls_sha256_starts_ret(&shaContext, 0) != 0) {
      failure = "SHA-256 setup failed";
      goto ota_cleanup;
    }
    shaStarted = true;

    WiFiClient *stream = http.getStreamPtr();
    uint8_t buffer[2048];
    while (written < static_cast<size_t>(contentLength)) {
      const size_t available = stream->available();
      if (available == 0) {
        if (millis() - lastReadMs > OTA_HTTP_IDLE_TIMEOUT_MS) {
          failure = "Firmware download stalled";
          goto ota_cleanup;
        }
        delay(10);
        continue;
      }

      const size_t wanted = min(available, sizeof(buffer));
      const int read = stream->readBytes(buffer, wanted);
      if (read <= 0) {
        delay(2);
        continue;
      }

      lastReadMs = millis();
      mbedtls_sha256_update_ret(&shaContext, buffer, read);
      if (Update.write(buffer, read) != static_cast<size_t>(read)) {
        failure = "Flash write failed";
        goto ota_cleanup;
      }

      written += static_cast<size_t>(read);
      const int progress = static_cast<int>((written * 100) / contentLength);
      if (progress >= lastProgress + 10 || progress >= 99) {
        lastProgress = progress;
        emitOtaStatus("download", "Downloading firmware", progress);
      }
      delay(1);
    }
  }

  if (shaStarted && mbedtls_sha256_finish_ret(&shaContext, hash) != 0) {
    failure = "SHA-256 finish failed";
    goto ota_cleanup;
  }
  shaStarted = false;

  if (!sha256Hex(hash).equalsIgnoreCase(otaExpectedSha256)) {
    failure = "Firmware SHA-256 mismatch";
    goto ota_cleanup;
  }

  emitOtaStatus("verify", "Firmware hash verified", 100);
  if (!Update.end(true)) {
    failure = "OTA finalize failed";
    goto ota_cleanup;
  }

  emitOtaStatus("rebooting", "Firmware installed; rebooting", 100);
  restartPending = true;
  restartAtMs = millis() + 1200;

ota_cleanup:
  if (shaInitialized) {
    mbedtls_sha256_free(&shaContext);
  }
  if (failure.length() > 0) {
    Update.abort();
    emitOtaStatus("error", failure);
  }
  http.end();
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  resetOtaConfig();
  otaInProgress = false;
  setupClusterRadio();
  if (failure.length() > 0 && bleConnected && snifferStartRequested) {
    setupSniffer();
  }
}

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &) override {
    std::string value = characteristic->getValue();
    if (value.empty()) {
      return;
    }

    String command(value.c_str());
    command.trim();
    String lowerCommand = command;
    lowerCommand.toLowerCase();

    if (lowerCommand == "ping") {
      emitLine("{\"type\":\"pong\"}\n");
    } else if (lowerCommand == "status") {
      emitStatus("command");
    } else if (lowerCommand == "start-scan") {
      snifferStartRequested = true;
      snifferStartAtMs = millis() + 1200;
      clusterScanActive = true;
      enterClusterControlWindow(millis());
      emitStatus("scan-starting");
    } else if (lowerCommand == "stop-scan") {
      snifferStartRequested = false;
      snifferStartAtMs = 0;
      stopSniffer();
      clusterScanActive = false;
      enterClusterControlWindow(millis());
      broadcastClusterState(CLUSTER_STOP);
      emitStatus("scan-stopped");
    } else if (lowerCommand == "reset-counts") {
      detectionCount = 0;
      wifiFramesSeen = 0;
      mgmtFramesSeen = 0;
      dataFramesSeen = 0;
      wildcardProbesSeen = 0;
      candidateFramesSeen = 0;
      queueDrops = 0;
      memset(seenEntries, 0, sizeof(seenEntries));
      emitStatus("counts-reset");
    } else if (processSignatureCommand(command, lowerCommand)) {
      return;
    } else if (processOtaCommand(command, lowerCommand)) {
      return;
    } else {
      emitStatus("unknown-command");
    }
  }
};

static void setupBle() {
  const uint32_t shortId = static_cast<uint32_t>(ESP.getEfuseMac() & 0xFFFFFFULL);
  snprintf(deviceName, sizeof(deviceName), "RoadLens-%06lX", static_cast<unsigned long>(shortId));
  NimBLEDevice::init(deviceName);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  server->advertiseOnDisconnect(true);

  NimBLEService *service = server->createService(SERVICE_UUID);
  notifyCharacteristic = service->createCharacteristic(
      NOTIFY_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  notifyCharacteristic->setValue("RoadLens Scout ready\n");

  NimBLECharacteristic *commandCharacteristic = service->createCharacteristic(
      COMMAND_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  commandCharacteristic->setCallbacks(new CommandCallbacks());

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  NimBLEAdvertisementData scanResponse;
  scanResponse.setName(deviceName);
  advertising->setScanResponseData(scanResponse);
  advertising->enableScanResponse(true);
  advertising->start();
}

static void stopSniffer() {
  if (!wifiSnifferActive) {
    return;
  }

  esp_wifi_set_promiscuous(false);
  esp_wifi_set_promiscuous_rx_cb(nullptr);
  wifiSnifferActive = false;
  if (clusterRadioReady) {
    setRadioChannel(CLUSTER_CONTROL_CHANNEL);
    clusterControlWindow = true;
  }
}

static void setupSniffer() {
  if (wifiSnifferActive) {
    return;
  }

  if (!clusterRadioReady) {
    setupClusterRadio();
  }

  wifi_promiscuous_filter_t filter = {};
  filter.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA;

  esp_wifi_set_promiscuous(false);
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(&snifferCallback);
  setRadioChannel(clusterControlWindow ? CLUSTER_CONTROL_CHANNEL : CHANNELS[channelIndex]);
  esp_wifi_set_promiscuous(true);
  wifiSnifferActive = true;
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.begin(115200);
  delay(250);

  loadDynamicSignatures();
  detectionQueue = xQueueCreate(24, sizeof(DetectionEvent));
  bleMessageQueue = xQueueCreate(BLE_MESSAGE_QUEUE_LENGTH, sizeof(BleMessage));
  clusterRxQueue = xQueueCreate(24, sizeof(ClusterPacket));
  setupClusterRadio();
  setupBle();
  emitStatus("boot");
}

void loop() {
  const uint32_t nowMs = millis();

  if (restartPending && static_cast<int32_t>(nowMs - restartAtMs) >= 0) {
    ESP.restart();
  }

  if (otaStartRequested && !otaInProgress) {
    performOtaUpdate();
  }

  if (bleConnected && snifferStartRequested && !wifiSnifferActive && !otaInProgress &&
      static_cast<int32_t>(nowMs - snifferStartAtMs) >= 0) {
    setupSniffer();
    emitStatus("scan-started");
  }

  if (signatureApplyRequested) {
    applyStagedSignatures();
  }

  drainBleNotifications(nowMs);

  DetectionEvent event = {};
  size_t drainedDetections = 0;
  while (detectionQueue != nullptr && drainedDetections < 6 &&
         xQueueReceive(detectionQueue, &event, 0) == pdTRUE) {
    if (clusterGateway) {
      emitDetection(event);
    } else if (clusterControlWindow && clusterLeaderLastSeenMs > 0) {
      sendClusterDetection(event);
      delay(4);
    } else {
      if (xQueueSendToFront(detectionQueue, &event, 0) != pdTRUE) {
        queueDrops++;
      }
      break;
    }
    drainedDetections++;
  }

  serviceCluster(nowMs);

  if (wifiSnifferActive && !clusterControlWindow &&
      nowMs - lastChannelHopMs >= CHANNEL_DWELL_MS) {
    channelIndex = (channelIndex + CLUSTER_SCAN_LANES) %
                   (sizeof(CHANNELS) / sizeof(CHANNELS[0]));
    setRadioChannel(CHANNELS[channelIndex]);
    lastChannelHopMs = nowMs;
  }

  if (nowMs - lastStatusMs >= STATUS_INTERVAL_MS) {
    emitStatus("heartbeat");
    lastStatusMs = nowMs;
  }

  delay(5);
}
