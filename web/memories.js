// =============================================================
// 思い出ランキングのデータ
// 中学時代の「あの頃の順位」を発表するための固定データです。
// - type が "best3" の項目 … ranks に [1位, 2位, 3位] の順で名前が入る
// - type が "pair"  の項目 … male（男子）と female（女子）に1名ずつ入る
// 名前や項目を直したいときは、このファイルを書き換えるだけでOKです。
// =============================================================

export const MEMORIES = [
  // ---- 全体部門 ----
  { id: "q1",  category: "全体部門", title: "クラス盛り上げてくれた",         type: "best3", ranks: ["藤野", "石井", "塩澤"] },
  { id: "q2",  category: "全体部門", title: "クラス引っ張ってくれた",         type: "best3", ranks: ["衣笠", "福村", "北村"] },
  { id: "q3",  category: "全体部門", title: "体育大会活躍してた",             type: "best3", ranks: ["石井", "古屋", "藤野"] },
  { id: "q4",  category: "全体部門", title: "合唱コンクール美声部門",         type: "best3", ranks: ["川崎", "塩澤", "三苫"] },
  { id: "q5",  category: "全体部門", title: "勉強一生懸命頑張った",           type: "best3", ranks: ["矢野", "高橋", "日下"] },
  { id: "q6",  category: "全体部門", title: "係の仕事しっかりやってくれた",   type: "best3", ranks: ["荒金", "三苫", "山口"] },
  { id: "q7",  category: "全体部門", title: "掃除きちんとやってくれた",       type: "best3", ranks: ["山口", "矢野", "長谷川"] },
  { id: "q8",  category: "全体部門", title: "修学旅行楽しみにしてた",         type: "best3", ranks: ["枡井", "木村", "北村"] },
  { id: "q9",  category: "全体部門", title: "元気有り余ってそうだね",         type: "best3", ranks: ["石井", "山下", "藤野"] },
  { id: "q10", category: "全体部門", title: "奇妙な行動",                     type: "best3", ranks: ["大石", "日下", "麻野"] },

  // ---- 男子部門 ----
  { id: "q11", category: "男子部門", title: "帰ったら寝てそう",               type: "best3", ranks: ["中川", "枡井", "上石"] },
  { id: "q12", category: "男子部門", title: "優男",                           type: "best3", ranks: ["荒金", "藤野", "松田"] },
  { id: "q13", category: "男子部門", title: "気が利く男子",                   type: "best3", ranks: ["松田", "相原", "金子"] },
  { id: "q14", category: "男子部門", title: "天然男子",                       type: "best3", ranks: ["上石", "宮", "大石"] },
  { id: "q15", category: "男子部門", title: "笑顔が可愛い",                   type: "best3", ranks: ["相原", "里", "三上"] },

  // ---- 女子部門 ----
  { id: "q16", category: "女子部門", title: "帰ったら晩飯まで寝てそう",       type: "best3", ranks: ["梶原", "山本", "川崎"] },
  { id: "q17", category: "女子部門", title: "優女",                           type: "best3", ranks: ["橋本", "矢野", "高橋"] },
  { id: "q18", category: "女子部門", title: "気が利く女子",                   type: "best3", ranks: ["矢野", "高橋", "三浦"] },
  { id: "q19", category: "女子部門", title: "天然女子",                       type: "best3", ranks: ["中嶋", "福村", "藤本"] },
  { id: "q20", category: "女子部門", title: "笑顔が可愛い",                   type: "best3", ranks: ["中西", "中嶋", "福村"] },
  { id: "q21", category: "女子部門", title: "将来芸能人とかなってそう",       type: "best3", ranks: ["藤本", "梶原", "川崎"] },

  // ---- 番外編（男女ペア） ----
  { id: "q22", category: "番外編", title: "ゆるキャラにするなら",             type: "pair", male: "三上", female: "山本" },
  { id: "q23", category: "番外編", title: "結婚が早そう",                     type: "pair", male: "荒金", female: "矢野" },
  { id: "q24", category: "番外編", title: "逆に結婚が遅そう",                 type: "pair", male: "相原", female: "木村" },
  { id: "q25", category: "番外編", title: "高校でデビュー間違いなし",         type: "pair", male: "北村", female: "川崎" },
  { id: "q26", category: "番外編", title: "コスプレが似合いそう",             type: "pair", male: "日下", female: "橋本" },
  { id: "q27", category: "番外編", title: "愛されそう",                       type: "pair", male: "藤野", female: "藤本" },
  { id: "q28", category: "番外編", title: "逆に愛しそう",                     type: "pair", male: "衣笠", female: "古屋" },
  { id: "q29", category: "番外編", title: "散歩してたら会えそう",             type: "pair", male: "塩澤", female: "山下" },
  { id: "q30", category: "番外編", title: "騙されそう",                       type: "pair", male: "相原", female: "三浦" },
  { id: "q31", category: "番外編", title: "将来大金持ち",                     type: "pair", male: "松田", female: "中嶋" },
  { id: "q32", category: "番外編", title: "常に笑顔で過ごす",                 type: "pair", male: "麻野", female: "梶原" },
  { id: "q34", category: "番外編", title: "ばったり会いそうな二人",           type: "pair", male: "金子", female: "山口" },
  { id: "q36", category: "番外編", title: "ミスター・ミス2組",                type: "pair", male: "藤野", female: "中西" },
];

// カテゴリの表示順（管理画面の一覧で使う）
export const MEMORY_CATEGORIES = ["全体部門", "男子部門", "女子部門", "番外編"];
