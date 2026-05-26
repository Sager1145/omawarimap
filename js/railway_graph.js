import { railwayWays } from "./osm_normalizer.js";

export function buildRailwayGraph(osm) {
  const graphNodes = new Map();
  const adjacency = new Map();
  const edges = [];

  for (const way of railwayWays(osm)) {
    const ids = way.nodes || [];
    for (let i = 0; i < ids.length - 1; i += 1) {
      const a = osm.nodes.get(ids[i]);
      const b = osm.nodes.get(ids[i + 1]);
      if (!a || !b) continue;

      const from = String(a.id);
      const to = String(b.id);
      graphNodes.set(from, { id: from, lat: a.lat, lon: a.lon });
      graphNodes.set(to, { id: to, lat: b.lat, lon: b.lon });

      const base = {
        length_m: haversine([a.lat, a.lon], [b.lat, b.lon]),
        geometry: [[a.lat, a.lon], [b.lat, b.lon]],
        osm_way_id: way.id,
        tags: way.tags || {},
        route_relation_ids: (osm.wayRelations?.get(way.id) || []).map((relation) => relation.relation_id),
        route_relation_tags: (osm.wayRelations?.get(way.id) || []).map((relation) => relation.tags)
      };

      addEdge(adjacency, edges, { ...base, edge_id: `${way.id}:${from}:${to}`, from_node: from, to_node: to });
      addEdge(adjacency, edges, { ...base, edge_id: `${way.id}:${to}:${from}`, from_node: to, to_node: from, geometry: [...base.geometry].reverse() });
    }
  }

  return { nodes: graphNodes, adjacency, edges };
}

export function nearestGraphNodes(graph, coord, limit = 8) {
  if (!coord) return [];
  return [...graph.nodes.values()]
    .map((node) => ({
      ...node,
      distance_m: haversine(coord, [node.lat, node.lon])
    }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

export function haversine(a, b) {
  const radius = 6371000;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const lat1 = radians(a[0]);
  const lat2 = radians(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function addEdge(adjacency, edges, edge) {
  edges.push(edge);
  if (!adjacency.has(edge.from_node)) adjacency.set(edge.from_node, []);
  adjacency.get(edge.from_node).push(edge);
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}
