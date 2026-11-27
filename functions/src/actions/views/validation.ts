import { getFirestore } from 'firebase-admin/firestore';
import { fields, parse, resolve, serialize, type Context, type Entity, type Expression } from '../../common/pql';

const groupings = ['none', 'status', 'assignee', 'priority', 'project', 'epic', 'cycle'];
const icons = ['list', 'inbox', 'user', 'eye', 'flag', 'calendar', 'lock', 'zap'];
const writable = new Set(['id', 'workspaceId', 'teamId', 'name', 'icon', 'query', 'queryVersion', 'grouping', 'ordering', 'display', 'shared']);
export async function validateView(data: Record<string, any>, workspaceId: string, actorId: string) {
  for (const key of Object.keys(data)) if (!writable.has(key)) throw new Error(`Campo no editable: ${key}.`);
  if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) throw new Error('Workspace inválido.');
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || name.length > 80) throw new Error('El nombre debe tener entre 1 y 80 caracteres.');
  if (typeof data.query !== 'string') throw new Error('La consulta debe ser texto.');
  if (data.queryVersion !== undefined && data.queryVersion !== 1) throw new Error('Versión PQL no admitida.');
  if (data.icon != null && (typeof data.icon !== 'string' || !icons.includes(data.icon))) throw new Error('Icono no admitido.');
  if (!['list', 'board'].includes(data.display)) throw new Error('Presentación inválida.');
  if (typeof data.shared !== 'boolean') throw new Error('Compartición inválida.');
  if (data.grouping != null && !groupings.includes(data.grouping)) throw new Error('Agrupación inválida.');
  if (data.display === 'board' && !['status', 'epic'].includes(data.grouping)) throw new Error('El tablero solo admite agrupación por estado o épica.');
  let ordering: Array<{ field: string; direction: 'asc' | 'desc' }> | undefined;
  if (data.ordering != null) {
    if (!Array.isArray(data.ordering) || data.ordering.length > 5) throw new Error('Orden inválido.');
    ordering = data.ordering.map((o: any) => {
      if (!o || typeof o.field !== 'string' || !Object.hasOwn(fields, o.field.toLowerCase()) || !fields[o.field.toLowerCase()].sortable || !['asc', 'desc'].includes(o.direction) || Object.keys(o).some(k => !['field', 'direction'].includes(k))) throw new Error('Término de orden inválido.');
      return { field: o.field.toLowerCase(), direction: o.direction };
    });
  }
  const parsed = parse(data.query);
  if (!parsed.ok) throw new Error(`PQL: ${parsed.diagnostic.message}`);
  const db = getFirestore();
  const needsIssues = (node?: Expression): boolean => !node ? false : node.kind === 'and' || node.kind === 'or' ? needsIssues(node.left) || needsIssues(node.right) : node.kind === 'not' ? needsIssues(node.expression) : ['parent', 'epic'].includes(node.field.toLowerCase());
  const collections = ['teams', 'members', 'projects', 'labels', 'cycles', 'agents', ...(needsIssues(parsed.query.expression) ? ['issues'] : [])];
  const snapshots = await Promise.all(collections.map(collection => db.collection(collection).where('workspaceId', '==', workspaceId).limit(5001).get()));
  if (snapshots.some(s => s.size > 5000)) throw new Error('El catálogo excede el límite de validación.');
  const entities = (index: number): Entity[] => snapshots[index].docs.map(d => ({ ...d.data(), id: d.id })) as Entity[];
  const teams = entities(0);
  const teamId = data.teamId == null || data.teamId === '' ? undefined : data.teamId;
  if (teamId !== undefined && (typeof teamId !== 'string' || !teams.some(t => t.id === teamId))) throw new Error('Equipo no disponible.');
  const context: Context = { workspaceId, actorId, now: new Date().toISOString(), teamId, teams, members: entities(1), projects: entities(2), labels: entities(3), cycles: entities(4), agents: entities(5), issues: snapshots[6]?.docs.map(d => ({ id: d.id, identifier: d.get('identifier'), name: d.get('title'), type: d.get('type'), teamId: d.get('teamId') })) ?? [] };
  const checked = resolve(data.query, parsed.query, context);
  if (!checked.ok) throw new Error(`PQL: ${checked.diagnostic.message}`);
  const canonicalize = (node: Expression): Expression => {
    if (node.kind === 'and' || node.kind === 'or') return { ...node, left: canonicalize(node.left), right: canonicalize(node.right) };
    if (node.kind === 'not') return { ...node, expression: canonicalize(node.expression) };
    const field = node.field.toLowerCase();
    if (!['reference', 'set'].includes(fields[field].type)) return node;
    const part = resolve(data.query, { expression: node, orderBy: [] }, context);
    if (!part.ok || part.query.expression?.kind !== 'comparison') throw new Error('No se pudo resolver la referencia.');
    const values = part.query.expression.values;
    return { ...node, values: node.values.map((value, index) => value.kind === 'function' ? value : { ...value, value: String(values[index]), quoted: true }) };
  };
  const query = serialize({ ...parsed.query, expression: parsed.query.expression ? canonicalize(parsed.query.expression) : undefined });
  const serialized = parse(query);
  if (!serialized.ok) throw new Error(`PQL: ${serialized.diagnostic.message}`);
  return { name, query, queryVersion: 1 as const, display: data.display as 'list' | 'board', shared: data.shared as boolean,
    ...(teamId ? { teamId } : {}), ...(data.icon ? { icon: data.icon as string } : {}), ...(data.grouping ? { grouping: data.grouping as string } : {}), ...(ordering ? { ordering } : {}) };
}
