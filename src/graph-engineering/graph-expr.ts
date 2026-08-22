/**
 * Graph Expr — variable-reference resolver + condition-expression evaluator.
 *
 * Pure functions, no I/O. Shared by the runner (constructing node inputs from
 * ${var} templates) and the scheduler (deciding whether a conditional edge is
 * active). Designed for unit testing in isolation (TC for C1).
 *
 * Safety first: the evaluator is deliberately NOT Turing-complete. It supports
 * ${path} variable lookup + comparison (== != > < >= <=) + boolean logic
 * (&& || !). It does NOT use eval / Function / new Function — only a hand-rolled
 * recursive-descent parser over a fixed operator whitelist, so untrusted graph
 * DSL cannot escape into arbitrary code execution.
 *
 * See docs/tech_solution/graph-task-planning-execution/SOLUTION.md §3.
 */

/**
 * Build an EvalContext from a shared graph state. Node outputs are persisted
 * in state under `node_<id>_output` keys (by the runner); this helper rehydrates
 * them into the `node.<id>.output` shape the ${var} references expect, so the
 * runner and scheduler can resolve `${node_a.output.summary}` without a
 * separate node-output store. Branch decisions live under `__branch_<id>`.
 */
export function buildEvalContext(
  state: Record<string, unknown>,
  graphInput: Record<string, unknown> = {},
): EvalContext {
  const node: Record<string, { output: unknown; status: string }> = {};
  for (const [k, v] of Object.entries(state)) {
    const m = /^node_(.+)_output$/.exec(k);
    if (m) {
      node[m[1]] = { output: v, status: typeof state[`__branch_${m[1]}`] === 'string' ? 'completed' : 'completed' };
    }
  }
  return { graph: { input: graphInput }, state, node };
}
export interface EvalContext {
  /** Graph-level input declared by the 'start' node. */
  graph: { input: Record<string, unknown> };
  /** Shared mutable graph state (node_<id>_output, branch decisions, etc.). */
  state: Record<string, unknown>;
  /** Per-node outputs + runtime status, keyed by node id. */
  node: Record<string, { output: unknown; status: string }>;
}

/**
 * Resolve a ${...} template string against the context.
 * - ${graph.input.topic}      → ctx.graph.input.topic
 * - ${node_a.output.summary} → ctx.node['node_a'].output.summary
 * - ${state.some_key}        → ctx.state.some_key
 * - ${node_a.status}         → ctx.node['node_a'].status
 * Unknown paths resolve to the empty string (so prompts degrade gracefully).
 */
export function resolveExpr(template: string, ctx: EvalContext): string {
  if (typeof template !== 'string' || !template.includes('${')) return template;
  return template.replace(/\$\{([^}]+)\}/g, (_m, path: string) => {
    const val = resolvePath(path.trim(), ctx);
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val).slice(0, 8000);
      } catch {
        return '';
      }
    }
    return String(val);
  });
}

/**
 * Recursively resolve a ${var} reference inside an arbitrary JSON-ish value.
 * Strings get resolveExpr; arrays/objects recurse; primitives pass through.
 */
export function resolveValue<T>(value: T, ctx: EvalContext): T {
  if (typeof value === 'string') return resolveExpr(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}

/** Resolve a dotted path like "node_a.output.summary" against the context. */
function resolvePath(path: string, ctx: EvalContext): unknown {
  const parts = path.split('.');
  if (parts.length === 0) return undefined;
  let cur: unknown;
  const root = parts[0];
  if (root === 'graph') cur = ctx.graph;
  else if (root === 'state') cur = ctx.state;
  else if (root === 'node') {
    // node.<id>.<field>
    if (parts.length < 3) return undefined;
    const nodeEntry = ctx.node[parts[1]];
    cur = nodeEntry;
    parts.splice(1, 1); // consume the node id, keep the field name
  } else {
    // Bare path: treat as a state key for ergonomics (${some_key} == state.some_key).
    cur = ctx.state[root];
  }
  for (let i = 1; i < parts.length; i++) {
    if (cur === undefined || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

/**
 * Evaluate a condition expression to a boolean.
 *
 * Grammar (left-recursive but handled iteratively):
 *   or   := and ('||' and)*
 *   and  := not ('&&' not)*
 *   not  := '!' not | cmp
 *   cmp  := atom (('==' | '!=' | '>' | '<' | '>=' | '<=') atom)?
 *   atom := '(' or ')' | literal | ${path}
 *
 * Returns false for unparseable expressions (fail-safe: a malformed condition
 * never activates an edge). Whitespace is insignificant.
 */
export function evalCondition(expr: string, ctx: EvalContext): boolean {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  const parser = new ExprParser(expr, ctx);
  try {
    const result = parser.parseOr();
    if (parser.hasTail()) return false; // trailing garbage → fail-safe
    return !!result;
  } catch {
    return false;
  }
}

/** Tokenize an expression into a stream the parser can consume. */
class ExprParser {
  private pos = 0;
  constructor(
    private readonly src: string,
    private readonly ctx: EvalContext,
  ) {}

  parseOr(): boolean {
    let v = this.parseAnd();
    while (this.matchOp('||')) {
      const rhs = this.parseAnd();
      v = v || rhs;
    }
    return v;
  }

  parseAnd(): boolean {
    let v = this.parseNot();
    while (this.matchOp('&&')) {
      const rhs = this.parseNot();
      v = v && rhs;
    }
    return v;
  }

  parseNot(): boolean {
    if (this.matchOp('!')) {
      return !this.parseNot();
    }
    return this.parseCmp();
  }

  parseCmp(): boolean {
    const left = this.parseAtom();
    const op = this.peekOp();
    if (op === '==' || op === '!=' || op === '>' || op === '<' || op === '>=' || op === '<=') {
      this.consume(op);
      const right = this.parseAtom();
      return compare(op, left, right);
    }
    // No operator → truthiness.
    return truthy(left);
  }

  parseAtom(): unknown {
    this.skipWs();
    if (this.peek() === '(') {
      this.pos++; // consume (
      const v = this.parseOr();
      this.skipWs();
      if (this.peek() === ')') this.pos++; // consume )
      return v;
    }
    // ${path} reference
    if (this.peek() === '$' && this.src[this.pos + 1] === '{') {
      const end = this.src.indexOf('}', this.pos + 2);
      if (end === -1) throw new Error('unterminated ${');
      const path = this.src.slice(this.pos + 2, end);
      this.pos = end + 1;
      return resolvePath(path.trim(), this.ctx);
    }
    // String literal '...' or "..."
    const ch = this.peek();
    if (ch === "'" || ch === '"') {
      const end = this.src.indexOf(ch, this.pos + 1);
      if (end === -1) throw new Error('unterminated string');
      const lit = this.src.slice(this.pos + 1, end);
      this.pos = end + 1;
      return lit;
    }
    // Number (incl. negative + decimal)
    const numMatch = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.pos));
    if (numMatch) {
      this.pos += numMatch[0].length;
      return Number(numMatch[0]);
    }
    // Bare identifier: treat as a state key reference (ergonomic shorthand).
    const idMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.src.slice(this.pos));
    if (idMatch) {
      this.pos += idMatch[0].length;
      return resolvePath(idMatch[0], this.ctx);
    }
    throw new Error(`unexpected token at ${this.pos}`);
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private peekOp(): string | null {
    this.skipWs();
    const two = this.src.slice(this.pos, this.pos + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      return two;
    }
    const one = this.src[this.pos];
    if (one === '>' || one === '<' || one === '!') return one;
    return null;
  }

  private matchOp(op: string): boolean {
    this.skipWs();
    const cand = this.src.slice(this.pos, this.pos + op.length);
    if (cand === op) {
      this.pos += op.length;
      // Distinguish '!' from '!=' / '!' standalone: matchOp('!') only matches a
      // standalone '!' not followed by '='. Caller uses parseNot for '!'.
      if (op === '!' && this.src[this.pos] === '=') {
        this.pos -= 1; // it's actually '!=', back off
        return false;
      }
      return true;
    }
    return false;
  }

  private consume(op: string): void {
    if (this.src.slice(this.pos, this.pos + op.length) === op) this.pos += op.length;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  hasTail(): boolean {
    this.skipWs();
    return this.pos < this.src.length;
  }
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== 'false' && v !== '0';
  return v !== undefined && v !== null;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  // Numeric comparison when both sides coerce to finite numbers.
  const ln = typeof left === 'number' ? left : Number(left);
  const rn = typeof right === 'number' ? right : Number(right);
  const bothNumeric =
    (typeof left === 'number' || (typeof left === 'string' && left.trim() !== '' && !Number.isNaN(ln))) &&
    (typeof right === 'number' || (typeof right === 'string' && right.trim() !== '' && !Number.isNaN(rn))) &&
    !Number.isNaN(ln) &&
    !Number.isNaN(rn);

  switch (op) {
    case '==':
      return bothNumeric ? ln === rn : String(left) === String(right);
    case '!=':
      return bothNumeric ? ln !== rn : String(left) !== String(right);
    case '>':
      return bothNumeric ? ln > rn : false;
    case '<':
      return bothNumeric ? ln < rn : false;
    case '>=':
      return bothNumeric ? ln >= rn : false;
    case '<=':
      return bothNumeric ? ln <= rn : false;
    default:
      return false;
  }
}
