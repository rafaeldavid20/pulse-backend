#!/usr/bin/env node
/**
 * Migración one-shot de `api_keys.scopes` (D22/TES-218).
 *
 * Los scopes nuevos `comments:read`/`runs:read` habilitan tools nuevas
 * (`pulse_list_comments`, `pulse_list_runs`) detrás de `TOOL_SCOPES` — una key
 * emitida antes de este cambio (o antes de D11/TES-207, que introdujo scopes
 * granulares) no las tiene y esas tools le van a devolver
 * `scope '...' requerido` hasta que se migre.
 *
 * Dos casos:
 *   - Key con `agentId` (emitida por `agents.connectRepo`): su perfil está
 *     determinado por `agents/{agentId}.role` — se reemplaza `scopes` entero
 *     por el perfil canónico (`DEV_SCOPES`/`QA_SCOPES`), igual que
 *     `connectRepo` la generó originalmente. Una key de agente no debería
 *     tener scopes custom, así que un reemplazo total es seguro.
 *   - Key sin `agentId` (personal, `apikeys.create` — un humano operando el
 *     backlog por MCP): se le agregan los scopes de lectura nuevos sin tocar
 *     el resto, porque estas no siguen un perfil fijo y podrían tener un
 *     recorte deliberado (p. ej. sin `issues:write`).
 *
 * `DEV_SCOPES`/`QA_SCOPES` están duplicados acá a mano (no se puede importar
 * TypeScript desde un script standalone `.mjs`) — si `functions/src/mcp/scopes.ts`
 * cambia antes de correr esto, actualizá estas constantes primero.
 *
 * Corre en DRY-RUN por defecto:
 *     node scripts/migrate-api-key-scopes.mjs
 *     node scripts/migrate-api-key-scopes.mjs --apply
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'pulse-app-93';

const DEV_SCOPES = [
  'issues:read',
  'issues:write',
  'projects:write',
  'comments:write',
  'comments:read',
  'reviews:read',
  'runs:write',
  'runs:read',
];
const QA_SCOPES = [
  'issues:read',
  'comments:write',
  'comments:read',
  'reviews:read',
  'reviews:write',
  'runs:write',
  'runs:read',
];
const NEW_READ_SCOPES = ['comments:read', 'runs:read'];

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const [keysSnap, agentsSnap] = await Promise.all([db.collection('api_keys').get(), db.collection('agents').get()]);
const agentRoleById = new Map(agentsSnap.docs.map((d) => [d.id, d.data().role || 'dev']));

const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((s) => b.includes(s));

const pending = [];
for (const doc of keysSnap.docs) {
  const key = doc.data();
  if (key.revokedAt) continue;
  const current = Array.isArray(key.scopes) ? key.scopes : [];

  let next;
  let reason;
  if (key.agentId) {
    const role = agentRoleById.get(key.agentId) ?? 'dev';
    next = role === 'qa' ? QA_SCOPES : DEV_SCOPES;
    reason = `agente '${key.agentId}' (role: ${role})`;
  } else {
    const missing = NEW_READ_SCOPES.filter((s) => !current.includes(s));
    if (missing.length === 0) continue;
    next = [...current, ...missing];
    reason = 'key personal — se agregan solo los scopes de lectura nuevos';
  }

  if (sameSet(current, next)) continue;
  pending.push({ id: doc.id, name: key.name, current, next, reason });
}

console.log(`[migrate] ${keysSnap.size} api_keys; ${pending.length} necesitan actualizar 'scopes'.`);
for (const p of pending) {
  console.log(`  ${p.id} (${p.name}) — ${p.reason}`);
  console.log(`    antes: [${p.current.join(', ')}]`);
  console.log(`    después: [${p.next.join(', ')}]`);
}

if (!APPLY) {
  console.log('\n[migrate] DRY RUN — no se escribió nada. Volvé a correr con --apply.');
  process.exit(0);
}

const batchSize = 400; // Firestore tope 500 writes/batch — margen para no rozarlo.
for (let i = 0; i < pending.length; i += batchSize) {
  const batch = db.batch();
  for (const p of pending.slice(i, i + batchSize)) {
    batch.update(db.collection('api_keys').doc(p.id), { scopes: p.next });
  }
  await batch.commit();
}

console.log(`[migrate] ✓ ${pending.length} api_keys migradas.`);
process.exit(0);
