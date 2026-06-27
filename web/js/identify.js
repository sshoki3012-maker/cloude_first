import { supabase } from "../lib/supabase.js";
import { EVENT_ID } from "../config.js";

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = `mirai_voter_${EVENT_ID}`;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

let participants = [];

function render(filter = "") {
  const sel = $("#name-select");
  const f = filter.trim();
  sel.innerHTML = "";
  participants
    .filter((p) => !f || p.name.includes(f))
    .forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
  $("#enter").disabled = !sel.value;
}

async function init() {
  // 既存ログインがあれば案内
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  if (saved) {
    $("#known").innerHTML =
      `前回は <b>${saved.name}</b> として参加中。` +
      ` <a href="./vote.html">投票へ進む →</a>`;
  }

  const [{ data: settings }, { data: ppl, error }] = await Promise.all([
    supabase.from("settings").select("label").eq("event_id", EVENT_ID).maybeSingle(),
    supabase.from("participants").select("id,name,sort_order").order("sort_order"),
  ]);

  if (settings?.label) $("#event-label").textContent = settings.label;
  if (error) {
    toast("名簿の読み込みに失敗しました");
    console.error(error);
    return;
  }
  participants = ppl || [];
  render();

  $("#search").addEventListener("input", (e) => render(e.target.value));
  $("#name-select").addEventListener("change", () => {
    $("#enter").disabled = !$("#name-select").value;
  });
  $("#enter").addEventListener("click", () => {
    const sel = $("#name-select");
    const id = Number(sel.value);
    const p = participants.find((x) => x.id === id);
    if (!p) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: p.id, name: p.name }));
    location.href = "./vote.html";
  });
}

init();
