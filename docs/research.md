# RoadLens Scout Research Notes

## What is detectable

Flock's own LPR product material describes the cameras as solar-powered and LTE-connected, so an ESP32 cannot reliably detect every camera by expecting a normal Wi-Fi access point. Treat RF detections as evidence that a compatible wireless side signal was nearby, not as proof that every unobserved camera is absent.

Current public ESP32 approaches use passive radio observation:

- Wi-Fi promiscuous mode against 2.4 GHz management/data frames.
- MAC OUI matching against a public research prefix list.
- Matching receiver address `addr1` as well as transmitter `addr2`, because sleeping stations may appear as the destination of nearby AP traffic.
- Tighter confidence when a matched transmitter sends wildcard probe requests.
- BLE sniffing for some legacy/misconfigured setups or battery telemetry, as documented by ESP32Marauder's Flock Sniff page.

RoadLens Scout implements the passive Wi-Fi path first and exposes detections to the phone over BLE. BLE-side Flock sniffing is left as the next firmware module because the BLE link is currently reserved for the phone connection.

## Sources checked

- Flock product page: https://www.flocksafety.com/products/license-plate-readers
- Public Flock-You detector research and firmware: https://github.com/colonelpanichacks/flock-you
- Public OUI research list: https://raw.githubusercontent.com/colonelpanichacks/flock-you/HEAD/datasets/NitekryDPaul_wifi_ouis.md
- ESP32Marauder Flock Sniff notes: https://github.com/justcallmekoko/ESP32Marauder/wiki/Flock-Sniff
- ESP32Marauder Flock Wardrive notes: https://github.com/justcallmekoko/ESP32Marauder/wiki/Flock-Wardrive
- Hackaday summary of ESP32 Flock-style detection: https://hackaday.com/2025/09/26/detecting-surveillance-cameras-with-the-esp32/
- Public teardown listing LTE, Wi-Fi/Bluetooth, GPS, and other components: https://www.cehrp.org/dissection-of-flock-safety-camera/

## Boundaries

This project is receive-only. It does not spoof camera infrastructure, transmit probe/deauth traffic, interfere with camera operation, or attempt to bypass access controls. Use it for lawful mapping of publicly visible infrastructure and keep exports free of unrelated private device data.
