import { supabase } from "../lib/supabase.js";
import { APP_TITLE, EVENT_ID, RESULTS_TOP_N, POLL_INTERVAL_MS } from "../config.js";
import { setupNav, navPresenting } from "./nav.js";
import { isUnlocked, tryUnlock } from "./gate.js";

const $ = (s) => document.querySelector(s);

// 画面上部の共通ナビゲーションバー
setupNav("results");

// アプリタイトルをタブ名と見出しに反映（config.js の APP_TITLE を変えるだけでOK）
document.title = `${APP_TITLE} 結果発表`;
$("#app-title").textContent = `🏆 ${APP_TITLE} 結果発表`;

let participants = new Map(); // id -> name
let awards = [];
let activeAwardId = null;
let latest = []; // vote_results rows

async function loadStatic() {
  const [pplRes, awardsRes] = await Promise.all([
    supabase.from("participants").select("id,name"),
    supabase.from("awards").select("*").eq("is_active", true).order("sort_order"),
  ]);
  participants = new Map((pplRes.data || []).map((p) => [p.id, p.name]));
  awards = awardsRes.data || [];
  if (!activeAwardId && awards.length) activeAwardId = awards[0].id;
  renderTabs();
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  awards.forEach((a) => {
    const t = document.createElement("div");
    t.className = "tab" + (a.id === activeAwardId ? " active" : "");
    t.textContent = a.title;
    t.addEventListener("click", () => {
      activeAwardId = a.id;
      renderTabs();
      renderResult();
    });
    tabs.appendChild(t);
  });
}

async function poll() {
  // 発表モード中は自動更新を止める（発表途中で順位が変わると混乱するため）
  if (presentation) return;
  const { data, error } = await supabase
    .from("vote_results")
    .select("award_id,candidate_id,votes,points")
    .eq("event_id", EVENT_ID);
  if (error) {
    console.error(error);
    return;
  }
  latest = data || [];
  renderResult();
}

function renderResult() {
  const root = $("#result");
  const award = awards.find((a) => a.id === activeAwardId);
  if (!award) {
    root.innerHTML = `<p class="muted">表示できるお題がありません。</p>`;
    return;
  }

  const rows = latest
    .filter((r) => r.award_id === award.id)
    .sort((a, b) => b.points - a.points)
    .slice(0, RESULTS_TOP_N);

  const max = rows.length ? rows[0].points : 1;

  let html = `<div class="result-title">${award.title}</div>`;
  if (!rows.length) {
    html += `<p class="muted" style="font-size:1.4rem">まだ投票がありません…</p>`;
  } else {
    html += `<div class="rank-list">`;
    rows.forEach((r, i) => {
      const name = participants.get(r.candidate_id) || "（不明）";
      const pct = Math.round((r.points / (max || 1)) * 100);
      html += `
        <div class="rank r${i + 1}">
          <div class="pos">${i + 1}</div>
          <div class="name">${name}</div>
          <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
          <div class="votes">${r.points}<span style="font-size:1rem"> pt</span></div>
        </div>`;
    });
    html += `</div>`;
  }
  root.innerHTML = html;
}

// お題の自動切替（30秒ごと）
let rotateTimer = null;
$("#autorotate").addEventListener("change", (e) => {
  if (e.target.checked) {
    rotateTimer = setInterval(() => {
      if (!awards.length || presentation) return;
      const idx = awards.findIndex((a) => a.id === activeAwardId);
      activeAwardId = awards[(idx + 1) % awards.length].id;
      renderTabs();
      renderResult();
    }, 30000);
  } else {
    clearInterval(rotateTimer);
  }
});

async function main() {
  await loadStatic();
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
  // 名簿/お題の変更も時々取り込む（発表モード中はお休み）
  setInterval(() => {
    if (!presentation) loadStatic();
  }, 30000);

  // URL に ?mode=presentation が付いていたら、最初から発表モードで開く
  if (new URLSearchParams(location.search).get("mode") === "presentation") {
    startPresentation();
  }
}

// =============================================================
// 発表モード（授賞式風カウントダウン）
// - お題ごとに 3位 → 2位 → 1位 の順で、タップするたびにめくれる
// - 発表中は自動更新を止め、開始時点の集計結果で固定する
// =============================================================

// 発表中はここにデータが入る。null なら通常のLIVE表示
let presentation = null;

// 発表用のデータを作る：お題ごとに上位3位までを「同点グループ」にまとめる
// 同点は同じ順位で同時にめくる（例：1位が2人なら、その次は3位）
function buildPresentationItems() {
  return awards.map((award) => {
    // このお題の得票を、ポイントの多い順に並べる
    const rows = latest
      .filter((r) => r.award_id === award.id && r.points > 0)
      .sort((a, b) => b.points - a.points);

    // 同じポイントの人を1つのグループにまとめる
    const groups = [];
    let rank = 0;
    let prevPoints = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].points !== prevPoints) {
        rank = i + 1; // 順位は「自分より上に何人いるか＋1」
        prevPoints = rows[i].points;
      }
      if (rank > 3) break; // 発表するのは3位まで
      let g = groups.find((x) => x.rank === rank);
      if (!g) {
        g = { rank, entries: [] };
        groups.push(g);
      }
      g.entries.push({
        name: participants.get(rows[i].candidate_id) || "（不明）",
        points: rows[i].points,
      });
    }

    // めくる順番＝下位から（3位 → 2位 → 1位）
    groups.sort((a, b) => b.rank - a.rank);
    return { title: award.title, groups };
  });
}

function startPresentation() {
  if (!awards.length) {
    alert("表示できるお題がまだありません");
    return;
  }
  const items = buildPresentationItems(); // この瞬間の集計で固定（スナップショット）
  // 必要なタップの総数＝各お題の「めくる回数＋次のお題へ進む1回」の合計
  const total = items.reduce((sum, it) => sum + it.groups.length + 1, 0);
  presentation = { items, step: 0, total };
  $("#presentation").style.display = "flex";
  navPresenting(true); // 発表中はナビバーを隠す（☰ボタンで再表示できる）
  renderPresentation(null);
}

function exitPresentation() {
  presentation = null;
  $("#presentation").style.display = "none";
  navPresenting(false); // ナビバーを元に戻す
  poll(); // LIVE表示を最新の状態に戻す
}

// 今のタップ数（step）から「どのお題を・何グループめくった状態か」を計算する
function presentationState() {
  const p = presentation;
  let base = 0;
  for (let i = 0; i < p.items.length; i++) {
    const cost = p.items[i].groups.length + 1;
    if (p.step < base + cost) {
      return { finished: false, index: i, revealed: p.step - base };
    }
    base += cost;
  }
  return { finished: true }; // 全お題の発表が終わった
}

// タップで1つ進める
function presentForward() {
  const p = presentation;
  if (p.step >= p.total) return; // 締め画面より先はない
  const before = presentationState();
  p.step++;
  const after = presentationState();

  // 「いま新しくめくれたグループ」があればアニメーション付きで描画する
  let justIdx = null;
  if (!after.finished && !before.finished &&
      after.index === before.index && after.revealed > before.revealed) {
    justIdx = after.revealed - 1;
  }
  renderPresentation(justIdx);

  // 1位がめくれた瞬間と、全発表が終わった瞬間は紙吹雪！
  if (justIdx !== null && p.items[after.index].groups[justIdx].rank === 1) {
    fireConfetti();
  } else if (after.finished && !before.finished) {
    fireConfetti();
  }
}

// 誤タップ用：1つ戻る（戻るときはアニメーションなし）
function presentBack() {
  const p = presentation;
  if (p.step <= 0) return;
  p.step--;
  renderPresentation(null);
}

// 発表モードの画面を描く
function renderPresentation(justIdx) {
  const p = presentation;
  const stage = $("#p-stage");
  const st = presentationState();

  // 全お題が終わったら締め画面
  if (st.finished) {
    stage.innerHTML = `
      <div class="p-finale">
        <div class="p-finale-emoji">🎉🏆🎉</div>
        <div class="p-finale-title">全発表終了！</div>
        <div class="p-finale-sub">ご参加ありがとうございました</div>
      </div>`;
    $("#p-hint").textContent = "「✕ 終了」でLIVE表示に戻れます";
    return;
  }

  const item = p.items[st.index];
  let html = `<div class="p-award-label">お題 ${st.index + 1} / ${p.items.length}</div>`;
  html += `<div class="p-title">${item.title}</div>`;

  if (!item.groups.length) {
    html += `<p class="p-empty">このお題への投票はありませんでした</p>`;
  } else {
    // 表示は上から 1位 → 2位 → 3位 の順に並べる
    const displayGroups = [...item.groups].sort((a, b) => a.rank - b.rank);
    html += `<div class="p-list">`;
    displayGroups.forEach((g) => {
      // このグループが「めくる順」で何番目か（それが revealed 未満ならめくれている）
      const orderIdx = item.groups.indexOf(g);
      const revealed = orderIdx < st.revealed;
      const justNow = justIdx !== null && orderIdx === justIdx;
      const tie = g.entries.length > 1 ? `<span class="p-tie">同率</span>` : "";
      g.entries.forEach((e) => {
        const cls =
          `p-rank pr${g.rank}` +
          (revealed ? " open" : " closed") +
          (revealed && g.rank === 1 ? " p-first" : "") +
          (justNow ? " flip" : "");
        if (revealed) {
          // 王冠は名前より小さく表示（1行に収めるため。見た目は css の .p-crown）
          const crown = g.rank === 1 ? `<span class="p-crown">👑</span>` : "";
          html += `
            <div class="${cls}">
              <div class="p-pos">${g.rank}位${tie}</div>
              <div class="p-name">${crown}${e.name}</div>
              <div class="p-pts">${e.points}<span> pt</span></div>
            </div>`;
        } else {
          // まだ伏せてある行
          html += `
            <div class="${cls}">
              <div class="p-pos">${g.rank}位${tie}</div>
              <div class="p-name">？？？</div>
              <div class="p-pts">??<span> pt</span></div>
            </div>`;
        }
      });
    });
    html += `</div>`;
  }
  stage.innerHTML = html;

  // 画面下の案内文
  if (st.revealed < item.groups.length) {
    $("#p-hint").textContent = "画面をタップして発表 ▶";
  } else if (st.index + 1 < p.items.length) {
    $("#p-hint").textContent = "タップで次のお題へ ▶";
  } else {
    $("#p-hint").textContent = "タップで発表終了へ ▶";
  }
}

// =============================================================
// PDF保存（印刷）
// 「📄 PDF保存」を押すと、全お題の順位をまとめた印刷用レイアウトを作り、
// ブラウザの印刷画面を開く。そこで「PDFとして保存」を選べばPDFになる。
// 外部サービスを使わないので、スマホでもPCでも無料で動く。
// =============================================================
function buildPrintView() {
  // 印刷用の入れ物（無ければ作る。CSSで普段は非表示、印刷時だけ表示）
  let pv = document.getElementById("print-view");
  if (!pv) {
    pv = document.createElement("div");
    pv.id = "print-view";
    document.body.appendChild(pv);
  }

  const today = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric",
  });
  let html = `<h1 class="pv-title">🏆 ${APP_TITLE} 結果発表</h1>`;
  html += `<p class="pv-date">${today}</p>`;

  // 画面（LIVE表示）と同じ部品（.result-title / .rank-list / .rank）を
  // そのまま使って組み立てる。だからPDFも画面と同じデザインになる
  awards.forEach((award) => {
    const rows = latest
      .filter((r) => r.award_id === award.id && r.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, RESULTS_TOP_N);

    const max = rows.length ? rows[0].points : 1;

    html += `<div class="pv-award">`;
    html += `<div class="result-title">${award.title}</div>`;
    if (!rows.length) {
      html += `<p class="pv-empty">投票はありませんでした</p>`;
    } else {
      html += `<div class="rank-list">`;
      rows.forEach((r, i) => {
        const name = participants.get(r.candidate_id) || "（不明）";
        const pct = Math.round((r.points / (max || 1)) * 100);
        html += `
          <div class="rank r${i + 1}">
            <div class="pos">${i + 1}</div>
            <div class="name">${name}</div>
            <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
            <div class="votes">${r.points}<span> pt</span></div>
          </div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
  });
  pv.innerHTML = html;
}

$("#print-btn").addEventListener("click", async () => {
  await poll(); // 最新の集計にしてから
  buildPrintView();
  window.print(); // 印刷画面を開く（ここで「PDFとして保存」を選ぶ）
});

// ---- 発表モードの操作 ----
$("#present-btn").addEventListener("click", startPresentation);
$("#p-exit").addEventListener("click", exitPresentation);
$("#p-back").addEventListener("click", presentBack);

// 画面のどこをタップしても進む（戻る・終了ボタンの上は除く）
$("#presentation").addEventListener("click", (e) => {
  if (e.target.closest("#p-back") || e.target.closest("#p-exit")) return;
  presentForward();
});

// キーボード操作：← で1つ戻る、→ / スペース / Enter で進む
document.addEventListener("keydown", (e) => {
  if (!presentation) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault(); // 画面が勝手にスクロールしないように
    presentBack();
  }
  if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
    e.preventDefault();
    presentForward();
  }
});

// =============================================================
// 紙吹雪エフェクト（外部ライブラリなしの簡易版）
// =============================================================
let confettiAnim = null;
function fireConfetti() {
  const canvas = $("#confetti");
  const ctx = canvas.getContext("2d");
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

  const started = performance.now();
  cancelAnimationFrame(confettiAnim);
  function tick(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (now - started > 4000) return; // 4秒たったら終了
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
// 認証が済むまで結果は読み込まない
// =============================================================
function unlockAndStart() {
  $("#gate").style.display = "none";
  $("#content").style.display = "block";
  main();
}

if (isUnlocked()) {
  // このブラウザで認証済みなら、すぐ表示
  unlockAndStart();
} else {
  $("#gate").style.display = "block";
  $("#unlock").addEventListener("click", () => {
    if (tryUnlock($("#pass").value)) {
      unlockAndStart();
    } else {
      alert("合言葉が違います");
    }
  });
  $("#pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#unlock").click();
  });
}
