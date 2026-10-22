/**
 * Strict Liquid-compatible prompt template engine (SPEC 5.4, 12.2).
 *
 * Supported syntax:
 *   - output `{{ expression | filter: arg, arg }}`
 *   - tags: `if` / `elsif` / `else` / `endif`, `unless` / `endunless`,
 *     `for x in y` / `else` / `endfor`, `break`, `continue`, `assign`,
 *     `raw` / `endraw`, `comment` / `endcomment`
 *   - whitespace control with `{{-`, `-}}`, `{%-`, `-%}`
 *
 * Strict semantics required by the specification: referencing a variable that
 * does not exist and calling a filter that is not implemented both fail
 * rendering instead of silently producing empty output.
 */
import { WorkflowError, describeError } from '../domain/errors.js';

export class TemplateError extends WorkflowError {
  constructor(code: 'template_parse_error' | 'template_render_error', message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = 'TemplateError';
  }
}

/* ------------------------------------------------------------------ values */

type Scope = Map<string, unknown>;

interface RenderEnv {
  root: Record<string, unknown>;
  scopes: Scope[];
}

/** Loop control state: `break` unwinds the enclosing loop, `continue` skips it. */
interface Control {
  stop: 'break' | 'continue' | null;
}

function newControl(): Control {
  return { stop: null };
}

type Tok =
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'punc'; value: string }
  | { kind: 'eof' };

interface FilterCall {
  name: string;
  args: Expr[];
}

type Expr =
  | { type: 'literal'; value: unknown }
  | { type: 'path'; segments: Array<string | Expr> }
  | { type: 'binary'; op: string; left: Expr; right: Expr }
  | { type: 'unary'; op: 'not'; operand: Expr }
  | { type: 'filtered'; base: Expr; filters: FilterCall[] };

type Node =
  | { type: 'text'; value: string }
  | { type: 'output'; expr: Expr }
  | { type: 'if'; branches: Array<{ test: Expr; body: Node[] }>; else_body: Node[] | null }
  | { type: 'for'; variable: string; iterable: Expr; body: Node[]; else_body: Node[] | null }
  | { type: 'assign'; name: string; expr: Expr }
  | { type: 'break' }
  | { type: 'continue' };

/* ------------------------------------------------------------- expression */

const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_-]/;
const MULTI_OPS = ['==', '!=', '<=', '>='];
const SINGLE_PUNCT = new Set(['.', ',', '|', ':', '(', ')', '[', ']']);
const SINGLE_OPS = new Set(['<', '>', '=']);

function tokenizeExpression(source: string): Tok[] {
  const tokens: Tok[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index += 1;
      let closed = false;
      while (index < source.length) {
        const next = source[index] as string;
        if (next === '\\' && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
          continue;
        }
        if (next === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed) throw new TemplateError('template_parse_error', `unterminated string literal in expression: ${source}`);
      tokens.push({ kind: 'str', value });
      continue;
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let raw = char;
      index += 1;
      while (index < source.length && /[0-9.]/.test(source[index] as string)) {
        raw += source[index];
        index += 1;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new TemplateError('template_parse_error', `invalid number literal: ${raw}`);
      tokens.push({ kind: 'num', value });
      continue;
    }
    if (IDENT_START.test(char)) {
      let raw = char;
      index += 1;
      while (index < source.length && IDENT_BODY.test(source[index] as string)) {
        raw += source[index];
        index += 1;
      }
      tokens.push({ kind: 'ident', value: raw });
      continue;
    }
    const two = source.slice(index, index + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ kind: 'op', value: two });
      index += 2;
      continue;
    }
    if (SINGLE_OPS.has(char)) {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }
    if (SINGLE_PUNCT.has(char)) {
      tokens.push({ kind: 'punc', value: char });
      index += 1;
      continue;
    }
    throw new TemplateError('template_parse_error', `unexpected character ${JSON.stringify(char)} in expression: ${source}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class ExpressionParser {
  private readonly tokens: Tok[];
  private index = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenizeExpression(source);
  }

  parse(): Expr {
    const expr = this.parseOr();
    if (this.peek().kind !== 'eof') {
      throw new TemplateError('template_parse_error', `unexpected token in expression: ${this.source}`);
    }
    return expr;
  }

  private peek(): Tok {
    return this.tokens[this.index] as Tok;
  }

  private next(): Tok {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private matchIdent(...names: string[]): boolean {
    const token = this.peek();
    if (token.kind === 'ident' && names.includes(token.value)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchIdent('or')) {
      left = { type: 'binary', op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.matchIdent('and')) {
      left = { type: 'binary', op: 'and', left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parseUnary();
    const token = this.peek();
    if (token.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(token.value)) {
      this.index += 1;
      return { type: 'binary', op: token.value, left, right: this.parseUnary() };
    }
    if (token.kind === 'ident' && token.value === 'contains') {
      this.index += 1;
      return { type: 'binary', op: 'contains', left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.matchIdent('not')) {
      return { type: 'unary', op: 'not', operand: this.parseUnary() };
    }
    return this.parseFiltered();
  }

  private parseFiltered(): Expr {
    const base = this.parsePrimary();
    const filters: FilterCall[] = [];
    while (this.peek().kind === 'punc' && (this.peek() as { value: string }).value === '|') {
      this.index += 1;
      const nameToken = this.next();
      if (nameToken.kind !== 'ident') {
        throw new TemplateError('template_parse_error', `expected a filter name in expression: ${this.source}`);
      }
      const args: Expr[] = [];
      if (this.peek().kind === 'punc' && (this.peek() as { value: string }).value === ':') {
        this.index += 1;
        args.push(this.parseOr());
        while (this.peek().kind === 'punc' && (this.peek() as { value: string }).value === ',') {
          this.index += 1;
          args.push(this.parseOr());
        }
      }
      filters.push({ name: nameToken.value, args });
    }
    return filters.length === 0 ? base : { type: 'filtered', base, filters };
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (token.kind === 'str') {
      this.index += 1;
      return { type: 'literal', value: token.value };
    }
    if (token.kind === 'num') {
      this.index += 1;
      return { type: 'literal', value: token.value };
    }
    if (token.kind === 'punc' && token.value === '(') {
      this.index += 1;
      const inner = this.parseOr();
      const close = this.next();
      if (close.kind !== 'punc' || close.value !== ')') {
        throw new TemplateError('template_parse_error', `missing closing parenthesis in expression: ${this.source}`);
      }
      return inner;
    }
    if (token.kind === 'ident') {
      if (token.value === 'true') {
        this.index += 1;
        return { type: 'literal', value: true };
      }
      if (token.value === 'false') {
        this.index += 1;
        return { type: 'literal', value: false };
      }
      if (token.value === 'nil' || token.value === 'null') {
        this.index += 1;
        return { type: 'literal', value: null };
      }
      if (token.value === 'empty' || token.value === 'blank') {
        this.index += 1;
        return { type: 'literal', value: EMPTY };
      }
      if (token.value === 'and' || token.value === 'or' || token.value === 'not' || token.value === 'contains') {
        throw new TemplateError('template_parse_error', `unexpected operator ${token.value} in expression: ${this.source}`);
      }
      this.index += 1;
      const segments: Array<string | Expr> = [token.value];
      for (;;) {
        const next = this.peek();
        if (next.kind === 'punc' && next.value === '.') {
          this.index += 1;
          const property = this.next();
          if (property.kind !== 'ident') {
            throw new TemplateError('template_parse_error', `expected a property name in expression: ${this.source}`);
          }
          segments.push(property.value);
          continue;
        }
        if (next.kind === 'punc' && next.value === '[') {
          this.index += 1;
          segments.push(this.parseOr());
          const close = this.next();
          if (close.kind !== 'punc' || close.value !== ']') {
            throw new TemplateError('template_parse_error', `missing closing bracket in expression: ${this.source}`);
          }
          continue;
        }
        break;
      }
      return { type: 'path', segments };
    }
    throw new TemplateError('template_parse_error', `unexpected end of expression: ${this.source}`);
  }
}

/* ---------------------------------------------------------------- filters */

const EMPTY = Symbol('empty');

function isBlankish(value: unknown): boolean {
  if (value === EMPTY) return true;
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map) return value.size === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  return [value];
}

function asString(value: unknown): string {
  if (value === EMPTY) return '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(asString(value));
  if (!Number.isFinite(parsed)) throw new TemplateError('template_render_error', `expected a number, got ${asString(value)}`);
  return parsed;
}

interface FilterContext {
  name: string;
  source: string;
}

type FilterFn = (value: unknown, args: unknown[], ctx: FilterContext) => unknown;

const FILTERS = new Map<string, FilterFn>([
  ['default', (value, args) => (isBlankish(value) ? args[0] : value)],
  ['upcase', (value) => asString(value).toUpperCase()],
  ['downcase', (value) => asString(value).toLowerCase()],
  ['capitalize', (value) => {
    const text = asString(value).toLowerCase();
    return text.length === 0 ? text : (text[0] as string).toUpperCase() + text.slice(1);
  }],
  ['strip', (value) => asString(value).trim()],
  ['lstrip', (value) => asString(value).replace(/^\s+/, '')],
  ['rstrip', (value) => asString(value).replace(/\s+$/, '')],
  ['append', (value, args) => asString(value) + asString(args[0])],
  ['prepend', (value, args) => asString(args[0]) + asString(value)],
  ['replace', (value, args) => asString(value).split(asString(args[0])).join(asString(args[1]))],
  ['split', (value, args) => asString(value).split(asString(args[0] ?? ' '))],
  ['join', (value, args) => toArray(value).map(asString).join(args.length > 0 ? asString(args[0]) : ' ')],
  ['first', (value) => toArray(value)[0]],
  ['last', (value) => {
    const items = toArray(value);
    return items[items.length - 1];
  }],
  ['size', (value) => {
    if (Array.isArray(value)) return value.length;
    if (value instanceof Map) return value.size;
    if (typeof value === 'string') return [...value].length;
    if (value === null || value === undefined || value === EMPTY) return 0;
    return Object.keys(value as object).length;
  }],
  ['map', (value, args) => {
    const property = asString(args[0]);
    return toArray(value).map((item) => getProperty(item, property));
  }],
  ['where', (value, args) => {
    const property = asString(args[0]);
    const expected = args[1];
    return toArray(value).filter((item) => {
      const actual = getProperty(item, property);
      return args.length < 2 ? isTruthy(actual) : looseEquals(actual, expected);
    });
  }],
  ['escape', (value) => asString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')],
  ['truncate', (value, args) => {
    const limit = Math.max(0, Math.trunc(toNumber(args[0] ?? 80)));
    const ellipsis = args.length > 1 ? asString(args[1]) : '...';
    const text = asString(value);
    return text.length <= limit ? text : text.slice(0, limit) + ellipsis;
  }],
  ['plus', (value, args) => toNumber(value) + toNumber(args[0])],
  ['minus', (value, args) => toNumber(value) - toNumber(args[0])],
  ['times', (value, args) => toNumber(value) * toNumber(args[0])],
  ['divided_by', (value, args) => {
    const divisor = toNumber(args[0]);
    if (divisor === 0) throw new TemplateError('template_render_error', 'divided_by: division by zero');
    return toNumber(value) / divisor;
  }],
  ['modulo', (value, args) => toNumber(value) % toNumber(args[0])],
  ['json', (value) => {
    const json = JSON.stringify(value === EMPTY ? null : value);
    return json === undefined ? 'null' : json;
  }],
  ['inspect', (value) => JSON.stringify(value === EMPTY ? null : value, null, 2) ?? 'null'],
]);

function getProperty(value: unknown, property: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Map) return value.get(property);
  if (Array.isArray(value)) {
    if (property === 'size' || property === 'length') return value.length;
    if (property === 'first') return value[0];
    if (property === 'last') return value[value.length - 1];
    return (value as unknown as Record<string, unknown>)[property];
  }
  if (typeof value === 'object') return (value as Record<string, unknown>)[property];
  return undefined;
}

function isTruthy(value: unknown): boolean {
  if (value === EMPTY) return false;
  if (value === false || value === null || value === undefined) return false;
  return true;
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === EMPTY || right === EMPTY) {
    const other = left === EMPTY ? right : left;
    return isBlankish(other);
  }
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left as number);
    const b = Number(right as number);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return String(left) === String(right);
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' || typeof right === 'number') {
    return toNumber(left) - toNumber(right);
  }
  const a = asString(left);
  const b = asString(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/* --------------------------------------------------------------- rendering */

class Renderer {
  constructor(private readonly env: RenderEnv) {}

  render(nodes: Node[]): string {
    const out: string[] = [];
    this.renderNodes(nodes, out, newControl());
    return out.join('');
  }

  private renderNodes(nodes: Node[], out: string[], control: Control): void {
    for (const node of nodes) {
      if (control.stop !== null) return;
      switch (node.type) {
        case 'text':
          out.push(node.value);
          break;
        case 'output':
          out.push(asString(this.evaluate(node.expr)));
          break;
        case 'assign':
          this.topScope().set(node.name, this.evaluate(node.expr));
          break;
        case 'if': {
          const selected = node.branches.find((branch) => isTruthy(this.evaluate(branch.test)));
          if (selected !== undefined) this.renderNodes(selected.body, out, control);
          else if (node.else_body !== null) this.renderNodes(node.else_body, out, control);
          break;
        }
        case 'for': {
          const items = this.iterableItems(this.evaluate(node.iterable), node.variable);
          if (items.length === 0) {
            if (node.else_body !== null) this.renderNodes(node.else_body, out, control);
            break;
          }
          for (let index = 0; index < items.length; index += 1) {
            const scope = new Map<string, unknown>();
            scope.set(node.variable, items[index]);
            scope.set('forloop', {
              index: index + 1,
              index0: index,
              rindex: items.length - index,
              rindex0: items.length - index - 1,
              first: index === 0,
              last: index === items.length - 1,
              length: items.length,
            });
            this.env.scopes.push(scope);
            const loopControl = newControl();
            this.renderNodes(node.body, out, loopControl);
            this.env.scopes.pop();
            if (loopControl.stop === 'break') {
              control.stop = null;
              break;
            }
            if (loopControl.stop === 'continue') control.stop = null;
          }
          break;
        }
        case 'break':
          control.stop = 'break';
          break;
        case 'continue':
          control.stop = 'continue';
          break;
      }
    }
  }

  private iterableItems(value: unknown, variable: string): unknown[] {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return [...value.values()];
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>);
    if (typeof value === 'string') {
      if (value === '') return [];
      throw new TemplateError('template_render_error', `cannot iterate over string value bound to \`${variable}\``);
    }
    throw new TemplateError('template_render_error', `cannot iterate over ${typeof value} value bound to \`${variable}\``);
  }

  private topScope(): Scope {
    const scope = this.env.scopes[this.env.scopes.length - 1];
    if (scope === undefined) throw new TemplateError('template_render_error', 'no active scope');
    return scope;
  }

  private evaluate(expr: Expr): unknown {
    switch (expr.type) {
      case 'literal':
        return expr.value;
      case 'path':
        return this.evaluatePath(expr.segments);
      case 'unary':
        return !isTruthy(this.evaluate(expr.operand));
      case 'binary':
        return this.evaluateBinary(expr);
      case 'filtered': {
        let value = this.evaluate(expr.base);
        for (const filter of expr.filters) {
          const implementation = FILTERS.get(filter.name);
          if (implementation === undefined) {
            throw new TemplateError('template_render_error', `unknown filter: ${filter.name}`);
          }
          const args = filter.args.map((arg) => this.evaluate(arg));
          value = implementation(value, args, { name: filter.name, source: '' });
        }
        return value;
      }
    }
  }

  private evaluateBinary(expr: Extract<Expr, { type: 'binary' }>): unknown {
    if (expr.op === 'and') return isTruthy(this.evaluate(expr.left)) && isTruthy(this.evaluate(expr.right));
    if (expr.op === 'or') return isTruthy(this.evaluate(expr.left)) || isTruthy(this.evaluate(expr.right));
    const left = this.evaluate(expr.left);
    const right = this.evaluate(expr.right);
    switch (expr.op) {
      case '==':
        return looseEquals(left, right);
      case '!=':
        return !looseEquals(left, right);
      case '<':
        return compare(left, right) < 0;
      case '>':
        return compare(left, right) > 0;
      case '<=':
        return compare(left, right) <= 0;
      case '>=':
        return compare(left, right) >= 0;
      case 'contains': {
        if (typeof left === 'string') return left.includes(asString(right));
        if (Array.isArray(left)) return left.some((item) => looseEquals(item, right));
        if (left instanceof Map) return left.has(asString(right));
        return false;
      }
      default:
        throw new TemplateError('template_render_error', `unknown operator: ${expr.op}`);
    }
  }

  private evaluatePath(segments: Array<string | Expr>): unknown {
    const first = segments[0];
    if (typeof first !== 'string') throw new TemplateError('template_render_error', 'template path must start with an identifier');
    let value: unknown;
    let found = false;
    for (let index = this.env.scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.env.scopes[index] as Scope;
      if (scope.has(first)) {
        value = scope.get(first);
        found = true;
        break;
      }
    }
    if (!found) {
      if (Object.prototype.hasOwnProperty.call(this.env.root, first)) {
        value = this.env.root[first];
        found = true;
      }
    }
    if (!found) {
      throw new TemplateError('template_render_error', `unknown variable: ${first}`, { variable: first });
    }
    let path = first;
    for (const segment of segments.slice(1)) {
      const key = typeof segment === 'string' ? segment : asString(this.evaluate(segment));
      path = `${path}.${key}`;
      if (value === null || value === undefined) {
        throw new TemplateError('template_render_error', `unknown variable: ${path}`, { variable: path });
      }
      const next = getProperty(value, key);
      if (next === undefined) {
        throw new TemplateError('template_render_error', `unknown variable: ${path}`, { variable: path });
      }
      value = next;
    }
    return value;
  }
}

/* ------------------------------------------------------------------ parser */

interface Tag {
  kind: 'text' | 'output' | 'tag';
  value: string;
  trimLeft: boolean;
  trimRight: boolean;
}

function lexTemplate(source: string): Tag[] {
  const tags: Tag[] = [];
  let index = 0;
  while (index < source.length) {
    const outputStart = source.indexOf('{{', index);
    const tagStart = source.indexOf('{%', index);
    const commentStart = source.indexOf('{#', index);
    const candidates = [outputStart, tagStart, commentStart].filter((value) => value >= 0);
    if (candidates.length === 0) {
      tags.push({ kind: 'text', value: source.slice(index), trimLeft: false, trimRight: false });
      break;
    }
    const start = Math.min(...candidates);
    if (start > index) {
      tags.push({ kind: 'text', value: source.slice(index, start), trimLeft: false, trimRight: false });
    }
    const opener = source.slice(start, start + 2);
    const closer = opener === '{{' ? '}}' : opener === '{%' ? '%}' : '#}';
    const end = source.indexOf(closer, start + 2);
    if (end < 0) {
      throw new TemplateError('template_parse_error', `unterminated ${opener} tag`);
    }
    const rawInner = source.slice(start + 2, end);
    const trimLeft = rawInner.startsWith('-');
    const trimRight = rawInner.endsWith('-');
    const inner = rawInner.replace(/^-\s*/, '').replace(/\s*-$/, '').trim();
    if (opener === '{#') {
      // Comments produce no output.
    } else {
      tags.push({ kind: opener === '{{' ? 'output' : 'tag', value: inner, trimLeft, trimRight });
    }
    index = end + 2;
  }

  // Apply whitespace control markers.
  for (let position = 0; position < tags.length; position += 1) {
    const tag = tags[position] as Tag;
    if (tag.trimLeft) {
      const previous = tags[position - 1];
      if (previous !== undefined && previous.kind === 'text') previous.value = previous.value.replace(/\s+$/, '');
    }
    if (tag.trimRight) {
      const next = tags[position + 1];
      if (next !== undefined && next.kind === 'text') next.value = next.value.replace(/^\s+/, '');
    }
  }
  return tags;
}

interface BlockFrame {
  kind: 'root' | 'if' | 'for' | 'raw' | 'comment';
  body: Node[];
  branches?: Array<{ test: Expr; body: Node[] }>;
  elseBody?: Node[] | null;
  forHeader?: { variable: string; iterable: Expr };
}

function parseNodes(tags: Tag[], source: string): Node[] {
  const root: BlockFrame = { kind: 'root', body: [] };
  const stack: BlockFrame[] = [root];
  let inRaw = false;
  const rawChunks: string[] = [];

  const currentFrame = (): BlockFrame => stack[stack.length - 1] as BlockFrame;
  const currentBody = (): Node[] => currentFrame().body;

  for (const tag of tags) {
    if (inRaw) {
      if (tag.kind === 'tag' && tag.value.trim() === 'endraw') {
        currentBody().push({ type: 'text', value: rawChunks.join('') });
        rawChunks.length = 0;
        inRaw = false;
        continue;
      }
      // Preserve the original delimiters inside a raw block.
      if (tag.kind === 'output') rawChunks.push(`{{ ${tag.value} }}`);
      else if (tag.kind === 'tag') rawChunks.push(`{% ${tag.value} %}`);
      continue;
    }

    if (tag.kind === 'text') {
      currentBody().push({ type: 'text', value: tag.value });
      continue;
    }

    if (tag.kind === 'output') {
      currentBody().push({ type: 'output', expr: new ExpressionParser(tag.value).parse() });
      continue;
    }

    const trimmed = tag.value.trim();
    const [keyword] = trimmed.split(/\s+/, 1);
    const rest = trimmed.slice(keyword?.length ?? 0).trim();

    switch (keyword) {
      case 'if':
      case 'unless': {
        const test = new ExpressionParser(rest).parse();
        const frame: BlockFrame = { kind: 'if', body: [], branches: [], elseBody: null };
        (frame.branches as Array<{ test: Expr; body: Node[] }>).push({
          test: keyword === 'if' ? test : { type: 'unary', op: 'not', operand: test },
          body: frame.body,
        });
        currentBody().push({ type: 'if', branches: [], else_body: null } as Node);
        stack.push(frame);
        break;
      }
      case 'elsif': {
        const frame = currentFrame();
        if (frame.kind !== 'if' || frame.branches === undefined) {
          throw new TemplateError('template_parse_error', '`elsif` outside of an `if` block');
        }
        const test = new ExpressionParser(rest).parse();
        const branch = { test, body: [] as Node[] };
        frame.branches.push(branch);
        frame.body = branch.body;
        break;
      }
      case 'else': {
        const frame = currentFrame();
        if (frame.kind !== 'if' && frame.kind !== 'for') {
          throw new TemplateError('template_parse_error', '`else` outside of an `if` or `for` block');
        }
        const body: Node[] = [];
        frame.elseBody = body;
        frame.body = body;
        break;
      }
      case 'endif':
      case 'endunless': {
        const frame = stack.pop();
        if (frame === undefined || frame.kind !== 'if') {
          throw new TemplateError('template_parse_error', `unexpected \`${keyword}\``);
        }
        const parentBody = currentBody();
        const target = parentBody[parentBody.length - 1];
        if (target !== undefined && target.type === 'if') {
          target.branches = frame.branches ?? [];
          target.else_body = frame.elseBody ?? null;
        }
        break;
      }
      case 'for': {
        const header = parseForHeader(rest, source);
        const frame: BlockFrame = { kind: 'for', body: [], forHeader: header, elseBody: null };
        currentBody().push({ type: 'for', variable: header.variable, iterable: header.iterable, body: [], else_body: null });
        stack.push(frame);
        break;
      }
      case 'endfor': {
        const frame = stack.pop();
        if (frame === undefined || frame.kind !== 'for' || frame.forHeader === undefined) {
          throw new TemplateError('template_parse_error', 'unexpected `endfor`');
        }
        const parentBody = currentBody();
        const target = parentBody[parentBody.length - 1];
        if (target !== undefined && target.type === 'for') {
          target.body = frame.body;
          target.else_body = frame.elseBody ?? null;
        }
        break;
      }
      case 'assign': {
        const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*([\s\S]+)$/.exec(rest);
        if (match === null) throw new TemplateError('template_parse_error', `invalid assign tag: ${trimmed}`);
        currentBody().push({
          type: 'assign',
          name: match[1] as string,
          expr: new ExpressionParser(match[2] as string).parse(),
        });
        break;
      }
      case 'break':
        currentBody().push({ type: 'break' });
        break;
      case 'continue':
        currentBody().push({ type: 'continue' });
        break;
      case 'raw':
        inRaw = true;
        break;
      case 'comment':
        stack.push({ kind: 'comment', body: [] });
        break;
      case 'endcomment': {
        const frame = stack.pop();
        if (frame === undefined || frame.kind !== 'comment') {
          throw new TemplateError('template_parse_error', 'unexpected `endcomment`');
        }
        break;
      }
      case 'endraw':
        throw new TemplateError('template_parse_error', 'unexpected `endraw`');
      default:
        throw new TemplateError('template_parse_error', `unknown tag: ${keyword ?? ''}`);
    }
  }

  if (inRaw) throw new TemplateError('template_parse_error', 'unterminated `raw` block');
  if (stack.length !== 1) {
    const frame = stack[stack.length - 1] as BlockFrame;
    throw new TemplateError('template_parse_error', `unterminated \`${frame.kind}\` block`);
  }
  return root.body;
}

function parseForHeader(rest: string, source: string): { variable: string; iterable: Expr } {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s+in\s+([\s\S]+)$/.exec(rest);
  if (match === null) {
    throw new TemplateError('template_parse_error', `invalid for tag in ${JSON.stringify(source.slice(0, 80))}: expected \`for x in y\``);
  }
  const iterableSource = (match[2] as string).replace(/\s+(reversed|limit:\s*\d+|offset:\s*\d+)\s*$/, '');
  return { variable: match[1] as string, iterable: new ExpressionParser(iterableSource.trim()).parse() };
}

/* ------------------------------------------------------------------- public */

/** A parsed, reusable prompt template. */
export class Template {
  readonly source: string;
  private readonly nodes: Node[];

  constructor(source: string) {
    this.source = source;
    try {
      this.nodes = parseNodes(lexTemplate(source), source);
    } catch (error) {
      if (error instanceof TemplateError) throw error;
      throw new TemplateError('template_parse_error', `cannot parse template: ${describeError(error)}`);
    }
  }

  /** Render with strict variable and filter checking. */
  render(context: Record<string, unknown>): string {
    const env: RenderEnv = { root: context, scopes: [new Map<string, unknown>()] };
    const renderer = new Renderer(env);
    try {
      return renderer.render(this.nodes);
    } catch (error) {
      if (error instanceof TemplateError) throw error;
      throw new TemplateError('template_render_error', `cannot render template: ${describeError(error)}`);
    }
  }
}

const cache = new Map<string, Template>();

/** Parse a template with a process-wide cache keyed by source text. */
export function parseTemplate(source: string): Template {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const template = new Template(source);
  if (cache.size > 64) cache.clear();
  cache.set(source, template);
  return template;
}

/** Render a template source with strict semantics. */
export function renderTemplate(source: string, context: Record<string, unknown>): string {
  return parseTemplate(source).render(context);
}
