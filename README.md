# 西宮市 学文殿町 ごみ収集通知ツール

`gomi_notifier.py` は西宮市学文殿町のごみ収集予定を表示／通知する小さなCLIツールです。

## 使い方

```bash
python3 gomi_notifier.py              # 今日と明日の予定を表示
python3 gomi_notifier.py --week       # 今日から7日分を表示
python3 gomi_notifier.py --date 2026-05-20
python3 gomi_notifier.py --notify     # notify-send / osascript でデスクトップ通知
```

初回実行時に `schedule.json` が自動生成されます。
収集曜日は地域や年度で変わるため、必ず西宮市公式の
[ごみカレンダー](https://www.nishi.or.jp/homepage/gomicalendar/index.html) で
学文殿町の最新の曜日を確認し、`schedule.json` を編集してください。

## schedule.json の構造

| キー | 説明 |
| --- | --- |
| `rules[].name` | 表示名（例: 燃やすごみ） |
| `rules[].type` | `weekly` または `biweekly` |
| `rules[].days` | 曜日キー (`mon`〜`sun`) |
| `rules[].reference_date` | `biweekly` の基準日 (この日が収集日になる) |
| `holidays` | 収集休止日 (例: 年末年始) を `YYYY-MM-DD` で列挙 |

## cron 例

毎朝7時に翌日の収集を通知する場合:

```cron
0 7 * * * cd /path/to/cloude_first && /usr/bin/python3 gomi_notifier.py --notify
```
