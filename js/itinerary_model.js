export function normalizeStationName(name) {
  if (name === undefined) name = "";
  return String(name)
    .trim()
    .normalize("NFKC")
    .replace(/[\s・･\-ー－]/g, "")
    .replace(/駅$/u, "")
    .toLowerCase();
}

export function normalizeLineName(name) {
  if (name === undefined) name = "";
  return String(name)
    .trim()
    .normalize("NFKC")
    .replace(/[\s・･\-ー－]/g, "")
    .toLowerCase();
}

export function toLatLon(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lat = Number(coord[0]);
  const lon = Number(coord[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}

export function hydrateItinerary(input) {
  const legs = Array.isArray(input?.legs) ? input.legs : [];
  const normalizedLegs = legs.map((leg, index) => ({
    mode: "train",
    warnings: [],
    ...leg,
    leg_id: Number(leg.leg_id ?? index + 1),
    from_station: String(leg.from_station ?? "").trim(),
    to_station: String(leg.to_station ?? "").trim(),
    from_coord: toLatLon(leg.from_coord),
    to_coord: toLatLon(leg.to_coord),
    from_platform_coord: toLatLon(leg.from_platform_coord) ?? null,
    to_platform_coord: toLatLon(leg.to_platform_coord) ?? null,
    from_osm_station_id: leg.from_osm_station_id || null,
    to_osm_station_id: leg.to_osm_station_id || null,
    intermediate_stations: Array.isArray(leg.intermediate_stations)
      ? leg.intermediate_stations.map((s) => String(s).trim()).filter(Boolean)
      : [],
    depart_platform: leg.depart_platform ? String(leg.depart_platform).trim() : null,
    arrive_platform: leg.arrive_platform ? String(leg.arrive_platform).trim() : null,
    fallback_path: Array.isArray(leg.fallback_path)
      ? leg.fallback_path.map(toLatLon).filter(Boolean)
      : []
  }));

  const itinerary = {
    trip_title: input?.trip_title || "未命名大回り行程",
    date: input?.date || "",
    source: input?.source || "user",
    legs: normalizedLegs,
    warnings: Array.isArray(input?.warnings) ? input.warnings : []
  };

  itinerary.transfers = detectTransferStations(itinerary.legs);
  return itinerary;
}

export function detectTransferStations(legs) {
  const transfers = [];
  for (let i = 0; i < legs.length - 1; i += 1) {
    const current = legs[i];
    const next = legs[i + 1];
    if (
      normalizeStationName(current.to_station) &&
      normalizeStationName(current.to_station) === normalizeStationName(next.from_station)
    ) {
      transfers.push({
        station: current.to_station,
        from_leg_id: current.leg_id,
        to_leg_id: next.leg_id,
        arrive_time: current.arrive_time || "",
        depart_time: next.depart_time || "",
        line_from: current.line_name || "",
        line_to: next.line_name || ""
      });
    }
  }
  return transfers;
}

export function collectWarnings(itinerary, routeState) {
  if (routeState === undefined) routeState = {};
  const warnings = [...(itinerary?.warnings || [])];
  for (const leg of itinerary?.legs || []) {
    for (const warning of leg.warnings || []) {
      warnings.push({ leg_id: leg.leg_id, message: warning.message || warning });
    }
    const solved = routeState.solvedRoutes?.find((route) => route.properties.leg_id === leg.leg_id);
    if (!solved) {
      warnings.push({
        leg_id: leg.leg_id,
        message: leg.from_station + " -> " + leg.to_station + " 尚未生成 OSM 鉄路路径。不会显示两点直线；请点击\"下载 OSM 并求解\"。"
      });
    } else if (solved.properties.confidence_score < 0.6) {
      warnings.push({
        leg_id: leg.leg_id,
        message: leg.from_station + " -> " + leg.to_station + " 路径置信度偏低。"
      });
    }
  }
  return warnings;
}

export function routeColor(index) {
  const colors = ["#0f766e", "#be123c", "#2563eb", "#7c3aed", "#ca8a04", "#0891b2"];
  return colors[index % colors.length];
}

export function legLabel(leg) {
  const train = [leg.line_name, leg.train_number].filter(Boolean).join(" / ");
  const time = [leg.depart_time, leg.arrive_time].filter(Boolean).join("-");
  return [train, time].filter(Boolean).join(" · ");
}

export function makeStationOnlyFeatures(itinerary) {
  const stations = [];
  for (const leg of itinerary?.legs || []) {
    const board = pointFeatureFromLegStation(leg, "board");
    const alight = pointFeatureFromLegStation(leg, "alight");
    if (board) stations.push(board);
    if (alight) stations.push(alight);
  }
  return stations;
}

export function pointFeatureFromLegStation(leg, role) {
  const coord = (role === "origin" || role === "board") ? leg.from_coord : leg.to_coord;
  const station = (role === "origin" || role === "board") ? leg.from_station : leg.to_station;
  if (!coord) return null;
  return {
    station_id: role + ":" + leg.leg_id + ":" + normalizeStationName(station),
    name: station,
    lat: coord[0],
    lon: coord[1],
    roles: [role],
    leg_ids: [leg.leg_id],
    confidence_score: 0.5
  };
}
