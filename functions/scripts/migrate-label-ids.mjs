#!/usr/bin/env node
/**
 * Migración one-shot de `issues.labelIds` (TES-265).
 *
 * `LabelPicker` en pulse-app escribía nombres de etiqueta (`l.name`) en vez de
 * ids en `labelIds` — el tipo dice ids (`domain.ts`) y es lo único que
 * `FilterBar`/`lib/issueFilters.ts` saben buscar, así que una etiqueta puesta
 * desde el panel no se podía filtrar y se veía como el id crudo si además la
 * había puesto el MCP. Ya se corrigió el picker (PR pulse-app#51); esto
 * convierte los datos existentes.
 *
 * Por cada issue, cada entrada de `labelIds` que:
 *   - ya es el id de una etiqueta del mismo workspace, o tiene forma de id
 *     (`lbl-…`) aunque no matchee ninguna etiqueta viva → se deja igual: no
 *     es el bug de TES-265, y podar referencias huérfanas se va del alcance.
 *   - matchea el `name` (case-insensitive) de una etiqueta del mismo
 *     workspace → se reemplaza por su id.
 *   - no matchea ninguna etiqueta real (el caso esperado es `'feature'`, que
 *     `CreateIssueModal` mandaba hardcodeado sin que existiera esa etiqueta
 *     en ningún workspace) → se DESCARTA. No hay forma de saber con qué
 *     color/team la persona la hubiera creado, así que crearla a ciegas
 *     inventaría un dato; se prefiere perder la marca a fabricar una
 *     etiqueta fantasma. El dry-run imprime cada nombre descartado — si
 *     aparece algo además de 'feature', revisar antes de --apply.
 *
 * Idempotente: un issue sin nombres que migrar (ids válidos únicamente, o ya
 * corrido antes) no genera `pending`, así que correrlo dos veces con --apply
 * no vuelve a escribir nada.
 *
 * Corre en DRY-RUN por defecto:
 *     node scripts/migrate-label-ids.mjs
 *     node scripts/migrate-label-ids.mjs --apply
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'pulse-app-93';
const BATCH_LIMIT = 400; // Firestore permite 500 ops por batch; margen de sobra.

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const [issuesSnap, labelsSnap] = await Promise.all([
  db.collection('issues').get(),
  db.collection('labels').get(),
]);

// Índice por workspace: ids reales y nombre (lowercase, como los guarda
// `labels.create`) -> id, para no confundir nombres de un workspace con ids
// o nombres de otro.
const byWorkspace = new Map();
for (const doc of labelsSnap.docs) {
  const label = doc.data();
  if (!label.workspaceId) continue;
  if (!byWorkspace.has(label.workspaceId)) {
    byWorkspace.set(label.workspaceId, { ids: new Set(), byName: new Map() });
  }
  const bucket = byWorkspace.get(label.workspaceId);
  bucket.ids.add(doc.id);
  bucket.byName.set(String(label.name).trim().toLowerCase(), doc.id);
}

const pending = [];
const discardedByName = new Map(); // nombre no reconocido -> cuántas veces

for (const doc of issuesSnap.docs) {
  const issue = doc.data();
  const current = Array.isArray(issue.labelIds) ? issue.labelIds : [];
  if (current.length === 0) continue;

  const bucket = byWorkspace.get(issue.workspaceId) || { ids: new Set(), byName: new Map() };
  const next = [];
  const changes = [];

  for (const entry of current) {
    // Ya es un id válido (existe la etiqueta), o tiene forma de id (`lbl-…`)
    // pero apunta a una etiqueta borrada/de otro workspace — en ningún caso
    // es el bug de TES-265 (un nombre guardado donde va un id), así que se
    // deja intacto: podar referencias huérfanas no es el alcance de esta
    // migración.
    if (bucket.ids.has(entry) || String(entry).startsWith('lbl-')) {
      if (!next.includes(entry)) next.push(entry);
      continue;
    }
    const matchedId = bucket.byName.get(String(entry).trim().toLowerCase());
    if (matchedId) {
      if (!next.includes(matchedId)) next.push(matchedId);
      changes.push(`'${entry}' -> ${matchedId}`);
      continue;
    }
    changes.push(`'${entry}' -> (descartado, sin etiqueta correspondiente)`);
    discardedByName.set(entry, (discardedByName.get(entry) || 0) + 1);
  }

  const sameSet = next.length === current.length && next.every((id) => current.includes(id));
  if (sameSet) continue;

  pending.push({ id: doc.id, identifier: issue.identifier, before: current, after: next, changes });
}

console.log(`[migrate] ${issuesSnap.size} issues, ${labelsSnap.size} labels en el proyecto '${PROJECT_ID}'.`);
console.log(`[migrate] ${pending.length} issues necesitan cambios en 'labelIds'.`);
for (const p of pending.slice(0, 30)) {
  console.log(`  ${p.identifier || p.id}: ${p.changes.join(', ')}`);
}
if (pending.length > 30) console.log(`  … y ${pending.length - 30} más.`);

if (discardedByName.size > 0) {
  console.log('\n[migrate] Nombres descartados (sin etiqueta correspondiente):');
  for (const [name, count] of discardedByName) {
    console.log(`  '${name}' — ${count} issue(s)`);
  }
}

if (!APPLY) {
  console.log('\n[migrate] DRY RUN — no se escribió nada. Volvé a correr con --apply.');
  process.exit(0);
}

let written = 0;
for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
  const batch = db.batch();
  for (const p of pending.slice(i, i + BATCH_LIMIT)) {
    batch.update(db.collection('issues').doc(p.id), { labelIds: p.after });
  }
  await batch.commit();
  written += Math.min(BATCH_LIMIT, pending.length - i);
  console.log(`[migrate] ${written}/${pending.length} escritos.`);
}

console.log('[migrate] ✓ Migración completa.');
process.exit(0);
