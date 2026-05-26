import { getCurrentRailwayData } from "./railway_data.js";

const REQUIRED_STRING_FIELDS = [
  "route_id",
  "rail_line",
  "operator",
  "start_station",
  "arrive_station",
  "start_time",
  "arrive_time",
  "platform_number"
];

const EXAMPLE_ITINERARY = {
  itinerary: [
    {
      route_id: "way1",
      rail_line: "Yamanote Line",
      operator: "JR East",
      start_station: "Tokyo",
      arrive_station: "Shinagawa",
      start_time: "08:00",
      arrive_time: "08:13",
      platform_number: "5",
      passing_stations: [
        "Yurakucho",
        "Shimbashi",
        "Hamamatsucho",
        "Tamachi",
        "Takanawa Gateway"
      ]
    },
    {
      route_id: "way2",
      rail_line: "Tokaido Main Line",
      operator: "JR East",
      start_station: "Shinagawa",
      arrive_station: "Yokohama",
      start_time: "08:18",
      arrive_time: "08:36",
      platform_number: "12",
      passing_stations: ["Kawasaki"]
    },
    {
      route_id: "way3",
      rail_line: "Minatomirai Line",
      operator: "Yokohama Minatomirai Railway",
      start_station: "Yokohama",
      arrive_station: "Motomachi-Chukagai",
      start_time: "08:42",
      arrive_time: "08:50",
      platform_number: "1",
      passing_stations: [
        "Shin-Takashima",
        "Minatomirai",
        "Bashamichi",
        "Nihon-odori"
      ]
    }
  ]
};

let currentItinerary = null;
let currentResolution = null;

export function setupItineraryInput() {
  const elements = {
    input: document.getElementById("itinerary-json"),
    parse: document.getElementById("parse-itinerary"),
    example: document.getElementById("load-itinerary-example"),
    clear: document.getElementById("clear-itinerary"),
    status: document.getElementById("itinerary-status"),
    summary: document.getElementById("itinerary-summary")
  };

  elements.parse.addEventListener("click", () => parseItinerary(elements));
  elements.example.addEventListener("click", () => loadExample(elements));
  elements.clear.addEventListener("click", () => clearItinerary(elements));
  document.addEventListener("railway-data:change", () => refreshStationResolution(elements));
}

function parseItinerary(elements) {
  const rawValue = elements.input.value.trim();

  if (!rawValue) {
    currentItinerary = null;
    elements.summary.innerHTML = "";
    setStatus(elements, "请输入行程 JSON。", true);
    dispatchItineraryChange(null);
    return;
  }

  try {
    const parsed = JSON.parse(rawValue);
    const itinerary = validateItinerary(parsed);

    currentItinerary = itinerary;
    currentResolution = resolveItineraryStations(itinerary, getCurrentRailwayData());
    renderSummary(elements, itinerary, currentResolution);
    setStatus(elements, `已解析 ${itinerary.length} 段行程。`, false);
    dispatchItineraryChange(itinerary);
  } catch (error) {
    currentItinerary = null;
    elements.summary.innerHTML = "";
    setStatus(elements, error.message, true);
    dispatchItineraryChange(null);
  }
}

function loadExample(elements) {
  elements.input.value = JSON.stringify(EXAMPLE_ITINERARY, null, 2);
  parseItinerary(elements);
}

function clearItinerary(elements) {
  currentItinerary = null;
  currentResolution = null;
  elements.input.value = "";
  elements.summary.innerHTML = "";
  setStatus(elements, "等待输入行程 JSON。", false);
  dispatchItineraryChange(null);
}

function validateItinerary(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("JSON 顶层必须是对象。");
  }

  if (!Array.isArray(payload.itinerary)) {
    throw new Error("JSON 必须包含 itinerary 数组。");
  }

  if (payload.itinerary.length === 0) {
    throw new Error("itinerary 至少需要 1 段 route。");
  }

  return payload.itinerary.map((segment, index) => validateSegment(segment, index));
}

function validateSegment(segment, index) {
  const routeLabel = `itinerary[${index}]`;

  if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
    throw new Error(`${routeLabel} 必须是对象。`);
  }

  const normalized = {};

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof segment[field] !== "string" || !segment[field].trim()) {
      throw new Error(`${routeLabel}.${field} 必须是非空字符串。`);
    }

    normalized[field] = segment[field].trim();
  }

  if (!Array.isArray(segment.passing_stations)) {
    throw new Error(`${routeLabel}.passing_stations 必须是字符串数组。`);
  }

  normalized.passing_stations = segment.passing_stations.map((station, stationIndex) => {
    if (typeof station !== "string" || !station.trim()) {
      throw new Error(`${routeLabel}.passing_stations[${stationIndex}] 必须是非空字符串。`);
    }

    return station.trim();
  });

  normalized.station_sequence = [
    normalized.start_station,
    ...normalized.passing_stations,
    normalized.arrive_station
  ];

  return normalized;
}

function refreshStationResolution(elements) {
  if (!currentItinerary) {
    return;
  }

  currentResolution = resolveItineraryStations(currentItinerary, getCurrentRailwayData());
  renderSummary(elements, currentItinerary, currentResolution);
}

export function resolveItineraryStations(itinerary, featureCollection) {
  const stationIndex = buildStationIndex(featureCollection);
  const routeResolutions = itinerary.map((segment) => {
    const stationResults = segment.station_sequence.map((stationName) => {
      const matches = findStationMatches(stationIndex, stationName, segment.operator);

      return {
        stationName,
        operator: segment.operator,
        status: getMatchStatus(matches),
        matches
      };
    });

    return {
      route_id: segment.route_id,
      stationResults
    };
  });

  const counts = routeResolutions.reduce((summary, route) => {
    for (const result of route.stationResults) {
      summary.total += 1;
      summary[result.status] += 1;
    }

    return summary;
  }, { total: 0, matched: 0, missing: 0, ambiguous: 0 });

  return {
    available: Boolean(featureCollection),
    routeResolutions,
    counts
  };
}

function buildStationIndex(featureCollection) {
  if (!featureCollection) {
    return [];
  }

  return featureCollection.features.filter((feature) => (
    feature.geometry?.type === "Point"
    && feature.properties?.osmType === "node"
    && feature.properties?.railway === "station"
  )).map((feature) => ({
    feature,
    nameKeys: getStationNameKeys(feature.properties),
    operatorKey: normalizeText(feature.properties.operator),
    name: feature.properties.name || "",
    displayName: feature.properties["name:en"] || feature.properties.name || "",
    operator: feature.properties.operator || "",
    osmId: feature.properties.osmId
  }));
}

function findStationMatches(stationIndex, stationName, operator) {
  const nameKeys = getStationSearchKeys(stationName);
  const operatorKey = normalizeText(operator);
  const sameName = stationIndex.filter((station) => (
    station.nameKeys.some((stationKey) => nameKeys.includes(stationKey))
  ));
  const sameNameAndOperator = sameName.filter((station) => station.operatorKey === operatorKey);

  return sameNameAndOperator.length > 0 ? sameNameAndOperator : sameName;
}

function getMatchStatus(matches) {
  if (matches.length === 0) {
    return "missing";
  }

  if (matches.length > 1) {
    return "ambiguous";
  }

  return "matched";
}

function renderSummary(elements, itinerary, resolution) {
  const resolutionBanner = createResolutionBanner(resolution);
  const routeMarkup = itinerary.map((segment, index) => `
    <article class="itinerary-route">
      <p class="itinerary-route-title">${escapeHtml(segment.route_id)} · ${escapeHtml(segment.rail_line)}</p>
      <p class="itinerary-route-meta">${escapeHtml(segment.operator)} · ${escapeHtml(segment.start_time)}-${escapeHtml(segment.arrive_time)} · Platform ${escapeHtml(segment.platform_number)}</p>
      <p class="itinerary-route-path">${escapeHtml(segment.station_sequence.join(" -> "))}</p>
      ${resolution?.available ? createStationResolutionList(resolution.routeResolutions[index]?.stationResults || []) : ""}
    </article>
  `).join("");

  elements.summary.innerHTML = resolutionBanner + routeMarkup;
}

function createResolutionBanner(resolution) {
  if (!resolution?.available) {
    return `<p class="resolution-note">点击“解析点位”后，将解析 station 节点并显示在地图上。</p>`;
  }

  return `
    <p class="resolution-note">
      站点解析：${resolution.counts.matched} matched,
      ${resolution.counts.missing} missing,
      ${resolution.counts.ambiguous} ambiguous
    </p>
  `;
}

function createStationResolutionList(stationResults) {
  if (stationResults.length === 0) {
    return "";
  }

  return `
    <ul class="station-resolution-list">
      ${stationResults.map((result) => createStationResolutionItem(result)).join("")}
    </ul>
  `;
}

function createStationResolutionItem(result) {
  const matchText = result.matches.map((match) => {
    const operator = match.operator ? ` · ${match.operator}` : "";
    return `${match.displayName || match.name}${operator} · OSM node/${match.osmId}`;
  }).join(" | ");

  const detail = matchText || `No railway=station node for ${result.stationName} + ${result.operator}`;

  return `
    <li class="station-resolution ${result.status}">
      <span>${escapeHtml(result.stationName)}</span>
      <small>${escapeHtml(result.status)} · ${escapeHtml(detail)}</small>
    </li>
  `;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getStationNameKeys(properties) {
  const names = [
    properties.name,
    properties["name:en"],
    properties["name:ja-Latn"],
    properties.official_name,
    properties.alt_name
  ].filter(Boolean);

  return Array.from(new Set(names.flatMap((name) => String(name).split(";")).map(normalizeText)));
}

function getStationSearchKeys(stationName) {
  const base = String(stationName || "").trim();
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

  return Array.from(variants).map(normalizeText);
}

function setStatus(elements, message, isError) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function dispatchItineraryChange(itinerary) {
  document.dispatchEvent(new CustomEvent("itinerary:change", {
    detail: {
      itinerary,
      valid: Boolean(itinerary),
      resolution: currentResolution
    }
  }));
}

function escapeHtml(value) {
  const container = document.createElement("div");
  container.textContent = value;
  return container.innerHTML;
}

export function getCurrentItinerary() {
  return currentItinerary;
}

export function getCurrentResolution() {
  return currentResolution;
}
