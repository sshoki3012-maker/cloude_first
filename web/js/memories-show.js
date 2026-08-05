// =============================================================
// 思い出ランキング発表画面（memories.html 用）
// - 発表する項目は Supabase の memory_settings.selected_ids から読む
//   （どれをどの順で発表するかは admin.html で設定する）
// - 発表は2段階方式：
//     1段階目 … 題目のタイトルだけを画面いっぱいに表示
//     2段階目 … タップすると 1位〜3位（pair は男女）を一度に全部表示
//   もう一度タップすると次の題目のタイトルへ進む
// - best3 の答えが開いた瞬間は紙吹雪（1位が見える瞬間なので）
// - 「← 戻る」で1つ戻れる。開くには管理画面と同じ合言葉が必要
// =============================================================
import { supabase } from "../lib/supabase.js";
import { APP_TITLE, EVENT_ID } from "../config.js";
import { MEMORIES } from "../memories.js";
import { setupNav, navPresenting } from "./nav.js";
import { isUnlocked, tryUnlock } from "./gate.js";

const $ = (s) => document.querySelector(s);

// アプリタイトルをタブ名に反映（config.js の APP_TITLE を変えるだけでOK）
document.title = `${APP_TITLE} 思い出発表`;

// ナビバーを差し込む（合言葉の画面ではナビは見えたまま）
setupNav("memories");

// 発表する項目のリスト（管理画面で選んだ順）
let items = [];

// 合言葉を通って発表が始まったら true
let started = false;

// 今どこまでタップしたか。
// step 0 = 導入画面。以降は1項目につき2ステップ（タイトル → 全部表示）
let step = 0;
let totalSteps = 0;

// 管理画面で保存した selected_ids を読み込んで、発表リストを作る
async function loadItems() {
  const { data, error } = await supabase
    .from("memory_settings")
    .select("selected_ids")
    .eq("event_id", EVENT_ID)
    .maybeSingle();
  if (error) console.error(error);

  const ids = data?.selected_ids || [];
  // id から実データを引く（memories.js に無い id は無視する）
  items = ids.map((id) => MEMORIES.find((m) => m.id === id)).filter(Boolean);

  // タップの総数 = 導入画面の1回 + 各項目2回（タイトル→全部表示）
  totalSteps = 1 + items.length * 2;
}

// 今の step から「導入 / 何番目の項目のどの段階か / 終了」を計算する
function currentState() {
  if (step === 0) return { intro: true };
  const s = step - 1;
  const index = Math.floor(s / 2); // 2ステップごとに次の項目へ
  if (index >= items.length) return { finished: true };
  return { index, revealed: s % 2 === 1 }; // 偶数=タイトルだけ、奇数=全部表示
}

// タップで1つ進める
function forward() {
  if (!started || !items.length) return;
  if (step >= totalSteps) return; // 終了画面より先はない
  const before = currentState();
  step++;
  const after = currentState();

  // 「タイトルだけ → 全部表示」に切り替わった瞬間か？
  const justRevealed =
    !before.intro && !before.finished && !before.revealed &&
    !after.intro && !after.finished && after.revealed;

  render(justRevealed);

  // best3 の答えが開いた瞬間（＝1位が見える瞬間）と、全発表の終了で紙吹雪！
  if (justRevealed && items[after.index].type === "best3") {
    fireConfetti();
  } else if (after.finished && !before.finished) {
    fireConfetti();
  }
}

// 誤タップ用：1つ戻る（戻るときはアニメーションなし）
function back() {
  if (!started || step <= 0) return;
  step--;
  render(false);
}

// 画面を描く
function render(justRevealed) {
  const stage = $("#p-stage");

  // 発表する項目が選ばれていないとき
  if (!items.length) {
    stage.innerHTML = `
      <div class="p-finale">
        <div class="p-finale-emoji">📖</div>
        <div class="p-finale-title" style="font-size:2.4rem">発表する項目がありません</div>
        <div class="p-finale-sub">管理画面の「思い出ランキング発表の設定」で<br>項目を選んで保存してください</div>
      </div>`;
    $("#p-hint").textContent = "";
    return;
  }

  const st = currentState();

  // ---- 導入画面 ----
  if (st.intro) {
    stage.innerHTML = `
      <div class="p-finale p-intro">
        <div class="p-finale-emoji">📖✨</div>
        <div class="p-finale-title">思い出ランキング</div>
        <div class="p-finale-sub">昔はこんな順位だったよね</div>
      </div>`;
    $("#p-hint").textContent = "画面をタップして発表スタート ▶";
    return;
  }

  // ---- 終了画面 ----
  if (st.finished) {
    stage.innerHTML = `
      <div class="p-finale">
        <div class="p-finale-emoji">🎉📖🎉</div>
        <div class="p-finale-title">全項目終わりました！</div>
        <div class="p-finale-sub">思い出に浸っていただけましたか？</div>
      </div>`;
    $("#p-hint").textContent = "発表はこれで終了です";
    return;
  }

  const item = items[st.index];

  // ---- 1段階目：タイトルだけを画面いっぱいに ----
  if (!st.revealed) {
    stage.innerHTML = `
      <div class="p-solo">
        <div class="p-solo-cat">${item.category} — ${st.index + 1} / ${items.length}</div>
        <div class="p-solo-title">${item.title}</div>
      </div>`;
    $("#p-hint").textContent = "画面をタップして結果発表 ▶";
    return;
  }

  // ---- 2段階目：1位〜3位（pair は男女）を一度に全部表示 ----
  let html = `<div class="p-award-label">${item.category} — ${st.index + 1} / ${items.length}</div>`;
  html += `<div class="p-title">${item.title}</div>`;
  html += `<div class="p-list">`;

  // 開いた瞬間は、行を上から順に少しずつ遅らせてめくる（見栄え用）
  const delay = (i) => (justRevealed ? ` style="animation-delay:${i * 0.18}s"` : "");
  const flip = justRevealed ? " flip" : "";

  if (item.type === "best3") {
    for (let rank = 1; rank <= 3; rank++) {
      const cls = `p-rank pr${rank} open` + (rank === 1 ? " p-first" : "") + flip;
      const crown = rank === 1 ? "👑 " : "";
      html += `
        <div class="${cls}"${delay(rank - 1)}>
          <div class="p-pos">${rank}位</div>
          <div class="p-name">${crown}${item.ranks[rank - 1]}</div>
        </div>`;
    }
  } else {
    // pair：男 → 女 の順に並べて一度に表示
    const rows = [
      { label: "男", cls: "pr-m", name: item.male },
      { label: "女", cls: "pr-f", name: item.female },
    ];
    rows.forEach((r, i) => {
      html += `
        <div class="p-rank ${r.cls} open${flip}"${delay(i)}>
          <div class="p-pos">${r.label}</div>
          <div class="p-name">${r.name}</div>
        </div>`;
    });
  }
  html += `</div>`;
  stage.innerHTML = html;

  // 画面下の案内文
  if (st.index + 1 < items.length) {
    $("#p-hint").textContent = "タップで次の題目へ ▶";
  } else {
    $("#p-hint").textContent = "タップで発表終了へ ▶";
  }
}

// ---- 操作 ----
$("#p-back").addEventListener("click", back);

// 画面のどこをタップしても進む（戻るボタンの上は除く）
$("#presentation").addEventListener("click", (e) => {
  if (e.target.closest("#p-back")) return;
  forward();
});

// キーボード操作：← で1つ戻る、→ / スペース / Enter で進む
document.addEventListener("keydown", (e) => {
  if (!started) return; // 合言葉の画面では何もしない（Enterは入力欄で使う）
  if (e.key === "ArrowLeft") {
    e.preventDefault(); // 画面が勝手にスクロールしないように
    back();
  }
  if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
    e.preventDefault();
    forward();
  }
});

// =============================================================
// 紙吹雪エフェクト（results.js と同じ簡易版）
// =============================================================
let confettiAnim = null;
function fireConfetti() {
  const canvas = $("#confetti");
  const ctx = canvas.getContext("2d");
  // 画面を回転させてもサイズが合うように、撃つたびに測り直す
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ["#f26a1b", "#d98a1f", "#ffd700", "#2e8b6e", "#e5484d", "#4a7fd4"];
  const pieces = [];
  for (let i = 0; i < 150; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.6, // 画面の上の外からバラバラに降る
      w: 8 + Math.random() * 8,
      h: 6 + Math.random() * 6,
      color: colors[i % colors.length],
      speed: 2.5 + Math.random() * 3,
      sway: Math.random() * Math.PI * 2, // 左右のゆらゆらの位相
      rot: Math.random() * Math.PI * 2,
    });
  }

  const startedAt = performance.now();
  cancelAnimationFrame(confettiAnim);
  function tick(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (now - startedAt > 4000) return; // 4秒たったら終了
    for (const pc of pieces) {
      pc.y += pc.speed;
      pc.x += Math.sin(now / 400 + pc.sway) * 1.5;
      pc.rot += 0.06;
      if (pc.y > canvas.height + 20) pc.y = -20; // 下まで落ちたら上に戻す
      ctx.save();
      ctx.translate(pc.x, pc.y);
      ctx.rotate(pc.rot);
      ctx.fillStyle = pc.color;
      ctx.fillRect(-pc.w / 2, -pc.h / 2, pc.w, pc.h);
      ctx.restore();
    }
    confettiAnim = requestAnimationFrame(tick);
  }
  confettiAnim = requestAnimationFrame(tick);
}

// =============================================================
// 合言葉ゲート（js/gate.js 共通。管理画面と同じ合言葉）
// =============================================================
async function start() {
  started = true;
  $("#gate-wrap").style.display = "none";
  $("#presentation").style.display = "flex";
  navPresenting(true); // 発表中はナビバーを隠す（☰ボタンで再表示できる）
  await loadItems();
  render(false);
}

if (isUnlocked()) {
  // このブラウザで認証済みなら、すぐ発表画面へ
  start();
} else {
  $("#gate-wrap").style.display = "block";
  $("#unlock").addEventListener("click", () => {
    if (tryUnlock($("#pass").value)) {
      start();
    } else {
      alert("合言葉が違います");
    }
  });
  $("#pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#unlock").click();
  });
}
