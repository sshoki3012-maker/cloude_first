# 同窓会 出席管理ツール

リアルタイム同期で複数人が同時に編集できる、シンプルな同窓会出席管理ツールです。

## 機能

- **名前 / 担当者 / 集客状況 / メモ** を一人ずつカードで管理
- **5段階の集客状況** — 未連絡 / 連絡済 / 検討中 / 出席 / 欠席
- **複数人同時編集** — Firestore のリアルタイム同期で、誰かが追加・更新するとすぐに全員の画面に反映
- **フィルタ** — 名前・担当者・状況で絞り込み
- **集計** — 各状況の人数を画面上部に常時表示
- **モバイル対応** — スマホでも使いやすいレイアウト

## セットアップ手順

### 1. Firebase プロジェクトを作る（無料）

1. https://console.firebase.google.com/ にアクセス
2. 「プロジェクトを追加」→ 任意の名前（例: `dousoukai`）で作成（Google Analytics は不要）
3. プロジェクト画面で「ウェブアプリ」(`</>` アイコン）を追加
4. アプリ名を入力 → 「アプリを登録」
5. 表示される `firebaseConfig` の中身をコピー

### 2. Firestore を有効化

1. 左メニュー「Firestore Database」→「データベースの作成」
2. 「**本番環境モード**」を選択（後でルールを設定）→ ロケーションは `asia-northeast1` (東京) 推奨
3. 作成完了後、「ルール」タブで以下に書き換えて「公開」:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /members/{doc} {
         allow read, write: if true;
       }
     }
   }
   ```

   > ⚠️ これは「URL を知っている人なら誰でも読み書きできる」設定です。身内限定の運用なら問題ありませんが、本格的に守りたい場合は Firebase Authentication を追加してください。

### 3. 設定ファイルを置く

`firebase-config.example.js` を `firebase-config.js` にコピーし、手順 1 でコピーした値で書き換えます。

```bash
cp firebase-config.example.js firebase-config.js
# その後、エディタで firebase-config.js を開いて値を入れる
```

### 4. 起動する

#### 方法A: ローカルで試す

```bash
# Python があれば
python3 -m http.server 8080

# あるいは Node.js があれば
npx serve .
```

ブラウザで `http://localhost:8080` を開く。

#### 方法B: 無料ホスティングで公開する（みんなで使う）

GitHub Pages / Netlify / Vercel / Firebase Hosting などに `index.html`, `style.css`, `app.js`, `firebase-config.js` を一緒にアップロードするだけで、URL を共有して複数人で同時編集できます。

Firebase Hosting の例:
```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # public ディレクトリは "." を指定
firebase deploy
```

## 使い方

- **追加**: 右上「+ 新規追加」ボタン → 名前・担当者・状況を入力 → 保存
- **編集**: 一覧のカードをクリック → モーダルで変更 → 保存
- **削除**: 編集モーダル内の「削除」ボタン
- **絞り込み**: 上部の検索ボックス／状況／担当者プルダウン

更新は自動的に他の人の画面にも数秒以内で反映されます。

## ファイル構成

```
index.html              -- 画面
style.css               -- スタイル
app.js                  -- Firestore 連携 + 表示ロジック
firebase-config.js      -- ★ 自分で作る（example をコピー）
firebase-config.example.js
```

## ライセンス

自由に改変してお使いください。
