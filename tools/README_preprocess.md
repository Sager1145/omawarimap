# 日本铁路 OSM 预处理

前端可以直接用 Overpass API 下载小范围铁路数据。长距离行程或反复使用时，建议先用 Geofabrik 的日本 PBF 做离线预处理。

## 依赖

- Python 3.10+
- Osmium Tool: https://osmcode.org/osmium-tool/

## 输入

从 Geofabrik 下载日本 OSM extract：

```powershell
Invoke-WebRequest https://download.geofabrik.de/asia/japan-latest.osm.pbf -OutFile data/japan-latest.osm.pbf
```

## 运行

```powershell
python tools/preprocess_osm_japan.py --input data/japan-latest.osm.pbf --output data/preprocessed
```

脚本会生成：

```text
data/preprocessed/
  railway_japan.osm.pbf
  railway_japan_metadata.json
```

后续可以在此基础上继续扩展为：

- `railway_japan_tracks.geojson`
- `railway_japan_stations.geojson`
- `railway_japan_graph.json`
- `railway_japan_relations.json`

## 许可

Geofabrik extract 来自 OpenStreetMap。使用和再分发处理结果时，需要遵守 ODbL，并保留：

```text
Map data © OpenStreetMap contributors. OpenStreetMap data is available under the Open Database License.
```
