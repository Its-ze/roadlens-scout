export const TARGET_MIN_SIGHTINGS = 2;

const AREA_MATCH_RADIUS_METERS = 120;
const SAME_DEVICE_RADIUS_METERS = 320;

export type Spot = {
  id: string;
  createdAt: string;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  source: string;
  detector: string;
  label: string;
  mac: string;
  ssid?: string;
  role: string;
  rssi: number | null;
  channel: number | null;
  confidence: number;
  wildcardProbe: boolean;
  seedId?: string;
  seedLabel?: string;
  seedDistanceMeters?: number | null;
};

export type LocatedSpot = Spot & {
  lat: number;
  lon: number;
};

export type SmartTarget = {
  id: string;
  label: string;
  lat: number;
  lon: number;
  accuracy: number;
  radius: number;
  sightings: number;
  confidence: number;
  bestRssi: number | null;
  macs: string[];
  channels: number[];
  firstAt: string;
  lastAt: string;
  strongestSpotId: string;
  spotIds: string[];
};

type TargetDraft = {
  id: string;
  lat: number;
  lon: number;
  weight: number;
  weightedConfidence: number;
  weightedAccuracy: number;
  sightings: number;
  firstAtMs: number;
  lastAtMs: number;
  labelCounts: Map<string, number>;
  macs: Set<string>;
  channels: Set<number>;
  spots: LocatedSpot[];
  bestSpot: LocatedSpot;
  bestScore: number;
};

export function buildSmartTargets(allSpots: Spot[]): SmartTarget[] {
  const drafts: TargetDraft[] = [];
  const located = allSpots.filter(hasCoordinates).slice().reverse();

  for (const spot of located) {
    const draft = findBestDraft(spot, drafts);
    if (draft) {
      addSpotToDraft(draft, spot);
    } else {
      drafts.push(createTargetDraft(spot));
    }
  }

  return drafts
    .map(finalizeTarget)
    .sort((a, b) => {
      const scoreA = a.sightings * 1000 + a.confidence + new Date(a.lastAt).getTime() / 100000000000;
      const scoreB = b.sightings * 1000 + b.confidence + new Date(b.lastAt).getTime() / 100000000000;
      return scoreB - scoreA;
    });
}

export function hasCoordinates(spot: Spot): spot is LocatedSpot {
  return typeof spot.lat === 'number' && typeof spot.lon === 'number';
}

function findBestDraft(spot: LocatedSpot, drafts: TargetDraft[]) {
  let bestDraft: TargetDraft | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const draft of drafts) {
    const distance = distanceMeters(spot.lat, spot.lon, draft.lat, draft.lon);
    const sameMac = isKnownDevice(spot.mac) && draft.macs.has(spot.mac);
    const labelMatch = draft.labelCounts.has(spot.label);
    const accuracyBuffer = Math.min(180, (spot.accuracy ?? 45) + draft.weightedAccuracy / draft.weight);
    const threshold = sameMac
      ? Math.max(SAME_DEVICE_RADIUS_METERS, accuracyBuffer * 1.35)
      : Math.max(AREA_MATCH_RADIUS_METERS, accuracyBuffer * 1.15);

    if (
      (sameMac || labelMatch || distance <= AREA_MATCH_RADIUS_METERS) &&
      distance <= threshold &&
      distance < bestDistance
    ) {
      bestDistance = distance;
      bestDraft = draft;
    }
  }

  return bestDraft;
}

function createTargetDraft(spot: LocatedSpot): TargetDraft {
  const weight = sightingWeight(spot);
  const createdAtMs = new Date(spot.createdAt).getTime();
  const labels = new Map<string, number>();
  labels.set(spot.label, 1);

  return {
    id: crypto.randomUUID(),
    lat: spot.lat,
    lon: spot.lon,
    weight,
    weightedConfidence: spot.confidence * weight,
    weightedAccuracy: (spot.accuracy ?? 45) * weight,
    sightings: 1,
    firstAtMs: createdAtMs,
    lastAtMs: createdAtMs,
    labelCounts: labels,
    macs: isKnownDevice(spot.mac) ? new Set([spot.mac]) : new Set(),
    channels: spot.channel != null ? new Set([spot.channel]) : new Set(),
    spots: [spot],
    bestSpot: spot,
    bestScore: strongestScore(spot),
  };
}

function addSpotToDraft(draft: TargetDraft, spot: LocatedSpot) {
  const weight = sightingWeight(spot);
  const nextWeight = draft.weight + weight;
  draft.lat = (draft.lat * draft.weight + spot.lat * weight) / nextWeight;
  draft.lon = (draft.lon * draft.weight + spot.lon * weight) / nextWeight;
  draft.weight = nextWeight;
  draft.weightedConfidence += spot.confidence * weight;
  draft.weightedAccuracy += (spot.accuracy ?? 45) * weight;
  draft.sightings += 1;

  const createdAtMs = new Date(spot.createdAt).getTime();
  draft.firstAtMs = Math.min(draft.firstAtMs, createdAtMs);
  draft.lastAtMs = Math.max(draft.lastAtMs, createdAtMs);
  draft.labelCounts.set(spot.label, (draft.labelCounts.get(spot.label) ?? 0) + 1);
  if (isKnownDevice(spot.mac)) draft.macs.add(spot.mac);
  if (spot.channel != null) draft.channels.add(spot.channel);
  draft.spots.push(spot);

  const score = strongestScore(spot);
  if (score > draft.bestScore) {
    draft.bestScore = score;
    draft.bestSpot = spot;
  }
}

function finalizeTarget(draft: TargetDraft): SmartTarget {
  const avgAccuracy = draft.weightedAccuracy / draft.weight;
  const spread = draft.spots.reduce(
    (largest, spot) => Math.max(largest, distanceMeters(spot.lat, spot.lon, draft.lat, draft.lon)),
    0,
  );
  const bestRssi = draft.spots.reduce<number | null>((best, spot) => {
    if (spot.rssi == null) return best;
    if (best == null) return spot.rssi;
    return spot.rssi > best ? spot.rssi : best;
  }, null);
  const confidenceBase = draft.weightedConfidence / draft.weight;
  const repeatBoost = Math.min(18, Math.max(0, draft.sightings - 1) * 7);
  const signalBoost = bestRssi == null ? 0 : clamp((bestRssi + 80) / 3.8, 0, 12);
  const confidence = Math.round(clamp(confidenceBase + repeatBoost + signalBoost, 0, 99));
  const label = mostCommonLabel(draft.labelCounts);

  return {
    id: draft.id,
    label,
    lat: draft.lat,
    lon: draft.lon,
    accuracy: avgAccuracy,
    radius: Math.round(clamp(Math.max(18, avgAccuracy / Math.sqrt(draft.sightings), spread * 0.7), 18, 220)),
    sightings: draft.sightings,
    confidence,
    bestRssi,
    macs: [...draft.macs].sort(),
    channels: [...draft.channels].sort((a, b) => a - b),
    firstAt: new Date(draft.firstAtMs).toISOString(),
    lastAt: new Date(draft.lastAtMs).toISOString(),
    strongestSpotId: draft.bestSpot.id,
    spotIds: draft.spots.map((spot) => spot.id),
  };
}

function sightingWeight(spot: Spot) {
  const accuracyWeight = clamp(45 / Math.max(8, spot.accuracy ?? 45), 0.35, 2.25);
  const confidenceWeight = clamp((spot.confidence || 50) / 75, 0.45, 1.6);
  const signalWeight = spot.rssi == null ? 0.85 : clamp((spot.rssi + 96) / 42, 0.35, 2.25);
  return accuracyWeight * confidenceWeight * signalWeight;
}

function strongestScore(spot: Spot) {
  const rssiScore = spot.rssi == null ? 0 : spot.rssi + 100;
  const accuracyScore = spot.accuracy == null ? 0 : 80 - Math.min(80, spot.accuracy);
  return rssiScore * 2 + spot.confidence + accuracyScore;
}

function isKnownDevice(mac: string) {
  return mac !== 'unknown' && mac !== 'manual' && mac.trim().length >= 11;
}

function mostCommonLabel(labels: Map<string, number>) {
  let bestLabel = 'alpr-signal';
  let bestCount = -1;
  for (const [label, count] of labels) {
    if (count > bestCount) {
      bestLabel = label;
      bestCount = count;
    }
  }
  return bestLabel;
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radius = 6371000;
  const toRadians = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRadians;
  const dLon = (lon2 - lon1) * toRadians;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
