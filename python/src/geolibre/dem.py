"""USGS 3DEP Digital Elevation Model (DEM) services module.

Provides querying, downloading, and footprint conversion for USGS The National Map (TNM)
elevation datasets and 24K Topo Quad searches.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import pathlib
import re
import urllib.parse
import urllib.request
from typing import Any, Mapping, Sequence

USGS_TNM_PRODUCTS_ENDPOINT = "https://tnmaccess.nationalmap.gov/api/v1/products"
USGS_24K_QUAD_ENDPOINT = (
    "https://carto.nationalmap.gov/arcgis/rest/services/USTopoAvailability/MapServer/0/query"
)

USGS_DEM_DATASETS = [
    "Digital Elevation Model (DEM) 1 meter",
    "National Elevation Dataset (NED) 1/3 arc-second",
    "National Elevation Dataset (NED) 1 arc-second",
    "National Elevation Dataset (NED) 1/9 arc-second",
    "Digital Elevation Model (DEM) 1/3 arc-second",
    "Digital Elevation Model (DEM) 1 arc-second",
    "Digital Elevation Model (DEM) 1/9 arc-second",
    "Digital Elevation Model (DEM) 2 arc-second",
    "Alaska 5 meter DEM",
    "Original Product Resolution (OPR) Digital Elevation Model (DEM)",
    "Lidar Point Cloud (LPC)",
]


def extract_raw_dem_name(title: str) -> str:
    """Extract a normalized DEM base name from a raw USGS product title.

    Args:
        title: Raw title string from USGS metadata.

    Returns:
        Normalized key for deduplication.
    """
    if not title:
        return ""
    clean = title.strip()
    clean = re.sub(
        r"^USGS\s+(?:NED|3DEP|13\s+arc-second|1\s+arc-second|1m\s+)?",
        "",
        clean,
        flags=re.IGNORECASE,
    )
    clean = re.sub(
        r"\s+(?:GeoTIFF|IMG|ArcGrid|1x1\s+degree|Shapefile).*$",
        "",
        clean,
        flags=re.IGNORECASE,
    )
    match_1m = re.search(r"x\d+y\d+", clean, flags=re.IGNORECASE)
    if match_1m:
        return match_1m.group(0).lower()
    return clean.lower()


def filter_redundant_dem_records(records: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filter out redundant or duplicate partial DEM tiles from a list of records.

    Args:
        records: List of normalized DEM dictionaries.

    Returns:
        Deduplicated list of DEM items.
    """
    seen: dict[str, dict[str, Any]] = {}
    for rec in records:
        key = extract_raw_dem_name(rec.get("title", "")) or rec.get("title") or rec.get("id", "")
        existing = seen.get(key)
        if not existing:
            seen[key] = rec
            continue

        existing_pub = str(existing.get("publicationDate", ""))
        rec_pub = str(rec.get("publicationDate", ""))
        existing_url = str(existing.get("downloadUrl", ""))
        rec_url = str(rec.get("downloadUrl", ""))

        if rec_pub > existing_pub or (not existing_url.endswith(".tif") and rec_url.endswith(".tif")):
            seen[key] = rec

    return list(seen.values())


def get_24k_quad_bbox(quad_name: str, state_name: str) -> list[float] | None:
    """Look up the bounding box of a USGS 1:24,000 Topo Quad.

    Args:
        quad_name: Topo Quad name (e.g. "Mount St. Helens").
        state_name: 2-letter state abbreviation (e.g. "WA").

    Returns:
        [minX, minY, maxX, maxY] (west, south, east, north) in WGS84, or None if not found.
    """
    clean_quad = quad_name.strip().replace("'", "''")
    clean_state = state_name.strip().upper().replace("'", "''")
    if not clean_quad or not clean_state:
        return None

    where_clause = f"CELL_NAME='{clean_quad}' AND PRIMARY_STATE='{clean_state}'"
    params = {
        "where": where_clause,
        "outFields": "CELL_NAME,PRIMARY_STATE",
        "returnGeometry": "true",
        "f": "geojson",
    }
    url = f"{USGS_24K_QUAD_ENDPOINT}?{urllib.parse.urlencode(params)}"

    req = urllib.request.Request(url, headers={"User-Agent": "GeoLibre/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    features = body.get("features", [])
    if not features:
        return None

    first = features[0]
    if "bbox" in first and len(first["bbox"]) == 4:
        return [float(x) for x in first["bbox"]]

    geom = first.get("geometry", {})
    if geom.get("type") == "Polygon" and geom.get("coordinates"):
        coords = geom["coordinates"][0]
        if coords:
            min_x = min(pt[0] for pt in coords)
            max_x = max(pt[0] for pt in coords)
            min_y = min(pt[1] for pt in coords)
            max_y = max(pt[1] for pt in coords)
            return [float(min_x), float(min_y), float(max_x), float(max_y)]

    return None


def search_usgs_dem(
    bbox: Sequence[float] | None = None,
    polygon: Sequence[Sequence[float]] | None = None,
    quad: str | None = None,
    state: str | None = None,
    datasets: Sequence[str] | None = None,
    prod_formats: Sequence[str] | None = None,
    max_results: int = 100,
    offset: int = 0,
    date_type: str | None = None,
    start: str | None = None,
    end: str | None = None,
    filter_redundant: bool = True,
    endpoint: str = USGS_TNM_PRODUCTS_ENDPOINT,
) -> list[dict[str, Any]]:
    """Search the USGS The National Map API for Digital Elevation Models (DEMs).

    Args:
        bbox: Optional [minX, minY, maxX, maxY] (west, south, east, north) in WGS84 degrees.
        polygon: Optional sequence of [lng, lat] coordinate pairs defining a polygon.
        quad: Optional 24K Topo Quad name (e.g. "Mount St. Helens").
        state: Optional 2-letter state code for the 24K Quad (e.g. "WA").
        datasets: List of dataset names to search. Defaults to DEM 1m, 1/3 arc-sec, 1 arc-sec.
        prod_formats: List of allowed product formats (e.g. ``["GeoTIFF"]``).
        max_results: Maximum number of records to return.
        offset: Pagination offset index.
        date_type: Optional date filter type.
        start: Optional start date (YYYY-MM-DD).
        end: Optional end date (YYYY-MM-DD).
        filter_redundant: Whether to filter out duplicate/redundant partial tiles.
        endpoint: API endpoint URL override.

    Returns:
        List of normalized DEM record dictionaries with metadata and download URLs.
    """
    if quad and state and bbox is None:
        quad_bbox = get_24k_quad_bbox(quad, state)
        if quad_bbox:
            bbox = quad_bbox
        else:
            raise ValueError(f"Could not find 24K Topo Quad '{quad}' in state '{state}'.")

    params: dict[str, str] = {}

    if datasets:
        params["datasets"] = ",".join(datasets)
    else:
        params["datasets"] = (
            "Digital Elevation Model (DEM) 1 meter,"
            "National Elevation Dataset (NED) 1/3 arc-second,"
            "National Elevation Dataset (NED) 1 arc-second"
        )

    if bbox:
        if len(bbox) != 4:
            raise ValueError("bbox must contain exactly 4 numbers: [minX, minY, maxX, maxY].")
        w, s, e, n = bbox
        params["bbox"] = f"{w},{s},{e},{n}"

    if polygon and len(polygon) >= 3:
        params["polygon"] = json.dumps({"type": "Polygon", "coordinates": [polygon]})

    if prod_formats and "All" not in prod_formats:
        params["prodFormats"] = ",".join(prod_formats)

    params["max"] = str(max(1, max_results))
    if offset > 0:
        params["offset"] = str(offset)

    if date_type:
        params["dateType"] = date_type
    if start:
        params["start"] = start
    if end:
        params["end"] = end

    url = f"{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "GeoLibre/1.0"})

    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    raw_items = data.get("items", []) if isinstance(data, dict) else []
    results: list[dict[str, Any]] = []

    for item in raw_items:
        if not isinstance(item, dict):
            continue

        source_id = str(item.get("sourceId") or item.get("id") or item.get("metaUrl") or "")
        title = str(item.get("title") or "USGS DEM")
        dataset_name = str(item.get("datasetName") or item.get("dataset") or "USGS DEM")
        fmt = str(item.get("format") or item.get("prodFormat") or "GeoTIFF")
        download_url = str(item.get("downloadURL") or item.get("downloadUrl") or "")

        if not download_url:
            continue

        bounding_box = item.get("boundingBox") or {}
        min_x = float(bounding_box.get("minX", bounding_box.get("west", -180)))
        min_y = float(bounding_box.get("minY", bounding_box.get("south", -90)))
        max_x = float(bounding_box.get("maxX", bounding_box.get("east", 180)))
        max_y = float(bounding_box.get("maxY", bounding_box.get("north", 90)))

        rec = {
            "id": source_id,
            "sourceId": source_id,
            "title": title,
            "dataset": dataset_name,
            "format": fmt,
            "downloadUrl": download_url,
            "metaUrl": item.get("metaUrl"),
            "previewUrl": item.get("previewUrl") or item.get("thumbUrl"),
            "sizeBytes": item.get("sizeInBytes"),
            "prettyFileSize": item.get("prettyFileSize"),
            "publicationDate": item.get("publicationDate"),
            "lastUpdated": item.get("lastUpdated"),
            "spatialReference": item.get("spatialReference"),
            "bbox": [min_x, min_y, max_x, max_y],
            "raw": item,
        }
        results.append(rec)

    if filter_redundant:
        return filter_redundant_dem_records(results)
    return results


def download_usgs_dem(
    item_or_url: str | Mapping[str, Any],
    output_dir: str | pathlib.Path | None = None,
    filename: str | None = None,
    overwrite: bool = False,
    chunk_size: int = 65536,
) -> pathlib.Path:
    """Download a single USGS DEM file to disk.

    Args:
        item_or_url: DEM metadata dict or download URL string.
        output_dir: Directory where the file is saved. Defaults to current directory.
        filename: Custom destination filename.
        overwrite: Whether to overwrite an existing local file.
        chunk_size: Stream buffer size in bytes.

    Returns:
        Path to the downloaded DEM file.
    """
    if isinstance(item_or_url, Mapping):
        url = str(item_or_url.get("downloadUrl") or item_or_url.get("downloadURL") or "")
        default_name = str(item_or_url.get("title", ""))
    else:
        url = str(item_or_url)
        default_name = ""

    if not url:
        raise ValueError("Invalid DEM item or URL.")

    out_dir = pathlib.Path(output_dir) if output_dir else pathlib.Path.cwd()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not filename:
        url_name = url.split("?")[0].split("/")[-1]
        filename = url_name if url_name else f"{default_name or 'dem'}.tif"

    dest = out_dir / filename
    if dest.exists() and not overwrite:
        return dest

    req = urllib.request.Request(url, headers={"User-Agent": "GeoLibre/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
        while True:
            chunk = resp.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)

    return dest


def download_usgs_dems(
    items_or_urls: Sequence[str | Mapping[str, Any]],
    output_dir: str | pathlib.Path | None = None,
    max_workers: int = 4,
    overwrite: bool = False,
) -> list[pathlib.Path]:
    """Download multiple USGS DEM files concurrently.

    Args:
        items_or_urls: List of DEM dictionaries or download URLs.
        output_dir: Destination directory for downloaded files.
        max_workers: Maximum number of concurrent download threads.
        overwrite: Whether to overwrite existing files.

    Returns:
        List of Paths to downloaded DEM files.
    """
    paths: list[pathlib.Path] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(
                download_usgs_dem,
                item,
                output_dir=output_dir,
                overwrite=overwrite,
            )
            for item in items_or_urls
        ]
        for future in concurrent.futures.as_completed(futures):
            paths.append(future.result())

    return paths


def dem_items_to_geojson(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Convert a list of DEM items to a GeoJSON FeatureCollection of bounding box footprints.

    Args:
        items: List of DEM metadata dictionaries.

    Returns:
        GeoJSON FeatureCollection dict.
    """
    features: list[dict[str, Any]] = []
    for item in items:
        bbox = item.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        w, s, e, n = bbox
        coordinates = [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ]
        ]
        feat = {
            "type": "Feature",
            "id": str(item.get("id", "")),
            "properties": {
                "id": item.get("id"),
                "title": item.get("title"),
                "dataset": item.get("dataset"),
                "format": item.get("format"),
                "downloadUrl": item.get("downloadUrl"),
                "fileSize": item.get("prettyFileSize"),
                "publicationDate": item.get("publicationDate"),
                "lastUpdated": item.get("lastUpdated"),
                "west": w,
                "south": s,
                "east": e,
                "north": n,
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": coordinates,
            },
        }
        features.append(feat)

    return {"type": "FeatureCollection", "features": features}
