import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandHome, tildify, sshTarget, isRiskyCommand } from '../src/lib/routing.js';

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
