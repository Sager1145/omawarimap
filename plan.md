# omawari-map 开发计划

## 1. 目标

做一个可在浏览器运行的 HTML 页面，用 OpenStreetMap 底图和开源/开放的日本铁路数据，把“大回り/大回”行程 PDF 中的乘车区间画到地图上，并标出：

- 每一段车辆实际经过的铁路线区间
- 出发站、到达站
- 换乘站
- 沿途经过站
- 每段车次、线路名、运营公司、发到时间、站台、备注
- 无法自动匹配时的警告与人工修正入口

这里的“PDF”先按“行程表 PDF”处理：PDF 中至少能提取出每段的出发站、到达站、线路名、时间、车次等文字。如果 PDF 是扫描图片，计划中保留 OCR/人工编辑的备用流程。

## 2. 数据源

### 2.1 主数据：OpenStreetMap

用途：

- 铁路线几何：`railway=rail`
- 车站/停留点：`railway=station`、`railway=halt`
- 站台/站区辅助信息：`railway=platform`、`railway=platform_edge`
- 线路 relation：`route=train`、`route=subway`、`route=light_rail` 等
- tags：`name`、`name:ja`、`name:en`、`operator`、`ref`、`usage`、`service`

获取方式分两档：

1. 小范围在线查询：用 Overpass API 按每个 leg 的 bbox/corridor 查询。
2. 全国离线预处理：从 Geofabrik 下载 `japan-latest.osm.pbf`，用 Osmium/自写脚本抽取日本铁路图层，生成前端可加载的 compact GeoJSON/JSON。

注意：

- 不要让浏览器直接下载日本全量 PBF。Geofabrik 日本 PBF 约数 GB，适合预处理脚本，不适合前端直接加载。
- 前端在线模式只查行程相关区域，避免 Overpass 超时和限流。
- 地图和导出数据必须保留 OpenStreetMap/ODbL attribution。

### 2.2 辅助数据：国土数値情報 鉄道データ

用途：

- 作为站名、线路名、运营公司名的辅助匹配表
- 对 OSM 线路/车站匹配结果做 QA
- 在 OSM 站名缺失或别名不一致时辅助 disambiguation

不建议直接拿它替代 OSM 路由图，因为其铁路数据更偏 GIS 线/站资料，不一定有可直接做轨道级最短路径的拓扑结构。更合适的用法是“OSM 负责轨道路径，国土数値情報负责名称/线路校验”。

### 2.3 外部资料记录

截至 2026-05-26 查到的关键资料：

- Geofabrik Japan OSM extract: https://download.geofabrik.de/asia/japan.html
- Overpass API manual: https://dev.overpass-api.de/overpass-doc/en/index.html
- OSMF attribution guidelines: https://osmfoundation.org/wiki/Attribution_Guidelines
- 国土数値情報 鉄道データ: https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html
- Leaflet reference: https://leafletjs.com/reference
- PDF.js examples: https://mozilla.github.io/pdf.js/examples/index.html
- Osmium Tool: https://osmcode.org/osmium-tool/index.html
- OSM railway tagging / OpenRailwayMap tagging: https://wiki.openstreetmap.org/wiki/Railways

## 3. 总体架构

优先做成静态前端应用，后续再加数据预处理工具。

```text
用户 PDF / JSON
    |
    v
PDF.js 文本提取
    |
    v
行程解析与人工确认
    |
    v
车站匹配 + OSM 数据获取
    |
    v
铁路 graph 构建
    |
    v
每段路线求解
    |
    v
沿途站/换乘站识别
    |
    v
Leaflet 地图渲染 + 导出 GeoJSON/CSV/Project JSON
```

### 两种运行模式

**在线 MVP 模式**

- 上传 PDF 或 JSON。
- 用站名粗定位每段区域。
- 每段按 bbox 调用 Overpass。
- 构建局部 graph 并画线。
- 优点是实现快；缺点是受网络和 Overpass 限制。

**离线增强模式**

- 运行 `tools/preprocess_osm_japan.py` 下载/读取 Geofabrik PBF。
- 抽取铁路相关 OSM 数据。
- 生成：
  - `data/railway_japan_tracks.geojson`
  - `data/railway_japan_stations.geojson`
  - `data/railway_japan_relations.json`
  - `data/railway_japan_graph.json`
  - `data/station_aliases_ja.json`
  - `data/line_aliases_ja.json`
- 前端直接加载 compact 数据。
- 优点是稳定、快、可重复；缺点是初次预处理成本高。

## 4. 建议目录结构

```text
omawarimap/
  index.html
  css/
    style.css
  js/
    app.js
    pdf_parser.js
    itinerary_model.js
    station_matcher.js
    osm_downloader.js
    osm_normalizer.js
    railway_graph.js
    route_solver.js
    station_detector.js
    map_renderer.js
    export_tools.js
  data/
    sample_itinerary.json
    station_aliases_ja.json
    line_aliases_ja.json
  tools/
    preprocess_osm_japan.py
    README_preprocess.md
  exports/
  plan.md
```

## 5. 核心数据模型

### 5.1 Itinerary

```ts
type Itinerary = {
  trip_title: string;
  date?: string;
  source_pdf_name?: string;
  legs: ItineraryLeg[];
  warnings: ParseWarning[];
};
```

### 5.2 ItineraryLeg

```ts
type ItineraryLeg = {
  leg_id: number;
  mode: "train" | "walk" | "transfer" | "unknown";
  train_name?: string;
  train_number?: string;
  operator?: string;
  line_name?: string;
  from_station: string;
  to_station: string;
  depart_time?: string;
  arrive_time?: string;
  depart_platform?: string;
  arrive_platform?: string;
  notes?: string;

  matched_from_station_id?: string;
  matched_to_station_id?: string;
  solved_path_id?: string;
  confidence_score?: number;
  warnings?: ParseWarning[];
};
```

### 5.3 StationFeature

```ts
type StationFeature = {
  station_id: string;
  osm_type: "node" | "way" | "relation" | "mlit";
  osm_id?: number;
  mlit_id?: string;
  name: string;
  name_ja?: string;
  name_en?: string;
  operator?: string;
  line_names?: string[];
  lat: number;
  lon: number;
  roles: Array<
    "origin" |
    "destination" |
    "transfer" |
    "board" |
    "alight" |
    "pass_through"
  >;
  leg_ids: number[];
};
```

### 5.4 SolvedRouteFeature

```ts
type SolvedRouteFeature = {
  type: "Feature";
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
  properties: {
    leg_id: number;
    train_name?: string;
    train_number?: string;
    line_name?: string;
    operator?: string;
    from_station: string;
    to_station: string;
    depart_time?: string;
    arrive_time?: string;
    osm_way_ids: number[];
    osm_relation_ids?: number[];
    confidence_score: number;
    warnings: string[];
  };
};
```

### 5.5 坐标约定

- OSM/Leaflet 内部常用：`[lat, lon]`
- GeoJSON 标准：`[lon, lat]`
- 所有模块边界必须写清输入输出坐标顺序。
- `map_renderer.js` 负责把 GeoJSON 坐标转换成 Leaflet 可画的坐标。

## 6. PDF 解析计划

### 6.1 PDF.js 流程

1. 用户上传 PDF。
2. `pdf_parser.js` 用 PDF.js 逐页读取 text content。
3. 保留每个 text item 的：
   - 文本
   - 页码
   - x/y 坐标
   - 字体高度
4. 按 y 坐标聚合成行。
5. 用规则识别站名、时间、线路名、车次、站台。
6. 输出 `Itinerary` 草稿。
7. 在 UI 中让用户确认/修正。

### 6.2 解析策略

优先支持以下常见格式：

```text
07:10 東京 -> 07:45 千葉
JR総武線快速 1234F
```

```text
東京 07:10
↓ JR総武線快速
千葉 07:45
```

```text
東京駅 7番線 発 07:10
千葉駅 2番線 着 07:45
```

解析规则：

- 时间：`HH:mm`、`H:mm`、`HH時mm分`
- 方向：`->`、`→`、`⇒`、`発`、`着`、`到着`
- 站名：去掉末尾 `駅` 后参与匹配，但显示时保留原文
- 线路名：包含 `線`、`ライン`、`Line`、`新幹線`、`本線`
- 车次：数字 + 字母，如 `1234M`、`1234F`

### 6.3 扫描 PDF/OCR 备用

如果 PDF.js 提取不到文字：

- MVP：提示用户改用手动 JSON/表格输入。
- 增强版：接入浏览器 OCR 或本地 OCR 脚本，但 OCR 不作为第一阶段目标。

## 7. OSM 数据获取

### 7.1 Overpass 在线查询

每个 leg 查询流程：

1. 用 `from_station` 和 `to_station` 查候选站。
2. 根据候选站坐标生成 bbox。
3. bbox 向四周扩展 5-20km，长距离 leg 分段查询。
4. 查询 railway ways、station/halt、platform、route relation。
5. 缓存结果到 IndexedDB，cache key 包含 bbox、query version、OSM timestamp。

示例 Overpass QL：

```ql
[out:json][timeout:120];
(
  way["railway"="rail"]({{south}},{{west}},{{north}},{{east}});
  node["railway"~"station|halt"]({{south}},{{west}},{{north}},{{east}});
  way["railway"~"station|platform|platform_edge"]({{south}},{{west}},{{north}},{{east}});
  relation["route"~"train|subway|light_rail"]({{south}},{{west}},{{north}},{{east}});
);
out body;
>;
out skel qt;
```

**重要**：上面的查询用 `out body; >; out skel qt;` 是为了同时拿到 way 的成员 node 坐标，但这样 node 只有坐标，没有 geometry 内联。更推荐的写法是在 way 上直接用 `out geom`，让 Overpass 把每个 way 的完整坐标序列内联返回，省去手动拼接节点：

```ql
[out:json][timeout:120];
(
  way["railway"="rail"]({{south}},{{west}},{{north}},{{east}});
  node["railway"~"station|halt"]({{south}},{{west}},{{north}},{{east}});
  relation["route"~"train|subway|light_rail|monorail|tram"]({{south}},{{west}},{{north}},{{east}});
);
out geom;
```

`out geom` 会在每个 way 的 JSON 对象里直接附带 `geometry` 数组（`[{lat, lon}, ...]`），不需要再做 node lookup。这是前端获取铁路几何的**首选方式**。

### 7.2 Geofabrik 离线预处理

预处理脚本负责：

1. 下载或读取 `japan-latest.osm.pbf`。
2. 使用 Osmium 过滤：
   - `railway=rail`
   - `railway=station`
   - `railway=halt`
   - `railway=platform`
   - `route=train`
   - `route=subway`
   - `route=light_rail`
3. 生成 graph：
   - OSM node 为 graph node
   - way 相邻节点为 graph edge
   - edge 保存 geometry、length、tags、way_id、relation ids
4. 生成 compact JSON，供浏览器加载。

第一版可以先不实现全国预处理，只把接口和目录留好。

## 8. 名称匹配

### 8.1 站名标准化

```js
function normalizeStationName(name) {
  return name
    .trim()
    .normalize("NFKC")
    .replace(/[\\s・･\\-ー－]/g, "")
    .replace(/駅$/u, "")
    .toLowerCase();
}
```

匹配优先级：

1. `name:ja` 完全匹配
2. `name` 完全匹配
3. 去掉 `駅` 后匹配
4. 别名表 `station_aliases_ja.json`
5. `name:en` 罗马字匹配
6. 按距离、线路名、运营公司重排候选

### 8.2 线路名标准化

线路名需要 alias 表，例如：

```json
{
  "総武快速線": ["JR総武快速線", "総武線快速", "Sobu Rapid Line"],
  "東海道本線": ["JR東海道線", "東海道線", "Tokaido Main Line"],
  "山手線": ["JR山手線", "Yamanote Line"]
}
```

评分时同时看：

- PDF 线路名
- OSM way `name`
- OSM relation `name`
- `operator`
- `ref`
- 国土数値情報的线路名/运营公司

## 9. 路线求解

### 9.1 Graph 构建

每条 `railway=rail` way 拆成连续 edge：

```ts
type RailwayEdge = {
  edge_id: string;
  from_node: string;
  to_node: string;
  length_m: number;
  geometry: [number, number][]; // [lat, lon]
  osm_way_id: number;
  tags: Record<string, string>;
  route_relation_ids: number[];
};
```

过滤/降权：

- `service=yard`、`siding`、`spur`、`crossover` 不直接删除，但高 penalty。
- `railway=abandoned`、`disused`、`construction` 默认排除，除非用户开启 debug。
- 货物线、车辆基地线高 penalty。

### 9.2 起终点贴合

1. 找到 from/to station 的 OSM feature。
2. 在站点周边搜索最近 graph node。
3. 优先选择与 leg 线路名/运营公司一致的轨道节点。
4. 若站点是大型站，允许多个候选 node，并在路径搜索中尝试 top N 组合。

### 9.3 路径算法

第一版用 Dijkstra，后续可改 A*。

```text
cost = distance_m
     + lineMismatchPenalty
     + operatorMismatchPenalty
     + relationMismatchPenalty
     + serviceTrackPenalty
     + excessiveDetourPenalty
```

建议 penalty：

| 情况 | penalty |
|---|---:|
| edge 与 leg.line_name / route relation 匹配 | 0 |
| edge 没有线路名但方向合理 | +50 |
| edge operator 不匹配 | +500 |
| service=siding/spur/crossover | +2000 |
| 明显绕远 | +5000 |

输出：

- 每段 `SolvedRouteFeature`
- `confidence_score`
- `warnings`
- 使用过的 OSM way ids / relation ids

## 10. 铁路线几何的正确获取与拼接

> **核心原则：地图上的每一条铁路 polyline 必须完全来自 OSM way 的真实节点坐标序列，绝不允许用"起点站坐标 → 终点站坐标"直线代替。**

### 10.1 为什么直线不可接受

铁路线有弯道、隧道、高架桥、环形线路，两站之间的直线根本无法反映真实走向。例如东京→新宿（山手線）的直线是西南方向，但实际轨道向北绕行上野、向南经品川，是一个环形。

### 10.2 OSM way 的几何结构

每条 OSM way 包含一个有序的 node 列表，每个 node 有精确的 (lat, lon)。铁路线几何 = 将这些节点按顺序连成折线。

```
way 12345678
  nodes: [N1, N2, N3, N4, N5, ...]
  geometry (out geom 返回):
    [{lat:35.681, lon:139.767},
     {lat:35.684, lon:139.762},
     {lat:35.690, lon:139.755}, ...]
```

用 `out geom` 查询时，几何已经内联在 way 对象里，直接可用。

### 10.3 多段 way 的端点拼接

一段铁路区间通常由多条相邻 way 拼成。Dijkstra 求解后得到一个 way 序列，需要将它们首尾相接成一条连续折线：

```js
/**
 * 将路径中的 OSM way 序列拼接成连续 GeoJSON LineString 坐标数组。
 * 每条 way 可能需要反转，使得相邻 way 首尾相连。
 *
 * @param {Array<OsmWayWithGeom>} waySequence - 路径中按顺序排列的 way
 * @returns {Array<[number, number]>} GeoJSON 坐标数组 [lon, lat]（GeoJSON 标准）
 */
function assembleGeometry(waySequence) {
  if (waySequence.length === 0) return [];

  // 第一条 way 的方向由第二条 way 的端点决定
  const coords = [];

  for (let i = 0; i < waySequence.length; i++) {
    const way = waySequence[i];
    // way.geometry: [{lat, lon}, ...] (from Overpass out geom)
    let pts = way.geometry.map(p => [p.lon, p.lat]); // → GeoJSON [lon, lat]

    if (i === 0) {
      // 第一条 way：看第二条 way 的起点来决定方向
      if (waySequence.length > 1) {
        const nextFirst = waySequence[1].geometry[0];
        const nextLast  = waySequence[1].geometry.at(-1);
        const curLast   = way.geometry.at(-1);
        const curFirst  = way.geometry[0];
        // 如果本 way 末端更靠近下一条 way 的末端（而非起点），说明下一条要反转
        // 这里先处理本条方向：
        const distLastToNextFirst = latLonDist(curLast, nextFirst);
        const distLastToNextLast  = latLonDist(curLast, nextLast);
        const distFirstToNextFirst = latLonDist(curFirst, nextFirst);
        if (distFirstToNextFirst < distLastToNextFirst) {
          pts = pts.reverse(); // 本条 way 反转，让末端对齐下一条起端
        }
      }
      coords.push(...pts);
    } else {
      // 后续 way：根据上一条的末端决定是否反转
      const prevEnd = coords.at(-1);
      const curFirst = pts[0];
      const curLast  = pts.at(-1);
      const dFirst = Math.hypot(curFirst[0] - prevEnd[0], curFirst[1] - prevEnd[1]);
      const dLast  = Math.hypot(curLast[0]  - prevEnd[0], curLast[1]  - prevEnd[1]);
      if (dLast < dFirst) pts = pts.reverse();
      coords.push(...pts.slice(1)); // 去掉与上一条重复的首节点
    }
  }

  return coords;
}
```

### 10.4 站点贴轨（station snapping）

从 Overpass 查到的 `railway=station` node 不一定恰好在轨道 way 上（OSM 建模习惯不同）。需要将站点坐标投影到最近的轨道 way：

```js
/**
 * 将站点投影到最近 way 上，返回投影点坐标和所属 way 上最近的 node。
 */
function snapStationToTrack(stationLatLon, waySequence) {
  let best = { dist: Infinity, wayIndex: -1, nodeIndex: -1, projPt: null };

  for (let wi = 0; wi < waySequence.length; wi++) {
    const pts = waySequence[wi].geometry;
    for (let ni = 0; ni < pts.length - 1; ni++) {
      const proj = projectPointToSegment(stationLatLon, pts[ni], pts[ni + 1]);
      if (proj.dist < best.dist) {
        best = { dist: proj.dist, wayIndex: wi, nodeIndex: ni, projPt: proj.pt };
      }
    }
  }
  return best;
}
```

snapping 的容许距离建议：
- 一般线路：100m
- 大型ターミナル（東京・新宿・大阪）：300m
- 地下駅・新幹線ホーム：200m

### 10.5 路线图形的切割（起点和终点处理）

求解出的 way 序列可能包含从站点向两端延伸的多余部分。需要在起点站投影点和终点站投影点处截断几何：

```js
function trimGeometryToStations(fullCoords, startSnap, endSnap) {
  // 找最近节点，从 startSnap 截到 endSnap
  // 注意保持方向一致（startSnap.measure < endSnap.measure）
}
```

### 10.6 relation 路线辅助几何

OSM route relation（`route=train`）包含该线路的 way 成员列表，且已经有顺序排列。可用它来：

1. 验证 Dijkstra 求出的 way 序列是否合理（大部分 way 应在 relation 里）
2. 直接使用 relation 的 way 顺序代替 Dijkstra（适合不需要跨 relation 路由的单线区间）

```ql
/* 获取特定 relation 的完整几何（替代 Dijkstra 的简化方案） */
[out:json][timeout:60];
relation({{relation_id}});
out geom;
```

当 `route_solver.js` 能在 relation 里找到完整路径时，优先采用 relation 几何，置信度设为 1.0。只有无法匹配 relation 时才回退 Dijkstra。

### 10.7 Leaflet 渲染

```js
// SolvedRouteFeature.geometry 是 GeoJSON [lon, lat] 顺序
// Leaflet.polyline 需要 [lat, lon] 顺序，必须转换
function geoJsonCoordsToLeaflet(coords) {
  return coords.map(([lon, lat]) => [lat, lon]);
}

const latlngs = geoJsonCoordsToLeaflet(solvedRoute.geometry.coordinates);
const polyline = L.polyline(latlngs, {
  color: LEG_COLORS[leg.leg_id % LEG_COLORS.length],
  weight: 4,
  opacity: 0.85,
});
polyline.addTo(map);
```

### 10.8 几何质量验证（调试用）

在 debug 面板中显示：

- 本段 polyline 使用了多少条 OSM way
- 最长单段 way 长度（km）
- 起点/终点 snapping 误差（m）
- 是否来自 relation 直接几何（relation_id）
- 总长度（km）与铁道距离合理性对比

红色警告条件：
- 起点 snapping 误差 > 500m → 可能站名匹配错误
- polyline 有跳跃（相邻节点距离 > 10km）→ way 拼接错误
- way 总数为 1 且长度 < 0.5km → 几乎一定是直线退化

### 10.9 直线退化绝对禁止

在 `map_renderer.js` 中加入断言，若检测到 polyline 节点数少于 5 而区间距离超过 2km，强制报错并拒绝渲染，改为显示"几何数据不足，请重新下载 OSM 数据"提示，不能悄悄画成直线。

## 11. 沿途站和换乘站识别

### 10.1 换乘站

规则：

- 如果 `legs[i].to_station` 与 `legs[i + 1].from_station` 标准化后相同，则该站是换乘站。
- 如果两个站不完全相同但坐标小于 300m 且属于同一站区，也提示“可能换乘站”。
- 换乘 marker 显示上一段到达时间、下一段出发时间、换乘线路。

### 10.2 沿途站

流程：

1. 将 solved path 合并为 polyline。
2. 取 path 周边 100-300m 的 station/halt。
3. 将候选站投影到 polyline，计算 measure。
4. 按 measure 排序。
5. 排除与当前 leg 起终点重复的站，或标成 board/alight。
6. 对大型站、地下站、新干线站设置更宽容阈值。

站点角色：

- `origin`
- `destination`
- `board`
- `alight`
- `transfer`
- `pass_through`

## 11. 地图 UI

### 11.1 页面布局

```text
+-------------------------------------------------------+
| 顶部工具栏：上传 PDF / 导入 JSON / 下载 OSM / 导出       |
+------------------------+------------------------------+
| 左侧面板               | Leaflet 地图                  |
| - 行程 legs            | - OSM 底图                    |
| - 解析警告             | - 每段铁路 polyline           |
| - 匹配结果             | - 站点 marker                 |
| - 手动修正             | - hover/click popup           |
+------------------------+------------------------------+
| 底部 debug 面板：OSM ids / confidence / Overpass query |
+-------------------------------------------------------+
```

### 11.2 地图图层

- OSM tile layer
- 每段路线 polyline，按 leg 分色
- 当前 hover/selected leg 高亮
- 起点/终点 marker
- 换乘站 marker
- 沿途站 marker
- 匹配失败/低可信度 marker
- 可选 OpenRailwayMap tile overlay，只作为参考图层，不作为数据源

### 11.3 Popup 内容

```text
千葉
角色：换乘站
上一段：東京 -> 千葉 07:10-07:45
下一段：千葉 -> 成田 07:52-08:35
线路：総武快速線 / 成田線
匹配：OSM node 123456789, confidence 0.91
```

## 12. 导出

导出格式：

```text
exports/
  omawari_route.geojson
  omawari_stations.csv
  omawari_project.json
  omawari_debug.json
```

`omawari_route.geojson`：

- FeatureCollection
- 每个 leg 一条 LineString/MultiLineString
- properties 包含线路、车次、时间、OSM ids、confidence

`omawari_stations.csv`：

```csv
role,station_name,lat,lon,leg_ids,arrive_time,depart_time,operator,line_name,osm_id,confidence
```

`omawari_project.json`：

- 完整项目状态
- 原始 PDF 解析结果
- 用户修正内容
- OSM 查询缓存 metadata
- 可重新打开继续编辑

## 13. MVP 开发顺序

### Phase 1：静态地图和示例 JSON

目标：

- 建立 `index.html`、`style.css`、`app.js`
- 引入 Leaflet
- 读取 `data/sample_itinerary.json`
- 在地图上显示起终站 marker 和手写示例 polyline

验收：

- 打开页面能看到地图
- 示例路线能显示
- 点击 leg 能高亮地图线段

### Phase 2：Overpass 小范围下载和站名匹配

目标：

- 根据站名查候选站
- 调 Overpass 获取 railway/station 数据
- 缓存响应
- UI 显示匹配候选和置信度

验收：

- 输入 `東京 -> 千葉` 能找到候选站
- 能展示 OSM 站点 marker
- 查询失败时有清晰错误信息

### Phase 3：railway graph 与路径求解

目标：

- OSM ways 转 graph
- from/to station 贴到 graph node
- 用 Dijkstra 求路径
- 将路径转换为 GeoJSON 并画到地图

验收：

- 同一城市/区域内的 JR 区间能沿铁路画线
- 不走明显错误的 siding/yard
- 每段输出 confidence 和 OSM way ids

### Phase 4：沿途站和换乘站

目标：

- 识别换乘站
- 从 solved path 周边检测沿途站
- 按经过顺序排序
- marker 和 popup 完整显示

验收：

- 连续 legs 的换乘站被标出
- 沿途站顺序合理
- 起终站不会重复显示成普通经过站

### Phase 5：PDF.js 解析

目标：

- 上传 PDF
- 提取文本和坐标
- 初步解析成 legs
- 提供人工确认/编辑 UI

验收：

- 常见行程 PDF 能解析出主要 leg 字段
- 不确定字段进入 warnings
- 用户修正后可以继续匹配和绘图

### Phase 6：导出和项目保存

目标：

- 导出 GeoJSON/CSV/project JSON
- 重新导入 project JSON
- debug 信息可下载

验收：

- GeoJSON 可被 QGIS/uMap 打开
- project JSON 可恢复地图状态
- 导出文件包含必要 attribution metadata

### Phase 7：离线预处理增强

目标：

- 增加 `tools/preprocess_osm_japan.py`
- 支持读取 Geofabrik PBF
- 输出 compact railway graph
- 可选合并国土数値情報别名表

验收：

- 不依赖 Overpass 也能跑示例行程
- 前端加载时间可接受
- 数据版本和 license metadata 清晰记录

## 14. 风险与处理

### 14.1 PDF 格式不稳定

风险：

- 不同 PDF 的排版差异大。
- 文字顺序可能与视觉顺序不同。
- 扫描 PDF 无法直接提取文本。

处理：

- 第一版把 JSON/人工编辑作为主路径，PDF 自动解析作为增强。
- PDF 解析结果必须先进入确认界面。
- 保留 raw text/debug view。

### 14.2 OSM 数据不完整或 tag 不一致

风险：

- 日本铁路 OSM 数据总体丰富，但线路 relation、operator、站名 tag 可能不一致。

处理：

- 使用名称 alias 表。
- 结合线路名、运营公司、距离、relation 多因素评分。
- 低置信度时要求用户选候选路线。

### 14.3 Overpass 限流和超时

风险：

- 大 bbox 或长距离行程容易超时。

处理：

- bbox 分段。
- IndexedDB 缓存。
- 限制并发。
- 提供 Geofabrik 离线预处理方案。

### 14.4 大型站/并行线路复杂

风险：

- 东京、新宿、大阪等站区轨道复杂，最近节点不一定正确。
- 同区间可能有普通线、快速线、货物线、新干线并行。

处理：

- station snapping 使用 top N 候选。
- route solver 对 line/operator/relation 匹配加权。
- UI 允许用户手动选择候选路线。

## 15. 许可证与署名

页面底部和地图 attribution 必须包含：

```text
Map data © OpenStreetMap contributors. OpenStreetMap data is available under the Open Database License.
```

如果使用国土数値情報：

```text
Contains data from 国土数値情報 鉄道データ, Ministry of Land, Infrastructure, Transport and Tourism of Japan.
```

具体措辞和导出文件 metadata 要根据实际使用的数据源确认。OSM/ODbL 数据和 CC BY 4.0 数据混合时，需要在 README 和导出 metadata 中明确每个数据层的来源与许可。

## 16. 第一版最小可交付

第一版不要求完美自动解析所有 PDF。建议最小可交付定义为：

1. 一个静态 HTML 页面。
2. 可导入手写/修正后的 itinerary JSON。
3. 可用 Overpass 下载相关 OSM 铁路数据。
4. 可匹配起终站。
5. 可沿铁路 graph 求出每段路径并画线。
6. 可标出起终站、换乘站、沿途站。
7. 可导出 GeoJSON/CSV/project JSON。
8. UI 明确显示低置信度和需要人工修正的位置。

PDF 自动解析放在 MVP 后半段，不阻塞地图核心能力。

## 17. 大回り規則とバリデーション

### 17.1 大回りとは

JR の「大都市近郊区間」内の制度：最短経路の普通乗車券で、区間内なら実際にどんな遠回り経路を乗っても運賃は最短距離計算で良い。同じ駅を二度通る（折り返し）は禁止。

対象区間（2025 年時点）：

- **関東大回り**（東京近郊区間）：東京・横浜・大宮・千葉・高崎・前橋・新前橋・小山・宇都宮・熱海・豊田・八王子・拝島・武蔵五日市・武蔵増戸・高麗川・川越・大宮・桐生・小山・友部・我孫子・成田空港 等を囲む範囲
- **大阪近郊区間**：大阪・京都・奈良・和歌山・姫路・米原 等
- **福岡近郊区間**、**新潟近郊区間**、**仙台近郊区間**

### 17.2 大回りバリデーションロジック

```ts
type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  duplicateStations: string[];
  outOfZoneLegs: number[];
};

function validateOmawariRoute(itinerary: Itinerary, zone: "kanto" | "osaka" | "fukuoka" | "niigata" | "sendai"): ValidationResult
```

チェック項目：

1. **同一駅通過禁止**：全 solved path 上のすべての停車駅（origin/destination/pass_through）に同一駅が複数回登場していないか。
2. **区間内完結**：全 leg の from/to station が近郊区間ポリゴン内に収まっているか。
3. **JR のみ**：大回りの対象は JR 線のみ。operator != JR の leg がある場合は警告。
4. **折り返し禁止**：同一 way/node を逆方向に通っていないか（graph レベルで検出）。
5. **乗車区間の連続性**：`legs[i].to_station == legs[i+1].from_station`（または同一駅区）。

UIでのフィードバック：

- バリデーション結果をサイドパネルに表示
- 重複駅は地図上で赤色 marker
- 区外 leg は polyline をオレンジ点線で表示
- 「この大回りは有効です ✓」/ 「無効：○○駅を2回通過しています」バナー

### 17.3 近郊区間ポリゴン

区間ポリゴンは `data/omawari_zones.geojson` として管理する：

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "zone": "kanto", "name": "東京近郊区間" },
      "geometry": { "type": "Polygon", "coordinates": [[...]] }
    }
  ]
}
```

初版は手書き近似ポリゴンでよい。将来的には国土数値情報の鉄道線路データから自動生成する。

---

## 18. 技術スタックと具体的 CDN

すべて単一 HTML ファイルか静的ファイルで動くよう、CDN のみで依存解決する。

### 18.1 CDN 一覧

```html
<!-- Leaflet 1.9.x -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- PDF.js 4.x (ES module build) -->
<script type="module">
  import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
</script>

<!-- Turf.js (GeoJSON 空間演算) -->
<script src="https://unpkg.com/@turf/turf@6/turf.min.js"></script>

<!-- Fuse.js (ファジー検索、駅名マッチング) -->
<script src="https://cdn.jsdelivr.net/npm/fuse.js@7/dist/fuse.min.js"></script>
```

### 18.2 タイルレイヤー

| 名前 | URL テンプレート | 用途 |
|---|---|---|
| OSM 標準タイル | `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` | 基本ベースマップ |
| OpenRailwayMap | `https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png` | 鉄道参考オーバーレイ |
| 地理院タイル | `https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png` | 日本語地名ベースマップ |

※ OpenRailwayMap はデータソースには使わない。ビジュアル参考のみ。

### 18.3 Overpass エンドポイント候補

```js
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
```

レート制限を避けるため、キャッシュヒット時はエンドポイントを使わない。失敗時は次のエンドポイントにフォールバックする。

---

## 19. サンプルデータ定義

### 19.1 `data/sample_itinerary.json` 完全例

関東大回りの定番コース（錦糸町起点）：

```json
{
  "trip_title": "関東大回り（錦糸町起点）",
  "date": "2025-11-23",
  "source_pdf_name": null,
  "zone": "kanto",
  "fare_origin": "錦糸町",
  "fare_destination": "錦糸町",
  "legs": [
    {
      "leg_id": 1,
      "mode": "train",
      "line_name": "総武線各駅停車",
      "operator": "JR東日本",
      "from_station": "錦糸町",
      "to_station": "千葉",
      "depart_time": "08:00",
      "arrive_time": "08:38",
      "train_number": "B823S",
      "depart_platform": "2",
      "arrive_platform": "5",
      "notes": null
    },
    {
      "leg_id": 2,
      "mode": "train",
      "line_name": "内房線",
      "operator": "JR東日本",
      "from_station": "千葉",
      "to_station": "蘇我",
      "depart_time": "08:50",
      "arrive_time": "09:02",
      "train_number": "339M",
      "depart_platform": "4",
      "arrive_platform": "1",
      "notes": null
    },
    {
      "leg_id": 3,
      "mode": "train",
      "line_name": "内房線",
      "operator": "JR東日本",
      "from_station": "蘇我",
      "to_station": "安房鴨川",
      "depart_time": "09:10",
      "arrive_time": "11:02",
      "train_number": "141M",
      "notes": "外房回り接続"
    },
    {
      "leg_id": 4,
      "mode": "train",
      "line_name": "外房線",
      "operator": "JR東日本",
      "from_station": "安房鴨川",
      "to_station": "蘇我",
      "depart_time": "11:20",
      "arrive_time": "13:15",
      "train_number": "1360M"
    },
    {
      "leg_id": 5,
      "mode": "train",
      "line_name": "京葉線",
      "operator": "JR東日本",
      "from_station": "蘇我",
      "to_station": "東京",
      "depart_time": "13:30",
      "arrive_time": "14:02",
      "train_number": "1242A"
    },
    {
      "leg_id": 6,
      "mode": "train",
      "line_name": "中央線快速",
      "operator": "JR東日本",
      "from_station": "東京",
      "to_station": "立川",
      "depart_time": "14:15",
      "arrive_time": "14:50",
      "train_number": "1131T"
    },
    {
      "leg_id": 7,
      "mode": "train",
      "line_name": "南武線",
      "operator": "JR東日本",
      "from_station": "立川",
      "to_station": "川崎",
      "depart_time": "15:05",
      "arrive_time": "16:10",
      "train_number": "1437F"
    },
    {
      "leg_id": 8,
      "mode": "train",
      "line_name": "東海道線",
      "operator": "JR東日本",
      "from_station": "川崎",
      "to_station": "錦糸町",
      "depart_time": "16:20",
      "arrive_time": null,
      "notes": "東京乗換→総武快速線直通"
    }
  ],
  "warnings": []
}
```

### 19.2 `data/station_aliases_ja.json` 例

```json
{
  "錦糸町": ["錦糸町駅", "Kinshicho"],
  "東京": ["東京駅", "Tokyo", "東京ターミナル"],
  "千葉": ["千葉駅", "Chiba"],
  "蘇我": ["蘇我駅", "Soga"],
  "安房鴨川": ["安房鴨川駅", "Awa-Kamogawa"],
  "立川": ["立川駅", "Tachikawa"],
  "川崎": ["川崎駅", "Kawasaki"]
}
```

### 19.3 `data/line_aliases_ja.json` 例

```json
{
  "総武線各駅停車": ["総武線", "JR総武線", "Chuo-Sobu Line", "中央・総武線"],
  "総武快速線": ["JR総武快速線", "総武線快速", "Sobu Rapid Line"],
  "内房線": ["JR内房線", "Uchibo Line"],
  "外房線": ["JR外房線", "Sotobou Line"],
  "京葉線": ["JR京葉線", "Keiyo Line"],
  "中央線快速": ["中央快速線", "JR中央線", "Chuo Line Rapid"],
  "南武線": ["JR南武線", "Nambu Line"],
  "東海道線": ["JR東海道線", "東海道本線", "Tokaido Line"]
}
```

---

## 20. 既知の大回りテストケース

開発中の回帰テスト用。少なくとも以下のルートで Phase 3 以降の route solver が正しく動くことを確認する。

| テスト ID | 出発駅 | 到着駅 | 主な経由路線 | 備考 |
|---|---|---|---|---|
| kanto-01 | 錦糸町 | 錦糸町 | 総武・内房・外房・京葉・中央・南武・東海道 | 定番千葉ぐるり |
| kanto-02 | 大宮 | 大宮 | 高崎線・上越線・両毛線・水戸線・東北本線 | 北関東大回り |
| kanto-03 | 立川 | 立川 | 青梅線・五日市線・八高線・横浜線 | 西多摩大回り |
| osaka-01 | 大阪 | 大阪 | 環状線・阪和線・和歌山線・桜井線・大和路線 | 関西大回り |
| osaka-02 | 京都 | 京都 | 湖西線・北陸線・草津線・関西線 | 琵琶湖ぐるり |

テストケースは `data/test_itineraries/` 以下に JSON として保存する。

---

## 21. PDF 形式ガイドライン（推奨入力フォーマット）

自分で大回り記録 PDF を作る場合、以下のフォーマットに沿っていると自動解析精度が高い。

### 21.1 推奨テーブル形式

```
| # | 路線名         | 列車番号 | 出発駅   | 発時刻 | 到着駅   | 着時刻 | 備考      |
|---|--------------|--------|--------|------|--------|------|---------|
| 1 | 総武線各駅停車    | B823S  | 錦糸町   | 08:00 | 千葉     | 08:38 |         |
| 2 | 内房線          | 339M   | 千葉     | 08:50 | 蘇我     | 09:02 |         |
```

### 21.2 推奨テキスト形式

```
08:00 錦糸町 発 → 08:38 千葉 着（総武線各駅停車 B823S）
08:50 千葉 発 → 09:02 蘇我 着（内房線 339M）
```

### 21.3 自動解析が難しいケース

- 路線図スキャン（OCR 前処理が必要）
- 時刻表アプリのスクリーンショット（構造が多様）
- 路線名が略称のみ（エイリアス表で対応）

---

## 22. 開発環境セットアップ

### 22.1 ローカル開発サーバー

```bash
# 静的ファイルの開発サーバー（Fetch API は file:// では動作しないため必須）
cd omawarimap
python3 -m http.server 8080
# または
npx serve .
```

ブラウザで `http://localhost:8080` を開く。

### 22.2 OSM 前処理（オプション）

```bash
# Python 依存のインストール
pip install osmium pyproj shapely tqdm requests

# Geofabrik から日本データを取得して抽出
python3 tools/preprocess_osm_japan.py \
  --input japan-latest.osm.pbf \
  --output data/ \
  --filter railway

# または小さい地域で試す
python3 tools/preprocess_osm_japan.py \
  --input kanto-latest.osm.pbf \
  --output data/ \
  --filter railway
```

### 22.3 ブラウザ開発者ツールの活用

- **Network タブ**：Overpass クエリの応答サイズ・時間を監視
- **Application > IndexedDB**：OSM キャッシュの中身を確認・削除
- **Console**：`window.__omawari_debug` に内部状態を公開する（デバッグモード時）

### 22.4 推奨 VSCode 拡張

- `ritwickdey.LiveServer`：保存時に自動リロード
- `dbaeumer.vscode-eslint`：JS linting
- `esbenp.prettier-vscode`：コードフォーマット
- `ms-python.python`：前処理スクリプト用

---

## 23. IndexedDB キャッシュ設計

```js
// DB name: omawari_cache, version: 1
// Object stores:
//   overpass_cache: keyPath = "cache_key"
//     { cache_key, bbox_str, query_hash, timestamp, osm_timestamp, data }
//   station_index: keyPath = "normalized_name"
//     { normalized_name, aliases, osm_ids, lat, lon, operator, line_names }
//   project_autosave: keyPath = "id"
//     { id: "current", itinerary, solved_routes, timestamp }
```

キャッシュ有効期限：デフォルト 7 日。ユーザーが設定可能。
`Clear Cache` ボタンを UI に設ける。

---

## 24. エラーハンドリング方針

| エラー種別 | 対応 |
|---|---|
| Overpass タイムアウト | 別エンドポイントにリトライ、それでも失敗なら「手動 JSON 入力に切り替える」リンク表示 |
| 駅名が見つからない | warnings に追加、地図上に「未解決」マーカー表示、ユーザーが手動で OSM ID 入力できる |
| PDF テキスト抽出ゼロ | 「スキャン PDF の可能性があります。JSON 形式で手動入力してください」メッセージ |
| ルート求解失敗（孤立グラフ） | 直線フォールバック（破線）で表示、confidence = 0、警告表示 |
| CORS ブロック | Overpass CORS は基本問題ないが、GeoJSON ファイルをローカル開発で fetch する場合はサーバー必須旨を表示 |

---

## 25. アクセシビリティと多言語

- 地図 UI の主要テキストは日本語（`lang="ja"`）
- ポップアップ・サイドパネルは日英切り替え可能にする（Phase 6 以降）
- Leaflet の `keyboard: true` を有効にして、キーボードで地図操作できるようにする
- カラーパレットは色覚多様性に配慮（Polyline の色は hue のみでなく線種も変える）

---

## 26. 更新履歴

| バージョン | 日付 | 変更内容 |
|---|---|---|
| 0.1 | 2026-05-26 | 初版作成 |
| 0.2 | 2026-05-26 | 大回りバリデーション、技術スタック、サンプルデータ、テストケース、開発環境、キャッシュ設計、エラーハンドリング追加 |

---

## 27. 次のステップ・タスク一覧

### Phase 1（静的地図）

- [ ] `index.html`・`css/style.css`・`js/app.js` 作成
- [ ] Leaflet + OSM タイル表示
- [ ] `data/sample_itinerary.json` 作成（上記錦糸町ルート）
- [ ] `data/omawari_zones.geojson` 初版（関東・大阪の概略ポリゴン）
- [ ] 手書き polyline で sample ルートを地図上に表示
- [ ] leg クリックで左パネルがハイライト連動

### Phase 2（Overpass + 駅名マッチング）

- [ ] `js/osm_downloader.js`：Overpass クエリとキャッシュ
- [ ] `js/station_matcher.js`：Fuse.js ファジーマッチ + alias 表
- [ ] IndexedDB キャッシュ層
- [ ] `data/station_aliases_ja.json`・`data/line_aliases_ja.json` 充実化
- [ ] マッチング候補の UI 表示

### Phase 3（railway graph + ルート求解）

- [ ] `js/osm_normalizer.js`：OSM `out geom` JSON → GeoJSON + graph データ（各 way の geometry 座標列を保持）
- [ ] `js/railway_graph.js`：隣接リスト構築（edge に geometry を持たせる）
- [ ] `js/route_solver.js`：Dijkstra + penalty
- [ ] `assembleGeometry()`：way 列の首尾接続アルゴリズム実装
- [ ] `snapStationToTrack()`：駅を最近軌道に投影
- [ ] `trimGeometryToStations()`：始終点で geometry を切り取り
- [ ] route relation 直接利用パス（relation 内 way 列挙 → geometry 直接採用）
- [ ] solved path → Leaflet polyline 描画（**GeoJSON [lon,lat] → Leaflet [lat,lon] 変換を必ず通す**）
- [ ] debug パネル：使用 way 数・snapping 誤差・総距離表示
- [ ] 直線退化チェックのアサーション（節点数 < 5 かつ距離 > 2km でエラー）
- [ ] confidence スコアと使用 OSM way ids の表示

### Phase 4（沿途駅・換乗駅）

- [ ] `js/station_detector.js`：Turf.js で polyline 沿い駅検出
- [ ] 換乗駅識別ロジック
- [ ] 大回りバリデーション（重複駅チェック）
- [ ] 各駅種別 marker と popup 実装

### Phase 5（PDF 解析）

- [ ] `js/pdf_parser.js`：PDF.js で text item 抽出
- [ ] 行集計とパースルール
- [ ] 確認・修正 UI（テーブル編集）

### Phase 6（導出・プロジェクト保存）

- [ ] `js/export_tools.js`：GeoJSON / CSV / project JSON 出力
- [ ] IndexedDB への自動保存 + 読み込み
- [ ] attribution フッター

### Phase 7（離線前処理）

- [ ] `tools/preprocess_osm_japan.py` 実装
- [ ] Geofabrik PBF → compact railway graph
- [ ] `tools/README_preprocess.md`

### その他

- [ ] kanto-01〜osaka-02 テストケース JSON 作成
- [ ] README.md（ライセンス表記・使い方）
- [ ] GitHub Actions で静的サイトを GitHub Pages にデプロイ
