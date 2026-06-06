// End-to-end test: spin up two MCP clients (two "agents") against a fresh DB,
// register them, open a thread, tag, and verify inbox/read behavior.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, AGORA_HOME: '/tmp/agora-e2e' };
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`); if (!cond) fails++; };

function spawn() {
  const transport = new StdioClientTransport({ command: 'node', args: [join(root, 'src/mcp.js')], env });
  const c = new Client({ name: 'test', version: '1' });
  return c.connect(transport).then(() => c);
}
const txt = (r) => r.content.map((c) => c.text).join('\n');
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }).then(txt);

const A = await spawn();
const B = await spawn();

// list tools
const tools = (await A.listTools()).tools.map((x) => x.name);
t('exposes terse tools', tools.includes('reg') && tools.includes('say') && tools.includes('inbox'));

// register alice (active because no approval by default? approval=1 → pending)
const rega = await call(A, 'reg', { nick: 'alice', bio: 'planner' });
t('reg alice returns token', /t=/.test(rega));
const tokenA = rega.match(/t=(\S+)/)[1];
const aPending = /pending/.test(rega);

const regb = await call(B, 'reg', { nick: 'bob' });
const tokenB = regb.match(/t=(\S+)/)[1];

// Reg without an invite joins the default server S1 with status per config
// (approval on by default → pending). Approve both memberships via the DB.
process.env.AGORA_HOME = '/tmp/agora-e2e';
const db = await import('../src/db.js');
db.setMemberStatus.run('active', 1, db.agentByNick.get('alice').id);
db.setMemberStatus.run('active', 1, db.agentByNick.get('bob').id);

// login to refresh sessions to active
const loga = await call(A, 'login', { t: tokenA });
t('alice login active', /hi @alice/.test(loga));
await call(B, 'login', { t: tokenB });

// who — shares server S1
const who = await call(A, 'who');
t('who lists bob (co-member)', /@bob/.test(who));

// per-server access: srv lists S1 for alice
const srv = await call(A, 'srv');
t('srv lists alice\'s server S1', /S1/.test(srv));

// alice starts a thread with bob and tags him
const created = await call(A, 'new', { to: 'bob', title: 'plan', msg: 'hey @bob ready?' });
t('new returns T id', /T\d+/.test(created));
const tnum = created.match(/T(\d+)/)[1];

// bob checks inbox → should see unread + mention
const inbox = await call(B, 'inbox');
t('bob inbox shows the thread', new RegExp('T' + tnum).test(inbox));
t('bob inbox shows mention', /@1/.test(inbox));

// bob reads
const read = await call(B, 'read', { th: tnum });
t('bob read sees alice message', /alice: hey @bob ready\?/.test(read));

// after read, inbox should be clear
const inbox2 = await call(B, 'inbox');
t('bob inbox zero after read', /inbox zero/.test(inbox2));

// bob replies tagging alice
await call(B, 'say', { th: tnum, msg: 'yes @alice lets go' });
const ainbox = await call(A, 'inbox');
t('alice notified of reply', new RegExp('T' + tnum).test(ainbox) && /@1/.test(ainbox));

// ls shows thread for alice
const ls = await call(A, 'ls');
t('ls lists thread', new RegExp('T' + tnum + ' plan').test(ls));

// duplicate nick rejected
const dup = await call(A, 'reg', { nick: 'alice' });
t('duplicate nick rejected', /taken/.test(dup));

// ---- per-server permissions ----
// Create a 2nd server S2 with a server-bound invite; alice is NOT a member.
const s2 = db.createServer({ name: 'Secret' });
const denyNew = await call(A, 'new', { to: 'bob', title: 'x', sv: String(s2) });
t('non-member cannot create a thread in S2', /not a member of S2/.test(denyNew));
const denySrv = await call(A, 'srv', { sv: String(s2) });
t('non-member cannot read S2 context', /not a member of S2/.test(denySrv));
t('srv (no arg) does NOT list S2 for alice', !new RegExp('S' + s2 + ' Secret').test(await call(A, 'srv')));

// Human mints an S2 invite; alice redeems it with `join code=` → now in S2.
const inv = db.newCode();
db.createInvite.run(inv, '', s2, db.now());
const joined = await call(A, 'join', { code: inv });
t('join code grants access to S2', new RegExp('joined S' + s2).test(joined));
const okNew = await call(A, 'new', { to: 'alice', title: 'now allowed', sv: String(s2) });
t('member CAN create a thread in S2 after joining', new RegExp('created in S' + s2).test(okNew));

await A.close();
await B.close();
console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
