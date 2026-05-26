import { normalizeStationName } from "./itinerary_model.js";
import { haversine } from "./railway_graph.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Canonical operator aliases — maps any known variant to one canonical key.
// Add entries as needed for other operators.
const OPERATOR_ALIASES = {
  // JR East
  "jr東日本":               "jr東日本",
  "東日本旅客鉄道":          "jr東日本",
  "east japan railway company": "jr東日本",
  "jr east":                "jr東日本",
  // JR Central
  "jr東海":                 "jr東海",
  "東海旅客鉄道":            "jr東海",
  "central japan railway company": "jr東海",
  // JR West
  "jr西日本":               "jr西日本",
  "西日本旅客鉄道":          "jr西日本",
  // JR Kyushu
  "jr九州":                 "jr九州",
  "九州旅客鉄道":            "jr九州",
  // JR Hokkaido
  "jr北海道":               "jr北海道",
  "北海道旅客鉄道":          "jr北海道",
  // Tokyo Metro
  "東京地下鉄":             "東京メトロ",
  "東京メトロ":             "東京メトロ",
  "tokyo metro":            "東京メトロ",
  // Toei
  "東京都交通局":           "都営",
  "都営":                   "都営",
  "toei":                   "都営",
  // Tokyu
  "東急電鉄":               "東急",
  "東急":                   "東急",
  "tokyu corporation":      "東急",
  // Odakyu
  "小田急電鉄":             "小田急",
  "小田急":                 "小田急",
  // Keio
  "京王電鉄":               "京王",
  "京王":                   "京王",
  // Keikyu
  "京急電鉄":               "京急",
  "京急":                   "京急",
  // Seibu
  "西武鉄道":               "西武",
  "西武":                   "西武",
  // Tobu
  "東武鉄道":               "東武",
  "東武":                   "東武",
  // Kintetsu
  "近畿日本鉄道":           "近鉄",
  "近鉄":                   "近鉄",
  // Nankai
  "南海電気鉄道":           "南海",
  "南海":                   "南海",
  // Hankyu
  "阪急電鉄":               "阪急",
  "阪急":                   "阪急",
  // Hanshin
  "阪神電気鉄道":           "阪神",
  "阪神":                   "阪神",
};

/**
 * Normalise an operator name to a canonical key for comparison.
 * Returns "" if the input is falsy.
 */
function normalizeOperator(name) {
  if (!name) return "";
  const key = String(name).trim().toLowerCase().replace(/\s+/g, "");
  return OPERATOR_ALIASES[key] || key;
}

/**
 * Ensure leg has from_coord/to_coord by querying Overpass if missing.
 * This is the initial bootstrap step before the corridor download.
 * After the corridor is downloaded, call resolveStationFromOsmData() to
 * refine coords using local corridor station data.
 */
export async function ensureLegCoordinates(leg) {
  const updated = { ...leg };
  if (!updated.from_coord) {
    const from = await searchStation(updated.from_station, updated.operator);
    if (from) {
      updated.from_coord = [from.lat, from.lon];
      updated.matched_from_station_id = from.station_id;
    }
  }
  if (!updated.to_coord) {
    const to = await searchStation(updated.to_station, updated.operator);
    if (to) {
      updated.to_coord = [to.lat, to.lon];
      updated.matched_to_station_id = to.station_id;
    }
  }
  return updated;
}

/**
 * Resolve a station by name from already-downloaded corridor OSM stations.
 * Preferred over ensureLegCoordinates because the station is guaranteed to
 * be within the railway corridor being rendered.
 */
/**
 * Resolve a station by name (and optionally operator) from corridor OSM stations.
 * operatorHint: leg.operator value from JSON (e.g. "JR東日本").
 * When multiple OSM nodes share the same station name (e.g. 御茶ノ水 on JR and
 * Tokyo Metro), the operator hint boosts the correct candidate by +30 and
 * penalises mismatches by -20.
 */
export function resolveStationFromOsmData(stationName, osmStations, operatorHint) {
  if (!osmStations?.length) return null;
  const normalized = normalizeStationName(stationName);
  if (!normalized) return null;

  const candidates = osmStations
    .map((s) => ({ ...s, _score: scoreStation(s, normalized, operatorHint) }))
    .filter((s) => s._score >= 70)
    .sort((a, b) => b._score - a._score);

  return candidates[0] || null;
}

/**
 * Find a platform feature near a station by platform ref/name.
 * platformRef: e.g. "3", "3番線", "3番のりば"
 * osmPlatforms: platform features from normalizeOverpass().platforms
 * stationCoord: [lat, lon] of the matched station (to filter by proximity)
 * maxDistM: max distance in metres from station centre to accept a platform
 */
export function resolvePlatformFromOsmData(platformRef, osmPlatforms, stationCoord, maxDistM = 600) {
  if (!platformRef || !osmPlatforms?.length) return null;

  // Normalise: strip trailing "番線" / "番のりば" / whitespace
  const norm = String(platformRef).trim().replace(/番(線|のりば)$/u, "").trim();

  const candidates = osmPlatforms.filter((p) => {
    const ref = String(p.ref || "").trim();
    const name = String(p.name || "").trim().replace(/番(線|のりば)$/u, "").trim();
    return ref === norm || name === norm || name === String(platformRef).trim() || ref === String(platformRef).trim();
  });

  if (!candidates.length) return null;

  // Prefer platforms close to the station centre
  if (stationCoord) {
    const nearby = candidates
      .map((p) => ({ ...p, _dist: haversine([p.lat, p.lon], stationCoord) }))
      .filter((p) => p._dist <= maxDistM)
      .sort((a, b) => a._dist - b._dist);
    if (nearby.length) return nearby[0];
  }

  return candidates[0];
}

export async function searchStation(name, operatorHint) {
  const normalized = normalizeStationName(name);
  if (!normalized) return null;

  // Cache key does NOT include operator so the raw result set is shared;
  // operator disambiguation is applied at sort time from the cached list.
  const cacheKey = `station_search:v2:${normalized}`;
  const cachedList = readCache(cacheKey);
  if (cachedList) {
    const sorted = cachedList.sort((a, b) => scoreStation(b, normalized, operatorHint) - scoreStation(a, normalized, operatorHint));
    return sorted[0] || null;
  }

  const escaped = escapeRegex(String(name).replace(/駅$/u, ""));
  const query = `
[out:json][timeout:45];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
(
  node(area.jp)["railway"~"station|halt"]["name"~"^${escaped}駅?$"];
  way(area.jp)["railway"~"station|halt"]["name"~"^${escaped}駅?$"];
  node(area.jp)["railway"~"station|halt"]["name:ja"~"^${escaped}駅?$"];
  way(area.jp)["railway"~"station|halt"]["name:ja"~"^${escaped}駅?$"];
);
out center 20;`;

  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: query })
  });
  if (!response.ok) return null;

  const data = await response.json();
  const allCandidates = (data.elements || []).map(toCandidate).filter(Boolean);
  // Cache the full candidate list so different operator hints can reuse it.
  if (allCandidates.length) writeCache(cacheKey, allCandidates);

  const sorted = allCandidates.sort((a, b) => scoreStation(b, normalized, operatorHint) - scoreStation(a, normalized, operatorHint));
  return sorted[0] || null;
}

function toCandidate(element) {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    station_id: `${element.type}/${element.id}`,
    osm_type: element.type,
    osm_id: element.id,
    name: element.tags?.["name:ja"] || element.tags?.name || element.tags?.["name:en"] || "",
    name_ja: element.tags?.["name:ja"],
    name_en: element.tags?.["name:en"],
    operator: element.tags?.operator,
    lat,
    lon,
    tags: element.tags || {}
  };
}

function scoreStation(candidate, normalized, operatorHint) {
  const names = [candidate.name, candidate.name_ja, candidate.name_en].map(normalizeStationName);
  let score;
  if (names.includes(normalized)) score = 100;
  else if (names.some((name) => name.includes(normalized) || normalized.includes(name))) score = 70;
  else score = 10;

  // Apply operator bonus/penalty when a hint is provided.
  // +30 for confirmed match, -20 for confirmed mismatch.
  // No adjustment when either side is unknown.
  if (operatorHint && score >= 70) {
    const hintKey = normalizeOperator(operatorHint);
    const candKey = normalizeOperator(candidate.operator);
    if (hintKey && candKey) {
      if (hintKey === candKey) score += 30;
      else score -= 20;
    }
  }

  return score;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // Cache is an optimization only.
  }
}
