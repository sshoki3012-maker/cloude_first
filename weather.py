#!/usr/bin/env python3
"""
JMA weather fetcher for Osaka prefecture (area 270000), with a 10-minute
file-system cache. Importable module + CLI for inspection.

  from weather import fetch_weather
  w = fetch_weather()
  # -> {"rain_flag": bool, "severe_flag": bool, "weather_code": "300",
  #     "weather_text": "雨", "pop_max": 60, "warnings": [...], ...}

CLI:
  python weather.py                    # pretty-prints current weather
  python weather.py --force            # ignore cache
  python weather.py --area 270000
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast/{area}.json"
WARNING_URL  = "https://www.jma.go.jp/bosai/warning/data/warning/{area}.json"

DEFAULT_AREA   = "270000"       # 大阪府
DEFAULT_CACHE  = Path(".cache/weather")
TTL_SEC        = 600            # 10 minutes

# Weather-code classes (JMA): 1xx clear, 2xx cloudy, 3xx rain, 4xx snow.
# A handful of 3xx codes denote thunderstorm / 暴風 — bump those to severe.
SEVERE_CODES = {
    "202", "204", "206", "207",     # 曇一時/時々雨で雷を伴う 系
    "217", "228",                    # 雷を伴う 系
    "308",                           # 雨で暴風を伴う
    "350", "351",                    # 雷雨
    "402", "403", "405", "406", "407", "409",  # 雪混じり/吹雪
}


def fetch_weather(area_code: str = DEFAULT_AREA,
                  cache_dir: Path | None = None,
                  ttl_sec: int = TTL_SEC,
                  force: bool = False,
                  timeout: float = 30.0) -> dict:
    """Fetch JMA forecast + warning for the area, cached for *ttl_sec*."""
    cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{area_code}.json"

    if not force and cache.exists():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            age = time.time() - float(cached.get("_fetched_at", 0))
            if 0 <= age < ttl_sec:
                cached["_cache_age_sec"] = age
                cached["_from_cache"]    = True
                return cached
        except (json.JSONDecodeError, OSError, KeyError, ValueError):
            pass

    forecast = _http_get(FORECAST_URL.format(area=area_code), timeout)
    try:
        warning = _http_get(WARNING_URL.format(area=area_code), timeout)
    except requests.RequestException:
        warning = None

    summary = _summarize(forecast, warning, area_code)
    summary["_fetched_at"]   = time.time()
    summary["_from_cache"]   = False
    summary["_cache_age_sec"] = 0.0
    cache.write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                     encoding="utf-8")
    return summary


def _http_get(url: str, timeout: float) -> dict | list:
    r = requests.get(
        url, timeout=timeout,
        headers={"User-Agent": "osaka-stations/0.1 (+research)"},
    )
    r.raise_for_status()
    return r.json()


def _summarize(forecast: list, warning: dict | None, area_code: str) -> dict:
    out: dict = {
        "area_code":         area_code,
        "rain_flag":         False,
        "severe_flag":       False,
        "weather_code":      None,
        "weather_text":      None,
        "pop_max":           None,
        "publishing_office": None,
        "report_datetime":   None,
        "warnings":          [],
        "headline":          None,
    }
    if not forecast:
        return out

    block = forecast[0]
    out["publishing_office"] = block.get("publishingOffice")
    out["report_datetime"]   = block.get("reportDatetime")

    # First TS that exposes weatherCodes wins; first that exposes pops wins
    # (areas[0] is the prefecture-wide entry).
    for ts in block.get("timeSeries", []):
        for area in ts.get("areas", []):
            codes = area.get("weatherCodes")
            if codes and out["weather_code"] is None:
                out["weather_code"] = codes[0]
                if area.get("weathers"):
                    out["weather_text"] = area["weathers"][0]
            pops = area.get("pops")
            if pops and out["pop_max"] is None:
                try:
                    nums = [int(p) for p in pops if p not in ("", None)]
                    if nums:
                        out["pop_max"] = max(nums)
                except (ValueError, TypeError):
                    pass

    code = out["weather_code"] or ""
    out["rain_flag"] = bool(
        (out["pop_max"] is not None and out["pop_max"] > 50)
        or code.startswith(("3", "4"))
    )
    if code in SEVERE_CODES:
        out["severe_flag"] = True

    if warning:
        try:
            out["headline"] = warning.get("headlineText") or None
            for atype in warning.get("areaTypes", []):
                for area in atype.get("areas", []):
                    for w in area.get("warnings", []):
                        if w.get("status") in ("発表", "継続"):
                            out["warnings"].append({
                                "code":   w.get("code"),
                                "name":   w.get("name"),
                                "status": w.get("status"),
                            })
            if out["warnings"]:
                out["severe_flag"] = True
        except (AttributeError, TypeError):
            pass

    return out


def _badge_html(w: dict) -> str:
    """Self-contained HTML snippet for the Folium weather badge."""
    if w.get("severe_flag"):
        bg, label = "#d7191c", "⚠ 警報"
    elif w.get("rain_flag"):
        bg, label = "#2c7bb6", "☔ 雨"
    else:
        bg, label = "#5aa84a", "☀ 晴/曇"
    text = w.get("weather_text") or w.get("weather_code") or ""
    pop = w.get("pop_max")
    pop_s = f" / 降水確率 {pop}%" if pop is not None else ""
    warns = "".join(f"<li>{w['name']}: {w['status']}</li>"
                    for w in (w.get("warnings") or []))
    warns_html = f"<ul style='margin:4px 0 0 16px;padding:0'>{warns}</ul>" if warns else ""
    return (
        "<div style=\"position:fixed;top:12px;right:12px;z-index:9999;"
        "background:rgba(255,255,255,0.92);border-radius:8px;"
        "padding:8px 12px;font:13px/1.4 system-ui,sans-serif;"
        "box-shadow:0 2px 6px rgba(0,0,0,0.15);max-width:240px;\">"
        f"<div style=\"background:{bg};color:white;font-weight:600;"
        "border-radius:4px;padding:2px 8px;display:inline-block;\">"
        f"{label}</div>"
        f"<div style=\"margin-top:6px\">{text}{pop_s}</div>"
        f"{warns_html}"
        "</div>"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--area", default=DEFAULT_AREA)
    p.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    p.add_argument("--ttl", type=int, default=TTL_SEC)
    p.add_argument("--force", action="store_true")
    args = p.parse_args(argv)

    try:
        w = fetch_weather(args.area, Path(args.cache_dir), args.ttl, args.force)
    except requests.RequestException as e:
        print(f"[weather] fetch failed: {e}", file=sys.stderr)
        return 1
    print(json.dumps(w, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
