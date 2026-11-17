#!/usr/bin/env node
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const { seedViews } = require('../lib/actions/views/seed');

const projectIndex = process.argv.indexOf('--project');
const projectId = projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined;
if (!projectId || !process.argv.includes('--apply')) {
  console.error('Uso: node scripts/backfill-saved-views.cjs --project PROJECT_ID --apply');
  process.exit(1);
}
initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();
(async () => {
  let cursor, workspaces = 0, created = 0, skipped = 0;
  while (true) {
    let q = db.collection('workspaces').orderBy(FieldPath.documentId()).limit(100);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    for (const workspace of page.docs) {
      const ownerId = workspace.data().ownerId;
      if (!ownerId) { skipped++; continue; }
      const teams = await db.collection('teams').where('workspaceId', '==', workspace.id).get();
      const result = await seedViews(workspace.id, ownerId, teams.docs.map(team => ({ id: team.id, name: team.data().name || team.data().key || team.id })));
      workspaces++; created += result.created;
    }
    if (page.size < 100) break;
    cursor = page.docs[page.docs.length - 1];
  }
  console.log(JSON.stringify({ projectId, workspaces, created, skipped }));
})().catch(error => { console.error('Backfill failed:', error.message); process.exitCode = 1; });
