# RoadLens Scout

RoadLens Scout is a passive ESP32 sensor plus Android mapping app for spotting Flock-style ALPR wireless signals and saving GPS-tagged sightings to a local map.

The app keeps raw sightings and also computes smart likely points. When repeat sightings land in the same general area, RoadLens weights phone GPS accuracy, detection confidence, and ESP32 RSSI so the map marker moves toward the strongest likely camera point instead of stacking duplicate pins.

## Project Layout

- `firmware/` - PlatformIO ESP32 firmware.
- `app/` - Capacitor Android app source.
- `web/flasher/` - local ESP Web Tools flasher page.
- `assets/brand/` - shared RoadLens logo source.
- `scripts/` - build, flash, preview, and APK helper scripts.
- `docs/` - research notes and BLE/serial protocol.

## Branding Assets

Regenerate the app icon, splash screens, web logo, and Pages logo:

```powershell
python .\scripts\generate-brand-assets.py
```

The generator uses `assets\brand\roadlens-mark.svg` as the source of truth and writes Android launcher/splash PNGs plus web-facing SVG copies.

## Build Firmware

```powershell
.\scripts\build-firmware.ps1
```

That compiles the verified BLE sensor targets and copies the browser-flasher binaries into `web\flasher\firmware`.

Published sensor builds:

- `esp32dev` -> ESP32 / ESP32-WROOM / ESP32-WROVER
- `esp32s3` -> ESP32-S3
- `esp32c3` -> ESP32-C3

The ESP Web Tools manifest auto-detects the connected chip family and selects the matching build. ESP32-S2 has no Bluetooth, and ESP32-C6/H2/P4 are not published by this Arduino firmware package yet.

## Flash ESP32

Browser flasher:

```powershell
.\scripts\start-flasher.ps1
```

Then open `http://127.0.0.1:8787/` in Chrome or Edge.

USB upload:

```powershell
.\scripts\flash-firmware.ps1 -Port COM15
```

Replace `COM15` with the live ESP32 port.

After flashing, reset or power-cycle the board and look for the BLE device name
`RoadLensESP32` from the Android app. Firmware `0.1.7` keeps Wi-Fi monitor mode
off until the phone connects, so the ESP32 advertises over Bluetooth first and
then starts passive detection after the app is linked. It scans 2.4 GHz channels
1-11, reports raw frame counters in app status, and matches the current 42-prefix
public Flock Wi-Fi signature set.

For a specific USB-upload target:

```powershell
.\scripts\flash-firmware.ps1 -Port COM15 -Environment esp32s3
.\scripts\flash-firmware.ps1 -Port COM15 -Environment esp32c3
```

## Android App

Install dependencies and run the web preview:

```powershell
cd app
npm install
npm run dev
```

Build APK when JDK 21+ and Android SDK are installed:

```powershell
.\scripts\build-apk.ps1
```

If this machine still lacks Java/Android SDK, run:

```powershell
.\scripts\bootstrap-android-tooling.ps1
```

Then apply the printed environment variables in the same shell and rerun the APK build.

### Phone USB Setup

The Android app has a `Setup` tab for a phone-plugged ESP32. It detects USB-OTG
serial devices such as Espressif native USB, CP210x, CH34x, and FTDI bridges,
requests Android USB permission, and opens the RoadLens flasher with the device
context. After flashing, return to the app and use `Connect` to link to
`RoadLensESP32`; while linked, the same button becomes `Disconnect`.

The `Setup` tab also has `BLE Sweep`. It runs a short phone-side BLE scan for
known Flock-style BLE names, manufacturer IDs, and MAC prefixes, then saves any
matches to the same GPS-tagged map as ESP32 Wi-Fi hits.

### Sensor OTA Updates

Firmware `0.1.7` adds in-app ESP32 firmware updates after the board has been
flashed once by USB or the web flasher. When the app connects to a sensor, it
reads the sensor firmware version and chip family, checks RoadLens Pages
metadata, and prompts if a newer matching firmware build is available.

Android cannot expose the phone's saved Wi-Fi password to apps. The Setup tab
can request location/Wi-Fi access to prefill the current SSID when Android
allows it, but the Wi-Fi password must be typed into the app. The app sends the
SSID/password and expected firmware SHA256 to the ESP32 over BLE using compact
staged commands; the ESP32 joins Wi-Fi, downloads its chip-specific firmware
from RoadLens Pages, verifies SHA256, writes OTA flash, and reboots.

## In-App GitHub Updates

The Android app has an `Update` button. It checks the latest GitHub release for the configured repo, finds the best `.apk` asset, compares the release tag/name version against the installed app version, downloads the APK, and opens Android's installer.

Default update repo:

```text
Its-ze/roadlens-scout
```

Override it at build time:

```powershell
$env:VITE_UPDATE_REPO = "Its-ze/roadlens-scout"
.\scripts\build-apk.ps1
```

Release requirements:

- Create a GitHub release with a tag containing a semantic version, such as `v0.1.1`.
- Attach an APK asset, preferably named like `roadlens-scout-v0.1.1.apk`.
- The APK must use the same Android package id and signing key as the installed app, or Android will treat it as a different/incompatible install.
- Android requires the user to allow installs from this app and approve the installer prompt; self-updates cannot be silent.

## GitHub Pages

The `docs/` folder is a Pages-ready static site. It includes:

- Root page with auto-detected ESP32-family flashing and `Download APK` buttons.
- ESP Web Tools flasher copied to `docs/flasher/`.
- Android APK metadata and download link pointed at the matching GitHub release asset.
- `docs/site-meta.json` and `docs/downloads/checksums.txt`, including per-chip firmware hashes.

Refresh Pages artifacts after firmware or APK changes:

```powershell
.\scripts\build-firmware.ps1
.\scripts\build-apk.ps1
.\scripts\build-pages.ps1
```

In GitHub, set Pages source to the `docs/` folder on the default branch.

## Notes

This is a passive receive-only mapper. Detection depends on whether a camera emits matching Wi-Fi/BLE side signals while the ESP32 is nearby, so missed detections are expected.
