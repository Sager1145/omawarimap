const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

let railwayLayer = null;
let lastFeatureCollection = null;
let lastStationFeatureCollection = null;
let activeRequest = null;
let hasStationResolutionData = false;
let hasRouteResolutionData = false;

export function setupRailwayData(map, options = {}) {
  const getItinerary = options.getItinerary || (() => null);
  const getResolution = options.getResolution || (() => null);
  const elements = {
    south: document.getElementById("bound-south"),
    west: document.getElementById("bound-west"),
    north: document.getElementById("bound-north"),
    east: document.getElementById("bound-east"),
    stations: document.getElementById("resolve-stations"),
    route: document.getElementById("resolve-route"),
    clear: document.getElementById("clear-railway"),
    status: document.getElementById("railway-status")
  };

  const updateState = () => {
    updateBounds(map, elements);
    updateDownloadAvailability(map, elements, getItinerary, getResolution);
  };

  map.on("moveend zoomend", updateState);
  document.addEventListener("itinerary:change", updateState);
  updateState();

  elements.stations.addEventListener("click", () => resolveStationData(map, elements, getItinerary, getResolution));
  elements.route.addEventListener("click", () => resolveRouteData(map, elements, getItinerary, getResolution));
  elements.clear.addEventListener("click", () => clearRailwayData(map, elements));
}

function updateBounds(map, elements) {
  const bbox = getCurrentBbox(map);
  elements.south.textContent = bbox.south;
  elements.west.textContent = bbox.west;
  elements.north.textContent = bbox.north;
  elements.east.textContent = bbox.east;
}

function updateDownloadAvailability(map, elements, getItinerary = () => null, getResolution = () => null) {
  if (activeRequest) {
    elements.stations.disabled = true;
    elements.route.disabled = true;
    return;
  }

  const itinerary = getItinerary();
  const canResolveStations = Array.isArray(itinerary) && itinerary.length > 0;
  const hasMatchedStations = collectMatchedStations(getResolution()).length > 0;

  elements.stations.disabled = !canResolveStations;
  elements.route.disabled = !canResolveStations || !hasStationResolutionData || !hasMatchedStations;

  if (!canResolveStations) {
    setStatus(elements, "先解析行程 JSON 后可解析点位。", false);
    return;
  }

  if (!lastFeatureCollection) {
    setStatus(elements, `可解析 ${itinerary.length} 段行程的站点点位。`, false);
    return;
  }

  if (hasRouteResolutionData) {
    setStatus(elements, "路线数据已解析，可重新解析点位或路线。", false);
    return;
  }

  if (hasStationResolutionData && !hasMatchedStations) {
    setStatus(elements, "点位数据已解析，但没有匹配站点，暂不能解析路线。", false);
    return;
  }

  if (hasStationResolutionData) {
    setStatus(elements, "点位数据已解析，可继续解析路线。", false);
  }
}

async function resolveStationData(map, elements, getItinerary, getResolution) {
  const itinerary = getItinerary();

  if (!Array.isArray(itinerary) || itinerary.length === 0 || activeRequest) {
    setStatus(elements, "请先解析有效的行程 JSON。", true);
    return;
  }

  const queryContext = buildStationQueryContext(itinerary);
  const query = buildStationQuery(itinerary);
  const controller = new AbortController();
  activeRequest = controller;

  elements.stations.disabled = true;
  elements.route.disabled = true;
  setStatus(elements, "正在从 Overpass API 解析行程站点点位...", false);

  try {
    const overpassData = await fetchOverpassData(query, controller.signal);
    const featureCollection = overpassToGeoJson(overpassData, queryContext, query);

    hasStationResolutionData = true;
    hasRouteResolutionData = false;
    lastFeatureCollection = featureCollection;
    lastStationFeatureCollection = featureCollection;
    renderRailwayData(map, featureCollection);
    dispatchRailwayDataChange(featureCollection);

    const summary = summarizeFeatures(featureCollection);
    elements.clear.disabled = featureCollection.features.length === 0;
    setStatus(elements, `已解析 ${summary.points} 个点位。可继续解析路线。`, false);
  } catch (error) {
    const message = error.name === "AbortError" ? "解析已取消。" : `点位解析失败：${error.message}`;
    setStatus(elements, message, true);
  } finally {
    activeRequest = null;
    updateDownloadAvailability(map, elements, getItinerary, getResolution);
  }
}

async function resolveRouteData(map, elements, getItinerary, getResolution) {
  const itinerary = getItinerary();
  const resolution = getResolution();

  if (!Array.isArray(itinerary) || itinerary.length === 0 || activeRequest) {
    setStatus(elements, "请先解析有效的行程 JSON。", true);
    return;
  }

  if (!hasStationResolutionData || !resolution?.available) {
    setStatus(elements, "请先点击“解析点位”。", true);
    return;
  }

  if (collectMatchedStations(resolution).length === 0) {
    setStatus(elements, "没有可用于路线解析的匹配站点。", true);
    return;
  }

  const queryContext = buildRouteQueryContext(itinerary, resolution);
  const query = buildRouteQuery(itinerary, resolution);
  const controller = new AbortController();
  activeRequest = controller;

  elements.stations.disabled = true;
  elements.route.disabled = true;
  setStatus(elements, "正在根据已解析点位获取并显示行程路线数据...", false);

  try {
    const overpassData = await fetchOverpassData(query, controller.signal);
    const routeFeatureCollection = overpassToGeoJson(overpassData, queryContext, query);
    const journeyFeatureCollection = buildJourneyFeatureCollection(
      itinerary,
      resolution,
      lastFeatureCollection,
      routeFeatureCollection
    );

    lastFeatureCollection = journeyFeatureCollection;
    hasRouteResolutionData = true;
    renderRailwayData(map, journeyFeatureCollection);
    dispatchRailwayDataChange(lastStationFeatureCollection);

    const summary = summarizeFeatures(journeyFeatureCollection);
    elements.clear.disabled = journeyFeatureCollection.features.length === 0;
    setStatus(elements, `路线数据已解析：${summary.journeySegments} 段行程区间，${summary.journeyMarkers} 个行程点。`, false);
  } catch (error) {
    const message = error.name === "AbortError" ? "解析已取消。" : `路线解析失败：${error.message}`;
    setStatus(elements, message, true);
  } finally {
    activeRequest = null;
    updateDownloadAvailability(map, elements, getItinerary, getResolution);
  }
}

function clearRailwayData(map, elements) {
  if (railwayLayer) {
    railwayLayer.removeFrom(map);
    railwayLayer = null;
  }

  lastFeatureCollection = null;
  lastStationFeatureCollection = null;
  hasStationResolutionData = false;
  hasRouteResolutionData = false;
  elements.clear.disabled = true;
  setStatus(elements, "已清除地图上的铁路数据。", false);
  dispatchRailwayDataChange(null);
}

function getCurrentBbox(map) {
  const bounds = map.getBounds();

  return {
    south: formatCoordinate(bounds.getSouth()),
    west: formatCoordinate(bounds.getWest()),
    north: formatCoordinate(bounds.getNorth()),
    east: formatCoordinate(bounds.getEast())
  };
}

function formatCoordinate(value) {
  return Number(value).toFixed(6);
}

function buildStationQuery(itinerary) {
  const clauses = new Set();

  for (const segment of itinerary) {
    const operatorFilter = buildTagFilter("operator", segment.operator);

    for (const stationName of segment.station_sequence) {
      for (const nameKey of ["name", "name:en", "name:ja-Latn", "official_name", "alt_name"]) {
        for (const variant of getStationNameVariants(stationName)) {
          clauses.add(`node["railway"="station"]${buildTagFilter(nameKey, variant)}${operatorFilter};`);
          clauses.add(`node["railway"="station"]${buildTagFilter(nameKey, variant)};`);
        }
      }
    }
  }

  return `[out:json][timeout:30];
(
  ${Array.from(clauses).join("\n  ")}
);
out geom;`;
}

function buildRouteQuery(itinerary, resolution) {
  const clauses = new Set();

  for (const segment of itinerary) {
    const operatorFilter = buildTagFilter("operator", segment.operator);
    const lineFilters = [
      buildTagFilter("name", segment.rail_line),
      buildTagFilter("ref", segment.rail_line)
    ];

    for (const lineFilter of lineFilters) {
      clauses.add(`way["railway"]${lineFilter}${operatorFilter};`);
      clauses.add(`relation["route"]${lineFilter}${operatorFilter};`);
      clauses.add(`relation["railway"]${lineFilter}${operatorFilter};`);
    }
  }

  for (const station of collectMatchedStations(resolution)) {
    clauses.add(`way["railway"](around:800,${station.lat},${station.lon});`);
  }

  return `[out:json][timeout:45];
(
  ${Array.from(clauses).join("\n  ")}
)->.routeMatches;
(.routeMatches; >;);
out geom;`;
}

function buildStationQueryContext(itinerary) {
  return {
    mode: "stations",
    routes: itinerary.map((segment) => ({
      route_id: segment.route_id,
      operator: segment.operator,
      station_sequence: segment.station_sequence
    }))
  };
}

function buildRouteQueryContext(itinerary, resolution) {
  return {
    mode: "route",
    routes: itinerary.map((segment) => ({
      route_id: segment.route_id,
      rail_line: segment.rail_line,
      operator: segment.operator,
      station_sequence: segment.station_sequence
    })),
    matchedStations: collectMatchedStations(resolution)
  };
}

function buildTagFilter(key, value) {
  return `["${escapeOverpassString(key)}"="${escapeOverpassString(value)}"]`;
}

function escapeOverpassString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function getStationNameVariants(stationName) {
  const base = String(stationName).trim();
  const variants = new Set([base, `${base} Station`]);
  const macronVariant = base
    .replace(/Chukagai/g, "Chūkagai")
    .replace(/chukagai/g, "chūkagai");

  variants.add(macronVariant);
  variants.add(`${macronVariant} Station`);

  if (base.toLowerCase() === "motomachi-chukagai") {
    [
      "Motomachi-Chūkagai Station",
      "Motomachi-Chukagai Station",
      "Motomachi-Chūkagai Station (Yamashita-kōen)",
      "Motomachi-Chukagai Station (Yamashita-koen)",
      "Motomachi-Chūkagai(Yamashita-Kōen)",
      "元町・中華街",
      "元町・中華街駅"
    ].forEach((variant) => variants.add(variant));
  }

  return Array.from(variants);
}

async function fetchOverpassData(query, signal) {
  const body = new URLSearchParams({ data: query });
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body,
    signal
  });

  if (!response.ok) {
    throw new Error(`Overpass API 返回 ${response.status}`);
  }

  return response.json();
}

function overpassToGeoJson(overpassData, queryContext, query) {
  const features = [];

  for (const element of overpassData.elements || []) {
    if (element.type === "node" && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
      features.push(createFeature("Point", [element.lon, element.lat], element));
    }

    if (element.type === "way" && Array.isArray(element.geometry) && element.geometry.length > 1) {
      features.push(createFeature("LineString", toCoordinates(element.geometry), element));
    }

    if (element.type === "relation" && Array.isArray(element.members)) {
      for (const member of element.members) {
        if (Array.isArray(member.geometry) && member.geometry.length > 1) {
          features.push(createFeature("LineString", toCoordinates(member.geometry), element, member));
        }
      }
    }
  }

  return {
    type: "FeatureCollection",
    properties: {
      source: "OpenStreetMap data via Overpass API",
      overpassEndpoint: OVERPASS_ENDPOINT,
      overpassQuery: query,
      queryContext,
      downloadedAt: new Date().toISOString()
    },
    features
  };
}

function createFeature(type, coordinates, element, member = null) {
  return {
    type: "Feature",
    properties: {
      osmType: element.type,
      osmId: element.id,
      relationMemberType: member?.type || null,
      relationMemberRef: member?.ref || null,
      relationMemberRole: member?.role || null,
      rawElement: element,
      rawRelationMember: member,
      ...(element.tags || {})
    },
    geometry: {
      type,
      coordinates
    }
  };
}

function toCoordinates(geometry) {
  return geometry.map((point) => [point.lon, point.lat]);
}

function renderRailwayData(map, featureCollection) {
  if (railwayLayer) {
    railwayLayer.removeFrom(map);
  }

  railwayLayer = L.geoJSON(featureCollection, {
    style: getFeatureStyle,
    pointToLayer: (feature, latlng) => createPointLayer(feature, latlng),
    onEachFeature: (feature, layer) => {
      layer.bindPopup(createPopupContent(feature), {
        maxWidth: 560,
        maxHeight: 420
      });
    }
  }).addTo(map);
}

function createPointLayer(feature, latlng) {
  if (feature.properties.journeyRole) {
    return L.marker(latlng, {
      icon: L.divIcon({
        className: `journey-marker ${feature.properties.journeyRole}`,
        html: `<span>${escapeHtml(feature.properties.journeyLabel)}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17]
      })
    });
  }

  return L.circleMarker(latlng, getPointStyle(feature));
}

function getFeatureStyle(feature) {
  if (feature.geometry.type === "Point") {
    return getPointStyle(feature);
  }

  return getLineStyle(feature);
}

function getLineStyle(feature) {
  if (feature.properties.journeySegment) {
    return {
      color: "#0f766e",
      weight: 7,
      opacity: 0.94,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  const isRelation = feature.properties.osmType === "relation";

  return {
    color: isRelation ? "#8f3d96" : "#c43828",
    weight: isRelation ? 4 : 3,
    opacity: 0.86,
    dashArray: isRelation ? "8 5" : null
  };
}

function getPointStyle(feature) {
  const visual = getNodeVisual(feature.properties.railway);

  return {
    radius: visual.radius,
    color: visual.color,
    fillColor: "#ffffff",
    fillOpacity: 0.94,
    weight: 3
  };
}

function getNodeVisual(railwayType) {
  const visuals = {
    station: { color: "#7c3aed", radius: 7 },
    halt: { color: "#0f8f5f", radius: 6 },
    tram_stop: { color: "#0f8f5f", radius: 6 },
    stop: { color: "#0f8f5f", radius: 6 },
    subway_entrance: { color: "#d97706", radius: 5 },
    level_crossing: { color: "#ca8a04", radius: 5 }
  };

  return visuals[railwayType] || { color: "#475569", radius: 5 };
}

function createPopupContent(feature) {
  const title = feature.properties.name || feature.properties.railway || "railway";
  const osmRef = `OSM ${feature.properties.osmType}/${feature.properties.osmId}`;
  const featureJson = JSON.stringify(feature, null, 2);

  return `
    <div class="railway-popup">
      <div>
        <div class="railway-popup-title">${escapeHtml(title)}</div>
        <div class="railway-popup-meta">${escapeHtml(osmRef)}</div>
      </div>
      <pre>${escapeHtml(featureJson)}</pre>
    </div>
  `;
}

function collectMatchedStations(resolution) {
  if (!resolution?.routeResolutions) {
    return [];
  }

  const stationsById = new Map();

  for (const route of resolution.routeResolutions) {
    for (const result of route.stationResults) {
      for (const match of result.matches) {
        const coordinates = match.feature.geometry.coordinates;
        stationsById.set(match.osmId, {
          osmId: match.osmId,
          name: match.name,
          operator: match.operator,
          lon: coordinates[0],
          lat: coordinates[1]
        });
      }
    }
  }

  return Array.from(stationsById.values());
}

function summarizeFeatures(featureCollection) {
  return featureCollection.features.reduce((summary, feature) => {
    summary.total += 1;

    if (feature.geometry.type === "Point") {
      summary.points += 1;
    }

    if (feature.geometry.type === "LineString") {
      summary.lines += 1;
    }

    if (feature.properties.journeySegment) {
      summary.journeySegments += 1;
    }

    if (feature.properties.journeyMarker) {
      summary.journeyMarkers += 1;
    }

    return summary;
  }, { total: 0, lines: 0, points: 0, journeySegments: 0, journeyMarkers: 0 });
}

function buildJourneyFeatureCollection(itinerary, resolution, stationFeatureCollection, routeFeatureCollection) {
  const graph = buildRailGraph(routeFeatureCollection);
  const journeyStops = buildJourneyStops(itinerary, resolution);
  const features = [];
  const warnings = [];
  const markerFeatures = buildJourneyMarkerFeatures(itinerary, journeyStops);

  for (const segment of journeyStops) {
    const resolvedStops = segment.stops.filter((stop) => stop.match);

    for (let index = 0; index < resolvedStops.length - 1; index += 1) {
      const from = resolvedStops[index];
      const to = resolvedStops[index + 1];
      const path = findGraphPath(graph, from.match.coordinates, to.match.coordinates);

      if (!path) {
        warnings.push(`No path: ${segment.route_id} ${from.stationName} -> ${to.stationName}`);
        continue;
      }

      features.push({
        type: "Feature",
        properties: {
          journeySegment: true,
          route_id: segment.route_id,
          rail_line: segment.rail_line,
          operator: segment.operator,
          from_station: from.stationName,
          to_station: to.stationName
        },
        geometry: {
          type: "LineString",
          coordinates: path
        }
      });
    }
  }

  features.push(...markerFeatures);

  return {
    type: "FeatureCollection",
    properties: {
      source: "OpenStreetMap data via Overpass API",
      overpassEndpoint: OVERPASS_ENDPOINT,
      queryContext: {
        mode: "journey-route",
        stationContext: stationFeatureCollection?.properties?.queryContext,
        routeContext: routeFeatureCollection?.properties?.queryContext
      },
      warnings,
      downloadedAt: new Date().toISOString()
    },
    features
  };
}

function buildJourneyStops(itinerary, resolution) {
  const resolutionByRoute = new Map(
    (resolution?.routeResolutions || []).map((route) => [route.route_id, route])
  );

  return itinerary.map((segment) => {
    const routeResolution = resolutionByRoute.get(segment.route_id);

    return {
      route_id: segment.route_id,
      rail_line: segment.rail_line,
      operator: segment.operator,
      stops: segment.station_sequence.map((stationName, index) => {
        const stationResult = routeResolution?.stationResults[index];
        return {
          stationName,
          match: pickStationMatch(stationResult)
        };
      })
    };
  });
}

function pickStationMatch(stationResult) {
  const match = stationResult?.matches?.[0];

  if (!match) {
    return null;
  }

  return {
    osmId: match.osmId,
    name: match.displayName || match.name || stationResult.stationName,
    operator: match.operator,
    coordinates: match.feature.geometry.coordinates
  };
}

function buildJourneyMarkerFeatures(itinerary, journeyStops) {
  const markers = new Map();
  const firstSegment = itinerary[0];
  const lastSegment = itinerary[itinerary.length - 1];
  const startName = firstSegment?.start_station;
  const endName = lastSegment?.arrive_station;
  const transfers = getTransfers(itinerary);

  for (const segment of journeyStops) {
    for (const stop of segment.stops) {
      if (!stop.match) {
        continue;
      }

      const key = normalizeStationName(stop.stationName);
      const existing = markers.get(key);
      const marker = existing || {
        stationName: stop.stationName,
        coordinates: stop.match.coordinates,
        osmId: stop.match.osmId,
        role: "passing",
        label: ""
      };

      if (normalizeStationName(stop.stationName) === normalizeStationName(startName)) {
        marker.role = "start";
        marker.label = "S";
      }

      if (normalizeStationName(stop.stationName) === normalizeStationName(endName)) {
        marker.role = "end";
        marker.label = "E";
      }

      const transferIndex = transfers.findIndex((transferName) => (
        normalizeStationName(transferName) === normalizeStationName(stop.stationName)
      ));

      if (transferIndex >= 0 && marker.role !== "start" && marker.role !== "end") {
        marker.role = "transfer";
        marker.label = `T${transferIndex + 1}`;
      }

      if (marker.role !== "passing") {
        markers.set(key, marker);
      }
    }
  }

  return Array.from(markers.values()).map((marker) => ({
    type: "Feature",
    properties: {
      journeyMarker: true,
      journeyRole: marker.role,
      journeyLabel: marker.label,
      name: marker.stationName,
      osmType: "node",
      osmId: marker.osmId
    },
    geometry: {
      type: "Point",
      coordinates: marker.coordinates
    }
  }));
}

function getTransfers(itinerary) {
  const transfers = [];

  for (let index = 0; index < itinerary.length - 1; index += 1) {
    if (normalizeStationName(itinerary[index].arrive_station) === normalizeStationName(itinerary[index + 1].start_station)) {
      transfers.push(itinerary[index].arrive_station);
    }
  }

  return transfers;
}

function normalizeStationName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildRailGraph(featureCollection) {
  const nodes = new Map();

  for (const feature of featureCollection.features || []) {
    if (feature.geometry?.type !== "LineString") {
      continue;
    }

    const coordinates = feature.geometry.coordinates;

    for (let index = 0; index < coordinates.length - 1; index += 1) {
      addGraphEdge(nodes, coordinates[index], coordinates[index + 1]);
    }
  }

  return {
    nodes
  };
}

function addGraphEdge(nodes, fromCoordinate, toCoordinate) {
  const fromKey = coordinateKey(fromCoordinate);
  const toKey = coordinateKey(toCoordinate);
  const distance = getDistanceMeters(fromCoordinate, toCoordinate);
  const fromNode = getGraphNode(nodes, fromKey, fromCoordinate);
  const toNode = getGraphNode(nodes, toKey, toCoordinate);

  fromNode.edges.push({ key: toKey, distance });
  toNode.edges.push({ key: fromKey, distance });
}

function getGraphNode(nodes, key, coordinate) {
  if (!nodes.has(key)) {
    nodes.set(key, {
      key,
      coordinate,
      edges: []
    });
  }

  return nodes.get(key);
}

function findGraphPath(graph, fromCoordinate, toCoordinate) {
  const startKey = findNearestGraphNodeKey(graph, fromCoordinate);
  const endKey = findNearestGraphNodeKey(graph, toCoordinate);

  if (!startKey || !endKey) {
    return null;
  }

  const pathKeys = shortestPath(graph, startKey, endKey);

  if (!pathKeys) {
    return null;
  }

  return pathKeys.map((key) => graph.nodes.get(key).coordinate);
}

function findNearestGraphNodeKey(graph, coordinate) {
  let nearestKey = null;
  let nearestDistance = Infinity;

  for (const node of graph.nodes.values()) {
    const distance = getDistanceMeters(coordinate, node.coordinate);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestKey = node.key;
    }
  }

  return nearestDistance <= 1500 ? nearestKey : null;
}

function shortestPath(graph, startKey, endKey) {
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const visited = new Set();
  const queue = [{ key: startKey, distance: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.distance - b.distance);
    const current = queue.shift();

    if (visited.has(current.key)) {
      continue;
    }

    if (current.key === endKey) {
      return reconstructPath(previous, endKey);
    }

    visited.add(current.key);

    for (const edge of graph.nodes.get(current.key).edges) {
      if (visited.has(edge.key)) {
        continue;
      }

      const nextDistance = current.distance + edge.distance;

      if (nextDistance < (distances.get(edge.key) ?? Infinity)) {
        distances.set(edge.key, nextDistance);
        previous.set(edge.key, current.key);
        queue.push({ key: edge.key, distance: nextDistance });
      }
    }
  }

  return null;
}

function reconstructPath(previous, endKey) {
  const path = [endKey];
  let current = endKey;

  while (previous.has(current)) {
    current = previous.get(current);
    path.unshift(current);
  }

  return path;
}

function coordinateKey(coordinate) {
  return `${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`;
}

function getDistanceMeters(fromCoordinate, toCoordinate) {
  const earthRadius = 6371000;
  const fromLat = toRadians(fromCoordinate[1]);
  const toLat = toRadians(toCoordinate[1]);
  const deltaLat = toRadians(toCoordinate[1] - fromCoordinate[1]);
  const deltaLon = toRadians(toCoordinate[0] - fromCoordinate[0]);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function setStatus(elements, message, isError) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function escapeHtml(value) {
  const container = document.createElement("div");
  container.textContent = value;
  return container.innerHTML;
}

function dispatchRailwayDataChange(featureCollection) {
  document.dispatchEvent(new CustomEvent("railway-data:change", {
    detail: {
      featureCollection,
      available: Boolean(featureCollection)
    }
  }));
}

export function getCurrentRailwayData() {
  return lastStationFeatureCollection || lastFeatureCollection;
}
