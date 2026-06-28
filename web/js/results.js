import { supabase } from "../lib/supabase.js";
import { EVENT_ID, RESULTS_TOP_N, POLL_INTERVAL_MS } from "../config.js";

const $ = (s) => document.querySelector(s);

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
      if (!awards.length) return;
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
  // 名簿/お題の変更も時々取り込む
  setInterval(loadStatic, 30000);
}

main();
