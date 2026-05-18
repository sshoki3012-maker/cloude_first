#!/usr/bin/env python3
"""
Phase 3 — load municipality day/night ratios, reverse-lookup each station's
containing municipality, and classify `station_type`.

Adds / refreshes:
  - municipalities      table  (muni_name, area_group, day_night_ratio, centroid)
  - stations columns    municipality, day_night_ratio, n_lines_at_name, station_type

Classification rules (priority order):

  1. entertainment  — restaurant_count > 150
  2. hub            — passengers >= 100_000 AND n_lines_at_name >= 2
  3. business       — day_night_ratio > 1.5
  4. residential    — day_night_ratio < 0.8
  5. mixed          — otherwise

Reverse lookup uses nearest centroid against the bundled CSV
(`osaka_daynight.csv`); 町丁目 granularity is intentionally collapsed to
市区町村 because the e-Stat 昼夜間比 itself is published at that level.

Usage:
  python phase3_extend.py [--db osaka_stations.duckdb]
                          [--daynight osaka_daynight.csv]
                          [--ent-threshold 150]
                          [--hub-passengers 100000]
                          [--hub-lines 2]
"""
from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

import duckdb
import numpy as np


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default="osaka_stations.duckdb")
    p.add_argument("--daynight", default="osaka_daynight.csv")
    p.add_argument("--ent-threshold", type=int, default=150,
                   help="restaurant_count > N → entertainment")
    p.add_argument("--hub-passengers", type=int, default=100_000)
    p.add_argument("--hub-lines",      type=int, default=2)
    p.add_argument("--business-ratio", type=float, default=1.5)
    p.add_argument("--residential-ratio", type=float, default=0.8)
    return p.parse_args()


def load_daynight(con: duckdb.DuckDBPyConnection, csv_path: Path) -> int:
    if not csv_path.exists():
        raise FileNotFoundError(csv_path)
    con.execute("DROP TABLE IF EXISTS municipalities;")
    con.execute("""
        CREATE TABLE municipalities (
            muni_name        VARCHAR PRIMARY KEY,
            area_group       VARCHAR,
            day_night_ratio  DOUBLE,
            centroid_lat     DOUBLE,
            centroid_lon     DOUBLE
        );
    """)
    rows: list[tuple] = []
    with csv_path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append((
                r["muni_name"].strip(),
                r["area_group"].strip(),
                float(r["day_night_ratio"]),
                float(r["centroid_lat"]),
                float(r["centroid_lon"]),
            ))
    con.executemany(
        "INSERT INTO municipalities VALUES (?, ?, ?, ?, ?);", rows
    )
    print(f"[muni] loaded {len(rows)} municipalities", file=sys.stderr)
    return len(rows)


def assign_municipalities(con: duckdb.DuckDBPyConnection) -> None:
    """Nearest-centroid reverse-lookup (lat/lon in degrees, equirectangular
    approximation at each station's latitude)."""
    cols = {r[1] for r in con.execute("PRAGMA table_info('stations')").fetchall()}
    for c, t in (("municipality", "VARCHAR"),
                 ("day_night_ratio", "DOUBLE"),
                 ("n_lines_at_name", "INTEGER"),
                 ("station_type", "VARCHAR")):
        if c not in cols:
            con.execute(f"ALTER TABLE stations ADD COLUMN {c} {t};")

    muni_rows = con.execute(
        "SELECT muni_name, day_night_ratio, centroid_lat, centroid_lon "
        "FROM municipalities;"
    ).fetchall()
    if not muni_rows:
        raise RuntimeError("municipalities table empty")
    names  = np.array([r[0] for r in muni_rows])
    ratios = np.array([r[1] for r in muni_rows], dtype=float)
    mlat   = np.array([r[2] for r in muni_rows], dtype=float)
    mlon   = np.array([r[3] for r in muni_rows], dtype=float)

    stations = con.execute(
        "SELECT station_id, lat, lon FROM stations "
        "WHERE station_id IS NOT NULL;"
    ).fetchall()
    if not stations:
        return
    sids = [s[0] for s in stations]
    slat = np.array([s[1] for s in stations], dtype=float)
    slon = np.array([s[2] for s in stations], dtype=float)
    cos = np.cos(np.radians(slat))

    # (n_stations, n_munis)
    dlat = (mlat[None, :] - slat[:, None]) * 111_320.0
    dlon = ((mlon[None, :] - slon[:, None])
            * 111_320.0 * cos[:, None])
    d2 = dlat * dlat + dlon * dlon
    idx = d2.argmin(axis=1)

    updates = [(names[i], float(ratios[i]), sid)
               for sid, i in zip(sids, idx)]
    con.executemany(
        "UPDATE stations SET municipality = ?, day_night_ratio = ? "
        "WHERE station_id = ?;",
        updates,
    )
    print(f"[muni] reverse-looked-up {len(updates)} stations", file=sys.stderr)


def compute_line_counts(con: duckdb.DuckDBPyConnection) -> None:
    """n_lines_at_name = # distinct line per station_name (cross-operator)."""
    con.execute("""
        UPDATE stations s
        SET n_lines_at_name = sub.n
        FROM (
            SELECT station_name,
                   COUNT(DISTINCT COALESCE(operator, '') || '|'
                                  || COALESCE(line, '')) AS n
            FROM stations
            GROUP BY station_name
        ) sub
        WHERE s.station_name = sub.station_name;
    """)


def classify(con: duckdb.DuckDBPyConnection,
             ent_thr: int, hub_pax: int, hub_lines: int,
             biz_ratio: float, res_ratio: float) -> dict[str, int]:
    con.execute(f"""
        UPDATE stations SET station_type = CASE
            WHEN COALESCE(restaurant_count, 0) > {ent_thr}        THEN 'entertainment'
            WHEN COALESCE(passengers, 0) >= {hub_pax}
                 AND COALESCE(n_lines_at_name, 0) >= {hub_lines}  THEN 'hub'
            WHEN day_night_ratio > {biz_ratio}                    THEN 'business'
            WHEN day_night_ratio < {res_ratio}                    THEN 'residential'
            ELSE 'mixed'
        END;
    """)
    counts = dict(con.execute(
        "SELECT station_type, COUNT(*) FROM stations GROUP BY station_type "
        "ORDER BY COUNT(*) DESC;"
    ).fetchall())
    return counts


def main() -> int:
    args = parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        print(f"[fatal] {db_path} not found; run osaka_stations_map.py first",
              file=sys.stderr)
        return 2
    con = duckdb.connect(str(db_path))
    try:
        load_daynight(con, Path(args.daynight))
        assign_municipalities(con)
        compute_line_counts(con)
        counts = classify(con, args.ent_threshold,
                          args.hub_passengers, args.hub_lines,
                          args.business_ratio, args.residential_ratio)
        print(f"[type] classification: {counts}", file=sys.stderr)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
