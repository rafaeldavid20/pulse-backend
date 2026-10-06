/** Keep a short, sanitized completion summary for Runner jobs. */
export function safeRunnerJobResult(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const redacted = value
    .replace(/\b(?:runner-[A-Za-z0-9_-]{12}\.)[A-Za-z0-9._-]{32,}/gi, '[redacted runner credential]')
    .replace(/\b(?:sk-ant-|sk-proj-|pulse_sk_|ghp_|gho_|ghu_|ghs_|github_pat_|sk-)[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
  // Keep the tail: command and provider errors commonly put the actionable cause last.
  const summary = redacted.slice(-500).trim();
  return summary || null;
}

export interface RunnerFailure { phase: string; category: 'configuration' | 'local_preparation' | 'execution'; correlationId: string }
export function safeRunnerFailure(value: any, jobId: string): RunnerFailure | null {
  if (!value || typeof value.phase !== 'string' || !/^[a-z-]{1,60}$/.test(value.phase) || !['configuration', 'local_preparation', 'execution'].includes(value.category)) return null;
  return { phase: value.phase, category: value.category, correlationId: jobId };
}
