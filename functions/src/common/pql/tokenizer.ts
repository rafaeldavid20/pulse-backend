// GENERATED from pulse-app/src/lib/pql; do not edit.
/** Lexical analysis for PQL. Offsets are UTF-16 indices, as in a JS input. */
export interface Diagnostic {
  code: string;
  message: string;
  start: number;
  end: number;
  line: number;
  column: number;
  expected?: string[];
}

export type TokenKind = 'word' | 'string' | 'number' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'eof';
export interface Token { kind: TokenKind; value: string; start: number; end: number }
export type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; diagnostic: Diagnostic };

export function diagnostic(source: string, code: string, message: string, start: number, end: number, expected?: string[]): Diagnostic {
  const prefix = source.slice(0, start);
  const line = prefix.split('\n').length;
  const column = start - prefix.lastIndexOf('\n');
  return { code, message, start, end, line, column, ...(expected ? { expected } : {}) };
}

export function tokenize(source: string): TokenizeResult {
  if (source.length > 4096) return { ok: false, diagnostic: diagnostic(source, 'TEXT_LIMIT', 'La consulta supera 4096 caracteres.', 4096, source.length) };
  const tokens: Token[] = [];
  let i = 0;
  const fail = (code: string, message: string, start: number, end: number): TokenizeResult => ({ ok: false, diagnostic: diagnostic(source, code, message, start, end) });
  while (i < source.length) {
    if (/\s/u.test(source[i])) { i++; continue; }
    const start = i;
    const char = source[i++];
    let kind: TokenKind;
    let value = char;
    if (char === '"' || char === "'") {
      kind = 'string'; value = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i++];
        if (c === char) { closed = true; break; }
        if (c === '\\') {
          if (i >= source.length) return fail('INVALID_ESCAPE', 'Escape incompleto.', i - 1, i);
          const next = source[i++];
          if (next !== char && next !== '\\') return fail('INVALID_ESCAPE', 'Solo se puede escapar la comilla o la barra invertida.', i - 2, i);
          value += next;
        } else value += c;
      }
      if (!closed) return fail('UNCLOSED_STRING', 'Falta cerrar la cadena.', start, i);
    } else if (char === '(' || char === ')' || char === ',') {
      kind = char === '(' ? 'lparen' : char === ')' ? 'rparen' : 'comma';
    } else if ('=!<>~'.includes(char)) {
      kind = 'operator';
      if ('!<>'.includes(char) && source[i] === '=') value += source[i++];
      if (char === '!' && value === '!') return fail('INVALID_OPERATOR', 'Se esperaba !=.', start, i);
    } else {
      while (i < source.length && !/[\s(),=!<>~"']/u.test(source[i])) i++;
      value = source.slice(start, i);
      kind = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? 'number' : 'word';
    }
    tokens.push({ kind, value, start, end: i });
    if (tokens.length > 500) return fail('TOKEN_LIMIT', 'La consulta supera 500 tokens.', start, i);
  }
  tokens.push({ kind: 'eof', value: '', start: i, end: i });
  return { ok: true, tokens };
}
