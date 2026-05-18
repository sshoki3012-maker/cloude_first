#!/usr/bin/env python3
"""
Osaka station passenger × OSM restaurant density mapper.

Pipeline:
  1. Download MLIT S12 (駅別乗降客数 令和5年度) shapefile.
  2. Filter Osaka prefecture (27) stations and aggregate per station.
  3. Store the table in DuckDB via GeoPandas.
  4. Query OSM amenities around Osaka via Overpass API and attach a
     500 m restaurant count to each station.
  5. Render a Folium map (output.html) coloured by passengers × density.

CLI:
  python osaka_stations_map.py [--output output.html] [--no-overpass] ...
"""
from __future__ import annotations

import argparse
import math
import sys
import time
import zipfile
from pathlib import Path

import duckdb
import folium
import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from branca.colormap import LinearColormap

S12_URL_DEFAULT = "https://nlftp.mlit.go.jp/ksj/gml/data/S12/S12-23/S12-23_GML.zip"
OVERPASS_URL_DEFAULT = "https://overpass-api.de/api/interpreter"

# Bounding box covering Osaka prefecture (27). Used both to prune S12 and to
# query Overpass in one shot. A slight buffer is fine — final counting is
# distance-based per station.
OSAKA_BBOX = {"south": 34.27, "west": 135.10, "north": 35.05, "east": 135.74}

AMENITIES = ["restaurant", "cafe", "fast_food", "bar", "pub"]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--s12-url", default=S12_URL_DEFAULT,
                   help="S12 shapefile zip URL (default: 令和5年度 = S12-23)")
    p.add_argument("--overpass-url", default=OVERPASS_URL_DEFAULT)
    p.add_argument("--cache-dir", default=".cache",
                   help="Directory for cached downloads")
    p.add_argument("--db", default="osaka_stations.duckdb",
                   help="DuckDB file path")
    p.add_argument("--output", default="output.html",
                   help="Output Folium HTML path")
    p.add_argument("--radius", type=int, default=500,
                   help="Search radius in metres (default: 500)")
    p.add_argument("--no-overpass", action="store_true",
                   help="Skip Overpass API (restaurant_count = 0)")
    return p.parse_args()


# ---------------------------------------------------------------------------
# S12 download / load
# ---------------------------------------------------------------------------

def download_s12(url: str, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / url.rsplit("/", 1)[-1]
    if not zip_path.exists() or zip_path.stat().st_size < 1024:
        print(f"[s12] downloading {url}", file=sys.stderr)
        with requests.get(url, stream=True, timeout=180) as r:
            r.raise_for_status()
            with open(zip_path, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
    extract_dir = cache_dir / zip_path.stem
    if not extract_dir.exists():
        extract_dir.mkdir()
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extract_dir)
    shps = list(extract_dir.rglob("*.shp"))
    if not shps:
        raise FileNotFoundError(f"No .shp inside {zip_path}")
    return max(shps, key=lambda p: p.stat().st_size)


def _read_shp(path: Path) -> gpd.GeoDataFrame:
    for enc in ("cp932", "shift_jis", "utf-8"):
        try:
            return gpd.read_file(path, encoding=enc)
        except UnicodeDecodeError:
            continue
    return gpd.read_file(path)


def _detect_passenger_col(gdf: gpd.GeoDataFrame) -> str | None:
    """Pick the latest 乗降客数 numeric field heuristically.

    S12 v3.1 puts yearly passenger counts in columns like S12_037, S12_045, ...
    They are numeric, non-negative and typically range from ~100 to ~10^6.
    """
    candidates: list[tuple[str, float]] = []
    for col in gdf.columns:
        if col == "geometry":
            continue
        s = pd.to_numeric(gdf[col], errors="coerce")
        s = s.dropna()
        if len(s) == 0:
            continue
        # Passenger columns: many distinct large values
        if s.max() >= 100 and s.nunique() > 10 and (s >= 0).all():
            candidates.append((col, float(s.max())))
    if not candidates:
        return None
    # Prefer the last-named S12_* column (chronologically latest).
    s12_cols = [c for c in candidates if c[0].upper().startswith("S12_")]
    pool = s12_cols or candidates
    pool.sort(key=lambda x: x[0])
    return pool[-1][0]


def load_osaka_stations(shp_path: Path) -> gpd.GeoDataFrame:
    print(f"[s12] reading {shp_path.name}", file=sys.stderr)
    gdf = _read_shp(shp_path)
    if gdf.crs is None:
        gdf = gdf.set_crs(4326)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(4326)

    osaka = gdf.cx[OSAKA_BBOX["west"]:OSAKA_BBOX["east"],
                   OSAKA_BBOX["south"]:OSAKA_BBOX["north"]].copy()
    print(f"[s12] {len(osaka)} segments inside Osaka bbox", file=sys.stderr)

    name_col = next((c for c in ("S12_001",) if c in osaka.columns), None)
    op_col   = next((c for c in ("S12_002",) if c in osaka.columns), None)
    line_col = next((c for c in ("S12_003",) if c in osaka.columns), None)
    pax_col  = _detect_passenger_col(osaka)
    print(f"[s12] columns -> name={name_col} op={op_col} line={line_col} "
          f"pax={pax_col}", file=sys.stderr)

    # S12 features are LineStrings (track segments). Collapse to one point
    # per (station, operator, line).
    proj = osaka.to_crs(3857)
    cent = proj.geometry.centroid.to_crs(4326)
    osaka = osaka.assign(lon=cent.x.values, lat=cent.y.values)

    keys = [c for c in (name_col, op_col, line_col) if c]
    agg_kwargs = {"lat": ("lat", "mean"), "lon": ("lon", "mean")}
    if pax_col:
        # cast to numeric defensively, then take the max across duplicates
        osaka[pax_col] = pd.to_numeric(osaka[pax_col], errors="coerce")
        agg_kwargs["passengers"] = (pax_col, "max")
    if keys:
        stations = osaka.groupby(keys, dropna=False).agg(**agg_kwargs).reset_index()
    else:
        stations = osaka[list({*("lat", "lon"), *(k for k in keys)})].copy()

    rename = {}
    if name_col: rename[name_col] = "station_name"
    if op_col:   rename[op_col]   = "operator"
    if line_col: rename[line_col] = "line"
    stations = stations.rename(columns=rename)
    if "passengers" not in stations.columns:
        stations["passengers"] = 0
    stations["passengers"] = stations["passengers"].fillna(0).astype("int64")

    geom = gpd.points_from_xy(stations["lon"], stations["lat"], crs=4326)
    return gpd.GeoDataFrame(stations, geometry=geom, crs=4326)


# ---------------------------------------------------------------------------
# Overpass
# ---------------------------------------------------------------------------

def query_overpass(url: str, amenities: list[str]) -> list[tuple[float, float]]:
    regex = "|".join(amenities)
    bbox = (OSAKA_BBOX["south"], OSAKA_BBOX["west"],
            OSAKA_BBOX["north"], OSAKA_BBOX["east"])
    query = (
        "[out:json][timeout:300];"
        "("
        f'node["amenity"~"^({regex})$"]({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]});'
        f'way["amenity"~"^({regex})$"]({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]});'
        ");"
        "out center;"
    )
    print(f"[overpass] querying {url}", file=sys.stderr)
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            r = requests.post(url, data={"data": query}, timeout=300)
            r.raise_for_status()
            data = r.json()
            break
        except (requests.RequestException, ValueError) as e:
            last_err = e
            wait = 2 ** attempt
            print(f"[overpass] attempt {attempt + 1} failed ({e}); "
                  f"retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    else:
        raise RuntimeError(f"Overpass API failed: {last_err}")

    points: list[tuple[float, float]] = []
    for el in data.get("elements", []):
        if el.get("type") == "node":
            points.append((el["lat"], el["lon"]))
        elif "center" in el:
            points.append((el["center"]["lat"], el["center"]["lon"]))
    print(f"[overpass] {len(points)} amenities returned", file=sys.stderr)
    return points


def attach_restaurant_count(stations: gpd.GeoDataFrame,
                            points: list[tuple[float, float]],
                            radius_m: int) -> gpd.GeoDataFrame:
    if not points:
        stations["restaurant_count"] = 0
        return stations
    arr = np.asarray(points, dtype=float)
    counts = np.zeros(len(stations), dtype=np.int64)
    r2 = radius_m * radius_m
    for i, (lat0, lon0) in enumerate(zip(stations["lat"].values,
                                         stations["lon"].values)):
        dlat = (arr[:, 0] - lat0) * 111_320.0
        dlon = (arr[:, 1] - lon0) * 111_320.0 * math.cos(math.radians(lat0))
        counts[i] = int(((dlat * dlat + dlon * dlon) <= r2).sum())
    stations["restaurant_count"] = counts
    return stations


# ---------------------------------------------------------------------------
# DuckDB
# ---------------------------------------------------------------------------

def write_duckdb(stations: gpd.GeoDataFrame, db_path: str, radius_m: int) -> None:
    con = duckdb.connect(db_path)
    try:
        con.execute("INSTALL spatial;")
        con.execute("LOAD spatial;")
        spatial = True
    except duckdb.Error as e:
        print(f"[duckdb] spatial extension unavailable ({e}); "
              "storing WKT only", file=sys.stderr)
        spatial = False

    df = pd.DataFrame(stations.drop(columns="geometry"))
    df["geom_wkt"] = [f"POINT({lon} {lat})"
                      for lat, lon in zip(df["lat"], df["lon"])]
    df["radius_m"] = radius_m
    con.register("stations_df", df)
    con.execute("DROP TABLE IF EXISTS stations;")
    if spatial:
        con.execute("""
            CREATE TABLE stations AS
            SELECT * EXCLUDE (geom_wkt),
                   ST_GeomFromText(geom_wkt) AS geom
            FROM stations_df;
        """)
    else:
        con.execute("CREATE TABLE stations AS SELECT * FROM stations_df;")
    n = con.execute("SELECT COUNT(*) FROM stations;").fetchone()[0]
    con.close()
    print(f"[duckdb] wrote {n} rows to {db_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Folium map
# ---------------------------------------------------------------------------

def build_map(stations: gpd.GeoDataFrame, output_path: str, radius_m: int) -> None:
    df = stations.copy()
    area_km2 = math.pi * (radius_m / 1000.0) ** 2
    df["density_per_km2"] = df["restaurant_count"] / area_km2
    df["score"] = df["passengers"].astype(float) * df["density_per_km2"]

    log_score = np.log1p(df["score"].clip(lower=0).values)
    norm = log_score / log_score.max() if log_score.max() > 0 else log_score

    center = [df["lat"].mean(), df["lon"].mean()]
    fmap = folium.Map(location=center, zoom_start=11, tiles="cartodbpositron")
    colors = ["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]
    cmap = LinearColormap(
        colors=colors, vmin=0.0, vmax=1.0,
        caption="passengers × restaurant density (log-normalised 0–1)",
    )

    for (_, row), n in zip(df.iterrows(), norm):
        col = cmap(float(n))
        popup = folium.Popup(
            (
                f"<b>{row.get('station_name', '(no name)')}</b><br>"
                f"{row.get('operator', '')} {row.get('line', '')}<br>"
                f"乗降客数: {int(row['passengers']):,}<br>"
                f"{radius_m}m圏内 飲食店: {int(row['restaurant_count'])}"
                f" ({row['density_per_km2']:.1f}/km²)<br>"
                f"スコア: {row['score']:,.0f}"
            ),
            max_width=320,
        )
        folium.CircleMarker(
            location=[row["lat"], row["lon"]],
            radius=float(max(3.0, 3.0 + n * 12.0)),
            color=col, weight=1, fill=True,
            fill_color=col, fill_opacity=0.8,
            popup=popup,
        ).add_to(fmap)

    cmap.add_to(fmap)
    fmap.save(output_path)
    print(f"[map] saved {output_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    args = parse_args()
    cache = Path(args.cache_dir)

    shp = download_s12(args.s12_url, cache)
    stations = load_osaka_stations(shp)
    if stations.empty:
        print("[fatal] no Osaka stations found", file=sys.stderr)
        return 1

    if args.no_overpass:
        stations["restaurant_count"] = 0
    else:
        try:
            points = query_overpass(args.overpass_url, AMENITIES)
            stations = attach_restaurant_count(stations, points, args.radius)
        except Exception as e:
            print(f"[overpass] giving up: {e}; counts set to 0",
                  file=sys.stderr)
            stations["restaurant_count"] = 0

    write_duckdb(stations, args.db, args.radius)
    build_map(stations, args.output, args.radius)
    return 0


if __name__ == "__main__":
    sys.exit(main())
