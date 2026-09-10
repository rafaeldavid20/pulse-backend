#!/usr/bin/env node
/**
 * Migración one-shot para `Agent.role`.
 *
 * `role` se declara requerido en el modelo, así que los agentes creados antes
 * de que existiera el campo necesitan tenerlo — si no, el tipo estaría mintiendo
 * sobre lo que hay en Firestore. Todos pasan a `'dev'`, que es lo que venían
 * siendo de hecho: abrir PRs sobre issues.
 *
 * También siembra `agentRole` en el `member` espejo de cada agente, que es de
 * donde el picker de asignado lee para agrupar Humanos / Dev / QA (no puede leer
 * `agents`, que es Admin-SDK-only).
 *
 * Corre en DRY-RUN por defecto:
 *     node scripts/migrate-agent-roles.mjs
 *     node scripts/migrate-agent-roles.mjs --apply
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'pulse-app-93';
const DEFAULT_ROLE = 'dev';

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const agents = await db.collection('agents').get();
const pending = [];

for (const doc of agents.docs) {
  const agent = doc.data();
  if (agent.role) continue;

  const memberId = `${agent.workspaceId}_${doc.id}`;
  const memberSnap = await db.collection('members').doc(memberId).get();

  pending.push({
    agentId: doc.id,
    displayName: agent.displayName,
    memberId: memberSnap.exists ? memberId : null,
  });
}

console.log(`[migrate] ${agents.size} agentes; ${pending.length} sin 'role'.`);
for (const p of pending) {
  console.log(`  ${p.agentId} (${p.displayName}) → role: '${DEFAULT_ROLE}'` +
    (p.memberId ? ` + member ${p.memberId}.agentRole` : ' (sin member espejo)'));
}

if (!APPLY) {
  console.log('\n[migrate] DRY RUN — no se escribió nada. Volvé a correr con --apply.');
  process.exit(0);
}

const batch = db.batch();
for (const p of pending) {
  batch.update(db.collection('agents').doc(p.agentId), { role: DEFAULT_ROLE });
  if (p.memberId) {
    batch.update(db.collection('members').doc(p.memberId), { agentRole: DEFAULT_ROLE });
  }
}
if (pending.length > 0) await batch.commit();

console.log(`[migrate] ✓ ${pending.length} agentes migrados.`);
process.exit(0);
