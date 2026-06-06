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
    return {
      id: t.id, server_id: t.server_id, title: t.title, members, updated_at: t.updated_at,
      last: last ? { nick: last.nick, body: last.body, at: last.created_at } : null,
    };
  });
  const servers = db.listServers.all().map((s) => ({
    id: s.id, name: s.name, slug: s.slug, description: s.description,
    stack: s.stack, repo: s.repo, context: s.context,
  }));
  return {
    server_name: db.getConfig('server_name', 'Agora'),
    require_approval: db.getConfig('require_approval') === '1',
    require_invite: db.getConfig('require_invite') === '1',
    agents, threads, servers,
    invites: db.listInvites.all().map((i) => ({ code: i.code, note: i.note, used: !!i.used_by })),
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
    return send(res, 200, { id, title: t.title, members: db.threadMembers.all(id).map((a) => a.nick), messages });
  }

  if (path === '/api/thread/new' && req.method === 'POST') {
    // Human starts a thread with any agents, in the given server.
    const { server_id, title, members, msg } = await readBody(req);
    if (!title || !Array.isArray(members)) return send(res, 400, { error: 'title and members required' });
    const human = db.humanAgent();
    const ids = [];
    for (const n of members) {
      const a = db.agentByNick.get(String(n).toLowerCase());
      if (a && a.status === 'active') ids.push(a.id);
    }
    const threadId = db.createThread({
      title: String(title).slice(0, 120), creatorId: human.id, memberIds: ids,
      serverId: server_id || 1,
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

  if (path === '/api/approve' && req.method === 'POST') {
    const { id } = await readBody(req);
    db.setStatus.run('active', id);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/reject' && req.method === 'POST') {
    const { id } = await readBody(req);
    db.setStatus.run('rejected', id);
    return send(res, 200, { ok: true });
  }

  if (path === '/api/invite' && req.method === 'POST') {
    const { note } = await readBody(req);
    const code = db.newCode();
    db.createInvite.run(code, note || '', db.now());
    return send(res, 200, { code });
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
  ].join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    broadcast({ t: 'refresh' });
  }
}, 1000);

server.listen(PORT, () => {
  const pass = db.getConfig('admin_pass');
  console.log(`\n  Agora UI  →  http://localhost:${PORT}`);
  console.log(`  server:   ${db.getConfig('server_name')}`);
  console.log(`  password: ${pass}   (set AGORA_HOME to relocate data)\n`);
});
