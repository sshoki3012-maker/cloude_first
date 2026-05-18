#!/usr/bin/env python3
"""
Phase 3 scoring CLI.

  score = ln(1 + passengers)
          × time_factor             (from station_schedule, 0.1..1.5)
          × type_time_factor        (from station_type × hour-of-service-day)
          × weather_factor          (1.0 / rain 1.6 / severe 2.0)

Reads the Phase 1/2/3 DuckDB. Computes a ranked list at a given clock time
and, optionally, rebuilds the Folium map with a live JMA weather badge.

  python rank.py --time "23:45" --weather auto --top 10
  python rank.py --time "2026-05-15T23:45" --weather rain --map output.html
  python rank.py --weather none --top 20         # current local time
"""
from __future__ import annotations

import argparse
import datetime as dt
import math
import sys
from pathlib import Path

import duckdb
import folium
import numpy as np
from branca.colormap import LinearColormap
from branca.element import Element

import weather as weather_mod

TYPE_COLORS = {
    "entertainment": "#e75480",
    "hub":           "#ff8c00",
    "business":      "#5a6b85",
    "residential":   "#3a8fb7",
    "mixed":         "#b8b8b8",
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default="osaka_stations.duckdb")
    p.add_argument("--time", default=None,
                   help='HH:MM (e.g. "23:45") or full ISO timestamp. '
                        "Default: now")
    p.add_argument("--weather", default="auto",
                   choices=("auto", "none", "rain", "severe"),
                   help="auto = fetch JMA; rain/severe = force flag")
    p.add_argument("--area", default="270000")
    p.add_argument("--top", type=int, default=10)
    p.add_argument("--map", dest="map_path", default=None,
                   help="If given, regenerate the Folium map at this path")
    p.add_argument("--radius", type=int, default=500)
    p.add_argument("--csv-out", default=None,
                   help="Optional CSV dump of ranked stations")
    return p.parse_args()


def parse_when(s: str | None) -> dt.datetime:
    if not s:
        return dt.datetime.now()
    # HH:MM today
    if len(s) <= 5 and ":" in s:
        today = dt.date.today()
        hh, mm = s.split(":")
        return dt.datetime(today.year, today.month, today.day,
                           int(hh), int(mm))
    return dt.datetime.fromisoformat(s)


# ---------------------------------------------------------------------------
# Factor functions
# ---------------------------------------------------------------------------

def _service_hour(now_t: dt.time) -> float:
    """Convert clock time to service-day hour (0..28.99). 0-4:59 → 24-28:59."""
    h = now_t.hour + now_t.minute / 60.0
    return h + 24 if h < 5 else h


def time_coefficient(now_t: dt.time,
                     last: dt.time | None,
                     first: dt.time | None,
                     peak: dt.time | None) -> float:
    """Same step coefficient as Phase 2."""
    def m(t: dt.time | None) -> int | None:
        return None if t is None else t.hour * 60 + t.minute
    n, l, f, p = m(now_t), m(last), m(first), m(peak)
    if None in (n, l, f, p):
        return 1.0
    in_service = (f <= n <= l) if l >= f else (n >= f or n <= l)
    if not in_service:
        return 0.1
    in_peak = (p <= n <= l) if l >= p else (n >= p or n <= l)
    if in_peak:
        return 1.5
    pre = (p - 120) % 1440
    in_pre = (pre <= n < p) if pre <= p else (n >= pre or n < p)
    return 1.2 if in_pre else 0.7


def type_time_factor(station_type: str | None,
                     now_t: dt.time,
                     weekday_type: str) -> float:
    """User-specified boosts; identical windows for 平日 and 土日 unless noted."""
    if not station_type:
        return 1.0
    h = _service_hour(now_t)
    if station_type == "entertainment":
        return 2.5 if 23.0 <= h < 26.0 else 1.0
    if station_type == "residential":
        return 2.0 if 22.0 <= h < 24.0 else 1.0
    if station_type == "business":
        # commute-home window — only 平日
        if weekday_type == "平日" and 19.0 <= h < 22.0:
            return 1.5
        return 1.0
    if station_type == "hub":
        return 1.3
    return 1.0


def weather_factor(weather: dict) -> float:
    if weather.get("severe_flag"):
        return 2.0
    if weather.get("rain_flag"):
        return 1.6
    return 1.0


def weekday_type_of(ts: dt.datetime) -> str:
    return "土日" if ts.weekday() >= 5 else "平日"


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def fetch_stations(con: duckdb.DuckDBPyConnection,
                   weekday_type: str,
                   radius_m: int) -> list[dict]:
    area_km2 = math.pi * (radius_m / 1000.0) ** 2
    rows = con.execute("""
        SELECT s.station_id, s.station_name, s.operator, s.line,
               s.lat, s.lon,
               COALESCE(s.passengers, 0)        AS passengers,
               COALESCE(s.restaurant_count, 0)  AS restaurant_count,
               s.municipality, s.day_night_ratio,
               s.station_type, s.n_lines_at_name,
               sch.last_train_time, sch.first_train_time, sch.peak_pm_end_time,
               COALESCE((SELECT SUM(count) FROM station_amenity a
                         WHERE a.station_id = s.station_id), 0) AS amenity_total
        FROM stations s
        LEFT JOIN station_schedule sch
            ON sch.station_id = s.station_id AND sch.weekday_type = ?;
    """, [weekday_type]).fetchall()
    cols = ("station_id", "station_name", "operator", "line", "lat", "lon",
            "passengers", "restaurant_count", "municipality", "day_night_ratio",
            "station_type", "n_lines_at_name",
            "last_train_time", "first_train_time", "peak_pm_end_time",
            "amenity_total")
    out = []
    for r in rows:
        d = dict(zip(cols, r))
        d["density_per_km2"] = d["amenity_total"] / area_km2
        out.append(d)
    return out


def score_all(stations: list[dict], now_ts: dt.datetime, weather: dict
              ) -> list[dict]:
    weekday = weekday_type_of(now_ts)
    now_t   = now_ts.time()
    wf      = weather_factor(weather)
    for s in stations:
        base = math.log1p(max(int(s["passengers"]), 0))
        tf   = time_coefficient(now_t,
                                s["last_train_time"],
                                s["first_train_time"],
                                s["peak_pm_end_time"])
        ttf  = type_time_factor(s["station_type"], now_t, weekday)
        s["base"]         = base
        s["time_factor"]  = tf
        s["type_factor"]  = ttf
        s["weather_factor"] = wf
        s["score"]        = base * tf * ttf * s["density_per_km2"] * wf
    stations.sort(key=lambda r: r["score"], reverse=True)
    return stations


# ---------------------------------------------------------------------------
# Map
# ---------------------------------------------------------------------------

def build_map(stations: list[dict],
              weather: dict,
              now_ts: dt.datetime,
              output_path: Path,
              radius_m: int) -> None:
    valid = [s for s in stations
             if s["lat"] is not None and s["lon"] is not None]
    if not valid:
        raise RuntimeError("no stations to map")
    scores = np.array([s["score"] for s in valid], dtype=float)
    log_s = np.log1p(np.clip(scores, 0, None))
    norm  = log_s / log_s.max() if log_s.max() > 0 else log_s

    center = [
        float(np.mean([s["lat"] for s in valid])),
        float(np.mean([s["lon"] for s in valid])),
    ]
    fmap = folium.Map(location=center, zoom_start=11, tiles="cartodbpositron")
    cmap = LinearColormap(
        colors=["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"],
        vmin=0.0, vmax=1.0,
        caption=(f"score @ {now_ts.strftime('%Y-%m-%d %H:%M')} "
                 f"({weekday_type_of(now_ts)}, "
                 f"weather×{weather_factor(weather):.1f})"),
    )

    # one layer per station type for filtering
    layers = {t: folium.FeatureGroup(name=f"{t}", show=True)
              for t in TYPE_COLORS}

    for s, n in zip(valid, norm):
        edge = TYPE_COLORS.get(s.get("station_type") or "mixed", "#888")
        fill = cmap(float(n))
        popup_html = (
            f"<b>{s.get('station_name') or ''}</b><br>"
            f"{s.get('operator') or ''} {s.get('line') or ''}<br>"
            f"区市町村: {s.get('municipality') or '-'} "
            f"(昼夜間比 {s.get('day_night_ratio') or '-'})<br>"
            f"type: <b>{s.get('station_type') or '-'}</b> "
            f"(乗線数 {s.get('n_lines_at_name') or '-'})<br>"
            f"乗降客数: {int(s['passengers']):,}<br>"
            f"{radius_m}m amenities: {int(s['amenity_total'])} "
            f"({s['density_per_km2']:.1f}/km²)<br>"
            f"base={s['base']:.2f} × time={s['time_factor']:.2f} "
            f"× type={s['type_factor']:.2f} × weather={s['weather_factor']:.2f}<br>"
            f"<b>score = {s['score']:.2f}</b>"
        )
        folium.CircleMarker(
            location=[s["lat"], s["lon"]],
            radius=float(max(3.0, 3.0 + n * 12.0)),
            color=edge, weight=2,
            fill=True, fill_color=fill, fill_opacity=0.85,
            popup=folium.Popup(popup_html, max_width=320),
        ).add_to(layers.get(s.get("station_type") or "mixed",
                            layers["mixed"]))

    for fg in layers.values():
        fg.add_to(fmap)
    folium.LayerControl(collapsed=False).add_to(fmap)
    cmap.add_to(fmap)

    # Weather badge in the top-right corner.
    fmap.get_root().html.add_child(Element(weather_mod._badge_html(weather)))

    # station_type legend (top-left)
    legend_items = "".join(
        f'<div style="display:flex;align-items:center;margin:2px 0">'
        f'<span style="background:{c};width:12px;height:12px;'
        f'border-radius:6px;display:inline-block;margin-right:6px"></span>'
        f'{t}</div>'
        for t, c in TYPE_COLORS.items()
    )
    legend_html = (
        '<div style="position:fixed;top:12px;left:60px;z-index:9999;'
        'background:rgba(255,255,255,0.92);border-radius:8px;'
        'padding:8px 12px;font:12px/1.4 system-ui,sans-serif;'
        'box-shadow:0 2px 6px rgba(0,0,0,0.15);">'
        '<div style="font-weight:600;margin-bottom:4px">station_type</div>'
        f"{legend_items}"
        '</div>'
    )
    fmap.get_root().html.add_child(Element(legend_html))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fmap.save(str(output_path))
    print(f"[map] wrote {output_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Weather wiring
# ---------------------------------------------------------------------------

def resolve_weather(mode: str, area: str) -> dict:
    if mode == "auto":
        try:
            return weather_mod.fetch_weather(area)
        except Exception as e:
            print(f"[weather] auto fetch failed ({e}); falling back to 'none'",
                  file=sys.stderr)
            mode = "none"
    if mode == "rain":
        return {"rain_flag": True, "severe_flag": False,
                "weather_text": "(forced) 雨", "pop_max": 80,
                "weather_code": "300", "warnings": [],
                "_fetched_at": 0, "_from_cache": False}
    if mode == "severe":
        return {"rain_flag": True, "severe_flag": True,
                "weather_text": "(forced) 警報級", "pop_max": 95,
                "weather_code": "308",
                "warnings": [{"name": "(forced)", "status": "発表"}],
                "_fetched_at": 0, "_from_cache": False}
    return {"rain_flag": False, "severe_flag": False,
            "weather_text": "(forced) 通常", "pop_max": 0,
            "weather_code": "100", "warnings": [],
            "_fetched_at": 0, "_from_cache": False}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    args = parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        print(f"[fatal] {db_path} not found", file=sys.stderr)
        return 2
    when = parse_when(args.time)
    weather = resolve_weather(args.weather, args.area)

    con = duckdb.connect(str(db_path))
    try:
        stations = fetch_stations(con, weekday_type_of(when), args.radius)
    finally:
        con.close()
    stations = score_all(stations, when, weather)

    # Print top N to stdout
    top = stations[:max(args.top, 0)]
    print(f"\n== Top {len(top)} stations @ "
          f"{when.strftime('%Y-%m-%d %H:%M')} "
          f"({weekday_type_of(when)}) "
          f"weather: {weather.get('weather_text') or '-'} "
          f"rain={weather.get('rain_flag')} "
          f"severe={weather.get('severe_flag')} "
          f"×{weather_factor(weather):.1f} ==")
    print(f"{'#':>3} {'station':<14} {'type':<13} {'muni':<10} "
          f"{'pax':>7} {'amen':>4} {'tf':>4} {'ttf':>4} {'score':>8}")
    for i, s in enumerate(top, 1):
        print(f"{i:>3} {(s['station_name'] or '')[:14]:<14} "
              f"{(s['station_type'] or '-'):<13} "
              f"{(s.get('municipality') or '-')[:10]:<10} "
              f"{int(s['passengers']):>7} {int(s['amenity_total']):>4} "
              f"{s['time_factor']:>4.2f} {s['type_factor']:>4.2f} "
              f"{s['score']:>8.2f}")

    if args.csv_out:
        import csv as _csv
        fields = ("station_id", "station_name", "operator", "line",
                  "lat", "lon", "passengers", "amenity_total",
                  "density_per_km2", "municipality", "day_night_ratio",
                  "station_type", "n_lines_at_name",
                  "base", "time_factor", "type_factor", "weather_factor",
                  "score")
        with open(args.csv_out, "w", encoding="utf-8", newline="") as f:
            w = _csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(stations)
        print(f"[csv] wrote {args.csv_out}", file=sys.stderr)

    if args.map_path:
        build_map(stations, weather, when, Path(args.map_path), args.radius)
    return 0


if __name__ == "__main__":
    sys.exit(main())
