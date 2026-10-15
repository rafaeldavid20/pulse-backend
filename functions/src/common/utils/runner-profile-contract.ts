import { createHash } from 'crypto';
import { z } from 'zod';

export const profileId = z.string().regex(/^[-A-Za-z0-9_]{1,100}$/);
export const repoId = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
export const candidateId = z.string().regex(/^dir-[a-f0-9]{64}$/);
export const profilePatch = z.object({ model: modelId.nullable().optional(), directories: z.array(z.object({ repo: repoId, candidateId: candidateId.nullable() }).strict()).max(100).optional() }).strict();
export const profileInput = z.object({ agentId: profileId, runnerId: profileId, op: z.enum(['read', 'request']), requestId: z.string().uuid().optional(), expectedRevision: revision.optional(), patch: profilePatch.optional() }).strict();
export const profileSnapshot = z.object({
  version: z.literal(1), revision, provider: z.enum(['codex', 'claude']), model: modelId.nullable(), modelValid: z.boolean(), models: z.array(modelId).max(100),
  directories: z.array(z.object({ repo: repoId, selected: candidateId.nullable(), valid: z.boolean(), candidates: z.array(z.object({ id: candidateId, alias: z.string().regex(/^Checkout [1-9][0-9]{0,3}$/) }).strict()).max(100) }).strict()).max(100),
}).strict();
export const profileResult = z.object({ requestId: z.string().uuid(), status: z.enum(['applied', 'validation_failed', 'conflict', 'expired', 'forbidden']), revision: revision.optional() }).strict();
export const profileKey = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function profileOnline(runner: any, now = Date.now()) {
  const at = Date.parse(runner.lastHeartbeatAt || '');
  return !runner.revokedAt && ['online', 'busy'].includes(runner.status) && at <= now && now - at < 120_000;
}
