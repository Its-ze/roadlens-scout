#include <Arduino.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <esp_wifi.h>

#include "signatures.h"

static constexpr char DEVICE_NAME[] = "RoadLensESP32";
static constexpr char SERVICE_UUID[] = "7d1d0001-52a1-4b81-9fd2-fd7ec3f501000";
static constexpr char NOTIFY_UUID[] = "7d1d0002-52a1-4b81-9fd2-fd7ec3f501000";
static constexpr char COMMAND_UUID[] = "7d1d0003-52a1-4b81-9fd2-fd7ec3f501000";

static constexpr uint8_t LED_PIN = 2;
static constexpr uint32_t CHANNEL_DWELL_MS = 350;
static constexpr uint32_t DUPLICATE_SUPPRESS_MS = 15000;
static constexpr uint32_t STATUS_INTERVAL_MS = 5000;
static const uint8_t CHANNELS[] = {1, 6, 11};

struct DetectionEvent {
  char mac[18];
  char role[8];
  char label[24];
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
  char role[8];
  uint32_t lastSeenMs;
  bool used;
};

static QueueHandle_t detectionQueue = nullptr;
static NimBLECharacteristic *notifyCharacteristic = nullptr;
static bool bleConnected = false;
static bool wifiSnifferActive = false;
static uint8_t channelIndex = 0;
static uint32_t lastChannelHopMs = 0;
static uint32_t lastStatusMs = 0;
static uint32_t detectionCount = 0;
static SeenEntry seenEntries[24] = {};

static void setupSniffer();
static void stopSniffer();

static void formatMac(const uint8_t *mac, char *out, size_t outLen) {
  snprintf(out, outLen, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1],
           mac[2], mac[3], mac[4], mac[5]);
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
                           uint8_t frameSubtype, bool wildcardProbe) {
  const uint32_t nowMs = millis();
  if (!signature || shouldSuppress(mac, role, nowMs) || detectionQueue == nullptr) {
    return;
  }

  DetectionEvent event = {};
  formatMac(mac, event.mac, sizeof(event.mac));
  strlcpy(event.role, role, sizeof(event.role));
  strlcpy(event.label, signature->label, sizeof(event.label));
  event.rssi = rssi;
  event.channel = channel;
  event.frameType = frameType;
  event.frameSubtype = frameSubtype;
  event.wildcardProbe = wildcardProbe;
  event.uptimeMs = nowMs;

  if (wildcardProbe && strcmp(role, "addr2") == 0) {
    event.confidence = 96;
  } else if (strcmp(role, "addr2") == 0) {
    event.confidence = 82;
  } else if (strcmp(role, "addr1") == 0) {
    event.confidence = 70;
  } else {
    event.confidence = 62;
  }

  xQueueSend(detectionQueue, &event, 0);
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

  const bool wildcardProbe =
      wildcardSsidProbe(payload, len, frameType, frameSubtype);
  const uint8_t *addr1 = payload + 4;
  const uint8_t *addr2 = payload + 10;
  const uint8_t *addr3 = payload + 16;
  const int8_t rssi = packet->rx_ctrl.rssi;
  const uint8_t channel = packet->rx_ctrl.channel;

  queueDetection(addr2, "addr2", matchFlockOui(addr2), rssi, channel, frameType,
                 frameSubtype, wildcardProbe);
  queueDetection(addr1, "addr1", matchFlockOui(addr1), rssi, channel, frameType,
                 frameSubtype, false);
  if (frameType == 0) {
    queueDetection(addr3, "addr3", matchFlockOui(addr3), rssi, channel,
                   frameType, frameSubtype, false);
  }
}

static void emitLine(const String &line) {
  Serial.print(line);
  if (bleConnected && notifyCharacteristic != nullptr) {
    notifyCharacteristic->setValue(reinterpret_cast<const uint8_t *>(line.c_str()),
                                   line.length());
    notifyCharacteristic->notify();
  }
}

static void emitStatus(const char *reason) {
  char json[240];
  snprintf(json, sizeof(json),
           "{\"type\":\"status\",\"device\":\"%s\",\"reason\":\"%s\","
           "\"uptime_ms\":%lu,\"channel\":%u,\"detections\":%lu,"
           "\"signature_count\":%u,\"ble_connected\":%s}\n",
           DEVICE_NAME, reason, static_cast<unsigned long>(millis()),
           CHANNELS[channelIndex], static_cast<unsigned long>(detectionCount),
           static_cast<unsigned>(FLOCK_WIFI_OUI_COUNT),
           bleConnected ? "true" : "false");
  emitLine(String(json));
}

static void emitDetection(const DetectionEvent &event) {
  detectionCount++;
  digitalWrite(LED_PIN, HIGH);

  char json[320];
  snprintf(json, sizeof(json),
           "{\"type\":\"detection\",\"source\":\"wifi\",\"detector\":\"%s\","
           "\"mac\":\"%s\",\"role\":\"%s\",\"label\":\"%s\","
           "\"rssi\":%d,\"channel\":%u,\"frame_type\":%u,"
           "\"frame_subtype\":%u,\"wildcard_probe\":%s,"
           "\"confidence\":%u,\"uptime_ms\":%lu}\n",
           DEVICE_NAME, event.mac, event.role, event.label, event.rssi,
           event.channel, event.frameType, event.frameSubtype,
           event.wildcardProbe ? "true" : "false", event.confidence,
           static_cast<unsigned long>(event.uptimeMs));
  emitLine(String(json));

  delay(18);
  digitalWrite(LED_PIN, LOW);
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *) override {
    bleConnected = true;
    setupSniffer();
    emitStatus("ble-connected");
  }

  void onDisconnect(NimBLEServer *) override {
    bleConnected = false;
    stopSniffer();
    NimBLEDevice::startAdvertising();
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *characteristic) override {
    std::string value = characteristic->getValue();
    if (value.empty()) {
      return;
    }

    String command(value.c_str());
    command.trim();
    command.toLowerCase();

    if (command == "ping") {
      emitStatus("pong");
    } else if (command == "status") {
      emitStatus("command");
    } else if (command == "reset-counts") {
      detectionCount = 0;
      memset(seenEntries, 0, sizeof(seenEntries));
      emitStatus("counts-reset");
    } else {
      emitStatus("unknown-command");
    }
  }
};

static void setupBle() {
  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService *service = server->createService(SERVICE_UUID);
  notifyCharacteristic = service->createCharacteristic(
      NOTIFY_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  notifyCharacteristic->setValue("RoadLens Scout ready\n");

  NimBLECharacteristic *commandCharacteristic = service->createCharacteristic(
      COMMAND_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  commandCharacteristic->setCallbacks(new CommandCallbacks());

  service->start();

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setName(DEVICE_NAME);
  advertising->setScanResponse(true);
  advertising->start();
}

static void stopSniffer() {
  if (!wifiSnifferActive) {
    return;
  }

  esp_wifi_set_promiscuous(false);
  esp_wifi_set_promiscuous_rx_cb(nullptr);
  WiFi.disconnect(true, true);
  WiFi.mode(WIFI_OFF);
  wifiSnifferActive = false;
}

static void setupSniffer() {
  if (wifiSnifferActive) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);

  wifi_promiscuous_filter_t filter = {};
  filter.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA;

  esp_wifi_set_promiscuous(false);
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(&snifferCallback);
  esp_wifi_set_channel(CHANNELS[channelIndex], WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(true);
  wifiSnifferActive = true;
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.begin(115200);
  delay(250);

  detectionQueue = xQueueCreate(24, sizeof(DetectionEvent));
  setupBle();
  emitStatus("boot");
}

void loop() {
  const uint32_t nowMs = millis();

  if (wifiSnifferActive && nowMs - lastChannelHopMs >= CHANNEL_DWELL_MS) {
    channelIndex = (channelIndex + 1) % (sizeof(CHANNELS) / sizeof(CHANNELS[0]));
    esp_wifi_set_channel(CHANNELS[channelIndex], WIFI_SECOND_CHAN_NONE);
    lastChannelHopMs = nowMs;
  }

  DetectionEvent event = {};
  while (detectionQueue != nullptr &&
         xQueueReceive(detectionQueue, &event, 0) == pdTRUE) {
    emitDetection(event);
  }

  if (nowMs - lastStatusMs >= STATUS_INTERVAL_MS) {
    emitStatus("heartbeat");
    lastStatusMs = nowMs;
  }

  delay(5);
}
