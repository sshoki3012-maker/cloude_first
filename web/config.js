// =============================================================
// アプリ設定 — ここだけ書き換えれば動きます
// =============================================================

// Supabase ダッシュボード > Project Settings > API から取得
export const SUPABASE_URL      = "https://tpnuxzhmjyqzyilhyqcj.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_TMANElHzpqayEt-dNgOFPQ_tGzSB8si";

// イベント（年度）。supabase/seed.sql の event_id と必ず一致させる
export const EVENT_ID = "2026";

// 1つのお題で選べる最大人数
export const MAX_PICKS = 3;

// 結果スクリーンに表示する上位人数
export const RESULTS_TOP_N = 5;

// 結果スクリーンの自動更新間隔（ミリ秒）
export const POLL_INTERVAL_MS = 3000;

// 管理画面の簡易合言葉（余興用の軽い保護）
export const ADMIN_PASSCODE = "nanpi32";

// QR に埋め込む投票URL。空なら現在のドメイン + /index.html を使用
export const VOTE_URL = "";
