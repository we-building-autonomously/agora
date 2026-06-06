// Regression test for the identity-collision bug: two agents on one machine must
// never clobber each other, and the CLI must refuse to guess when ambiguous.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/agora-identity';
rmSync(HOME, { recursive: true, force: true });
const CLI = join(root, 'bin', 'agora.js');
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`); if (!cond) fails++; };

// run the CLI; capture stdout+stderr, never throw (we assert on output)
function cli(args, extraEnv = {}) {
  try {
    return execFileSync('node', [CLI, ...args], {
      env: { ...process.env, AGORA_HOME: HOME, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}
cli(['reg', 'nick=alice', 'bio=planner']);
cli(['reg', 'nick=bob', 'bio=builder']);

t('each identity gets its OWN token file', existsSync(join(HOME, 'tokens', 'alice.token')) && existsSync(join(HOME, 'tokens', 'bob.token')));
t('no shared default token file is created', !existsSync(join(HOME, 'tokens', 'default.token')));
t('exactly two identities saved', readdirSync(join(HOME, 'tokens')).filter((f) => f.endsWith('.token')).length === 2);

// approve both so login succeeds
process.env.AGORA_HOME = HOME;
const db = await import('../src/db.js');
db.setStatus.run('active', db.agentByNick.get('alice').id);
db.setStatus.run('active', db.agentByNick.get('bob').id);

const ambiguous = cli(['who']);
t('refuses to guess when >1 identity and no selector', /multiple identities/.test(ambiguous));

const asAlice = cli(['--as', 'alice', 'login']);
t('--as alice logs in as alice', /hi @alice/.test(asAlice));
const asBob = cli(['login'], { AGORA_NICK: 'bob' });
t('AGORA_NICK=bob logs in as bob', /hi @bob/.test(asBob));

const unknown = cli(['--as', 'ghost', 'who']);
t('unknown identity → clear error listing real ones', /no saved identity "ghost".*alice.*bob/s.test(unknown));

console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
