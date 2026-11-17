// GENERATED from pulse-app/src/lib/pql; do not edit.
import type { Expression, Query, Value } from './parser';

function serializeValue(value: Value): string {
  if (value.kind === 'function') return `${value.value}()`;
  if (!value.quoted && /^[^\s(),=!<>~"']+$/.test(value.value)) return value.value;
  return `"${value.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function serializeExpression(expression: Expression): string {
  if (expression.kind === 'and' || expression.kind === 'or') return `(${serializeExpression(expression.left)} ${expression.kind.toUpperCase()} ${serializeExpression(expression.right)})`;
  if (expression.kind === 'not') return `NOT (${serializeExpression(expression.expression)})`;
  const operator = expression.operator.toUpperCase();
  if (expression.operator.startsWith('is ')) return `${expression.field} ${operator}`;
  if (expression.operator === 'in' || expression.operator === 'not in') return `${expression.field} ${operator} (${expression.values.map(serializeValue).join(', ')})`;
  return `${expression.field} ${operator} ${serializeValue(expression.values[0])}`;
}
export function serialize(query: Query): string {
  const expression = query.expression ? serializeExpression(query.expression) : '';
  const ordering = query.orderBy.length ? `ORDER BY ${query.orderBy.map(o => `${o.field} ${o.direction.toUpperCase()}`).join(', ')}` : '';
  return [expression, ordering].filter(Boolean).join(' ');
}
