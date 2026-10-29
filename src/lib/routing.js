// Path and command-line helpers: ~ expansion, ssh targets, and the commands a danger
// session asks about before running.

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

// Pulls the destination host out of an ssh command line ("ssh -p 22 deploy@web-01" → web-01).
export function sshTarget(command) {
  if (!command) return null;
  const parts = command.trim().split(/\s+/);
  let i = parts[0] === 'sudo' ? 1 : 0;
  if (!/(^|\/)(ssh|mosh|autossh)$/.test(parts[i] || '')) return null;
  const withArg = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I']);
  if (/autossh$/.test(parts[i])) withArg.add('-M');
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

// Commands that need an explicit OK on a danger (production) session.
export function isRiskyCommand(line) {
  const l = line.trim();
  if (!l) return false;
  return /(^|[\s;&|(])sudo\s/.test(l) || /\b(reboot|shutdown|halt|poweroff)\b/.test(l) || /\b(systemctl|service)\s+\S*\s*(restart|stop|reload|disable)\b/.test(l) || /\brm\s+-\w*[rf]/.test(l) || /\b(drop|truncate)\s+(table|database)\b/i.test(l);
}
