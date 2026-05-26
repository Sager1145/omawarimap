import {
  collectWarnings,
  hydrateItinerary,
  legLabel
} from "./itinerary_model.js";
import {
  formatJson,
  parseAndValidateJson,
  schemaText,
  templateJson
} from "./json_language.js";
import { extractPdfText, parseItineraryText } from "./pdf_parser.js";
import { fetchRailwayDataForLeg } from "./osm_downloader.js";
import { normalizeOverpass } from "./osm_normalizer.js";
import { buildRailwayGraph } from "./railway_graph.js";
import { solveLegRoute } from "./route_solver.js";
import { buildStationFeatures } from "./station_detector.js?v=20260526-rail-node-2";
import { ensureLegCoordinates, resolvePlatformFromOsmData } from "./station_matcher.js";
import { createMap, fitToStations, highlightLeg, renderRoutes, renderStations } from "./map_renderer.js?v=20260526-rail-node-2";
import { downloadGeoJson, downloadProject, downloadStationsCsv } from "./export_tools.js";

const JSON_EDITOR_STORAGE_KEY = "omawari-json-editor:v1";

const state = {
  itinerary: null,
  routes: [],
  stations: [],
  osmStations: [],
  debug: {
    messages: [],
    overpass: []
  },
  selectedLegId: null,
  syncingEditor: false
};

const mapState = createMap("map");
const els = {
  jsonInput: document.querySelector("#jsonInput"),
  pdfInput: document.querySelector("#pdfInput"),
  loadSampleButton: document.querySelector("#loadSampleButton"),
  showNodesButton: document.querySelector("#showNodesButton"),
  solveButton: document.querySelector("#solveButton"),
  exportGeojsonButton: document.querySelector("#exportGeojsonButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  exportProjectButton: document.querySelector("#exportProjectButton"),
  parseTextButton: document.querySelector("#parseTextButton"),
  jsonEditor: document.querySelector("#jsonEditor"),
  jsonStatus: document.querySelector("#jsonStatus"),
  jsonMessages: document.querySelector("#jsonMessages"),
  jsonSchemaView: document.querySelector("#jsonSchemaView"),
  jsonValidateButton: document.querySelector("#jsonValidateButton"),
  jsonFormatButton: document.querySelector("#jsonFormatButton"),
  jsonApplyButton: document.querySelector("#jsonApplyButton"),
  jsonTemplateButton: document.querySelector("#jsonTemplateButton"),
  legList: document.querySelector("#legList"),
  tripMeta: document.querySelector("#tripMeta"),
  warnings: document.querySelector("#warnings"),
  debugOutput: document.querySelector("#debugOutput"),
  pdfStatus: document.querySelector("#pdfStatus"),
  pdfTextPreview: document.querySelector("#pdfTextPreview"),
  statusBadge: document.querySelector("#statusBadge")
};

wireEvents();
initializeJsonEditor();
loadSample();

function wireEvents() {
  els.loadSampleButton.addEventListener("click", loadSample);
  els.jsonInput.addEventListener("change", handleJsonInput);
  els.pdfInput.addEventListener("change", handlePdfInput);
  els.parseTextButton.addEventListener("click", parseTextPreview);
  els.showNodesButton.addEventListener("click", showStationNodes);
  els.solveButton.addEventListener("click", solveWithOsm);
  els.exportGeojsonButton.addEventListener("click", () => downloadGeoJson(state.routes, state.stations));
  els.exportCsvButton.addEventListener("click", () => downloadStationsCsv(state.stations));
  els.exportProjectButton.addEventListener("click", () => downloadProject(state.itinerary, state.routes, state.stations, state.debug));
  els.jsonValidateButton.addEventListener("click", validateJsonEditor);
  els.jsonFormatButton.addEventListener("click", formatJsonEditor);
  els.jsonApplyButton.addEventListener("click", applyJsonEditor);
  els.jsonTemplateButton.addEventListener("click", insertJsonTemplate);
  els.jsonEditor.addEventListener("input", handleJsonEditorInput);
  els.jsonEditor.addEventListener("keydown", handleJsonEditorKeys);
}

function initializeJsonEditor() {
  els.jsonSchemaView.textContent = schemaText();
  const saved = localStorage.getItem(JSON_EDITOR_STORAGE_KEY);
  els.jsonEditor.value = saved || templateJson();
  validateJsonEditor({ silent: true });
}

async function loadSample() {
  setBusy("Loading sample");
  try {
    const response = await fetch("data/sample_itinerary.json", { cache: "no-store" });
    const json = await response.json();
    setItinerary(hydrateItinerary(json), { syncEditor: true });
    setStatus("Ready");
  } catch (error) {
    reportError(error);
  }
}

async function handleJsonInput(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy("Reading JSON");
  try {
    const text = await file.text();
    els.jsonEditor.value = text;
    localStorage.setItem(JSON_EDITOR_STORAGE_KEY, text);
    applyJsonEditor();
  } catch (error) {
    reportError(error);
  } finally {
    event.target.value = "";
  }
}

async function handlePdfInput(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy("Reading PDF");
  try {
    const text = await extractPdfText(file);
    els.pdfTextPreview.value = text;
    els.pdfStatus.textContent = `${file.name} / ${text.length} chars`;
    const draft = hydrateItinerary(parseItineraryText(text));
    if (draft.legs.length) setItinerary(draft, { syncEditor: true });
    setStatus("PDF loaded");
  } catch (error) {
    reportError(error);
  } finally {
    event.target.value = "";
  }
}

function parseTextPreview() {
  try {
    const draft = hydrateItinerary(parseItineraryText(els.pdfTextPreview.value));
    setItinerary(draft, { syncEditor: true });
    setStatus("Text parsed");
  } catch (error) {
    reportError(error);
  }
}

function applyJsonEditor() {
  const result = parseAndValidateJson(els.jsonEditor.value);
  renderJsonValidation(result);
  if (!result.ok) return;

  try {
    localStorage.setItem(JSON_EDITOR_STORAGE_KEY, els.jsonEditor.value);
    setItinerary(hydrateItinerary(result.value), { syncEditor: false });
    setStatus("JSON applied");
  } catch (error) {
    reportError(error);
  }
}

function validateJsonEditor(options = {}) {
  const result = parseAndValidateJson(els.jsonEditor.value);
  renderJsonValidation(result);
  if (!options.silent && result.ok) setStatus("JSON valid");
  return result;
}

function formatJsonEditor() {
  const result = parseAndValidateJson(els.jsonEditor.value);
  renderJsonValidation(result);
  if (!result.ok) return;
  els.jsonEditor.value = formatJson(result.value);
  localStorage.setItem(JSON_EDITOR_STORAGE_KEY, els.jsonEditor.value);
  renderJsonValidation(parseAndValidateJson(els.jsonEditor.value));
  setStatus("JSON formatted");
}

function insertJsonTemplate() {
  els.jsonEditor.value = templateJson();
  localStorage.setItem(JSON_EDITOR_STORAGE_KEY, els.jsonEditor.value);
  renderJsonValidation(parseAndValidateJson(els.jsonEditor.value));
  setStatus("Template inserted");
}

function handleJsonEditorInput() {
  if (state.syncingEditor) return;
  localStorage.setItem(JSON_EDITOR_STORAGE_KEY, els.jsonEditor.value);
  renderJsonValidation(parseAndValidateJson(els.jsonEditor.value), { compact: true });
}

function handleJsonEditorKeys(event) {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = els.jsonEditor.selectionStart;
    const end = els.jsonEditor.selectionEnd;
    els.jsonEditor.setRangeText("  ", start, end, "end");
    handleJsonEditorInput();
  }

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    applyJsonEditor();
  }
}

function renderJsonValidation(result, options = {}) {
  els.jsonEditor.classList.toggle("is-valid", result.ok);
  els.jsonEditor.classList.toggle("is-invalid", !result.ok);
  els.jsonStatus.textContent = result.ok ? "Valid JSON" : "Fix JSON";

  const messages = [
    ...(result.errors || []).map((item) => ({ type: "error", ...item })),
    ...(result.warnings || []).map((item) => ({ type: "warning", ...item }))
  ];

  if (options.compact && messages.length > 4) {
    const hidden = messages.length - 4;
    messages.splice(4, messages.length - 4, {
      type: "warning",
      path: "$",
      message: `${hidden} more issue(s). Click Validate for details.`
    });
  }

  if (!messages.length) {
    messages.push({
      type: "info",
      path: "$",
      message: "JSON is valid and can be applied to the map."
    });
  }

  els.jsonMessages.innerHTML = "";
  for (const item of messages) {
    const div = document.createElement("div");
    div.className = `json-message ${item.type}`;
    div.textContent = `${item.path}: ${item.message}`;
    els.jsonMessages.append(div);
  }
}

function setItinerary(itinerary, options = {}) {
  state.itinerary = itinerary;
  state.debug.messages = [];
  state.debug.overpass = [];
  state.osmStations = [];
  state.routes = [];
  state.stations = buildStationFeatures(itinerary, [], []);
  state.selectedLegId = itinerary.legs[0]?.leg_id || null;

  if (options.syncEditor) {
    state.syncingEditor = true;
    els.jsonEditor.value = formatJson({
      $schema: "https://omawari-map.local/schema/itinerary.v1.json",
      type: "omawari.itinerary.v1",
      trip_title: itinerary.trip_title,
      date: itinerary.date,
      source: itinerary.source,
      legs: itinerary.legs
    });
    localStorage.setItem(JSON_EDITOR_STORAGE_KEY, els.jsonEditor.value);
    renderJsonValidation(parseAndValidateJson(els.jsonEditor.value), { compact: true });
    state.syncingEditor = false;
  }

  renderAll();
}

/**
 * Resolve station coordinates via Overpass station search (operator-aware)
 * and display the resulting nodes on the map — without downloading the full
 * corridor OSM data or solving any routes.
 */
async function showStationNodes() {
  if (!state.itinerary) return;
  setBusy("Resolving stations");
  els.showNodesButton.disabled = true;

  try {
    const updatedLegs = [];

    for (let index = 0; index < state.itinerary.legs.length; index += 1) {
      const leg = state.itinerary.legs[index];
      setBusy(`Searching: ${leg.from_station} / ${leg.to_station}`);
      try {
        const resolved = await ensureLegCoordinates(leg);
        updatedLegs.push(resolved);
      } catch (err) {
        state.debug.messages.push({ leg_id: leg.leg_id, level: "warning", message: err.message });
        updatedLegs.push(leg);
      }
    }

    state.itinerary = hydrateItinerary({ ...state.itinerary, legs: updatedLegs });
    // Keep existing solved routes; rebuild station features with new coords.
    state.stations = buildStationFeatures(state.itinerary, state.routes, state.osmStations);
    setStatus("Stations resolved");
    renderAll();
  } catch (error) {
    reportError(error);
  } finally {
    els.showNodesButton.disabled = false;
  }
}

async function solveWithOsm() {
  if (!state.itinerary) return;
  setBusy("Downloading OSM");
  els.solveButton.disabled = true;

  try {
    const solvedRoutes = [];
    const osmStations = [];
    const updatedLegs = [];

    for (let index = 0; index < state.itinerary.legs.length; index += 1) {
      const originalLeg = state.itinerary.legs[index];
      setBusy(`Solving ${originalLeg.from_station} -> ${originalLeg.to_station}`);
      const leg = await ensureLegCoordinates(originalLeg);
      updatedLegs.push(leg);

      try {
        const result = await fetchRailwayDataForLeg(leg);
        const osm = normalizeOverpass(result.data);

        // Refine station coords using the corridor's own OSM station data.
        // This is more accurate than the global Overpass search in ensureLegCoordinates
        // because the station is confirmed to be on this specific route segment.
        // Also resolves platform coords if depart_platform / arrive_platform are set.
        let resolvedLeg = resolveLegCoordsFromOsm(leg, osm.stations, osm.platforms || []);
        updatedLegs[updatedLegs.length - 1] = resolvedLeg;

        const graph = buildRailwayGraph(osm);
        const route = solveLegRoute(graph, resolvedLeg, index);

        // Use solved route endpoints as definitive station positions.
        // These coords are guaranteed to lie exactly on the railway track,
        // which eliminates projection errors for origin/destination stations.
        if (route && route.geometry && route.geometry.coordinates && route.geometry.coordinates.length >= 2) {
          const coords = route.geometry.coordinates;
          const fromRail = [coords[0][1], coords[0][0]];
          const toRail   = [coords[coords.length - 1][1], coords[coords.length - 1][0]];
          resolvedLeg = Object.assign({}, resolvedLeg, { from_rail_coord: fromRail, to_rail_coord: toRail });
          updatedLegs[updatedLegs.length - 1] = resolvedLeg;
        }

        solvedRoutes.push(route);
        osmStations.push(...osm.stations);
        state.debug.overpass.push({
          leg_id: resolvedLeg.leg_id,
          bbox: result.bbox,
          cached: result.cached,
          query_mode: result.queryMode || "corridor",
          elements: result.data.elements?.length || 0,
          query_areas: result.areas?.length || 0,
          stations: osm.stations.length,
          platforms: (osm.platforms || []).length,
          from_osm_station_id: resolvedLeg.from_osm_station_id || null,
          to_osm_station_id: resolvedLeg.to_osm_station_id || null,
          from_platform_coord: resolvedLeg.from_platform_coord || null,
          to_platform_coord: resolvedLeg.to_platform_coord || null,
          graph_nodes: graph.nodes.size,
          graph_edges: graph.edges.length,
          osm_way_ids: route.properties.osm_way_ids.slice(0, 30),
          path_length_m: route.properties.path_length_m,
          direct_distance_m: route.properties.direct_distance_m,
          station_center_connectors: route.properties.station_center_connectors,
          route_start: route.geometry.coordinates[0],
          route_end: route.geometry.coordinates.at(-1)
        });
      } catch (error) {
        state.debug.messages.push({
          leg_id: leg.leg_id,
          level: "warning",
          message: `${error.message} No fallback straight line was drawn.`
        });
      }
    }

    state.itinerary = hydrateItinerary({ ...state.itinerary, legs: updatedLegs });
    state.routes = solvedRoutes.filter(Boolean);
    state.osmStations = osmStations;
    state.stations = buildStationFeatures(state.itinerary, state.routes, osmStations);
    setStatus("OSM solved");
    renderAll();
  } catch (error) {
    reportError(error);
  } finally {
    els.solveButton.disabled = false;
  }
}

function renderAll() {
  renderLegList();
  renderRoutes(mapState, state.routes, selectLeg);
  renderStations(mapState, state.stations);
  if (!state.routes.length) fitToStations(mapState, state.stations);
  renderWarnings();
  renderDebug();
  if (state.selectedLegId) highlightLeg(mapState, state.selectedLegId);
}

function renderLegList() {
  const itinerary = state.itinerary;
  els.tripMeta.textContent = itinerary
    ? `${itinerary.trip_title}${itinerary.date ? ` / ${itinerary.date}` : ""}`
    : "Not loaded";

  els.legList.innerHTML = "";
  for (const leg of itinerary?.legs || []) {
    const route = state.routes.find((item) => item.properties.leg_id === leg.leg_id);
    const li = document.createElement("li");
    li.className = `leg-card ${leg.leg_id === state.selectedLegId ? "is-active" : ""}`;
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="leg-title">
        <span>${leg.leg_id}</span>
        <div>${escapeHtml(leg.from_station)} -> ${escapeHtml(leg.to_station)}</div>
      </div>
      <div class="leg-route">${escapeHtml(legLabel(leg) || "Unknown line")}</div>
      <div class="leg-meta">
        ${escapeHtml([leg.operator, leg.depart_platform ? `${leg.depart_platform} platform` : ""].filter(Boolean).join(" / "))}
      </div>
      <div class="confidence"><div style="width:${Math.round((route?.properties.confidence_score || 0) * 100)}%"></div></div>
    `;
    li.addEventListener("click", () => selectLeg(leg.leg_id));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectLeg(leg.leg_id);
    });
    els.legList.append(li);
  }
}


function renderWarnings() {
  const warnings = [
    ...collectWarnings(state.itinerary, { solvedRoutes: state.routes }),
    ...state.debug.messages
  ];
  els.warnings.innerHTML = "";
  for (const warning of warnings) {
    const div = document.createElement("div");
    div.className = "warning";
    div.textContent = (warning.leg_id ? "Leg " + warning.leg_id + ": " : "") + (warning.message || warning);
    els.warnings.append(div);
  }
}

function renderDebug() {
  els.debugOutput.textContent = JSON.stringify({
    routes: state.routes.length,
    stations: state.stations.length,
    osmStations: state.osmStations.length,
    overpass: state.debug.overpass
  }, null, 2);
}

function selectLeg(legId) {
  state.selectedLegId = legId;
  highlightLeg(mapState, legId);
  renderLegList();
}

function setBusy(message) {
  els.statusBadge.textContent = message;
  els.statusBadge.style.color = "#ad6500";
}

function setStatus(message) {
  els.statusBadge.textContent = message;
  els.statusBadge.style.color = "#65727e";
}

function reportError(error) {
  console.error(error);
  state.debug.messages.push({
    level: "error",
    message: error.message || String(error)
  });
  setStatus("Error");
  renderWarnings();
  renderDebug();
}

/**
 * Resolve platform coords from corridor OSM data.
 *
 * Station coords (from_coord / to_coord) are intentionally NOT overwritten
 * here. They were already set correctly by ensureLegCoordinates, which uses
 * an operator-aware global Overpass search — the same source the "显示站点"
 * button uses. Overwriting them with corridor OSM data risks picking the wrong
 * node when multiple companies share the same station name (e.g. 秋葉原 on
 * JR / TX / Tokyo Metro).
 *
 * This function only adds platform_coord when depart_platform / arrive_platform
 * are specified in the JSON leg.
 */
function resolveLegCoordsFromOsm(leg, osmStations, osmPlatforms) {
  const fromCoord = leg.from_coord;
  const toCoord   = leg.to_coord;
  const fromPlatform =
    leg.depart_platform && fromCoord
      ? resolvePlatformFromOsmData(leg.depart_platform, osmPlatforms, fromCoord)
      : null;
  const toPlatform =
    leg.arrive_platform && toCoord
      ? resolvePlatformFromOsmData(leg.arrive_platform, osmPlatforms, toCoord)
      : null;
  return {
    ...leg,
    from_coord: fromCoord,
    to_coord:   toCoord,
    from_osm_station_id: leg.from_osm_station_id || leg.matched_from_station_id || null,
    to_osm_station_id:   leg.to_osm_station_id   || leg.matched_to_station_id   || null,
    from_platform_coord: fromPlatform ? [fromPlatform.lat, fromPlatform.lon] : (leg.from_platform_coord || null),
    to_platform_coord:   toPlatform   ? [toPlatform.lat,   toPlatform.lon]   : (leg.to_platform_coord   || null)
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
