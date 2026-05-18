import express from "express";
import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- .env を読み込み (依存ゼロの簡易ローダー) ---
loadEnv(path.join(__dirname, ".env"));

const {
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  APP_PASSWORD,
  SESSION_SECRET,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  APP_PASSWORD,
  SESSION_SECRET,
})) {
  if (!v) {
    console.error(`環境変数 ${k} が設定されていません。.env.example を参考に .env を作成してください。`);
    process.exit(1);
  }
}

// --- DB ---
const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

await db.execute(`
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '未連絡',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// --- SSE クライアント管理 ---
const sseClients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// --- セッション Cookie (HMAC 署名) ---
const COOKIE_NAME = "alumni_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30日

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}
function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(data)
    .digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function requireAuth(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = verifySession(token);
  if (!session) {
    res.status(401).json({ error: "認証が必要です" });
    return;
  }
  req.session = session;
  next();
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // 長さが違っても比較時間を一定にする
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// --- App ---
const app = express();
app.use(express.json({ limit: "100kb" }));

// ログイン
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || !timingSafeEqualStr(password, APP_PASSWORD)) {
    res.status(401).json({ error: "パスワードが違います" });
    return;
  }
  const token = signSession({ exp: Date.now() + SESSION_TTL_MS });
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}${secure ? "; Secure" : ""}`
  );
  res.json({ ok: true });
});

// ログアウト
app.post("/api/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
  );
  res.json({ ok: true });
});

// 認証状態
app.get("/api/me", (req, res) => {
  const session = verifySession(parseCookies(req)[COOKIE_NAME]);
  res.json({ authenticated: !!session });
});

// メンバー一覧
app.get("/api/members", requireAuth, async (req, res) => {
  try {
    const rs = await db.execute("SELECT * FROM members ORDER BY created_at ASC");
    res.json({ members: rs.rows.map(rowToMember) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 追加
app.post("/api/members", requireAuth, async (req, res) => {
  try {
    const m = sanitizeMember(req.body);
    if (!m.name) return res.status(400).json({ error: "名前は必須です" });
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO members (id, name, owner, status, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, m.name, m.owner, m.status, m.note, now, now],
    });
    const member = { id, ...m, created_at: now, updated_at: now };
    broadcast({ type: "created", member });
    res.json({ member });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 更新
app.put("/api/members/:id", requireAuth, async (req, res) => {
  try {
    const m = sanitizeMember(req.body);
    if (!m.name) return res.status(400).json({ error: "名前は必須です" });
    const now = Date.now();
    const rs = await db.execute({
      sql: `UPDATE members SET name=?, owner=?, status=?, note=?, updated_at=? WHERE id=?`,
      args: [m.name, m.owner, m.status, m.note, now, req.params.id],
    });
    if (rs.rowsAffected === 0) return res.status(404).json({ error: "見つかりません" });
    const member = { id: req.params.id, ...m, updated_at: now };
    broadcast({ type: "updated", member });
    res.json({ member });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 削除
app.delete("/api/members/:id", requireAuth, async (req, res) => {
  try {
    const rs = await db.execute({
      sql: "DELETE FROM members WHERE id=?",
      args: [req.params.id],
    });
    if (rs.rowsAffected === 0) return res.status(404).json({ error: "見つかりません" });
    broadcast({ type: "deleted", id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// SSE
app.get("/api/events", requireAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`: connected\n\n`);
  sseClients.add(res);

  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 20000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// 静的ファイル
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`同窓会出席管理: http://localhost:${PORT}`);
});

// --- helpers ---
const STATUSES = new Set(["未連絡", "連絡済", "検討中", "出席", "欠席"]);
function sanitizeMember(b) {
  const status = STATUSES.has(b?.status) ? b.status : "未連絡";
  return {
    name: String(b?.name ?? "").trim().slice(0, 100),
    owner: String(b?.owner ?? "").trim().slice(0, 100),
    status,
    note: String(b?.note ?? "").trim().slice(0, 1000),
  };
}
function rowToMember(r) {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    status: r.status,
    note: r.note,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
