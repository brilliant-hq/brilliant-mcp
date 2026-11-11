// config_editors.js: pure, dependency-free JSON/JSONC/TOML text-surgery editors
// used by the `install <client>` subcommand. A faithful port of the desktop
// app's own config editors, so the two surfaces
// (desktop URL toggles, npx stdio installer) share identical merge semantics:
//
//   1. Comment preservation. VS Code (mcp.json) and Zed (settings.json) are
//      JSONC: a decode→re-encode would strip user comments. We edit raw text so
//      foreign comments/formatting survive.
//   2. Byte-stability. Enable-then-disable on a config carrying foreign servers
//      returns the original bytes: upsert inserts our member as the container's
//      FIRST member and remove deletes exactly that span (exact inverses).
//
// The editors never touch, reorder, or reformat any member that isn't ours.
// Everything here is string-only (no fs, no process) so it is trivially testable
// against string fixtures: mirror of the Dart doc comment.

// ===========================================================================
// JSON / JSONC
// ===========================================================================

/** Insert or replace `containerPath -> memberKey = memberValue` in `source`,
 *  creating missing container objects (and the whole document when `source` is
 *  blank). Foreign members and, when `jsonc`, comments are preserved verbatim. */
export function upsertJsonMember(source, {
  containerPath,
  memberKey,
  memberValue,
  jsonc,
  indentSize = 2,
}) {
  if (source.trim().length === 0) {
    let nested = { [memberKey]: memberValue };
    for (const seg of [...containerPath].reverse()) nested = { [seg]: nested };
    return _encodeValue(nested, "", indentSize) + "\n";
  }
  const rootOpen = _skipWs(source, 0, jsonc);
  if (rootOpen >= source.length || source[rootOpen] !== "{") {
    let nested = { [memberKey]: memberValue };
    for (const seg of [...containerPath].reverse()) nested = { [seg]: nested };
    return _encodeValue(nested, "", indentSize) + "\n";
  }
  return _upsertInObject(
    source, rootOpen, containerPath, memberKey, memberValue, jsonc, indentSize);
}

/** Remove `containerPath -> memberKey` from `source` if present, collapsing any
 *  container objects that we would have created and that are now empty. Foreign
 *  members are never touched. */
export function removeJsonMember(source, { containerPath, memberKey, jsonc }) {
  if (source.trim().length === 0) return source;
  const rootOpen = _skipWs(source, 0, jsonc);
  if (rootOpen >= source.length || source[rootOpen] !== "{") return source;

  let cur = _removeAtPath(source, containerPath, memberKey, jsonc);
  for (let depth = containerPath.length; depth >= 1; depth--) {
    const path = containerPath.slice(0, depth);
    if (_objectAtPathIsEmpty(cur, path, jsonc)) {
      cur = _removeAtPath(cur, path.slice(0, depth - 1), path[path.length - 1], jsonc);
    } else {
      break;
    }
  }
  return cur;
}

/** Decode the value at `containerPath -> memberKey`, or null when absent. */
export function readJsonMember(source, { containerPath, memberKey, jsonc }) {
  if (source.trim().length === 0) return null;
  let i = _skipWs(source, 0, jsonc);
  if (i >= source.length || source[i] !== "{") return null;
  let objOpen = i;
  for (const seg of containerPath) {
    const objClose = _matchDelim(source, objOpen, jsonc);
    const m = _findMember(source, objOpen, objClose, seg, jsonc);
    if (m == null || source[m.valStart] !== "{") return null;
    objOpen = m.valStart;
  }
  const objClose = _matchDelim(source, objOpen, jsonc);
  const m = _findMember(source, objOpen, objClose, memberKey, jsonc);
  if (m == null) return null;
  return _decode(source.slice(m.valStart, m.valEnd), jsonc);
}

// --- JSON internals --------------------------------------------------------

class _Member {
  constructor(keyStart, valStart, valEnd) {
    this.keyStart = keyStart;
    this.valStart = valStart;
    this.valEnd = valEnd;
  }
}

function _upsertInObject(s, objOpen, path, memberKey, value, jsonc, step) {
  const objClose = _matchDelim(s, objOpen, jsonc);
  if (path.length === 0) {
    const existing = _findMember(s, objOpen, objClose, memberKey, jsonc);
    const mi = _memberIndent(s, objOpen, objClose, jsonc, step);
    const valueText = _encodeValue(value, mi, step);
    if (existing != null) {
      return s.slice(0, existing.valStart) + valueText + s.slice(existing.valEnd);
    }
    return _insertFirstMember(s, objOpen, objClose, memberKey, valueText, mi, jsonc);
  }
  const head = path[0];
  const rest = path.slice(1);
  const member = _findMember(s, objOpen, objClose, head, jsonc);
  if (member != null && s[member.valStart] === "{") {
    return _upsertInObject(s, member.valStart, rest, memberKey, value, jsonc, step);
  }
  const mi = _memberIndent(s, objOpen, objClose, jsonc, step);
  let nested = { [memberKey]: value };
  for (const seg of [...rest].reverse()) nested = { [seg]: nested };
  const valueText = _encodeValue(nested, mi, step);
  if (member != null) {
    return s.slice(0, member.valStart) + valueText + s.slice(member.valEnd);
  }
  return _insertFirstMember(s, objOpen, objClose, head, valueText, mi, jsonc);
}

function _removeAtPath(s, path, memberKey, jsonc) {
  let objOpen = _skipWs(s, 0, jsonc);
  if (objOpen >= s.length || s[objOpen] !== "{") return s;
  for (const seg of path) {
    const objClose = _matchDelim(s, objOpen, jsonc);
    const m = _findMember(s, objOpen, objClose, seg, jsonc);
    if (m == null || s[m.valStart] !== "{") return s;
    objOpen = m.valStart;
  }
  const objClose = _matchDelim(s, objOpen, jsonc);
  const m = _findMember(s, objOpen, objClose, memberKey, jsonc);
  if (m == null) return s;
  return _spliceRemoveMember(s, objOpen, objClose, m, jsonc);
}

function _objectAtPathIsEmpty(s, path, jsonc) {
  let objOpen = _skipWs(s, 0, jsonc);
  if (objOpen >= s.length || s[objOpen] !== "{") return false;
  for (const seg of path) {
    const objClose = _matchDelim(s, objOpen, jsonc);
    const m = _findMember(s, objOpen, objClose, seg, jsonc);
    if (m == null || s[m.valStart] !== "{") return false;
    objOpen = m.valStart;
  }
  const objClose = _matchDelim(s, objOpen, jsonc);
  const first = _skipWs(s, objOpen + 1, jsonc);
  return first >= objClose;
}

function _spliceRemoveMember(s, objOpen, objClose, m, jsonc) {
  const after = _skipWs(s, m.valEnd, jsonc);
  const hasTrailingComma = after < objClose && s[after] === ",";
  if (hasTrailingComma) {
    let lineStart = m.keyStart;
    while (lineStart > objOpen + 1 &&
        (s[lineStart - 1] === " " || s[lineStart - 1] === "\t")) {
      lineStart--;
    }
    if (lineStart > objOpen + 1 && s[lineStart - 1] === "\n") {
      lineStart--;
      if (lineStart > objOpen + 1 && s[lineStart - 1] === "\r") lineStart--;
    }
    return s.slice(0, lineStart) + s.slice(after + 1);
  }
  // Last member: consume the preceding comma instead.
  let prec = m.keyStart - 1;
  while (prec > objOpen &&
      (s[prec] === " " || s[prec] === "\t" || s[prec] === "\n" || s[prec] === "\r")) {
    prec--;
  }
  if (prec > objOpen && s[prec] === ",") {
    return s.slice(0, prec) + s.slice(m.valEnd);
  }
  // Only member.
  return s.slice(0, objOpen + 1) + s.slice(objClose);
}

function _findMember(s, objOpen, objClose, key, jsonc) {
  let i = _skipWs(s, objOpen + 1, jsonc);
  while (i < objClose) {
    if (s[i] !== '"') break;
    const keyStart = i;
    const keyEnd = _skipString(s, i);
    const decodedKey = JSON.parse(s.slice(keyStart, keyEnd));
    let j = _skipWs(s, keyEnd, jsonc);
    if (j >= s.length || s[j] !== ":") break;
    j++;
    const valStart = _skipWs(s, j, jsonc);
    const valEnd = _skipValue(s, valStart, jsonc);
    if (decodedKey === key) return new _Member(keyStart, valStart, valEnd);
    let k = _skipWs(s, valEnd, jsonc);
    if (k < objClose && s[k] === ",") {
      k = _skipWs(s, k + 1, jsonc);
    }
    i = k;
  }
  return null;
}

function _insertFirstMember(s, objOpen, objClose, key, valueText, mi, jsonc) {
  const first = _skipWs(s, objOpen + 1, jsonc);
  const keyText = JSON.stringify(key);
  if (first >= objClose) {
    const closeIndent = _lineIndentAt(s, objOpen);
    const body = "\n" + mi + keyText + ": " + valueText + "\n" + closeIndent;
    return s.slice(0, objOpen + 1) + body + s.slice(objClose);
  }
  const insertion = "\n" + mi + keyText + ": " + valueText + ",";
  return s.slice(0, objOpen + 1) + insertion + s.slice(objOpen + 1);
}

function _memberIndent(s, objOpen, objClose, jsonc, step) {
  const first = _skipWs(s, objOpen + 1, jsonc);
  if (first < objClose && s[first] === '"') return _lineIndentAt(s, first);
  return _lineIndentAt(s, objOpen) + " ".repeat(step);
}

function _lineIndentAt(s, pos) {
  let start = pos;
  while (start > 0 && s[start - 1] !== "\n") start--;
  let e = start;
  while (e < s.length && (s[e] === " " || s[e] === "\t")) e++;
  return s.slice(start, e);
}

function _skipWs(s, i, jsonc) {
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (jsonc && c === "/" && i + 1 < s.length &&
        (s[i + 1] === "/" || s[i + 1] === "*")) {
      i = _skipComment(s, i);
      continue;
    }
    break;
  }
  return i;
}

function _skipComment(s, i) {
  if (s[i + 1] === "/") {
    i += 2;
    while (i < s.length && s[i] !== "\n") i++;
    return i;
  }
  i += 2;
  while (i + 1 < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
  return i + 2 <= s.length ? i + 2 : s.length;
}

function _skipString(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  throw new Error("Unterminated string");
}

function _matchDelim(s, open, jsonc) {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      i = _skipString(s, i);
      continue;
    }
    if (jsonc && c === "/" && i + 1 < s.length &&
        (s[i + 1] === "/" || s[i + 1] === "*")) {
      i = _skipComment(s, i);
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("Unbalanced delimiter");
}

function _skipValue(s, i, jsonc) {
  const c = s[i];
  if (c === '"') return _skipString(s, i);
  if (c === "{" || c === "[") return _matchDelim(s, i, jsonc) + 1;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "," || ch === "}" || ch === "]" || ch === " " ||
        ch === "\t" || ch === "\n" || ch === "\r") {
      break;
    }
    if (jsonc && ch === "/" && j + 1 < s.length &&
        (s[j + 1] === "/" || s[j + 1] === "*")) {
      break;
    }
    j++;
  }
  return j;
}

function _decode(text, jsonc) {
  return JSON.parse(jsonc ? _stripComments(text) : text);
}

function _stripComments(s) {
  let buf = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      const end = _skipString(s, i);
      buf += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && i + 1 < s.length && (s[i + 1] === "/" || s[i + 1] === "*")) {
      const end = _skipComment(s, i);
      if (s[i + 1] === "/") buf += "\n";
      i = end;
      continue;
    }
    buf += c;
    i++;
  }
  return buf;
}

function _encodeValue(v, indent, step) {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    const inner = indent + " ".repeat(step);
    const entries = keys.map((k) =>
      inner + JSON.stringify(k) + ": " + _encodeValue(v[k], inner, step));
    return "{\n" + entries.join(",\n") + "\n" + indent + "}";
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const inner = indent + " ".repeat(step);
    const items = v.map((e) => inner + _encodeValue(e, inner, step));
    return "[\n" + items.join(",\n") + "\n" + indent + "]";
  }
  return JSON.stringify(v);
}

// ===========================================================================
// TOML (Codex `config.toml`)
// ===========================================================================

/** Upsert `[table.name]` with an ordered set of key/value `entries`, preserving
 *  every other section, comment, and whitespace run verbatim. `entries` is an
 *  insertion-ordered object; string values render as `key = "v"`, arrays of
 *  strings as `key = ["a", "b"]`. (The desktop TOML adapter writes a single
 *  `url`; the stdio installer writes `command`/`args`: same section surgery.) */
export function upsertTomlSection(source, { table, name, entries }) {
  const header = "[" + table + "." + name + "]";
  const block = header + "\n" + _tomlBody(entries);
  if (source.trim().length === 0) return block;

  const lines = source.split("\n");
  const [start, end] = _tomlSectionBounds(lines, header);
  if (start < 0) {
    let buf = source;
    if (!source.endsWith("\n")) buf += "\n";
    if (!source.endsWith("\n\n")) buf += "\n";
    buf += block;
    return buf;
  }
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  let buf = "";
  if (before.length > 0) {
    buf += before;
    if (!before.endsWith("\n")) buf += "\n";
  }
  buf += block;
  if (after.length > 0) {
    if (!after.startsWith("\n")) buf += "\n";
    buf += after;
  }
  return buf;
}

/** Remove the `[table.name]` section (header + body up to the next section or
 *  EOF), leaving all other sections intact. Exact inverse of an append-upsert. */
export function removeTomlSection(source, { table, name }) {
  const header = "[" + table + "." + name + "]";
  const lines = source.split("\n");
  const [start, end] = _tomlSectionBounds(lines, header);
  if (start < 0) return source;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  if (before.length === 0) return after;
  if (after.length === 0) return before.endsWith("\n") ? before : before + "\n";
  const sep = before.endsWith("\n") ? "" : "\n";
  return before + sep + after;
}

/** Read the full `[table.name]` body as an ordered object of parsed values
 *  (string or string[]), or null when the section is absent. Used to detect an
 *  already-configured entry so `install` can no-op instead of rewriting. */
export function readTomlSection(source, { table, name }) {
  const header = "[" + table + "." + name + "]";
  const lines = source.split("\n");
  const [start, end] = _tomlSectionBounds(lines, header);
  if (start < 0) return null;
  const out = {};
  for (let i = start + 1; i < end; i++) {
    const t = lines[i].trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const rawVal = t.slice(eq + 1).trim();
    out[key] = _parseTomlValue(rawVal);
  }
  return out;
}

function _parseTomlValue(raw) {
  const str = /^"([^"]*)"$/.exec(raw);
  if (str) return str[1];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((p) => {
      const m = /^\s*"([^"]*)"\s*$/.exec(p);
      return m ? m[1] : p.trim();
    });
  }
  return raw;
}

function _tomlBody(entries) {
  let out = "";
  for (const key of Object.keys(entries)) {
    out += key + " = " + _tomlValue(entries[key]) + "\n";
  }
  return out;
}

function _tomlValue(v) {
  if (Array.isArray(v)) {
    return "[" + v.map((e) => JSON.stringify(String(e))).join(", ") + "]";
  }
  return JSON.stringify(String(v));
}

/** Returns `[startLine, endLineExclusive]` for the section headed by `header`,
 *  or `[-1, -1]` when absent. The body runs until the next `[...]` header. */
function _tomlSectionBounds(lines, header) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t.startsWith("[") && t.endsWith("]")) {
          end = j;
          break;
        }
      }
      return [i, end];
    }
  }
  return [-1, -1];
}
