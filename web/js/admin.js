import { supabase } from "../lib/supabase.js";
import { EVENT_ID, ADMIN_PASSCODE } from "../config.js";

const $ = (s) => document.querySelector(s);

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.borderColor = isError ? "var(--accent)" : "var(--accent2)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

// ---- 合言葉ゲート ----
$("#unlock").addEventListener("click", () => {
  if ($("#pass").value === ADMIN_PASSCODE) {
    $("#gate").style.display = "none";
    $("#panel").style.display = "block";
    refresh();
  } else {
    toast("合言葉が違います", true);
  }
});
$("#pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#unlock").click();
});

// ---- 受付状態 ----
async function refresh() {
  await Promise.all([loadSettings(), loadAwards(), loadPeople()]);
}

async function loadSettings() {
  const { data } = await supabase
    .from("settings")
    .select("voting_open")
    .eq("event_id", EVENT_ID)
    .maybeSingle();
  const open = data?.voting_open ?? true;
  const b = $("#open-badge");
  b.textContent = open ? "受付中" : "締切";
  b.className = "badge " + (open ? "done" : "closed");
  $("#toggle-open").dataset.open = open ? "1" : "0";
}

$("#toggle-open").addEventListener("click", async () => {
  const next = $("#toggle-open").dataset.open !== "1";
  const { error } = await supabase
    .from("settings")
    .update({ voting_open: next })
    .eq("event_id", EVENT_ID);
  if (error) return toast("更新に失敗", true);
  toast(next ? "受付を開始しました" : "受付を締め切りました");
  loadSettings();
});

// ---- お題 ----
async function loadAwards() {
  const { data } = await supabase.from("awards").select("*").order("sort_order");
  const root = $("#awards-list");
  root.innerHTML = "";
  (data || []).forEach((a) => {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <input value="${a.title.replaceAll('"', "&quot;")}" />
      <label class="row" style="gap:4px;width:auto">
        <input type="checkbox" style="width:auto" ${a.is_active ? "checked" : ""} />
        <span class="muted">表示</span>
      </label>
      <button class="btn-sm" data-act="save">保存</button>
      <button class="btn-sm btn-ghost" data-act="del">削除</button>`;
    const [titleInput, activeInput] = row.querySelectorAll("input");
    row.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const { error } = await supabase
        .from("awards")
        .update({ title: titleInput.value.trim(), is_active: activeInput.checked })
        .eq("id", a.id);
      toast(error ? "保存失敗" : "保存しました", !!error);
    });
    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`「${a.title}」を削除しますか？関連する投票も消えます。`)) return;
      const { error } = await supabase.from("awards").delete().eq("id", a.id);
      if (error) return toast("削除失敗", true);
      loadAwards();
    });
    root.appendChild(row);
  });
}

$("#add-award").addEventListener("click", async () => {
  const title = $("#new-award").value.trim();
  if (!title) return;
  const { data: maxRow } = await supabase
    .from("awards")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { error } = await supabase.from("awards").insert({ title, sort_order });
  if (error) return toast("追加失敗", true);
  $("#new-award").value = "";
  loadAwards();
});

// ---- 名簿 ----
async function loadPeople() {
  const { data } = await supabase
    .from("participants")
    .select("*")
    .order("sort_order");
  const root = $("#people-list");
  root.innerHTML = "";
  (data || []).forEach((p) => {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <input value="${p.name.replaceAll('"', "&quot;")}" />
      <button class="btn-sm" data-act="save">保存</button>
      <button class="btn-sm btn-ghost" data-act="del">削除</button>`;
    const input = row.querySelector("input");
    row.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const { error } = await supabase
        .from("participants")
        .update({ name: input.value.trim() })
        .eq("id", p.id);
      toast(error ? "保存失敗" : "保存しました", !!error);
    });
    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`「${p.name}」を削除しますか？`)) return;
      const { error } = await supabase.from("participants").delete().eq("id", p.id);
      if (error) return toast("削除失敗", true);
      loadPeople();
    });
    root.appendChild(row);
  });
}

$("#add-person").addEventListener("click", async () => {
  const name = $("#new-person").value.trim();
  if (!name) return;
  const { data: maxRow } = await supabase
    .from("participants")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { error } = await supabase.from("participants").insert({ name, sort_order });
  if (error) return toast("追加失敗", true);
  $("#new-person").value = "";
  loadPeople();
});

// ---- リセット ----
$("#reset").addEventListener("click", async () => {
  if (!confirm("この回の投票を全て削除します。よろしいですか？")) return;
  const { error } = await supabase.from("votes").delete().eq("event_id", EVENT_ID);
  toast(error ? "リセット失敗" : "投票をリセットしました", !!error);
});

// ---- エクスポート（答え合わせ用の保存） ----
async function fetchAll() {
  const [ppl, aw, votes] = await Promise.all([
    supabase.from("participants").select("*").order("sort_order"),
    supabase.from("awards").select("*").order("sort_order"),
    supabase.from("votes").select("*").eq("event_id", EVENT_ID),
  ]);
  return {
    event_id: EVENT_ID,
    participants: ppl.data || [],
    awards: aw.data || [],
    votes: votes.data || [],
  };
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$("#export-json").addEventListener("click", async () => {
  const all = await fetchAll();
  download(`mirai_${EVENT_ID}.json`, JSON.stringify(all, null, 2), "application/json");
});

$("#export-csv").addEventListener("click", async () => {
  const all = await fetchAll();
  const pName = new Map(all.participants.map((p) => [p.id, p.name]));
  const aName = new Map(all.awards.map((a) => [a.id, a.title]));
  const header = "event_id,award,voter,candidate,created_at";
  const lines = all.votes.map((v) =>
    [
      all.event_id,
      `"${(aName.get(v.award_id) || "").replaceAll('"', '""')}"`,
      `"${(pName.get(v.voter_id) || "").replaceAll('"', '""')}"`,
      `"${(pName.get(v.candidate_id) || "").replaceAll('"', '""')}"`,
      v.created_at,
    ].join(",")
  );
  download(`mirai_${EVENT_ID}.csv`, [header, ...lines].join("\n"), "text/csv");
});
