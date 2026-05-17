"""西宮市 学文殿町 ごみ収集通知ツール.

使い方:
    python gomi_notifier.py              # 今日と明日の収集予定を表示
    python gomi_notifier.py --week       # 今週の収集予定を表示
    python gomi_notifier.py --date 2026-05-20
    python gomi_notifier.py --notify     # デスクトップ通知 (notify-send/osascript) を試行

収集曜日は schedule.json で変更できます。
西宮市の公式「ごみカレンダー」で最新の収集曜日を確認のうえ schedule.json を更新してください。
    https://www.nishi.or.jp/homepage/gomicalendar/index.html
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

CONFIG_PATH = Path(__file__).with_name("schedule.json")

WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"]
WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def load_schedule(path: Path = CONFIG_PATH) -> dict:
    if not path.exists():
        write_default_schedule(path)
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_default_schedule(path: Path) -> None:
    """学文殿町のデフォルト収集スケジュール (令和8年4月～新分別).

    実際の曜日は西宮市の公式「ごみカレンダー」で町名を検索して確認してください。
    """
    default = {
        "area": "西宮市 学文殿町",
        "note": "西宮市公式『ごみカレンダー』で確認のうえ修正してください。",
        "rules": [
            {"name": "燃やすごみ", "type": "weekly", "days": ["mon", "thu"]},
            {"name": "プラスチック (青袋)", "type": "weekly", "days": ["tue"]},
            {"name": "ペットボトル", "type": "weekly", "days": ["fri"]},
            {
                "name": "缶・びん",
                "type": "biweekly",
                "days": ["wed"],
                "reference_date": "2026-04-08",
            },
            {
                "name": "紙・布",
                "type": "biweekly",
                "days": ["wed"],
                "reference_date": "2026-04-15",
            },
        ],
        "holidays": [],
    }
    path.write_text(
        json.dumps(default, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def is_collection_day(rule: dict, date: dt.date) -> bool:
    weekday_key = WEEKDAY_KEYS[date.weekday()]
    if weekday_key not in rule["days"]:
        return False
    if rule["type"] == "weekly":
        return True
    if rule["type"] == "biweekly":
        ref = dt.date.fromisoformat(rule["reference_date"])
        return ((date - ref).days % 14) == 0
    raise ValueError(f"未知の収集タイプ: {rule['type']}")


def collections_on(date: dt.date, schedule: dict) -> list[str]:
    if date.isoformat() in schedule.get("holidays", []):
        return []
    return [r["name"] for r in schedule["rules"] if is_collection_day(r, date)]


def format_line(date: dt.date, items: list[str]) -> str:
    wd = WEEKDAY_JA[date.weekday()]
    head = f"{date:%Y-%m-%d}({wd})"
    if not items:
        return f"{head}: 収集なし"
    return f"{head}: " + " / ".join(items)


def notify(title: str, message: str) -> bool:
    if shutil.which("notify-send"):
        subprocess.run(["notify-send", title, message], check=False)
        return True
    if shutil.which("osascript"):
        script = f'display notification "{message}" with title "{title}"'
        subprocess.run(["osascript", "-e", script], check=False)
        return True
    return False


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="西宮市 学文殿町 ごみ収集通知ツール")
    p.add_argument("--date", help="基準日 (YYYY-MM-DD)。省略時は今日。")
    p.add_argument("--week", action="store_true", help="今週分 (基準日から7日間) を表示")
    p.add_argument("--notify", action="store_true", help="デスクトップ通知を送信")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    schedule = load_schedule()
    base = dt.date.fromisoformat(args.date) if args.date else dt.date.today()

    print(f"=== {schedule['area']} ごみ収集予定 ===")

    if args.week:
        lines = []
        for i in range(7):
            d = base + dt.timedelta(days=i)
            lines.append(format_line(d, collections_on(d, schedule)))
        body = "\n".join(lines)
        print(body)
        if args.notify:
            notify(f"{schedule['area']} 今週のごみ", body)
        return 0

    today_items = collections_on(base, schedule)
    tomorrow = base + dt.timedelta(days=1)
    tomorrow_items = collections_on(tomorrow, schedule)

    print(format_line(base, today_items))
    print(format_line(tomorrow, tomorrow_items))

    if args.notify:
        if tomorrow_items:
            notify(
                f"明日のごみ ({tomorrow:%m/%d})",
                " / ".join(tomorrow_items),
            )
        elif today_items:
            notify(
                f"今日のごみ ({base:%m/%d})",
                " / ".join(today_items),
            )
        else:
            print("(通知対象なし)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
