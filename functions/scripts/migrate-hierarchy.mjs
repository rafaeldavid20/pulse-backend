#!/usr/bin/env node
/**
 * Migración one-shot para la jerarquía de issues (épica → historia → sub-tarea).
 *
 * Hace dos cosas sobre la colección `issues`:
 *   1. Pone `type: 'task'` en todo issue que no tenga `type` — el default para
 *      lo creado antes de que la jerarquía existiera.
 *   2. Inicializa `subIssueCount` / `subIssueDoneCount` contando los hijos
 *      reales de cada issue (no asume 0: `parentId` ya existía en el tipo y
 *      podría haber datos colgados).
 *
 * Corre en DRY-RUN por defecto: imprime lo que haría sin escribir nada.
 *
 *     node scripts/migrate-hierarchy.mjs            # dry run
 *     node scripts/migrate-hierarchy.mjs --apply    # escribe
 *
 * Credenciales: usa Application Default Credentials.
 *     export GOOGLE_APPLICATION_CREDENTIALS=/ruta/service-account.json
 *   o `gcloud auth application-default login` con acceso al proyecto.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'pulse-app-93';
const DEFAULT_TYPE = 'task';
const COMPLETED = new Set(['done', 'canceled']);
const BATCH_LIMIT = 400; // Firestore permite 500 ops por batch; margen de sobra.

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const snap = await db.collection('issues').get();
console.log(`[migrate] ${snap.size} issues en el proyecto '${PROJECT_ID}'.`);

// Hijos por padre, en una sola pasada sobre la colección ya leída.
const childrenByParent = new Map();
for (const doc of snap.docs) {
  const parentId = doc.data().parentId;
  if (!parentId) continue;
  if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
  childrenByParent.get(parentId).push(doc);
}

const pending = [];
for (const doc of snap.docs) {
  const issue = doc.data();
  const updates = {};

  if (!issue.type) updates.type = DEFAULT_TYPE;

  const children = childrenByParent.get(doc.id) || [];
  const count = children.length;
  const doneCount = children.filter((c) => COMPLETED.has(c.data().status)).length;

  if (issue.subIssueCount !== count) updates.subIssueCount = count;
  if (issue.subIssueDoneCount !== doneCount) updates.subIssueDoneCount = doneCount;

  if (Object.keys(updates).length > 0) {
    pending.push({ id: doc.id, identifier: issue.identifier, updates });
  }
}

console.log(`[migrate] ${pending.length} issues necesitan cambios.`);
for (const { identifier, id, updates } of pending.slice(0, 20)) {
  console.log(`  ${identifier || id}: ${JSON.stringify(updates)}`);
}
if (pending.length > 20) console.log(`  … y ${pending.length - 20} más.`);

if (!APPLY) {
  console.log('\n[migrate] DRY RUN — no se escribió nada. Volvé a correr con --apply.');
  process.exit(0);
}

let written = 0;
for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
  const batch = db.batch();
  for (const { id, updates } of pending.slice(i, i + BATCH_LIMIT)) {
    batch.update(db.collection('issues').doc(id), updates);
  }
  await batch.commit();
  written += Math.min(BATCH_LIMIT, pending.length - i);
  console.log(`[migrate] ${written}/${pending.length} escritos.`);
}

console.log('[migrate] ✓ Migración completa.');
process.exit(0);
