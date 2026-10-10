import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { registerWriteTools } from '../mcp/tools/write';
import { ReportCriteriaAction } from '../actions/reviews/report-criteria';
import { ResolveFindingAction } from '../actions/reviews/resolve-finding';
import type { McpPrincipal } from '../mcp/auth';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Este test requiere Firebase Emulator.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
let sequence = 0;

async function fixture(legacy = false, mode = 'rework') {
  const suffix = `dev-review-${process.pid}-${++sequence}`;
  const workspaceId = `ws-${suffix}`, issueId = `issue-${suffix}`, agentId = `agent-${suffix}`;
  const human = `human-${suffix}`, jobId = `job-${suffix}`, runnerId = `runner-${suffix}`, apiKeyId = `key-${suffix}`;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const issueRef = db.collection('issues').doc(issueId);
  const agentRef = db.collection('agents').doc(agentId);
  const keyRef = db.collection('api_keys').doc(apiKeyId);
  const jobRef = db.collection('runner_jobs').doc(jobId);
  const runnerRef = db.collection('runners').doc(runnerId);
  await Promise.all([
    issueRef.set({ workspaceId, assigneeId: legacy ? agentId : human, responsibleMemberId: human,
      ...(legacy ? {} : { execution: { agentId, mode: 'personal' } }),
      review: { attempt: 2, findings: [{ id: 'finding', status: 'open', message: 'Fix' }] } }),
    db.collection('members').doc(`${workspaceId}_${agentId}`).set({ workspaceId, userId: agentId, isAgent: true }),
    agentRef.set({ workspaceId, role: 'dev' }),
    keyRef.set({ workspaceId, issueId, agentId, runnerId, jobId, expiresAt }),
    jobRef.set({ workspaceId, issueId, agentId, runnerId, expiresAt, mode, status: 'delivered' }),
    runnerRef.set({ workspaceId }),
  ]);
  const principal: McpPrincipal = { workspaceId, issueId, agentId, runnerId, jobId, apiKeyId,
    createdBy: human, source: 'api_key', scopes: ['issues:write'] };
  return { principal, issueRef, keyRef, jobRef, agentRef, runnerRef, human };
}

async function call(principal: McpPrincipal, name: string, args: Record<string, unknown>) {
  const handlers = new Map<string, Function>();
  registerWriteTools({ registerPrompt: () => {}, registerResource: () => {}, tool: (name: string, ...rest: any[]) => handlers.set(name, rest.at(-1)) } as any, principal);
  const result = await handlers.get(name)!(args);
  return JSON.parse(result.content[0].text);
}

const checks = [{ criterionId: 'criterion', result: 'met', evidence: 'Integration test' }];
async function both(principal: McpPrincipal) {
  return [
    await call(principal, 'pulse_report_criteria', { identifier: principal.issueId, checks }),
    await call(principal, 'pulse_resolve_finding', { identifier: principal.issueId, findingId: 'finding', resolution: 'fixed', note: 'Corrected' }),
  ];
}

for (const legacy of [false, true]) {
  for (const mode of ['task', 'rework', 'handoff']) {
    test(`emulator: MCP dev ${legacy ? 'legacy' : 'delegado'} en ${mode} registra autoverificación y resuelve findings`, async () => {
      const f = await fixture(legacy, mode);
      for (const result of await both(f.principal)) assert.equal(result.error, undefined);
      const issue = (await f.issueRef.get()).data()!;
      assert.deepEqual(issue.devSelfCheck, checks);
      assert.equal(issue.review.findings[0].status, 'fixed');
      assert.equal(issue.review.attempt, 2);
      assert.equal(issue.assigneeId, legacy ? f.principal.agentId : f.human);
      assert.equal(issue.responsibleMemberId, f.human);
      assert.equal(issue.updatedBy, f.principal.agentId);
    });
  }
}

const cases: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown> | void> = {
  'otro agente ejecutor': f => f.issueRef.update({ execution: { agentId: 'other' } }),
  'QA': f => f.agentRef.update({ role: 'qa' }),
  'job de revisión': f => f.jobRef.update({ mode: 'review' }),
  'job de recuperación': f => f.jobRef.update({ recoveryOf: 'old-job' }),
  'job de otro issue': f => f.jobRef.update({ issueId: 'other' }),
  'job de otro workspace': f => f.jobRef.update({ workspaceId: 'other' }),
  'job de otro Runner': f => f.jobRef.update({ runnerId: 'other' }),
  'credencial revocada': f => f.keyRef.update({ revokedAt: new Date().toISOString() }),
  'credencial vencida': f => f.keyRef.update({ expiresAt: '2000-01-01T00:00:00Z' }),
  'credencial de otro job': f => f.keyRef.update({ jobId: 'old-job' }),
  'credencial de otro issue': f => f.keyRef.update({ issueId: 'other' }),
  'credencial de otro workspace': f => f.keyRef.update({ workspaceId: 'other' }),
  'job antiguo completado': f => f.jobRef.update({ status: 'completed' }),
  'job cancelado': f => f.jobRef.update({ cancelRequestedAt: new Date().toISOString() }),
  'job vencido': f => f.jobRef.update({ expiresAt: '2000-01-01T00:00:00Z' }),
  'Runner revocado': f => f.runnerRef.update({ revokedAt: new Date().toISOString() }),
  'principal de otro workspace': f => { f.principal.workspaceId = 'other'; },
  'principal de otro issue': f => { f.principal.issueId = 'other'; },
  'agente archivado': f => f.agentRef.update({ archivedAt: new Date().toISOString() }),
  'job inexistente': f => f.jobRef.delete(),
};
for (const [name, mutate] of Object.entries(cases)) {
  for (const mode of ['rework', 'handoff']) {
    test(`emulator: rechaza ${name} en ${mode} sin modificar el issue`, async () => {
      const f = await fixture(false, mode);
      await mutate(f);
      const before = (await f.issueRef.get()).data();
      for (const result of await both(f.principal)) assert.ok(result.error);
      assert.deepEqual((await f.issueRef.get()).data(), before);
    });
  }
}

test('emulator: job stale no usa fallback legacy y QA legacy queda denegado', async () => {
  const f = await fixture(true);
  await f.jobRef.update({ status: 'completed' });
  for (const result of await both(f.principal)) assert.ok(result.error);
  await f.agentRef.update({ role: 'qa' });
  delete f.principal.jobId;
  for (const result of await both(f.principal)) assert.ok(result.error);
});

test('emulator: legacy sin job funciona; datos de callable no pueden simular principal delegado', async () => {
  const legacy = await fixture(true);
  delete legacy.principal.jobId;
  for (const result of await both(legacy.principal)) assert.equal(result.error, undefined);
  const f = await fixture();
  const actor = f.principal.agentId!;
  const data = { issueId: f.issueRef.id, checks, principal: f.principal, jobId: f.principal.jobId };
  const report = await new ReportCriteriaAction({ actionCode: 'reviews.reportCriteria', data }, actor).run();
  const resolve = await new ResolveFindingAction({ actionCode: 'reviews.resolveFinding', data: { ...data, findingId: 'finding', resolution: 'fixed' } }, actor).run();
  assert.equal(report.success, false);
  assert.equal(resolve.success, false);
});
