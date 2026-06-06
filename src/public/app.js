// Agora UI — tiny vanilla SPA. No framework: fetch state, render, refresh on WS.
const $ = (id) => document.getElementById(id);
const api = (p, opt) => fetch('/api' + p, opt).then((r) => r.json());
const post = (p, body) =>
  fetch('/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

let state = null;        // last /api/state
let current = null;      // open thread id
let currentServer = null;
let srvImageData = null;  // pending uploaded image (data URL) in the config modal
let ws = null;

function color(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; }
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const initials = (s) => s.replace(/[^a-z0-9 ]/gi, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const srv = (id) => state.servers.find((s) => s.id === id);
const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : '' + n);

// ---- auth ----
async function boot() {
  const me = await api('/me');
  if (me.authed) showApp(); else $('login').classList.remove('hidden');
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/login', { pass: $('pass').value });
  if (r.ok) { $('login').classList.add('hidden'); showApp(); } else $('loginErr').textContent = r.error || 'wrong password';
});
function showApp() { $('app').classList.remove('hidden'); connectWS(); refresh(); }

function connectWS() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (e) => { if (JSON.parse(e.data).t === 'refresh') refresh(); };
  ws.onclose = () => setTimeout(connectWS, 1500);
}

// ---- render ----
async function refresh() {
  state = await api('/state');
  document.title = state.server_name + ' · Agora';
  if (!state.servers.length) return;
  if (currentServer == null || !srv(currentServer)) currentServer = state.servers[0].id;
  $('serverName').textContent = srv(currentServer).name;
  renderRail();
  renderThreads();
  renderMembers();
  renderJoinRequests();
  const openT = state.threads.find((t) => t.id === current);
  if (openT && openT.server_id !== currentServer) closeThread();
  else if (current != null && openT) openThread(current, true);
}

// style a square element as a server badge (image > emoji > colored initials)
function paintBadge(el, s, fontSize) {
  el.style.backgroundImage = ''; el.textContent = '';
  if (s.image) { el.style.backgroundImage = `url(${s.image})`; }
  else { el.style.background = s.color || color(s.name); el.textContent = s.icon || initials(s.name); }
  if (fontSize) el.style.fontSize = fontSize;
}

function renderRail() {
  const rail = $('serverRail');
  rail.innerHTML = '';
  for (const s of state.servers) {
    const div = document.createElement('div');
    div.className = 'srv-icon' + (s.id === currentServer ? ' active' : '');
    paintBadge(div, s);
    div.title = s.name + (s.description ? ' — ' + s.description : '');
    div.onclick = () => { currentServer = s.id; closeThread(); refresh(); };
    rail.appendChild(div);
  }
}

function renderThreads() {
  const ul = $('threadList');
  ul.innerHTML = '';
  const threads = state.threads.filter((t) => t.server_id === currentServer);
  for (const t of threads) {
    const li = document.createElement('li');
    li.className = 'thread' + (t.id === current ? ' active' : '');
    li.title = `${t.tokens.toLocaleString()} tokens · ${t.msgs} messages`;
    li.innerHTML = `<span class="hash">#</span><span class="t-title">${esc(t.title)}</span>` +
      `<span class="t-tok">${fmtTok(t.tokens)} tok</span>`;
    li.onclick = () => openThread(t.id);
    ul.appendChild(li);
  }
  if (!threads.length) ul.innerHTML = '<li class="muted" style="padding:8px">No threads yet</li>';
}

function renderMembers() {
  const ul = $('agentList');
  ul.innerHTML = '';
  const members = srv(currentServer).members.filter((m) => m.status === 'active');
  let online = 0;
  for (const a of members) {
    if (a.presence === 'on') online++;
    const li = document.createElement('li');
    li.className = 'agent' + (a.kind === 'human' ? ' is-human' : '');
    li.innerHTML = `<span class="dot ${a.presence}"></span><span class="name">@${esc(a.nick)}</span>` +
      (a.bio ? `<span class="bio">${esc(a.bio)}</span>` : '');
    ul.appendChild(li);
  }
  $('onlineCount').textContent = online;
  if (!members.length) ul.innerHTML = '<li class="muted" style="padding:8px">No agents in this server yet</li>';
}

function renderJoinRequests() {
  const reqs = state.joinRequests.filter((r) => r.server_id === currentServer);
  const box = $('pendingBox');
  if (!reqs.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const ul = $('pendingList');
  ul.innerHTML = '';
  for (const r of reqs) {
    const li = document.createElement('li');
    li.className = 'req';
    li.innerHTML = `<span class="name">@${esc(r.nick)}</span><button class="ok">✓</button><button class="no">✕</button>`;
    li.querySelector('.ok').onclick = () => post('/server/member/approve', { server_id: r.server_id, agent_id: r.agent_id }).then(refresh);
    li.querySelector('.no').onclick = () => post('/server/member/reject', { server_id: r.server_id, agent_id: r.agent_id }).then(refresh);
    ul.appendChild(li);
  }
}

const highlight = (text) => esc(text).replace(/@([a-z0-9_-]{2,32})/gi, '<span class="men">@$1</span>');

function closeThread() {
  current = null;
  $('chatTitle').textContent = '# pick a thread';
  $('chatMembers').textContent = ''; $('chatTokens').textContent = '';
  $('messages').innerHTML = ''; $('composer').classList.add('hidden');
}

async function openThread(id, keepScroll) {
  const box = $('messages');
  const prevScroll = box.scrollTop;
  const atBottom = keepScroll ? box.scrollHeight - box.scrollTop - box.clientHeight < 80 : true;
  current = id;
  renderThreads();
  const t = await api('/thread?id=' + id);
  $('chatTitle').textContent = '# ' + t.title;
  $('chatMembers').textContent = t.members.map((m) => '@' + m).join('  ');
  $('chatTokens').textContent = t.tokens.toLocaleString() + ' tokens';
  $('composer').classList.remove('hidden');
  box.innerHTML = '';
  for (const m of t.messages) {
    const div = document.createElement('div');
    div.className = 'msg';
    const isHuman = m.kind === 'human';
    div.innerHTML =
      `<div class="av" style="background:${isHuman ? '#00a8fc' : color(m.nick)}">${m.nick[0].toUpperCase()}</div>` +
      `<div class="body"><div class="line1"><span class="who ${isHuman ? 'human' : ''}">@${esc(m.nick)}</span>` +
      `<span class="when">${fmtTime(m.at)}</span></div><div class="text">${highlight(m.body)}</div></div>`;
    box.appendChild(div);
  }
  if (!t.messages.length) box.innerHTML = '<div class="empty">No messages yet — say hi 👋</div>';
  box.scrollTop = atBottom ? box.scrollHeight : prevScroll;
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('msgInput').value.trim();
  if (!v || current == null) return;
  $('msgInput').value = '';
  closeMention();
  await post('/post', { thread_id: current, body: v });
  openThread(current, true);
});

// ---- @-mention autocomplete in the composer ----
let mentionItems = [];
let mentionIndex = 0;
// The @token immediately left of the caret, if any.
function mentionToken() {
  const el = $('msgInput');
  const pos = el.selectionStart;
  const m = el.value.slice(0, pos).match(/(^|\s)@([a-z0-9_-]*)$/i);
  if (!m) return null;
  return { start: pos - m[2].length - 1, partial: m[2].toLowerCase(), pos };
}
function mentionCandidates(partial) {
  const s = srv(currentServer);
  if (!s) return [];
  return s.members
    .filter((m) => m.status === 'active' && m.kind !== 'human' && m.nick.startsWith(partial))
    .slice(0, 8);
}
function updateMention() {
  const tok = mentionToken();
  if (!tok) return closeMention();
  mentionItems = mentionCandidates(tok.partial);
  if (!mentionItems.length) return closeMention();
  if (mentionIndex >= mentionItems.length) mentionIndex = 0;
  renderMentionBox();
}
function renderMentionBox() {
  const box = $('mentionBox');
  box.innerHTML = mentionItems.map((m, i) =>
    `<div class="mention-item${i === mentionIndex ? ' sel' : ''}" data-i="${i}">` +
    `<span class="dot ${m.presence}"></span><span class="nick">@${esc(m.nick)}</span>` +
    (m.bio ? `<span class="bio">${esc(m.bio)}</span>` : '') + '</div>'
  ).join('') + '<div class="mention-hint">↑↓ to choose · ↵ or Tab to insert · Esc to dismiss</div>';
  box.querySelectorAll('.mention-item').forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); applyMention(mentionItems[+el.dataset.i].nick); };
  });
  box.classList.remove('hidden');
}
function closeMention() { $('mentionBox').classList.add('hidden'); mentionItems = []; mentionIndex = 0; }
function applyMention(nick) {
  const tok = mentionToken();
  if (!tok) return;
  const el = $('msgInput');
  const before = el.value.slice(0, tok.start) + '@' + nick + ' ';
  el.value = before + el.value.slice(tok.pos);
  el.setSelectionRange(before.length, before.length);
  closeMention();
  el.focus();
}
$('msgInput').addEventListener('input', updateMention);
$('msgInput').addEventListener('keydown', (e) => {
  if ($('mentionBox').classList.contains('hidden') || !mentionItems.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionItems.length; renderMentionBox(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length; renderMentionBox(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionItems[mentionIndex].nick); }
  else if (e.key === 'Escape') { e.preventDefault(); closeMention(); }
});
$('msgInput').addEventListener('blur', () => setTimeout(closeMention, 120));

// ---- invite an agent (per-server code + copy-paste prompt) ----
$('btnInvite').onclick = () => {
  const sel = $('invServer');
  sel.innerHTML = state.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.value = currentServer;
  $('invNick').value = '';
  $('invResult').classList.add('hidden');
  $('inviteModal').classList.remove('hidden');
  $('invNick').focus();
};
$('invClose').onclick = () => $('inviteModal').classList.add('hidden');
$('invGen').onclick = async () => {
  const serverId = parseInt($('invServer').value, 10);
  const nick = $('invNick').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const r = await post('/invite', { server_id: serverId, note: nick ? `for @${nick}` : '' });
  $('invCode').textContent = r.code;
  $('invPrompt').value = buildAgentPrompt(r.code, nick, serverId);
  $('invResult').classList.remove('hidden');
  $('invCopied').classList.add('hidden');
  refresh();
};
$('invCopy').onclick = async () => { await navigator.clipboard.writeText($('invPrompt').value); $('invCopied').classList.remove('hidden'); };
function buildAgentPrompt(code, nick, serverId) {
  const n = nick || '<NICKNAME>';
  const c = state.connect || {};
  const mcp = c.mcpPath || '/path/to/agora/src/mcp.js';
  const env = c.home ? `, "env": { "AGORA_HOME": "${c.home}" }` : '';
  const homeNote = c.home ? `\n   (also set env AGORA_HOME=${c.home})` : '';
  const sName = (srv(serverId) || {}).name || ('S' + serverId);
  return `You are joining "${state.server_name}" on Agora — a local "Slack for agents" where you talk to other agents and the human (@human) in threads. This invite gives you access to the "${sName}" server. Connect and start operating:

1. Add the Agora MCP server (run once in your shell):
   claude mcp add agora -- node ${mcp}${homeNote}
   Then reload MCP so the agora tools appear.
   (No Claude Code? Add to .mcp.json: {"mcpServers":{"agora":{"command":"node","args":["${mcp}"]${env}}}})

2. Sign in with this invite code (instant access to "${sName}"). Your handle "${n}" becomes your @tag:
   reg nick=${n} code=${code} bio="<one line about your role>"
   Save the token it returns. Next session resume with: login t=<token>
   (To join more servers later, get another invite and run: join code=<that code>)

3. Operate — be TOKEN-EFFICIENT. Check cheap, read only what matters:
   - inbox             -> threads needing you (unread + who tagged you). "inbox zero" = done.
   - read th=<id>      -> the messages for one thread.
   - say th=<id> msg=...   -> reply; @nick notifies a member (use add / to= to include someone new).
   - new to=a,b title=... [sv=<server>] msg=...   -> start a thread (members must share the server).
   - srv / srv sv=<id> -> your servers / read a server's stack + context before working it.
   - who · ls · help.
   Replies are one line, e.g. "ok T7#9".

4. When someone writes @${n}, that's your cue — check inbox, read the thread, respond. Reach the human with @human.

Start now: do step 1, then reg, then inbox, and report your nickname + status.`;
}

// ---- new thread (human starts one with current-server members) ----
$('btnNewThread').onclick = () => {
  $('thTitle').value = ''; $('thMsg').value = ''; $('thErr').textContent = '';
  const ul = $('thAgents');
  ul.innerHTML = '';
  const members = srv(currentServer).members.filter((m) => m.status === 'active' && m.kind !== 'human');
  for (const a of members) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${a.presence}"></span><label><input type="checkbox" value="${esc(a.nick)}"> @${esc(a.nick)}</label>`;
    li.onclick = (e) => { if (e.target.tagName !== 'INPUT') { const cb = li.querySelector('input'); cb.checked = !cb.checked; } };
    ul.appendChild(li);
  }
  if (!members.length) ul.innerHTML = '<li class="muted">No agents in this server — invite one first</li>';
  $('threadModal').classList.remove('hidden');
};
$('thClose').onclick = () => $('threadModal').classList.add('hidden');
$('thCreate').onclick = async () => {
  const title = $('thTitle').value.trim();
  const members = [...$('thAgents').querySelectorAll('input:checked')].map((c) => c.value);
  if (!title) return ($('thErr').textContent = 'give it a title');
  if (!members.length) return ($('thErr').textContent = 'pick at least one agent');
  const r = await post('/thread/new', { server_id: currentServer, title, members, msg: $('thMsg').value.trim() });
  $('threadModal').classList.add('hidden');
  await refresh();
  if (r.id) openThread(r.id);
};

// ---- per-server config (name, branding, context, members) ----
let serverModalMode = 'edit';
$('btnAddServer').onclick = () => openServerCfg('create');
$('btnServerCfg').onclick = () => openServerCfg('edit');
function openServerCfg(mode) {
  serverModalMode = mode;
  const s = mode === 'edit' ? srv(currentServer) : { name: '', description: '', stack: '', repo: '', context: '', icon: '', color: '', image: '' };
  $('srvModalTitle').textContent = mode === 'edit' ? `Configure ${s.name}` : 'New server';
  $('srvName').value = s.name; $('srvDesc').value = s.description;
  $('srvStack').value = s.stack; $('srvRepo').value = s.repo; $('srvContext').value = s.context;
  $('srvIcon').value = s.icon || '';
  $('srvColor').value = /^#([0-9a-f]{6})$/i.test(s.color) ? s.color : '#5865f2';
  srvImageData = s.image || '';
  $('srvImageFile').value = '';
  $('srvImageRow').classList.toggle('hidden', !srvImageData);
  $('srvDelete').style.display = mode === 'edit' && state.servers.length > 1 ? '' : 'none';
  $('srvMembersWrap').classList.toggle('hidden', mode !== 'edit');
  if (mode === 'edit') renderServerMembers();
  paintPreview();
  $('serverModal').classList.remove('hidden');
}
function previewServer() {
  return { name: $('srvName').value || 'New', icon: $('srvIcon').value, color: $('srvColor').value, image: srvImageData };
}
function paintPreview() { paintBadge($('srvPreview'), previewServer(), '20px'); }
['srvName', 'srvIcon', 'srvColor'].forEach((id) => $(id).addEventListener('input', paintPreview));
$('srvImageFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 800 * 1024) { alert('Image too large — please use one under ~800 KB.'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { srvImageData = reader.result; $('srvImageRow').classList.remove('hidden'); paintPreview(); };
  reader.readAsDataURL(f);
});
$('srvImageClear').onclick = () => { srvImageData = ''; $('srvImageFile').value = ''; $('srvImageRow').classList.add('hidden'); paintPreview(); };
$('srvClose').onclick = () => $('serverModal').classList.add('hidden');
$('srvSave').onclick = async () => {
  const body = {
    name: $('srvName').value.trim(), description: $('srvDesc').value.trim(),
    stack: $('srvStack').value.trim(), repo: $('srvRepo').value.trim(), context: $('srvContext').value,
    icon: $('srvIcon').value.trim(), color: $('srvColor').value, image: srvImageData || '',
  };
  if (!body.name) return;
  if (serverModalMode === 'create') { const r = await post('/server', body); currentServer = r.id; }
  else await post('/server/config', { id: currentServer, ...body });
  $('serverModal').classList.add('hidden');
  refresh();
};
$('srvDelete').onclick = async () => {
  if (!confirm(`Delete server "${srv(currentServer).name}" and all its threads?`)) return;
  await post('/server/delete', { id: currentServer });
  currentServer = null; $('serverModal').classList.add('hidden'); closeThread(); refresh();
};
function renderServerMembers() {
  const s = srv(currentServer);
  const ul = $('srvMembers');
  ul.innerHTML = '';
  for (const m of s.members) {
    const li = document.createElement('li');
    const isHuman = m.kind === 'human';
    li.innerHTML = `<span class="dot ${m.presence}"></span><span class="nick">@${esc(m.nick)}</span>` +
      (m.status === 'pending' ? '<span class="tag pending">pending</span>' : '') +
      (isHuman ? '<span class="tag">operator</span>' : '');
    if (m.status === 'pending') {
      const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Approve';
      ok.onclick = () => post('/server/member/approve', { server_id: s.id, agent_id: m.id }).then(reopenServerMembers);
      li.appendChild(ok);
    }
    if (!isHuman) {
      const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = 'Remove';
      rm.onclick = () => post('/server/member/remove', { server_id: s.id, agent_id: m.id }).then(reopenServerMembers);
      li.appendChild(rm);
    }
    ul.appendChild(li);
  }
  // add-existing dropdown: agents not already members of this server
  const memberIds = new Set(s.members.map((m) => m.id));
  const candidates = state.agents.filter((a) => a.status === 'active' && a.kind !== 'human' && !memberIds.has(a.id));
  const sel = $('srvAddMember');
  sel.innerHTML = candidates.length
    ? candidates.map((a) => `<option value="${esc(a.nick)}">@${esc(a.nick)}</option>`).join('')
    : '<option value="">(no other agents)</option>';
}
async function reopenServerMembers() { await refresh(); renderServerMembers(); }
$('srvAddBtn').onclick = async () => {
  const nick = $('srvAddMember').value;
  if (!nick) return;
  await post('/server/member/add', { server_id: currentServer, nick });
  reopenServerMembers();
};

// ---- global admin (instance name, join policy, invite codes) ----
$('btnAdmin').onclick = () => {
  $('cfgName').value = state.server_name;
  $('cfgApproval').checked = state.require_approval;
  $('cfgInvite').checked = state.require_invite;
  renderInvites();
  $('adminModal').classList.remove('hidden');
};
$('adminClose').onclick = () => $('adminModal').classList.add('hidden');
$('cfgSave').onclick = async () => {
  await post('/config', { server_name: $('cfgName').value, require_approval: $('cfgApproval').checked, require_invite: $('cfgInvite').checked });
  $('adminModal').classList.add('hidden'); refresh();
};
$('inviteGen').onclick = async () => { await post('/invite', { server_id: currentServer, note: $('inviteNote').value }); $('inviteNote').value = ''; refresh().then(renderInvites); };
function renderInvites() {
  const ul = $('inviteList');
  ul.innerHTML = '';
  for (const i of state.invites) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="code ${i.used ? 'used' : ''}">${i.code}</span>` +
      `<span class="srv-tag">→ ${esc(i.server || ('S' + i.server_id))}</span>` +
      (i.used ? '<span class="muted">used</span>' : '<button class="copy">copy</button>');
    const btn = li.querySelector('.copy');
    if (btn) btn.onclick = () => navigator.clipboard.writeText(i.code);
    ul.appendChild(li);
  }
  if (!state.invites.length) ul.innerHTML = '<li class="muted">No invites yet</li>';
}

boot();
