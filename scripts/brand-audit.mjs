#!/usr/bin/env node
/**
 * Brand audit — every case-sensitive "Gaia" in this repository, classified.
 *
 * The customer-facing brand is "Gaia Healers". This script finds each "Gaia"
 * and decides, without guessing per file, what it is:
 *
 *   OK_BRAND          already "Gaia Healers" (or "Gaia Healer", the certified
 *                     person title) — nothing to do
 *   KEEP_PROPER_NAME  a deliberate proper name that is not the platform:
 *                     Gaia Practitioners (partner platform), Gaia Assist / the
 *                     "Gaia" assistant character, … — see brand-allowlist.json
 *   TECHNICAL         not customer copy: code comments, console/log lines,
 *                     Python docstrings, AI prompt text, staff-only CRM notes,
 *                     identifiers. Never renamed.
 *   REPLACE           customer-facing copy where "Gaia" names the company /
 *                     platform / website — must read "Gaia Healers"
 *
 * Customer-facing text is extracted structurally, never by grepping lines:
 *   .html   text nodes + attribute values (title, alt, aria-label, content…);
 *           inline <script> is tokenised as JS, <style> and comments skipped
 *   .js     string and template-literal contents (comments and regex skipped)
 *   .py     string tokens via Python's own tokenizer (docstrings = TECHNICAL)
 *   .json / .webmanifest  values only (keys are identifiers)
 *   .svg    <text> contents
 *
 * Usage:
 *   node scripts/brand-audit.mjs                 # summary to stdout
 *   node scripts/brand-audit.mjs --csv out.csv   # full inventory
 *   node scripts/brand-audit.mjs --md  out.md    # REPLACE/KEEP listing
 *   node scripts/brand-audit.mjs --check         # exit 1 if any REPLACE remains
 *
 * No network, no paid calls. The guard test (tests/brand-consistency.test.cjs)
 * imports scan() from here, so the audit and the guard can never disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'brand-allowlist.json');

/* ------------------------------------------------------------------------ */
/* Which files are customer-facing                                           */
/* ------------------------------------------------------------------------ */

// Directories / files that never ship to a customer (tests, docs, internal
// tooling, design archives, vendored code, ops scripts, backups).
const EXCLUDE = [
  /^vendor\//, /(^|\/)node_modules\//, /^docs\//, /^design-reference\//,
  /(^|\/)tests?\//, /\.test\.(c?js|mjs|jsx?)$/, /(^|\/)test_[^/]*\.py$/,
  /^scripts\//, /^ops\//, /^staging-proxy\/(tools|scripts|deploy)\//,
  /^event-manager\/(docs|import|scripts)\//, /^event-manager\/backend\/patch_[^/]*\.py$/,
  /\.prephase\d*\.\d+-\d+$/, /\.bak/, /(^|\/)\.env/,
  /^event-manager\/frontend\/public\/vendor\//,
  /^design-qa\.md$/,
];
const EXT = /\.(html?|m?js|cjs|jsx|py|json|webmanifest|svg)$/;
// Markdown that is store / marketing copy rather than documentation.
const MD_COPY = new Set(['app-store/CAPTIONS.md']);

export function listFiles(root = ROOT) {
  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    files = walk(root, root);
  }
  return files.filter((f) => (EXT.test(f) || MD_COPY.has(f)) && !EXCLUDE.some((re) => re.test(f))
    && !/package(-lock)?\.json$/.test(f) && fs.existsSync(path.join(root, f)));
}
function walk(dir, root) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, root)); else out.push(path.relative(root, p));
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Extractors: each returns segments { kind, text, offset } where offset is  */
/* the character offset of text[0] in the file. kind: 'copy' (customer text) */
/* or a TECHNICAL reason.                                                     */
/* ------------------------------------------------------------------------ */

const REGEX_PREV = /[(,=:[!&|?{};+\-*%<>~^]$|(^|[^\w$.])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** Tokenise JavaScript; yields string / template-chunk / comment segments. */
export function jsSegments(src, base = 0) {
  const segs = [];
  let i = 0;
  const n = src.length;
  let lastSig = ''; // text of the last significant code chars (for regex detection)
  const stack = []; // template nesting: brace depth per open ${
  let braceDepth = 0;
  const pushCode = (s) => { lastSig = (lastSig + s).slice(-24).trimEnd() || lastSig; };

  function readString(q) {
    const start = i; i++;
    let text = '';
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { text += src[i] + (src[i + 1] || ''); i += 2; continue; }
      if (src[i] === '\n') break;
      text += src[i]; i++;
    }
    i++;
    segs.push({ kind: 'string', text, offset: base + start + 1 });
    lastSig = 'x';
  }
  function readTemplate() {
    // at a backtick or resuming after a closing } of ${...}
    let start = i;
    let text = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { text += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === '`') { segs.push({ kind: 'string', text, offset: base + start }); i++; lastSig = 'x'; return; }
      if (c === '$' && src[i + 1] === '{') {
        segs.push({ kind: 'string', text, offset: base + start });
        i += 2; stack.push(braceDepth); braceDepth = 0; lastSig = '{'; return;
      }
      text += c; i++;
    }
    segs.push({ kind: 'string', text, offset: base + start });
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i); const e = end < 0 ? n : end;
      segs.push({ kind: 'code comment', text: src.slice(i, e), offset: base + i }); i = e; continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2); const e = end < 0 ? n : end + 2;
      segs.push({ kind: 'code comment', text: src.slice(i, e), offset: base + i }); i = e; continue;
    }
    if (c === '"' || c === "'") { readString(c); continue; }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/' && (lastSig === '' || REGEX_PREV.test(lastSig))) {
      // regex literal
      let j = i + 1; let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++; while (j < n && /[a-z]/i.test(src[j])) j++;
      segs.push({ kind: 'regex literal', text: src.slice(i, j), offset: base + i });
      i = j; lastSig = 'x'; continue;
    }
    if (c === '{') { braceDepth++; pushCode(c); i++; continue; }
    if (c === '}') {
      if (stack.length && braceDepth === 0) { braceDepth = stack.pop(); i++; readTemplate(); continue; }
      braceDepth--; pushCode(c); i++; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    // identifiers / numbers / punctuation
    let j = i;
    if (/[\w$]/.test(c)) { while (j < n && /[\w$]/.test(src[j])) j++; } else j = i + 1;
    pushCode(src.slice(i, j)); i = j;
  }
  return segs;
}

/** HTML: text nodes + attribute values; inline <script> as JS. */
export function htmlSegments(src) {
  const segs = [];
  const re = /<!--[\s\S]*?-->|<script\b[^>]*>([\s\S]*?)<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|<\/[^>]+>/g;
  let last = 0; let m;
  while ((m = re.exec(src))) {
    if (m.index > last) segs.push({ kind: 'copy', text: src.slice(last, m.index), offset: last });
    const tok = m[0];
    if (tok.startsWith('<!--')) segs.push({ kind: 'html comment', text: tok, offset: m.index });
    else if (/^<script/i.test(tok)) {
      const open = tok.indexOf('>') + 1;
      const isJson = /type\s*=\s*["']application\/(ld\+)?json/i.test(tok.slice(0, open));
      const body = m[1] || '';
      if (isJson) segs.push(...jsonSegments(body, m.index + open));
      else segs.push(...jsSegments(body, m.index + open).map(toCopy));
    } else if (/^<style/i.test(tok)) { /* skip */ } else if (m[3]) {
      const attrRe = /([^\s=>/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a; const attrs = m[3]; const aBase = m.index + 1 + m[2].length;
      while ((a = attrRe.exec(attrs))) {
        const name = a[1].toLowerCase();
        const val = a[3] ?? a[4] ?? a[5];
        if (val == null) continue;
        const vOff = aBase + a.index + a[0].indexOf(val, a[1].length);
        const technical = /^(class|id|href|src|srcset|style|for|name|type|rel|data-[\w-]+|on\w+|action|method|role|xmlns.*|viewbox|d|fill|stroke)$/.test(name)
          && !/^data-([\w-]*-)?(label|title|tooltip|text)$/.test(name);
        segs.push({ kind: technical ? `attribute ${name}` : 'copy', text: val, offset: vOff });
      }
    }
    last = m.index + tok.length;
  }
  if (last < src.length) segs.push({ kind: 'copy', text: src.slice(last), offset: last });
  return segs;
}
const toCopy = (s) => (s.kind === 'string' ? { ...s, kind: 'copy' } : s);

/** JSON: keys are identifiers; values are copy only under a display key. */
const JSON_COPY_KEYS = /^(name|short_name|description|title|label|text|summary|body|subtitle|cta|message|reason|member_reason|why|headline|caption|alt|placeholder|button|kicker|lede)$/i;
export function jsonSegments(src, base = 0) {
  let lastKey = '';
  return jsSegments(src, base).map((s) => {
    if (s.kind !== 'string') return s;
    const after = src.slice(s.offset - base + s.text.length + 1).match(/^\s*(.)/);
    if (after && after[1] === ':') { lastKey = s.text; return { ...s, kind: 'JSON key' }; }
    return JSON_COPY_KEYS.test(lastKey) ? { ...s, kind: 'copy' } : { ...s, kind: `JSON internal field "${lastKey}"` };
  });
}

/** SVG: <text>/<tspan> contents only. */
export function svgSegments(src) {
  const segs = []; const re = /<(text|tspan|title)\b[^>]*>([^<]*)/g; let m;
  while ((m = re.exec(src))) segs.push({ kind: 'copy', text: m[2], offset: m.index + m[0].length - m[2].length });
  return segs;
}

/** Python: string tokens from the real tokenizer; docstrings are TECHNICAL. */
const PY_HELPER = String.raw`
import sys, tokenize, io, json
src = open(sys.argv[1], encoding='utf-8').read()
lines = src.splitlines(keepends=True)
starts = [0]
for l in lines: starts.append(starts[-1] + len(l))
out = []
toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
SKIP = {tokenize.NL, tokenize.COMMENT, tokenize.INDENT, tokenize.DEDENT}
sig = [t for t in toks if t.type not in SKIP]
for k, t in enumerate(sig):
    kind = None
    if t.type == tokenize.STRING: kind = 'string'
    elif getattr(tokenize, 'FSTRING_MIDDLE', -1) == t.type: kind = 'string'
    if not kind: continue
    prev = sig[k-1] if k else None
    nxt = sig[k+1] if k + 1 < len(sig) else None
    doc = t.type == tokenize.STRING and (prev is None or prev.type in (tokenize.NEWLINE,) or (prev.type == tokenize.OP and prev.string == ':')) and (nxt is None or nxt.type in (tokenize.NEWLINE, tokenize.ENDMARKER))
    off = starts[t.start[0]-1] + t.start[1]
    out.append([off, t.string, 'docstring' if doc else 'string'])
for t in toks:
    if t.type == tokenize.COMMENT:
        out.append([starts[t.start[0]-1] + t.start[1], t.string, 'code comment'])
print(json.dumps(out))
`;
export function pySegments(file) {
  const raw = execFileSync('python3', ['-I', '-c', PY_HELPER, file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(raw).map(([offset, text, kind]) => ({ kind: kind === 'string' ? 'string' : kind, text, offset }));
}

/* ------------------------------------------------------------------------ */
/* Classification                                                             */
/* ------------------------------------------------------------------------ */

export function loadAllowlist(p = ALLOWLIST_PATH) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const compile = (list, cls) => (list || []).map((e) => ({
    ...e, cls, re: new RegExp(e.pattern, 'g'),
    fileRe: e.files ? new RegExp(e.files) : null,
  }));
  return [
    ...compile(raw.ok, 'OK_BRAND'),
    ...compile(raw.keep, 'KEEP_PROPER_NAME'),
    ...compile(raw.technical, 'TECHNICAL'),
  ];
}

const lineCol = (src) => {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
  return (off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
};

// A JS string is console/log output when the call opening it is console.*
const LOG_CALL = /(console\.(log|warn|error|info|debug)|\blog(ger)?\.(info|warn|error|debug)|\bdebugLog|\blogEvent|\bwarnOnce|\bprint)\s*\(\s*$/;

/**
 * Scan the repository (or a set of {file, src} overrides) and return every
 * "Gaia" occurrence with its class and reason.
 */
export function scan({ root = ROOT, files = null, sources = null, allowlist = null } = {}) {
  const rules = allowlist || loadAllowlist();
  const list = files || listFiles(root);
  const results = [];
  for (const file of list) {
    const abs = path.join(root, file);
    const src = sources && sources[file] != null ? sources[file] : fs.readFileSync(abs, 'utf8');
    if (!/Gaia|GAIA/.test(src)) continue;
    let segs;
    if (/\.html?$/.test(file)) segs = htmlSegments(src);
    else if (/\.(m?js|cjs|jsx)$/.test(file)) segs = jsSegments(src);
    else if (/\.py$/.test(file)) {
      if (sources && sources[file] != null) {
        const tmp = path.join(fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'brand-')), 'x.py');
        fs.writeFileSync(tmp, src); segs = pySegments(tmp);
      } else segs = pySegments(abs);
    } else if (/\.(json|webmanifest)$/.test(file)) segs = jsonSegments(src);
    else if (/\.svg$/.test(file)) segs = svgSegments(src);
    else segs = [{ kind: 'copy', text: src, offset: 0 }]; // store-copy markdown
    const line = lineCol(src);
    for (const seg of segs) {
      if (!/Gaia|GAIA/.test(seg.text)) continue;
      let baseKind = seg.kind;
      if (baseKind === 'string') {
        // JS / Python string: customer copy unless it is log output
        const before = src.slice(Math.max(0, seg.offset - 80), seg.offset - 1);
        baseKind = LOG_CALL.test(before) ? 'console/log output' : 'copy';
      }
      const re = /Gaia|GAIA/g; let m;
      while ((m = re.exec(seg.text))) {
        // skip identifiers such as GaiaShell, window.GaiaUI, data-Gaia…
        const prevCh = seg.text[m.index - 1] || ' ';
        const nextCh = seg.text[m.index + 4] || ' ';
        const off = seg.offset + m.index;
        const snippet = seg.text.slice(Math.max(0, m.index - 50), m.index + 60).replace(/\s+/g, ' ').trim();
        const rec = { file, line: line(off), offset: off, snippet };
        if (/[\w$.-]/.test(prevCh) && prevCh !== '.' || /[A-Za-z0-9_$]/.test(nextCh)) {
          // e.g. "GaiaUI", "myGaia" — part of an identifier
          results.push({ ...rec, cls: 'TECHNICAL', reason: 'identifier' });
          continue;
        }
        if (baseKind !== 'copy') { results.push({ ...rec, cls: 'TECHNICAL', reason: baseKind }); continue; }
        let hit = null;
        for (const r of rules) {
          if (r.fileRe && !r.fileRe.test(file)) continue;
          r.re.lastIndex = 0; let mm;
          while ((mm = r.re.exec(seg.text))) {
            if (mm.index <= m.index && m.index < mm.index + mm[0].length) { hit = r; break; }
            if (mm[0].length === 0) r.re.lastIndex++;
          }
          if (hit) break;
        }
        if (hit) results.push({ ...rec, cls: hit.cls, reason: hit.reason });
        else results.push({ ...rec, cls: 'REPLACE', reason: '"Gaia" names the company/platform in customer copy' });
      }
    }
  }
  return results;
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                        */
/* ------------------------------------------------------------------------ */

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
function summary(results) {
  const counts = {};
  for (const r of results) counts[r.cls] = (counts[r.cls] || 0) + 1;
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const results = scan();
  const counts = summary(results);
  const opt = (name) => { const k = args.indexOf(name); return k >= 0 ? args[k + 1] : null; };
  if (opt('--csv')) {
    const rows = ['file,line,class,reason,snippet', ...results.map((r) => [r.file, r.line, r.cls, r.reason, r.snippet].map(csvCell).join(','))];
    fs.writeFileSync(opt('--csv'), rows.join('\n') + '\n');
  }
  if (opt('--md')) {
    const md = ['| file:line | class | reason | snippet |', '|---|---|---|---|',
      ...results.filter((r) => r.cls === 'REPLACE' || r.cls === 'KEEP_PROPER_NAME')
        .map((r) => `| ${r.file}:${r.line} | ${r.cls} | ${r.reason} | ${r.snippet.replace(/\|/g, '\\|')} |`)];
    fs.writeFileSync(opt('--md'), md.join('\n') + '\n');
  }
  if (args.includes('--list')) {
    for (const r of results.filter((x) => x.cls === (opt('--list') || 'REPLACE'))) console.log(`${r.file}:${r.line}\t${r.snippet}`);
  }
  const byReason = {};
  for (const r of results) { const k = `${r.cls} · ${r.reason}`; byReason[k] = (byReason[k] || 0) + 1; }
  console.log(JSON.stringify({ total: results.length, counts, byReason }, null, 2));
  if (args.includes('--check') && counts.REPLACE) process.exit(1);
}
