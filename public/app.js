// 同窓会出席管理 — Turso バックエンドへの API + SSE クライアント

const STATUSES = ["未連絡", "連絡済", "検討中", "出席", "欠席"];

const state = {
  members: [],
  filterText: "",
  filterStatus: "",
  filterOwner: "",
  editingId: null,
};

// --- DOM refs ---
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

const listEl = document.getElementById("member-list");
const emptyEl = document.getElementById("empty-message");
const filterTextEl = document.getElementById("filter-text");
const filterStatusEl = document.getElementById("filter-status");
const filterOwnerEl = document.getElementById("filter-owner");
const connStatusEl = document.getElementById("connection-status");

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const inputName = document.getElementById("input-name");
const inputOwner = document.getElementById("input-owner");
const inputStatus = document.getElementById("input-status");
const inputNote = document.getElementById("input-note");
const ownerSuggestions = document.getElementById("owner-suggestions");
const btnAdd = document.getElementById("open-add");
const btnSave = document.getElementById("modal-save");
const btnCancel = document.getElementById("modal-cancel");
const btnDelete = document.getElementById("modal-delete");

let eventSource = null;

// --- 初期化 ---
init();

async function init() {
  const me = await fetch("/api/me").then((r) => r.json()).catch(() => ({ authenticated: false }));
  if (me.authenticated) {
    await enterApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  appScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  setTimeout(() => loginPassword.focus(), 50);
}

async function enterApp() {
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  await loadMembers();
  subscribeEvents();
}

// --- ログイン ---
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: loginPassword.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      loginError.textContent = err.error || "ログインに失敗しました";
      loginError.classList.remove("hidden");
      return;
    }
    loginPassword.value = "";
    await enterApp();
  } catch (err) {
    loginError.textContent = "通信エラー: " + err.message;
    loginError.classList.remove("hidden");
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  state.members = [];
  showLogin();
});

// --- データ取得 ---
async function loadMembers() {
  try {
    const res = await fetch("/api/members");
    if (res.status === 401) return showLogin();
    const data = await res.json();
    state.members = data.members || [];
    render();
  } catch (err) {
    console.error(err);
  }
}

// --- SSE 購読 ---
function subscribeEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/events");
  eventSource.onopen = () => {
    connStatusEl.textContent = "● オンライン";
    connStatusEl.classList.add("online");
    connStatusEl.classList.remove("offline");
  };
  eventSource.onerror = () => {
    connStatusEl.textContent = "● オフライン";
    connStatusEl.classList.add("offline");
    connStatusEl.classList.remove("online");
  };
  eventSource.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      applyEvent(msg);
    } catch {}
  };
}

function applyEvent(msg) {
  if (msg.type === "created") {
    if (!state.members.some((m) => m.id === msg.member.id)) {
      state.members.push(msg.member);
    }
  } else if (msg.type === "updated") {
    const i = state.members.findIndex((m) => m.id === msg.member.id);
    if (i >= 0) state.members[i] = { ...state.members[i], ...msg.member };
  } else if (msg.type === "deleted") {
    state.members = state.members.filter((m) => m.id !== msg.id);
  }
  render();
}

// --- レンダリング ---
function render() {
  const owners = [...new Set(state.members.map((m) => m.owner).filter(Boolean))].sort();
  const currentOwner = filterOwnerEl.value;
  filterOwnerEl.innerHTML =
    '<option value="">すべての担当者</option>' +
    owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  filterOwnerEl.value = currentOwner;

  ownerSuggestions.innerHTML = owners.map((o) => `<option value="${escapeHtml(o)}">`).join("");

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  state.members.forEach((m) => {
    if (counts[m.status] !== undefined) counts[m.status]++;
  });
  STATUSES.forEach((s) => {
    document.getElementById(`count-${s}`).textContent = counts[s];
  });
  document.getElementById("count-total").textContent = state.members.length;

  const text = state.filterText.trim().toLowerCase();
  const filtered = state.members.filter((m) => {
    if (state.filterStatus && m.status !== state.filterStatus) return false;
    if (state.filterOwner && m.owner !== state.filterOwner) return false;
    if (text) {
      const hay = `${m.name || ""} ${m.owner || ""} ${m.note || ""}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });

  listEl.innerHTML = filtered
    .map(
      (m) => `
      <li class="member-item" data-id="${m.id}" data-status="${escapeHtml(m.status || "未連絡")}">
        <div class="member-main">
          <div class="member-name">${escapeHtml(m.name || "(名前なし)")}</div>
          <div class="member-meta">担当: ${escapeHtml(m.owner || "—")}</div>
          ${m.note ? `<div class="member-note">${escapeHtml(m.note)}</div>` : ""}
        </div>
        <span class="badge" data-status="${escapeHtml(m.status || "未連絡")}">${escapeHtml(m.status || "未連絡")}</span>
      </li>
    `
    )
    .join("");

  emptyEl.classList.toggle("hidden", filtered.length > 0);
}

// --- フィルタ ---
filterTextEl.addEventListener("input", (e) => {
  state.filterText = e.target.value;
  render();
});
filterStatusEl.addEventListener("change", (e) => {
  state.filterStatus = e.target.value;
  render();
});
filterOwnerEl.addEventListener("change", (e) => {
  state.filterOwner = e.target.value;
  render();
});

listEl.addEventListener("click", (e) => {
  const li = e.target.closest(".member-item");
  if (!li) return;
  const member = state.members.find((m) => m.id === li.dataset.id);
  if (member) openModal(member);
});

btnAdd.addEventListener("click", () => openModal(null));
btnCancel.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

btnSave.addEventListener("click", async () => {
  const name = inputName.value.trim();
  if (!name) {
    alert("名前を入力してください");
    inputName.focus();
    return;
  }
  const payload = {
    name,
    owner: inputOwner.value.trim(),
    status: inputStatus.value,
    note: inputNote.value.trim(),
  };
  btnSave.disabled = true;
  try {
    let res;
    if (state.editingId) {
      res = await fetch(`/api/members/${state.editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "保存に失敗しました");
    }
    closeModal();
  } catch (err) {
    alert(err.message);
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener("click", async () => {
  if (!state.editingId) return;
  if (!confirm("削除します。よろしいですか？")) return;
  try {
    const res = await fetch(`/api/members/${state.editingId}`, { method: "DELETE" });
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "削除に失敗しました");
    }
    closeModal();
  } catch (err) {
    alert(err.message);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
});

function openModal(member) {
  if (member) {
    state.editingId = member.id;
    modalTitle.textContent = "編集";
    inputName.value = member.name || "";
    inputOwner.value = member.owner || "";
    inputStatus.value = member.status || "未連絡";
    inputNote.value = member.note || "";
    btnDelete.classList.remove("hidden");
  } else {
    state.editingId = null;
    modalTitle.textContent = "新規追加";
    inputName.value = "";
    inputOwner.value = "";
    inputStatus.value = "未連絡";
    inputNote.value = "";
    btnDelete.classList.add("hidden");
  }
  modal.classList.remove("hidden");
  setTimeout(() => inputName.focus(), 50);
}

function closeModal() {
  modal.classList.add("hidden");
  state.editingId = null;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
