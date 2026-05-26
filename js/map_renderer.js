import { routeColor } from "./itinerary_model.js";

export function createMap(elementId) {
  const container = document.getElementById(elementId);
  const map = L.map(container, {
    zoomControl: true,
    preferCanvas: false,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false
  }).setView([35.681236, 139.767125], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const layers = {
    routes: L.layerGroup().addTo(map),
    stations: L.layerGroup().addTo(map),
    debug: L.layerGroup().addTo(map)
  };

  const resize = () => {
    map.invalidateSize({ pan: false });
  };

  window.addEventListener("resize", resize);
  requestAnimationFrame(resize);

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(resize);
    observer.observe(container);
  }

  return { map, layers };
}

export function renderRoutes(mapState, routes, onSelectLeg) {
  mapState.layers.routes.clearLayers();
  const bounds = [];
  const displayRoutes = routes.filter((feature) => {
    const props = feature.properties || {};
    return props.fallback !== true && Array.isArray(props.osm_way_ids) && props.osm_way_ids.length > 0;
  });

  displayRoutes.forEach((feature, index) => {
    const color = feature.properties.color || routeColor(index);
    const latLngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    bounds.push(...latLngs);

    L.polyline(latLngs, {
      color,
      weight: 6,
      opacity: 0.9
    })
      .bindPopup(routePopup(feature))
      .on("click", () => onSelectLeg?.(feature.properties.leg_id))
      .addTo(mapState.layers.routes);
  });

  requestAnimationFrame(() => {
    mapState.map.invalidateSize({ pan: false });
    if (bounds.length) {
      mapState.map.fitBounds(bounds, {
        animate: false,
        padding: [32, 32],
        maxZoom: 14
      });
    }
  });
}

export function renderStations(mapState, stations) {
  mapState.layers.stations.clearLayers();

  for (const station of stations) {
    // Skip stations whose coordinates have not been resolved yet
    if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;

    const role = station.roles.includes("destination")
      ? "destination"
      : station.roles.includes("origin")
        ? "origin"
        : station.roles.includes("transfer")
      ? "transfer"
      : station.roles.includes("pass_through")
        ? "pass"
        : "normal";
    const label = stationLabel(role, station);

    L.marker([station.lat, station.lon], {
      icon: L.divIcon({
        className: "station-icon-anchor",
        html: `<span class="station-marker ${role}" data-lat="${station.lat}" data-lon="${station.lon}" data-source="${station.display_source || ""}" data-osm-station="${station.matched_osm_station_id || station.station_id || ""}">${label}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
        popupAnchor: [0, -14]
      })
    })
      .bindPopup(stationPopup(station))
      .addTo(mapState.layers.stations);
  }
}

export function fitToStations(mapState, stations) {
  const points = stations
    .filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lon))
    .map((station) => [station.lat, station.lon]);

  if (!points.length) return;
  requestAnimationFrame(() => {
    mapState.map.invalidateSize({ pan: false });
    mapState.map.fitBounds(points, {
      animate: false,
      padding: [40, 40],
      maxZoom: 13
    });
  });
}

export function highlightLeg(mapState, legId) {
  mapState.layers.routes.eachLayer((layer) => {
    const popup = layer.getPopup()?.getContent?.() || "";
    const active = popup.includes(`data-leg="${legId}"`);
    layer.setStyle({
      weight: active ? 9 : 5,
      opacity: active ? 1 : 0.62
    });
    if (active) layer.bringToFront();
  });
}

function routePopup(feature) {
  const props = feature.properties;
  return `
    <div data-leg="${props.leg_id}">
      <strong>${escapeHtml(props.from_station)} -> ${escapeHtml(props.to_station)}</strong><br>
      ${escapeHtml([props.line_name, props.train_number].filter(Boolean).join(" / "))}<br>
      ${escapeHtml([props.depart_time, props.arrive_time].filter(Boolean).join(" - "))}<br>
      confidence: ${Math.round((props.confidence_score || 0) * 100)}%<br>
      OSM ways: ${props.osm_way_ids?.length || 0}
    </div>
  `;
}

function stationPopup(station) {
  const sourceLabel = {
    rail_node: "route endpoint (on track)",
    platform_coord: "platform (OSM)",
    osm_station: "station centre (OSM)",
    json_coord: "override coord (JSON)"
  }[station.display_source] || station.display_source || "";

  return `
    <strong>${escapeHtml(station.name)}</strong><br>
    role: ${station.roles.map(translateRole).join(" / ")}<br>
    ${station.transfer_order ? `transfer: T${station.transfer_order} (${station.transfer_from_leg_id} -> ${station.transfer_to_leg_id})<br>` : ""}
    leg: ${station.leg_ids.join(", ")}<br>
    ${station.display_on_route ? (station.display_source === "rail_node" ? `on track (${sourceLabel})<br>` : `projected to rail (${station.display_offset_m}m from ${sourceLabel})<br>`) : ""}
    ${station.matched_osm_station_id ? `OSM station: ${escapeHtml(station.matched_osm_name || station.matched_osm_station_id)} (${station.matched_osm_station_id})<br>` : ""}
    ${station.osm_id ? `OSM: ${station.osm_type}/${station.osm_id}<br>` : ""}
    confidence: ${Math.round((station.confidence_score ?? 0.5) * 100)}%
  `;
}

function stationLabel(role, station = {}) {
  if (role === "destination") return "D";
  if (role === "origin") return "O";
  if (role === "transfer") return `T${station.transfer_order || ""}`;
  if (role === "pass") return "";
  return "S";
}

function translateRole(role) {
  return {
    origin: "origin",
    destination: "destination",
    board: "board",
    alight: "alight",
    transfer: "transfer",
    pass_through: "pass"
  }[role] || role;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
