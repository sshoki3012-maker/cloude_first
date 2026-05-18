# 同窓会 出席管理ツール

リアルタイム同期で複数人が同時に編集できる、シンプルな同窓会出席管理ツール。
**Turso (libSQL)** + **Express + SSE** + **共有パスワード認証** で構築。

## 機能

- **名前 / 担当者 / 集客状況 / メモ** を一人ずつカードで管理
- **5段階の集客状況** — 未連絡 / 連絡済 / 検討中 / 出席 / 欠席
- **共有パスワードでログイン** — 知っている人だけがアクセス可能（HttpOnly Cookie で30日間記憶）
- **複数人同時編集** — Server-Sent Events で誰かが更新するとすぐ全員の画面に反映
- **フィルタ** — 名前・担当者・状況で絞り込み
- **集計** — 各状況の人数を画面上部に常時表示
- **モバイル対応**

## アーキテクチャ

```
ブラウザ ──(HTTPS + Cookie)──> Node.js (Express) ──(libsql)──> Turso (SQLite)
   ↑                                  │
   └──────── SSE ─────────────────────┘   (更新があれば全クライアントに即時 push)
```

- Turso の認証トークンはサーバー側にしか置かないので、クライアントから漏れる心配なし
- ログインしたクライアントだけが API・SSE にアクセス可能

## セットアップ

### 1. Turso データベースを作成（無料）

```bash
# Turso CLI をインストール
curl -sSfL https://get.tur.so/install.sh | bash

# サインアップ → ログイン
turso auth signup
turso auth login

# DB 作成 (リージョンは東京 nrt 推奨)
turso db create dousoukai --location nrt

# 接続 URL を取得
turso db show dousoukai --url
# => libsql://dousoukai-xxxx.turso.io

# 認証トークンを発行 (長期有効)
turso db tokens create dousoukai
# => eyJhbGciOi...
```

### 2. ローカルで動かす

```bash
# Node.js 20 以上が必要
node -v

# 依存をインストール
npm install

# .env を作成して値を入れる
cp .env.example .env
# エディタで .env を編集:
#   TURSO_DATABASE_URL=libsql://dousoukai-xxxx.turso.io
#   TURSO_AUTH_TOKEN=eyJhbGciOi...
#   APP_PASSWORD=好きな共有パスワード
#   SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# 起動
npm start
```

ブラウザで `http://localhost:3000` を開く → パスワード入力でログイン。

### 3. 本番環境にデプロイ（みんなで使う）

#### Render の場合（最も簡単）

1. このリポジトリを GitHub に push
2. https://render.com/ で「New Web Service」→ リポジトリを選択
3. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Environment Variables に `.env` の4つの値を登録
5. Deploy → 数分で `https://xxx.onrender.com` のような URL が発行される

> Render の無料枠は15分アクセスがないとスリープします。最初のアクセスだけ数秒待ちます。

#### Fly.io / Railway も同様

Node.js 環境変数 4つを設定して `npm start` を起動コマンドにするだけです。

## パスワード認証の仕組み

- ログインフォームで `APP_PASSWORD` と一致したら、HMAC-SHA256 署名付きトークンを HttpOnly Cookie に発行
- 以降の API リクエストはこの Cookie を検証
- 30日間有効、ログアウトで即座に無効化
- Cookie は HttpOnly + SameSite=Strict + HTTPS 環境では Secure 付きなので、XSS や CSRF にも一定の耐性あり

### パスワードを変えたい

`.env` の `APP_PASSWORD` を変更してサーバーを再起動。発行済み Cookie は SESSION_SECRET を変えれば全員無効になります。

## 使い方

- **追加**: 「+ 新規追加」→ 名前・担当者・状況を入力 → 保存
- **編集**: カードをクリック → モーダルで変更 → 保存
- **削除**: 編集モーダル内の「削除」ボタン
- **絞り込み**: 上部の検索ボックス／状況／担当者プルダウン
- **ログアウト**: ヘッダ右上の「ログアウト」

## ファイル構成

```
server.js              -- Express + Turso + SSE + 認証
package.json
.env.example           -- 環境変数テンプレ（.env は git 管理外）
public/
  index.html
  style.css
  app.js               -- API 呼び出し + SSE 購読 + UI
```

## ライセンス

自由に改変してお使いください。
