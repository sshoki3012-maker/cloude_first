// =============================================================
// 全画面共通のナビゲーションバー
// 各ページから setupNav("ページ名") を呼ぶと、画面上部にボタン列を
// 差し込みます。今いるページのボタンはハイライトされ、押せません。
//
// 発表中（results / memories）は navPresenting(true) を呼ぶと
// ナビバーを自動で隠し、画面隅の「☰」ボタンだけ残します。
// ☰ を押すとナビバーが最前面に出てきて、他の画面へ移動できます。
// =============================================================

// ナビに並べるページの一覧（表示順もこのまま）
const PAGES = [
  { id: "vote",     href: "./index.html",    label: "🗳 投票" },
  { id: "qr",       href: "./qr.html",       label: "📱 QR" },
  { id: "results",  href: "./results.html",  label: "🏆 結果発表" },
  { id: "memories", href: "./memories.html", label: "📖 思い出発表" },
  { id: "admin",    href: "./admin.html",    label: "⚙️ 管理" },
];

// ナビバーを作って body の先頭に差し込む
export function setupNav(currentId) {
  const nav = document.createElement("nav");
  nav.className = "appnav";
  nav.id = "appnav";

  PAGES.forEach((p) => {
    if (p.id === currentId) {
      // 今いるページ：リンクにせず、ハイライト表示だけ
      const span = document.createElement("span");
      span.className = "appnav-btn current";
      span.textContent = p.label;
      nav.appendChild(span);
    } else {
      const a = document.createElement("a");
      a.className = "appnav-btn";
      a.href = p.href;
      a.textContent = p.label;
      nav.appendChild(a);
    }
  });
  document.body.prepend(nav);

  // 発表中にナビを呼び出すための小さなボタン（普段は隠しておく）
  const peek = document.createElement("button");
  peek.id = "nav-peek";
  peek.type = "button";
  peek.textContent = "☰";
  peek.title = "ナビゲーションを表示";
  peek.style.display = "none";
  peek.addEventListener("click", (e) => {
    e.stopPropagation(); // 発表画面の「タップで進む」に反応させない
    nav.classList.toggle("overlay-show");
  });
  document.body.appendChild(peek);
}

// 発表の開始/終了時に呼ぶ。on=true でナビを隠して ☰ ボタンを出す
export function navPresenting(on) {
  const nav = document.getElementById("appnav");
  const peek = document.getElementById("nav-peek");
  if (!nav || !peek) return;
  nav.classList.toggle("presenting", on);
  nav.classList.remove("overlay-show"); // 切り替え時は一旦閉じる
  peek.style.display = on ? "block" : "none";
}
