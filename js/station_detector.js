import { detectTransferStations, normalizeStationName, pointFeatureFromLegStation } from "./itinerary_model.js";
import { haversine } from "./railway_graph.js";

const ROUTE_STATION_ROLES = new Set(["origin", "destination", "board", "alight", "transfer"]);

export function buildStationFeatures(itinerary, solvedRoutes, osmStations) {
  if (solvedRoutes === undefined) solvedRoutes = [];
  if (osmStations === undefined) osmStations = [];
  const stationMap = new Map();
  const firstLeg = itinerary.legs[0];
  const lastLeg = itinerary.legs[itinerary.legs.length - 1];

  for (const leg of itinerary.legs) {
    addStation(stationMap, pointFeatureFromLegStation(leg, "board"));
    addStation(stationMap, pointFeatureFromLegStation(leg, "alight"));
  }

  if (firstLeg) addStation(stationMap, pointFeatureFromLegStation(firstLeg, "origin"));
  if (lastLeg)  addStation(stationMap, pointFeatureFromLegStation(lastLeg, "destination"));

  detectTransferStations(itinerary.legs).forEach(function(transfer, index) {
    const key = normalizeStationName(transfer.station);
    for (const station of stationMap.values()) {
      if (normalizeStationName(station.name) === key) {
        station.roles = Array.from(new Set(station.roles.concat(["transfer"])));
        station.transfer_order = index + 1;
        station.transfer_from_leg_id = transfer.from_leg_id;
        station.transfer_to_leg_id   = transfer.to_leg_id;
      }
    }
  });

  // Add intermediate stations from JSON (explicit by name — NOT distance-inferred).
  for (const leg of itinerary.legs) {
    for (const stationName of leg.intermediate_stations || []) {
      const key = normalizeStationName(stationName);
      const existing = stationMap.get(key);
      if (existing) {
        existing.leg_ids = Array.from(new Set(existing.leg_ids.concat([leg.leg_id])));
        continue;
      }
      const osmMatch = osmStations.find(function(s) { return stationNameKeys(s).includes(key); });
      if (osmMatch) {
        addStation(stationMap, {
          station_id: osmMatch.station_id,
          osm_type: osmMatch.osm_type,
          osm_id: osmMatch.osm_id,
          name: stationName,
          lat: osmMatch.lat,
          lon: osmMatch.lon,
          roles: ["pass_through"],
          leg_ids: [leg.leg_id],
          confidence_score: 0.9,
          matched_osm_station_id: osmMatch.station_id,
          matched_osm_name: osmMatch.name,
          matched_osm_name_ja: osmMatch.name_ja,
          matched_osm_name_en: osmMatch.name_en
        });
      } else {
        addStation(stationMap, {
          station_id: "intermediate:" + leg.leg_id + ":" + key,
          name: stationName,
          lat: null,
          lon: null,
          roles: ["pass_through"],
          leg_ids: [leg.leg_id],
          confidence_score: 0.3
        });
      }
    }
  }

  projectRouteStationsToRail(stationMap, itinerary, solvedRoutes, osmStations);
  return Array.from(stationMap.values());
}

function projectRouteStationsToRail(stationMap, itinerary, solvedRoutes, osmStations) {
  if (!solvedRoutes.length) return;

  const routeByLegId = new Map(
    solvedRoutes.map(function(route) { return [route.properties.leg_id, featurePath(route)]; })
  );

  for (const station of stationMap.values()) {
    const isRouteStation = station.roles.some(function(r) { return ROUTE_STATION_ROLES.has(r); });
    const isPassThrough  = station.roles.includes("pass_through");
    if (!isRouteStation && !isPassThrough) continue;

    const projections = [];

    if (isRouteStation) {
      for (const leg of itinerary.legs) {
        if (!station.leg_ids.includes(leg.leg_id)) continue;
        const path = routeByLegId.get(leg.leg_id);
        if (!path || !path.length) continue;

        // Highest priority: use the solved route endpoint directly.
        // This coord is already on the railway track — no projection needed.
        const railCoord = railCoordForStationOnLeg(station, leg);
        if (railCoord) {
          projections.push({ lat: railCoord[0], lon: railCoord[1], distance_m: 0, source: "rail_node", osmStation: null });
          continue;
        }

        const roleCoord = coordinateForStationOnLeg(station, leg);
        if (!roleCoord) continue;

        // Platform coord next; otherwise match OSM station by name.
        const platformCoord = platformCoordForStationOnLeg(station, leg);
        let sourceCoord, osmStation, sourceLabel;

        if (platformCoord) {
          sourceCoord = platformCoord;
          sourceLabel = "platform_coord";
          osmStation  = null;
        } else {
          osmStation  = matchOsmStationForRouteStation(station, roleCoord, path, osmStations);
          sourceCoord = osmStation ? [osmStation.lat, osmStation.lon] : roleCoord;
          sourceLabel = osmStation ? "osm_station" : "json_coord";
        }

        const projection = projectPointToPath(sourceCoord, path);
        if (projection) {
          projections.push(Object.assign({}, projection, { source: sourceLabel, osmStation: osmStation }));
        }
      }
    }

    // pass_through stations: project directly from their OSM coord.
    if (!projections.length && isPassThrough && Number.isFinite(station.lat) && Number.isFinite(station.lon)) {
      for (const legId of station.leg_ids) {
        const path = routeByLegId.get(legId);
        if (!path || !path.length) continue;
        const projection = projectPointToPath([station.lat, station.lon], path);
        if (projection) {
          projections.push(Object.assign({}, projection, { source: "osm_station", osmStation: null }));
        }
      }
    }

    if (!projections.length) continue;

    const best = chooseProjectedPoint(projections);
    station.source_lat = station.lat;
    station.source_lon = station.lon;
    station.lat = best.lat;
    station.lon = best.lon;
    station.display_on_route  = true;
    station.display_offset_m  = Math.round(best.distance_m);
    station.display_source    = best.source;
    if (best.osmStation) {
      station.matched_osm_station_id = best.osmStation.station_id;
      station.matched_osm_name       = best.osmStation.name;
      station.matched_osm_name_ja    = best.osmStation.name_ja;
      station.matched_osm_name_en    = best.osmStation.name_en;
      station.matched_osm_type       = best.osmStation.osm_type;
      station.matched_osm_id         = best.osmStation.osm_id;
    }
  }
}

function matchOsmStationForRouteStation(station, roleCoord, path, osmStations) {
  const stationNames = stationNameKeys(station);
  const candidates = osmStations
    .filter(function(c) { return stationNames.some(function(n) { return stationNameKeys(c).includes(n); }); })
    .map(function(c) {
      const routeDistance = minDistanceToPath([c.lat, c.lon], path);
      const roleDistance  = haversine(roleCoord, [c.lat, c.lon]);
      return Object.assign({}, c, {
        routeDistance: routeDistance,
        roleDistance:  roleDistance,
        score: routeDistance + roleDistance * 0.35
      });
    })
    .filter(function(c) { return c.routeDistance <= 900 || c.roleDistance <= 900; })
    .sort(function(a, b) { return a.score - b.score; });

  return candidates[0] || null;
}

function coordinateForStationOnLeg(station, leg) {
  const key = normalizeStationName(station.name);
  if (normalizeStationName(leg.from_station) === key) {
    return leg.from_platform_coord || leg.from_coord;
  }
  if (normalizeStationName(leg.to_station) === key) {
    return leg.to_platform_coord || leg.to_coord;
  }
  return null;
}

function platformCoordForStationOnLeg(station, leg) {
  const key = normalizeStationName(station.name);
  if (normalizeStationName(leg.from_station) === key) return leg.from_platform_coord || null;
  if (normalizeStationName(leg.to_station) === key)   return leg.to_platform_coord || null;
  return null;
}

// Returns the solved-route endpoint for a station on a leg.
// These coords are guaranteed to lie exactly on the railway geometry.
function railCoordForStationOnLeg(station, leg) {
  const key = normalizeStationName(station.name);
  if (normalizeStationName(leg.from_station) === key) return leg.from_rail_coord || null;
  if (normalizeStationName(leg.to_station)   === key) return leg.to_rail_coord   || null;
  return null;
}

function chooseProjectedPoint(projections) {
  const order = { rail_node: 0, platform_coord: 1, osm_station: 2, json_coord: 3 };
  return projections.slice().sort(function(a, b) {
    const diff = ((order[a.source] !== undefined ? order[a.source] : 9)) -
                 ((order[b.source] !== undefined ? order[b.source] : 9));
    return diff !== 0 ? diff : a.distance_m - b.distance_m;
  })[0];
}

function projectPointToPath(point, path) {
  let best = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const projected = projectPointToSegment(point, path[i], path[i + 1]);
    if (!best || projected.distance_m < best.distance_m) best = projected;
  }
  return best;
}

function projectPointToSegment(point, a, b) {
  const meanLat = ((point[0] + a[0] + b[0]) / 3) * Math.PI / 180;
  const mLat = 111320;
  const mLon = 111320 * Math.cos(meanLat);
  const px = point[1] * mLon, py = point[0] * mLat;
  const ax = a[1] * mLon,     ay = a[0] * mLat;
  const bx = b[1] * mLon,     by = b[0] * mLat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  return { lat: y / mLat, lon: x / mLon, distance_m: Math.hypot(px - x, py - y) };
}

function addStation(map, station) {
  if (!station) return;
  const key = normalizeStationName(station.name);
  const existing = map.get(key);
  if (existing) {
    existing.roles    = Array.from(new Set(existing.roles.concat(station.roles)));
    existing.leg_ids  = Array.from(new Set(existing.leg_ids.concat(station.leg_ids)));
  } else {
    map.set(key, station);
  }
}

function stationNameKeys(station) {
  return [
    station.name,
    station.name_ja,
    station.name_en,
    station.tags && station.tags.name,
    station.tags && station.tags["name:ja"],
    station.tags && station.tags["name:en"]
  ].map(normalizeStationName).filter(Boolean);
}

function featurePath(feature) {
  if (!feature.geometry || feature.geometry.type !== "LineString") return [];
  // Pure railway geometry — coordinates are [lon, lat] in GeoJSON, convert to [lat, lon].
  return feature.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
}

function minDistanceToPath(point, path) {
  let best = Infinity;
  for (const coord of path) {
    const d = haversine(point, coord);
    if (d < best) best = d;
  }
  return best;
}
