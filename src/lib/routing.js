// Routing rules decide where a new session lands and which effects it gets.
// A rule reads as a sentence: trigger (dir | ssh | command) → action (space | split) + effects.

export function expandHome(p, home) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

export function tildify(p, home) {
  if (!p || !home) return p;
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

// Glob → RegExp. `**` spans directories, `*` stays within one segment. A trailing `/*`
// matches the directory itself and everything below it, which is what people mean by
// "a terminal opens in ~/work/*".
export function globToRegExp(glob, { path = false } = {}) {
  let g = glob.trim();
  let tail = '';
  if (path && g.endsWith('/*')) {
    g = g.slice(0, -2);
    tail = '(?:/.*)?';
  }
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += path ? '[^/]*' : '.*';
    } else if (c === '?') re += path ? '[^/]' : '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}${tail}$`, path ? '' : 'i');
}

// Pulls the destination host out of an ssh command line ("ssh -p 22 deploy@web-01" → web-01).
export function sshTarget(command) {
  if (!command) return null;
  const parts = command.trim().split(/\s+/);
  let i = parts[0] === 'sudo' ? 1 : 0;
  if (!/(^|\/)(ssh|mosh|autossh)$/.test(parts[i] || '')) return null;
  const withArg = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I']);
  for (i = i + 1; i < parts.length; i++) {
    const a = parts[i];
    if (withArg.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    const at = a.lastIndexOf('@');
    return { user: at > 0 ? a.slice(0, at) : '', host: (at >= 0 ? a.slice(at + 1) : a).toLowerCase(), raw: a };
  }
  return null;
}

export function ruleMatches(rule, ctx, home) {
  if (!rule.enabled) return false;
  const pattern = rule.trigger?.pattern?.trim();
  if (!pattern) return false;
  switch (rule.trigger.type) {
    case 'dir': {
      if (!ctx.cwd) return false;
      return globToRegExp(expandHome(pattern, home), { path: true }).test(ctx.cwd.replace(/\/+$/, ''));
    }
    case 'ssh': {
      const t = ctx.host ? { host: ctx.host.toLowerCase() } : sshTarget(ctx.command);
      if (!t) return false;
      const re = globToRegExp(pattern.toLowerCase());
      return re.test(t.host) || (t.raw && re.test(t.raw.toLowerCase()));
    }
    case 'command':
      return !!ctx.command && ctx.command.trim().startsWith(pattern);
    default:
      return false;
  }
}

// First match wins. Returns the rule and its index, or null.
export function route(rules, ctx, home) {
  for (let i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i], ctx, home)) return { rule: rules[i], index: i };
  }
  return null;
}

// Commands that need an explicit OK on a danger (production) session.
export function isRiskyCommand(line) {
  const l = line.trim();
  if (!l) return false;
  return /(^|[\s;&|(])sudo\s/.test(l) || /\b(reboot|shutdown|halt|poweroff)\b/.test(l) || /\b(systemctl|service)\s+\S*\s*(restart|stop|reload|disable)\b/.test(l) || /\brm\s+-\w*[rf]/.test(l) || /\b(drop|truncate)\s+(table|database)\b/i.test(l);
}
