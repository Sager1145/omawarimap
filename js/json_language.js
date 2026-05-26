export const JSON_LANGUAGE_SCHEMA = {
  $schema: "https://omawari-map.local/schema/itinerary.v1.json",
  type: "omawari.itinerary.v1",
  requiredRootFields: ["trip_title", "legs"],
  rootFields: {
    trip_title: "string",
    date: "YYYY-MM-DD string, optional",
    source: "string, optional",
    legs: "ItineraryLeg[]"
  },
  legRequiredFields: ["from_station", "to_station"],
  legFields: {
    leg_id: "number, optional; auto-filled when omitted",
    mode: "train | walk | transfer | unknown",
    operator: "string, optional",
    line_name: "string, optional",
    train_name: "string, optional",
    train_number: "string, optional",
    from_station: "string — station name; coordinates resolved automatically from OSM",
    to_station: "string — station name; coordinates resolved automatically from OSM",
    depart_time: "HH:mm string, optional",
    arrive_time: "HH:mm string, optional",
    depart_platform: "string, optional — platform name/number (e.g. '3番線'); marker placed at platform center if found in OSM",
    arrive_platform: "string, optional — platform name/number; marker placed at platform center if found in OSM",
    intermediate_stations: "[station_name, ...], optional — explicit list of intermediate station names to display; resolved from OSM by name, projected onto railway line",
    from_coord: "[lat, lon], optional — override coord for from_station; normally resolved from OSM automatically",
    to_coord: "[lat, lon], optional — override coord for to_station; normally resolved from OSM automatically",
    fallback_path: "[[lat, lon], ...], optional corridor hint for OSM queries; never rendered as railway",
    notes: "string, optional"
  },
  coordinateOrder: "All custom coordinate arrays use [lat, lon]. GeoJSON export uses [lon, lat]."
};

export const ITINERARY_TEMPLATE = {
  $schema: JSON_LANGUAGE_SCHEMA.$schema,
  type: JSON_LANGUAGE_SCHEMA.type,
  trip_title: "東京近郊大回り",
  date: "2026-05-26",
  source: "manual-json",
  legs: [
    {
      leg_id: 1,
      mode: "train",
      operator: "JR東日本",
      line_name: "中央線快速",
      train_number: "1001T",
      from_station: "東京",
      to_station: "御茶ノ水",
      depart_time: "09:00",
      arrive_time: "09:05",
      notes: "駅座標はOSMデータから自動解決。from_coord/to_coordの記述は不要。"
    },
    {
      leg_id: 2,
      mode: "train",
      operator: "JR東日本",
      line_name: "中央・総武線各駅停車",
      from_station: "御茶ノ水",
      to_station: "秋葉原",
      depart_time: "09:09",
      arrive_time: "09:11"
    },
    {
      leg_id: 3,
      mode: "train",
      operator: "JR東日本",
      line_name: "山手線",
      from_station: "秋葉原",
      to_station: "上野",
      depart_time: "09:15",
      arrive_time: "09:19",
      intermediate_stations: ["御徒町"],
      arrive_platform: "3番線"
    }
  ]
};

export function parseJsonDocument(text) {
  try {
    return {
      ok: true,
      value: JSON.parse(text)
    };
  } catch (error) {
    return {
      ok: false,
      errors: [jsonParseError(error, text)]
    };
  }
}

export function validateItineraryJson(value) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(value)) {
    return {
      ok: false,
      errors: [{ path: "$", message: "根节点必须是 JSON object。" }],
      warnings
    };
  }

  if (value.type && value.type !== JSON_LANGUAGE_SCHEMA.type) {
    warnings.push({
      path: "$.type",
      message: `推荐使用 type="${JSON_LANGUAGE_SCHEMA.type}"。`
    });
  }

  requireString(value, "trip_title", "$.trip_title", errors);

  if (!Array.isArray(value.legs)) {
    errors.push({ path: "$.legs", message: "legs 必须是数组。" });
  } else if (!value.legs.length) {
    errors.push({ path: "$.legs", message: "legs 至少需要一段行程。" });
  } else {
    value.legs.forEach((leg, index) => validateLeg(leg, index, errors, warnings));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

export function parseAndValidateJson(text) {
  const parsed = parseJsonDocument(text);
  if (!parsed.ok) return parsed;
  const validation = validateItineraryJson(parsed.value);
  return {
    ...validation,
    value: parsed.value
  };
}

export function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

export function templateJson() {
  return formatJson(ITINERARY_TEMPLATE);
}

export function schemaText() {
  return formatJson(JSON_LANGUAGE_SCHEMA);
}

function validateLeg(leg, index, errors, warnings) {
  const path = `$.legs[${index}]`;
  if (!isPlainObject(leg)) {
    errors.push({ path, message: "每个 leg 必须是 object。" });
    return;
  }

  requireString(leg, "from_station", `${path}.from_station`, errors);
  requireString(leg, "to_station", `${path}.to_station`, errors);

  if (leg.mode && !["train", "walk", "transfer", "unknown"].includes(leg.mode)) {
    errors.push({
      path: `${path}.mode`,
      message: "mode 只能是 train、walk、transfer 或 unknown。"
    });
  }

  if (leg.depart_time && !isTime(leg.depart_time)) {
    warnings.push({ path: `${path}.depart_time`, message: "建议使用 HH:mm 时间格式。" });
  }
  if (leg.arrive_time && !isTime(leg.arrive_time)) {
    warnings.push({ path: `${path}.arrive_time`, message: "建议使用 HH:mm 时间格式。" });
  }

  // from_coord / to_coord are optional overrides; normally resolved from OSM by station name
  validateCoord(leg.from_coord, `${path}.from_coord`, errors);
  validateCoord(leg.to_coord, `${path}.to_coord`, errors);

  if (leg.intermediate_stations !== undefined) {
    if (!Array.isArray(leg.intermediate_stations)) {
      errors.push({ path: `${path}.intermediate_stations`, message: "intermediate_stations は文字列配列である必要があります。" });
    } else {
      leg.intermediate_stations.forEach((name, i) => {
        if (typeof name !== "string" || !name.trim()) {
          errors.push({ path: `${path}.intermediate_stations[${i}]`, message: "駅名は空でない文字列である必要があります。" });
        }
      });
    }
  }

  if (leg.fallback_path !== undefined) {
    if (!Array.isArray(leg.fallback_path)) {
      errors.push({ path: `${path}.fallback_path`, message: "fallback_path 必须是坐标数组。" });
    } else {
      leg.fallback_path.forEach((coord, coordIndex) => {
        validateCoord(coord, `${path}.fallback_path[${coordIndex}]`, errors);
      });
    }
  }
}

function requireString(object, key, path, errors) {
  if (typeof object[key] !== "string" || !object[key].trim()) {
    errors.push({ path, message: `${key} 必须是非空字符串。` });
  }
}

function validateCoord(coord, path, errors) {
  if (coord === undefined || coord === null) return;
  if (
    !Array.isArray(coord) ||
    coord.length !== 2 ||
    !Number.isFinite(Number(coord[0])) ||
    !Number.isFinite(Number(coord[1]))
  ) {
    errors.push({ path, message: "坐标必须是 [lat, lon] 两个数字。" });
    return;
  }

  const lat = Number(coord[0]);
  const lon = Number(coord[1]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    errors.push({ path, message: "坐标超出合法经纬度范围。" });
  }
}

function jsonParseError(error, text) {
  const positionMatch = String(error.message).match(/position\s+(\d+)/i);
  const position = positionMatch ? Number(positionMatch[1]) : null;
  if (!Number.isFinite(position)) {
    return { path: "$", message: error.message };
  }

  const before = text.slice(0, position);
  const line = before.split(/\r?\n/).length;
  const column = before.length - before.lastIndexOf("\n");
  return {
    path: `$:${line}:${column}`,
    message: `${error.message}。位置：第 ${line} 行，第 ${column} 列。`
  };
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isTime(value) {
  return /^\d{1,2}:\d{2}$/.test(String(value));
}
