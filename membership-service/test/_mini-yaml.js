/**
 * Tiny YAML reader for docs/membership/partner-api.openapi.yaml (no new
 * dependency). Supports exactly what that file uses: block mappings, block
 * sequences (of scalars or mappings), flow sequences [a, b], quoted and plain
 * scalars, comments. Anything else throws, so the doc cannot silently drift
 * into syntax this reader misparses.
 */
function scalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) { if (!s.endsWith('"') || s.length < 2) throw new Error('bad quoted scalar: ' + s); return JSON.parse(s); }
  if (s.startsWith("'")) { if (!s.endsWith("'")) throw new Error('bad quoted scalar: ' + s); return s.slice(1, -1).replace(/''/g, "'"); }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error('bad flow sequence: ' + s);
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x)) : [];
  }
  if (/^[>|{&*!]/.test(s)) throw new Error('unsupported YAML syntax: ' + s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitKey(text) {
  const m = text.match(/^("[^"]*"|'[^']*'|[^:]+?):(\s+(.*))?$/);
  if (!m) return null;
  return { key: String(scalar(m[1])), rest: m[3] ?? '' };
}

export function parseYaml(src) {
  const lines = src.split('\n').map(stripComment).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  for (const l of lines) if (/^\t/.test(l)) throw new Error('tabs are not allowed');
  let i = 0;
  const indent = (l) => l.match(/^ */)[0].length;

  function block(level) {
    const first = lines[i];
    if (first.trim().startsWith('- ') || first.trim() === '-') return seq(level);
    return map(level);
  }
  function map(level) {
    const out = {};
    while (i < lines.length && indent(lines[i]) === level && !lines[i].trim().startsWith('-')) {
      const kv = splitKey(lines[i].trim());
      if (!kv) throw new Error('expected key: ' + lines[i]);
      i++;
      if (kv.rest !== '') out[kv.key] = scalar(kv.rest);
      else if (i < lines.length && indent(lines[i]) > level) out[kv.key] = block(indent(lines[i]));
      else if (i < lines.length && indent(lines[i]) === level && lines[i].trim().startsWith('- ')) out[kv.key] = seq(level);
      else out[kv.key] = null;
    }
    return out;
  }
  function seq(level) {
    const out = [];
    while (i < lines.length && indent(lines[i]) === level && lines[i].trim().startsWith('-')) {
      const body = lines[i].trim().slice(1).trim();
      const kv = splitKey(body);
      if (kv && !body.startsWith('"')) {
        // "- key: value" starts a mapping item; continue at the item's own indent.
        const itemIndent = level + 2;
        lines[i] = ' '.repeat(itemIndent) + body;
        out.push(map(itemIndent));
      } else {
        i++;
        out.push(scalar(body));
      }
    }
    return out;
  }
  const doc = block(0);
  if (i !== lines.length) throw new Error('unparsed YAML from: ' + lines[i]);
  return doc;
}
