// =============================================================
// 合言葉ゲート（admin / results / memories で共通）
// - config.js の ADMIN_PASSCODE と照合する
// - 一度合っていたらブラウザ（localStorage）に記憶して、
//   次からは同じブラウザなら入力を省略できるようにする
// - 合言葉を変えると記憶は自動で無効になる（保存値と一致しなくなるため）
// =============================================================
import { ADMIN_PASSCODE } from "../config.js";

// localStorage に保存するときのキー名
const KEY = "admin_gate_pass";

// すでにこのブラウザで認証済みか？
export function isUnlocked() {
  try {
    return localStorage.getItem(KEY) === ADMIN_PASSCODE;
  } catch {
    return false; // プライベートモード等で localStorage が使えない場合
  }
}

// 入力された合言葉を確認。合っていれば記憶して true を返す
export function tryUnlock(value) {
  if (value !== ADMIN_PASSCODE) return false;
  try {
    localStorage.setItem(KEY, ADMIN_PASSCODE);
  } catch {
    // 記憶できなくても、今回の解除はそのまま通す
  }
  return true;
}
