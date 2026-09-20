#!/usr/bin/env node
/**
 * Seed one-shot de la Definition of Done del proyecto MVP (D14/TES-210).
 *
 * Reglas que hoy solo viven en CLAUDE.md o en la memoria de quien revisa, y
 * que valen para todos los issues del proyecto (no una rúbrica por issue):
 * no editar `domain.generated.ts` a mano, que `npm run lint` pase, nada de
 * hex hardcodeados en `className`, toda mutación pasa por Platform Actions,
 * y los errores de auth van traducidos al español.
 *
 * Solo agrega los ítems que faltan por texto — no pisa una DoD que un humano
 * ya haya editado a mano desde el modal del proyecto, ni duplica si se corre
 * más de una vez.
 *
 * Corre en DRY-RUN por defecto:
 *     node scripts/seed-mvp-definition-of-done.mjs
 *     node scripts/seed-mvp-definition-of-done.mjs --apply
 *
 * Credenciales: usa Application Default Credentials.
 *     export GOOGLE_APPLICATION_CREDENTIALS=/ruta/service-account.json
 *   o `gcloud auth application-default login` con acceso al proyecto.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';

const APPLY = process.argv.includes('--apply');
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'pulse-app-93';
const MVP_PROJECT_ID = 'proj-pOpuaYVs';

const RULES = [
  { text: 'No editar `domain.generated.ts` a mano.', severity: 'blocker' },
  { text: '`npm run lint` pasa (incluye el chequeo de sincronía de tipos).', severity: 'blocker' },
  { text: 'Toda mutación pasa por Platform Actions.', severity: 'blocker' },
  { text: 'No hex hardcodeados en `className`.', severity: 'major' },
  { text: 'Errores de auth traducidos al español.', severity: 'major' },
];

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

const projRef = db.collection('projects').doc(MVP_PROJECT_ID);
const snap = await projRef.get();
if (!snap.exists) {
  console.error(`[seed] El proyecto '${MVP_PROJECT_ID}' no existe en '${PROJECT_ID}'. Nada que hacer.`);
  process.exit(1);
}

const project = snap.data();
const existing = Array.isArray(project.definitionOfDone) ? project.definitionOfDone : [];
const existingTexts = new Set(existing.map((c) => c.text));

const toAdd = RULES.filter((r) => !existingTexts.has(r.text)).map((r) => ({
  id: `dod-${nanoid(8)}`,
  text: r.text,
  severity: r.severity,
}));

console.log(`[seed] Proyecto '${project.name}' (${MVP_PROJECT_ID}): ${existing.length} regla(s) ya presentes, ${toAdd.length} por agregar.`);
for (const r of toAdd) {
  console.log(`  + [${r.severity}] ${r.text}`);
}

if (toAdd.length === 0) {
  console.log('[seed] Nada para agregar.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n[seed] DRY RUN — no se escribió nada. Volvé a correr con --apply.');
  process.exit(0);
}

await projRef.update({
  definitionOfDone: [...existing, ...toAdd],
  updatedAt: new Date().toISOString(),
});

console.log(`[seed] ✓ ${toAdd.length} regla(s) agregadas a la Definition of Done de '${project.name}'.`);
process.exit(0);
