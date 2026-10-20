import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandHome, tildify, globToRegExp, sshTarget, ruleMatches, route, isRiskyCommand } from '../src/lib/routing.js';

const HOME = '/Users/me';

describe('expandHome / tildify', () => {
  test('expandHome', () => {
    assert.equal(expandHome('~', HOME), HOME);
    assert.equal(expandHome('~/work', HOME), '/Users/me/work');
    assert.equal(expandHome('/etc', HOME), '/etc');
    assert.equal(expandHome('~other', HOME), '~other');
    assert.equal(expandHome('', HOME), '');
  });
  test('tildify', () => {
    assert.equal(tildify(HOME, HOME), '~');
    assert.equal(tildify('/Users/me/work/api', HOME), '~/work/api');
    assert.equal(tildify('/Users/meow', HOME), '/Users/meow');
    assert.equal(tildify('/etc', undefined), '/etc');
  });
});

describe('globToRegExp', () => {
  const work = globToRegExp(expandHome('~/work/*', HOME), { path: true });
  test('trailing /* in path mode matches the dir itself and everything below', () => {
    assert.ok(work.test('/Users/me/work'));
    assert.ok(work.test('/Users/me/work/api'));
    assert.ok(work.test('/Users/me/work/api/src'));
  });
  test('trailing /* does not match sibling prefixes', () => {
    assert.ok(!work.test('/Users/me/workshop'));
    assert.ok(!work.test('/Users/me/workshop/x'));
    assert.ok(!work.test('/Users/me'));
  });
  test('path mode: * stays in one segment, ** spans segments, ? is one char', () => {
    const one = globToRegExp('/a/*/c', { path: true });
    assert.ok(one.test('/a/b/c'));
    assert.ok(!one.test('/a/b/x/c'));
    const many = globToRegExp('/a/**/c', { path: true });
    assert.ok(many.test('/a/b/x/c'));
    const q = globToRegExp('/a/?', { path: true });
    assert.ok(q.test('/a/b'));
    assert.ok(!q.test('/a/bc'));
  });
  test('regex metacharacters in the glob are literal', () => {
    const re = globToRegExp('/tmp/a.b(1)', { path: true });
    assert.ok(re.test('/tmp/a.b(1)'));
    assert.ok(!re.test('/tmp/aXb(1)'));
  });
  test('host globs are case-insensitive and anchored', () => {
    const re = globToRegExp('*.prod.company.com');
    assert.ok(re.test('WEB-01.prod.company.com'));
    assert.ok(re.test('db.PROD.company.com'));
    assert.ok(!re.test('web-01.staging.company.com'));
    assert.ok(!re.test('web.prod.company.com.evil.io'));
    assert.ok(!re.test('prodXcompany.com'));
  });
  test('host glob ? and leading/trailing whitespace', () => {
    assert.ok(globToRegExp('  web-0?  ').test('web-07'));
  });
});

describe('sshTarget', () => {
  test('user@host', () => {
    assert.deepEqual(sshTarget('ssh deploy@web-01'), { user: 'deploy', host: 'web-01', raw: 'deploy@web-01' });
  });
  test('bare host, lowercased', () => {
    assert.deepEqual(sshTarget('ssh WEB-01.Prod.com'), { user: '', host: 'web-01.prod.com', raw: 'WEB-01.Prod.com' });
  });
  test('skips flags and their arguments', () => {
    const t = sshTarget('ssh -p 22 -i key deploy@web-01');
    assert.equal(t.host, 'web-01');
    assert.equal(t.user, 'deploy');
    assert.equal(sshTarget('ssh -v -A -o StrictHostKeyChecking=no -J bastion host-a').host, 'host-a');
  });
  test('sudo ssh, mosh, autossh and absolute paths', () => {
    assert.equal(sshTarget('sudo ssh root@db').host, 'db');
    assert.equal(sshTarget('mosh web').host, 'web');
    assert.equal(sshTarget('/usr/bin/ssh web').host, 'web');
  });
  test('autossh -M <port> takes an argument (monitor port is not the host)', () => {
    assert.equal(sshTarget('autossh -M 0 web').host, 'web');
    assert.equal(sshTarget('autossh -M 20000 deploy@web').user, 'deploy');
  });
  test('non-ssh commands and missing targets return null', () => {
    assert.equal(sshTarget('ls -la'), null);
    assert.equal(sshTarget('sshfs host:/ /mnt'), null);
    assert.equal(sshTarget('sudo ls'), null);
    assert.equal(sshTarget('ssh'), null);
    assert.equal(sshTarget('ssh -p 22'), null);
    assert.equal(sshTarget(''), null);
    assert.equal(sshTarget(null), null);
  });
});

describe('ruleMatches / route', () => {
  const rule = (type, pattern, extra = {}) => ({ enabled: true, trigger: { type, pattern }, ...extra });

  test('dir rule expands ~ and ignores trailing slashes on cwd', () => {
    const r = rule('dir', '~/work/*');
    assert.ok(ruleMatches(r, { cwd: '/Users/me/work/api/' }, HOME));
    assert.ok(!ruleMatches(r, { cwd: '/Users/me/workshop' }, HOME));
    assert.ok(!ruleMatches(r, {}, HOME));
  });
  test('ssh rule uses ctx.host, else parses the command; also matches raw user@host', () => {
    const r = rule('ssh', '*.prod.company.com');
    assert.ok(ruleMatches(r, { host: 'WEB-01.prod.company.com' }, HOME));
    assert.ok(ruleMatches(r, { command: 'ssh -p 22 deploy@web-01.prod.company.com' }, HOME));
    assert.ok(!ruleMatches(r, { command: 'ssh web-01.staging.company.com' }, HOME));
    assert.ok(!ruleMatches(r, { command: 'ls' }, HOME));
    assert.ok(ruleMatches(rule('ssh', 'deploy@*'), { command: 'ssh deploy@x' }, HOME));
  });
  test('command rule is a prefix match on the trimmed command', () => {
    const r = rule('command', 'npm run');
    assert.ok(ruleMatches(r, { command: '  npm run dev' }, HOME));
    assert.ok(!ruleMatches(r, { command: 'npx npm run' }, HOME));
    assert.ok(!ruleMatches(r, {}, HOME));
  });
  test('disabled, empty-pattern and unknown-type rules never match', () => {
    assert.ok(!ruleMatches({ ...rule('command', 'ls'), enabled: false }, { command: 'ls' }, HOME));
    assert.ok(!ruleMatches(rule('command', '   '), { command: 'ls' }, HOME));
    assert.ok(!ruleMatches(rule('weird', 'ls'), { command: 'ls' }, HOME));
  });
  test('route: first match wins, disabled rules are skipped', () => {
    const rules = [
      { ...rule('dir', '~/work/*', { id: 'disabled' }), enabled: false },
      rule('command', 'git', { id: 'git' }),
      rule('dir', '~/work/*', { id: 'work' }),
      rule('dir', '~/**', { id: 'home' }),
    ];
    assert.deepEqual(route(rules, { cwd: '/Users/me/work/api' }, HOME), { rule: rules[2], index: 2 });
    assert.deepEqual(route(rules, { cwd: '/Users/me/work/api', command: 'git status' }, HOME), { rule: rules[1], index: 1 });
    assert.equal(route(rules, { cwd: '/Users/me/notes' }, HOME).rule.id, 'home');
    assert.equal(route(rules, { cwd: '/etc' }, HOME), null);
    assert.equal(route([], { cwd: '/etc' }, HOME), null);
  });
});

describe('isRiskyCommand', () => {
  for (const cmd of [
    'sudo apt upgrade',
    'ls && sudo reboot',
    'systemctl restart nginx',
    'sudo systemctl stop nginx',
    'service nginx reload',
    'rm -rf /tmp/x',
    'rm -r build',
    'rm -fr build',
    'reboot',
    'shutdown -h now',
    'psql -c "DROP TABLE users"',
  ]) {
    test(`risky: ${cmd}`, () => assert.equal(isRiskyCommand(cmd), true));
  }
  for (const cmd of ['ls', 'ls -la', 'git status', 'systemctl status nginx', 'rm file.txt', 'echo hi', '', '   ', 'firm -rf']) {
    test(`not risky: ${JSON.stringify(cmd)}`, () => assert.equal(isRiskyCommand(cmd), false));
  }
});
