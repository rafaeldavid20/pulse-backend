// GENERATED from pulse-app/src/lib/pql; do not edit.
import { parse } from './parser';
import { resolve, type Context, type ResolvedExpression, type ResolvedQuery } from './resolver';
import { fields, type FieldSpec } from './schema';

export type Issue = { id: string };
const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
function extract(issue: Issue, field: string, spec: FieldSpec): unknown {
  const data = issue as Record<string, unknown>;
  if (field === 'epic') return data.type === 'epic' ? issue.id : data.epicId;
  if (field === 'type') return data.type ?? 'task';
  if (field === 'text') return [data.title, data.identifier].filter(v => !empty(v));
  return spec.path.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, issue);
}
const fold = (s: unknown) => String(s).toLowerCase();
function match(issue: Issue, expression: ResolvedExpression): boolean {
  if (expression.kind === 'and') return match(issue, expression.left) && match(issue, expression.right);
  if (expression.kind === 'or') return match(issue, expression.left) || match(issue, expression.right);
  if (expression.kind === 'not') return !match(issue, expression.expression);
  const { field, spec, operator, values } = expression;
  const actual = extract(issue, field, spec);
  if (operator === 'is empty') return empty(actual);
  if (operator === 'is not empty') return !empty(actual);
  if (empty(actual) && spec.type !== 'set') return false;
  const candidates = Array.isArray(actual) ? actual : [actual];
  const equals = (a: unknown, b: string | number | null): boolean => {
    if (b === null || empty(a)) return false;
    if (spec.type === 'date') return Date.parse(String(a)) === b;
    if (spec.type === 'number') return a === b;
    if (spec.type === 'reference' || spec.type === 'set') return a === b;
    return fold(a) === fold(b);
  };
  const anyEqual = candidates.some(a => values.some(b => equals(a, b)));
  if (operator === '=' || operator === 'in') return anyEqual;
  if (operator === '!=' || operator === 'not in') return !anyEqual;
  if (operator === '~') return candidates.some(a => fold(a).includes(fold(values[0])));
  const left = spec.type === 'date' ? Date.parse(String(actual)) : Number(actual);
  const right = Number(values[0]);
  if (operator === '<') return left < right;
  if (operator === '<=') return left <= right;
  if (operator === '>') return left > right;
  return left >= right;
}
const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
export function evaluate<T extends Issue>(query: ResolvedQuery, issues: readonly T[]): T[] {
  const orders = query.orderBy.length ? query.orderBy : [{ field: 'created', spec: fields.created, direction: 'desc' as const }];
  return issues.filter(issue => !query.expression || match(issue, query.expression)).sort((a, b) => {
    for (const order of orders) {
      let av = extract(a, order.field, order.spec); let bv = extract(b, order.field, order.spec);
      if (empty(av) || empty(bv)) { if (empty(av) !== empty(bv)) return empty(av) ? 1 : -1; continue; }
      if (order.spec.type === 'date') { av = Date.parse(String(av)); bv = Date.parse(String(bv)); }
      if (order.field === 'priority') { av = av === 0 ? 5 : av; bv = bv === 0 ? 5 : bv; }
      const c = compare(av as string | number, bv as string | number);
      if (c) return order.direction === 'asc' ? c : -c;
    }
    return compare(a.id, b.id);
  });
}
export function execute<T extends Issue>(source: string, issues: readonly T[], context: Context) {
  const parsed = parse(source);
  if (!parsed.ok) return parsed;
  const resolved = resolve(source, parsed.query, context);
  if (!resolved.ok) return resolved;
  return { ok: true as const, issues: evaluate(resolved.query, issues) };
}
