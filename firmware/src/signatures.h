#pragma once

#include <Arduino.h>

struct OuiSignature {
  uint8_t bytes[3];
  const char *label;
  bool allowLocalAdministered;
};

// Public research signature set from:
// https://github.com/colonelpanichacks/flock-you
// https://github.com/colonelpanichacks/oui-spy-unified-blue
// Credit: NitekryDPaul for the base prefixes and April 2026 additions,
// DeFlockJoplin for 82:6b:f2. f8:a2:d6 is intentionally omitted because
// the current public notes mark it as a Sony media-player false positive.
static const OuiSignature FLOCK_WIFI_OUIS[] = {
    {{0x70, 0xc9, 0x4e}, "flock-wifi", false},
    {{0x3c, 0x91, 0x80}, "flock-wifi", false},
    {{0xd8, 0xf3, 0xbc}, "flock-wifi", false},
    {{0x80, 0x30, 0x49}, "flock-wifi", false},
    {{0xb8, 0x35, 0x32}, "flock-wifi", false},
    {{0x14, 0x5a, 0xfc}, "flock-wifi", false},
    {{0x74, 0x4c, 0xa1}, "flock-wifi", false},
    {{0x08, 0x3a, 0x88}, "flock-wifi", false},
    {{0x9c, 0x2f, 0x9d}, "flock-wifi", false},
    {{0xc0, 0x35, 0x32}, "flock-wifi", false},
    {{0x94, 0x08, 0x53}, "flock-wifi", false},
    {{0xe4, 0xaa, 0xea}, "flock-wifi", false},
    {{0xf4, 0x6a, 0xdd}, "flock-wifi", false},
    {{0x24, 0xb2, 0xb9}, "flock-wifi", false},
    {{0x00, 0xf4, 0x8d}, "flock-wifi", false},
    {{0xd0, 0x39, 0x57}, "flock-wifi", false},
    {{0xe8, 0xd0, 0xfc}, "flock-wifi", false},
    {{0xe0, 0x4f, 0x43}, "flock-wifi", false},
    {{0xb8, 0x1e, 0xa4}, "flock-wifi", false},
    {{0x70, 0x08, 0x94}, "flock-wifi", false},
    {{0x58, 0x8e, 0x81}, "flock-wifi", false},
    {{0xec, 0x1b, 0xbd}, "flock-wifi", false},
    {{0x3c, 0x71, 0xbf}, "flock-wifi", false},
    {{0x58, 0x00, 0xe3}, "flock-wifi", false},
    {{0x90, 0x35, 0xea}, "flock-wifi", false},
    {{0x5c, 0x93, 0xa2}, "flock-wifi", false},
    {{0x64, 0x6e, 0x69}, "flock-wifi", false},
    {{0x48, 0x27, 0xea}, "flock-wifi", false},
    {{0xa4, 0xcf, 0x12}, "flock-wifi", false},
    {{0x04, 0x0d, 0x84}, "flock-wifi", false},
    {{0xf0, 0x82, 0xc0}, "flock-wifi", false},
    {{0x1c, 0x34, 0xf1}, "flock-wifi", false},
    {{0x38, 0x5b, 0x44}, "flock-wifi", false},
    {{0x94, 0x34, 0x69}, "flock-wifi", false},
    {{0xb4, 0xe3, 0xf9}, "flock-wifi", false},
    {{0xb4, 0x1e, 0x52}, "flock-wifi", false},
    {{0x14, 0xb5, 0xcd}, "flock-wifi", false},
    {{0x94, 0x2a, 0x6f}, "flock-wifi", false},
    {{0xf4, 0xe2, 0xc6}, "flock-wifi", false},
    {{0xd4, 0x11, 0xd6}, "flock-wifi", false},
    {{0xe0, 0x0a, 0xf6}, "flock-wifi", false},
    {{0x82, 0x6b, 0xf2}, "flock-wifi-wildcard", true},
};

static constexpr size_t FLOCK_WIFI_OUI_COUNT =
    sizeof(FLOCK_WIFI_OUIS) / sizeof(FLOCK_WIFI_OUIS[0]);

inline bool isMulticastMac(const uint8_t *mac) {
  return (mac[0] & 0x01) != 0;
}

inline bool isLocalAdministeredMac(const uint8_t *mac) {
  return (mac[0] & 0x02) != 0;
}

inline const OuiSignature *matchFlockOui(const uint8_t *mac) {
  if (isMulticastMac(mac)) {
    return nullptr;
  }

  for (size_t i = 0; i < FLOCK_WIFI_OUI_COUNT; i++) {
    const OuiSignature *sig = &FLOCK_WIFI_OUIS[i];
    if (mac[0] == sig->bytes[0] && mac[1] == sig->bytes[1] &&
        mac[2] == sig->bytes[2]) {
      if (isLocalAdministeredMac(mac) && !sig->allowLocalAdministered) {
        return nullptr;
      }
      return sig;
    }
  }

  return nullptr;
}
