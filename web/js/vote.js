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
// award_id -> bool  保存済みでロック中かどうか
const locked = new Map();
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

  // 既存投票を point の大きい順（=選んだ順）に並べて復元。
  // 保存済みの賞は最初からロック状態にして誤操作を防ぐ。
  const byAward = new Map();
  for (const v of votesRes.data || []) {
    if (!byAward.has(v.award_id)) byAward.set(v.award_id, []);
    byAward.get(v.award_id).push(v);
  }
  for (const [awardId, rows] of byAward) {
    rows.sort((a, b) => b.point - a.point);
    selections.set(awardId, rows.map((r) => r.candidate_id));
    locked.set(awardId, true);
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
    head.innerHTML = `<h2>${award.title}</h2>`;
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

    // 操作ボタン：保存（未保存/保存済み）と 変更
    const actions = document.createElement("div");
    actions.className = "row";
    actions.style.marginTop = "12px";

    const save = document.createElement("button");
    save.dataset.save = award.id;
    save.addEventListener("click", () => saveAward(award));

    const edit = document.createElement("button");
    edit.dataset.edit = award.id;
    edit.className = "btn-ghost";
    edit.textContent = "変更";
    edit.addEventListener("click", () => editAward(award));

    actions.appendChild(save);
    actions.appendChild(edit);
    card.appendChild(actions);

    root.appendChild(card);
    applySelection(award.id);
    applyLock(award.id);
  });
}

function toggle(award, candidateId) {
  if (!votingOpen) return;
  if (locked.get(award.id)) return; // 保存済み（ロック中）は変更不可
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

// チップの選択表示（順位・配点バッジ）とカウントを同期
function applySelection(awardId) {
  const arr = selections.get(awardId);
  const card = cardByAward.get(awardId);
  if (!card) return;

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
}

// ロック状態に応じてチップのロック・ボタン表示・枠色・進捗を同期
function applyLock(awardId) {
  const card = cardByAward.get(awardId);
  if (!card) return;
  const arr = selections.get(awardId);
  const isLocked = locked.get(awardId) === true;

  const grid = card.querySelector(".grid");
  grid.classList.toggle("locked", isLocked || !votingOpen);

  const saveBtn = card.querySelector("[data-save]");
  const editBtn = card.querySelector("[data-edit]");

  if (!votingOpen) {
    saveBtn.textContent = "受付終了";
    saveBtn.className = "btn-saved";
    saveBtn.disabled = true;
    editBtn.style.display = "none";
  } else if (isLocked) {
    saveBtn.textContent = "保存済み";
    saveBtn.className = "btn-saved";
    saveBtn.disabled = true;
    editBtn.style.display = "";
    editBtn.disabled = false;
  } else {
    saveBtn.textContent = "未保存（タップで保存）";
    saveBtn.className = "btn-unsaved";
    saveBtn.disabled = false;
    editBtn.style.display = "none";
  }

  // 「投票済み」= 保存済みかつ1人以上選択。枠色と進捗に反映
  const done = isLocked && arr.length > 0;
  card.classList.toggle("done", done);
  card.classList.toggle("todo", !done);

  updateProgress();
}

// 上部の全体進捗「N問中M問 投票済み」を更新
function updateProgress() {
  const el = $("#progress");
  if (!el) return;
  const total = awards.length;
  const done = awards.filter(
    (a) => locked.get(a.id) === true && (selections.get(a.id) || []).length > 0
  ).length;
  el.textContent = `${total}問中 ${done}問 投票済み`;
  el.classList.toggle("complete", total > 0 && done === total);
}

// 「変更」：ロックを解除して選び直せる状態に戻す
function editAward(award) {
  if (!votingOpen) return;
  locked.set(award.id, false);
  applyLock(award.id);
  toast(`「${award.title}」を選び直せます`);
}

async function saveAward(award) {
  if (!votingOpen) return;
  if (locked.get(award.id)) return;

  const card = cardByAward.get(award.id);
  const saveBtn = card.querySelector("[data-save]");
  saveBtn.disabled = true;
  saveBtn.textContent = "保存中…";

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
    applyLock(award.id); // 未保存状態へ戻す
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
      applyLock(award.id); // 未保存状態へ戻す
      return;
    }
  }

  locked.set(award.id, true);
  applyLock(award.id);
  toast(`「${award.title}」を保存しました`);
}

load();
