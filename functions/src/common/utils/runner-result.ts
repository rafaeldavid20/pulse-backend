/** Redacts common provider credentials from the short job summary retained in Pulse. */
export function safeRunnerJobResult(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.slice(0, 500)
    .replace(/\b(?:sk-ant-|sk-proj-|sk-|pulse_sk_|ghp_|github_pat_)[A-Za-z0-9_\-]+/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]');
}
