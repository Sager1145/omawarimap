export function downloadGeoJson(routes, stations) {
  const osmRoutes = routes.filter((route) => route.properties?.fallback !== true);
  const stationFeatures = stations.map((station) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [station.lon, station.lat]
    },
    properties: {
      kind: "station",
      station_id: station.station_id,
      name: station.name,
      roles: station.roles,
      leg_ids: station.leg_ids,
      osm_type: station.osm_type || "",
      osm_id: station.osm_id || "",
      confidence_score: station.confidence_score ?? null
    }
  }));

  downloadJson("omawari_route.geojson", {
    type: "FeatureCollection",
    metadata: attributionMetadata(),
    features: [...osmRoutes, ...stationFeatures]
  });
}

export function downloadProject(itinerary, routes, stations, debug) {
  downloadJson("omawari_project.json", {
    metadata: attributionMetadata(),
    itinerary,
    routes,
    stations,
    debug,
    saved_at: new Date().toISOString()
  });
}

export function downloadStationsCsv(stations) {
  const rows = [
    ["role", "station_name", "lat", "lon", "leg_ids", "operator", "osm_id", "confidence"]
  ];
  for (const station of stations) {
    rows.push([
      station.roles.join("|"),
      station.name,
      station.lat,
      station.lon,
      station.leg_ids.join("|"),
      station.operator || "",
      station.osm_id || "",
      station.confidence_score ?? ""
    ]);
  }
  downloadBlob("omawari_stations.csv", rows.map(csvRow).join("\n"), "text/csv;charset=utf-8");
}

function attributionMetadata() {
  return {
    attribution: "Map data © OpenStreetMap contributors. OpenStreetMap data is available under the Open Database License.",
    osm_license: "ODbL",
    generated_by: "omawari-map"
  };
}

function csvRow(row) {
  return row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",");
}

function downloadJson(filename, data) {
  downloadBlob(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
}

function downloadBlob(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
