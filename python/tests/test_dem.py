"""Tests for USGS DEM services and Map DEM layer integration."""

from __future__ import annotations

import io
import json
import pathlib
import urllib.request
from unittest.mock import MagicMock, patch

import pytest

import geolibre
from geolibre.dem import (
    dem_items_to_geojson,
    download_usgs_dem,
    download_usgs_dems,
    extract_raw_dem_name,
    filter_redundant_dem_records,
    get_24k_quad_bbox,
    search_usgs_dem,
)


def _mock_dem_api_payload():
    return {
        "total": 2,
        "items": [
            {
                "sourceId": "dem1",
                "title": "USGS 1 meter x56y478 WA Mount St Helens 2020",
                "datasetName": "Digital Elevation Model (DEM) 1 meter",
                "format": "GeoTIFF",
                "downloadURL": "https://example.com/dem1.tif",
                "metaUrl": "https://example.com/dem1.xml",
                "previewUrl": "https://example.com/dem1.jpg",
                "sizeInBytes": 1048576,
                "prettyFileSize": "1.00 MB",
                "publicationDate": "2021-01-01",
                "boundingBox": {
                    "minX": -122.25,
                    "minY": 46.125,
                    "maxX": -122.125,
                    "maxY": 46.25,
                },
            },
            {
                "sourceId": "dem2",
                "title": "USGS 1/3 arc-second n47w123 WA 2019",
                "datasetName": "Digital Elevation Model (DEM) 1/3 arc-second",
                "format": "GeoTIFF",
                "downloadURL": "https://example.com/dem2.tif",
                "boundingBox": {
                    "minX": -123.0,
                    "minY": 46.0,
                    "maxX": -122.0,
                    "maxY": 47.0,
                },
            },
        ],
    }


def _mock_quad_api_payload():
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "bbox": [-122.25, 46.125, -122.125, 46.25],
                "properties": {"CELL_NAME": "Mount St. Helens", "PRIMARY_STATE": "WA"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [-122.25, 46.125],
                            [-122.125, 46.125],
                            [-122.125, 46.25],
                            [-122.25, 46.25],
                            [-122.25, 46.125],
                        ]
                    ],
                },
            }
        ],
    }


class _MockResponse:
    def __init__(self, data: bytes):
        self._data = data

    def read(self, size: int = -1) -> bytes:
        if size == -1 or size is None:
            res = self._data
            self._data = b""
            return res
        res = self._data[:size]
        self._data = self._data[size:]
        return res

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def test_extract_raw_dem_name():
    assert extract_raw_dem_name("USGS 1 meter x56y478 WA 2020 GeoTIFF") == "x56y478"
    assert "n47w123" in extract_raw_dem_name("USGS NED 1/3 arc-second n47w123 1x1 degree")
    assert extract_raw_dem_name("") == ""


def test_filter_redundant_dem_records():
    rec1 = {
        "id": "1",
        "title": "USGS 1 meter x56y478 WA 2018",
        "downloadUrl": "https://example.com/1.tif",
        "publicationDate": "2018-01-01",
    }
    rec2 = {
        "id": "2",
        "title": "USGS 1 meter x56y478 WA 2022",
        "downloadUrl": "https://example.com/2.tif",
        "publicationDate": "2022-01-01",
    }
    rec3 = {
        "id": "3",
        "title": "USGS 1 meter x99y999 WA 2020",
        "downloadUrl": "https://example.com/3.tif",
        "publicationDate": "2020-01-01",
    }
    filtered = filter_redundant_dem_records([rec1, rec2, rec3])
    assert len(filtered) == 2
    assert filtered[0]["id"] == "2"
    assert filtered[1]["id"] == "3"


@patch("urllib.request.urlopen")
def test_get_24k_quad_bbox(mock_urlopen):
    mock_urlopen.return_value = _MockResponse(json.dumps(_mock_quad_api_payload()).encode("utf-8"))
    bbox = get_24k_quad_bbox("Mount St. Helens", "WA")
    assert bbox == [-122.25, 46.125, -122.125, 46.25]


@patch("urllib.request.urlopen")
def test_search_usgs_dem_bbox(mock_urlopen):
    mock_urlopen.return_value = _MockResponse(json.dumps(_mock_dem_api_payload()).encode("utf-8"))
    results = search_usgs_dem(bbox=[-122.5, 46.1, -122.0, 46.5])
    assert len(results) == 2
    assert results[0]["id"] == "dem1"
    assert results[0]["title"] == "USGS 1 meter x56y478 WA Mount St Helens 2020"
    assert results[0]["format"] == "GeoTIFF"
    assert results[0]["downloadUrl"] == "https://example.com/dem1.tif"
    assert results[0]["bbox"] == [-122.25, 46.125, -122.125, 46.25]


@patch("urllib.request.urlopen")
def test_search_usgs_dem_quad(mock_urlopen):
    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if "USTopoAvailability" in url:
            return _MockResponse(json.dumps(_mock_quad_api_payload()).encode("utf-8"))
        return _MockResponse(json.dumps(_mock_dem_api_payload()).encode("utf-8"))

    mock_urlopen.side_effect = fake_urlopen
    results = search_usgs_dem(quad="Mount St. Helens", state="WA")
    assert len(results) == 2


def test_dem_items_to_geojson():
    items = [
        {
            "id": "dem1",
            "title": "DEM 1",
            "dataset": "DEM 1m",
            "format": "GeoTIFF",
            "downloadUrl": "https://example.com/dem1.tif",
            "prettyFileSize": "1 MB",
            "publicationDate": "2021-01-01",
            "bbox": [-122.25, 46.125, -122.125, 46.25],
        }
    ]
    fc = dem_items_to_geojson(items)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    feat = fc["features"][0]
    assert feat["geometry"]["type"] == "Polygon"
    assert feat["properties"]["title"] == "DEM 1"
    assert feat["properties"]["downloadUrl"] == "https://example.com/dem1.tif"


@patch("urllib.request.urlopen")
def test_download_usgs_dem(mock_urlopen, tmp_path):
    mock_urlopen.return_value = _MockResponse(b"TIFF_DEM_DATA_BYTES")
    out_file = download_usgs_dem(
        {"downloadUrl": "https://example.com/test_dem.tif", "title": "test_dem"},
        output_dir=tmp_path,
    )
    assert out_file.exists()
    assert out_file.read_bytes() == b"TIFF_DEM_DATA_BYTES"


@patch("urllib.request.urlopen")
def test_download_usgs_dems(mock_urlopen, tmp_path):
    mock_urlopen.return_value = _MockResponse(b"TIFF_DEM_DATA_BYTES")
    items = [
        {"downloadUrl": "https://example.com/test_dem_1.tif", "title": "dem1"},
        {"downloadUrl": "https://example.com/test_dem_2.tif", "title": "dem2"},
    ]
    files = download_usgs_dems(items, output_dir=tmp_path)
    assert len(files) == 2
    for f in files:
        assert f.exists()


def test_map_add_usgs_dem():
    m = geolibre.Map()
    dem_item = {
        "downloadUrl": "https://example.com/mount_st_helens.tif",
        "title": "Mount St. Helens 1m DEM",
    }
    layer_id = m.add_usgs_dem(dem_item)
    assert layer_id in [layer.id for layer in m.layers]
    dem_layer = [layer for layer in m.layers if layer.id == layer_id][0]
    assert dem_layer.name == "Mount St. Helens 1m DEM"
    assert dem_layer.type == "cog"


def test_map_add_usgs_dem_footprints():
    m = geolibre.Map()
    dem_items = [
        {
            "id": "dem1",
            "title": "DEM 1",
            "dataset": "DEM 1m",
            "format": "GeoTIFF",
            "downloadUrl": "https://example.com/dem1.tif",
            "bbox": [-122.25, 46.125, -122.125, 46.25],
        }
    ]
    layer_id = m.add_usgs_dem_footprints(dem_items, name="My Footprints")
    assert layer_id in [layer.id for layer in m.layers]
    fp_layer = [layer for layer in m.layers if layer.id == layer_id][0]
    assert fp_layer.name == "My Footprints"
    assert fp_layer.type == "geojson"
