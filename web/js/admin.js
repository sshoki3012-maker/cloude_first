import { supabase } from "../lib/supabase.js";
import { APP_TITLE, EVENT_ID } from "../config.js";
import { MEMORIES, MEMORY_CATEGORIES } from "../memories.js";
import { isUnlocked, tryUnlock } from "./gate.js";

const $ = (s) => document.querySelector(s);

// アプリタイトルをタブ名と見出しに反映（config.js の APP_TITLE を変えるだけでOK）
document.title = `${APP_TITLE} 管理`;
$("#app-title").textContent = `⚙️ ${APP_TITLE} 管理画面`;

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.borderColor = isError ? "var(--bad)" : "var(--good)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

// ---- 合言葉ゲート（js/gate.js 共通。一度認証すれば次回から入力不要） ----
function openPanel() {
  $("#gate").style.display = "none";
  $("#panel").style.display = "block";
  refresh();
}
$("#unlock").addEventListener("click", () => {
  if (tryUnlock($("#pass").value)) {
    openPanel();
  } else {
    toast("合言葉が違います", true);
  }
});
$("#pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#unlock").click();
});
// このブラウザで認証済みなら、合言葉入力を飛ばしてすぐ開く
if (isUnlocked()) openPanel();

// ---- 受付状態 ----
async function refresh() {
  await Promise.all([
    loadSettings(), loadStats(), loadAwards(), loadPeople(), loadMemorySettings(),
  ]);
}

// 投票完了状況：votes の voter_id から集計（DB変更なしで算出）
async function loadStats() {
  const [pplRes, awardsRes, votesRes] = await Promise.all([
    supabase.from("participants").select("id"),
    supabase.from("awards").select("id").eq("is_active", true),
    supabase.from("votes").select("voter_id,award_id").eq("event_id", EVENT_ID),
  ]);

  const totalPeople = (pplRes.data || []).length;
  const activeAwards = (awardsRes.data || []).length;
  const votes = votesRes.data || [];

  // 投票者ごとに、回答済みのお題数を集計
  const awardsByVoter = new Map();
  for (const v of votes) {
    if (!awardsByVoter.has(v.voter_id)) awardsByVoter.set(v.voter_id, new Set());
    awardsByVoter.get(v.voter_id).add(v.award_id);
  }
  const participated = awardsByVoter.size; // 1問以上投票した人数
  let completed = 0; // 全お題に回答した人数
  for (const set of awardsByVoter.values()) {
    if (activeAwards > 0 && set.size >= activeAwards) completed++;
  }

  $("#stat-participated").textContent = `${totalPeople}人中 ${participated}人が投票`;
  $("#stat-completed").textContent =
    `全${activeAwards}問に回答済み：${completed}人` +
    `（1問以上のみ：${participated - completed}人）`;
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

$("#refresh-stats").addEventListener("click", loadStats);

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

// =============================================================
// 思い出ランキング発表の設定
// - 発表したい項目にチェックを入れて、順番を決めて「保存」する
// - 保存先は Supabase の memory_settings テーブル（selected_ids 列）
// =============================================================

// 選択中の項目 id の配列。並び順がそのまま発表順になる
let memSelected = [];

// 問題ごとの発表方法（{ q1: "B", ... }）。
//   A = 一括表示（タップで題目と全順位を一度に表示）← デフォルト
//   B = 1位を伏せる（2位3位を見せて、もう1タップで1位を発表）
let memModes = {};

// 保存済みの選択を読み込む
async function loadMemorySettings() {
  const { data, error } = await supabase
    .from("memory_settings")
    .select("selected_ids, reveal_modes")
    .eq("event_id", EVENT_ID)
    .maybeSingle();
  if (error) {
    console.error(error);
    toast("思い出設定の読込に失敗（memory_settings テーブルはありますか？）", true);
  }
  // memories.js に存在しない id が混ざっていたら取り除く
  memSelected = (data?.selected_ids || []).filter((id) =>
    MEMORIES.some((m) => m.id === id)
  );
  memModes = data?.reveal_modes || {};
  renderMemorySection();
}

// 項目の中身を1行のテキストにする（チェック時に表示する答え）
function memDetailText(m) {
  if (m.type === "best3") {
    return `1位 ${m.ranks[0]} ／ 2位 ${m.ranks[1]} ／ 3位 ${m.ranks[2]}`;
  }
  return `男：${m.male} ／ 女：${m.female}`;
}

// チェックボックス一覧と発表順リストをまとめて描き直す
function renderMemorySection() {
  // ---- 選択数のカウント表示 ----
  const count = $("#mem-count");
  count.textContent = `${memSelected.length}項目 選択中`;
  count.className = "badge " + (memSelected.length ? "done" : "todo");

  // ---- カテゴリごとのチェックボックス一覧 ----
  const catRoot = $("#mem-categories");
  catRoot.innerHTML = "";
  MEMORY_CATEGORIES.forEach((cat) => {
    const box = document.createElement("div");
    box.className = "mem-category";
    const h = document.createElement("h3");
    h.className = "mem-cat-title";
    h.textContent = cat;
    box.appendChild(h);

    MEMORIES.filter((m) => m.category === cat).forEach((m) => {
      const checked = memSelected.includes(m.id);
      const modeB = memModes[m.id] === "B"; // 指定なしは A（一括表示）
      const row = document.createElement("label");
      row.className = "mem-item" + (checked ? " checked" : "");
      row.innerHTML = `
        <input type="checkbox" ${checked ? "checked" : ""} />
        <span class="mem-item-body">
          <span class="mem-item-title">${m.title}</span>
          ${checked ? `<span class="mem-item-detail">${memDetailText(m)}</span>` : ""}
          ${checked ? `
            <span class="mem-mode">
              <button type="button" data-mode="A" class="${modeB ? "" : "active"}">A 一括表示</button>
              <button type="button" data-mode="B" class="${modeB ? "active" : ""}">B 1位を伏せる</button>
            </span>` : ""}
        </span>`;
      row.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) {
          memSelected.push(m.id); // チェックした順に末尾へ追加
        } else {
          memSelected = memSelected.filter((id) => id !== m.id);
        }
        renderMemorySection();
      });
      // A/B トグル（ラベル内のボタンなので、チェックボックスが反応しないよう止める）
      row.querySelectorAll(".mem-mode button").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.dataset.mode === "B") {
            memModes[m.id] = "B";
          } else {
            delete memModes[m.id]; // A はデフォルトなので保存データからは消す
          }
          renderMemorySection();
        });
      });
      box.appendChild(row);
    });
    catRoot.appendChild(box);
  });

  // ---- 発表順の並べ替えリスト ----
  const orderRoot = $("#mem-order");
  orderRoot.innerHTML = "";
  if (!memSelected.length) {
    orderRoot.innerHTML = `<p class="muted">まだ何も選ばれていません。</p>`;
    return;
  }
  memSelected.forEach((id, i) => {
    const m = MEMORIES.find((x) => x.id === id);
    const row = document.createElement("div");
    row.className = "mem-order-item";
    const modeTag = memModes[id] === "B" ? `<span class="mem-mode-tag">B 1位伏せ</span>` : "";
    row.innerHTML = `
      <span class="mem-order-num">${i + 1}</span>
      <span class="mem-order-title">${m.title}<span class="muted"> （${m.category}）</span>${modeTag}</span>
      <button class="btn-sm btn-ghost" data-act="up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="btn-sm btn-ghost" data-act="down" ${i === memSelected.length - 1 ? "disabled" : ""}>↓</button>`;
    // ↑ボタン：1つ上の項目と入れ替える
    row.querySelector('[data-act="up"]').addEventListener("click", () => {
      [memSelected[i - 1], memSelected[i]] = [memSelected[i], memSelected[i - 1]];
      renderMemorySection();
    });
    // ↓ボタン：1つ下の項目と入れ替える
    row.querySelector('[data-act="down"]').addEventListener("click", () => {
      [memSelected[i], memSelected[i + 1]] = [memSelected[i + 1], memSelected[i]];
      renderMemorySection();
    });
    orderRoot.appendChild(row);
  });
}

// 保存：選択・発表順・A/B設定を memory_settings に書き込む（無ければ行ごと作る）
$("#mem-save").addEventListener("click", async () => {
  const { error } = await supabase
    .from("memory_settings")
    .upsert({ event_id: EVENT_ID, selected_ids: memSelected, reveal_modes: memModes });
  if (error) {
    console.error(error);
    return toast("保存失敗（reveal_modes 列は追加済みですか？）", true);
  }
  toast(`保存しました（${memSelected.length}項目）`);
});

// すべて選択解除（画面上だけ。確定するには「保存」を押す）
$("#mem-clear").addEventListener("click", () => {
  if (!memSelected.length) return;
  if (!confirm("すべての選択を外します。よろしいですか？（「保存」を押すまで確定はされません）")) return;
  memSelected = [];
  renderMemorySection();
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
