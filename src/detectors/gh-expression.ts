// The GitHub Actions expression subset ci-tampering folds, and the reading of a
// `${{ }}` inside a command. Shared with the invocation module so a check line's
// canonical form can be computed without a circular import.

/** A `${{ }}` expression inside a command, read as the runner reads it: folded to
 *  its constant when it has one (`${{ 'unit' }}` is the literal `unit`), otherwise a
 *  single opaque token — one that says whether the value comes from the matrix, the
 *  strategy or a workflow input (the job runs once per value; the whole set is run)
 *  or from anywhere else. Tokenising the raw text read `}}/4` of
 *  `--shard=${{ matrix.shard }}/4` as a path-shaped positional and
 *  `--project=${{ matrix.project }}` as a project narrowed by hand. */
export function foldExpressions(s: string): string {
  return s.replace(/\$\{\{([^}]*)\}\}/g, (_m, e: string) => {
    const v = foldConst(e.trim());
    if (v !== undefined && v !== TRUTHY) return String(v);
    return /\b(?:matrix|strategy|inputs)\./.test(e) ? MATRIX_TOKEN : EXPR_TOKEN;
  });
}
export const EXPR_TOKEN = '__expr__';
export const MATRIX_TOKEN = '__matrix__';

// ── a constant folder for the expression subset that has no context reference ──
//
// GitHub evaluates `if:` and `continue-on-error:` as expressions. Literals, `==`,
// `!=`, `&&`, `||`, `!` and parentheses fold to a value here; an identifier, a
// context reference or a function call is UNKNOWN — but `&&` and `||` short-circuit
// on the KNOWN side exactly as they do at runtime: `unknown && false` is always
// falsy and `unknown || true` always truthy, whatever the context holds. An unknown
// that survives reads as reachable — the same exposure as authoring a new guarded
// step.
export const TRUTHY = Symbol('truthy'); // a value not known, except that it is truthy
export type Val = string | number | boolean | null | typeof TRUTHY;
type Tok = { t: 'str' | 'num' | 'id' | 'op'; v: string };

function lex(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else s += src[j++];
      }
      if (j >= src.length) return null;
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = src.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const op = src.slice(i).match(/^(?:==|!=|&&|\|\||<=|>=|[!()<>,[\]])/);
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][\w.\-*]*/);
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    return null;
  }
  return out;
}

export const truthy = (v: Val): boolean => (v === TRUTHY ? true : typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 : v === true);

/** Fold an expression to a constant; undefined when it depends on anything. */
/** Fold an expression to a constant; undefined when it depends on anything. */
export function foldConst(src: string): Val | undefined {
  const toks = lex(src);
  if (!toks) return undefined;
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => (toks[p]?.t === 'op' && toks[p].v === v ? (p++, true) : false);
  const num = (v: Val): number =>
    v === TRUTHY ? NaN : typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : v === null ? 0 : v.trim() === '' ? 0 : Number(v);
  const eq = (a: Val, b: Val): boolean | undefined => {
    if (a === TRUTHY || b === TRUTHY) return undefined;
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if (a === null && b === null) return true;
    const x = num(a);
    const y = num(b);
    return !Number.isNaN(x) && x === y;
  };
  const or = (): Val | undefined => {
    let l = and();
    while (eat('||')) {
      const r = and();
      if (l !== undefined && truthy(l)) continue; // a truthy left decides
      if (l !== undefined) l = r; // a falsy left yields the right
      else l = r !== undefined && truthy(r) ? TRUTHY : undefined; // unknown || truthy is truthy
    }
    return l;
  };
  const and = (): Val | undefined => {
    let l = cmp();
    while (eat('&&')) {
      const r = cmp();
      if (l !== undefined && !truthy(l)) continue; // a falsy left decides
      if (l !== undefined) l = r; // a truthy left yields the right
      else l = r !== undefined && !truthy(r) ? false : undefined; // unknown && falsy is falsy
    }
    return l;
  };
  const cmp = (): Val | undefined => {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !/^(?:==|!=|<|>|<=|>=)$/.test(t.v)) return l;
      p++;
      const r = unary();
      if (l === undefined || r === undefined) {
        l = undefined;
        continue;
      }
      if (t.v === '==' || t.v === '!=') {
        const e = eq(l, r);
        l = e === undefined ? undefined : t.v === '==' ? e : !e;
      } else {
        const x = num(l);
        const y = num(r);
        if (Number.isNaN(x) || Number.isNaN(y)) l = undefined;
        else l = t.v === '<' ? x < y : t.v === '>' ? x > y : t.v === '<=' ? x <= y : x >= y;
      }
    }
  };
  const unary = (): Val | undefined => {
    if (eat('!')) {
      const v = unary();
      return v === undefined ? undefined : !truthy(v);
    }
    return primary();
  };
  const primary = (): Val | undefined => {
    const t = peek();
    if (!t) return undefined;
    if (eat('(')) {
      const v = or();
      return eat(')') ? v : undefined;
    }
    p++;
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'id') {
      if (/^true$/i.test(t.v)) return true;
      if (/^false$/i.test(t.v)) return false;
      if (/^null$/i.test(t.v)) return null;
      // a function call: its arguments are consumed so the operators AROUND it still
      // fold; a call over CONSTANTS folds to its value (`contains('a', 'b')` is false,
      // `fromJSON('false')` is false — issue #436), any other call yields unknown
      if (eat('(')) {
        const args: Array<Val | undefined> = [];
        if (!eat(')')) {
          for (;;) {
            args.push(or());
            if (eat(')')) break;
            if (!eat(',')) return undefined;
          }
        }
        let indexed = false;
        while (eat('[')) {
          or();
          indexed = true;
          if (!eat(']')) return undefined;
        }
        if (indexed) return undefined;
        return callConst(t.v, args);
      }
      while (eat('[')) {
        or();
        if (!eat(']')) return undefined;
      }
      return undefined;
    }
    return undefined;
  };
  const v = or();
  return p === toks.length ? v : undefined;
}

/** GitHub's expression functions over constant arguments, evaluated as the runner
 *  does: string comparison is case-insensitive, a non-string is coerced the way
 *  `format` prints it, `fromJSON` yields a primitive or (for an object/array) an
 *  unknown-but-truthy value. Any unknown argument keeps the call unknown. */
function callConst(name: string, args: Array<Val | undefined>): Val | undefined {
  const vals: Array<string | number | boolean | null> = [];
  for (const a of args) {
    if (a === undefined || a === TRUTHY) return undefined;
    vals.push(a);
  }
  const s = (i: number): string => (vals[i] == null ? '' : String(vals[i]));
  switch (name.toLowerCase()) {
    case 'contains':
      return vals.length === 2 ? s(0).toLowerCase().includes(s(1).toLowerCase()) : undefined;
    case 'startswith':
      return vals.length === 2 ? s(0).toLowerCase().startsWith(s(1).toLowerCase()) : undefined;
    case 'endswith':
      return vals.length === 2 ? s(0).toLowerCase().endsWith(s(1).toLowerCase()) : undefined;
    case 'format': {
      if (vals.length < 1) return undefined;
      return s(0).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, i: string | undefined) => (m === '{{' ? '{' : m === '}}' ? '}' : s(Number(i) + 1)));
    }
    case 'join':
      return vals.length >= 1 && vals.length <= 2 ? s(0) : undefined;
    case 'tojson':
      return vals.length === 1 ? JSON.stringify(vals[0]) : undefined;
    case 'fromjson': {
      if (vals.length !== 1) return undefined;
      try {
        const v: unknown = JSON.parse(s(0));
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
        return TRUTHY; // an object or an array: truthy, its contents not ours to read
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}
