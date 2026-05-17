// 同窓会出席管理 — Firebase Firestore でリアルタイム同期
// firebase-config.js から設定を読み込みます（README 参照）
import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const STATUSES = ["未連絡", "連絡済", "検討中", "出席", "欠席"];

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const membersCol = collection(db, "members");

const state = {
  members: [],
  filterText: "",
  filterStatus: "",
  filterOwner: "",
  editingId: null,
};

// --- DOM refs ---
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

// --- Firestore subscription (realtime) ---
const q = query(membersCol, orderBy("createdAt", "asc"));
onSnapshot(
  q,
  (snap) => {
    state.members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    connStatusEl.textContent = "● オンライン";
    connStatusEl.classList.add("online");
    connStatusEl.classList.remove("offline");
    render();
  },
  (err) => {
    console.error(err);
    connStatusEl.textContent = "● オフライン";
    connStatusEl.classList.add("offline");
    connStatusEl.classList.remove("online");
  }
);

// --- Render ---
function render() {
  // owner filter options
  const owners = [...new Set(state.members.map((m) => m.owner).filter(Boolean))].sort();
  const currentOwner = filterOwnerEl.value;
  filterOwnerEl.innerHTML =
    '<option value="">すべての担当者</option>' +
    owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  filterOwnerEl.value = currentOwner;

  // owner datalist
  ownerSuggestions.innerHTML = owners.map((o) => `<option value="${escapeHtml(o)}">`).join("");

  // counts
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  state.members.forEach((m) => {
    if (counts[m.status] !== undefined) counts[m.status]++;
  });
  STATUSES.forEach((s) => {
    document.getElementById(`count-${s}`).textContent = counts[s];
  });
  document.getElementById("count-total").textContent = state.members.length;

  // filter
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

  // list
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

// --- Event handlers ---
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
    updatedAt: serverTimestamp(),
  };
  btnSave.disabled = true;
  try {
    if (state.editingId) {
      await updateDoc(doc(db, "members", state.editingId), payload);
    } else {
      await addDoc(membersCol, { ...payload, createdAt: serverTimestamp() });
    }
    closeModal();
  } catch (err) {
    console.error(err);
    alert("保存に失敗しました: " + err.message);
  } finally {
    btnSave.disabled = false;
  }
});

btnDelete.addEventListener("click", async () => {
  if (!state.editingId) return;
  if (!confirm("削除します。よろしいですか？")) return;
  try {
    await deleteDoc(doc(db, "members", state.editingId));
    closeModal();
  } catch (err) {
    console.error(err);
    alert("削除に失敗しました: " + err.message);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
});

// --- Modal helpers ---
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
