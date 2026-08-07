// =============================================================
// 思い出ランキング発表画面（memories.html 用）
// - 発表する項目・発表方法は Supabase の memory_settings から読む
//   （admin.html の「思い出ランキング発表の設定」で決める）
// - 発表方法は問題ごとに2種類（管理画面のA/Bトグルで切り替え）：
//     A. 一括表示   … タップで題目と全順位（1位含む）を一度に表示
//     B. 1位を伏せる … タップで題目＋2位3位を表示、1位は「？」で伏せる
//                      → もう一度タップで1位を発表（pair は男女とも伏せる）
// - best3 の1位が見えた瞬間は紙吹雪
// - 画面のどこをタップしても進む。「← 戻る」で1つ戻れる
// - 発表中に管理画面でA/Bを変えても、数秒で自動反映される
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

// 問題ごとの発表方法（{ q1: "B", ... }。書いていない問題は A）
let revealModes = {};

// 合言葉を通って発表が始まったら true
let started = false;

// 今どの画面にいるか（タップで進む位置）
//   { type: "intro" }                     … 導入画面
//   { type: "item", index: n, phase: p }  … n番目の項目
//     phase 0 = タイトルだけ大きく表示
//     phase 1 = 順位を表示（A=全部 / B=2位3位のみ、1位は「？」）
//     phase 2 = 1位を発表（B のみ）
//   { type: "end" }                       … 終了画面
let pos = { type: "intro" };

// この項目の発表方法を返す（設定が無ければ A）
function modeOf(item) {
  return revealModes[item.id] === "B" ? "B" : "A";
}

// 管理画面で保存した設定を読み込んで、発表リストを作る
async function loadItems() {
  const { data, error } = await supabase
    .from("memory_settings")
    .select("selected_ids, reveal_modes")
    .eq("event_id", EVENT_ID)
    .maybeSingle();
  if (error) console.error(error);

  const ids = data?.selected_ids || [];
  // id から実データを引く（memories.js に無い id は無視する）
  items = ids.map((id) => MEMORIES.find((m) => m.id === id)).filter(Boolean);
  revealModes = data?.reveal_modes || {};
}

// タップで1つ進める
function forward() {
  if (!started || !items.length) return;
  if (pos.type === "end") return; // 終了画面より先はない

  // 導入 → 最初の項目のタイトル画面へ
  if (pos.type === "intro") {
    pos = { type: "item", index: 0, phase: 0 };
    render(null);
    return;
  }

  const item = items[pos.index];

  // タイトル画面 → 順位の表示（A=全部 / B=1位は伏せたまま）
  if (pos.phase === 0) {
    pos = { type: "item", index: pos.index, phase: 1 };
    render("show");
    // A（一括表示）はこの瞬間に1位も見えるので、best3 なら紙吹雪
    if (modeOf(item) === "A" && item.type === "best3") fireConfetti();
    return;
  }

  // B（1位を伏せる）の順位画面 → 1位を発表
  if (pos.phase === 1 && modeOf(item) === "B") {
    pos = { type: "item", index: pos.index, phase: 2 };
    render("reveal");
    if (item.type === "best3") fireConfetti(); // 1位が見えた瞬間！
    return;
  }

  // 次の項目へ（最後なら終了画面へ）
  if (pos.index + 1 < items.length) {
    pos = { type: "item", index: pos.index + 1, phase: 0 };
    render(null);
  } else {
    pos = { type: "end" };
    render(null);
    fireConfetti();
  }
}

// その項目の「最後の画面」の位置（戻るときに使う。Bは phase 2 まである）
function lastPhaseOf(i) {
  return { type: "item", index: i, phase: modeOf(items[i]) === "B" ? 2 : 1 };
}

// 誤タップ用：1つ戻る（戻るときはアニメーションなし）
function back() {
  if (!started || pos.type === "intro") return;
  if (pos.type === "end") {
    pos = items.length ? lastPhaseOf(items.length - 1) : { type: "intro" };
  } else if (pos.phase > 0) {
    // 同じ項目の1つ前の画面へ（1位発表 → 伏せた状態 → タイトルだけ）
    pos = { type: "item", index: pos.index, phase: pos.phase - 1 };
  } else if (pos.index > 0) {
    pos = lastPhaseOf(pos.index - 1);
  } else {
    pos = { type: "intro" };
  }
  render(null);
}

// 画面を描く。anim は "show"=全体をめくる / "reveal"=伏せていた所だけめくる / null=なし
function render(anim) {
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

  // ---- 導入画面 ----
  if (pos.type === "intro") {
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
  if (pos.type === "end") {
    stage.innerHTML = `
      <div class="p-finale">
        <div class="p-finale-emoji">🎉📖🎉</div>
        <div class="p-finale-title">全項目終わりました！</div>
        <div class="p-finale-sub">思い出に浸っていただけましたか？</div>
      </div>`;
    $("#p-hint").textContent = "発表はこれで終了です";
    return;
  }

  // ---- 項目の画面 ----
  const item = items[pos.index];

  // phase 0：タイトルだけを画面いっぱいに大きく表示
  if (pos.phase === 0) {
    stage.innerHTML = `
      <div class="p-solo">
        <div class="p-solo-cat">${item.category} — ${pos.index + 1} / ${items.length}</div>
        <div class="p-solo-title">${item.title}</div>
      </div>`;
    $("#p-hint").textContent = "画面をタップして結果発表 ▶";
    return;
  }

  // 1位（pair は男女とも）を伏せているか？（B の phase 1 のとき）
  const masked = modeOf(item) === "B" && pos.phase === 1;

  let html = `<div class="p-award-label">${item.category} — ${pos.index + 1} / ${items.length}</div>`;
  html += `<div class="p-title">${item.title}</div>`;
  html += `<div class="p-list">`;

  // めくるアニメーションの付け方：
  //   "show"   … 全行を上から順に少しずつ遅らせてめくる
  //   "reveal" … 伏せていた行（1位／男女）だけめくる
  const flipAll = anim === "show" ? " flip" : "";
  const flipRevealed = anim === "reveal" ? " flip" : "";
  const delay = (i) => (anim === "show" ? ` style="animation-delay:${i * 0.18}s"` : "");

  if (item.type === "best3") {
    for (let rank = 1; rank <= 3; rank++) {
      const isTop = rank === 1;
      if (isTop && masked) {
        // 1位はまだヒミツ。大きめの文字＋目立つ枠で「？」
        html += `
          <div class="p-rank pr1 p-mystery${flipAll}"${delay(0)}>
            <div class="p-pos">1位</div>
            <div class="p-name">？？？</div>
          </div>`;
      } else {
        const cls = `p-rank pr${rank} open` +
          (isTop ? " p-first" : "") +
          (isTop ? flipRevealed : "") + flipAll;
        html += `
          <div class="${cls}"${delay(rank - 1)}>
            <div class="p-pos">${rank}位</div>
            <div class="p-name">${isTop ? `<span class="p-crown">👑</span>` : ""}${item.ranks[rank - 1]}</div>
          </div>`;
      }
    }
  } else {
    // pair：男 → 女。Bのときは両方「？」で伏せて、タップで両方発表
    const rows = [
      { label: "男", cls: "pr-m", name: item.male },
      { label: "女", cls: "pr-f", name: item.female },
    ];
    rows.forEach((r, i) => {
      if (masked) {
        html += `
          <div class="p-rank ${r.cls} p-mystery${flipAll}"${delay(i)}>
            <div class="p-pos">${r.label}</div>
            <div class="p-name">？？？</div>
          </div>`;
      } else {
        html += `
          <div class="p-rank ${r.cls} open${flipAll}${flipRevealed}"${delay(i)}>
            <div class="p-pos">${r.label}</div>
            <div class="p-name">${r.name}</div>
          </div>`;
      }
    });
  }
  html += `</div>`;
  stage.innerHTML = html;

  // 画面下の案内文
  if (masked) {
    $("#p-hint").textContent =
      item.type === "best3" ? "タップで1位を発表 ▶" : "タップで男女を発表 ▶";
  } else if (pos.index + 1 < items.length) {
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
// 発表中でも、管理画面でのA/B変更を数秒ごとに取り込む
// ※ 発表順（selected_ids）は途中で変わると進行位置がズレるので、
//    開いたときのまま固定。A/B（reveal_modes）だけ反映する
// =============================================================
setInterval(async () => {
  if (!started || !items.length) return;
  const { data } = await supabase
    .from("memory_settings")
    .select("reveal_modes")
    .eq("event_id", EVENT_ID)
    .maybeSingle();
  const next = data?.reveal_modes || {};
  if (JSON.stringify(next) !== JSON.stringify(revealModes)) {
    revealModes = next;
    render(null); // 表示中の画面にもすぐ反映（アニメーションなしで描き直し）
  }
}, 5000);

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
  render(null);
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
