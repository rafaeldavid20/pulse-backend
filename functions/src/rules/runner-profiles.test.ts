import test, { before, after } from 'node:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initializeTestEnvironment, assertFails, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-runner-profiles-rules', firestore: { rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async c => {
    for (const name of ['runner_profiles', 'runner_profile_requests']) await setDoc(doc(c.firestore(), name, 'fixture'), { workspaceId: 'ws-one' });
  });
});
after(async () => env?.cleanup());
test('profile metadata requires the server action even for workspace owners', async () => {
  for (const client of [env.unauthenticatedContext(), env.authenticatedContext('owner', { ws: { 'ws-one': 'owner' } }), env.authenticatedContext('member', { ws: { 'ws-one': 'member' } })]) {
    for (const name of ['runner_profiles', 'runner_profile_requests']) {
      await assertFails(getDoc(doc(client.firestore(), name, 'fixture')));
      await assertFails(setDoc(doc(client.firestore(), name, 'fixture'), { workspaceId: 'ws-one' }));
    }
  }
});
