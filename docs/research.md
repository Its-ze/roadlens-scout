# RoadLens Scout Research Notes

## What is detectable

Flock's own LPR product material describes the cameras as solar-powered and LTE-connected, so an ESP32 cannot reliably detect every camera by expecting a normal Wi-Fi access point. Treat RF detections as evidence that a compatible wireless side signal was nearby, not as proof that every unobserved camera is absent.

Current public ESP32 approaches use passive radio observation:

- Wi-Fi promiscuous mode against 2.4 GHz management/data frames.
- MAC OUI matching against a public research prefix list.
- Matching receiver address `addr1` as well as transmitter `addr2`, because sleeping stations may appear as the destination of nearby AP traffic.
- Tighter confidence when a matched transmitter sends wildcard probe requests.
- SSID parsing for probe/beacon/association management frames when public research names appear.
- BLE sniffing for some legacy/misconfigured setups or battery telemetry, as documented by ESP32Marauder's Flock Sniff page.

RoadLens Scout implements passive Wi-Fi detection on the ESP32 and phone-side BLE sweep detection in the Android app. The ESP32 reports raw scan counters so a field miss can be separated into "no matching signature" versus "no RF frames seen."

As of `0.1.13`, RoadLens generates `data/signatures.json` from public Flock-You, OUI-Spy, and detector-confidence sources. The feed currently contains 46 Wi-Fi/BLE prefixes, BLE name patterns, manufacturer ID `0x09C8`, Raven service UUIDs, and Wi-Fi SSID pattern detectors. The Android app loads the bundled feed, refreshes from RoadLens Pages when online, caches the last good feed locally, uses it for phone-side BLE sweeps, and syncs Wi-Fi prefixes into v0.1.8+ ESP32 sensors over BLE. Firmware stores the synced prefix feed in ESP32 preferences and falls back to its built-in list if no synced feed exists.

Firmware `0.1.13` parses Wi-Fi management tagged parameters for SSIDs. It treats `Flock-*` provisioning-style names as medium-confidence detections and records battery/module names such as `FS Ext Battery`, `Penguin`, and `Pigvision` when those appear as SSIDs. Direct Flock-assigned prefix `b4:1e:52`, wildcard empty-probe observations, BLE manufacturer ID `0x09C8`, and Raven service UUIDs are weighted higher in the app.

## Sources checked

- Flock product page: https://www.flocksafety.com/products/license-plate-readers
- Public Flock-You detector research and firmware: https://github.com/colonelpanichacks/flock-you
- Public flock-back notes on newer camera Wi-Fi probe detection: https://github.com/NSM-Barii/flock-back
- Public OUI-Spy unified BLE/OUI detector notes: https://github.com/colonelpanichacks/oui-spy-unified-blue
- Public OUI research list: https://raw.githubusercontent.com/colonelpanichacks/flock-you/HEAD/datasets/NitekryDPaul_wifi_ouis.md
- ESP32Marauder Flock Sniff notes: https://github.com/justcallmekoko/ESP32Marauder/wiki/Flock-Sniff
- ESP32Marauder Flock Wardrive notes: https://github.com/justcallmekoko/ESP32Marauder/wiki/Flock-Wardrive
- WiFiMothership detector confidence notes: https://wifimothership.com/flock
- WatchFlock passive detector notes: https://churchofmalware.org/tools/WatchFlock/
- Hackaday summary of ESP32 Flock-style detection: https://hackaday.com/2025/09/26/detecting-surveillance-cameras-with-the-esp32/
- Public teardown listing LTE, Wi-Fi/Bluetooth, GPS, and other components: https://www.cehrp.org/dissection-of-flock-safety-camera/

## Boundaries

This project is receive-only. It does not spoof camera infrastructure, transmit probe/deauth traffic, interfere with camera operation, or attempt to bypass access controls. Use it for lawful mapping of publicly visible infrastructure and keep exports free of unrelated private device data.
