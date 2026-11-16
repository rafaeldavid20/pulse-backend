// GENERATED from pulse-app/src/lib/pql; do not edit.
import { diagnostic, type Diagnostic } from './tokenizer';
import { fields, operatorsFor, type FieldSpec } from './schema';
import type { Expression, Query, Value } from './parser';

export interface Entity { id: string; name?: string; displayName?: string; userId?: string; key?: string; identifier?: string; teamId?: string; status?: string; endsAt?: string; type?: string }
export interface Context {
  workspaceId: string;
  actorId?: string;
  now: string;
  teamId?: string;
  members: Entity[];
  teams: Entity[];
  projects: Entity[];
  labels: Entity[];
  cycles: Entity[];
  issues: Entity[];
}
export type ResolvedExpression =
  | { kind: 'and'; left: ResolvedExpression; right: ResolvedExpression }
  | { kind: 'or'; left: ResolvedExpression; right: ResolvedExpression }
  | { kind: 'not'; expression: ResolvedExpression }
  | { kind: 'comparison'; field: string; spec: FieldSpec; operator: string; values: (string | number | null)[] };
export interface ResolvedQuery { expression?: ResolvedExpression; orderBy: { field: string; spec: FieldSpec; direction: 'asc' | 'desc' }[] }
export type ResolveResult = { ok: true; query: ResolvedQuery } | { ok: false; diagnostic: Diagnostic };
class ResolutionFailure { constructor(readonly diagnostic: Diagnostic) {} }

function relativeDate(now: Date, amount: number, unit: string): number {
  if (unit === 'd' || unit === 'w') return now.getTime() + amount * (unit === 'd' ? 1 : 7) * 86400000;
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

export function resolve(source: string, query: Query, context: Context): ResolveResult {
  const fail = (code: string, message: string, range: { start: number; end: number }): never => { throw new ResolutionFailure(diagnostic(source, code, message, range.start, range.end)); };
  const now = new Date(context.now);
  const activeCycle = (v: Value): Entity | undefined => {
    if (!context.teamId) return fail('CONTEXT', 'La función requiere un equipo explícito.', v);
    const active = context.cycles.filter(c => c.teamId === context.teamId && c.status === 'active');
    if (active.length > 1) return fail('CONTEXT', 'Hay varios ciclos activos para el equipo.', v);
    return active[0];
  };
  const lookup = (field: string, v: Value): string => {
    const person = field === 'assignee' || field === 'creator' || field === 'review.reviewer';
    const items = person ? context.members
      : field === 'team' ? context.teams : field === 'project' ? context.projects
      : field === 'label' ? context.labels : field === 'cycle' ? context.cycles : field === 'epic' ? context.issues.filter(i => i.type === 'epic') : context.issues;
    const direct = items.filter(item => (person ? item.userId ?? item.id : item.id) === v.value);
    const matches = direct.length ? direct : items.filter(item => [item.name, item.displayName, item.key, item.identifier].some(s => s?.toLowerCase() === v.value.toLowerCase()));
    if (matches.length !== 1) return fail('REFERENCE', matches.length ? 'Referencia ambigua; use un ID.' : 'Referencia no disponible.', v);
    return person ? matches[0].userId ?? matches[0].id : matches[0].id;
  };
  const resolveValue = (field: string, spec: FieldSpec, v: Value): string | number | null => {
    if (v.kind === 'function') {
      const fn = v.value.toLowerCase();
      if (fn === 'me' && ['assignee', 'creator', 'review.reviewer'].includes(field)) {
        if (!context.actorId) return fail('CONTEXT', 'No hay identidad disponible para me().', v);
        return context.actorId;
      }
      if (fn === 'currentcycle' && field === 'cycle') return activeCycle(v)?.id ?? null;
      if (fn === 'endofcycle' && spec.type === 'date') {
        const cycle = activeCycle(v);
        if (!cycle?.endsAt || !Number.isFinite(Date.parse(cycle.endsAt))) return fail('CONTEXT', 'No hay fecha de fin de ciclo disponible.', v);
        return Date.parse(cycle.endsAt);
      }
      if (spec.type === 'date' && fn === 'now') return now.getTime();
      if (spec.type === 'date' && fn === 'startofweek') {
        const d = new Date(now); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.getTime();
      }
      return fail('FUNCTION', 'Función desconocida o incompatible con el campo.', v);
    }
    if (!v.quoted && v.value.toLowerCase() === 'null') return fail('TYPE', 'Use IS EMPTY para consultar valores vacíos.', v);
    if (spec.type === 'reference' || spec.type === 'set') return lookup(field, v);
    if (spec.type === 'enum') {
      const result = spec.values?.find(s => s.toLowerCase() === v.value.toLowerCase());
      return result ?? fail('TYPE', 'Valor de enumeración no válido.', v);
    }
    if (spec.type === 'number') {
      const n = Number(v.value);
      if (v.quoted || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.value) || !Number.isFinite(n) || (field === 'priority' && (!Number.isInteger(n) || n < 0 || n > 4))) return fail('TYPE', 'Número no válido para este campo.', v);
      return n;
    }
    if (spec.type === 'date') {
      const relative = /^([+-]\d+)([dwm])$/i.exec(v.value);
      if (relative) {
        const amount = Number(relative[1]);
        const result = relativeDate(now, amount, relative[2].toLowerCase());
        if (!Number.isSafeInteger(amount) || !Number.isFinite(result)) return fail('TYPE', 'Fecha relativa fuera de rango.', v);
        return result;
      }
      const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2})))?$/i.exec(v.value);
      const date = Date.parse(v.value);
      if (!parts || !Number.isFinite(date)) return fail('TYPE', 'Fecha ISO no válida o sin zona horaria.', v);
      const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
      const calendar = new Date(0); calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
      if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day) || Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) return fail('TYPE', 'Fecha ISO no válida o sin zona horaria.', v);
      return date;
    }
    return v.value;
  };
  const expression = (e: Expression): ResolvedExpression => {
    if (e.kind === 'and' || e.kind === 'or') return { kind: e.kind, left: expression(e.left), right: expression(e.right) };
    if (e.kind === 'not') return { kind: 'not', expression: expression(e.expression) };
    const field = e.field.toLowerCase(); const spec = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (!spec) return fail('FIELD', 'Campo desconocido.', e);
    if (!operatorsFor(spec.type).includes(e.operator)) return fail('OPERATOR', 'Operador incompatible con el campo.', e);
    return { kind: 'comparison', field, spec, operator: e.operator, values: e.values.map(v => resolveValue(field, spec, v)) };
  };
  try {
    if (!Number.isFinite(now.getTime())) return fail('CONTEXT', 'Reloj inválido.', { start: 0, end: 0 });
    const resolved = query.expression ? expression(query.expression) : undefined;
    const orderBy = query.orderBy.map(o => {
      const field = o.field.toLowerCase(); const spec = Object.hasOwn(fields, field) ? fields[field] : undefined;
      if (!spec || !spec.sortable) return fail('ORDER_FIELD', 'Campo no válido para ordenar.', o);
      return { field, spec, direction: o.direction };
    });
    return { ok: true, query: { expression: resolved, orderBy } };
  } catch (error) {
    if (error instanceof ResolutionFailure) return { ok: false, diagnostic: error.diagnostic };
    throw error;
  }
}
