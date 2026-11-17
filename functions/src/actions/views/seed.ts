import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { validateView } from './validation';

interface Team { id: string; name: string }
export async function seedViews(workspaceId: string, ownerId: string, teams: Team[]) {
  const db = getFirestore();
  const templates = [
    { key: 'my-work', name: 'Mi trabajo', query: 'assignee = me() AND status NOT IN (done, canceled)', icon: 'user' },
    { key: 'in-review', name: 'En revisión', query: 'status = in_review', icon: 'eye' },
    { key: 'blocked', name: 'Bloqueados', query: 'agent.state = blocked', icon: 'flag' },
    { key: 'unassigned', name: 'Sin asignar', query: 'assignee IS EMPTY AND status NOT IN (done, canceled)', icon: 'inbox' },
    ...teams.map(team => ({ key: `current-cycle:${team.id}`, name: `Ciclo actual · ${team.name}`, query: 'cycle = currentCycle()', icon: 'calendar', teamId: team.id })),
  ];
  let created = 0;
  for (const template of templates) {
    const id = `view-system-${createHash('sha256').update(`${workspaceId}:${template.key}`).digest('hex').slice(0, 24)}`;
    const ref = db.collection('saved_views').doc(id);
    if ((await ref.get()).exists) continue;
    const validated = await validateView({ name: template.name, query: template.query, icon: template.icon, teamId: 'teamId' in template ? template.teamId : undefined, display: 'list', shared: true }, workspaceId, ownerId);
    const inserted = await db.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) return false;
      const now = new Date().toISOString();
      tx.create(ref, { id, workspaceId, ownerId, systemKey: template.key, createdAt: now, updatedAt: now, ...validated });
      return true;
    });
    if (inserted) created++;
  }
  return { created, existing: templates.length - created };
}
