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
// award_id -> Set(candidate_id) 現在の選択
const selections = new Map();

async function load() {
  $("#whoami").textContent = `${voter.name} さん`;

  const [settingsRes, pplRes, awardsRes, votesRes] = await Promise.all([
    supabase.from("settings").select("voting_open").eq("event_id", EVENT_ID).maybeSingle(),
    supabase.from("participants").select("id,name,sort_order").order("sort_order"),
    supabase.from("awards").select("*").eq("is_active", true).order("sort_order"),
    supabase
      .from("votes")
      .select("award_id,candidate_id")
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

  for (const v of votesRes.data || []) {
    if (!selections.has(v.award_id)) selections.set(v.award_id, new Set());
    selections.get(v.award_id).add(v.candidate_id);
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

  awards.forEach((award) => {
    if (!selections.has(award.id)) selections.set(award.id, new Set());
    const sel = selections.get(award.id);

    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "row";
    head.innerHTML = `
      <h2>${award.title}</h2>
      <div class="spacer"></div>
      <span class="badge ${sel.size ? "done" : "todo"}" data-badge="${award.id}">
        ${sel.size ? "投票済み" : "未投票"}
      </span>`;
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

    const grid = document.createElement("div");
    grid.className = "grid";
    participants.forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "chip" + (sel.has(p.id) ? " selected" : "");
      chip.textContent = p.name;
      chip.addEventListener("click", () => toggle(award, p.id));
      grid.appendChild(chip);
    });
    card.appendChild(grid);

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
    updateCount(award.id);
  });

  // 投票締切時はチップ操作不可
  if (!votingOpen) {
    document.querySelectorAll(".chip").forEach((c) => c.classList.add("disabled"));
  }
}

function toggle(award, candidateId) {
  if (!votingOpen) return;
  const sel = selections.get(award.id);
  if (sel.has(candidateId)) {
    sel.delete(candidateId);
  } else {
    if (sel.size >= MAX_PICKS) {
      toast(`「${award.title}」は最大${MAX_PICKS}人までです`, true);
      return;
    }
    sel.add(candidateId);
  }
  // 再描画は最小限：そのカードだけ更新
  rerenderAward(award.id);
}

function rerenderAward(awardId) {
  const sel = selections.get(awardId);
  const award = awards.find((a) => a.id === awardId);
  // チップの選択状態
  const cards = document.querySelectorAll("#awards .card");
  const idx = awards.indexOf(award);
  const grid = cards[idx]?.querySelectorAll(".chip");
  if (grid) {
    participants.forEach((p, i) => {
      grid[i].classList.toggle("selected", sel.has(p.id));
    });
  }
  updateCount(awardId);
  const badge = document.querySelector(`[data-badge="${awardId}"]`);
  if (badge) {
    badge.className = `badge ${sel.size ? "done" : "todo"}`;
    badge.textContent = sel.size ? "投票済み" : "未投票";
  }
}

function updateCount(awardId) {
  const sel = selections.get(awardId);
  const el = document.querySelector(`[data-count="${awardId}"]`);
  if (el) el.textContent = `選択中：${sel.size} / ${MAX_PICKS} 人`;
}

async function saveAward(award, btn) {
  if (!votingOpen) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "保存中…";

  const candidates = [...selections.get(award.id)];

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

  if (candidates.length) {
    const rows = candidates.map((cid) => ({
      event_id: EVENT_ID,
      voter_id: voter.id,
      award_id: award.id,
      candidate_id: cid,
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
