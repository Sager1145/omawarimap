export function normalizeOverpass(overpassJson) {
  const elements = overpassJson?.elements || [];
  const nodes = new Map();
  const ways = [];
  const relations = [];
  const wayRelations = new Map();
  const stations = [];
  const platforms = [];

  for (const element of elements) {
    if (element.type === "node") nodes.set(element.id, element);
  }

  for (const element of elements) {
    if (element.type === "way") {
      ways.push(element);
      if (isStationLike(element)) {
        const center = getWayCenter(element, nodes);
        if (center) stations.push(toStationFeature(element, center));
      } else if (isPlatformLike(element)) {
        const center = getWayCenter(element, nodes);
        if (center) platforms.push(toPlatformFeature(element, center));
      }
    } else if (element.type === "relation") {
      relations.push(element);
      for (const member of element.members || []) {
        if (member.type !== "way") continue;
        if (!wayRelations.has(member.ref)) wayRelations.set(member.ref, []);
        wayRelations.get(member.ref).push({
          relation_id: element.id,
          tags: element.tags || {}
        });
      }
    } else if (element.type === "node") {
      if (isStationLike(element)) {
        stations.push(toStationFeature(element, [element.lat, element.lon]));
      } else if (isPlatformLike(element)) {
        platforms.push(toPlatformFeature(element, [element.lat, element.lon]));
      }
    }
  }

  return { nodes, ways, relations, wayRelations, stations, platforms };
}

export function railwayWays(osm) {
  return osm.ways.filter((way) => way.tags?.railway === "rail" && !isExcludedRail(way.tags));
}

function isStationLike(element) {
  return /^(station|halt)$/u.test(element.tags?.railway || "");
}

function isPlatformLike(element) {
  return /^(platform|platform_edge)$/u.test(element.tags?.railway || "");
}

function isExcludedRail(tags) {
  return ["abandoned", "disused", "construction"].includes(tags.railway);
}

function getWayCenter(way, nodes) {
  const coords = (way.nodes || [])
    .map(function(id) { return nodes.get(id); })
    .filter(function(node) { return Number.isFinite(node?.lat) && Number.isFinite(node?.lon); });
  if (!coords.length) return null;
  const lat = coords.reduce(function(sum, node) { return sum + node.lat; }, 0) / coords.length;
  const lon = coords.reduce(function(sum, node) { return sum + node.lon; }, 0) / coords.length;
  return [lat, lon];
}

function toStationFeature(element, center) {
  return {
    station_id: element.type + "/" + element.id,
    osm_type: element.type,
    osm_id: element.id,
    name: element.tags?.["name:ja"] || element.tags?.name || element.tags?.["name:en"] || ("OSM " + element.id),
    name_ja: element.tags?.["name:ja"],
    name_en: element.tags?.["name:en"],
    operator: element.tags?.operator,
    lat: center[0],
    lon: center[1],
    roles: [],
    leg_ids: [],
    tags: element.tags || {}
  };
}

function toPlatformFeature(element, center) {
  return {
    platform_id: element.type + "/" + element.id,
    osm_type: element.type,
    osm_id: element.id,
    ref: element.tags?.ref || "",
    name: element.tags?.["name:ja"] || element.tags?.name || element.tags?.["name:en"] || "",
    operator: element.tags?.operator,
    lat: center[0],
    lon: center[1],
    tags: element.tags || {}
  };
}
