# Firmware Protocol

The ESP32 advertises as `RoadLensESP32`.

Firmware `0.1.3` starts in BLE-first mode: it advertises `RoadLensESP32`
without running Wi-Fi promiscuous scanning, then starts passive Wi-Fi detection
after the phone connects. On disconnect, Wi-Fi monitor mode is stopped and BLE
advertising restarts.

Published browser-flasher builds support ESP32 / ESP32-WROOM / ESP32-WROVER, ESP32-S3, and ESP32-C3. The ESP Web Tools manifest auto-detects the chip family and selects the matching image. ESP32-S2 cannot work as a RoadLens phone sensor because it has no Bluetooth; ESP32-C6/H2/P4 builds are not published by this Arduino firmware package yet.

BLE service:

- Service: `7d1d0001-52a1-4b81-9fd2-fd7ec3f501000`
- Notify/read characteristic: `7d1d0002-52a1-4b81-9fd2-fd7ec3f501000`
- Command/write characteristic: `7d1d0003-52a1-4b81-9fd2-fd7ec3f501000`

The notify characteristic emits newline-delimited JSON. The same JSON is printed to serial at `115200`.

Detection example:

```json
{"type":"detection","source":"wifi","detector":"RoadLensESP32","mac":"70:c9:4e:00:00:00","role":"addr2","label":"flock-wifi","rssi":-71,"channel":6,"frame_type":0,"frame_subtype":4,"wildcard_probe":true,"confidence":96,"uptime_ms":123456}
```

Status example:

```json
{"type":"status","device":"RoadLensESP32","reason":"heartbeat","uptime_ms":123456,"channel":6,"detections":3,"signature_count":31,"ble_connected":true}
```

Commands:

- `ping`
- `status`
- `reset-counts`
