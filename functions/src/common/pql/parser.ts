// GENERATED from pulse-app/src/lib/pql; do not edit.
import { diagnostic, tokenize, type Diagnostic, type Token } from './tokenizer';

export interface Range { start: number; end: number }
export interface Value extends Range { kind: 'literal' | 'function'; value: string; quoted: boolean }
export type Expression =
  | (Range & { kind: 'and'; left: Expression; right: Expression })
  | (Range & { kind: 'or'; left: Expression; right: Expression })
  | (Range & { kind: 'not'; expression: Expression })
  | (Range & { kind: 'comparison'; field: string; operator: string; values: Value[] });
export interface Ordering extends Range { field: string; direction: 'asc' | 'desc' }
export interface Query { expression?: Expression; orderBy: Ordering[] }
export type ParseResult = { ok: true; query: Query; tokens: Token[] } | { ok: false; diagnostic: Diagnostic };

class ParseFailure { constructor(readonly diagnostic: Diagnostic) {} }

export function parse(source: string): ParseResult {
  const lexical = tokenize(source);
  if (!lexical.ok) return lexical;
  const tokens = lexical.tokens;
  let index = 0;
  let depth = 0;
  const peek = () => tokens[index];
  const word = (s: string) => peek().kind === 'word' && peek().value.toLowerCase() === s;
  const consume = () => tokens[index++];
  const fail = (message: string, expected?: string[]): never => {
    const t = peek();
    throw new ParseFailure(diagnostic(source, 'SYNTAX', message, t.start, t.end, expected));
  };
  const requireWord = (s: string) => { if (!word(s)) fail(`Se esperaba ${s.toUpperCase()}.`, [s.toUpperCase()]); consume(); };
  const value = (): Value => {
    const t = peek();
    if (!['word', 'number', 'string'].includes(t.kind)) return fail('Se esperaba un valor.', ['valor']);
    consume();
    if (t.kind === 'word' && peek().kind === 'lparen') {
      consume();
      if (peek().kind !== 'rparen') return fail('Las funciones no aceptan argumentos.', [')']);
      const end = consume().end;
      return { kind: 'function', value: t.value, quoted: false, start: t.start, end };
    }
    return { kind: 'literal', value: t.value, quoted: t.kind === 'string', start: t.start, end: t.end };
  };
  const comparison = (): Expression => {
    const field = peek();
    if (field.kind !== 'word') return fail('Se esperaba un campo.', ['campo']);
    consume();
    let operator: string;
    if (peek().kind === 'operator') operator = consume().value;
    else if (word('is')) {
      consume(); const negated = word('not'); if (negated) consume(); requireWord('empty');
      return { kind: 'comparison', field: field.value, operator: negated ? 'is not empty' : 'is empty', values: [], start: field.start, end: tokens[index - 1].end };
    } else {
      const negated = word('not'); if (negated) consume();
      requireWord('in'); operator = negated ? 'not in' : 'in';
    }
    const values: Value[] = [];
    if (operator === 'in' || operator === 'not in') {
      if (peek().kind !== 'lparen') return fail('Se esperaba una lista.', ['(']);
      consume(); values.push(value());
      while (peek().kind === 'comma') { consume(); values.push(value()); }
      if (peek().kind !== 'rparen') return fail('Se esperaba cerrar la lista.', [')']);
      const end = consume().end;
      return { kind: 'comparison', field: field.value, operator, values, start: field.start, end };
    }
    values.push(value());
    return { kind: 'comparison', field: field.value, operator, values, start: field.start, end: values[0].end };
  };
  const unary = (): Expression => {
    if (word('not')) {
      const start = consume().start;
      if (++depth > 20) return fail('La consulta supera 20 niveles de anidación.');
      const expression = unary(); depth--;
      return { kind: 'not', expression, start, end: expression.end };
    }
    if (peek().kind === 'lparen') {
      const start = consume().start;
      if (++depth > 20) return fail('La consulta supera 20 niveles de anidación.');
      const expression = or(); depth--;
      if (peek().kind !== 'rparen') return fail('Se esperaba cerrar el paréntesis.', [')']);
      return { ...expression, start, end: consume().end };
    }
    return comparison();
  };
  const and = (): Expression => {
    let left = unary();
    while (word('and')) { consume(); const right = unary(); left = { kind: 'and', left, right, start: left.start, end: right.end }; }
    return left;
  };
  const or = (): Expression => {
    let left = and();
    while (word('or')) { consume(); const right = and(); left = { kind: 'or', left, right, start: left.start, end: right.end }; }
    return left;
  };
  try {
    const expression = peek().kind !== 'eof' && !word('order') ? or() : undefined;
    const orderBy: Ordering[] = [];
    if (word('order')) {
      consume(); requireWord('by');
      do {
        if (orderBy.length) consume();
        const field = peek();
        if (field.kind !== 'word') return fail('Se esperaba un campo de orden.', ['campo']);
        consume();
        const direction = word('asc') || word('desc') ? consume().value.toLowerCase() as 'asc' | 'desc' : 'asc';
        orderBy.push({ field: field.value, direction, start: field.start, end: tokens[index - 1].end });
        if (orderBy.length > 5) return fail('Se admiten hasta cinco términos de orden.');
      } while (peek().kind === 'comma');
    }
    if (peek().kind !== 'eof') return fail('Texto inesperado después de la consulta.');
    return { ok: true, query: { expression, orderBy }, tokens };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, diagnostic: error.diagnostic };
    throw error;
  }
}
