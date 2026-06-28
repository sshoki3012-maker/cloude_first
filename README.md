# 🔮 同窓会「未来予想」投票アプリ

スマホ（QR）から投票し、結果をその場でスクリーンにランキング表示する余興用Webアプリ。
集めた予想は `event_id`（年度）付きで永続化し、次回の同窓会で「予想 vs 現実」を答え合わせできます。

- フロント：**ビルド不要の静的サイト**（Netlify にそのまま置ける）
- バックエンド：**Supabase**（サーバ常駐なし・無料枠で40人規模OK）
- 結果更新：**3秒ポーリング**
- 識別：**名前選択 + localStorage**（認証なし）

---

## 画面構成

| URL | 用途 |
|-----|------|
| `/index.html`   | ログイン（合言葉 → 名簿から自分の名前を選ぶ） |
| `/vote.html`    | 投票（お題ごとに最大3人選択・修正可／全体進捗・投票済み/未投票表示・名前検索） |
| `/results.html` | 結果スクリーン（プロジェクタ用・自動更新・ポイント順） |
| `/admin.html`   | 管理（受付ON/OFF・投票状況の集計・名簿/お題編集・リセット・エクスポート） |
| `/qr.html`      | 投票URLのQRコード表示 |

---

## セットアップ手順

### 1. Supabase プロジェクトを作る
1. <https://supabase.com> でプロジェクト作成（無料枠でOK）
2. ダッシュボードの **SQL Editor** で次を順番に実行
   - `supabase/schema.sql`（テーブル・ビュー・RLS）
   - `supabase/seed.sql`（サンプル名簿・お題・イベント）
3. **Project Settings → API** から `Project URL` と `anon public` キーを控える

### 2. フロントの設定
`web/config.js` を編集：
```js
export const SUPABASE_URL      = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGci...";   // anon public key
export const EVENT_ID          = "2026";          // seed.sql と一致させる
export const VOTER_PASSCODE    = "入場の合言葉";   // 投票画面の入口で要求
export const ADMIN_PASSCODE    = "好きな合言葉";   // 管理画面の保護
```

> 投票画面（`index.html`）は最初に `VOTER_PASSCODE` の入力を求めます。管理用
> （`ADMIN_PASSCODE`）とは別の合言葉です。一度入れた端末では `localStorage` に
> 記録され再入力は不要。なお合言葉は `config.js`（公開ファイル）に平文で入るため、
> ソースを見れば分かる「余興レベルの軽い入場制限」である点に注意してください。

### 3. ローカル確認
ES Modules を使うので、ファイル直開きではなく簡易サーバ経由で：
```bash
cd web
python3 -m http.server 8000
# → http://localhost:8000/index.html
```

### 4. Netlify にデプロイ
- リポジトリを連携すると `netlify.toml` により `web/` が公開されます
- もしくは `web/` フォルダをドラッグ&ドロップ
- 公開URLができたら `qr.html` をスクリーンに映して配布

---

## 当日の流れ
1. `qr.html` をプロジェクタに映す → 各自スマホで読み取り
2. 名前を選んでログイン → お題ごとに最大3人を選んで保存（後から修正可）
3. 締め切りたくなったら `admin.html` で「受付を締め切る」
4. `results.html` をプロジェクタに映してランキング発表（3秒ごと自動更新）
5. `admin.html` の **JSON/CSVエクスポート** で結果を保存 → 次回の答え合わせ用に保管

---

## データモデル
- `participants` … 名簿（投票者でも候補でもある）
- `awards` … お題/賞（`is_active` で表示切替）
- `votes` … 投票（`event_id, voter_id, award_id, candidate_id, point`、1お題=最大3件）
  - `point` … 選んだ順の配点（**1番目=3pt・2番目=2pt・3番目=1pt**）
- `settings` … 年度ごとの受付状態（`voting_open`）
- `vote_results`（ビュー）… お題×候補ごとの `votes`（得票数）と `points`（合計ポイント）。
  結果画面は **`points` で傾斜配点ランキング**を表示

## お題・名簿の差し替え
- `admin.html` から追加・編集・削除できます
- まとめて入れ替えたい場合は `supabase/seed.sql` を書き換えて再実行

## 次回の答え合わせについて（今回のスコープ）
今回は **データ永続化 + 年度タグ + エクスポート** まで実装。
比較UI（予想 vs 現実）は、次回イベント時に `event_id` を新しく作って
過去データと突き合わせる形で追加予定です。エクスポートしたJSON/CSVも保管しておけば確実です。

---

## セキュリティについて（割り切り）
余興用途のため認証はかけていません。RLS で参照は全員可、投票は受付中のみ可。
名簿/お題編集・受付切替などの管理操作も匿名キーに開いており、`admin.html` は
`ADMIN_PASSCODE`（クライアント側の簡易合言葉）で軽く保護しています。
より厳密にしたい場合は Supabase Auth + `service_role` 運用に置き換えてください。
