#!/usr/bin/env python3
import hashlib
import json
import pathlib
import sys
import time
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "data" / "camera-seeds.json"
APP_PUBLIC_PATH = ROOT / "app" / "public" / "camera-seeds.json"
DOCS_PUBLIC_PATH = ROOT / "docs" / "camera-seeds.json"
DOCS_META_PATH = ROOT / "docs" / "site-meta.json"
DOCS_CHECKSUMS_PATH = ROOT / "docs" / "downloads" / "checksums.txt"
SOURCE_URL = "https://data.dontgetflocked.com/cameras.geojson.gz"
SOURCE_NAME = "DeFlock public ALPR camera map"
SOURCE_SITE = "https://maps.deflock.org/"


def main() -> int:
    raw = fetch_source()
    source_hash = hashlib.sha256(raw).hexdigest()
    source = json.loads(raw.decode("utf-8-sig"))
    features = source.get("features") if isinstance(source, dict) else source
    if not isinstance(features, list):
        raise RuntimeError("Camera source did not contain a feature list")

    points = []
    for feature in features:
        point = normalize_feature(feature)
        if point:
            points.append(point)

    if len(points) < 1000:
        raise RuntimeError(f"Camera seed feed unexpectedly small: {len(points)} points")

    points.sort(key=lambda item: (item.get("state") or "", item.get("operator") or "", item["id"]))
    version_input = "\n".join(
        f"{item['id']}|{item['lat']}|{item['lon']}|{item.get('brand','')}|{item.get('operator','')}"
        for item in points
    )
    version_hash = hashlib.sha256(version_input.encode("utf-8")).hexdigest()[:8]
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    version = f"{datetime.now(timezone.utc).strftime('%Y.%m.%d')}.{version_hash}"

    feed = {
        "schema": 1,
        "name": "RoadLens Scout Public Camera Seeds",
        "version": version,
        "generatedAt": generated_at,
        "sources": [
            {
                "name": SOURCE_NAME,
                "url": SOURCE_SITE,
                "dataUrl": SOURCE_URL,
                "sha256": source_hash,
                "license": "OpenStreetMap-derived public ALPR camera data; retain source attribution.",
            }
        ],
        "pointCount": len(points),
        "points": points,
    }

    write_json(OUT_PATH, feed)
    write_json(APP_PUBLIC_PATH, feed)
    write_json(DOCS_PUBLIC_PATH, feed)
    sync_pages_metadata(feed)
    print("Camera seed feed updated:")
    print(f"  {OUT_PATH}")
    print(f"  {APP_PUBLIC_PATH}")
    print(f"  {DOCS_PUBLIC_PATH}")
    print(f"  version: {version}")
    print(f"  points: {len(points)}")
    return 0


def fetch_source() -> bytes:
    request = urllib.request.Request(
        SOURCE_URL,
        headers={
            "Accept": "application/geo+json, application/json",
            "User-Agent": "RoadLens Scout camera seed updater",
        },
    )
    last_error = None
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except Exception as exc:  # pragma: no cover - network defensive retry
            last_error = exc
            if attempt < 3:
                time.sleep(attempt * 2)
    raise RuntimeError(f"Failed to download camera source: {last_error}")


def normalize_feature(feature):
    if not isinstance(feature, dict):
        return None

    properties = feature.get("properties") if isinstance(feature.get("properties"), dict) else feature
    geometry = feature.get("geometry") if isinstance(feature.get("geometry"), dict) else None
    coordinates = geometry.get("coordinates") if geometry else None
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        lat = parse_float(feature.get("lat"))
        lon = parse_float(feature.get("lon"))
    else:
        lon = parse_float(coordinates[0])
        lat = parse_float(coordinates[1])
    if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return None

    brand = clean_text(properties.get("brand"))
    operator = clean_text(properties.get("operator"))
    combined = f"{brand or ''} {operator or ''}".lower()
    if "flock" not in combined:
        return None

    osm_id = clean_text(properties.get("osmId")) or clean_text(properties.get("id"))
    osm_type = clean_text(properties.get("osmType")) or "node"
    seed_id = f"osm:{osm_type}:{osm_id}" if osm_id else f"seed:{lat:.6f}:{lon:.6f}"
    point = {
        "id": seed_id,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "brand": brand or "Flock Safety",
        "source": "deflock-osm",
    }

    optional_fields = {
        "operator": operator,
        "direction": parse_float(properties.get("direction")),
        "directionCardinal": clean_text(properties.get("directionCardinal")),
        "surveillanceZone": clean_text(properties.get("surveillanceZone")),
        "mountType": clean_text(properties.get("mountType")),
        "ref": clean_text(properties.get("ref")),
        "osmTimestamp": clean_text(properties.get("osmTimestamp")),
        "osmVersion": parse_int(properties.get("osmVersion")),
    }
    for key, value in optional_fields.items():
        if value not in (None, ""):
            point[key] = value
    return point


def clean_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def parse_float(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_int(value):
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def write_json(path: pathlib.Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def sync_pages_metadata(feed) -> None:
    if not DOCS_PUBLIC_PATH.exists():
        return

    seed_bytes = DOCS_PUBLIC_PATH.read_bytes()
    seed_sha256 = hashlib.sha256(seed_bytes).hexdigest()

    if DOCS_META_PATH.exists():
        meta = json.loads(DOCS_META_PATH.read_text(encoding="utf-8-sig"))
        if isinstance(meta, dict):
            meta["cameraSeeds"] = {
                "path": "camera-seeds.json",
                "version": feed["version"],
                "bytes": len(seed_bytes),
                "sha256": seed_sha256,
                "points": feed["pointCount"],
                "sources": len(feed.get("sources") or []),
            }
            DOCS_META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")

    if DOCS_CHECKSUMS_PATH.exists():
        lines = DOCS_CHECKSUMS_PATH.read_text(encoding="utf-8-sig").splitlines()
        camera_line = f"{seed_sha256}  camera-seeds.json"
        replaced = False
        next_lines = []
        for line in lines:
            if line.endswith("  camera-seeds.json"):
                next_lines.append(camera_line)
                replaced = True
            else:
                next_lines.append(line)
        if not replaced:
            next_lines.insert(0, camera_line)
        DOCS_CHECKSUMS_PATH.write_text("\n".join(next_lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
