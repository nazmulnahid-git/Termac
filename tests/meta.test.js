// Pin the zone before any Date work so dayLabel's DST case is deterministic.
process.env.TZ = 'America/New_York';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { firstToken, kindOf, leafOf, splitCwd, sessionName, shortName, procLabel, formatDuration, timeAgo, dayLabel, uid } from '../src/lib/meta.js';

const HOME = '/Users/me';

describe('firstToken', () => {
  test('plain commands and paths', () => {
    assert.equal(firstToken('git status'), 'git');
    assert.equal(firstToken('/usr/local/bin/python3 app.py'), 'python3');
    assert.equal(firstToken('./scripts/deploy.sh prod'), 'deploy.sh');
  });
  test('skips runners, env assignments and leading flags', () => {
    assert.equal(firstToken('sudo vim /etc/hosts'), 'vim');
    assert.equal(firstToken('FOO=1 BAR=2 node server.js'), 'node');
    assert.equal(firstToken('env -i bash'), 'bash');
    assert.equal(firstToken('npx vite'), 'vite');
    assert.equal(firstToken('time nohup make'), 'make');
  });
  test('npm/bun keep their subcommand', () => {
    assert.equal(firstToken('npm run dev'), 'npm run dev');
    assert.equal(firstToken('bun run build --watch'), 'bun run build');
    assert.equal(firstToken('sudo npm run dev'), 'npm run dev');
    assert.equal(firstToken('npm'), 'npm');
  });
  test('empty and all-skipped input', () => {
    assert.equal(firstToken(''), '');
    assert.equal(firstToken(null), '');
    assert.equal(firstToken('sudo'), 'sudo');
  });
});

describe('kindOf', () => {
  const cases = {
    'npm run dev': 'js',
    'node server.js': 'js',
    'python3 -m http.server': 'py',
    'pytest -x': 'py',
    'psql mydb': 'db',
    'git push': 'git',
    'ssh web-01': 'ssh',
    'terraform plan': 'tf',
    'kubectl get pods': 'k8',
    'cargo build': 'rs',
    'go test ./...': 'go',
    'docker compose up': 'dk',
    'nvim .': 'ed',
    'htop': 'top',
    'sudo python app.py': 'py',
    'exec ssh host': 'ssh',
    'ls -la': '>_',
    'gitk': '>_',
    'golang-thing': '>_',
    '': '>_',
  };
  for (const [cmd, kind] of Object.entries(cases)) test(`${JSON.stringify(cmd)} → ${kind}`, () => assert.equal(kindOf(cmd), kind));
  test('null', () => assert.equal(kindOf(null), '>_'));
});

describe('leafOf / splitCwd', () => {
  test('leafOf', () => {
    assert.equal(leafOf('/Users/me/work/api', HOME), 'api');
    assert.equal(leafOf('/Users/me/work/api/', HOME), 'api');
    assert.equal(leafOf(HOME, HOME), '~');
    assert.equal(leafOf('/Users/me/', HOME), '~');
    assert.equal(leafOf('/etc', HOME), 'etc');
    assert.equal(leafOf('/', HOME), '/');
    assert.equal(leafOf('', HOME), '~');
    assert.equal(leafOf(undefined, HOME), '~');
  });
  test('splitCwd tildifies and splits on the last slash', () => {
    assert.deepEqual(splitCwd('/Users/me/work/api', HOME), { dir: '~/work/', leaf: 'api' });
    assert.deepEqual(splitCwd('/Users/me/work', HOME), { dir: '~/', leaf: 'work' });
    assert.deepEqual(splitCwd(HOME, HOME), { dir: '', leaf: '~' });
    assert.deepEqual(splitCwd(null, HOME), { dir: '', leaf: '~' });
    assert.deepEqual(splitCwd('/var/log', HOME), { dir: '/var/', leaf: 'log' });
    assert.deepEqual(splitCwd('/Users/meow/x', HOME), { dir: '/Users/meow/', leaf: 'x' });
  });
});

describe('sessionName', () => {
  test('user rename wins over everything', () => {
    assert.equal(sessionName({ name: 'prod', cwd: '/x' }, { status: 'run', command: 'top', cwd: '/y' }, HOME), 'prod');
  });
  test('running command, then last finished command', () => {
    assert.equal(sessionName({}, { status: 'run', command: 'npm run dev', cwd: '/Users/me/app' }, HOME), 'npm run dev');
    assert.equal(sessionName({}, { status: 'fail', command: 'make', cwd: '/Users/me/app' }, HOME), 'make');
    assert.equal(sessionName({}, { status: 'ok', command: 'make', cwd: '/Users/me/app' }, HOME), 'make');
  });
  test('falls back to the folder: runtime cwd, then meta cwd, then ~', () => {
    assert.equal(sessionName({ cwd: '/Users/me/old' }, { status: 'idle', cwd: '/Users/me/app' }, HOME), 'app');
    assert.equal(sessionName({ cwd: '/Users/me/old' }, { status: 'run' }, HOME), 'old');
    assert.equal(sessionName({ cwd: '/Users/me/old' }, null, HOME), 'old');
    assert.equal(sessionName(null, null, HOME), '~');
  });
});

describe('shortName / procLabel', () => {
  test('shortName', () => {
    assert.equal(shortName('npm run dev'), 'npm');
    assert.equal(shortName('kubernetes'), 'kubern…');
    assert.equal(shortName('abcdefg'), 'abcdefg');
    assert.equal(shortName(''), '');
    assert.equal(shortName(null), '');
  });
  test('procLabel', () => {
    assert.equal(procLabel(null, 'fish'), 'fish');
    assert.equal(procLabel(null), 'zsh');
    assert.equal(procLabel({ status: 'run', command: 'ls' }), 'ls');
    assert.equal(procLabel({ status: 'run', command: 'x'.repeat(40) }), 'x'.repeat(27) + '…');
    assert.equal(procLabel({ status: 'fail', command: 'make all', exitCode: 2 }), 'make · exited 2');
    assert.equal(procLabel({ status: 'ok', command: 'make all' }), 'make · done');
    assert.equal(procLabel({ status: 'idle', proc: 'vim', shell: 'zsh' }), 'vim');
    assert.equal(procLabel({ status: 'idle', proc: 'zsh', shell: 'zsh' }), 'zsh');
    assert.equal(procLabel({ status: 'idle', proc: 'login' }, 'bash'), 'bash');
  });
});

describe('formatDuration', () => {
  test('null/undefined', () => {
    assert.equal(formatDuration(null), '');
    assert.equal(formatDuration(undefined), '');
  });
  test('under 10s: two decimals', () => {
    assert.equal(formatDuration(0), '0.00s');
    assert.equal(formatDuration(1234), '1.23s');
    assert.equal(formatDuration(9990), '9.99s');
  });
  test('10s to a minute: whole seconds', () => {
    assert.equal(formatDuration(10000), '10s');
    assert.equal(formatDuration(15400), '15s');
    assert.equal(formatDuration(59000), '59s');
  });
  test('minutes and seconds', () => {
    assert.equal(formatDuration(60000), '1m 0s');
    assert.equal(formatDuration(90000), '1m 30s');
    assert.equal(formatDuration(59 * 60000 + 59000), '59m 59s');
  });
  test('hours and minutes', () => {
    assert.equal(formatDuration(3600000), '1h 0m');
    assert.equal(formatDuration(3725000), '1h 2m');
    assert.equal(formatDuration(26 * 3600000 + 5 * 60000), '26h 5m');
  });
  test('rounding never produces a 60s component', () => {
    for (const ms of [59600, 119600, 179999]) {
      assert.doesNotMatch(formatDuration(ms), /(^|\s)60s$/, `formatDuration(${ms}) = ${formatDuration(ms)}`);
    }
  });
});

describe('timeAgo', () => {
  test('ranges', () => {
    const now = 1_000_000_000_000;
    assert.equal(timeAgo(now, now), 'just now');
    assert.equal(timeAgo(now + 5000, now), 'just now');
    assert.equal(timeAgo(now - 30_000, now), 'just now');
    assert.equal(timeAgo(now - 5 * 60_000, now), '5m ago');
    assert.equal(timeAgo(now - 3 * 3600_000, now), '3h ago');
    assert.equal(timeAgo(now - 3 * 86400_000, now), '3d ago');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 9, 20, 15, 0).getTime(); // Tue 20 Oct 2026, 15:00 local
  test('Today (including earlier today and the future)', () => {
    assert.equal(dayLabel(new Date(2026, 9, 20, 0, 1).getTime(), now), 'Today');
    assert.equal(dayLabel(new Date(2026, 9, 20, 23, 59).getTime(), now), 'Today');
    assert.equal(dayLabel(new Date(2026, 9, 22).getTime(), now), 'Today');
  });
  test('Yesterday across midnight', () => {
    assert.equal(dayLabel(new Date(2026, 9, 19, 23, 59).getTime(), now), 'Yesterday');
    assert.equal(dayLabel(new Date(2026, 9, 19, 0, 0).getTime(), now), 'Yesterday');
  });
  test('This week / Last week', () => {
    assert.equal(dayLabel(new Date(2026, 9, 17).getTime(), now), 'This week');
    assert.equal(dayLabel(new Date(2026, 9, 14).getTime(), now), 'This week');
    assert.equal(dayLabel(new Date(2026, 9, 13).getTime(), now), 'Last week');
    assert.equal(dayLabel(new Date(2026, 9, 7).getTime(), now), 'Last week');
  });
  test('older dates fall back to month + year', () => {
    const label = dayLabel(new Date(2026, 5, 1).getTime(), now);
    assert.match(label, /2026/);
    assert.notEqual(label, 'Last week');
  });
  test('Yesterday across a DST change (America/New_York, 2026-11-01)', () => {
    const afterFallBack = new Date(2026, 10, 2, 12).getTime();
    assert.equal(dayLabel(new Date(2026, 10, 1, 12).getTime(), afterFallBack), 'Yesterday');
    const afterSpringForward = new Date(2026, 2, 9, 12).getTime();
    assert.equal(dayLabel(new Date(2026, 2, 8, 12).getTime(), afterSpringForward), 'Yesterday');
  });
});

describe('uid', () => {
  test('uses the prefix and is unique', () => {
    const ids = new Set();
    for (let i = 0; i < 2000; i++) {
      const id = uid('s');
      assert.ok(id.startsWith('s'));
      assert.match(id, /^s[0-9a-z]+$/);
      ids.add(id);
    }
    assert.equal(ids.size, 2000);
    assert.ok(uid().startsWith('x'));
  });
});
