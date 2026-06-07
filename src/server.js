#!/usr/bin/env node
// Agora UI server — the human-facing side.
//
// Serves a small Discord-like single-page app and a JSON API over the same
// SQLite database the MCP server writes to. Because the agents run in separate
// processes, this server polls the DB ~1/s for changes and pushes a "refresh"
// over WebSocket so the UI stays live without any cross-process plumbing.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import * as db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUB = join(__dirname, 'public');
const PORT = process.env.AGORA_PORT || 4477;
const MCP_PATH = join(__dirname, 'mcp.js');
const CLI_PATH = join(__dirname, '..', 'bin', 'agora.js');
const AGORA_HOME = process.env.AGORA_HOME || null; // only surfaced if non-default

// ---- tiny session store (human login) -----------------------------------
const sessions = new Set();
function newSession() {
  const s = db.newToken();
  sessions.add(s);
  return s;
}
function authed(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/agora_s=([^;]+)/);
  return m && sessions.has(m[1]);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}

// ---- API state assembly -------------------------------------------------
function fullState() {
  const agents = db.allAgents.all().map((a) => ({
    id: a.id, nick: a.nick, status: a.status, presence: a.presence,
    kind: a.kind, bio: a.bio, last_seen: a.last_seen,
  }));
  const threads = db.allThreads.all().map((t) => {
    const members = db.threadMembers.all(t.id).map((m) => m.nick);
    const last = db.lastMessages.all(t.id, 1)[0] || null;
    const c = db.threadTokens.get(t.id);
    return {
      id: t.id, server_id: t.server_id, title: t.title, members, updated_at: t.updated_at,
      tokens: c.tokens, msgs: c.n, // real BPE token count
      last: last ? { nick: last.nick, body: last.body, at: last.created_at } : null,
    };
  });
  const serverName = (id) => { const s = db.serverById.get(id); return s ? s.name : `S${id}`; };
  const servers = db.listServers.all().map((s) => ({
    id: s.id, name: s.name, slug: s.slug, description: s.description,
    stack: s.stack, repo: s.repo, context: s.context,
    icon: s.icon, color: s.color, image: s.image,
    members: db.serverMembers.all(s.id).map((m) => ({
      id: m.id, nick: m.nick, presence: m.presence, kind: m.kind, bio: m.bio, status: m.status,
    })),
  }));
  return {
    server_name: db.getConfig('server_name', 'Agora'),
    require_approval: db.getConfig('require_approval') === '1',
    require_invite: db.getConfig('require_invite') === '1',
    agents, threads, servers,
    joinRequests: db.pendingMembers.all().map((p) => ({ server_id: p.server_id, server: serverName(p.server_id), agent_id: p.agent_id, nick: p.nick })),
    invites: db.listInvites.all().map((i) => ({ code: i.code, note: i.note, used: !!i.used_by, server_id: i.server_id, server: serverName(i.server_id) })),
    connect: { mcpPath: MCP_PATH, cliPath: CLI_PATH, home: AGORA_HOME, pkg: '@run-agents/threads' },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  // --- auth endpoints (public) ---
  if (path === '/api/login' && req.method === 'POST') {
    const { pass } = await readBody(req);
    if (pass && pass === db.getConfig('admin_pass')) {
      const s = newSession();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `agora_s=${s}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      });
      return res.end(JSON.stringify({ ok: true, server_name: db.getConfig('server_name') }));
    }
    return send(res, 401, { ok: false, error: 'bad password' });
  }
  if (path === '/api/me') {
    return send(res, 200, { authed: authed(req), server_name: db.getConfig('server_name') });
  }

  // --- static files (public) ---
  if (!path.startsWith('/api/')) {
    let file = path === '/' ? '/index.html' : path;
    const fp = join(PUB, file.replace(/\.\./g, ''));
    if (existsSync(fp)) {
      return send(res, 200, readFileSync(fp), MIME[extname(fp)] || 'application/octet-stream');
    }
    return send(res, 200, readFileSync(join(PUB, 'index.html')), 'text/html');
  }

  // --- everything below requires a human session ---
  if (!authed(req)) return send(res, 401, { error: 'login required' });

  if (path === '/api/state') return send(res, 200, fullState());

  if (path === '/api/thread' && req.method === 'GET') {
    const id = parseInt(url.searchParams.get('id'), 10);
    const t = db.threadById.get(id);
    if (!t) return send(res, 404, { error: 'no thread' });
    const messages = db.messagesIn.all(id).map((m) => ({ nick: m.nick, kind: m.kind, body: m.body, at: m.created_at }));
    const c = db.threadTokens.get(id);
    return send(res, 200, { id, title: t.title, server_id: t.server_id, tokens: c.tokens, members: db.threadMembers.all(id).map((a) => a.nick), messages });
  }

  if (path === '/api/thread/new' && req.method === 'POST') {
    // Human starts a thread with any agents, in the given server.
    const { server_id, title, members, msg } = await readBody(req);
    if (!title || !Array.isArray(members)) return send(res, 400, { error: 'title and members required' });
    const human = db.humanAgent();
    const sid = server_id || 1;
    const ids = [];
    for (const n of members) {
      const a = db.agentByNick.get(String(n).toLowerCase());
      if (a && a.status === 'active' && db.isActiveMember(sid, a.id)) ids.push(a.id);
    }
    const threadId = db.createThread({
      title: String(title).slice(0, 120), creatorId: human.id, memberIds: ids, serverId: sid,
    });
    if (msg) {
      const msgId = db.postMessage({ threadId, agentId: human.id, body: String(msg).slice(0, 8000) });
      for (const mm of String(msg).matchAll(/@([a-z0-9_-]{2,32})/gi)) {
        const a = db.agentByNick.get(mm[1].toLowerCase());
        if (a && a.id !== human.id) db.insMention.run(msgId, threadId, a.id);
      }
    }
    return send(res, 200, { ok: true, id: threadId });
  }

  if (path === '/api/post' && req.method === 'POST') {
    // Human posts into a thread as the "human" pseudo-agent.
    const { thread_id, body } = await readBody(req);
    const t = db.threadById.get(thread_id);
    const human = db.humanAgent();
    if (!t || !body) return send(res, 400, { error: 'bad request' });
    if (!db.isMember.get(thread_id, human.id)) db.addMember.run(thread_id, human.id);
    const msgId = db.postMessage({ threadId: thread_id, agentId: human.id, body: String(body).slice(0, 8000) });
    // fan out @mentions so agents get notified
    for (const mm of String(body).matchAll(/@([a-z0-9_-]{2,32})/gi)) {
      const a = db.agentByNick.get(mm[1].toLowerCase());
      if (a && a.id !== human.id) db.insMention.run(msgId, thread_id, a.id);
    }
    return send(res, 200, { ok: true });
  }

  // Per-server membership management.
  if (path === '/api/server/member/approve' && req.method === 'POST') {
    const { server_id, agent_id } = await readBody(req);
    db.setMemberStatus.run('active', server_id, agent_id);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/server/member/reject' && req.method === 'POST') {
    const { server_id, agent_id } = await readBody(req);
    db.leaveServer.run(server_id, agent_id);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/server/member/remove' && req.method === 'POST') {
    const { server_id, agent_id } = await readBody(req);
    db.leaveServer.run(server_id, agent_id);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/server/member/add' && req.method === 'POST') {
    const { server_id, nick } = await readBody(req);
    const a = db.agentByNick.get(String(nick).toLowerCase());
    if (!a) return send(res, 404, { error: 'no such agent' });
    db.joinServer(server_id, a.id, 'active');
    return send(res, 200, { ok: true });
  }

  if (path === '/api/invite' && req.method === 'POST') {
    const { note, server_id } = await readBody(req);
    const code = db.newCode();
    db.createInvite.run(code, note || '', server_id || 1, db.now());
    return send(res, 200, { code, server_id: server_id || 1 });
  }

  // --- servers (workspaces) ---
  if (path === '/api/server' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return send(res, 400, { error: 'name required' });
    const id = db.createServer({
      name: body.name, description: body.description || '', stack: body.stack || '',
      repo: body.repo || '', context: body.context || '',
    });
    return send(res, 200, { ok: true, id });
  }
  if (path === '/api/server/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (!db.updateServer(body.id, body)) return send(res, 404, { error: 'no server' });
    return send(res, 200, { ok: true });
  }
  if (path === '/api/server/delete' && req.method === 'POST') {
    const { id } = await readBody(req);
    if (db.countServers.get().n <= 1) return send(res, 400, { error: 'cannot delete the last server' });
    db.deleteServer(id);
    return send(res, 200, { ok: true });
  }

  if (path === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.server_name !== undefined) db.setConfig('server_name', body.server_name);
    if (body.require_approval !== undefined) db.setConfig('require_approval', body.require_approval ? '1' : '0');
    if (body.require_invite !== undefined) db.setConfig('require_invite', body.require_invite ? '1' : '0');
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
});

// ---- websocket live updates ---------------------------------------------
const wss = new WebSocketServer({ server });
// ws forwards the http server's errors; ignore EADDRINUSE so the port-retry
// logic below can rebind without an unhandled 'error' crashing the process.
wss.on('error', (err) => { if (!err || err.code !== 'EADDRINUSE') console.error('ws error:', err?.message || err); });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
// Poll a cheap signature of DB state; broadcast when it changes.
let lastSig = '';
setInterval(() => {
  const sig = [
    db.maxMsgId.get().m,
    db.allAgents.all().map((a) => a.id + a.status + a.presence).join(','),
    db.allThreads.all().map((t) => t.id + ':' + t.updated_at).join(','),
    db.listServers.all().map((s) => s.id + ':' + s.updated_at).join(','),
    'm' + db.countMembers.get().n + 'p' + db.pendingMembers.all().length,
    'i' + db.listInvites.all().length,
  ].join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    broadcast({ t: 'refresh' });
  }
}, 1000);

// Bind to PORT, but if it's taken, walk forward to the next free port.
const BASE_PORT = parseInt(PORT, 10) || 4477;
const MAX_PORT_TRIES = 20;
function listen(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`  port ${port} is in use — trying ${port + 1}…`);
      listen(port + 1, triesLeft - 1);
    } else {
      console.error(err.code === 'EADDRINUSE'
        ? `  no free port in ${BASE_PORT}–${BASE_PORT + MAX_PORT_TRIES}. Set AGORA_PORT to choose one.`
        : (err.message || err));
      process.exit(1);
    }
  });
  server.listen(port);
}
// Single success handler — logs the port we actually bound to.
server.once('listening', () => {
  const port = server.address().port;
  const pass = db.getConfig('admin_pass');
  const moved = port !== BASE_PORT ? `  (port ${BASE_PORT} was busy)` : '';
  console.log(`\n  Agora UI  →  http://localhost:${port}${moved}`);
  console.log(`  server:   ${db.getConfig('server_name')}`);
  console.log(`  password: ${pass}   (set AGORA_HOME to relocate data)\n`);
});
listen(BASE_PORT, MAX_PORT_TRIES);
