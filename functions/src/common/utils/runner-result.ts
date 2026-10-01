/** Keep a short, sanitized completion summary for Runner jobs. */
export function safeRunnerJobResult(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const redacted = value
    .replace(/\b(?:runner-[A-Za-z0-9_-]{12}\.)[A-Za-z0-9._-]{32,}/gi, '[redacted runner credential]')
    .replace(/\b(?:sk-ant-|sk-proj-|pulse_sk_|ghp_|gho_|ghu_|ghs_|github_pat_|sk-)[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
  const summary = redacted.slice(0, 500).trim();
  return summary || null;
}
