# Firmware Protocol

The ESP32 advertises as `RoadLensESP32`.

Firmware `0.1.11` starts in BLE-first mode: it advertises `RoadLensESP32`
without running Wi-Fi promiscuous scanning, then starts passive Wi-Fi detection
only after the phone has connected, subscribed to notifications, and sent
`start-scan`. If Android times out the first command write, the firmware
auto-starts scanning after a short connect delay. On disconnect, Wi-Fi monitor
mode is stopped and BLE advertising restarts.

Firmware `0.1.11` scans 2.4 GHz channels 1-11, uses the public Flock-style
Wi-Fi signature set, and reports raw scan counters so the app can distinguish
"no match" from "not seeing frames." It also accepts an app-synced signature
feed and stores it in ESP32 preferences, falling back to the built-in set when
no synced feed exists.

Firmware `0.1.11` also supports BLE-orchestrated OTA updates. The app sends Wi-Fi
credentials and the expected firmware size/SHA256 in compact staged commands.
The ESP32 downloads its chip-specific firmware from RoadLens Pages, verifies the
SHA256 before finalizing the update, and reboots after success.

Published browser-flasher builds support ESP32 / ESP32-WROOM / ESP32-WROVER, ESP32-S3, and ESP32-C3. The ESP Web Tools manifest auto-detects the chip family and selects the matching image. ESP32-S2 cannot work as a RoadLens phone sensor because it has no Bluetooth; ESP32-C6/H2/P4 builds are not published by this Arduino firmware package yet.

BLE service:

- Service: `7d1d0001-52a1-4b81-9fd2-fd7ec3f50100`
- Notify/read characteristic: `7d1d0002-52a1-4b81-9fd2-fd7ec3f50100`
- Command/write characteristic: `7d1d0003-52a1-4b81-9fd2-fd7ec3f50100`

The notify characteristic emits newline-delimited JSON. The same JSON is printed to serial at `115200`.

Detection example:

```json
{"type":"detection","source":"wifi","detector":"RoadLensESP32","mac":"70:c9:4e:00:00:00","role":"addr2","label":"flock-wifi","rssi":-71,"channel":6,"frame_type":0,"frame_subtype":4,"wildcard_probe":true,"confidence":96,"uptime_ms":123456}
```

Status example:

```json
{"type":"status","device":"RoadLensESP32","reason":"heartbeat","uptime_ms":123456,"channel":6,"detections":3,"signature_count":42,"ble_connected":true,"sniffer_active":true,"frames_seen":1800,"mgmt_frames":700,"data_frames":1100,"wildcard_probes":8,"candidate_frames":3,"queue_drops":0,"firmware_version":"0.1.11","chip_family":"ESP32","ota_supported":true,"ota_in_progress":false,"ota_version":"","signature_version":"2026.06.24.209126de","signature_source":"synced","signature_sync_supported":true}
```

OTA status example:

```json
{"type":"ota","state":"download","detail":"Downloading firmware","progress":50,"version":"0.1.11","chip_family":"ESP32"}
```

Signature status example:

```json
{"type":"signatures","state":"active","detail":"Signature set updated","count":42,"version":"2026.06.24.209126de"}
```

Commands:

- `ping`
- `status`
- `start-scan` starts Wi-Fi promiscuous detection after BLE notifications are active
- `stop-scan` stops Wi-Fi promiscuous detection while keeping BLE connected
- `reset-counts`
- `oc` clears staged OTA fields
- `os:<hex>` appends UTF-8 SSID bytes
- `op:<hex>` appends UTF-8 password bytes
- `oh:<hex>` appends expected firmware SHA256 text
- `ov:<version>` stages the target firmware version
- `oz:<bytes>` stages the expected firmware byte count
- `ou` starts OTA after staged fields are valid
- `sc` clears staged signature prefixes
- `sv:<version>` stages a compact signature feed version
- `sp:<6hex>:<0|1>` stages one three-byte Wi-Fi prefix and whether local-administered MACs are allowed
- `sf` applies the staged signature feed and saves it to ESP32 preferences
