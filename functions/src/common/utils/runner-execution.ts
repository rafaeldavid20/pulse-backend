export interface RunnerExecutionMetadata {
  provider: 'codex' | 'claude';
  cliVersion: string;
  requestedModel: string | null;
  requestedModelSource: 'local_profile' | 'provider_default';
  effectiveModel: string | null;
  effectiveModelSource: 'observed' | 'unknown';
  reasoningLevel: string | null;
  reasoningLevelSource: 'observed' | 'unknown';
  runConfigVersion: number;
  runConfigMode: 'task' | 'rework' | 'review';
  runConfigOrigin: 'pulse';
}

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Store only bounded, allowlisted execution metadata; never provider output. */
export function parseRunnerExecutionMetadata(value: unknown): RunnerExecutionMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!['codex', 'claude'].includes(String(v.provider))
    || !(v.cliVersion === 'unknown' || (typeof v.cliVersion === 'string' && /^\d+\.\d+\.\d+$/.test(v.cliVersion)))
    || !(v.requestedModel === null || (typeof v.requestedModel === 'string' && SAFE_VALUE.test(v.requestedModel)))
    || !['local_profile', 'provider_default'].includes(String(v.requestedModelSource))
    || !(v.effectiveModel === null || (typeof v.effectiveModel === 'string' && SAFE_VALUE.test(v.effectiveModel)))
    || !['observed', 'unknown'].includes(String(v.effectiveModelSource))
    || !(v.reasoningLevel === null || (typeof v.reasoningLevel === 'string' && SAFE_VALUE.test(v.reasoningLevel)))
    || !['observed', 'unknown'].includes(String(v.reasoningLevelSource))
    || !Number.isSafeInteger(v.runConfigVersion) || !['task', 'rework', 'review'].includes(String(v.runConfigMode))
    || v.runConfigOrigin !== 'pulse') return null;
  if (v.requestedModel === null && v.requestedModelSource !== 'provider_default') return null;
  if ((v.effectiveModel === null) !== (v.effectiveModelSource === 'unknown')) return null;
  if ((v.reasoningLevel === null) !== (v.reasoningLevelSource === 'unknown')) return null;
  return {
    provider: v.provider as RunnerExecutionMetadata['provider'], cliVersion: v.cliVersion as string,
    requestedModel: v.requestedModel as string | null, requestedModelSource: v.requestedModelSource as RunnerExecutionMetadata['requestedModelSource'],
    effectiveModel: v.effectiveModel as string | null, effectiveModelSource: v.effectiveModelSource as RunnerExecutionMetadata['effectiveModelSource'],
    reasoningLevel: v.reasoningLevel as string | null, reasoningLevelSource: v.reasoningLevelSource as RunnerExecutionMetadata['reasoningLevelSource'],
    runConfigVersion: v.runConfigVersion as number, runConfigMode: v.runConfigMode as RunnerExecutionMetadata['runConfigMode'], runConfigOrigin: 'pulse',
  };
}
