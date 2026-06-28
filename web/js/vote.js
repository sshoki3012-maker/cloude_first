import { supabase } from "../lib/supabase.js";
import { EVENT_ID, MAX_PICKS } from "../config.js";

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = `mirai_voter_${EVENT_ID}`;

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.borderColor = isError ? "var(--accent)" : "var(--accent2)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

const voter = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
if (!voter) location.href = "./index.html";

let participants = [];
let awards = [];
let votingOpen = true;
// award_id -> [candidate_id, ...]  選んだ順の配列（先頭ほど高得点）
const selections = new Map();
// award_id -> カード要素（再描画用）
const cardByAward = new Map();

// 選んだ順位（0始まり）から配点を返す。1番目=MAX_PICKS点 … 最後=1点
const pointForRank = (rank) => MAX_PICKS - rank;

async function load() {
  $("#whoami").textContent = `${voter.name} さん`;

  const [settingsRes, pplRes, awardsRes, votesRes] = await Promise.all([
    supabase.from("settings").select("voting_open").eq("event_id", EVENT_ID).maybeSingle(),
    supabase.from("participants").select("id,name,sort_order").order("sort_order"),
    supabase.from("awards").select("*").eq("is_active", true).order("sort_order"),
    supabase
      .from("votes")
      .select("award_id,candidate_id,point")
      .eq("event_id", EVENT_ID)
      .eq("voter_id", voter.id),
  ]);

  if (pplRes.error || awardsRes.error) {
    toast("読み込みに失敗しました", true);
    console.error(pplRes.error || awardsRes.error);
    return;
  }

  votingOpen = settingsRes.data?.voting_open ?? true;
  participants = pplRes.data || [];
  awards = awardsRes.data || [];

  // 既存投票を point の大きい順（=選んだ順）に並べて復元
  const byAward = new Map();
  for (const v of votesRes.data || []) {
    if (!byAward.has(v.award_id)) byAward.set(v.award_id, []);
    byAward.get(v.award_id).push(v);
  }
  for (const [awardId, rows] of byAward) {
    rows.sort((a, b) => b.point - a.point);
    selections.set(awardId, rows.map((r) => r.candidate_id));
  }

  if (!votingOpen) {
    $("#status-line").innerHTML =
      `<span class="badge closed">投票は締め切りました</span> 結果発表をお待ちください。`;
  }
  render();
}

function render() {
  const root = $("#awards");
  root.innerHTML = "";
  cardByAward.clear();

  awards.forEach((award) => {
    if (!selections.has(award.id)) selections.set(award.id, []);

    const card = document.createElement("div");
    card.className = "card";
    cardByAward.set(award.id, card);

    const head = document.createElement("div");
    head.className = "row";
    head.innerHTML = `
      <h2>${award.title}</h2>
      <div class="spacer"></div>
      <span class="badge" data-badge="${award.id}"></span>`;
    card.appendChild(head);

    if (award.description) {
      const d = document.createElement("p");
      d.className = "muted";
      d.style.margin = "6px 0 0";
      d.textContent = award.description;
      card.appendChild(d);
    }

    const cnt = document.createElement("p");
    cnt.className = "count";
    cnt.dataset.count = award.id;
    card.appendChild(cnt);

    // 名前で絞り込む検索ボックス（このお題の名簿だけを対象）
    const search = document.createElement("input");
    search.type = "search";
    search.className = "award-search";
    search.placeholder = "名前で絞り込む…";
    search.autocomplete = "off";
    card.appendChild(search);

    const grid = document.createElement("div");
    grid.className = "grid";
    participants.forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.dataset.cid = p.id;
      chip.dataset.name = p.name;
      chip.innerHTML =
        `<span class="chip-rank"></span><span class="chip-name">${p.name}</span>`;
      chip.addEventListener("click", () => toggle(award, p.id));
      grid.appendChild(chip);
    });
    card.appendChild(grid);

    search.addEventListener("input", () => {
      const q = search.value.trim();
      grid.querySelectorAll(".chip").forEach((chip) => {
        const hit = !q || chip.dataset.name.includes(q);
        chip.style.display = hit ? "" : "none";
      });
    });

    const actions = document.createElement("div");
    actions.className = "row";
    actions.style.marginTop = "12px";
    const save = document.createElement("button");
    save.textContent = "この賞を保存";
    save.dataset.save = award.id;
    save.disabled = !votingOpen;
    save.addEventListener("click", () => saveAward(award, save));
    actions.appendChild(save);
    card.appendChild(actions);

    root.appendChild(card);
    applySelection(award.id);
  });

  if (!votingOpen) {
    document.querySelectorAll(".chip").forEach((c) => c.classList.add("disabled"));
  }
}

function toggle(award, candidateId) {
  if (!votingOpen) return;
  const arr = selections.get(award.id);
  const idx = arr.indexOf(candidateId);
  if (idx >= 0) {
    arr.splice(idx, 1); // 解除：以降の順位が繰り上がる
  } else {
    if (arr.length >= MAX_PICKS) {
      toast(`「${award.title}」は最大${MAX_PICKS}人までです`, true);
      return;
    }
    arr.push(candidateId); // 末尾に追加＝次の順位
  }
  applySelection(award.id);
}

// 1つの賞のチップ表示・順位バッジ・カウント・バッジを最新の選択に同期
function applySelection(awardId) {
  const arr = selections.get(awardId);
  const card = cardByAward.get(awardId);
  if (!card) return;

  card.classList.toggle("done", arr.length > 0);
  card.classList.toggle("todo", arr.length === 0);

  card.querySelectorAll(".chip").forEach((chip) => {
    const cid = Number(chip.dataset.cid);
    const rank = arr.indexOf(cid);
    const rankEl = chip.querySelector(".chip-rank");
    if (rank >= 0) {
      chip.classList.add("selected");
      rankEl.textContent = `${rank + 1}位 ・ ${pointForRank(rank)}pt`;
    } else {
      chip.classList.remove("selected");
      rankEl.textContent = "";
    }
  });

  const cnt = card.querySelector(`[data-count="${awardId}"]`);
  if (cnt) {
    cnt.textContent =
      `選択中：${arr.length} / ${MAX_PICKS} 人` +
      (arr.length ? `（タップした順に ${MAX_PICKS}pt→1pt）` : "");
  }

  const badge = card.querySelector(`[data-badge="${awardId}"]`);
  if (badge) {
    badge.className = `badge ${arr.length ? "done" : "todo"}`;
    badge.textContent = arr.length ? "投票済み" : "未投票";
  }

  updateProgress();
}

// 上部の全体進捗「N問中M問 投票済み」を更新
function updateProgress() {
  const el = $("#progress");
  if (!el) return;
  const total = awards.length;
  const done = awards.filter((a) => (selections.get(a.id) || []).length > 0).length;
  el.textContent = `${total}問中 ${done}問 投票済み`;
  el.classList.toggle("complete", total > 0 && done === total);
}

async function saveAward(award, btn) {
  if (!votingOpen) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "保存中…";

  const ordered = selections.get(award.id);

  // delete → insert で「最新の選択」に置き換える
  const del = await supabase
    .from("votes")
    .delete()
    .eq("event_id", EVENT_ID)
    .eq("voter_id", voter.id)
    .eq("award_id", award.id);

  if (del.error) {
    toast("保存に失敗しました（削除）", true);
    console.error(del.error);
    btn.disabled = false;
    btn.textContent = original;
    return;
  }

  if (ordered.length) {
    const rows = ordered.map((cid, i) => ({
      event_id: EVENT_ID,
      voter_id: voter.id,
      award_id: award.id,
      candidate_id: cid,
      point: pointForRank(i),
    }));
    const ins = await supabase.from("votes").insert(rows);
    if (ins.error) {
      toast("保存に失敗しました（受付が締め切られている可能性）", true);
      console.error(ins.error);
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
  }

  toast(`「${award.title}」を保存しました`);
  btn.disabled = false;
  btn.textContent = original;
}

load();
