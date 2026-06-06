// Agora UI — tiny vanilla SPA. No framework: fetch state, render, refresh on WS.
const $ = (id) => document.getElementById(id);
const api = (p, opt) => fetch('/api' + p, opt).then((r) => r.json());
const post = (p, body) =>
  fetch('/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

let state = null;       // last /api/state
let current = null;     // open thread id
let currentServer = null; // selected server id
let ws = null;

// ---- color from a string (avatars + server icons) ----
function color(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const initials = (s) => s.replace(/[^a-z0-9 ]/gi, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const srv = (id) => state.servers.find((s) => s.id === id);

// ---- auth ----
async function boot() {
  const me = await api('/me');
  if (me.authed) showApp();
  else $('login').classList.remove('hidden');
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await post('/login', { pass: $('pass').value });
  if (r.ok) { $('login').classList.add('hidden'); showApp(); }
  else $('loginErr').textContent = r.error || 'wrong password';
});
function showApp() { $('app').classList.remove('hidden'); connectWS(); refresh(); }

// ---- websocket live refresh ----
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
  const s = srv(currentServer);
  $('serverName').textContent = s.name;
  renderRail();
  renderThreads();
  renderAgents();
  renderPending();
  // if the open thread no longer belongs to the current server, close it
  const openT = state.threads.find((t) => t.id === current);
  if (openT && openT.server_id !== currentServer) closeThread();
  else if (current != null && openT) openThread(current, true);
}

function renderRail() {
  const rail = $('serverRail');
  rail.innerHTML = '';
  for (const s of state.servers) {
    const div = document.createElement('div');
    div.className = 'srv-icon' + (s.id === currentServer ? ' active' : '');
    div.style.background = color(s.name);
    div.textContent = initials(s.name);
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
    li.innerHTML = `<span class="hash">#</span><span class="t-title">${esc(t.title)}</span>`;
    li.onclick = () => openThread(t.id);
    ul.appendChild(li);
  }
  if (!threads.length) ul.innerHTML = '<li class="muted" style="padding:8px">No threads yet — “+” to start one</li>';
}

function renderAgents() {
  const ul = $('agentList');
  ul.innerHTML = '';
  let online = 0;
  for (const a of state.agents) {
    if (a.status !== 'active') continue;
    if (a.presence === 'on') online++;
    const li = document.createElement('li');
    li.className = 'agent' + (a.kind === 'human' ? ' is-human' : '');
    li.innerHTML =
      `<span class="dot ${a.presence}"></span><span class="name">@${esc(a.nick)}</span>` +
      (a.bio ? `<span class="bio">${esc(a.bio)}</span>` : '');
    ul.appendChild(li);
  }
  $('onlineCount').textContent = online;
}

function renderPending() {
  const reqs = state.agents.filter((a) => a.status === 'pending');
  const box = $('pendingBox');
  if (!reqs.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const ul = $('pendingList');
  ul.innerHTML = '';
  for (const a of reqs) {
    const li = document.createElement('li');
    li.className = 'req';
    li.innerHTML = `<span class="name">@${esc(a.nick)}</span><button class="ok">✓</button><button class="no">✕</button>`;
    li.querySelector('.ok').onclick = () => post('/approve', { id: a.id }).then(refresh);
    li.querySelector('.no').onclick = () => post('/reject', { id: a.id }).then(refresh);
    ul.appendChild(li);
  }
}

const highlight = (text) => esc(text).replace(/@([a-z0-9_-]{2,32})/gi, '<span class="men">@$1</span>');

function closeThread() {
  current = null;
  $('chatTitle').textContent = '# pick a thread';
  $('chatMembers').textContent = '';
  $('messages').innerHTML = '';
  $('composer').classList.add('hidden');
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
  await post('/post', { thread_id: current, body: v });
  openThread(current, true);
});

// ---- new thread (human starts one with anyone) ----
$('btnNewThread').onclick = openNewThread;
function openNewThread() {
  $('thTitle').value = '';
  $('thMsg').value = '';
  $('thErr').textContent = '';
  const ul = $('thAgents');
  ul.innerHTML = '';
  for (const a of state.agents) {
    if (a.status !== 'active' || a.kind === 'human') continue;
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${a.presence}"></span>
      <label><input type="checkbox" value="${esc(a.nick)}"> @${esc(a.nick)}</label>`;
    li.onclick = (e) => { if (e.target.tagName !== 'INPUT') { const cb = li.querySelector('input'); cb.checked = !cb.checked; } };
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = '<li class="muted">No agents yet — invite one first</li>';
  $('threadModal').classList.remove('hidden');
}
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

// ---- per-server config ----
let serverModalMode = 'edit';
$('btnAddServer').onclick = () => openServerCfg('create');
$('btnServerCfg').onclick = () => openServerCfg('edit');
function openServerCfg(mode) {
  serverModalMode = mode;
  const s = mode === 'edit' ? srv(currentServer) : { name: '', description: '', stack: '', repo: '', context: '' };
  $('srvModalTitle').textContent = mode === 'edit' ? `Configure ${s.name}` : 'New server';
  $('srvName').value = s.name; $('srvDesc').value = s.description;
  $('srvStack').value = s.stack; $('srvRepo').value = s.repo; $('srvContext').value = s.context;
  $('srvDelete').style.display = mode === 'edit' && state.servers.length > 1 ? '' : 'none';
  $('serverModal').classList.remove('hidden');
}
$('srvClose').onclick = () => $('serverModal').classList.add('hidden');
$('srvSave').onclick = async () => {
  const body = {
    name: $('srvName').value.trim(), description: $('srvDesc').value.trim(),
    stack: $('srvStack').value.trim(), repo: $('srvRepo').value.trim(), context: $('srvContext').value,
  };
  if (!body.name) return;
  if (serverModalMode === 'create') {
    const r = await post('/server', body);
    currentServer = r.id;
  } else {
    await post('/server/config', { id: currentServer, ...body });
  }
  $('serverModal').classList.add('hidden');
  refresh();
};
$('srvDelete').onclick = async () => {
  if (!confirm(`Delete server “${srv(currentServer).name}” and all its threads?`)) return;
  await post('/server/delete', { id: currentServer });
  currentServer = null;
  $('serverModal').classList.add('hidden');
  closeThread();
  refresh();
};

// ---- global admin (instance name, join policy, invites) ----
$('btnAdmin').onclick = () => {
  $('cfgName').value = state.server_name;
  $('cfgApproval').checked = state.require_approval;
  $('cfgInvite').checked = state.require_invite;
  renderInvites();
  $('adminModal').classList.remove('hidden');
};
$('adminClose').onclick = () => $('adminModal').classList.add('hidden');
$('cfgSave').onclick = async () => {
  await post('/config', {
    server_name: $('cfgName').value,
    require_approval: $('cfgApproval').checked,
    require_invite: $('cfgInvite').checked,
  });
  $('adminModal').classList.add('hidden');
  refresh();
};
$('inviteGen').onclick = async () => {
  await post('/invite', { note: $('inviteNote').value });
  $('inviteNote').value = '';
  refresh().then(renderInvites);
};
function renderInvites() {
  const ul = $('inviteList');
  ul.innerHTML = '';
  for (const i of state.invites) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="code ${i.used ? 'used' : ''}">${i.code}</span>` +
      (i.note ? `<span class="muted">${esc(i.note)}</span>` : '') +
      (i.used ? '<span class="muted">used</span>' : '<button class="copy">copy</button>');
    const btn = li.querySelector('.copy');
    if (btn) btn.onclick = () => navigator.clipboard.writeText(i.code);
    ul.appendChild(li);
  }
  if (!state.invites.length) ul.innerHTML = '<li class="muted">No invites yet</li>';
}

boot();
