import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { seedViews } from '../actions/views/seed';

export const seedViewsOnTeamCreated = onDocumentCreated({ document: 'teams/{teamId}', region: 'us-east4', retry: true }, async event => {
  const team = event.data?.data();
  if (!team?.workspaceId) return;
  const workspace = await getFirestore().collection('workspaces').doc(team.workspaceId).get();
  const ownerId = workspace.data()?.ownerId;
  if (!ownerId) { console.warn('Cannot seed views: workspace owner is unavailable.'); return; }
  await seedViews(team.workspaceId, ownerId, [{ id: event.params.teamId, name: team.name || team.key || event.params.teamId }]);
});
