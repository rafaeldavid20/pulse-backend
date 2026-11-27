// GENERATED from pulse-app/src/lib/pql; do not edit.
import type { Expression, Query, Value } from './parser';

// Adjacent word/number tokens need a separator; punctuation and quoted strings
// delimit themselves in the tokenizer. Keeping only necessary whitespace lets
// valid inputs at the 4096-character boundary survive serialization.
const isWordChar = (char: string) => char !== '' && !/[\s(),=!<>~"']/u.test(char);
function joinTokens(tokens: string[]): string {
  let result = '';
  for (const token of tokens) {
    if (!token) continue;
    if (isWordChar(result.at(-1) ?? '') && isWordChar(token[0])) result += ' ';
    result += token;
  }
  return result;
}
function serializeValue(value: Value): string {
  if (value.kind === 'function') return `${value.value}()`;
  if (!value.quoted) return value.value;
  const quote = (delimiter: '"' | "'") => delimiter + value.value.replace(/\\/g, '\\\\').replaceAll(delimiter, `\\${delimiter}`) + delimiter;
  const single = quote("'");
  const double = quote('"');
  return single.length < double.length ? single : double;
}
function precedence(expression: Expression): number {
  if (expression.kind === 'or') return 1;
  if (expression.kind === 'and') return 2;
  if (expression.kind === 'not') return 3;
  return 4;
}
function serializeExpression(expression: Expression, parentPrecedence = 0): string {
  const ownPrecedence = precedence(expression);
  let result: string;
  if (expression.kind === 'and' || expression.kind === 'or') {
    result = joinTokens([serializeExpression(expression.left, ownPrecedence), expression.kind.toUpperCase(), serializeExpression(expression.right, ownPrecedence)]);
  } else if (expression.kind === 'not') {
    result = joinTokens(['NOT', serializeExpression(expression.expression, ownPrecedence)]);
  } else {
    const operator = expression.operator.toUpperCase();
    if (expression.operator.startsWith('is ')) result = joinTokens([expression.field, operator]);
    else if (expression.operator === 'in' || expression.operator === 'not in') {
      result = joinTokens([expression.field, operator, '(', expression.values.map(serializeValue).join(','), ')']);
    } else result = joinTokens([expression.field, operator, serializeValue(expression.values[0])]);
  }
  return ownPrecedence < parentPrecedence ? `(${result})` : result;
}
export function serialize(query: Query): string {
  const expression = query.expression ? serializeExpression(query.expression) : '';
  const ordering = query.orderBy.length ? joinTokens(['ORDER', 'BY', query.orderBy.map(o => joinTokens([o.field, o.direction === 'desc' ? 'DESC' : ''])).join(',')]) : '';
  return joinTokens([expression, ordering]);
}
