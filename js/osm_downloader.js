const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const QUERY_VERSION     = "rail-corridor-v3";  // corridor (fallback) cache version
const LINE_QUERY_VERSION = "rail-line-v1";      // route-relation-targeted cache version

/**
 * Download OSM railway data for a leg.
 *
 * Strategy:
 *  1. If leg.line_name is provided, try a route-relation-targeted query that
 *     fetches ONLY the ways belonging to that named relation within the corridor.
 *     This is much faster in dense urban areas (Tokyo: tens of lines per bbox).
 *  2. If the targeted query returns zero rail ways (relation name not found in
 *     OSM, or spelling mismatch), fall back silently to the full corridor query.
 *  3. Both result sets are cached separately so the two strategies don't pollute
 *     each other's caches.
 */
export async function fetchRailwayDataForLeg(leg, options) {
  if (options === undefined) options = {};
  const corridor = corridorForLeg(leg, options);
  if (!corridor) {
    throw new Error(leg.from_station + " -> " + leg.to_station + " is missing coordinates for an OSM corridor query.");
  }

  const lineName = (leg.line_name || "").trim();

  // ── Fast path: route-relation-targeted query ─────────────────────────────
  if (lineName) {
    const lineCacheKey = "osm_cache:" + LINE_QUERY_VERSION + ":"
      + normalizeLineCacheKey(lineName) + ":" + JSON.stringify(corridor.cacheShape);
    const lineCached = readCache(lineCacheKey);
    if (lineCached) {
      return { bbox: corridor.unionBbox, areas: corridor.areas, data: lineCached, cached: true, queryMode: "line" };
    }

    const lineQuery = buildRouteLineQuery(corridor.areas, lineName);
    const lineResp = await overpassFetch(lineQuery);
    const lineData = await lineResp.json();
    const railCount = countRailWays(lineData);

    if (railCount > 0) {
      writeCache(lineCacheKey, lineData);
      return { bbox: corridor.unionBbox, areas: corridor.areas, data: lineData, cached: false, queryMode: "line" };
    }
    // Zero rail ways → line name didn't match any OSM relation; fall through.
  }

  // ── Fallback: full corridor query ─────────────────────────────────────────
  const corridorCacheKey = "osm_cache:" + QUERY_VERSION + ":" + JSON.stringify(corridor.cacheShape);
  const corridorCached = readCache(corridorCacheKey);
  if (corridorCached) {
    return { bbox: corridor.unionBbox, areas: corridor.areas, data: corridorCached, cached: true, queryMode: "corridor" };
  }

  const corridorQuery = buildRailwayQuery(corridor.areas);
  const corridorResp = await overpassFetch(corridorQuery);
  const corridorData = await corridorResp.json();
  writeCache(corridorCacheKey, corridorData);
  return { bbox: corridor.unionBbox, areas: corridor.areas, data: corridorData, cached: false, queryMode: "corridor" };
}

async function overpassFetch(query) {
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: query })
  });
  if (!response.ok) {
    throw new Error("Overpass request failed: " + response.status + " " + response.statusText);
  }
  return response;
}

function countRailWays(data) {
  return (data.elements || []).filter(function(e) {
    return e.type === "way" && e.tags && e.tags.railway === "rail";
  }).length;
}

function normalizeLineCacheKey(lineName) {
  return lineName.trim().toLowerCase().replace(/\s+/g, "_");
}

export function corridorForLeg(leg, options) {
  if (options === undefined) options = {};
  const start = leg.from_coord;
  const end = leg.to_coord;
  if (!start || !end) return null;

  const distanceKm = haversine(start, end) / 1000;
  const radiusKm = options.radiusKm !== undefined ? options.radiusKm : corridorRadiusKm(distanceKm);
  const stepKm = options.stepKm !== undefined ? options.stepKm : 1.2;
  const steps = Math.max(1, Math.ceil(distanceKm / stepKm));
  const points = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push([
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t
    ]);
  }

  for (const coord of leg.fallback_path || []) {
    if (Array.isArray(coord) && coord.length >= 2) points.push(coord);
  }

  const areas = dedupeBboxes(points.map(function(point) { return bboxAround(point, radiusKm); }));
  return {
    areas,
    unionBbox: unionBbox(areas),
    cacheShape: {
      from: start.map(roundCoord),
      to: end.map(roundCoord),
      radiusKm: Number(radiusKm.toFixed(2)),
      areas
    }
  };
}

export function bboxForLeg(leg, paddingKm) {
  if (paddingKm === undefined) paddingKm = 1.2;
  const corridor = corridorForLeg(leg, { radiusKm: paddingKm });
  return corridor ? corridor.unionBbox : null;
}

export function buildRailwayQuery(areas) {
  const railWays = areas.map(function(bbox) {
    return "  way[\"railway\"=\"rail\"](" + bbox.join(",") + ");";
  }).join("\n");
  const stationNodes = areas.map(function(bbox) {
    return "  node[\"railway\"~\"station|halt\"](" + bbox.join(",") + ");";
  }).join("\n");
  const stationWays = areas.map(function(bbox) {
    return "  way[\"railway\"~\"station|halt\"](" + bbox.join(",") + ");";
  }).join("\n");
  const platformNodes = areas.map(function(bbox) {
    return "  node[\"railway\"~\"platform|platform_edge\"](" + bbox.join(",") + ");";
  }).join("\n");
  const platformWays = areas.map(function(bbox) {
    return "  way[\"railway\"~\"platform|platform_edge\"](" + bbox.join(",") + ");";
  }).join("\n");

  return [
    "[out:json][timeout:90];",
    "(",
    railWays,
    ")->.rails;",
    "(",
    "  .rails;",
    stationNodes,
    stationWays,
    platformNodes,
    platformWays,
    ");",
    "out body;",
    ">;",
    "out skel qt;",
    "rel(bw.rails)[\"route\"~\"train|subway|light_rail\"];",
    "out body;"
  ].join("\n");
}

/**
 * Route-relation-targeted query.
 *
 * Overpass strategy:
 *   1. Find all route relations whose "name" contains lineName within the
 *      union bbox of the corridor.
 *   2. From those relations, keep only the "railway=rail" ways that also fall
 *      inside the corridor (geographic clip).
 *   3. Add station and platform nodes/ways from the corridor as before.
 *
 * If the relation name isn't found in OSM, the ".rails" set will be empty and
 * the caller will detect this (countRailWays == 0) and fall back.
 */
export function buildRouteLineQuery(areas, lineName) {
  const bboxStr = unionBbox(areas).join(",");
  const namePattern = escapeOverpassRegex(lineName);

  const stationNodes = areas.map(function(bbox) {
    return "  node[\"railway\"~\"station|halt\"](" + bbox.join(",") + ");";
  }).join("\n");
  const stationWays = areas.map(function(bbox) {
    return "  way[\"railway\"~\"station|halt\"](" + bbox.join(",") + ");";
  }).join("\n");
  const platformNodes = areas.map(function(bbox) {
    return "  node[\"railway\"~\"platform|platform_edge\"](" + bbox.join(",") + ");";
  }).join("\n");
  const platformWays = areas.map(function(bbox) {
    return "  way[\"railway\"~\"platform|platform_edge\"](" + bbox.join(",") + ");";
  }).join("\n");

  return [
    "[out:json][timeout:90];",
    // Find route relations matching the line name anywhere in the corridor area.
    "rel[\"route\"~\"train|subway|light_rail\"][\"name\"~\"" + namePattern + "\"](" + bboxStr + ")->.route;",
    // Extract only the rail ways that are (a) members of those relations AND
    // (b) within the corridor union bbox.  This is the key filter.
    "way(r.route)[\"railway\"=\"rail\"](" + bboxStr + ")->.rails;",
    "(",
    "  .rails;",
    stationNodes,
    stationWays,
    platformNodes,
    platformWays,
    ");",
    "out body;",
    ">;",
    "out skel qt;",
    "rel(bw.rails)[\"route\"~\"train|subway|light_rail\"];",
    "out body;"
  ].join("\n");
}

/**
 * Escape special POSIX ERE characters for use inside an Overpass ["tag"~"…"]
 * filter.  Most Japanese line names have no special characters, but we escape
 * defensively.
 */
function escapeOverpassRegex(str) {
  return String(str).replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
}

function corridorRadiusKm(distanceKm) {
  if (distanceKm <= 1) return 0.75;
  if (distanceKm <= 3) return 1.0;
  if (distanceKm <= 8) return 1.35;
  if (distanceKm <= 25) return 1.8;
  return 2.5;
}

function bboxAround(point, radiusKm) {
  const lat = point[0];
  const lon = point[1];
  const latPad = radiusKm / 111;
  const lonPad = radiusKm / (111 * Math.max(0.25, Math.cos((lat * Math.PI) / 180)));
  return [
    roundCoord(lat - latPad),
    roundCoord(lon - lonPad),
    roundCoord(lat + latPad),
    roundCoord(lon + lonPad)
  ];
}

function dedupeBboxes(bboxes) {
  const seen = new Set();
  const output = [];
  for (const bbox of bboxes) {
    const key = bbox.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(bbox);
  }
  return output;
}

function unionBbox(bboxes) {
  return [
    Math.min.apply(null, bboxes.map(function(b) { return b[0]; })),
    Math.min.apply(null, bboxes.map(function(b) { return b[1]; })),
    Math.max.apply(null, bboxes.map(function(b) { return b[2]; })),
    Math.max.apply(null, bboxes.map(function(b) { return b[3]; }))
  ].map(roundCoord);
}

function haversine(a, b) {
  const radius = 6371000;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const lat1 = radians(a[0]);
  const lat2 = radians(b[0]);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

function roundCoord(value) {
  return Number(value.toFixed(6));
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    // Cache is an optimization only.
  }
}
