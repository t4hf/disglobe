"use strict";
/* ============================================================
   Disglobe server — zero-dependency online backend.
   Serves the client, stores accounts/servers/messages, pushes
   live updates over SSE. Run:  node server.js
   (or inside the Electron app: npm run disglobe:host)
   ============================================================ */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* ---------------- realtime transport: WebSocket (fallback: none) ----------------
   All live traffic — presence, messages, typing, voice states, WebRTC signaling —
   flows over WebSockets ("ws" package, optional dep). Voice/video media itself is
   WebRTC peer-to-peer; the server only relays SDP/ICE signaling. */
let WebSocketServer = null;
try { WebSocketServer = require("ws").WebSocketServer; } catch {}

/* ---------------- storage: PostgreSQL (optional) with JSON fallback ----------------
   Set DATABASE_URL (e.g. on Render/Railway/Neon) to use PostgreSQL. Without it,
   the server uses the classic disglobe-data/db.json file — zero-config local mode. */
let pgPool = null;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } });
  }
} catch {}
async function pgInit() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      key TEXT NOT NULL,
      id TEXT NOT NULL,
      msg JSONB NOT NULL,
      ts BIGINT NOT NULL,
      PRIMARY KEY (key, id)
    );
    CREATE INDEX IF NOT EXISTS messages_key_ts ON messages (key, ts);
  `);
  console.log("[disglobe] PostgreSQL storage ready");
}
async function dbLoad() {
  if (pgPool) {
    const r = await pgPool.query("SELECT v FROM kv WHERE k = 'core'");
    if (r.rows.length) db = { ...db, ...r.rows[0].v };
    const mr = await pgPool.query("SELECT key, msg FROM messages ORDER BY ts ASC");
    for (const row of mr.rows) (db.msgs[row.key] ||= []).push(row.msg);
    return;
  }
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) }; } catch {}
}
function dbSaveSoon() { saveSoon(); }
function saveSoon() {
  if (dirty) return;
  dirty = true;
  setTimeout(async () => {
    dirty = false;
    try {
      if (pgPool) {
        const { msgs, ...core } = db;
        await pgPool.query(
          "INSERT INTO kv (k, v) VALUES ('core', $1) ON CONFLICT (k) DO UPDATE SET v = $1",
          [JSON.stringify(core)]
        );
        /* messages live in their own table; sync any pending new ones */
        for (const [key, list] of Object.entries(db.msgs)) {
          const pending = list.slice(-pendingCount.get(key) || []);
          for (const m of pending) {
            await pgPool.query(
              "INSERT INTO messages (key, id, msg, ts) VALUES ($1,$2,$3,$4) ON CONFLICT (key, id) DO NOTHING",
              [key, m.id, JSON.stringify(m), m.ts || Date.now()]
            );
          }
          pendingCount.set(key, 0);
        }
      } else {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DB_FILE, JSON.stringify(db));
      }
    } catch (e) { console.error("[disglobe] save failed:", e.message); }
  }, 1500);
}
const pendingCount = new Map(); // key -> unsaved message count for pg mode

const PORT = Number(process.env.DISGLOBE_PORT || 3849);
const DATA_DIR = path.join(__dirname, "disglobe-data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BODY_LIMIT = 180 * 1024 * 1024; // allows several 25MB attachments (base64-inflated)

/* ---------------- tiny JSON db with debounced saves ---------------- */
let db = {
  users: {},      // name -> { name, pass:"salt:hash", email, emailVerified, profile, avatarData, bannerData, created }
  tokens: {},     // token -> { user, created }
  friends: {},    // name -> [name]
  requests: {},   // name -> [ { from, ts } ]
  servers: {},    // id -> { id, name, emoji, color, owner, members:[name], categories, banner, created }
  msgs: {},       // key -> [messages]      key: "s:<srv>:<chan>" | "dm:<a>|<b>"
  invites: {},    // code -> { serverId, by, ts }
  inbox: {},      // email -> [ mail from billybob ]
  reports: [],    // message reports: { id, by, key, msgId, reason, details, author, text, ts, open }
};
let dirty = false;
async function loadDb() {
  if (pgPool) { try { await dbLoad(); return; } catch (e) { console.error("[disglobe] pg load failed:", e.message); } }
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) }; } catch {}
}

/* ---------------- helpers ---------------- */
const uid = () => crypto.randomBytes(6).toString("hex");
const norm = n => String(n || "").trim().toLowerCase();
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return salt + ":" + hash;
}
function checkPass(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(String(pw), salt, 32));
  } catch { return false; }
}
const validName = n => /^[a-z0-9_.]{2,20}$/.test(norm(n));
/* short human-friendly invite code, e.g. GLB-7F3K9Q (no ambiguous chars) */
const inviteCode = () => "GLB-" + Array.from(crypto.randomBytes(6), b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ""));
const dmKey = (a, b) => "dm:" + [norm(a), norm(b)].sort().join("|");
const userPublic = u => u ? {
  name: u.name, profile: u.profile || {}, avatarData: u.avatarData || null, bannerData: u.bannerData || null,
  email: u.email || null, emailVerified: !!u.emailVerified, created: u.created,
} : null;
function userByName(n) { return db.users[norm(n)]; }
function authUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : new URL(req.url, "http://x").searchParams.get("token");
  const t = token && db.tokens[token];
  return t ? t.user : null;
}
/* everyone relevant to a user: friends, requests, dm partners, server members */
function peopleFor(name) {
  const out = {};
  const add = n => { const u = userByName(n); if (u) out[norm(n)] = userPublic(u); };
  (db.friends[name] || []).forEach(add);
  (db.requests[name] || []).forEach(r => add(r.from));
  Object.keys(db.servers).forEach(id => {
    const s = db.servers[id];
    if (s.members.includes(name)) s.members.forEach(add);
  });
  Object.keys(db.msgs).forEach(k => {
    if (k.startsWith("dm:")) {
      const [a, b] = k.slice(3).split("|");
      if (a === name || b === name) { add(a); add(b); }
    }
  });
  return out;
}
function worldFor(name) {
  const servers = Object.values(db.servers).filter(s => s.members.includes(name));
  const keys = new Set();
  servers.forEach(s => Object.keys(db.msgs).forEach(k => { if (k.startsWith("s:" + s.id + ":")) keys.add(k); }));
  Object.keys(db.msgs).forEach(k => {
    if (k.startsWith("dm:")) { const [a, b] = k.slice(3).split("|"); if (a === name || b === name) keys.add(k); }
  });
  const msgs = {};
  keys.forEach(k => { msgs[k] = db.msgs[k] || []; });
  return {
    profile: userPublic(db.users[name]).profile,
    servers, msgs,
    friends: (db.friends[name] || []).map(n => userPublic(userByName(n))).filter(Boolean),
    requests: (db.requests[name] || []).map(r => ({ ...userPublic(userByName(r.from)), ts: r.ts })).filter(Boolean),
    dmPartners: [...new Set(Object.keys(msgs).filter(k => k.startsWith("dm:")).flatMap(k => k.slice(3).split("|")))].filter(n => n !== name).map(n => userPublic(userByName(n))).filter(Boolean),
    people: peopleFor(name),
    online: [...onlineUsers],
    voice: voiceStates,
  };
}
function pushMsg(key, msg) {
  (db.msgs[key] ||= []).push(msg);
  if (db.msgs[key].length > 2000) db.msgs[key] = db.msgs[key].slice(-2000);
  if (pgPool) pendingCount.set(key, (pendingCount.get(key) || 0) + 1);
  saveSoon();
  return msg;
}
function broadcast(key, event) {
  const targets = new Set();
  if (key.startsWith("s:")) {
    const srv = db.servers[key.split(":")[1]];
    if (srv) srv.members.forEach(m => targets.add(m));
  } else if (key.startsWith("dm:")) {
    const [a, b] = key.slice(3).split("|");
    targets.add(a); targets.add(b);
  }
  targets.forEach(u => sendTo(u, event));
}
function sendTo(user, event) {
  const set = wsClients.get(norm(user));
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) { try { if (ws.readyState === 1) ws.send(data); } catch {} }
}

/* ---------------- WebSocket + presence ---------------- */
const wsClients = new Map(); // name -> Set<WebSocket>
const onlineUsers = new Set();
function wsConnect(name, ws) {
  const n = norm(name);
  (wsClients.get(n) || wsClients.set(n, new Set()).get(n)).add(ws);
  const wasOffline = !onlineUsers.has(n);
  onlineUsers.add(n);
  ws.send(JSON.stringify({ type: "hello", online: [...onlineUsers] }));
  if (wasOffline) broadcastPresence();
  ws.on("close", () => {
    const set = wsClients.get(n);
    if (set) { set.delete(ws); if (!set.size) { wsClients.delete(n); onlineUsers.delete(n); broadcastPresence(); } }
  });
}
function broadcastPresence() {
  const event = JSON.stringify({ type: "presence", online: [...onlineUsers] });
  for (const set of wsClients.values()) for (const ws of set) { try { if (ws.readyState === 1) ws.send(event); } catch {} }
}

/* ---------------- voice: states + WebRTC signaling relay ----------------
   voiceStates: name -> { serverId, channelId, sharing:"screen"|"cam"|null, quality }
   rtc signals relay between two peers by username (WebRTC mesh, direct P2P). */
const voiceStates = {};
function voiceBroadcast() {
  const event = JSON.stringify({ type: "voice", states: voiceStates });
  for (const set of wsClients.values()) for (const ws of set) { try { if (ws.readyState === 1) ws.send(event); } catch {} }
}
function sendToUser(user, obj) { sendTo(user, obj); }

/* ---------------- mail bot ---------------- */
function billybobSend(email, code) {
  (db.inbox[email] ||= []).push({
    from: "billybob@disglobe.chat",
    subject: "Your Disglobe verification code",
    body: `Hey! It's billybob 🤖\n\nYour Disglobe verification code is:\n\n    ${code}\n\nIt expires in 10 minutes.\n\n— billybob, the Disglobe mail bot`,
    ts: Date.now(),
  });
  console.info(`[disglobe] billybob mailed ${email} code ${code}`);
  saveSoon();
}
function billybobMail(email, subject, body) {
  (db.inbox[email] ||= []).push({ from: "billybob@disglobe.chat", subject, body, ts: Date.now() });
  console.info(`[disglobe] billybob mailed ${email}: ${subject}`);
  saveSoon();
}

/* ---------------- router ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(body);
  };
  if (req.method === "OPTIONS") return send(204, {});
  if (p === "/api/ping") return send(200, { disglobe: true, users: Object.keys(db.users).length, servers: Object.keys(db.servers).length });

  let body = {};
  if (req.method === "POST") {
    let raw = "";
    let size = 0;
    await new Promise((resolve) => {
      req.on("data", c => { size += c.length; if (size > BODY_LIMIT) { req.destroy(); resolve(); } else raw += c; });
      req.on("end", resolve);
      req.on("error", resolve);
    });
    try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "Bad JSON" }); }
  }

  /* ---- auth ---- */
  if (p === "/api/register" && req.method === "POST") {
    const name = norm(body.name);
    if (!validName(name)) return send(400, { error: "Username must be 2–20 chars: a-z 0-9 _ ." });
    if (!body.pass || String(body.pass).length < 4) return send(400, { error: "Password needs at least 4 characters." });
    if (body.email && !validEmail(body.email)) return send(400, { error: "That email doesn't look right." });
    if (db.users[name]) return send(400, { error: "That username is taken." });
    if (body.email && Object.values(db.users).some(u => u.email === body.email.toLowerCase())) return send(400, { error: "That email is already on an account." });
    db.users[name] = {
      name, pass: hashPass(body.pass), email: body.email ? body.email.toLowerCase() : null, emailVerified: false,
      profile: { name, displayName: "", color: "#9d6bff", status: "online", pronouns: "", customStatus: "", bio: "", nameEffect: "none", profileEffect: "none", badges: ["member"] },
      created: Date.now(),
    };
    const token = crypto.randomBytes(24).toString("hex");
    db.tokens[token] = { user: name, created: Date.now() };
    saveSoon();
    return send(200, { token, world: worldFor(name) });
  }
  if (p === "/api/login" && req.method === "POST") {
    const u = userByName(body.name);
    if (!u || !checkPass(body.pass, u.pass)) return send(401, { error: "Wrong username or password." });
    const token = crypto.randomBytes(24).toString("hex");
    db.tokens[token] = { user: u.name, created: Date.now() };
    saveSoon();
    return send(200, { token, world: worldFor(u.name) });
  }

  /* ---- password reset (no auth — that's the point) ---- */
  if (p === "/api/reset/start" && req.method === "POST") {
    const u = userByName(body.name);
    if (!u) return send(400, { error: "No account with that username." });
    if (!u.email) return send(400, { error: "That account has no email on file — recovery isn't set up for it.\n(Log in and add an email in Settings → Account.)" });
    if (!u.emailVerified) return send(400, { error: "That account's email was never verified." });
    const email = String(body.email || "").toLowerCase().trim();
    if (email && email !== u.email) return send(400, { error: "That email doesn't match the one on this account." });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.users[u.name].pendingCode = { email: u.email, code, expires: Date.now() + 10 * 60e3, purpose: "reset" };
    billybobSend(u.email, code);
    return send(200, { ok: true, email: u.email.replace(/^(.{2}).*(@.*)$/, "$1•••••$2") });
  }
  if (p === "/api/reset/complete" && req.method === "POST") {
    const u = userByName(body.name);
    if (!u || !u.pendingCode || u.pendingCode.purpose !== "reset") return send(400, { error: "No reset in progress — start again." });
    const pc = u.pendingCode;
    if (Date.now() > pc.expires) { delete u.pendingCode; return send(400, { error: "That code expired — start again." }); }
    if (String(body.code) !== pc.code) return send(400, { error: "Wrong code — check billybob's email and retry." });
    const npw = String(body.newPass || "");
    if (npw.length < 4) return send(400, { error: "New password needs at least 4 characters." });
    u.pass = hashPass(npw);
    delete u.pendingCode;
    /* drop all sessions — a reset kicks out any stolen tokens */
    for (const [t, rec] of Object.entries(db.tokens)) if (rec.user === u.name) delete db.tokens[t];
    billybobMail(u.email, "Your Disglobe password was changed", `Hey! It's billybob 🤖\n\nThe password for ${u.name} was just reset. If this wasn't you, reply quickly!\n\n— billybob`);
    return send(200, { ok: true });
  }

  if (p === "/api/forgot-username" && req.method === "POST") {
    const email = String(body.email || "").toLowerCase().trim();
    if (!validEmail(email)) return send(400, { error: "That email doesn't look right." });
    const u = Object.values(db.users).find(x => x.email === email && x.emailVerified);
    /* same response either way — no account enumeration */
    if (u) billybobMail(email, "Your Disglobe username", `Hey! It's billybob 🤖\n\nYour Disglobe username is:\n\n    ${u.name}\n\nSee you on the globe!\n\n— billybob`);
    return send(200, { ok: true, sent: !!u, email: email.replace(/^(.{2}).*(@.*)$/, "$1•••••$2") });
  }

  /* ---- everything below requires auth ---- */
  const me = authUser(req);
  if (!me) return send(401, { error: "Not logged in" });

  if (p === "/api/world") return send(200, worldFor(me));
  if (p === "/api/me" && req.method === "POST") {
    const u = db.users[me];
    const allowed = ["displayName", "pronouns", "customStatus", "bio", "color", "status", "nameEffect", "profileEffect", "badges"];
    for (const k of allowed) if (k in body) u.profile[k] = body[k];
    if (body.avatarData && String(body.avatarData).length < 2 * 1024 * 1024) u.avatarData = body.avatarData;
    if (body.bannerData && String(body.bannerData).length < 3 * 1024 * 1024) u.bannerData = body.bannerData;
    if (body.avatarData === null) u.avatarData = null;
    if (body.bannerData === null) u.bannerData = null;
    saveSoon();
    return send(200, { profile: u.profile });
  }
  if (p === "/api/users" && url.searchParams.get("names")) {
    const out = {};
    url.searchParams.get("names").split(",").slice(0, 100).forEach(n => { const u = userByName(n); if (u) out[norm(n)] = userPublic(u); });
    return send(200, { people: out });
  }
  if (p === "/api/verify/start" && req.method === "POST") {
    if (!validEmail(body.email)) return send(400, { error: "That email doesn't look right." });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.users[me].pendingCode = { email: body.email.toLowerCase(), code, expires: Date.now() + 10 * 60e3 };
    billybobSend(body.email.toLowerCase(), code);
    return send(200, { ok: true });
  }
  if (p === "/api/verify/check" && req.method === "POST") {
    const pc = db.users[me].pendingCode;
    if (!pc) return send(400, { error: "No pending verification." });
    if (Date.now() > pc.expires) return send(400, { error: "That code expired — resend." });
    if (String(body.code) !== pc.code) return send(400, { error: "Wrong code." });
    db.users[me].email = pc.email;
    db.users[me].emailVerified = true;
    delete db.users[me].pendingCode;
    saveSoon();
    return send(200, { ok: true, email: pc.email });
  }

  /* ---- friends ---- */
  if (p === "/api/friend/request" && req.method === "POST") {
    let target = norm(body.name);
    if (target === me) return send(400, { error: "You can't friend yourself." });
    let tuser = userByName(target);
    if (!tuser) {
      /* not an exact username — maybe they typed a display name */
      const q = String(body.name || "").trim().toLowerCase();
      const hits = Object.values(db.users).filter(u => String((u.profile && u.profile.displayName) || "").trim().toLowerCase() === q);
      if (hits.length === 1) tuser = hits[0];
      else if (hits.length > 1) return send(400, { error: "Several people use that display name — ask your friend for their @username (it's on their profile)." });
    }
    if (!tuser) return send(400, { error: `No user called "${String(body.name || "").trim().slice(0, 20)}" on this server. Usernames are lowercase (like @qz) — check your friend's profile for their @username, and make sure you both registered on the SAME server address.` });
    target = tuser.name;
    if ((db.friends[me] || []).includes(target)) return send(400, { error: "You're already friends." });
    // if they already asked me, accept
    const theirReqs = (db.requests[me] ||= []);
    const incoming = theirReqs.find(r => r.from === target);
    if (incoming) {
      theirReqs.splice(theirReqs.indexOf(incoming), 1);
      (db.friends[me] ||= []).push(target);
      (db.friends[target] ||= []).push(me);
      saveSoon();
      sendTo(target, { type: "friend_accepted", user: me });
      return send(200, { ok: true, friends: true });
    }
    const myOut = (db.requests[target] ||= []);
    if (myOut.some(r => r.from === me)) return send(400, { error: "Already requested — wait for them to accept." });
    myOut.push({ from: me, ts: Date.now() });
    saveSoon();
    sendTo(target, { type: "friend_request", from: me });
    return send(200, { ok: true });
  }
  if (p === "/api/friend/accept" && req.method === "POST") {
    const from = norm(body.name);
    const reqs = db.requests[me] || [];
    const i = reqs.findIndex(r => r.from === from);
    if (i === -1) return send(400, { error: "No request from that user." });
    reqs.splice(i, 1);
    (db.friends[me] ||= []).push(from);
    (db.friends[from] ||= []).push(me);
    saveSoon();
    sendTo(from, { type: "friend_accepted", user: me });
    return send(200, { ok: true });
  }
  if (p === "/api/friend/decline" && req.method === "POST") {
    const from = norm(body.name);
    const reqs = db.requests[me] || [];
    const i = reqs.findIndex(r => r.from === from);
    if (i === -1) return send(400, { error: "No request from that user." });
    reqs.splice(i, 1);
    saveSoon();
    return send(200, { ok: true });
  }
  if (p === "/api/friend/remove" && req.method === "POST") {
    const who = norm(body.name);
    db.friends[me] = (db.friends[me] || []).filter(n => n !== who);
    db.friends[who] = (db.friends[who] || []).filter(n => n !== me);
    saveSoon();
    return send(200, { ok: true });
  }

  /* ---- servers ---- */
  if (p === "/api/servers" && req.method === "POST") {
    const id = "s" + uid();
    const s = {
      id, name: String(body.name || "New Server").slice(0, 40), emoji: body.emoji || "🌐",
      color: body.color || "#9d6bff", owner: me, members: [me],
      categories: body.categories || [
        { id: "c" + uid(), name: "Text Channels", channels: [{ id: "ch" + uid(), name: "general", type: "text", topic: "Welcome!" }] },
        { id: "c" + uid(), name: "Voice Channels", channels: [{ id: "ch" + uid(), name: "Lounge", type: "voice" }] },
      ],
      ranks: body.ranks || [{ id: "r" + uid(), name: "Owner", color: "#faa61a", members: [me] }, { id: "r" + uid(), name: "Member", color: "#747f8d", members: [] }],
      created: Date.now(),
    };
    db.servers[id] = s;
    saveSoon();
    s.members.forEach(m => sendTo(m, { type: "world" }));
    return send(200, { server: s });
  }
  const srvMatch = p.match(/^\/api\/servers\/([\w-]+)(\/[\w-]+)?$/);
  if (srvMatch) {
    const s = db.servers[srvMatch[1]];
    const sub = srvMatch[2];
    if (!s) return send(404, { error: "Server not found" });
    if (p === "/api/servers/" + s.id + "/settings" && req.method === "POST") {
      if (s.owner !== me) return send(403, { error: "Only the owner can change server settings." });
      if (body.name) s.name = String(body.name).slice(0, 40);
      if (body.emoji) s.emoji = body.emoji;
      if (body.banner) s.banner = body.banner;
      if (Array.isArray(body.ranks)) s.ranks = body.ranks;
      saveSoon();
      s.members.forEach(m => sendTo(m, { type: "world" }));
      return send(200, { server: s });
    }
    if (p === "/api/servers/" + s.id + "/channels" && req.method === "POST") {
      if (s.owner !== me) return send(403, { error: "Only the owner can create channels." });
      const cat = s.categories.find(c => c.id === body.categoryId) || s.categories[0];
      const chan = { id: "ch" + uid(), name: String(body.name || "new-channel").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 30), type: body.type === "voice" ? "voice" : "text", topic: "" };
      cat.channels.push(chan);
      saveSoon();
      s.members.forEach(m => sendTo(m, { type: "world" }));
      return send(200, { channel: chan });
    }
    if (p === "/api/servers/" + s.id + "/invite" && req.method === "POST") {
      if (!s.members.includes(me)) return send(403, { error: "You're not in this server." });
      const code = inviteCode();
      db.invites[code] = { serverId: s.id, by: me, ts: Date.now() };
      saveSoon();
      return send(200, { code });
    }
    if (p === "/api/servers/" + s.id + "/leave" && req.method === "POST") {
      s.members = s.members.filter(m => m !== me);
      saveSoon();
      s.members.forEach(m => sendTo(m, { type: "world" }));
      sendTo(me, { type: "world" });
      return send(200, { ok: true });
    }
    if (p === "/api/servers/" + s.id + "/delete" && req.method === "POST") {
      if (s.owner !== me) return send(403, { error: "Only the owner can delete the server." });
      Object.keys(db.msgs).forEach(k => { if (k.startsWith("s:" + s.id + ":")) delete db.msgs[k]; });
      delete db.servers[s.id];
      saveSoon();
      s.members.forEach(m => sendTo(m, { type: "world" }));
      return send(200, { ok: true });
    }
  }
  if (p === "/api/join" && req.method === "POST") {
    /* accept an exact code (GLB-XXXXXX) or a pasted full invite link */
    const raw = String(body.code || "").trim();
    const fromLink = raw.includes("/join/") ? raw.slice(raw.indexOf("/join/") + 6).split(/[?#]/)[0] : raw;
    const cleaned = fromLink.replace(/\s+/g, "");
    const inv = db.invites[cleaned] || db.invites[cleaned.toUpperCase()] || null;
    if (!inv) return send(400, { error: "That invite code doesn't match any server. Codes look like GLB-7F3K9Q — ask your friend for the exact one." });
    const s = db.servers[inv.serverId];
    if (!s) return send(400, { error: "That server no longer exists." });
    if (!s.members.includes(me)) {
      s.members.push(me);
      saveSoon();
      s.members.forEach(m => sendTo(m, { type: "world" }));
    }
    return send(200, { server: s });
  }

  /* ---- messages ---- */
  if (p === "/api/messages" && req.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return send(400, { error: "key required" });
    return send(200, { msgs: db.msgs[key] || [] });
  }
  if (p === "/api/messages" && req.method === "POST") {
    const key = String(body.key || "");
    let allowed = false;
    if (key.startsWith("s:")) {
      const s = db.servers[key.split(":")[1]];
      allowed = !!(s && s.members.includes(me));
    } else if (key.startsWith("dm:")) {
      const [a, b] = key.slice(3).split("|");
      allowed = a === me || b === me;
    }
    if (!allowed) return send(403, { error: "You can't post there." });
    const atts = Array.isArray(body.attachments) ? body.attachments.slice(0, 4) : [];
    const msg = pushMsg(key, {
      id: uid(), uid: me, ts: Date.now(),
      text: String(body.text || "").slice(0, 4000),
      attachments: atts.map(a => ({ id: uid(), name: String(a.name || "file").slice(0, 80), size: Number(a.size) || 0, kind: a.kind === "image" ? "image" : "file", dataUrl: String(a.dataUrl || "").slice(0, 40 * 1024 * 1024) })),
      replyTo: body.replyTo || undefined,
    });
    broadcast(key, { type: "message", key, msg });
    return send(200, { msg });
  }
  if (p === "/api/report" && req.method === "POST") {
    const key = String(body.key || "").slice(0, 120);
    const msgId = String(body.msgId || "").slice(0, 40);
    const reason = String(body.reason || "other").slice(0, 40);
    const details = String(body.details || "").slice(0, 300);
    const list = db.msgs[key] || [];
    const m = list.find(x => x.id === msgId);
    if (!m) return send(404, { error: "Message not found." });
    (db.reports ||= []).push({
      id: uid(), by: me, key, msgId,
      reason, details,
      author: m.uid, text: String(m.text || "").slice(0, 500),
      ts: Date.now(), open: true,
    });
    if (db.reports.length > 500) db.reports = db.reports.slice(-500);
    saveSoon();
    console.info(`[disglobe] report filed by ${me}: ${reason} — "${String(m.text || "").slice(0, 60)}"`);
    return send(200, { ok: true });
  }
  if (p === "/api/typing" && req.method === "POST") {
    broadcast(String(body.key || ""), { type: "typing", key: body.key, user: me });
    return send(200, { ok: true });
  }

  /* ---- voice: state + WebRTC signaling relay ---- */
  if (p === "/api/voice/state" && req.method === "POST") {
    if (body.leave) {
      delete voiceStates[me];
    } else {
      voiceStates[me] = {
        serverId: String(body.serverId || ""), channelId: String(body.channelId || ""),
        sharing: body.sharing === "screen" || body.sharing === "cam" || body.sharing === "both" ? body.sharing : null,
        quality: String(body.quality || "720:30").slice(0, 10),
        ts: Date.now(),
      };
    }
    voiceBroadcast();
    return send(200, { ok: true, states: voiceStates });
  }
  if (p === "/api/rtc/signal" && req.method === "POST") {
    const to = norm(body.to);
    if (!userByName(to)) return send(400, { error: "Unknown peer." });
    /* payload is opaque WebRTC description/ICE — size-capped */
    const sig = String(body.signal || "").slice(0, 64 * 1024);
    sendToUser(to, { type: "rtc", from: me, signal: JSON.parse(sig) });
    return send(200, { ok: true });
  }

  return send(404, { error: "Not found" });
}

/* ---------------- static client ---------------- */
function serveClient(res) {
  let buf;
  try { buf = fs.readFileSync(path.join(__dirname, "disglobe.html")); }
  catch { buf = Buffer.from("<h1>Disglobe client missing</h1>"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    try { return await handle(req, res); }
    catch (e) {
      console.error("[disglobe] api error:", e);
      try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Server error" })); } catch {}
      return;
    }
  }
  if (req.method === "GET") return serveClient(res);
  res.writeHead(404); res.end();
});

/* WebSocket live layer on the same HTTP server (path /ws?token=...) */
if (WebSocketServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const me = authUser(req);
    if (!me) { try { ws.close(4001, "Not logged in"); } catch {} return; }
    wsConnect(me, ws);
  });
} else {
  console.warn("[disglobe] 'ws' package not installed — live updates disabled (npm i ws)");
}

async function startServer(port) {
  if (pgPool) { try { await pgInit(); } catch (e) { console.error("[disglobe] pg init failed:", e.message); } }
  await loadDb();
  /* cloud hosts (Render/Railway/Fly) assign the port via env; local defaults to 3849.
     A PORT of 0 or unset means "use the normal Disglobe port". */
  const envPort = Number(process.env.PORT);
  const p = (envPort > 0 ? envPort : (Number(port) > 0 ? Number(port) : PORT));
  return new Promise(resolve => {
    server.once("error", err => {
      if (err.code === "EADDRINUSE") {
        /* another Disglobe server is already running on this port — just use it */
        console.log(`[disglobe] port ${p} already serving — reusing the running server`);
        resolve(null);
      } else { console.error("[disglobe] server error:", err); resolve(null); }
    });
    server.listen(p, "0.0.0.0", () => {
      const renderUrl = process.env.RENDER_EXTERNAL_URL;
      console.log(`\n  🌐 Disglobe server online → http://localhost:${p}`);
      console.log(`     Storage → ${pgPool ? "PostgreSQL" : "local JSON (disglobe-data/db.json)"} · Realtime → ${WebSocketServer ? "WebSocket" : "OFF (install ws)"}`);
      if (renderUrl) console.log(`     Public URL → ${renderUrl}  ← share this link; anyone on the internet can register!`);
      else console.log(`     Friends can open that address in any browser to join you.`);
      resolve(server);
    });
  });
}

if (require.main === module) startServer();
module.exports = { startServer };
