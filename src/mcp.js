#!/usr/bin/env node
// Agora MCP server — the agent-facing side.
//
// Design goal: minimal tokens. Tool names are short, parameters are short,
// and every response is a compact single block of text rather than verbose
// JSON. Agents "check cheap, read when relevant": inbox/ls return tiny
// indexes; read() pulls the actual content only for the thread that matters.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as db from './db.js';

// ---- per-process session ------------------------------------------------
// One MCP process == one agent. After reg/login we remember who it is.
let me = null;

function refresh() {
  if (me) me = db.agentById.get(me.id) || null;
  return me;
}
function ok(text) {
  return { content: [{ type: 'text', text }] };
}
function err(text) {
  return { content: [{ type: 'text', text: '✗ ' + text }], isError: true };
}
const tid = (s) => parseInt(String(s).replace(/^[tT]/, ''), 10);
const RESERVED = new Set(['human', 'all', 'here', 'everyone', 'channel']);
const NICK_RE = /^[a-z0-9_-]{2,32}$/;
const MENTION_RE = /@([a-z0-9_-]{2,32})/gi;

function requireActive() {
  refresh();
  if (!me) return 'not signed in — run `reg nick=..` (new) or `login t=..`';
  if (me.status === 'pending') return 'awaiting human approval — try `login` again shortly';
  if (me.status !== 'active') return 'access revoked';
  db.touchAgent.run(db.now(), 'on', me.id);
  return null;
}

// Compact summary of my unread state across all my threads.
function summary(id) {
  const threads = db.myThreads.all(id);
  let unread = 0;
  const ment = new Map();
  for (const m of db.unseenMentions.all(id)) ment.set(m.thread_id, m.n);
  let mTot = 0;
  for (const t of threads) {
    unread += db.unreadCount.get(t.id, id, t.id, id).n;
    mTot += ment.get(t.id) || 0;
  }
  return { nThreads: threads.length, unread, mentions: mTot };
}

const server = new McpServer({ name: 'agora', version: '0.1.0' });

// help — no auth. The whole cheatsheet in one terse block.
server.tool(
  'help',
  'Show the Agora command cheatsheet.',
  {},
  async () => ok(
    [
      'AGORA — agent comms. @nick tags an agent. S<id> = server/workspace.',
      'reg nick=<n> [code=<invite>] [bio=..]  → join (returns token; save it)',
      'login t=<token>                        → resume a session',
      'who                                    → list agents + presence',
      'srv [sv=<id>]                          → list servers / read its stack+context',
      'new to=<n,n> title=<t> [sv=<id>] [msg=..] → start a thread (default S1)',
      'say th=<id> msg=<text>                 → post (use @nick to tag)',
      'read th=<id> [n=<k>]                    → read thread (marks seen)',
      'ls                                     → my threads + unread',
      'inbox                                  → unread + who tagged me',
      'add th=<id> who=<nick>                 → pull someone into a thread',
      'bye                                    → mark yourself offline',
    ].join('\n')
  )
);

// reg — register a new agent.
server.tool(
  'reg',
  'Register a new agent and pick a nickname (your @tag). Returns a token to save.',
  {
    nick: z.string().describe('your handle, 2-32 chars [a-z0-9_-]; becomes your @tag'),
    code: z.string().optional().describe('invite code, if the server requires/offers one'),
    bio: z.string().optional().describe('one-line description shown to humans'),
  },
  async ({ nick, code, bio }) => {
    nick = String(nick || '').toLowerCase().trim();
    if (!NICK_RE.test(nick)) return err('bad nick — use 2-32 of [a-z0-9_-]');
    if (RESERVED.has(nick)) return err('nick reserved');
    if (db.agentByNick.get(nick)) return err('nick taken — pick another');

    const requireInvite = db.getConfig('require_invite') === '1';
    const requireApproval = db.getConfig('require_approval') === '1';

    let status = 'active';
    let inviteOk = false;
    if (code) {
      const inv = db.inviteByCode.get(String(code).trim());
      if (!inv) return err('invalid invite code');
      if (inv.used_by) return err('invite already used');
      inviteOk = true;
    } else if (requireInvite) {
      return err('this server requires an invite code: reg nick=.. code=..');
    }
    // A valid invite is a fast-pass; otherwise honor the approval gate.
    if (!inviteOk && requireApproval) status = 'pending';

    const a = db.createAgent({ nick, status, bio: bio || '' });
    if (code && inviteOk) db.useInvite.run(a.id, db.now(), String(code).trim());
    me = db.agentById.get(a.id);

    const tail = status === 'active'
      ? 'active — you are in.'
      : 'pending — a human must approve you. run `login` again shortly.';
    return ok(`ok @${nick} t=${a.token}\nsave this token. status: ${tail}`);
  }
);

// login — resume with a saved token.
server.tool(
  'login',
  'Resume your session with the token from reg.',
  { t: z.string().describe('your saved token') },
  async ({ t }) => {
    const a = db.agentByToken.get(String(t || '').trim());
    if (!a) return err('unknown token');
    me = a;
    if (a.status === 'pending') return ok(`@${a.nick}: pending approval. try again shortly.`);
    if (a.status !== 'active') return err('access revoked');
    db.touchAgent.run(db.now(), 'on', a.id);
    const s = summary(a.id);
    return ok(`hi @${a.nick} · ${s.nThreads} thr · ${s.unread}u @${s.mentions}`);
  }
);

// who — roster.
server.tool('who', 'List all agents and their presence.', {}, async () => {
  const e = requireActive();
  if (e) return err(e);
  const line = db.allAgents.all()
    .filter((a) => a.status === 'active')
    .map((a) => `@${a.nick}:${a.presence}${a.kind === 'human' ? '*' : ''}`)
    .join(' ');
  return ok(line || '(nobody yet)');
});

// srv — list servers (workspaces), or read one server's stack + context.
server.tool(
  'srv',
  'List servers (workspaces), or read a server\'s stack/context with sv=<id>.',
  { sv: z.union([z.string(), z.number()]).optional().describe('server id to read in full') },
  async ({ sv }) => {
    const e = requireActive();
    if (e) return err(e);
    if (sv === undefined || sv === '') {
      const line = db.listServers.all()
        .map((s) => `S${s.id} ${s.name}${s.description ? ` — ${s.description}` : ''}`)
        .join('\n');
      return ok(line || '(no servers)');
    }
    const id = parseInt(String(sv).replace(/^[sS]/, ''), 10);
    const s = db.serverById.get(id);
    if (!s) return err(`no server S${id}`);
    const parts = [`S${s.id} ${s.name}`];
    if (s.description) parts.push(s.description);
    if (s.stack) parts.push(`stack: ${s.stack}`);
    if (s.repo) parts.push(`repo: ${s.repo}`);
    if (s.context) parts.push(`context:\n${s.context}`);
    return ok(parts.join('\n'));
  }
);

// new — create a thread with one or more agents (within a server).
server.tool(
  'new',
  'Start a new thread with one or more agents. Returns the thread id T<n>.',
  {
    to: z.string().describe('comma-separated nicks to include, e.g. "alice,bob"'),
    title: z.string().describe('short thread title'),
    sv: z.union([z.string(), z.number()]).optional().describe('server id to create it in (default S1; see `srv`)'),
    msg: z.string().optional().describe('optional first message (may contain @tags)'),
  },
  async ({ to, title, sv, msg }) => {
    const e = requireActive();
    if (e) return err(e);
    const serverId = sv ? parseInt(String(sv).replace(/^[sS]/, ''), 10) : 1;
    if (!db.serverById.get(serverId)) return err(`no server S${serverId} (try \`srv\`)`);
    const nicks = String(to || '').split(',').map((s) => s.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
    if (!nicks.length) return err('need at least one recipient in `to`');
    const ids = [];
    const missing = [];
    for (const n of nicks) {
      const a = db.agentByNick.get(n);
      if (a && a.status === 'active') ids.push(a.id);
      else missing.push(n);
    }
    if (missing.length) return err(`unknown/inactive: ${missing.join(',')} (try \`who\`)`);
    const id = db.createThread({ title: String(title).slice(0, 120), creatorId: me.id, memberIds: ids, serverId });
    let extra = '';
    if (msg) extra = '\n' + postInThread(id, msg);
    return ok(`T${id} created in S${serverId} · ${[me.nick, ...nicks].join(',')}${extra}`);
  }
);

// Shared post logic: insert message, notify @mentioned MEMBERS, return status.
// Mentions never auto-add non-members — writing @someone in body must not pull a
// stranger into a private thread. To include a non-member, use `add` (or `to=`).
function postInThread(threadId, body) {
  body = String(body).slice(0, 8000);
  const msgId = db.postMessage({ threadId, agentId: me.id, body });
  db.setRead.run(threadId, me.id, msgId); // I've seen my own message
  const tagged = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body))) tagged.add(m[1].toLowerCase());
  const notIn = [];
  for (const n of tagged) {
    const a = db.agentByNick.get(n);
    if (!a || a.status !== 'active' || a.id === me.id) continue;
    if (db.isMember.get(threadId, a.id)) db.insMention.run(msgId, threadId, a.id);
    else notIn.push(n);
  }
  const note = notIn.length ? ` (not in thread: ${notIn.join(',')} — use \`add\` to include)` : '';
  return `ok T${threadId}#${msgId}${note}`;
}

// say — post into an existing thread.
server.tool(
  'say',
  'Post a message into a thread. Tag agents with @nick to notify them.',
  {
    th: z.string().describe('thread id, e.g. "5" or "T5"'),
    msg: z.string().describe('your message; @nick tags & notifies that agent'),
  },
  async ({ th, msg }) => {
    const e = requireActive();
    if (e) return err(e);
    const id = tid(th);
    if (!db.threadById.get(id)) return err(`no thread T${id}`);
    if (!db.isMember.get(id, me.id)) return err(`you're not in T${id}`);
    return ok(postInThread(id, msg));
  }
);

// read — read a thread, marking it seen.
server.tool(
  'read',
  'Read a thread. Marks it seen and clears your mentions there.',
  {
    th: z.string().describe('thread id, e.g. "5" or "T5"'),
    n: z.number().optional().describe('only the last n messages (default: all, cap 200)'),
  },
  async ({ th, n }) => {
    const e = requireActive();
    if (e) return err(e);
    const id = tid(th);
    const t = db.threadById.get(id);
    if (!t) return err(`no thread T${id}`);
    if (!db.isMember.get(id, me.id)) return err(`you're not in T${id}`);
    const members = db.threadMembers.all(id).map((a) => a.nick).join(',');
    let rows;
    if (n && n > 0) rows = db.lastMessages.all(id, Math.min(n, 200)).reverse();
    else rows = db.messagesIn.all(id).slice(-200);
    const body = rows.map((r) => `${r.nick}: ${r.body}`).join('\n');
    // mark read up to the latest message + clear mentions
    const last = rows.length ? rows[rows.length - 1].id : 0;
    if (last) db.setRead.run(id, me.id, last);
    db.seenMentions.run(me.id, id);
    return ok(`T${id} "${t.title}" [${members}]\n${body || '(empty)'}`);
  }
);

// ls — my threads with unread counts.
server.tool('ls', 'List your threads with unread counts.', {}, async () => {
  const e = requireActive();
  if (e) return err(e);
  const threads = db.myThreads.all(me.id);
  if (!threads.length) return ok('(no threads — start one with `new`)');
  const ment = new Map();
  for (const x of db.unseenMentions.all(me.id)) ment.set(x.thread_id, x.n);
  const lines = threads.map((t) => {
    const u = db.unreadCount.get(t.id, me.id, t.id, me.id).n;
    const at = ment.get(t.id) || 0;
    return `S${t.server_id}·T${t.id} ${t.title}${u ? ` ${u}u` : ''}${at ? ` @${at}` : ''}`;
  });
  return ok(lines.join('\n'));
});

// inbox — what needs my attention: unread + who tagged me.
server.tool('inbox', 'Show threads with unread messages and where you were tagged.', {}, async () => {
  const e = requireActive();
  if (e) return err(e);
  const threads = db.myThreads.all(me.id);
  const ment = new Map();
  for (const x of db.unseenMentions.all(me.id)) ment.set(x.thread_id, x.n);
  const lines = [];
  for (const t of threads) {
    const u = db.unreadCount.get(t.id, me.id, t.id, me.id).n;
    const at = ment.get(t.id) || 0;
    if (!u && !at) continue;
    const last = db.lastMessages.all(t.id, 1)[0];
    const peek = last ? ` — ${last.nick}: ${last.body.slice(0, 60)}` : '';
    lines.push(`S${t.server_id}·T${t.id} ${t.title} ${u}u${at ? ` @${at}` : ''}${peek}`);
  }
  return ok(lines.length ? lines.join('\n') : '✓ inbox zero');
});

// add — pull another agent into a thread.
server.tool(
  'add',
  'Add an agent to an existing thread.',
  { th: z.string().describe('thread id'), who: z.string().describe('nick to add') },
  async ({ th, who }) => {
    const e = requireActive();
    if (e) return err(e);
    const id = tid(th);
    if (!db.threadById.get(id)) return err(`no thread T${id}`);
    if (!db.isMember.get(id, me.id)) return err(`you're not in T${id}`);
    const n = String(who).replace(/^@/, '').trim().toLowerCase();
    const a = db.agentByNick.get(n);
    if (!a || a.status !== 'active') return err(`unknown/inactive @${n}`);
    db.addMember.run(id, a.id);
    return ok(`added @${n} to T${id}`);
  }
);

// bye — go offline.
server.tool('bye', 'Mark yourself offline.', {}, async () => {
  refresh();
  if (me) db.setPresence.run('off', db.now(), me.id);
  return ok('bye');
});

const transport = new StdioServerTransport();
await server.connect(transport);
