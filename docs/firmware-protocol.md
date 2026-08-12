# Firmware Protocol

Each ESP32 advertises with a hardware-derived name such as `RoadLens-57E298`.

Firmware `0.1.20` starts as an ESP-NOW cluster worker on control channel 6. The
Android app automatically connects to one nearby RoadLens device; that device
becomes the gateway and coordinates up to seven workers. `start-scan` opens a
repeating control window, assigns deterministic staggered scan lanes, and pools
worker detections through the gateway BLE connection. On gateway disconnect or
timeout, workers stop scanning and return to control-channel discovery.

Outgoing JSON records are queued and sent as paced notifications capped at 220
bytes. Firmware `0.1.20` uses compact field names so normal records fit in one
notification; the app accepts both compact and legacy verbose records.

The `ping` command returns the compact `{"type":"pong"}` record and can be used
to verify notification delivery before starting the Wi-Fi monitor.

Firmware `0.1.20` scans 2.4 GHz channels 1-11, uses the public Flock-style
Wi-Fi signature set, detects empty probe requests, and parses Wi-Fi management
SSIDs for Flock-style provisioning/battery/module names. It reports raw scan
counters so the app can distinguish "no match" from "not seeing frames." It
also accepts an app-synced signature feed and stores it in ESP32 preferences,
falling back to the built-in set when no synced feed exists.

Firmware `0.1.20` also supports BLE-orchestrated OTA updates. The app sends Wi-Fi
credentials and the expected firmware size/SHA256 in compact staged commands.
The ESP32 downloads its chip-specific firmware from RoadLens Pages, verifies the
SHA256 before finalizing the update, and reboots after success.

Published browser-flasher builds support ESP32 / ESP32-WROOM / ESP32-WROVER, ESP32-S3, and ESP32-C3. The ESP Web Tools manifest auto-detects the chip family and selects the matching image. ESP32-S2 cannot work as a RoadLens phone sensor because it has no Bluetooth; ESP32-C6/H2/P4 builds are not published by this Arduino firmware package yet.

The Android app also syncs `camera-seeds.json` from RoadLens Pages. That public
seed map stays app-side: the ESP32 continues to report raw radio detections,
while the phone links detections and field checks to nearby known camera seeds
using GPS.

BLE service:

- Service: `7d1d0001-52a1-4b81-9fd2-fd7ec3f50100`
- Notify/read characteristic: `7d1d0002-52a1-4b81-9fd2-fd7ec3f50100`
- Command/write characteristic: `7d1d0003-52a1-4b81-9fd2-fd7ec3f50100`

The notify characteristic emits newline-delimited JSON. The same JSON is printed to serial at `115200`.

Detection example:

```json
{"t":"d","m":"70:c9:4e:00:00:00","s":"Flock-ABC123","r":"ssid","l":"flock-wifi-ssid","p":-71,"c":6,"ft":0,"fs":4,"w":0,"q":88,"u":123456,"n":"57E298"}
```

Status is emitted as a core record followed by a metrics record. The app merges
both records for the corresponding sensor session:

```json
{"t":"s","d":"RoadLens-57E298","r":"heartbeat","u":123456,"c":6,"b":1,"a":1,"v":"0.1.20","h":"ESP32","o":1,"i":0,"ov":"","g":46,"sv":"2026.06.28.003ddaa1","ss":"synced","sy":1,"cr":"gateway","cn":3,"ci":"57E298","cl":0}
{"t":"m","n":3,"f":1800,"m":700,"x":1100,"w":8,"k":3,"q":0}
```

OTA status example:

```json
{"t":"o","s":"download","d":"Downloading firmware","p":50,"v":"0.1.20","c":"ESP32"}
```

Signature status example:

```json
{"t":"g","s":"active","d":"Signature set updated","n":46,"v":"2026.06.28.003ddaa1"}
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
