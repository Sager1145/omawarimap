#!/usr/bin/env python3
"""
Extract railway-related OpenStreetMap objects from a Japan OSM PBF.

This script intentionally keeps the first preprocessing step conservative:
it creates a smaller railway-only PBF plus metadata. A later step can convert
that extract into GeoJSON and a browser-friendly graph JSON.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


RAILWAY_FILTERS = [
    "w/railway=rail",
    "n/railway=station,halt",
    "w/railway=station,halt,platform,platform_edge",
    "r/route=train,subway,light_rail",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Preprocess Japan railway OSM data.")
    parser.add_argument("--input", required=True, help="Path to japan-latest.osm.pbf")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument(
        "--osmium",
        default="osmium",
        help="Path to osmium executable. Defaults to osmium in PATH.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing railway_japan.osm.pbf",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "railway_japan.osm.pbf"
    metadata = output_dir / "railway_japan_metadata.json"

    if not source.exists():
        raise SystemExit(f"Input PBF does not exist: {source}")

    osmium = shutil.which(args.osmium) or args.osmium
    command = [
        osmium,
        "tags-filter",
        str(source),
        *RAILWAY_FILTERS,
        "-o",
        str(target),
    ]
    if args.overwrite:
        command.append("--overwrite")

    subprocess.run(command, check=True)

    metadata.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": str(source),
                "output": str(target),
                "filters": RAILWAY_FILTERS,
                "attribution": "Map data © OpenStreetMap contributors. OpenStreetMap data is available under the Open Database License.",
                "license": "ODbL",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Wrote {target}")
    print(f"Wrote {metadata}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
