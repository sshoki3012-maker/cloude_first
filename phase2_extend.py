#!/usr/bin/env python3
"""
Phase 2 — extend the Osaka stations DuckDB with:

  - station_schedule  (last/first train + evening-peak times per weekday_type)
  - station_amenity   (per-type nightlife amenity counts within --radius)
  - station_score_now (view) and a CSV/console dump computed for --now

Reads the Phase 1 DuckDB produced by `osaka_stations_map.py` and a CSV of
last-train times for major Osaka stations.

CSV schema (header required):

    station_name,operator,weekday_type,last_train_time,first_train_time,peak_pm_end_time
    大阪,西日本旅客鉄道,平日,00:30,05:00,20:00

`operator` is optional (joined loosely if blank). `line` may also be
included as an extra column for finer-grained disambiguation. Time
columns accept HH:MM or HH:MM:SS. Last trains past midnight are written
in the next-day clock (00:30 means 24:30 service-day time).

Score:

    score(station, t) = ln(1 + passengers)
                        × time_coefficient(t, schedule)
                        × restaurant_density_per_km2

`time_coefficient` is a step function in [0.1, 1.5]:
  - outside [first_train, last_train]            -> 0.1
  - within 2 h before peak_pm_end_time           -> 1.2
  - between peak_pm_end_time and last_train_time -> 1.5  (nightlife window)
  - otherwise (daytime inside service)           -> 0.7
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import math
import sys
import time as _time
from pathlib import Path

import duckdb
import numpy as np
import requests

OVERPASS_URL_DEFAULT = "https://overpass-api.de/api/interpreter"
NIGHTLIFE_AMENITIES = ("bar", "pub", "nightclub", "restaurant")
OSAKA_BBOX = {"south": 34.27, "west": 135.10, "north": 35.05, "east": 135.74}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--db", default="osaka_stations.duckdb",
                   help="Phase 1 DuckDB to extend")
    p.add_argument("--csv", default="osaka_last_train.csv",
                   help="Last-train CSV to import")
    p.add_argument("--radius", type=int, default=500,
                   help="Search radius in metres for station_amenity")
    p.add_argument("--overpass-url", default=OVERPASS_URL_DEFAULT)
    p.add_argument("--no-overpass", action="store_true",
                   help="Skip Overpass; assume station_amenity already populated")
    p.add_argument("--now", default=None,
                   help="ISO timestamp for scoring (default: current local time)")
    p.add_argument("--score-out", default=None,
                   help="Optional CSV path to dump computed scores")
    p.add_argument("--top", type=int, default=20,
                   help="Print top N stations by score to stdout")
    return p.parse_args()


# ---------------------------------------------------------------------------
# station_id
# ---------------------------------------------------------------------------

def make_station_id(name: str | None,
                    operator: str | None,
                    line: str | None) -> str:
    seed = "|".join([(name or ""), (operator or ""), (line or "")])
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]


def ensure_station_id(con: duckdb.DuckDBPyConnection) -> None:
    cols = {r[1] for r in con.execute("PRAGMA table_info('stations')").fetchall()}
    if "station_id" not in cols:
        print("[phase2] adding station_id to stations", file=sys.stderr)
        con.execute("ALTER TABLE stations ADD COLUMN station_id VARCHAR;")
    # Always (re)compute so Phase 1 reruns refresh the IDs deterministically.
    try:
        con.remove_function("_mkid")
    except (duckdb.Error, AttributeError):
        pass
    con.create_function(
        "_mkid", make_station_id,
        ["VARCHAR", "VARCHAR", "VARCHAR"], "VARCHAR",
    )
    con.execute("""
        UPDATE stations SET station_id = _mkid(
            COALESCE(station_name, ''),
            COALESCE(operator, ''),
            COALESCE(line, '')
        );
    """)


# ---------------------------------------------------------------------------
# station_schedule
# ---------------------------------------------------------------------------

def create_schedule_table(con: duckdb.DuckDBPyConnection,
                          csv_path: Path) -> int:
    con.execute("DROP TABLE IF EXISTS station_schedule;")
    con.execute("""
        CREATE TABLE station_schedule (
            station_id        VARCHAR NOT NULL,
            weekday_type      VARCHAR NOT NULL,
            last_train_time   TIME,
            first_train_time  TIME,
            peak_pm_end_time  TIME,
            PRIMARY KEY (station_id, weekday_type)
        );
    """)
    if not csv_path.exists():
        print(f"[schedule] CSV {csv_path} not found; "
              "table created empty", file=sys.stderr)
        return 0

    con.execute(
        "CREATE OR REPLACE TEMP VIEW _sched_csv AS "
        f"SELECT * FROM read_csv_auto('{csv_path}', header=True);"
    )
    csv_cols = {r[0] for r in con.execute("DESCRIBE _sched_csv").fetchall()}
    needed = {"station_name", "weekday_type", "last_train_time",
              "first_train_time", "peak_pm_end_time"}
    missing = needed - csv_cols
    if missing:
        raise ValueError(
            f"{csv_path} missing required columns: {sorted(missing)}"
        )
    has_op = "operator" in csv_cols
    has_line = "line" in csv_cols

    join = ["s.station_name = c.station_name"]
    if has_op:
        join.append(
            "(c.operator IS NULL OR c.operator = '' OR s.operator = c.operator)"
        )
    if has_line:
        join.append(
            "(c.line IS NULL OR c.line = '' OR s.line = c.line)"
        )
    join_sql = " AND ".join(join)

    # ROW_NUMBER picks one CSV row per (station_id, weekday_type) when the
    # CSV has duplicates (e.g. two operators tagged the same station).
    con.execute(f"""
        INSERT INTO station_schedule
        WITH joined AS (
            SELECT s.station_id,
                   c.weekday_type,
                   c.last_train_time,
                   c.first_train_time,
                   c.peak_pm_end_time,
                   ROW_NUMBER() OVER (
                       PARTITION BY s.station_id, c.weekday_type
                       ORDER BY c.last_train_time
                   ) AS rn
            FROM _sched_csv c
            JOIN stations s ON {join_sql}
        )
        SELECT station_id,
               weekday_type,
               CAST(last_train_time AS TIME),
               CAST(first_train_time AS TIME),
               CAST(peak_pm_end_time AS TIME)
        FROM joined
        WHERE rn = 1;
    """)
    n = con.execute("SELECT COUNT(*) FROM station_schedule").fetchone()[0]
    matched = con.execute(
        "SELECT COUNT(DISTINCT station_id) FROM station_schedule"
    ).fetchone()[0]
    print(f"[schedule] imported {n} rows covering {matched} unique stations",
          file=sys.stderr)
    return n


# ---------------------------------------------------------------------------
# station_amenity
# ---------------------------------------------------------------------------

def query_overpass_amenities(url: str,
                             amenities: tuple[str, ...]
                             ) -> dict[str, list[tuple[float, float]]]:
    bbox = (OSAKA_BBOX["south"], OSAKA_BBOX["west"],
            OSAKA_BBOX["north"], OSAKA_BBOX["east"])
    regex = "|".join(amenities)
    q = (
        "[out:json][timeout:300];"
        "("
        f'node["amenity"~"^({regex})$"]'
        f"({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]});"
        f'way["amenity"~"^({regex})$"]'
        f"({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]});"
        ");"
        "out tags center;"
    )
    print(f"[overpass] querying {url}", file=sys.stderr)
    last: Exception | None = None
    for i in range(4):
        try:
            r = requests.post(url, data={"data": q}, timeout=300)
            r.raise_for_status()
            data = r.json()
            break
        except (requests.RequestException, ValueError) as e:
            last = e
            wait = 2 ** i
            print(f"[overpass] attempt {i + 1} failed ({e}); "
                  f"retry in {wait}s", file=sys.stderr)
            _time.sleep(wait)
    else:
        raise RuntimeError(f"Overpass failed: {last}")

    grouped: dict[str, list[tuple[float, float]]] = {a: [] for a in amenities}
    for el in data.get("elements", []):
        tag = (el.get("tags") or {}).get("amenity")
        if tag not in grouped:
            continue
        if el.get("type") == "node":
            grouped[tag].append((el["lat"], el["lon"]))
        elif "center" in el:
            grouped[tag].append((el["center"]["lat"], el["center"]["lon"]))
    for a, pts in grouped.items():
        print(f"[overpass]   {a}: {len(pts)}", file=sys.stderr)
    return grouped


def populate_station_amenity(con: duckdb.DuckDBPyConnection,
                             points_by_type: dict[str, list[tuple[float, float]]],
                             radius_m: int) -> int:
    con.execute("DROP TABLE IF EXISTS station_amenity;")
    con.execute("""
        CREATE TABLE station_amenity (
            station_id   VARCHAR NOT NULL,
            amenity_type VARCHAR NOT NULL,
            count        INTEGER NOT NULL,
            radius_m     INTEGER NOT NULL,
            PRIMARY KEY (station_id, amenity_type, radius_m)
        );
    """)
    stations = con.execute(
        "SELECT station_id, lat, lon FROM stations "
        "WHERE station_id IS NOT NULL"
    ).fetchall()
    if not stations:
        return 0

    sids = np.array([s[0] for s in stations])
    lats = np.array([s[1] for s in stations], dtype=float)
    lons = np.array([s[2] for s in stations], dtype=float)
    cos_lat = np.cos(np.radians(lats))
    r2 = float(radius_m * radius_m)

    rows: list[tuple[str, str, int, int]] = []
    for amenity, pts in points_by_type.items():
        if not pts:
            for sid in sids:
                rows.append((sid, amenity, 0, radius_m))
            continue
        arr = np.asarray(pts, dtype=float)
        # broadcast: (n_stations, n_points)
        dlat = (arr[:, 0][None, :] - lats[:, None]) * 111_320.0
        dlon = ((arr[:, 1][None, :] - lons[:, None])
                * 111_320.0 * cos_lat[:, None])
        d2 = dlat * dlat + dlon * dlon
        counts = (d2 <= r2).sum(axis=1).astype(int)
        for sid, c in zip(sids, counts):
            rows.append((sid, amenity, int(c), radius_m))

    con.executemany(
        "INSERT INTO station_amenity VALUES (?, ?, ?, ?);", rows
    )
    n = con.execute("SELECT COUNT(*) FROM station_amenity").fetchone()[0]
    print(f"[amenity] wrote {n} rows "
          f"({len(NIGHTLIFE_AMENITIES)} types × {len(stations)} stations)",
          file=sys.stderr)
    return n


# ---------------------------------------------------------------------------
# Score
# ---------------------------------------------------------------------------

def _to_min(t: dt.time | None) -> int | None:
    if t is None:
        return None
    return t.hour * 60 + t.minute


def time_coefficient(now_t: dt.time,
                     last: dt.time | None,
                     first: dt.time | None,
                     peak: dt.time | None) -> float:
    """Step coefficient in [0.1, 1.5]; see module docstring."""
    n = _to_min(now_t)
    l = _to_min(last)
    f = _to_min(first)
    p = _to_min(peak)
    if n is None or l is None or f is None or p is None:
        return 1.0

    # Service window: from first_train to last_train, where last_train may
    # be a small number (post-midnight) meaning the window wraps.
    if l >= f:
        in_service = f <= n <= l
    else:
        in_service = n >= f or n <= l
    if not in_service:
        return 0.1

    # Nightlife window is from peak_pm_end_time to last_train_time, again
    # potentially wrapping past midnight.
    if l >= p:
        in_peak = p <= n <= l
    else:
        in_peak = n >= p or n <= l
    if in_peak:
        return 1.5

    # 2 h ramp before peak end.
    pre = (p - 120) % (24 * 60)
    if pre <= p:
        in_pre = pre <= n < p
    else:
        in_pre = n >= pre or n < p
    if in_pre:
        return 1.2

    return 0.7


def _weekday_type(ts: dt.datetime) -> str:
    # Monday=0 .. Sunday=6; Saturday/Sunday -> 土日.
    return "土日" if ts.weekday() >= 5 else "平日"


def compute_scores(con: duckdb.DuckDBPyConnection,
                   now_ts: dt.datetime,
                   radius_m: int) -> list[dict]:
    area_km2 = math.pi * (radius_m / 1000.0) ** 2
    weekday = _weekday_type(now_ts)
    rows = con.execute("""
        SELECT s.station_id, s.station_name, s.operator, s.line,
               s.lat, s.lon, COALESCE(s.passengers, 0) AS passengers,
               sch.last_train_time, sch.first_train_time, sch.peak_pm_end_time,
               COALESCE(SUM(a.count), 0) AS amenity_total
        FROM stations s
        LEFT JOIN station_schedule sch
            ON sch.station_id = s.station_id
           AND sch.weekday_type = ?
        LEFT JOIN station_amenity a
            ON a.station_id = s.station_id
        GROUP BY s.station_id, s.station_name, s.operator, s.line,
                 s.lat, s.lon, s.passengers,
                 sch.last_train_time, sch.first_train_time, sch.peak_pm_end_time;
    """, [weekday]).fetchall()

    out: list[dict] = []
    now_t = now_ts.time()
    for (sid, name, op, line, lat, lon, pax,
         last_t, first_t, peak_t, amenity_total) in rows:
        coef = time_coefficient(now_t, last_t, first_t, peak_t)
        density = float(amenity_total) / area_km2
        score = math.log1p(max(pax, 0)) * coef * density
        out.append({
            "station_id": sid,
            "station_name": name,
            "operator": op,
            "line": line,
            "lat": lat,
            "lon": lon,
            "passengers": int(pax),
            "amenity_total": int(amenity_total),
            "density_per_km2": density,
            "time_coef": coef,
            "weekday_type": weekday,
            "now": now_ts.isoformat(timespec="minutes"),
            "score": score,
        })
    out.sort(key=lambda r: r["score"], reverse=True)
    return out


def store_score_table(con: duckdb.DuckDBPyConnection,
                      scores: list[dict]) -> None:
    con.execute("DROP TABLE IF EXISTS station_score_now;")
    con.execute("""
        CREATE TABLE station_score_now (
            station_id      VARCHAR,
            station_name    VARCHAR,
            operator        VARCHAR,
            line            VARCHAR,
            lat             DOUBLE,
            lon             DOUBLE,
            passengers      BIGINT,
            amenity_total   INTEGER,
            density_per_km2 DOUBLE,
            time_coef       DOUBLE,
            weekday_type    VARCHAR,
            now_ts          VARCHAR,
            score           DOUBLE
        );
    """)
    con.executemany(
        "INSERT INTO station_score_now VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
        [(r["station_id"], r["station_name"], r["operator"], r["line"],
          r["lat"], r["lon"], r["passengers"], r["amenity_total"],
          r["density_per_km2"], r["time_coef"], r["weekday_type"],
          r["now"], r["score"]) for r in scores],
    )


def dump_scores_csv(path: Path, scores: list[dict]) -> None:
    if not scores:
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(scores[0].keys()))
        w.writeheader()
        w.writerows(scores)
    print(f"[score] wrote {len(scores)} rows to {path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    args = parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"[fatal] DuckDB {db_path} not found; "
              "run osaka_stations_map.py first", file=sys.stderr)
        return 2

    if args.now:
        try:
            now_ts = dt.datetime.fromisoformat(args.now)
        except ValueError as e:
            print(f"[fatal] --now is not ISO-8601: {e}", file=sys.stderr)
            return 2
    else:
        now_ts = dt.datetime.now()

    con = duckdb.connect(str(db_path))
    try:
        ensure_station_id(con)
        create_schedule_table(con, Path(args.csv))

        if args.no_overpass:
            # Touch the table to make sure it exists; leave existing rows.
            con.execute("""
                CREATE TABLE IF NOT EXISTS station_amenity (
                    station_id   VARCHAR NOT NULL,
                    amenity_type VARCHAR NOT NULL,
                    count        INTEGER NOT NULL,
                    radius_m     INTEGER NOT NULL,
                    PRIMARY KEY (station_id, amenity_type, radius_m)
                );
            """)
        else:
            try:
                pts = query_overpass_amenities(args.overpass_url,
                                               NIGHTLIFE_AMENITIES)
                populate_station_amenity(con, pts, args.radius)
            except Exception as e:
                print(f"[overpass] giving up: {e}; "
                      "keeping any existing station_amenity rows",
                      file=sys.stderr)
                con.execute("""
                    CREATE TABLE IF NOT EXISTS station_amenity (
                        station_id   VARCHAR NOT NULL,
                        amenity_type VARCHAR NOT NULL,
                        count        INTEGER NOT NULL,
                        radius_m     INTEGER NOT NULL,
                        PRIMARY KEY (station_id, amenity_type, radius_m)
                    );
                """)

        scores = compute_scores(con, now_ts, args.radius)
        store_score_table(con, scores)
        if args.score_out:
            dump_scores_csv(Path(args.score_out), scores)
    finally:
        con.close()

    # Top-N to stdout
    if args.top > 0 and scores:
        print(f"\n== Top {min(args.top, len(scores))} stations at "
              f"{now_ts.isoformat(timespec='minutes')} "
              f"({_weekday_type(now_ts)}) ==")
        print(f"{'rank':>4} {'station':<14} {'operator':<14} "
              f"{'pax':>8} {'amen':>5} {'coef':>5} {'score':>10}")
        for i, r in enumerate(scores[:args.top], 1):
            print(f"{i:>4} {(r['station_name'] or '')[:14]:<14} "
                  f"{(r['operator'] or '')[:14]:<14} "
                  f"{r['passengers']:>8} {r['amenity_total']:>5} "
                  f"{r['time_coef']:>5.2f} {r['score']:>10.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
