// Shared SQLite data layer for Agora.
// Both the MCP server (agent-facing) and the UI server (human-facing) open the
// same database file, so state is consistent across every local process.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encode } from 'gpt-tokenizer';

// Real token count of a string (BPE, o200k_base). Used to track per-thread cost.
export const countTokens = (s) => encode(String(s || '')).length;

const HOME = process.env.AGORA_HOME || join(homedir(), '.agora');
mkdirSync(HOME, { recursive: true });
export const DB_PATH = process.env.AGORA_DB || join(HOME, 'agora.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nick       TEXT UNIQUE NOT NULL,
  token      TEXT UNIQUE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | active | rejected
  presence   TEXT NOT NULL DEFAULT 'off',        -- on | off | away
  kind       TEXT NOT NULL DEFAULT 'agent',      -- agent | human
  bio        TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT DEFAULT '',
  server_id  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  used_by    INTEGER,
  used_at    INTEGER
);
-- Per-server membership: which servers an agent may access. status: active|pending.
CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL,
  agent_id  INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active',
  joined_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, agent_id)
);
CREATE TABLE IF NOT EXISTS servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT,
  description TEXT DEFAULT '',   -- one-liner shown in the UI
  stack       TEXT DEFAULT '',   -- tech stack for the effort
  repo        TEXT DEFAULT '',   -- repo / links
  context     TEXT DEFAULT '',   -- freeform context agents can read
  icon        TEXT DEFAULT '',   -- emoji shown on the rail (overrides initials)
  color       TEXT DEFAULT '',   -- accent color (hex), used for the rail badge
  image       TEXT DEFAULT '',   -- optional uploaded image (data URL), overrides icon
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  INTEGER NOT NULL DEFAULT 1,
  title      TEXT NOT NULL,
  creator_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  thread_id INTEGER NOT NULL,
  agent_id  INTEGER NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL,
  agent_id   INTEGER NOT NULL,
  body       TEXT NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  message_id INTEGER NOT NULL,
  thread_id  INTEGER NOT NULL,
  agent_id   INTEGER NOT NULL,   -- who was tagged
  seen       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, agent_id)
);
CREATE TABLE IF NOT EXISTS reads (
  thread_id    INTEGER NOT NULL,
  agent_id     INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_mem_agent  ON members(agent_id);
CREATE INDEX IF NOT EXISTS idx_thr_server ON threads(server_id);
`);

// Migration for DBs created before multi-server support: add threads.server_id.
try { db.exec('ALTER TABLE threads ADD COLUMN server_id INTEGER NOT NULL DEFAULT 1'); } catch { /* already present */ }
// Migration for DBs created before per-server invites.
try { db.exec('ALTER TABLE invites ADD COLUMN server_id INTEGER NOT NULL DEFAULT 1'); } catch { /* already present */ }
// Migration for server customization (icon / color / image).
for (const col of ['icon', 'color', 'image']) {
  try { db.exec(`ALTER TABLE servers ADD COLUMN ${col} TEXT DEFAULT ''`); } catch { /* already present */ }
}
// Migration for real per-message token counts.
try { db.exec('ALTER TABLE messages ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }

export const now = () => Date.now();
export const newToken = () => randomBytes(18).toString('base64url');
export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'srv';
export const newCode = () => randomBytes(4).toString('hex');

// ---- config -------------------------------------------------------------
const cfgGet = db.prepare('SELECT value FROM config WHERE key=?');
const cfgSet = db.prepare(
  'INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
);
export function getConfig(key, fallback = null) {
  const r = cfgGet.get(key);
  return r ? r.value : fallback;
}
export function setConfig(key, value) {
  cfgSet.run(key, String(value));
}

// Seed defaults + a "human" pseudo-agent the human posts as from the UI.
function seed() {
  if (getConfig('server_name') === null) setConfig('server_name', 'Agora');
  if (getConfig('require_approval') === null) setConfig('require_approval', '1');
  if (getConfig('require_invite') === null) setConfig('require_invite', '0');
  if (getConfig('admin_pass') === null) {
    setConfig('admin_pass', randomBytes(6).toString('hex'));
  }
  const human = db.prepare('SELECT id FROM agents WHERE nick=?').get('human');
  if (!human) {
    db.prepare(
      `INSERT INTO agents(nick,token,status,presence,kind,bio,created_at)
       VALUES('human',?,?,?,?,?,?)`
    ).run(newToken(), 'active', 'on', 'human', 'The human operator', now());
  }
}
seed();

// ---- agents -------------------------------------------------------------
export const agentByToken = db.prepare('SELECT * FROM agents WHERE token=?');
export const agentByNick = db.prepare('SELECT * FROM agents WHERE nick=? COLLATE NOCASE');
export const agentById = db.prepare('SELECT * FROM agents WHERE id=?');
export const allAgents = db.prepare('SELECT * FROM agents ORDER BY nick');
export const humanAgent = () => agentByNick.get('human');

const insAgent = db.prepare(
  `INSERT INTO agents(nick,token,status,presence,bio,created_at,last_seen)
   VALUES(?,?,?,?,?,?,?)`
);
export function createAgent({ nick, status, bio = '' }) {
  const token = newToken();
  const t = now();
  const info = insAgent.run(nick, token, status, 'on', bio, t, t);
  return { id: Number(info.lastInsertRowid), nick, token, status };
}

export const setPresence = db.prepare('UPDATE agents SET presence=?, last_seen=? WHERE id=?');
export const setStatus = db.prepare('UPDATE agents SET status=? WHERE id=?');
export const touchAgent = db.prepare('UPDATE agents SET last_seen=?, presence=? WHERE id=?');

// ---- invites (per-server) -----------------------------------------------
export const createInvite = db.prepare(
  'INSERT INTO invites(code,note,server_id,created_at) VALUES(?,?,?,?)'
);
export const inviteByCode = db.prepare('SELECT * FROM invites WHERE code=?');
export const useInvite = db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE code=?');
export const listInvites = db.prepare('SELECT * FROM invites ORDER BY created_at DESC');

// ---- per-server membership ----------------------------------------------
const insSM = db.prepare(
  `INSERT INTO server_members(server_id,agent_id,status,joined_at) VALUES(?,?,?,?)
   ON CONFLICT(server_id,agent_id) DO UPDATE SET status=excluded.status`
);
export function joinServer(serverId, agentId, status = 'active') {
  insSM.run(serverId, agentId, status, now());
}
export const memberStatus = db.prepare(
  'SELECT status FROM server_members WHERE server_id=? AND agent_id=?'
);
export const isActiveMember = (serverId, agentId) => {
  const r = memberStatus.get(serverId, agentId);
  return r && r.status === 'active';
};
export const leaveServer = db.prepare('DELETE FROM server_members WHERE server_id=? AND agent_id=?');
export const setMemberStatus = db.prepare(
  'UPDATE server_members SET status=? WHERE server_id=? AND agent_id=?'
);
// Active members of a server (with agent details).
export const serverMembers = db.prepare(
  `SELECT a.id, a.nick, a.presence, a.kind, a.bio, sm.status
   FROM server_members sm JOIN agents a ON a.id=sm.agent_id
   WHERE sm.server_id=? ORDER BY a.nick`
);
// Servers an agent is an ACTIVE member of.
export const myServers = db.prepare(
  `SELECT s.* FROM server_members sm JOIN servers s ON s.id=sm.server_id
   WHERE sm.agent_id=? AND sm.status='active' ORDER BY s.id`
);
// Pending join requests (optionally for one server).
export const pendingMembers = db.prepare(
  `SELECT sm.server_id, a.id AS agent_id, a.nick
   FROM server_members sm JOIN agents a ON a.id=sm.agent_id
   WHERE sm.status='pending' ORDER BY sm.joined_at`
);
// Agents that share at least one active server with me (the people I can talk to).
export const coMembers = db.prepare(
  `SELECT DISTINCT a.* FROM agents a
   JOIN server_members m1 ON m1.agent_id=a.id AND m1.status='active'
   WHERE m1.server_id IN (
     SELECT server_id FROM server_members WHERE agent_id=? AND status='active'
   ) AND a.status='active' ORDER BY a.nick`
);
export const countMembers = db.prepare('SELECT COUNT(*) AS n FROM server_members');

// ---- servers (workspaces) ----------------------------------------------
const insServer = db.prepare(
  `INSERT INTO servers(name,slug,description,stack,repo,context,icon,color,image,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`
);
export function createServer({ name, description = '', stack = '', repo = '', context = '', icon = '', color = '', image = '' }) {
  const t = now();
  const info = insServer.run(name, slugify(name), description, stack, repo, context, icon, color, image, t, t);
  const id = Number(info.lastInsertRowid);
  const human = humanAgent();
  if (human) joinServer(id, human.id, 'active'); // operator is in every server
  return id;
}
export const listServers = db.prepare('SELECT * FROM servers ORDER BY id');
export const serverById = db.prepare('SELECT * FROM servers WHERE id=?');
export const countServers = db.prepare('SELECT COUNT(*) AS n FROM servers');
const updServer = db.prepare(
  `UPDATE servers SET name=?, slug=?, description=?, stack=?, repo=?, context=?, icon=?, color=?, image=?, updated_at=? WHERE id=?`
);
export function updateServer(id, f) {
  const s = serverById.get(id);
  if (!s) return false;
  const name = f.name ?? s.name;
  updServer.run(
    name, slugify(name), f.description ?? s.description, f.stack ?? s.stack,
    f.repo ?? s.repo, f.context ?? s.context, f.icon ?? s.icon, f.color ?? s.color,
    f.image ?? s.image, now(), id
  );
  return true;
}
export function deleteServer(id) {
  const ths = db.prepare('SELECT id FROM threads WHERE server_id=?').all(id);
  const delMsg = db.prepare('DELETE FROM messages WHERE thread_id=?');
  const delMem = db.prepare('DELETE FROM members WHERE thread_id=?');
  const delMen = db.prepare('DELETE FROM mentions WHERE thread_id=?');
  const delRd = db.prepare('DELETE FROM reads WHERE thread_id=?');
  for (const th of ths) { delMsg.run(th.id); delMem.run(th.id); delMen.run(th.id); delRd.run(th.id); }
  db.prepare('DELETE FROM threads WHERE server_id=?').run(id);
  db.prepare('DELETE FROM servers WHERE id=?').run(id);
}
// Seed a default server (id 1) once, named from the legacy server_name config.
function seedServers() {
  if (countServers.get().n === 0) {
    createServer({ name: getConfig('server_name') || 'Agora', description: 'Default workspace' });
  }
}
seedServers();

// Backfill memberships for DBs that predate per-server access: the human joins
// every server; every existing active agent joins the default server (1).
function seedMembers() {
  if (countMembers.get().n > 0) return;
  const human = humanAgent();
  for (const s of listServers.all()) if (human) joinServer(s.id, human.id, 'active');
  for (const a of allAgents.all()) {
    if (a.status === 'active' && a.kind !== 'human') joinServer(1, a.id, 'active');
  }
}
seedMembers();

// ---- threads & members --------------------------------------------------
const insThread = db.prepare(
  'INSERT INTO threads(server_id,title,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)'
);
const insMember = db.prepare(
  'INSERT OR IGNORE INTO members(thread_id,agent_id) VALUES(?,?)'
);
export function createThread({ title, creatorId, memberIds, serverId = 1 }) {
  const t = now();
  const info = insThread.run(serverId, title, creatorId, t, t);
  const id = Number(info.lastInsertRowid);
  const ids = new Set([creatorId, ...memberIds]);
  for (const m of ids) insMember.run(id, m);
  return id;
}
export const threadsByServer = db.prepare(
  'SELECT * FROM threads WHERE server_id=? ORDER BY updated_at DESC'
);
export const threadById = db.prepare('SELECT * FROM threads WHERE id=?');
export const threadMembers = db.prepare(
  `SELECT a.* FROM members m JOIN agents a ON a.id=m.agent_id
   WHERE m.thread_id=? ORDER BY a.nick`
);
export const isMember = db.prepare('SELECT 1 FROM members WHERE thread_id=? AND agent_id=?');
export const touchThread = db.prepare('UPDATE threads SET updated_at=? WHERE id=?');
export const addMember = insMember;

// All threads an agent belongs to, newest activity first.
export const myThreads = db.prepare(
  `SELECT t.* FROM threads t JOIN members m ON m.thread_id=t.id
   WHERE m.agent_id=? ORDER BY t.updated_at DESC`
);
export const allThreads = db.prepare('SELECT * FROM threads ORDER BY updated_at DESC');

// ---- messages -----------------------------------------------------------
const insMsg = db.prepare(
  'INSERT INTO messages(thread_id,agent_id,body,tokens,created_at) VALUES(?,?,?,?,?)'
);
export function postMessage({ threadId, agentId, body }) {
  const t = now();
  const info = insMsg.run(threadId, agentId, body, countTokens(body), t);
  touchThread.run(t, threadId);
  return Number(info.lastInsertRowid);
}
export const messagesIn = db.prepare(
  `SELECT msg.id, msg.body, msg.created_at, a.nick, a.kind
   FROM messages msg JOIN agents a ON a.id=msg.agent_id
   WHERE msg.thread_id=? ORDER BY msg.id`
);
export const lastMessages = db.prepare(
  `SELECT msg.id, msg.body, msg.created_at, a.nick, a.kind
   FROM messages msg JOIN agents a ON a.id=msg.agent_id
   WHERE msg.thread_id=? ORDER BY msg.id DESC LIMIT ?`
);
export const maxMsgId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages');
// Real token cost per thread: sum of per-message token counts (see countTokens).
export const threadTokens = db.prepare(
  'SELECT COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS n FROM messages WHERE thread_id=?'
);

// One-time backfill: tokenize any messages stored before token tracking existed.
const _setMsgTokens = db.prepare('UPDATE messages SET tokens=? WHERE id=?');
const _untokenized = db.prepare("SELECT id, body FROM messages WHERE tokens=0 AND body<>''").all();
if (_untokenized.length) {
  db.exec('BEGIN');
  for (const m of _untokenized) _setMsgTokens.run(countTokens(m.body), m.id);
  db.exec('COMMIT');
}

// ---- mentions -----------------------------------------------------------
export const insMention = db.prepare(
  'INSERT OR IGNORE INTO mentions(message_id,thread_id,agent_id) VALUES(?,?,?)'
);
export const unseenMentions = db.prepare(
  `SELECT mn.thread_id, COUNT(*) AS n FROM mentions mn
   WHERE mn.agent_id=? AND mn.seen=0 GROUP BY mn.thread_id`
);
export const seenMentions = db.prepare(
  'UPDATE mentions SET seen=1 WHERE agent_id=? AND thread_id=?'
);

// ---- reads / unread -----------------------------------------------------
export const setRead = db.prepare(
  `INSERT INTO reads(thread_id,agent_id,last_read_id) VALUES(?,?,?)
   ON CONFLICT(thread_id,agent_id) DO UPDATE SET last_read_id=excluded.last_read_id`
);
export const getRead = db.prepare(
  'SELECT last_read_id FROM reads WHERE thread_id=? AND agent_id=?'
);
// Unread = messages newer than last_read, not authored by me.
export const unreadCount = db.prepare(
  `SELECT COUNT(*) AS n FROM messages
   WHERE thread_id=? AND agent_id<>?
     AND id > COALESCE((SELECT last_read_id FROM reads WHERE thread_id=? AND agent_id=?),0)`
);

export default db;
