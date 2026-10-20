// Small line-based syntax highlighter for the file viewer and review diffs. It only knows
// comments, strings, numbers and keywords, which is most of what makes code readable, and
// carries block-comment state from line to line.

const C_LIKE = 'break case catch class const continue default do else enum export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof undefined var void while with yield async await of as from interface type implements private public protected readonly declare namespace abstract';
const LANGS = {
  js: { kw: C_LIKE, line: '//', block: ['/*', '*/'], quotes: '"\'`' },
  json: { kw: 'true false null', quotes: '"' },
  css: { kw: 'important media import supports keyframes from to', block: ['/*', '*/'], quotes: '"\'' },
  py: { kw: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case', line: '#', quotes: '"\'' },
  sh: { kw: 'if then else elif fi for in do done while until case esac function return local export readonly echo exit set unset source', line: '#', quotes: '"\'' },
  go: { kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false', line: '//', block: ['/*', '*/'], quotes: '"\'`' },
  rs: { kw: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while None Some Ok Err', line: '//', block: ['/*', '*/'], quotes: '"' },
  c: { kw: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual template typename namespace using new delete true false nullptr bool include define', line: '//', block: ['/*', '*/'], quotes: '"\'' },
  rb: { kw: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require', line: '#', quotes: '"\'' },
  yaml: { kw: 'true false null yes no on off', line: '#', quotes: '"\'' },
  sql: { kw: 'select from where and or not insert into values update set delete create table index drop alter join left right inner outer on group by order having limit as distinct null is in like primary key', line: '--', block: ['/*', '*/'], quotes: '"\'' },
  html: { kw: '', block: ['<!--', '-->'], quotes: '"\'' },
};
const EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  json: 'json', jsonc: 'js',
  css: 'css', scss: 'css', less: 'css',
  py: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', env: 'sh',
  go: 'go', rs: 'rs',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', java: 'c', kt: 'c', swift: 'c', cs: 'c', php: 'c', dart: 'c', scala: 'c',
  rb: 'rb', yml: 'yaml', yaml: 'yaml', toml: 'yaml', sql: 'sql',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
};
const NAMES = { Dockerfile: 'sh', Makefile: 'sh', '.zshrc': 'sh', '.bashrc': 'sh', '.zprofile': 'sh', '.gitignore': 'sh', '.npmrc': 'sh', Caddyfile: 'sh' };

export function langOf(file) {
  const base = String(file || '').split('/').pop();
  if (NAMES[base]) return NAMES[base];
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return EXT[ext] || null;
}

const kwCache = new Map();
const kwSet = (lang) => {
  if (!kwCache.has(lang)) kwCache.set(lang, new Set(LANGS[lang].kw.split(' ').filter(Boolean)));
  return kwCache.get(lang);
};

// Highlights one line. Returns { tokens: [[class|null, text]], state } where state is
// carried into the next line (true while inside a block comment).
export function highlightLine(text, lang, inBlock = false) {
  const L = LANGS[lang];
  if (!L) return { tokens: [[null, text]], state: false };
  const kws = kwSet(lang);
  const tokens = [];
  const push = (cls, t) => {
    if (!t) return;
    const last = tokens[tokens.length - 1];
    if (last && last[0] === cls) last[1] += t;
    else tokens.push([cls, t]);
  };
  let i = 0;
  if (inBlock) {
    const end = text.indexOf(L.block[1]);
    if (end === -1) return { tokens: [['com', text]], state: true };
    push('com', text.slice(0, end + L.block[1].length));
    i = end + L.block[1].length;
  }
  while (i < text.length) {
    const rest = text.slice(i);
    if (L.line && rest.startsWith(L.line)) {
      push('com', rest);
      break;
    }
    if (L.block && rest.startsWith(L.block[0])) {
      const end = text.indexOf(L.block[1], i + L.block[0].length);
      if (end === -1) {
        push('com', rest);
        return { tokens, state: true };
      }
      push('com', text.slice(i, end + L.block[1].length));
      i = end + L.block[1].length;
      continue;
    }
    const ch = text[i];
    if (L.quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      push('str', text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const num = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)\b/i.exec(rest);
    if (num && !/[\w$]/.test(text[i - 1] || '')) {
      push('num', num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const cls = kws.has(lang === 'sql' ? w.toLowerCase() : w) ? 'kw' : text[i + w.length] === '(' ? 'fn' : /^[A-Z]/.test(w) && lang !== 'sql' ? 'type' : null;
      push(cls, w);
      i += w.length;
      continue;
    }
    push(null, ch);
    i++;
  }
  return { tokens, state: false };
}

export function highlightLines(lines, lang) {
  let state = false;
  return lines.map((line) => {
    const r = highlightLine(line, lang, state);
    state = r.state;
    return r.tokens;
  });
}
