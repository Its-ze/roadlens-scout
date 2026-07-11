import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { buildSmartTargets, TARGET_MIN_SIGHTINGS } = await import('../.smart-target-test/smartTargets.js');

function spot(overrides) {
  return {
    id: crypto.randomUUID(),
    createdAt: '2026-06-23T04:00:00.000Z',
    lat: 39,
    lon: -104,
    accuracy: 30,
    source: 'wifi',
    detector: 'RoadLensESP32',
    label: 'flock-wifi',
    mac: '70:c9:4e:11:22:33',
    role: 'addr2',
    rssi: -70,
    channel: 6,
    confidence: 82,
    wildcardProbe: false,
    ...overrides,
  };
}

function meters(a, b) {
  const radius = 6371000;
  const toRadians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRadians;
  const dLon = (b.lon - a.lon) * toRadians;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRadians) * Math.cos(b.lat * toRadians) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const weak = spot({
  id: 'weak-pass',
  lat: 39,
  lon: -104,
  accuracy: 65,
  rssi: -79,
  confidence: 78,
  createdAt: '2026-06-23T04:00:00.000Z',
});
const strong = spot({
  id: 'strong-pass',
  lat: 39.00045,
  lon: -104.00025,
  accuracy: 9,
  rssi: -42,
  confidence: 96,
  createdAt: '2026-06-23T04:01:00.000Z',
});
const far = spot({
  id: 'far-pass',
  lat: 39.02,
  lon: -104.02,
  accuracy: 10,
  rssi: -45,
  confidence: 95,
  createdAt: '2026-06-23T04:02:00.000Z',
});

const targets = buildSmartTargets([far, strong, weak]);
const merged = targets.find((target) => target.spotIds.includes('weak-pass') && target.spotIds.includes('strong-pass'));
assert.ok(merged, 'nearby repeat sightings should merge into one smart target');
assert.equal(merged.sightings, TARGET_MIN_SIGHTINGS);
assert.equal(merged.independentPasses, 2);
assert.equal(merged.bestRssi, -42);
assert.ok(merged.confidence >= 95, `expected high confidence, got ${merged.confidence}`);
assert.ok(meters(merged, strong) < meters(merged, weak), 'estimate should be pulled toward stronger/better GPS sighting');

const farTarget = targets.find((target) => target.spotIds.includes('far-pass'));
assert.ok(farTarget, 'distant sighting should remain available as a separate target');
assert.equal(farTarget.sightings, 1);

const unknownAreaTargets = buildSmartTargets([
  spot({ id: 'area-a', mac: 'unknown', lat: 40, lon: -105, rssi: -68 }),
  spot({ id: 'area-b', mac: 'unknown', lat: 40.0003, lon: -105.0002, rssi: -60 }),
]);
assert.equal(unknownAreaTargets[0].sightings, 2, 'nearby same-label area sightings should merge');

const duplicateTargets = buildSmartTargets([
  spot({ id: 'duplicate-a', createdAt: '2026-06-23T04:00:00.000Z' }),
  spot({ id: 'duplicate-b', createdAt: '2026-06-23T04:00:10.000Z', lat: 39.00001 }),
]);
assert.equal(duplicateTargets[0].independentPasses, 1, 'rapid samples from one position are one pass');
assert.ok(duplicateTargets[0].confidence < merged.confidence, 'duplicate samples should not inflate confidence');

const seedTargets = buildSmartTargets([
  spot({
    id: 'seed-pass-a',
    lat: 39.0004,
    lon: -104.0002,
    seedId: 'camera-1',
    seedLabel: 'Known ALPR',
    seedLat: 39.00025,
    seedLon: -104.0001,
  }),
  spot({
    id: 'seed-pass-b',
    createdAt: '2026-06-23T04:03:00.000Z',
    lat: 39.0001,
    lon: -104,
    seedId: 'camera-1',
    seedLabel: 'Known ALPR',
    seedLat: 39.00025,
    seedLon: -104.0001,
  }),
]);
assert.equal(seedTargets[0].estimateMode, 'seed-anchored');
assert.equal(seedTargets[0].lat, 39.00025);
assert.equal(seedTargets[0].lon, -104.0001);
assert.equal(seedTargets[0].radius, 18);

const robustTargets = buildSmartTargets([
  spot({ id: 'robust-a', lat: 39, lon: -104, rssi: -54 }),
  spot({ id: 'robust-b', createdAt: '2026-06-23T04:02:00.000Z', lat: 39.0002, lon: -104.0001, rssi: -48 }),
  spot({ id: 'robust-c', createdAt: '2026-06-23T04:04:00.000Z', lat: 39.0001, lon: -104.0002, rssi: -50 }),
  spot({ id: 'robust-outlier', createdAt: '2026-06-23T04:06:00.000Z', lat: 39.0025, lon: -104, rssi: -88 }),
]);
const robust = robustTargets.find((target) => target.spotIds.includes('robust-a'));
assert.ok(robust, 'same-device passes should remain one target');
assert.ok(meters(robust, { lat: 39.0001, lon: -104.0001 }) < 45, 'weak location outlier should be discounted');

console.log('smart target tests passed');
