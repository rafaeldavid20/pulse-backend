import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ credential: applicationDefault(), projectId: 'pulse-app-93' });
const db = getFirestore();
for (let i = 0; i < 60; i++) {
  try {
    const q = await db.collection('comments')
      .where('workspaceId','==','ws-aVEruGM7')
      .where('issueId','==','issue-ad8NxIkx')
      .orderBy('createdAt','asc').get();
    console.log(`índice listo — la query devuelve ${q.size} comentario(s)`);
    process.exit(0);
  } catch (e) {
    if (!String(e.message).includes('index')) { console.log('error distinto:', e.message.slice(0,120)); process.exit(1); }
    await new Promise(r => setTimeout(r, 10000));
  }
}
console.log('timeout esperando el índice');
process.exit(1);
