import { normalizeLineName, routeColor } from "./itinerary_model.js";
import { haversine, nearestGraphNodes } from "./railway_graph.js";

const LINE_ALIASES = {
  "chuo line rapid": ["中央線", "中央快速線", "中央本線", "chuo", "chuorapid"],
  "chuo rapid line": ["中央線", "中央快速線", "中央本線", "chuo", "chuorapid"],
  "chuo-sobu line": ["中央総武線", "中央・総武線", "総武線", "総武本線", "sobu", "chuo"],
  "yamanote line": ["山手線", "yamanote"]
};

export function solveLegRoute(graph, leg, index) {
  if (index === undefined) index = 0;
  const starts = nearestGraphNodes(graph, leg.from_coord, 80).filter(function(n) { return n.distance_m <= 1600; });
  const goals  = nearestGraphNodes(graph, leg.to_coord,   80).filter(function(n) { return n.distance_m <= 1600; });

  if (!starts.length || !goals.length) {
    throw new Error(leg.from_station + " -> " + leg.to_station + " has no railway graph nodes near one or both stations.");
  }

  const best = dijkstra(graph, starts, goals, leg);
  if (!best) {
    throw new Error(leg.from_station + " -> " + leg.to_station + " has no connected OSM railway path.");
  }

  const pathLengthM = best.edges.reduce(function(sum, e) { return sum + e.length_m; }, 0);
  const directDistanceM = (leg.from_coord && leg.to_coord) ? haversine(leg.from_coord, leg.to_coord) : 0;
  const maxReasonableM = directDistanceM ? Math.max(directDistanceM * 3.8, directDistanceM + 2600) : Infinity;

  if (pathLengthM > maxReasonableM) {
    throw new Error(
      leg.from_station + " -> " + leg.to_station +
      " solved path is too long (" + Math.round(pathLengthM) + "m vs " +
      Math.round(directDistanceM) + "m direct), so it was rejected."
    );
  }

  // Pure railway geometry — no station-centre connector spurs.
  // Station markers are projected onto this polyline separately in station_detector.js.
  const coords = mergeEdgeGeometry(best.edges);
  if (coords.length < 2) {
    throw new Error(leg.from_station + " -> " + leg.to_station + " produced an empty OSM path.");
  }

  const confidence = scoreRoute(best.edges, leg, pathLengthM, directDistanceM);

  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: coords.map(function(c) { return [c[1], c[0]]; })
    },
    properties: {
      leg_id: leg.leg_id,
      color: routeColor(index),
      train_name: leg.train_name || "",
      train_number: leg.train_number || "",
      line_name: leg.line_name || "",
      operator: leg.operator || "",
      from_station: leg.from_station,
      to_station: leg.to_station,
      depart_time: leg.depart_time || "",
      arrive_time: leg.arrive_time || "",
      osm_way_ids: Array.from(new Set(best.edges.map(function(e) { return e.osm_way_id; }))),
      osm_relation_ids: Array.from(new Set(best.edges.flatMap(function(e) { return e.route_relation_ids || []; }))),
      data_source: "OpenStreetMap railway=rail",
      open_data: true,
      path_length_m: Math.round(pathLengthM),
      direct_distance_m: Math.round(directDistanceM),
      confidence_score: confidence,
      fallback: false,
      warnings: confidence < 0.6 ? ["OSM path was found, but line/operator matching confidence is low."] : []
    }
  };
}

function dijkstra(graph, starts, goals, leg) {
  const goalById = new Map(goals.map(function(g) { return [g.id, g]; }));
  const queue = starts.map(function(s) { return { id: s.id, cost: s.distance_m * 2, start: s }; });
  const costs = new Map(queue.map(function(item) { return [item.id, item.cost]; }));
  const previous = new Map();
  let best = null;

  while (queue.length) {
    queue.sort(function(a, b) { return a.cost - b.cost; });
    const current = queue.shift();
    if (current.cost !== costs.get(current.id)) continue;
    if (best && current.cost > best.totalCost) break;

    const goal = goalById.get(current.id);
    if (goal) {
      const candidate = reconstruct(previous, current.id, current.cost + goal.distance_m * 2);
      if (!best || candidate.totalCost < best.totalCost) best = candidate;
      continue;
    }

    for (const edge of graph.adjacency.get(current.id) || []) {
      const nextCost = current.cost + edgeCost(edge, leg);
      if (nextCost < (costs.get(edge.to_node) !== undefined ? costs.get(edge.to_node) : Infinity)) {
        costs.set(edge.to_node, nextCost);
        previous.set(edge.to_node, { node: current.id, edge });
        queue.push({ id: edge.to_node, cost: nextCost });
      }
    }
  }

  return best;
}

function reconstruct(previous, goalId, totalCost) {
  const edges = [];
  let cursor = goalId;
  while (previous.has(cursor)) {
    const step = previous.get(cursor);
    edges.push(step.edge);
    cursor = step.node;
  }
  edges.reverse();
  return { edges, totalCost };
}

function edgeCost(edge, leg) {
  const tags = edge.tags || {};
  let penalty = 0;
  const lineTokens = lineTokensFor(leg.line_name);
  const edgeText = normalizeLineName([
    tags.name,
    tags.ref,
    tags.operator,
    ...(edge.route_relation_tags || []).flatMap(function(rt) {
      return [rt.name, rt.ref, rt.operator, rt.network];
    })
  ].filter(Boolean).join(" "));

  if (lineTokens.length && edgeText) {
    if (!lineTokens.some(function(token) { return edgeText.includes(token) || token.includes(edgeText); })) {
      penalty += 1400;
    }
  } else if (lineTokens.length) {
    penalty += 90;
  }

  const edgeOperator   = normalizeLineName(tags.operator);
  const targetOperator = normalizeLineName(leg.operator);
  if (targetOperator && edgeOperator &&
      !edgeOperator.includes(targetOperator) && !targetOperator.includes(edgeOperator)) {
    penalty += 500;
  }

  if (["yard", "siding", "spur", "crossover"].includes(tags.service)) penalty += 2600;
  if (tags.usage === "freight") penalty += 1600;

  return edge.length_m + penalty;
}

function mergeEdgeGeometry(edges) {
  const coords = [];
  for (const edge of edges) {
    for (const coord of edge.geometry) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== coord[0] || last[1] !== coord[1]) coords.push(coord);
    }
  }
  return coords;
}

function scoreRoute(edges, leg, pathLengthM, directDistanceM) {
  if (!edges.length) return 0;
  const lineTokens = lineTokensFor(leg.line_name);
  let matched = 0;
  let penalized = 0;

  for (const edge of edges) {
    const tags = edge.tags || {};
    const edgeText = normalizeLineName([
      tags.name,
      tags.ref,
      ...(edge.route_relation_tags || []).flatMap(function(rt) { return [rt.name, rt.ref]; })
    ].filter(Boolean).join(" "));

    if (!lineTokens.length || !edgeText ||
        lineTokens.some(function(token) { return edgeText.includes(token) || token.includes(edgeText); })) {
      matched += 1;
    }
    if (["yard", "siding", "spur", "crossover"].includes(tags.service)) penalized += 2;
  }

  const lineScore   = matched / edges.length;
  const detourScore = directDistanceM
    ? Math.max(0, 1 - Math.max(0, pathLengthM / directDistanceM - 1.15) / 2.5)
    : 0.75;
  return Math.max(0.1, Math.min(0.99, lineScore * 0.75 + detourScore * 0.25 - penalized / edges.length / 2));
}

function lineTokensFor(lineName) {
  if (lineName === undefined) lineName = "";
  const normalized = normalizeLineName(lineName);
  const aliases = LINE_ALIASES[String(lineName).trim().toLowerCase()] || [];
  return Array.from(new Set([normalized].concat(aliases.map(normalizeLineName)).filter(Boolean)));
}
