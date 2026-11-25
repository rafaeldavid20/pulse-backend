import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SavedViewAction } from '../actions/views/views';
import { seedViews } from '../actions/views/seed';
import { execute, type Context } from '../common/pql';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'demo-pulse-views' });
const db = getFirestore();
const run = (mode: 'create' | 'update' | 'delete', uid: string, data: Record<string, unknown>) => new SavedViewAction(mode, { actionCode: `views.${mode}`, data }, uid).run();

test('saved view actions enforce ownership, membership and immutable metadata', async () => {
  const suffix = randomBytes(5).toString('hex'), ws = `ws-${suffix}`, otherWs = `ws-other-${suffix}`, team = `team-${suffix}`, alice = `alice-${suffix}`, bob = `bob-${suffix}`, admin = `admin-${suffix}`;
  await Promise.all([
    db.collection('members').doc(`${ws}_${alice}`).set({ workspaceId: ws, userId: alice, role: 'member', displayName: 'Alice' }),
    db.collection('members').doc(`${ws}_${bob}`).set({ workspaceId: ws, userId: bob, role: 'member', displayName: 'Bob' }),
    db.collection('members').doc(`${ws}_${admin}`).set({ workspaceId: ws, userId: admin, role: 'admin' }),
    db.collection('teams').doc(team).set({ workspaceId: ws, key: 'TES', name: 'Team' }),
    db.collection('labels').doc(`label-${suffix}`).set({ workspaceId: ws, teamId: team, name: 'Backend' }),
  ]);
  const created = await run('create', alice, { workspaceId: ws, name: ' Mi vista ', query: 'label = Backend AND assignee = me()', display: 'list', shared: false, teamId: team });
  assert.equal(created.success, true, created.error); const id = created.data!.id;
  const saved = (await db.collection('saved_views').doc(id).get()).data()!;
  assert.equal(saved.name, 'Mi vista'); assert.equal(saved.ownerId, alice);
  assert.match(saved.query, new RegExp(`label\\s*=\\s*"label-${suffix}"`)); assert.match(saved.query, /me\(\)/i);
  assert.equal((await run('update', bob, { id, name: 'Robada' })).success, false);
  assert.equal((await run('delete', admin, { id })).success, false);
  assert.equal((await run('update', alice, { id, ownerId: bob })).success, false);
  assert.equal((await run('update', alice, { id, workspaceId: otherWs })).success, false);
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: saved.updatedAt, query: 'status =' })).success, false);
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: saved.updatedAt, icon: '<svg />' })).success, false);
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: saved.updatedAt, teamId: 'foreign-team' })).success, false);
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: saved.updatedAt, ordering: [{ field: 'label', direction: 'asc' }] })).success, false);
  assert.equal((await run('create', `outsider-${suffix}`, { workspaceId: ws, name: 'Ajena', query: '', display: 'list', shared: true })).success, false);
  await db.collection('labels').doc(`label-${suffix}`).update({ name: 'Renamed label' });
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: saved.updatedAt, name: 'Renombrada', shared: true })).success, true);
  assert.match((await db.collection('saved_views').doc(id).get()).get('query'), new RegExp(`label\\s*=\\s*"label-${suffix}"`));
  const fresh = (await db.collection('saved_views').doc(id).get()).data()!;
  assert.notEqual(fresh.updatedAt, saved.updatedAt);
  const stale = await run('update', alice, { id, expectedUpdatedAt: saved.updatedAt, name: 'Edición obsoleta' });
  assert.equal(stale.success, false); assert.match(stale.error!, /cambió/);
  assert.equal((await db.collection('saved_views').doc(id).get()).get('name'), 'Renombrada');
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: fresh.updatedAt, display: 'board', grouping: 'priority' })).success, false);
  assert.equal((await run('update', alice, { id, expectedUpdatedAt: fresh.updatedAt, display: 'board', grouping: 'epic' })).success, true);
  const currentVersion = (await db.collection('saved_views').doc(id).get()).get('updatedAt');
  const concurrent = await Promise.all([
    run('update', alice, { id, expectedUpdatedAt: currentVersion, name: 'Primera' }),
    run('update', alice, { id, expectedUpdatedAt: currentVersion, name: 'Segunda' }),
  ]);
  assert.equal(concurrent.filter(result => result.success).length, 1);
  assert.equal(concurrent.filter(result => !result.success).length, 1);
  assert.equal((await run('update', bob, { id, name: 'Cambio ajeno' })).success, false);
  const systemId = `view-system-${suffix}`;
  await db.collection('saved_views').doc(systemId).set({ ...saved, id: systemId, shared: true, systemKey: 'review' });
  assert.equal((await run('update', admin, { id: systemId, expectedUpdatedAt: saved.updatedAt, name: 'Sistema' })).success, true);
  assert.equal((await run('delete', bob, { id: systemId })).success, false);
  assert.equal((await run('delete', admin, { id: systemId })).success, true);
  await db.collection('members').doc(`${ws}_${alice}`).delete();
  assert.equal((await run('delete', alice, { id })).success, false);
  assert.equal((await db.collection('saved_views').doc(id).get()).exists, true);
});

test('seeding is repeatable across teams and never overwrites edits', async () => {
  const suffix = randomBytes(5).toString('hex'), ws = `ws-seed-${suffix}`, owner = `owner-${suffix}`, first = `team-a-${suffix}`, second = `team-b-${suffix}`;
  await Promise.all([
    db.collection('members').doc(`${ws}_${owner}`).set({ workspaceId: ws, userId: owner, role: 'owner' }),
    db.collection('teams').doc(first).set({ workspaceId: ws, name: 'A', key: 'AAA' }),
    db.collection('teams').doc(second).set({ workspaceId: ws, name: 'B', key: 'BBB' }),
  ]);
  const initial = await seedViews(ws, owner, [{ id: first, name: 'A' }, { id: second, name: 'B' }]);
  assert.equal(initial.created, 6);
  const views = await db.collection('saved_views').where('workspaceId', '==', ws).get();
  const mine = views.docs.find(d => d.get('systemKey') === 'my-work')!;
  await mine.ref.update({ name: 'Personalizada' });
  const repeated = await seedViews(ws, owner, [{ id: first, name: 'A' }, { id: second, name: 'B' }]);
  assert.equal(repeated.created, 0); assert.equal((await mine.ref.get()).get('name'), 'Personalizada');
  assert.equal(views.docs.filter(d => String(d.get('systemKey')).startsWith('current-cycle:')).length, 2);
  assert.match(mine.get('query'), /me\(\)/i);
  const context: Context = { workspaceId: ws, actorId: owner, teamId: first, now: '2024-01-01T00:00:00Z', teams: [], members: [{ id: owner, userId: owner }, { id: 'reader', userId: 'reader' }], agents: [], projects: [], labels: [], cycles: [], issues: [] };
  const candidates = [{ id: 'a', assigneeId: owner, status: 'todo', cycleId: 'cycle-1' }, { id: 'b', assigneeId: 'reader', status: 'todo', cycleId: 'cycle-2' }];
  const firstReader = execute(mine.get('query'), candidates, context);
  const secondReader = execute(mine.get('query'), candidates, { ...context, actorId: 'reader' });
  assert.deepEqual(firstReader.ok && firstReader.issues.map(i => i.id), ['a']);
  assert.deepEqual(secondReader.ok && secondReader.issues.map(i => i.id), ['b']);
  const cycleView = views.docs.find(d => d.get('systemKey') === `current-cycle:${first}`)!;
  const empty = execute(cycleView.get('query'), candidates, context);
  const cycle1 = execute(cycleView.get('query'), candidates, { ...context, cycles: [{ id: 'cycle-1', teamId: first, status: 'active' }] });
  const cycle2 = execute(cycleView.get('query'), candidates, { ...context, cycles: [{ id: 'cycle-2', teamId: first, status: 'active' }] });
  assert.deepEqual(empty.ok && empty.issues, []);
  assert.deepEqual(cycle1.ok && cycle1.issues.map(i => i.id), ['a']);
  assert.deepEqual(cycle2.ok && cycle2.issues.map(i => i.id), ['b']);
  assert.equal((await cycleView.ref.get()).get('query'), cycleView.get('query'));
});
